import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {ControlError} from '../lib/errors.mjs';
import {fixture,password,hash} from './fixtures/authority-fixture.mjs';
import {ViewerAccess} from '../../lib/viewer-access.mjs';
import {ControlIdentities} from '../broker/identity.mjs';
import {AuthorityStore} from '../broker/store.mjs';
import {HostConnections} from '../broker/host-channel.mjs';
import {enrollmentProof,channelProof,signMetadata} from '../host/enrollment.mjs';
import {createControlFacade} from '../../lib/control-facade.mjs';
import {LocalOwnerBoundary} from '../broker/local-owner.mjs';
const refused=callback=>assert.throws(callback,error=>error instanceof ControlError&&error.message==='Control foundation request refused');
const denied=callback=>assert.rejects(callback,error=>error instanceof ControlError&&error.message==='Control foundation request refused');
const issue=(f,operation=f.operation(),stage='DISPATCH')=>f.authority.issue(f.aliceSession.credential,{operation,stage,connection:f.connection});
const revokeGrant=f=>f.authority.putGrant(f.ownerSession.credential,{requestId:randomUUID(),value:{...f.grant,enabled:false,grantRevision:2},expectedRevision:1});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('named password reauthentication, explicit grant, broker consumption and final held-host check',async t=>{
  const f=await fixture(t),operation=f.operation(),assertion=issue(f,operation);
  assert.equal(f.policy.verifyAssertion({assertion,operation,stage:'DISPATCH'}).operation.operationId,operation.operationId);
  const permit=f.authority.consume(assertion);
  const receipt=f.policy.acceptPermit({assertion,permit,operation,stage:'DISPATCH'});
  assert.equal(receipt.authorized,true);assert.equal(receipt.nativeExecutionAllowed,false);
  refused(()=>f.authority.consume(assertion));
  refused(()=>f.policy.acceptPermit({assertion,permit,operation,stage:'DISPATCH'}));
  assert.equal(f.store.audit().at(-1).record.kind,'ASSERTION_DISPATCH');
});

test('observer administrator, imported identity objects and shared/local viewer credentials grant no execution',async t=>{
  const f=await fixture(t),operation=f.operation({actorId:f.ownerId});
  refused(()=>f.authority.issue(f.ownerSession.credential,{operation,stage:'DISPATCH',connection:f.connection}));
  refused(()=>f.authority.issue('x'.repeat(43),{operation,stage:'DISPATCH',connection:f.connection}));
  refused(()=>f.authority.issue(f.aliceSession.credential,{operation:f.operation(),stage:'DISPATCH',connection:{...f.connection}}));
  const shared=new ViewerAccess({viewTokenHash:hash('TEST_ONLY-shared')});
  const sharedIdentities=new ControlIdentities({getViewerAccess:()=>shared});
  const cookie=shared.issueCookie(shared.authenticateBearer('TEST_ONLY-shared'));
  await denied(()=>sharedIdentities.reauthenticate({cookie,username:'owner',password}));
  const local=new ViewerAccess();
  const localIdentity=new ControlIdentities({getViewerAccess:()=>local});
  await denied(()=>localIdentity.reauthenticate({cookie:local.issueCookie(local.localViewer),username:'owner',password}));
  sharedIdentities.close();localIdentity.close();
});

test('one-time bootstrap retries preserve audit, changed request conflicts, owner recovery advances generation',async t=>{
  const f=await fixture(t);
  refused(()=>f.authority.bootstrap(f.ownerSession.credential,{requestId:randomUUID(),actorId:f.ownerId,owner:f.ownerBoundary}));
  refused(()=>f.authority.bootstrap(f.ownerSession.credential,{requestId:randomUUID(),actorId:f.ownerId,owner:{directory:f.directory}}));
  const assertion=issue(f),requestId=randomUUID();
  const recovered=f.authority.bootstrap(f.ownerSession.credential,{requestId,actorId:f.ownerId,owner:f.ownerBoundary,recover:true});
  assert.equal(recovered.current.generation,2);
  const count=f.store.status().retainedRecords;
  const duplicate=f.authority.bootstrap(f.ownerSession.credential,{requestId,actorId:f.ownerId,owner:f.ownerBoundary,recover:true});
  assert.equal(duplicate.duplicate,true);assert.equal(f.store.status().retainedRecords,count);
  refused(()=>f.authority.consume(assertion));
  assert.equal(f.journal.status().records,0);
});

