import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {lifecycleFixture,deferred,refused} from './fixtures/codex-runtime-fixture.mjs';
import {ControlError} from '../lib/errors.mjs';
const focused=(name,fn)=>test(name,{timeout:60000,concurrency:false},fn);
focused('concurrent launch reservations enforce two runtime slots before any await',async t=>{
  const h=await lifecycleFixture(t),wait=deferred();h.controls.beforeAuthorize=async(_op,stage)=>{if(stage==='ADMISSION')await wait.promise;};
  const one=h.lifecycle.launchRuntime(h.op('runtime.launch')),two=h.lifecycle.launchRuntime(h.op('runtime.launch',{runtimeId:randomUUID()}));
  await refused(h.lifecycle.launchRuntime(h.op('runtime.launch',{runtimeId:randomUUID()})),'CAPACITY');wait.resolve();await Promise.all([one,two]);assert.equal(h.controls.runtimes.length,2);
});
focused('one active or starting turn across runtimes bounds native model concurrency',async t=>{
  const h=await lifecycleFixture(t);await h.ready();const other=randomUUID(),session=randomUUID();await h.launch(other);await h.lifecycle.createSession(h.op('session.create',{runtimeId:other,sessionId:session}));
  const started=await h.start(),op=h.op('turn.start',{runtimeId:other,sessionId:session});await refused(h.lifecycle.startTurn(op,h.consent(op)),'CAPACITY');assert.equal(h.count('turn/start'),1);
  h.controls.runtimes[0].complete('completed');assert.equal(h.lifecycle.operation(started.operation.operationId).state,'COMPLETED');
});
focused('confirmed stop of active work clears transient caches and retains UNKNOWN lineage',async t=>{
  const h=await lifecycleFixture(t);await h.ready();const started=await h.start();const result=await h.lifecycle.stopOwnedRuntime(h.op('runtime.stop'));
  assert.equal(result.processExitConfirmed,true);assert.equal(result.processTreeExitConfirmed,false);assert.equal(h.lifecycle.status().activeTurns,0);assert.equal(h.registry.session(h.sessionId).state,'UNKNOWN');assert.equal(h.lifecycle.operation(started.operation.operationId).state,'UNKNOWN');
});
focused('profile drift fences new work while owned runtime stop remains available',async t=>{
  const h=await lifecycleFixture(t);await h.ready();h.profile.assertCurrent=()=>{throw new ControlError('STALE_CONTEXT');};
  await refused(h.lifecycle.createSession(h.op('session.create',{sessionId:randomUUID()})),'STALE_CONTEXT');
  const stopped=await h.lifecycle.stopOwnedRuntime(h.op('runtime.stop'));assert.equal(stopped.processExitConfirmed,true);assert.equal(h.controls.stops.length,1);
});
focused('late final metadata remains durable after publication authority is revoked',async t=>{
  const h=await lifecycleFixture(t),{runtime}=await h.ready();
  h.controls.beforeAuthorize=async(op,stage)=>{if(op.action==='turn.start'&&stage==='PUBLICATION')h.revoke();};
  const op=h.op('turn.start');await refused(h.lifecycle.startTurn(op,h.consent(op)));
  assert.equal(h.registry.session(h.sessionId).state,'UNKNOWN');runtime.complete('completed');
  assert.equal(h.registry.session(h.sessionId).lastTurnStatus,'completed');assert.equal(h.registry.session(h.sessionId).state,'UNKNOWN');assert.equal(h.lifecycle.operation(op.operationId).state,'UNKNOWN');assert.equal(h.lifecycle.status().activeTurns,0);
});


for(const action of ['turn.start','turn.steer','turn.interrupt'])focused('registry failures at '+action+' entry expose only fixed errors',async t=>{
  const h=await lifecycleFixture(t),{runtime}=await h.ready();if(action!=='turn.start')await h.start();
  const op=h.op(action,{turnId:action==='turn.start'?null:runtime.turnId}),id=h.consent(op),original=fs.lstatSync,target=path.join(h.directory,'codex-lineage.sqlite');
  fs.lstatSync=(file,...args)=>{if(String(file)===target)throw new Error('TEST_ONLY_PRIVATE_PATH_STORAGE_ERROR');return original(file,...args);};
  try{const pending=action==='turn.start'?h.lifecycle.startTurn(op,id):action==='turn.steer'?h.lifecycle.steerTurn(op,id):h.lifecycle.interruptTurn(op);await refused(pending,'STORAGE_UNAVAILABLE');}finally{fs.lstatSync=original;}
});
