import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PassThrough} from 'node:stream';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {fixture} from './fixtures/authority-fixture.mjs';
import {ControlError} from '../lib/errors.mjs';
import {FreshActorChecks} from '../broker/actor-channel.mjs';
import {HostConnections} from '../broker/host-channel.mjs';
import {channelProof} from '../host/enrollment.mjs';

async function writer(f,kind){
  const child=fork(fileURLToPath(new URL('./fixtures/authority-writer-child.mjs',import.meta.url)),[],{execArgv:['--max-old-space-size=64'],windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
  f.addCleanup(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ended;});
  const locked=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('TEST_ONLY writer did not obtain lock')),5000);child.on('message',message=>{if(message.type==='WRITE_LOCK_HELD'){clearTimeout(timeout);resolve();}if(message.type==='FAILED'){clearTimeout(timeout);reject(new Error('TEST_ONLY writer failed'));}});});
  child.send({directory:f.directory,account:f.account,hubId:f.store.state().hubId,managerId:f.ownerId,atMs:f.now(),kind,grant:f.grant});
  await locked;return {ended};
}
for(const kind of ['RECOVER','REVOKE_GRANT'])test('consumption rechecks '+kind+' committed by another real process before its writer lock',{timeout:15000},async t=>{
  const f=await fixture(t),operation=f.operation(),assertion=f.authority.issue(f.aliceSession.credential,{operation,stage:'PUBLICATION',connection:f.connection});
  const before=f.store.status().retainedRecords,child=await writer(f,kind);let published=0;
  assert.throws(()=>{f.authority.consume(assertion);published++;},error=>error instanceof ControlError);
  assert.equal(await child.ended,0);assert.equal(published,0);assert.equal(f.store.status().retainedRecords,before+1);
  assert.notEqual(f.store.audit().at(-1).record.kind,'ASSERTION_PUBLICATION');
});
test('manager mutation cannot cross owner recovery even when the same named manager is restored',{timeout:15000},async t=>{
  const f=await fixture(t),child=await writer(f,'RECOVER');
  assert.throws(()=>f.authority.putPrincipal(f.ownerSession.credential,{requestId:randomUUID(),principal:{actorId:f.actorId,viewerId:'alice',revision:2,enabled:false},expectedRevision:1}),error=>error instanceof ControlError&&error.code==='STALE_CONTEXT');
  assert.equal(await child.ended,0);assert.equal(f.store.state().generation,2);assert.equal(f.store.principal(f.actorId).enabled,true);assert.equal(f.store.principal(f.actorId).revision,1);
});
test('expiry and recent reauthentication are checked again inside the actual write transaction',async t=>{
  const f=await fixture(t),operation=f.operation(),assertion=f.authority.issue(f.aliceSession.credential,{operation,stage:'DISPATCH',connection:f.connection});
  const original=fs.statfsSync;let advanced=false;
  fs.statfsSync=(...args)=>{if(!advanced&&args[1]?.bigint===true){advanced=true;f.advance(3001);}return original(...args);};
  try{assert.throws(()=>f.authority.consume(assertion),error=>error instanceof ControlError&&error.code==='STALE_CONTEXT');}finally{fs.statfsSync=original;}
  advanced=false;fs.statfsSync=(...args)=>{if(!advanced&&args[1]?.bigint===true){advanced=true;f.advance(300_001);}return original(...args);};
  try{assert.throws(()=>f.authority.putGrant(f.ownerSession.credential,{requestId:randomUUID(),value:{...f.grant,grantRevision:2},expectedRevision:1}),error=>error instanceof ControlError);}finally{fs.statfsSync=original;}
  assert.equal(f.store.getGrant(f.grantId).grantRevision,1);
});
test('durably rotated host retires its old transport but same-generation ownership remains exclusive',()=>{
  const first=generateKeyPairSync('ed25519'),second=generateKeyPairSync('ed25519');let retired=0;
  let host={hostId:randomUUID(),hubId:randomUUID(),state:'ACTIVE',generation:1,publicKey:first.publicKey.export({format:'der',type:'spki'}).toString('base64')};
  const connections=new HostConnections({store:{host:()=>host},maxConnections:1});
  const authenticate=key=>{const challenge=connections.challenge({hostId:host.hostId,generation:host.generation,connectionEpoch:randomUUID()});return connections.authenticate({challengeId:challenge.challengeId,signature:channelProof(challenge,key)});};
  try{
    const old=authenticate(first.privateKey);connections.bindTransport(old,()=>retired++);
    host={...host,generation:2,publicKey:second.publicKey.export({format:'der',type:'spki'}).toString('base64')};
    const current=authenticate(second.privateKey);assert.equal(retired,1);assert.equal(connections.check(current).hostGeneration,2);
    assert.throws(()=>connections.check(old),error=>error instanceof ControlError);
    assert.throws(()=>authenticate(second.privateKey),error=>error instanceof ControlError);
  }finally{connections.close();}
});
test('actor checks reject immediately after explicit closure and real stream disconnect',async()=>{
  const key=generateKeyPairSync('ed25519'),readable=new PassThrough(),writable=new PassThrough();
  const checks=new FreshActorChecks({readable,writable,hubId:randomUUID(),audienceId:randomUUID(),brokerEpoch:randomUUID(),hubPublicKey:key.publicKey.export({format:'der',type:'spki'}).toString('base64')});
  const operation={version:1,operationId:randomUUID(),requestKey:randomUUID(),actorId:randomUUID(),action:'control.inspect',target:{hostId:randomUUID(),projectId:randomUUID(),providerProfileId:null,runtimeId:null,sessionId:null,turnId:null,terminalId:null,requestId:null},context:{entityRevision:1,policyRevision:1,grantRevision:1,authorityGeneration:1,ownershipFence:1,connectionEpoch:randomUUID()},createdAtMs:Date.now(),deadlineAtMs:Date.now()+60_000,timeoutMs:59_000};
  const pending=checks.check('a'.repeat(43),{operation,stage:'ADMISSION'});const rejected=assert.rejects(pending,error=>error instanceof ControlError);
  readable.destroy();await rejected;
  assert.throws(()=>checks.check('a'.repeat(43),{operation,stage:'ADMISSION'}),error=>error instanceof ControlError&&error.code==='CLOSED');
  checks.close();assert.throws(()=>checks.check('a'.repeat(43),{operation,stage:'ADMISSION'}),error=>error instanceof ControlError&&error.code==='CLOSED');
});