test('grant changes are revision-bound, least-scope and cannot create another grant manager',async t=>{
  const f=await fixture(t),assertion=issue(f);
  refused(()=>f.authority.putGrant(f.aliceSession.credential,{requestId:randomUUID(),value:{...f.grant,grantRevision:2},expectedRevision:1}));
  refused(()=>f.authority.putGrant(f.ownerSession.credential,{requestId:randomUUID(),value:{...f.grant,grantRevision:2,actions:['control.grants.manage']},expectedRevision:1}));
  refused(()=>f.authority.putGrant(f.ownerSession.credential,{requestId:randomUUID(),value:{...f.grant,grantRevision:3},expectedRevision:2}));
  revokeGrant(f);refused(()=>f.authority.consume(assertion));
  refused(()=>issue(f));
});

test('all immutable target/context differences, principal substitution, action widening and foreign keys refuse',async t=>{
  const f=await fixture(t),operation=f.operation();
  for(const mutate of [op=>op.actorId=randomUUID(),op=>op.target.hostId=randomUUID(),op=>op.target.projectId=randomUUID(),op=>op.target.providerProfileId=randomUUID(),op=>op.context.connectionEpoch=randomUUID(),op=>op.context.entityRevision++,op=>op.context.policyRevision++,op=>op.context.grantRevision++,op=>op.context.authorityGeneration++,op=>op.action='terminal.open']){
    const changed=structuredClone(operation);mutate(changed);refused(()=>issue(f,changed));
  }
  const assertion=issue(f,operation),forged=structuredClone(assertion);forged.body.operation.context.ownershipFence++;
  refused(()=>f.policy.verifyAssertion({assertion:forged,operation:forged.body.operation,stage:'DISPATCH'}));
  const other=generateKeyPairSync('ed25519');forged.signature=signMetadata(forged.body,other.privateKey);
  refused(()=>f.policy.verifyAssertion({assertion:forged,operation,stage:'DISPATCH'}));
});

test('current cookie logout, scope/password/role changes and disabled principals invalidate pending assertions',async t=>{
  const f=await fixture(t),first=issue(f);
  f.access.revokeCookie(f.aliceSession.cookie);refused(()=>f.authority.consume(first));
  f.aliceSession=await f.login('alice');const second=issue(f);
  f.changeUsers(f.users.map(user=>user.id==='alice'?{...user,hostIds:[]}:user));
  refused(()=>f.authority.consume(second));
  // A changed ViewerAccess configuration cannot revalidate an old cookie even
  // when other current fields happen to be equal.
  f.changeUsers(f.users);f.aliceSession=await f.login('alice');f.ownerSession=await f.login('owner');const third=issue(f);
  f.authority.putPrincipal(f.ownerSession.credential,{requestId:randomUUID(),principal:{actorId:f.actorId,viewerId:'alice',revision:2,enabled:false},expectedRevision:1});
  refused(()=>f.authority.consume(third));
});

test('reauthentication checks current identity after awaited password derivation',async t=>{
  const f=await fixture(t),identities=f.identities;
  const pending=identities.reauthenticate({cookie:f.aliceSession.cookie,username:'alice',password});
  f.changeUsers(f.users.map(user=>user.id==='alice'?{...user,disabled:true}:user));
  await denied(()=>pending);
});

test('short assertion expiry, monotonic auth time and recent management reauthentication fail closed',async t=>{
  const f=await fixture(t),assertion=issue(f);f.advance(3001);refused(()=>f.authority.consume(assertion));
  const second=issue(f);f.advance(-4000);refused(()=>f.authority.consume(second));f.advance(4000+300_001);
  refused(()=>f.authority.putGrant(f.ownerSession.credential,{requestId:randomUUID(),value:{...f.grant,grantRevision:2},expectedRevision:1}));
});

