// Synthetic lifecycle qualification ONLY. No native Codex or provider turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {lifecycleFixture,deferred,refused,sentinels} from './fixtures/codex-runtime-fixture.mjs';
import {CodexLifecycle} from '../providers/codex/lifecycle.mjs';
import {CodexSessionRegistry} from '../providers/codex/session-registry.mjs';
import {codexSpawnPlan} from '../providers/codex/process.mjs';
import {ControlError} from '../lib/errors.mjs';

const focused=(name,fn)=>test(name,{timeout:20000,concurrency:false},fn);
const throwsControl=(fn,code)=>assert.throws(fn,e=>e instanceof ControlError&&(!code||e.code===code));

focused('launch/create/start/steer/interrupt/final/stop/relaunch/resume exactly once',async t=>{
  const h=await lifecycleFixture(t),{runtime}=await h.ready();
  assert.equal(h.registry.runtime(h.runtimeId).state,'READY');
  const started=await h.start();assert.equal(started.result.state,'RUNNING');
  const steer=h.op('turn.steer',{turnId:runtime.turnId});
  assert.equal((await h.lifecycle.steerTurn(steer,h.consent(steer))).state,'COMPLETED');
  const interrupt=h.op('turn.interrupt',{turnId:runtime.turnId});
  const ack=await h.lifecycle.interruptTurn(interrupt);
  assert.equal(ack.state,'INTERRUPT_REQUESTED');assert.equal(ack.nativeStopConfirmed,false);
  assert.equal(h.lifecycle.operation(started.operation.operationId).state,'RUNNING');
  assert.equal(h.registry.session(h.sessionId).activeTurnId,runtime.turnId);
  runtime.complete('interrupted');
  assert.equal(h.lifecycle.operation(started.operation.operationId).state,'INTERRUPTED');
  assert.equal(h.lifecycle.operation(interrupt.operationId).state,'INTERRUPTED');
  assert.equal(h.registry.session(h.sessionId).activeTurnId,null);
  const stopped=await h.lifecycle.stopOwnedRuntime(h.op('runtime.stop'));
  assert.equal(stopped.processExitConfirmed,true);assert.equal(stopped.processTreeExitConfirmed,false);
  assert.deepEqual(h.controls.stops,[runtime]);
  const next=randomUUID();await h.launch(next);
  const resume=h.op('session.resume',{runtimeId:next});await h.lifecycle.resumeOwnedSession(resume);
  assert.equal(h.registry.session(h.sessionId).currentRuntimeId,next);
  assert.equal(h.registry.session(h.sessionId).nativeThreadId,runtime.threadId);
  assert.equal(h.controls.calls.find(c=>c.method==='thread/resume').excludeTurns,true);
  await refused(h.lifecycle.resumeOwnedSession(resume));
  assert.equal(h.count('thread/start'),1);assert.equal(h.count('thread/resume'),1);
  assert.equal(h.count('turn/start'),1);assert.equal(h.count('turn/steer'),1);assert.equal(h.count('turn/interrupt'),1);
  await h.lifecycle.stopOwnedRuntime(h.op('runtime.stop',{runtimeId:next}));h.lifecycle.close();
});

focused('same journal operation is never replayed after successful session creation',async t=>{
  const h=await lifecycleFixture(t),{createOperation}=await h.ready();
  await refused(h.lifecycle.createSession(createOperation));
  assert.equal(h.count('thread/start'),1);
  assert.equal(h.lifecycle.operation(createOperation.operationId).state,'COMPLETED');
});

focused('unknown session and foreign runtime/native identifiers cannot select a session',async t=>{
  const h=await lifecycleFixture(t),{runtime}=await h.ready();
  for(const target of [{sessionId:randomUUID()},{sessionId:runtime.threadId},{runtimeId:randomUUID()}]){
    const op=h.op('turn.start',target);await refused(h.lifecycle.startTurn(op,h.consent(op)),'STALE_CONTEXT');
  }
  assert.equal(h.count('turn/start'),0);
});

