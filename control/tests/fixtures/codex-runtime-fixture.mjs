// TEST_ONLY: real P2 authority/storage; no native process, network or provider calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture} from './authority-fixture.mjs';
import {CodexLifecycle} from '../../providers/codex/lifecycle.mjs';
import {CodexSessionRegistry} from '../../providers/codex/session-registry.mjs';
import {CODEX_LIFECYCLE_PIN} from '../../providers/codex/compatibility.mjs';
import {createTransientContentStore} from '../../lib/transient-content.mjs';
import {ControlError} from '../../lib/errors.mjs';

export const sentinels = Object.freeze({prompt:'TEST_ONLY_PROMPT_NEVER_DURABLE_7c91',output:'TEST_ONLY_OUTPUT_NEVER_DURABLE_28af',error:'TEST_ONLY_ERROR_NEVER_DURABLE_b104'});
export const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise,resolve}; };
export const refused = (promise, code) => assert.rejects(promise, error => {
  assert.ok(error instanceof ControlError);
  assert.equal(error.message, 'Control foundation request refused');
  if (code) assert.equal(error.code, code);
  return true;
});

export async function lifecycleFixture(t) {
  const f = await fixture(t);
  const grant = {...f.grant,grantRevision:2,actions:['runtime.launch','runtime.stop','session.create','session.resume','turn.start','turn.steer','turn.interrupt','control.inspect']};
  f.authority.putGrant(f.ownerSession.credential,{requestId:randomUUID(),value:grant,expectedRevision:1});
  const registry = CodexSessionRegistry.open({directory:f.directory,owner:f.ownerBoundary,guard:()=>{f.root.assertCurrent();f.lease.assertCurrent();},now:f.now});
  const content = createTransientContentStore({clock:f.now});
  f.addCleanup(()=>{content.close();registry.close();});
  const metadata = Object.freeze({...CODEX_LIFECYCLE_PIN,profileId:f.profileId,accountRef:randomUUID(),accountBinding:randomUUID(),rootSha:f.root.identity().sha256,model:'gpt-6.1-sol',effort:'high',serviceTier:'default'});
  const controls = {beforeAuthorize:null,afterAuthorize:null,beforeWrite:null,afterWrite:null,accountState:'AUTHENTICATED',runtimes:[],stops:[],calls:[]};
  const profile = {metadata,assertCurrent:()=>metadata,checkAccount:()=>({state:controls.accountState,accountRef:metadata.accountRef})};
  const authorize = async (op,stage) => {
    if(controls.beforeAuthorize) await controls.beforeAuthorize(op,stage);
    const assertion = f.authority.issue(f.aliceSession.credential,{operation:op,stage,connection:f.connection});
    const permit = f.authority.consume(assertion);
    if(controls.afterAuthorize) await controls.afterAuthorize(op,stage);
    return {assertion,permit};
  };
  const factory = options => {
    assert.equal(options.profile,profile); assert.equal(options.root,f.root);
    assert.equal(options.beforeSpawn(),undefined);
    const runtime = {metadata:{pid:42000+controls.runtimes.length,processBinding:randomUUID()},threadId:randomUUID(),turnId:randomUUID(),options,
      assertCurrent(){return this.metadata;},
      async request(method,params,{beforeWrite}) {
        if(controls.beforeWrite) await controls.beforeWrite(method,params,runtime);
        assert.equal(beforeWrite(),undefined);
        // Keep only method/shape metadata in assertion records, never synthetic text.
        controls.calls.push({runtime,method,keys:Object.keys(params).sort(),inputKeys:params.input?.map(x=>Object.keys(x).sort()),policy:params.sandboxPolicy,model:params.model,effort:params.effort,serviceTier:params.serviceTier,approvalPolicy:params.approvalPolicy,approvalsReviewer:params.approvalsReviewer,threadId:params.threadId,expectedTurnId:params.expectedTurnId,excludeTurns:params.excludeTurns,projectDocMaxBytes:params.config?.project_doc_max_bytes,hasExpectedText:params.input?.[0]?.text===sentinels.prompt});
        if(controls.afterWrite){const result=await controls.afterWrite(method,params,runtime);if(result!==undefined)return result;}
        if(method==='initialize'||method==='turn/interrupt')return {};
        if(method==='account/read')return {account:{type:'chatgpt'},requiresOpenaiAuth:true};
        if(method==='model/list')return {data:[{model:'gpt-6.1-sol',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]};
        if(method==='thread/start'||method==='thread/resume')return {model:'gpt-6.1-sol',modelProvider:'openai',reasoningEffort:'high',serviceTier:'default',cwd:f.root.directory,approvalPolicy:'never',approvalsReviewer:'user',instructionSources:[],sandbox:{type:'readOnly',networkAccess:false},thread:{id:method==='thread/resume'?params.threadId:runtime.threadId}};
        if(method==='turn/start')return {turn:{id:runtime.turnId,status:'inProgress'}};
        if(method==='turn/steer')return {turnId:params.expectedTurnId};
        throw new Error('Unexpected synthetic native method');
      },
      async initialized({beforeWrite}){assert.equal(beforeWrite(),undefined);controls.calls.push({runtime,method:'initialized'});},
      async stop({beforeStop}){assert.equal(beforeStop(),undefined);controls.stops.push(runtime);return {exited:true,processTreeExitConfirmed:false};},
      complete(status='completed',turnId=runtime.turnId,threadId=runtime.threadId){return options.onNotification({method:'turn/completed',params:{threadId,turn:{id:turnId,status,output:sentinels.output}}});}
    };
    controls.runtimes.push(runtime); return runtime;
  };
  const options = {profile,root:f.root,lease:f.lease,policy:f.policy,registry,journal:f.journal,content,authorize,now:f.now,runtimeFactory:factory};
  const lifecycle = new CodexLifecycle(options);
  const runtimeId=randomUUID(),sessionId=randomUUID(),operationTemplate=f.operation();
  const op = (action,target={},extra={}) => {
    // Retain the acquired fence so tests can construct a stale operation after
    // releasing its lease; only the lifecycle may decide whether it is current.
    const base={...operationTemplate,operationId:randomUUID(),requestKey:randomUUID()};
    return {...base,action,target:{...base.target,runtimeId,sessionId:action.startsWith('runtime.')?null:sessionId,turnId:null,...target},context:{...base.context,grantRevision:2},...extra};
  };
  const consent = (operation,{scopeId=operation.operationId,kind='turn-consent',ttlMs=10000,bytes=Buffer.from(sentinels.prompt)}={}) => {
    const id=randomUUID();try{content.reserve({id,scopeId,kind,ttlMs,bytes});}finally{bytes.fill(0);}return id;
  };
  const launch = async (id=runtimeId) => {const operation=op('runtime.launch',{runtimeId:id});const result=await lifecycle.launchRuntime(operation);return {operation,result,runtime:controls.runtimes.at(-1)};};
  const ready = async () => {const launched=await launch();const operation=op('session.create');await lifecycle.createSession(operation);return {...launched,createOperation:operation};};
  const start = async () => {const operation=op('turn.start');const result=await lifecycle.startTurn(operation,consent(operation));return {operation,result};};
  const count = method => controls.calls.filter(c=>c.method===method).length;
  const withRegistryPressure = async callback => {
    const original=fs.statfsSync;
    fs.statfsSync=(directory,options)=>{
      const current=original(directory,options);
      // Preserve filesystem identity and every unrelated statfs field.
      return path.resolve(directory)===path.resolve(f.directory)?{...current,bavail:options?.bigint?0n:0}:current;
    };
    try{return await callback();}finally{fs.statfsSync=original;}
  };
  const revoke = () => f.authority.putGrant(f.ownerSession.credential,{requestId:randomUUID(),value:{...grant,grantRevision:3,enabled:false},expectedRevision:2});
  return {...f,registry,content,profile,controls,lifecycle,options,runtimeId,sessionId,op,consent,launch,ready,start,count,revoke,withRegistryPressure};
}