test('lost enrollment and activation responses are stable; duplicate receipts retain the current projection',async t=>{
  const f=await fixture(t),before=f.store.status().retainedRecords;
  const begin=f.authority.beginEnrollment(f.ownerSession.credential,f.beginInput);
  assert.equal(begin.duplicate,true);assert.equal(begin.current.state,'ACTIVE');
  const activated=f.authority.activateEnrollment(f.ownerSession.credential,f.activationInput);
  assert.equal(activated.duplicate,true);assert.equal(activated.current.generation,1);assert.equal(f.store.status().retainedRecords,before);
  refused(()=>f.authority.beginEnrollment(f.ownerSession.credential,{...f.beginInput,publicKey:generateKeyPairSync('ed25519').publicKey.export({format:'der',type:'spki'}).toString('base64')}));
  refused(()=>f.authority.activateEnrollment(f.ownerSession.credential,{...f.activationInput,signature:enrollmentProof(begin.current,generateKeyPairSync('ed25519').privateKey)}));
});

test('rotation activation advances host dispatch generation and revocation reports enforcement honestly',async t=>{
  const f=await fixture(t),assertion=issue(f),nextKey=generateKeyPairSync('ed25519');
  const pending=f.authority.beginEnrollment(f.ownerSession.credential,{...f.beginInput,requestId:randomUUID(),expectedGeneration:1,publicKey:nextKey.publicKey.export({format:'der',type:'spki'}).toString('base64')}).current;
  f.authority.activateEnrollment(f.ownerSession.credential,{requestId:randomUUID(),hostId:f.hostId,enrollmentRequestId:pending.requestId,signature:enrollmentProof(pending,nextKey.privateKey)});
  assert.equal(f.store.host(f.hostId).generation,2);refused(()=>f.authority.consume(assertion));
  const challenge=f.connections.challenge({hostId:f.hostId,generation:2,connectionEpoch:randomUUID()}),replacement=f.connections.authenticate({challengeId:challenge.challengeId,signature:channelProof(challenge,nextKey.privateKey)});
  const revoked=f.authority.revokeHost(f.ownerSession.credential,{requestId:randomUUID(),hostId:f.hostId,expectedGeneration:2});
  assert.equal(revoked.enforcement.status,'PENDING');assert.equal(revoked.enforcement.nativeStopConfirmed,false);
  f.connections.disconnect(replacement);assert.equal(f.connections.enforcement(f.hostId).status,'UNREACHABLE');
  const restart=new HostConnections({store:f.store,now:f.now});assert.equal(restart.enforcement(f.hostId).status,'UNKNOWN_AFTER_RESTART');restart.close();
});

test('host challenge is one use, expiring, exact epoch/generation and cannot accept collector credentials',async t=>{
  const f=await fixture(t),challenge=f.connections.challenge({hostId:f.hostId,generation:1,connectionEpoch:randomUUID()});
  refused(()=>f.connections.authenticate({challengeId:challenge.challengeId,signature:'TEST_ONLY-collector-token'}));
  refused(()=>f.connections.authenticate({challengeId:challenge.challengeId,signature:channelProof(challenge,f.hostKey.privateKey)}));
  const second=f.connections.challenge({hostId:f.hostId,generation:1,connectionEpoch:randomUUID()});
  f.advance(5001);refused(()=>f.connections.authenticate({challengeId:second.challengeId,signature:channelProof(second,f.hostKey.privateKey)}));
  refused(()=>f.connections.challenge({hostId:f.hostId,generation:2,connectionEpoch:randomUUID()}));
});

test('no offline action and no released ownership permit; final host gate checks broker proof and held root',async t=>{
  const f=await fixture(t),operation=f.operation(),assertion=issue(f,operation),permit=f.authority.consume(assertion);
  f.disconnect();refused(()=>f.policy.acceptPermit({assertion,permit,operation,stage:'DISPATCH'}));
  f.lease.release();refused(()=>f.policy.verifyAssertion({assertion,operation,stage:'DISPATCH'}));
  refused(()=>issue(f));
});