focused('stale turn steer/interrupt refuse before native send',async t=>{
  const h=await lifecycleFixture(t);await h.ready();await h.start();
  const steer=h.op('turn.steer',{turnId:randomUUID()});
  await refused(h.lifecycle.steerTurn(steer,h.consent(steer)),'STALE_CONTEXT');
  await refused(h.lifecycle.interruptTurn(h.op('turn.interrupt',{turnId:randomUUID()})),'STALE_CONTEXT');
  assert.equal(h.count('turn/steer'),0);assert.equal(h.count('turn/interrupt'),0);
});

focused('lost start reply is UNKNOWN, blocks resume, and never retries automatically',async t=>{
  const h=await lifecycleFixture(t);await h.ready();
  h.controls.afterWrite=method=>{if(method==='turn/start')throw new Error(sentinels.error);};
  const op=h.op('turn.start');await refused(h.lifecycle.startTurn(op,h.consent(op)));
  assert.equal(h.lifecycle.operation(op.operationId).state,'UNKNOWN');
  assert.equal(h.registry.runtime(h.runtimeId).state,'UNKNOWN');assert.equal(h.registry.session(h.sessionId).state,'UNKNOWN');
  await refused(h.lifecycle.startTurn(op,h.consent(op)),'STALE_CONTEXT');
  await h.lifecycle.stopOwnedRuntime(h.op('runtime.stop'));const next=randomUUID();await h.launch(next);
  await refused(h.lifecycle.resumeOwnedSession(h.op('session.resume',{runtimeId:next})),'STALE_CONTEXT');
  assert.equal(h.count('turn/start'),1);assert.equal(h.count('thread/resume'),0);
});

for(const mutation of ['revoke','logout','expiry']) focused(`${mutation} while dispatch authorization awaits prevents native turn send`,async t=>{
  const h=await lifecycleFixture(t);await h.ready();
  const reached=deferred(),release=deferred();
  h.controls.beforeAuthorize=async(op,stage)=>{if(stage==='DISPATCH'&&op.action==='turn.start'){reached.resolve();await release.promise;}};
  const op=h.op('turn.start'),pending=h.lifecycle.startTurn(op,h.consent(op));const check=refused(pending);
  await reached.promise;
  if(mutation==='revoke')h.revoke();else if(mutation==='logout')h.identities.logout(h.aliceSession.credential);else h.advance(60001);
  release.resolve();await check;assert.equal(h.count('turn/start'),0);
});

focused('expired already-consumed dispatch permit is rechecked at final beforeWrite',async t=>{
  const h=await lifecycleFixture(t);await h.ready();
  h.controls.beforeWrite=method=>{if(method==='turn/start')h.advance(3001);};
  const op=h.op('turn.start');await refused(h.lifecycle.startTurn(op,h.consent(op)),'STALE_CONTEXT');
  assert.equal(h.count('turn/start'),0);
});

focused('publication reauthorizes after native reply await and refuses revoked grant',async t=>{
  const h=await lifecycleFixture(t);await h.ready();const reached=deferred(),release=deferred();
  h.controls.afterWrite=async method=>{if(method==='turn/start'){reached.resolve();await release.promise;}};
  const op=h.op('turn.start'),check=refused(h.lifecycle.startTurn(op,h.consent(op)));
  await reached.promise;h.revoke();release.resolve();await check;
  assert.equal(h.count('turn/start'),1);assert.equal(h.lifecycle.operation(op.operationId).state,'UNKNOWN');
  assert.equal(h.registry.session(h.sessionId).state,'UNKNOWN');
});

focused('publication checks expiry after authorization await, without resending',async t=>{
  const h=await lifecycleFixture(t);await h.ready();
  h.controls.afterAuthorize=(op,stage)=>{if(stage==='PUBLICATION'&&op.action==='turn.start')h.advance(3001);};
  const op=h.op('turn.start');await refused(h.lifecycle.startTurn(op,h.consent(op)),'STALE_CONTEXT');
  assert.equal(h.count('turn/start'),1);assert.equal(h.lifecycle.operation(op.operationId).state,'UNKNOWN');
});

focused('native account logout prevents session creation',async t=>{
  const h=await lifecycleFixture(t);await h.launch();h.controls.accountState='UNAUTHENTICATED';
  await refused(h.lifecycle.createSession(h.op('session.create')));
  assert.equal(h.count('thread/start'),0);
});

