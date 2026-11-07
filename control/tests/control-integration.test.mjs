import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {fixture,password} from './fixtures/authority-fixture.mjs';
import {TEST_ONLY_KEY,TEST_ONLY_CERT,TEST_ONLY_PIN} from './fixtures/transport-tls.mjs';
import {ControlBroker} from '../broker/main.mjs';
import {ControlHostAgent} from '../host/agent.mjs';
import {OwnershipLease} from '../host/ownership.mjs';
import {HostPolicy} from '../host/policy.mjs';
import {enrollmentProof} from '../host/enrollment.mjs';
import {createControlFacade} from '../../lib/control-facade.mjs';
import {ControlError} from '../lib/errors.mjs';
const refused=callback=>assert.throws(callback,error=>error instanceof ControlError);
const denied=callback=>assert.rejects(callback,error=>error instanceof ControlError);
const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('TEST_ONLY condition timeout');};

async function network(t,{maxConnections=32}={}){
  const f=await fixture(t),base=f.operation(),epoch=randomUUID();f.disconnect();f.lease.release();f.policy.close();
  const broker=new ControlBroker({store:f.store,connections:f.connections,brokerPublicKey:f.brokerPublicKey,maxConnections});
  const server=https.createServer({key:TEST_ONLY_KEY,cert:TEST_ONLY_CERT},(req,res)=>broker.acceptHttp(req,res));
  server.requestTimeout=0;await new Promise(resolve=>server.listen(0,'localhost',resolve));
  const endpoint='https://localhost:'+server.address().port+'/api/control/v1/host-channel',key=generateKeyPairSync('ed25519');
  const pending=f.authority.beginEnrollment(f.ownerSession.credential,{...f.beginInput,requestId:randomUUID(),expectedGeneration:1,publicKey:key.publicKey.export({format:'der',type:'spki'}).toString('base64'),endpoint,serverCertificateSha256:TEST_ONLY_PIN}).current;
  f.authority.activateEnrollment(f.ownerSession.credential,{requestId:randomUUID(),hostId:f.hostId,enrollmentRequestId:pending.requestId,signature:enrollmentProof(pending,key.privateKey)});
  const lease=OwnershipLease.acquire({directory:path.join(f.directory,'ownership'),resourceId:f.projectId,ownerId:randomUUID(),connectionEpoch:epoch});
  let policy;
  const agent=new ControlHostAgent({hostId:f.hostId,generation:2,hubId:f.store.state().hubId,connectionEpoch:epoch,privateKey:key.privateKey,enrollment:f.store.host(f.hostId),policyFor:id=>{assert.equal(id,f.projectId);return policy;},onReady:info=>{policy=new HostPolicy({hostId:f.hostId,hostGeneration:2,projectId:f.projectId,entityRevision:1,brokerPublicKey:info.brokerPublicKey,root:f.root,lease,connection:()=>agent.connectionState(),now:f.now});},onClose:()=>policy?.close()});
  f.addCleanup(async()=>{agent.close();policy?.close();broker.close();lease.release();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const connect=()=>agent.connect({endpoint,serverCertificateSha256:TEST_ONLY_PIN,ca:TEST_ONLY_CERT});
  const operation=()=>({...structuredClone(base),operationId:randomUUID(),requestKey:randomUUID(),context:{...base.context,ownershipFence:lease.snapshot().fence,connectionEpoch:epoch}});
  return {f,broker,server,agent,lease,endpoint,key,connect,operation,get policy(){return policy;}};
}

test('actual pinned TLS host proof, authoritative facade admission and consumed host permit',async t=>{
  const n=await network(t),{f,broker,agent}=n,ready=await n.connect();
  assert.equal(ready.hostGeneration,2);assert.equal(agent.connectionState().connected,true);
  const connection=broker.connectionFor(f.hostId),facade=createControlFacade({enabled:true,authority:f.authority,identities:f.identities,journal:f.journal,hostCheck:input=>broker.checkHost(input)}),operation=n.operation();
  const admitted=await facade.admit({credential:f.aliceSession.credential,operation,connection});assert.equal(admitted.operation.state,'ADMITTED');
  const checked=await facade.authorize({credential:f.aliceSession.credential,operation,connection,stage:'DISPATCH'});
  const result=n.policy.acceptPermit({...checked,operation,stage:'DISPATCH'});assert.equal(result.nativeExecutionAllowed,false);
  assert.equal(f.journal.get(operation.operationId).state,'ADMITTED');assert.equal(broker.status().authenticated,1);
  agent.close();await until(()=>broker.status().connections===0);refused(()=>broker.connectionFor(f.hostId));
});

test('a valid TLS channel with the wrong host private credential cannot authenticate or expose a connection',async t=>{
  const n=await network(t),{f}=n;
  const forged=new ControlHostAgent({hostId:f.hostId,generation:2,hubId:f.store.state().hubId,connectionEpoch:randomUUID(),privateKey:generateKeyPairSync('ed25519').privateKey,enrollment:f.store.host(f.hostId),policyFor:()=>assert.fail('Unauthenticated policy callback')});
  f.addCleanup(()=>forged.close());
  await denied(()=>forged.connect({endpoint:n.endpoint,serverCertificateSha256:TEST_ONLY_PIN,ca:TEST_ONLY_CERT}));
  refused(()=>n.broker.connectionFor(f.hostId));assert.equal(f.journal.status().records,0);
});

test('host enforces its enrolled endpoint/pin and live revocation ACK means new input disabled, not native stop',async t=>{
  const n=await network(t),{f,agent,broker}=n;
  await denied(()=>agent.connect({endpoint:n.endpoint,serverCertificateSha256:'f'.repeat(64),ca:TEST_ONLY_CERT}));
  await n.connect();const operation=n.operation(),connection=broker.connectionFor(f.hostId);
  const assertion=f.authority.issue(f.aliceSession.credential,{operation,stage:'DISPATCH',connection});
  f.authority.revokeHost(f.ownerSession.credential,{requestId:randomUUID(),hostId:f.hostId,expectedGeneration:2});
  await broker.notifyRevocation(f.hostId);await until(()=>f.connections.enforcement(f.hostId).status==='ACKNOWLEDGED_NEW_INPUT_DISABLED');
  assert.equal(agent.connectionState().connected,false);assert.equal(f.connections.enforcement(f.hostId).nativeStopConfirmed,false);
  refused(()=>f.authority.consume(assertion));refused(()=>broker.connectionFor(f.hostId));
});

test('grant revoked after the real TLS response but before async publication is refused',async t=>{
  const n=await network(t),{f,broker}=n;await n.connect();let release,returned=false;
  const facade=createControlFacade({enabled:true,authority:f.authority,identities:f.identities,journal:f.journal,hostCheck:async input=>{await broker.checkHost(input);returned=true;await new Promise(resolve=>{release=resolve;});}});
  const operation=n.operation(),pending=facade.authorize({credential:f.aliceSession.credential,operation,connection:broker.connectionFor(f.hostId),stage:'PUBLICATION'});
  await until(()=>returned);f.authority.putGrant(f.ownerSession.credential,{requestId:randomUUID(),value:{...f.grant,grantRevision:2,enabled:false},expectedRevision:1});release();await denied(()=>pending);
});

test('saturated host endpoint returns bounded refusal without throwing into its authoritative HTTPS server',async t=>{
  const n=await network(t,{maxConnections:1});await n.connect();
  const status=await new Promise((resolve,reject)=>{const request=https.request(n.endpoint,{method:'POST',ca:TEST_ONLY_CERT,agent:false,headers:{'Content-Type':'application/x-codexcontrol-frame'}},response=>{response.resume();response.once('end',()=>resolve(response.statusCode));});request.once('error',reject);request.end();});
  assert.equal(status,503);assert.equal(n.agent.connectionState().connected,true);assert.equal(n.broker.status().connections,1);
});

test('actual owner-local CLI first bootstrap, lost response retry, replay conflict and generation recovery',async t=>{
  const f=await fixture(t),directory=path.join(f.directory,'cli-authority');fs.mkdirSync(directory,{mode:0o700});
  const config=path.join(f.directory,'TEST_ONLY-viewers.json');fs.writeFileSync(config,JSON.stringify({viewers:f.users}),{mode:0o600});
  const cli=fileURLToPath(new URL('../scripts/bootstrap-control.mjs',import.meta.url)),requestId=randomUUID(),actorId=randomUUID();
  const args=['--max-old-space-size=128',cli,'--directory',directory,'--account',f.account,'--viewer-config',config,'--hub-id',f.store.state().hubId,'--actor-id',actorId];
  const run=(id,recover=false)=>spawnSync(process.execPath,[...args,'--request-id',id,...recover?['--recover']:[]],{input:JSON.stringify({username:'owner',password}),encoding:'utf8',windowsHide:true,timeout:15_000,maxBuffer:8192});
  const first=run(requestId);assert.equal(first.status,0,first.stderr);const receipt=JSON.parse(first.stdout);assert.equal(receipt.current.manager,true);assert.equal(receipt.current.generation,1);
  const retry=run(requestId);assert.equal(retry.status,0,retry.stderr);assert.equal(JSON.parse(retry.stdout).duplicate,true);
  const conflict=run(randomUUID());assert.equal(conflict.status,1);assert.equal(conflict.stderr.includes(password),false);
  const recover=run(randomUUID(),true);assert.equal(recover.status,0,recover.stderr);assert.equal(JSON.parse(recover.stdout).current.generation,2);
  for(const value of [password,config,'TEST_ONLY-viewers'])assert.equal(first.stdout.includes(value),false);
});