test('awaited facade responses cannot revive revoked grants or mutate the admitted envelope',async t=>{
  const f=await fixture(t);let release;
  const facade=createControlFacade({enabled:true,authority:f.authority,identities:f.identities,journal:f.journal,hostCheck:async ({assertion,operation,stage})=>{f.policy.verifyAssertion({assertion,operation,stage});await new Promise(resolve=>{release=resolve;});}});
  const operation=f.operation(),pending=facade.admit({credential:f.aliceSession.credential,operation,connection:f.connection});await tick();
  revokeGrant(f);release();await denied(()=>pending);assert.equal(f.journal.status().records,0);
});

test('facade freezes metadata before async work and disabled construction creates no storage or child',async t=>{
  const f=await fixture(t);let release;
  const facade=createControlFacade({enabled:true,authority:f.authority,identities:f.identities,journal:f.journal,hostCheck:async ({assertion,operation,stage})=>{f.policy.verifyAssertion({assertion,operation,stage});await new Promise(resolve=>{release=resolve;});}});
  const operation=f.operation(),original=structuredClone(operation),pending=facade.admit({credential:f.aliceSession.credential,operation,connection:f.connection});await tick();
  operation.target.projectId=randomUUID();release();const admitted=await pending;
  assert.deepEqual(admitted.operation.envelope,original);
  const before=fs.readdirSync(f.directory),disabled=createControlFacade();assert.equal(disabled.identity().enabled,false);assert.deepEqual(fs.readdirSync(f.directory),before);
  assert.equal(facade.identity().nativeExecutionAllowed,false);
});

test('forbidden content, private proofs, passwords and credential fingerprints do not enter durable authority/journal files',async t=>{
  const f=await fixture(t),operation=f.operation(),assertion=issue(f,operation);f.authority.consume(assertion);
  const forbidden={...operation,prompt:'TEST_ONLY_PRIVATE_PROMPT_NEVER_DURABLE'};refused(()=>issue(f,forbidden));
  const sentinel='TEST_ONLY_PRIVATE_PROMPT_NEVER_DURABLE';
  for(const file of fs.readdirSync(f.directory).filter(name=>name.startsWith('control-authority.sqlite'))){
    const bytes=fs.readFileSync(path.join(f.directory,file));
    for(const value of [sentinel,password,f.aliceSession.credential,hash(password),hash(f.aliceSession.credential),f.activationInput.signature])assert.equal(bytes.includes(Buffer.from(value)),false);
  }
  for(const record of f.store.audit())assert.deepEqual(Object.keys(record.record).sort(),['actorId','atMs','eventId','generation','kind','requestId','revision','subjectId','version']);
});

test('authority state survives close/reopen with audit and pending custody; foreign hub/schema refused',async t=>{
  const f=await fixture(t),count=f.store.status().retainedRecords,hubId=f.store.state().hubId;f.store.close();
  refused(()=>AuthorityStore.open({directory:f.directory,owner:f.ownerBoundary,hubId:randomUUID(),now:f.now}));
  const reopened=AuthorityStore.open({directory:f.directory,owner:f.ownerBoundary,hubId,now:f.now});
  assert.equal(reopened.status().retainedRecords,count);reopened.close();
});

test('bounded facade concurrency refuses excess work without forgetting active checks',async t=>{
  const f=await fixture(t);let release;const barrier=new Promise(resolve=>{release=resolve;});
  const facade=createControlFacade({enabled:true,authority:f.authority,identities:f.identities,journal:f.journal,hostCheck:()=>barrier});
  const pending=Array.from({length:32},()=>facade.admit({credential:f.aliceSession.credential,operation:f.operation(),connection:f.connection}));
  assert.equal(facade.status().activeHostChecks,32);
  await denied(()=>facade.admit({credential:f.aliceSession.credential,operation:f.operation(),connection:f.connection}));
  assert.equal(facade.status().activeHostChecks,32);release();await Promise.all(pending);assert.equal(facade.status().activeHostChecks,0);
});