focused('native account logout prevents turn start',async t=>{
  const h=await lifecycleFixture(t);await h.ready();h.controls.accountState='UNAUTHENTICATED';
  const op=h.op('turn.start');await refused(h.lifecycle.startTurn(op,h.consent(op)));
  assert.equal(h.count('turn/start'),0);
});

focused('ownership fence/epoch mismatch and closed held root refuse before spawn',async t=>{
  const h=await lifecycleFixture(t);
  for(const key of ['ownershipFence','connectionEpoch']){
    const op=h.op('runtime.launch');op.context={...op.context,[key]:key==='ownershipFence'?op.context[key]+1:randomUUID()};
    await refused(h.lifecycle.launchRuntime(op),'STALE_CONTEXT');
  }
  h.root.close();await refused(h.lifecycle.launchRuntime(h.op('runtime.launch')));
  assert.equal(h.controls.runtimes.length,0);
});

focused('released held ownership lease refuses before spawn',async t=>{
  const h=await lifecycleFixture(t);h.lease.release();
  await refused(h.lifecycle.launchRuntime(h.op('runtime.launch')));assert.equal(h.controls.runtimes.length,0);
});

focused('fixed methods and narrowed input policy ignore no caller overrides',async t=>{
  const h=await lifecycleFixture(t);await h.ready();await h.start();
  assert.deepEqual(h.controls.calls.map(c=>c.method),['initialize','initialized','account/read','model/list','account/read','thread/start','account/read','turn/start']);
  const call=h.controls.calls.find(c=>c.method==='turn/start');
  assert.deepEqual(call.keys,['approvalPolicy','approvalsReviewer','cwd','effort','input','model','sandboxPolicy','serviceTier','threadId'].sort());
  assert.deepEqual(call.inputKeys,[['text','type']]);assert.equal(call.hasExpectedText,true);
  assert.equal(call.model,'gpt-6.1-sol');assert.equal(call.effort,'high');assert.equal(call.serviceTier,'default');
  assert.equal(call.approvalPolicy,'never');assert.equal(call.approvalsReviewer,'user');assert.deepEqual(call.policy,{type:'readOnly',networkAccess:false});
  const op=h.op('turn.start');await refused(h.lifecycle.startTurn({...op,model:'other'},h.consent(op)),'INVALID_INPUT');
  await refused(h.lifecycle.launchRuntime(h.op('runtime.launch',{sessionId:randomUUID()})),'INVALID_INPUT');
});

for(const bad of ['scope','kind','expired','used','oversized','invalid-utf8']) focused(`bound consent ${bad} prevents native send`,async t=>{
  const h=await lifecycleFixture(t);await h.ready();const op=h.op('turn.start');
  const options=bad==='scope'?{scopeId:randomUUID()}:bad==='kind'?{kind:'transport'}:bad==='expired'?{ttlMs:1}:bad==='oversized'?{bytes:Buffer.alloc(16385,65)}:bad==='invalid-utf8'?{bytes:Buffer.from([0xff])}:{};
  const id=h.consent(op,options);
  if(bad==='expired')h.advance(2);
  if(bad==='used'){const bytes=h.content.consumeBound({id,scopeId:op.operationId,kind:'turn-consent'});bytes.fill(0);}
  await refused(h.lifecycle.startTurn(op,id));assert.equal(h.count('turn/start'),0);
});

focused('successful bound consent is single use and absent after send',async t=>{
  const h=await lifecycleFixture(t);await h.ready();const op=h.op('turn.start'),id=h.consent(op);
  await h.lifecycle.startTurn(op,id);
  throwsControl(()=>h.content.consumeBound({id,scopeId:op.operationId,kind:'turn-consent'}),'REPLAY_UNAVAILABLE');
  assert.equal(h.content.stats().bytes,0);assert.equal(h.count('turn/start'),1);
});

