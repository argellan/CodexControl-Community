import {randomUUID} from 'node:crypto';
import {ControlError,isControlError} from '../../lib/errors.mjs';
import {strictRecord,uuid,opaqueToken,integer,deepFreeze} from '../../lib/privacy.mjs';
import {validateOperation} from '../../contracts/operations.mjs';
import {HostPolicy} from '../../host/policy.mjs';
import {OwnedCodexRuntime} from './process.mjs';
import {assertNativePolicy,bindNativeSessionPolicy} from './compatibility.mjs';
const fail=code=>{throw new ControlError(code??'CONTROL_DISABLED');};
const launch=options=>OwnedCodexRuntime.launch(options);
const finalStates=new Set(['COMPLETED','FAILED','INTERRUPTED','CANCELLED','EXPIRED','NOT_DISPATCHED']);
export class CodexLifecycle {
  #profile;#root;#lease;#policy;#registry;#journal;#content;#authorize;#now;#factory;
  #selection;#launching=0;#starting=0;#runtimes=new Map();#active=new Set();#turns=new Map();#interrupts=new Map();#early=new Map();#closed=false;
  constructor(options){
    strictRecord(options,['profile','root','lease','policy','registry','journal','content','authorize','now','runtimeFactory'],['profile','root','lease','policy','registry','journal','content','authorize']);
    const {profile,root,lease,policy,registry,journal,content,authorize,now=Date.now,runtimeFactory=launch}=options;
    if(!(policy instanceof HostPolicy)||typeof authorize!=='function'||typeof runtimeFactory!=='function')fail('INVALID_INPUT');
    this.#profile=profile;this.#selection=profile.metadata;this.#root=root;this.#lease=lease;this.#policy=policy;this.#registry=registry;this.#journal=journal;this.#content=content;this.#authorize=authorize;this.#now=now;this.#factory=runtimeFactory;
  }
  #operation(input,action){
    if(this.#closed)fail('CLOSED');const op=validateOperation(input);if(op.action!==action||op.target.providerProfileId!==this.#selection.profileId||op.target.terminalId!==null||op.target.requestId!==null)fail('INVALID_INPUT');
    if(['runtime.launch','runtime.stop'].includes(action)&&(op.target.sessionId!==null||op.target.turnId!==null))fail('INVALID_INPUT');
    if(['session.create','session.resume','turn.start'].includes(action)&&op.target.turnId!==null)fail('INVALID_INPUT');
    if(this.#active.has(op.operationId)||this.#active.size>=8)fail('CAPACITY');this.#context(op);return op;
  }
  #context(op){
    const root=this.#root.assertCurrent(),lease=this.#lease.assertCurrent();if(op.action!=='runtime.stop')this.#profile.assertCurrent();
    if(lease.fence!==op.context.ownershipFence||lease.connectionEpoch!==op.context.connectionEpoch||lease.resourceId!==op.target.projectId||op.deadlineAtMs<=integer(this.#now()))fail('STALE_CONTEXT');return root;
  }
  #entry(op,{allowBlocked=false}={}){
    const entry=this.#runtimes.get(op.target.runtimeId);if(!entry||entry.exited||entry.blocked&&!allowBlocked)fail('STALE_CONTEXT');
    this.#context(op);entry.runtime.assertCurrent();return entry;
  }
  #event(op,type,native=null){
    const current=this.#journal.get(op.operationId);if(!current)fail('NOT_FOUND');
    return this.#journal.transition({operationId:op.operationId,eventId:randomUUID(),expectedRevision:current.revision,type,atMs:integer(this.#now()),context:op.context,native,reasonCode:type==='UNKNOWN'?'TRANSPORT_LOST':'NATIVE_RESULT'}).operation;
  }
  async #authorization(op,stage){
    const packet=await this.#authorize(op,stage);strictRecord(packet,['assertion','permit']);this.#context(op);return {operation:op,stage,...packet};
  }
  async #admit(op){
    this.#active.add(op.operationId);
    try{const gate=await this.#authorization(op,'ADMISSION');this.#policy.acceptPermit(gate);if(this.#journal.admit(op).duplicate)fail('REPLAY_UNAVAILABLE');}
    catch(error){this.#active.delete(op.operationId);throw error;}
  }
  async #dispatch(op,reserve){
    reserve();this.#event(op,'DISPATCH_INTENT');
    return this.#authorization(op,'DISPATCH');
  }
  #beforeWrite(op,gate,entry){
    this.#context(op);if(entry){this.#entry(op);if(entry.busy!==op.operationId)fail('STALE_CONTEXT');}
    this.#policy.dispatchLifecycle(gate); // final synchronous gate, then transport writes without awaiting
  }
  async #publish(op,value){
    const gate=await this.#authorization(op,'PUBLICATION');this.#policy.acceptPermit(gate);return deepFreeze(value);
  }
  #lost(op,entry,wrote){
    let current;try{current=this.#journal.get(op.operationId);}catch{if(entry&&wrote){entry.blocked=true;try{this.#registry.unknownRuntime(op.target.runtimeId);}catch{}}return;}
    if(entry&&wrote&&!finalStates.has(current?.state)){entry.blocked=true;try{this.#registry.unknownRuntime(op.target.runtimeId);}catch{}}
    if(current&&!finalStates.has(current.state)&&current.state!=='UNKNOWN')try{this.#event(op,'UNKNOWN');}catch{}
  }
  #guardedError(error){return isControlError(error)?error:new ControlError();}
  #notify(runtimeId,message){
    if(!message||typeof message.method!=='string')fail('SCHEMA_MISMATCH');
    const entry=this.#runtimes.get(runtimeId);if(!entry)return;
    if(message.method==='account/updated'&&entry.ready){entry.blocked=true;return;}
    if(message.method!=='turn/completed')return; // discard content/tools/reasoning without copying
    const p=message.params,id=opaqueToken(p?.turn?.id),threadId=opaqueToken(p?.threadId),status=p.turn.status;
    if(!['completed','failed','interrupted'].includes(status))fail('SCHEMA_MISMATCH');
    const tracked=this.#turns.get(id);
    if(!tracked){if(!entry.pendingThread||entry.pendingThread!==threadId)fail('STALE_CONTEXT');if(this.#early.size>=8)fail('CAPACITY');this.#early.set(id,{runtimeId,threadId,status});return;}
    if(tracked.runtimeId!==runtimeId||tracked.threadId!==threadId)fail('STALE_CONTEXT');this.#completeTurn(id,status);
  }
  #completeTurn(id,status){
    const tracked=this.#turns.get(id);if(!tracked)return;
    this.#registry.finalTurn(tracked.sessionId,id,status);
    const native={threadId:tracked.threadId,turnId:id};
    this.#event(tracked.operation,{completed:'COMPLETED',failed:'FAILED',interrupted:'INTERRUPTED'}[status],native);
    for(const op of this.#interrupts.get(id)??[])this.#event(op,status==='interrupted'?'INTERRUPTED':'COMPLETED',native);
    this.#interrupts.delete(id);this.#turns.delete(id);
  }
  #closedRuntime(id){
    const entry=this.#runtimes.get(id);if(!entry)return;entry.blocked=true;if(entry.stopping)return;
    try{this.#registry.unknownRuntime(id);}catch{}
    for(const tracked of this.#turns.values())if(tracked.runtimeId===id)this.#lost(tracked.operation,entry,true);
  }
  async launchRuntime(input){
    const op=this.#operation(input,'runtime.launch');if(this.#runtimes.size+this.#launching>=2)fail('CAPACITY');this.#launching++;
    let runtime,entry,wrote=false;
    try{
      await this.#admit(op);
      const root=this.#context(op),gate=await this.#dispatch(op,()=>this.#registry.reserveRuntime(op,this.#profile.metadata,root.sha256));
      runtime=this.#factory({profile:this.#profile,root:this.#root,beforeSpawn:()=>{this.#beforeWrite(op,gate);wrote=true;},
        onNotification:m=>this.#notify(op.target.runtimeId,m),onServerRequest:()=>{const e=this.#runtimes.get(op.target.runtimeId);if(e)e.blocked=true;},onClose:()=>this.#closedRuntime(op.target.runtimeId)});
      entry={runtime,blocked:false,exited:false,ready:false,busy:op.operationId,pendingThread:null};
      this.#runtimes.set(op.target.runtimeId,entry);
      this.#registry.spawnedRuntime(op.target.runtimeId,{processBinding:runtime.metadata.processBinding,pid:runtime.metadata.pid});
      const internal=()=>{this.#context(op);runtime.assertCurrent();if(entry.blocked)fail('STALE_CONTEXT');};
      await runtime.request('initialize',{clientInfo:{name:'codexcontrol_preview',title:'CodexControl preview',version:'0.1.0'},capabilities:{experimentalApi:false}},{beforeWrite:internal});
      await runtime.initialized({beforeWrite:internal});
      const account=this.#profile.checkAccount(await runtime.request('account/read',{refreshToken:false},{beforeWrite:internal}));
      const models=await runtime.request('model/list',{limit:50,includeHidden:false},{beforeWrite:internal});
      const selected=models.data?.find(m=>m.model==='gpt-6.1-sol');
      if(account.state!=='AUTHENTICATED'||!selected||!selected.supportedReasoningEfforts?.some(e=>e.reasoningEffort===this.#selection.effort))fail('CONTROL_DISABLED');
      this.#registry.readyRuntime(op.target.runtimeId,{processBinding:runtime.metadata.processBinding,pid:runtime.metadata.pid});entry.ready=true;
      this.#event(op,'COMPLETED');return await this.#publish(op,{runtimeId:op.target.runtimeId,state:'READY',auth:account.state,productStatus:'EXPERIMENTAL_PREVIEW',requestedModel:'gpt-6.1-sol',requestedEffort:this.#selection.effort,requestedTier:'default',observedTier:null});
    }catch(error){this.#lost(op,entry,wrote);throw this.#guardedError(error);}
    finally{this.#launching--;if(entry)entry.busy=null;this.#active.delete(op.operationId);}
  }
  async #session(input,resume){
    const op=this.#operation(input,resume?'session.resume':'session.create'),entry=this.#entry(op);if(entry.busy)fail('CONFLICT');entry.busy=op.operationId;let wrote=false;
    try{
      await this.#admit(op);
      if(this.#profile.checkAccount(await entry.runtime.request('account/read',{refreshToken:false},{beforeWrite:()=>{this.#entry(op);}})).state!=='AUTHENTICATED')fail('CONTROL_DISABLED');
      const gate=await this.#dispatch(op,()=>resume?this.#registry.reserveResume(op):this.#registry.reserveSession(op));
      const session=resume?this.#registry.session(op.target.sessionId):null;
      const params={cwd:this.#root.directory,model:'gpt-6.1-sol',modelProvider:'openai',approvalPolicy:'never',approvalsReviewer:'user',sandbox:'read-only',serviceTier:'default',config:{model_reasoning_effort:this.#selection.effort,project_doc_max_bytes:0},baseInstructions:'Perform only the bounded user task. Do not inspect files, invoke tools, spawn agents or access networks.',developerInstructions:'Use only the supplied synthetic input. Do not load project or skill content.'};
      if(resume){params.threadId=session.nativeThreadId;params.excludeTurns=true;}else params.ephemeral=false;
      const policyProof=bindNativeSessionPolicy(this.#profile,this.#root,params);
      const result=await entry.runtime.request(resume?'thread/resume':'thread/start',params,{beforeWrite:()=>{this.#beforeWrite(op,gate,entry);wrote=true;}});
      assertNativePolicy(result,this.#profile,this.#root,policyProof);const nativeId=opaqueToken(result.thread?.id);
      if(resume)this.#registry.resumedSession(op.target.sessionId,op.operationId,nativeId);else this.#registry.createdSession(op.target.sessionId,op.operationId,nativeId);
      this.#event(op,'COMPLETED',{threadId:nativeId});return await this.#publish(op,{sessionId:op.target.sessionId,runtimeId:op.target.runtimeId,state:'READY',observedModel:result.model,observedEffort:result.reasoningEffort,observedTier:result.serviceTier});
    }catch(error){if(this.#journal.get(op.operationId))this.#lost(op,entry,wrote);throw this.#guardedError(error);}
    finally{entry.busy=null;this.#active.delete(op.operationId);}
  }
  createSession(input){return this.#session(input,false);}
  resumeOwnedSession(input){return this.#session(input,true);}
  async #turn(input,contentId,steer){
    const op=this.#operation(input,steer?'turn.steer':'turn.start'),entry=this.#entry(op),session=this.#registry.assertSession(op,{active:steer});
    if(entry.busy)fail('CONFLICT');if(!steer&&this.#turns.size+this.#starting>=1)fail('CAPACITY');if(!steer)this.#starting++;entry.busy=op.operationId;let wrote=false,bytes;
    try{
      await this.#admit(op);
      if(this.#profile.checkAccount(await entry.runtime.request('account/read',{refreshToken:false},{beforeWrite:()=>{this.#entry(op);}})).state!=='AUTHENTICATED')fail('CONTROL_DISABLED');
      const gate=await this.#dispatch(op,()=>{if(!steer)this.#registry.reserveTurn(op);else this.#registry.assertSession(op,{active:true});});
      bytes=this.#content.consumeBound({id:uuid(contentId),scopeId:op.operationId,kind:'turn-consent'});
      if(bytes.length>16384)fail('CAPACITY');const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);bytes.fill(0);bytes=null;
      const params={threadId:session.nativeThreadId,input:[{type:'text',text}]};
      if(steer)params.expectedTurnId=op.target.turnId;
      else Object.assign(params,{cwd:this.#root.directory,model:'gpt-6.1-sol',effort:this.#selection.effort,serviceTier:'default',approvalPolicy:'never',approvalsReviewer:'user',sandboxPolicy:{type:'readOnly',networkAccess:false}});
      entry.pendingThread=session.nativeThreadId;
      const result=await entry.runtime.request(steer?'turn/steer':'turn/start',params,{beforeWrite:()=>{this.#registry.assertSession(op,{active:steer});this.#beforeWrite(op,gate,entry);wrote=true;}});
      const id=opaqueToken(steer?result.turnId:result.turn?.id);
      if(steer){if(id!==op.target.turnId)fail('STALE_CONTEXT');this.#event(op,'COMPLETED',{threadId:session.nativeThreadId,turnId:id});}
      else{
        this.#registry.startedTurn(op,id);this.#event(op,'RUNNING',{threadId:session.nativeThreadId,turnId:id});
        this.#turns.set(id,{operation:op,runtimeId:op.target.runtimeId,sessionId:op.target.sessionId,threadId:session.nativeThreadId});
        const early=this.#early.get(id);this.#early.clear();
        if(early)this.#completeTurn(id,early.status);else if(['completed','failed','interrupted'].includes(result.turn.status))this.#completeTurn(id,result.turn.status);
      }
      return await this.#publish(op,{operationId:op.operationId,sessionId:op.target.sessionId,turnId:id,state:this.#journal.get(op.operationId).state});
    }catch(error){if(this.#journal.get(op.operationId))this.#lost(op,entry,wrote);throw this.#guardedError(error);}
    finally{if(!steer)this.#starting--;if(bytes)bytes.fill(0);entry.pendingThread=null;entry.busy=null;this.#active.delete(op.operationId);}
  }
  startTurn(input,contentId){return this.#turn(input,contentId,false);}
  steerTurn(input,contentId){return this.#turn(input,contentId,true);}
  async interruptTurn(input){
    const op=this.#operation(input,'turn.interrupt'),entry=this.#entry(op),session=this.#registry.assertSession(op,{active:true});
    if(entry.busy||(this.#interrupts.get(op.target.turnId)?.length??0)>=4)fail('CAPACITY');entry.busy=op.operationId;let wrote=false;
    try{
      await this.#admit(op);const gate=await this.#dispatch(op,()=>this.#registry.assertSession(op,{active:true}));
      // Register before the write: completion may precede its native acknowledgement.
      const list=this.#interrupts.get(op.target.turnId)??[];list.push(op);this.#interrupts.set(op.target.turnId,list);
      await entry.runtime.request('turn/interrupt',{threadId:session.nativeThreadId,turnId:op.target.turnId},{beforeWrite:()=>{this.#registry.assertSession(op,{active:true});this.#beforeWrite(op,gate,entry);wrote=true;}});
      const current=this.#journal.get(op.operationId);if(!finalStates.has(current.state))this.#event(op,'INTERRUPT_REQUESTED',{threadId:session.nativeThreadId,turnId:op.target.turnId});
      return await this.#publish(op,{operationId:op.operationId,state:this.#journal.get(op.operationId).state,nativeStopConfirmed:this.#journal.get(op.operationId).state==='INTERRUPTED'});
    }catch(error){if(!wrote){const list=(this.#interrupts.get(op.target.turnId)??[]).filter(item=>item.operationId!==op.operationId);if(list.length)this.#interrupts.set(op.target.turnId,list);else this.#interrupts.delete(op.target.turnId);}this.#lost(op,entry,wrote);throw this.#guardedError(error);}
    finally{entry.busy=null;this.#active.delete(op.operationId);}
  }
  async stopOwnedRuntime(input){
    const op=this.#operation(input,'runtime.stop'),entry=this.#runtimes.get(op.target.runtimeId);if(!entry||entry.busy)fail('CONFLICT');entry.busy=op.operationId;let wrote=false;
    try{
      await this.#admit(op);const record=this.#registry.runtime(op.target.runtimeId);
      if(!record||record.hostId!==op.target.hostId||record.projectId!==op.target.projectId||record.profileId!==op.target.providerProfileId)fail('STALE_CONTEXT');
      const gate=await this.#dispatch(op,()=>{});
      const result=await entry.runtime.stop({beforeStop:()=>{this.#context(op);this.#policy.dispatchLifecycle(gate);entry.stopping=true;wrote=true;},timeoutMs:5000});
      if(!result.exited)fail('STALE_CONTEXT');entry.exited=true;
      this.#registry.exitedRuntime(op.target.runtimeId,entry.runtime.metadata.processBinding);this.#event(op,'COMPLETED');
      for(const [id,tracked]of this.#turns)if(tracked.runtimeId===op.target.runtimeId){this.#lost(tracked.operation,null,false);this.#turns.delete(id);this.#interrupts.delete(id);}for(const [id,early]of this.#early)if(early.runtimeId===op.target.runtimeId)this.#early.delete(id);
      this.#runtimes.delete(op.target.runtimeId);return await this.#publish(op,{runtimeId:op.target.runtimeId,state:'EXITED',processExitConfirmed:true,processTreeExitConfirmed:result.processTreeExitConfirmed===true});
    }catch(error){this.#lost(op,entry,wrote);throw this.#guardedError(error);}
    finally{entry.busy=null;this.#active.delete(op.operationId);}
  }
  operation(id){const op=this.#journal.get(uuid(id));return op?deepFreeze({operationId:op.envelope.operationId,state:op.state,revision:op.revision}):null;}
  status(){return deepFreeze({runtimeCount:this.#runtimes.size,pendingOperations:this.#active.size,activeTurns:this.#turns.size,earlyMetadata:this.#early.size,nativeRequestsSupported:false,terminalSupported:false,productStatus:this.#factory===launch?'EXPERIMENTAL_PREVIEW':'TEST_ONLY',autoReplay:false});}
  close(){if(this.#runtimes.size||this.#active.size)fail('CONFLICT');this.#closed=true;this.#early.clear();this.#turns.clear();this.#interrupts.clear();}
}