test('publication uses a synchronous owned writer only after the fresh post-await authority check',async t=>{
  const f=await fixture(t);let release,writes=0;
  const facade=createControlFacade({enabled:true,authority:f.authority,identities:f.identities,journal:f.journal,hostCheck:()=>new Promise(resolve=>{release=resolve;})});
  const operation=f.operation(),pending=facade.publish({credential:f.aliceSession.credential,operation,connection:f.connection,write:()=>{writes++;}});await tick();
  f.access.revokeCookie(f.aliceSession.cookie);release();await denied(()=>pending);assert.equal(writes,0);
  await denied(()=>facade.publish({credential:f.ownerSession.credential,operation,connection:f.connection,write:async()=>{writes++;}}));assert.equal(writes,0);
});

test('owner recovery preserves UNKNOWN operation history and every unarchived version',async t=>{
  const f=await fixture(t),operation=f.operation(),saved=f.journal.admit(operation).operation;
  f.journal.transition({operationId:operation.operationId,eventId:randomUUID(),expectedRevision:saved.revision,type:'DISPATCH_INTENT',atMs:f.now(),context:operation.context});
  f.disconnect();f.journal.recover({connectionEpoch:operation.context.connectionEpoch,atMs:f.now()});
  const before=f.journal.read(),status=f.journal.status();assert.equal(f.journal.get(operation.operationId).state,'UNKNOWN');
  f.authority.bootstrap(f.ownerSession.credential,{requestId:randomUUID(),actorId:f.ownerId,owner:f.ownerBoundary,recover:true});
  assert.deepEqual(f.journal.read(),before);assert.equal(f.journal.status().pendingRecords,status.pendingRecords);assert.equal(f.journal.get(operation.operationId).state,'UNKNOWN');
});

test('owner boundary rejects a claimed different OS account and foreign exceptions remain fixed',async t=>{
  const f=await fixture(t);refused(()=>LocalOwnerBoundary.open({directory:f.directory,account:process.platform==='win32'?'S-1-5-18':'999999'}));
  const identities=new ControlIdentities({getViewerAccess:()=>{throw new Error('TEST_ONLY_PRIVATE_AUTH_FAILURE');}});
  refused(()=>identities.authenticate('x'.repeat(43)));
  await denied(()=>identities.reauthenticate({cookie:'x',username:'owner',password}));identities.close();
});
test('owner recovery cannot rebind another actor UUID and exact recovery retries survive later principal revisions',async t=>{
  const f=await fixture(t),requestId=randomUUID();
  f.authority.bootstrap(f.ownerSession.credential,{requestId,actorId:f.ownerId,owner:f.ownerBoundary,recover:true});
  f.authority.putPrincipal(f.ownerSession.credential,{requestId:randomUUID(),principal:{actorId:f.ownerId,viewerId:'owner',revision:2,enabled:true},expectedRevision:1});
  const count=f.store.status().retainedRecords;
  assert.equal(f.authority.bootstrap(f.ownerSession.credential,{requestId,actorId:f.ownerId,owner:f.ownerBoundary,recover:true}).duplicate,true);
  assert.equal(f.store.status().retainedRecords,count);assert.equal(f.store.principal(f.ownerId).revision,2);
  f.changeUsers([...f.users,{id:'charlie',label:'Fixture recovery account',tokenHash:hash('TEST_ONLY-charlie'),hostIds:null,username:'charlie',passwordHash:f.users[0].passwordHash}]);
  const charlie=await f.login('charlie');
  refused(()=>f.authority.bootstrap(charlie.credential,{requestId:randomUUID(),actorId:f.ownerId,owner:f.ownerBoundary,recover:true}));
  assert.equal(f.store.state().generation,2);assert.equal(f.store.principal(f.ownerId).viewerId,'owner');assert.equal(f.store.principalForViewer('charlie'),null);
});