focused('raw prompt/output/error sentinels stay out of journal/registry and SQLite bytes',async t=>{
  const h=await lifecycleFixture(t),{runtime}=await h.ready();const started=await h.start();runtime.complete();
  h.controls.afterWrite=method=>{if(method==='turn/start')throw new Error(sentinels.error);};
  const failed=h.op('turn.start');await refused(h.lifecycle.startTurn(failed,h.consent(failed)));
  const projected=JSON.stringify({runtime:h.registry.runtime(h.runtimeId),session:h.registry.session(h.sessionId),started:h.journal.get(started.operation.operationId),failed:h.journal.get(failed.operationId)});
  const files=[h.journal.file,path.join(h.directory,'codex-lineage.sqlite')].flatMap(file=>['','-wal','-shm'].map(s=>file+s)).filter(file=>fs.existsSync(file));
  for(const sentinel of Object.values(sentinels)){
    assert.equal(projected.includes(sentinel),false,'metadata excludes synthetic content');
    for(const file of files)assert.equal(fs.readFileSync(file).includes(Buffer.from(sentinel)),false,'SQLite bytes exclude synthetic content');
  }
  assert.equal(h.content.stats().bytes,0);
});

focused('unsolicited and foreign completion cannot finalize a tracked turn',async t=>{
  const h=await lifecycleFixture(t),{runtime}=await h.ready();
  throwsControl(()=>runtime.complete(),'STALE_CONTEXT');const started=await h.start();
  throwsControl(()=>runtime.complete('completed',runtime.turnId,randomUUID()),'STALE_CONTEXT');
  assert.equal(h.lifecycle.operation(started.operation.operationId).state,'RUNNING');runtime.complete();
  assert.equal(h.lifecycle.operation(started.operation.operationId).state,'COMPLETED');
});

focused('native server request and account update put runtime on hold',async t=>{
  const h=await lifecycleFixture(t),{runtime}=await h.ready();
  runtime.options.onServerRequest({method:'item/commandExecution/requestApproval'});
  const op=h.op('turn.start');await refused(h.lifecycle.startTurn(op,h.consent(op)),'STALE_CONTEXT');
  assert.equal(h.count('turn/start'),0);
  await h.lifecycle.stopOwnedRuntime(h.op('runtime.stop'));const id=randomUUID(),launched=await h.launch(id);
  launched.runtime.options.onNotification({method:'account/updated',params:{}});
  await refused(h.lifecycle.createSession(h.op('session.create',{runtimeId:id,sessionId:randomUUID()})),'STALE_CONTEXT');
});

focused('completion before start reply is applied after native turn correlation',async t=>{
  const h=await lifecycleFixture(t),{runtime}=await h.ready();
  h.controls.afterWrite=method=>{if(method==='turn/start')runtime.complete();};
  const started=await h.start();assert.equal(started.result.state,'COMPLETED');
  assert.equal(h.registry.session(h.sessionId).activeTurnId,null);assert.equal(h.lifecycle.status().earlyMetadata,0);
});

focused('completion before interrupt ACK is final proof and is not downgraded by ACK',async t=>{
  const h=await lifecycleFixture(t),{runtime}=await h.ready();await h.start();
  h.controls.afterWrite=method=>{if(method==='turn/interrupt')runtime.complete('interrupted');};
  const result=await h.lifecycle.interruptTurn(h.op('turn.interrupt',{turnId:runtime.turnId}));
  assert.equal(result.state,'INTERRUPTED');assert.equal(result.nativeStopConfirmed,true);
});

focused('storage refusal rolls back intent and prevents native thread send',async t=>{
  const h=await lifecycleFixture(t);await h.launch();
  await h.withRegistryPressure(()=>refused(h.lifecycle.createSession(h.op('session.create')),'CAPACITY'));
  assert.equal(h.count('thread/start'),0);assert.equal(h.registry.session(h.sessionId),null);
});

focused('onClose marks runtime/session/active operation UNKNOWN',async t=>{
  const h=await lifecycleFixture(t),{runtime}=await h.ready(),started=await h.start();runtime.options.onClose();
  assert.equal(h.registry.runtime(h.runtimeId).state,'UNKNOWN');assert.equal(h.registry.session(h.sessionId).state,'UNKNOWN');
  assert.equal(h.lifecycle.operation(started.operation.operationId).state,'UNKNOWN');
  const op=h.op('turn.start');await refused(h.lifecycle.startTurn(op,h.consent(op)),'STALE_CONTEXT');assert.equal(h.count('turn/start'),1);
});

focused('restarted lifecycle never adopts saved PID and only stops retained runtime object',async t=>{
  const h=await lifecycleFixture(t),{runtime}=await h.ready();runtime.options.onClose();
  const restarted=new CodexLifecycle(h.options);assert.equal(h.registry.runtime(h.runtimeId).pid,runtime.metadata.pid);
  await refused(restarted.stopOwnedRuntime(h.op('runtime.stop')),'CONFLICT');assert.equal(h.controls.stops.length,0);restarted.close();
  await h.lifecycle.stopOwnedRuntime(h.op('runtime.stop'));assert.deepEqual(h.controls.stops,[runtime]);
  // Pure pre-launch check: a synthetic profile must never reach a real spawn plan.
  throwsControl(()=>codexSpawnPlan(h.profile,h.root),'CONTROL_DISABLED');
});

focused('resume refuses mismatching native thread ID and marks UNKNOWN',async t=>{
  const h=await lifecycleFixture(t);await h.ready();await h.lifecycle.stopOwnedRuntime(h.op('runtime.stop'));
  const id=randomUUID();await h.launch(id);
  h.controls.afterWrite=(method,params,runtime)=>method==='thread/resume'?{model:'gpt-6.1-sol',modelProvider:'openai',reasoningEffort:'high',serviceTier:'default',cwd:h.root.directory,approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false},thread:{id:runtime.threadId}}:undefined;
  const op=h.op('session.resume',{runtimeId:id});await refused(h.lifecycle.resumeOwnedSession(op),'STALE_CONTEXT');
  assert.equal(h.lifecycle.operation(op.operationId).state,'UNKNOWN');assert.equal(h.registry.session(h.sessionId).state,'UNKNOWN');assert.equal(h.count('thread/resume'),1);
});

focused('busy runtime refuses a concurrent session command without native replay',async t=>{
  const h=await lifecycleFixture(t);await h.launch();const reached=deferred(),release=deferred();
  h.controls.afterWrite=async method=>{if(method==='thread/start'){reached.resolve();await release.promise;}};
  const first=h.lifecycle.createSession(h.op('session.create'));await reached.promise;
  await refused(h.lifecycle.createSession(h.op('session.create',{sessionId:randomUUID()})),'CONFLICT');
  release.resolve();await first;assert.equal(h.count('thread/start'),1);
});

focused('two retained runtimes cap launch before a third spawn',async t=>{
  const h=await lifecycleFixture(t);await h.launch();await h.launch(randomUUID());
  await refused(h.lifecycle.launchRuntime(h.op('runtime.launch',{runtimeId:randomUUID()})),'CAPACITY');assert.equal(h.controls.runtimes.length,2);
});

focused('journal write failure before launch dispatch prevents even synthetic spawn',async t=>{
  const h=await lifecycleFixture(t);h.journal.close();
  await refused(h.lifecycle.launchRuntime(h.op('runtime.launch')));assert.equal(h.controls.runtimes.length,0);
});

focused('registry persists exact lineage across close/open without native history',async t=>{
  const h=await lifecycleFixture(t),{runtime}=await h.ready();
  h.registry.close();
  const reopened=CodexSessionRegistry.open({directory:h.directory,owner:h.ownerBoundary,guard:()=>{h.root.assertCurrent();h.lease.assertCurrent();},now:h.now});
  h.addCleanup(()=>reopened.close());
  const db=new DatabaseSync(path.join(h.directory,'codex-lineage.sqlite'),{readOnly:true});
  try{
    const session=JSON.parse(db.prepare('SELECT metadata FROM sessions WHERE session_id=?').get(h.sessionId).metadata);
    assert.equal(session.nativeThreadId,runtime.threadId);assert.equal(session.accountBinding,h.profile.metadata.accountBinding);
    assert.equal(session.profileId,h.profileId);assert.equal(session.hostId,h.hostId);assert.equal(session.projectId,h.projectId);
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM lifecycle_events').get().n>=4);
    assert.equal(reopened.session(h.sessionId).nativeThreadId,runtime.threadId);
    assert.equal(reopened.status().nativeHistoryCollected,false);
  }finally{db.close();}
});

test('per-session request pins document byte limit before native dispatch',async t=>{
 const h=await lifecycleFixture(t);await h.ready();
 const call=h.controls.calls.find(value=>value.method==='thread/start');
 assert.equal(call.projectDocMaxBytes,0);
});