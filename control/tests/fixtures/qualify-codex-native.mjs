// TEST_ONLY explicit owned native qualification; never in automatic test globs.
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {spawnSync} from 'node:child_process';
import {fixture} from './authority-fixture.mjs';
import {createNativeQualificationBudget} from './native-qualification-budget.mjs';
import {runQualifiedDispatch,acquireQualificationLease} from './qualification-dispatch.mjs';
import {NativeProfileBoundary,CodexProfile} from '../../providers/codex/compatibility.mjs';
import {OwnedCodexRuntime} from '../../providers/codex/process.mjs';
import {WindowsJobHost} from '../../providers/codex/windows-job.mjs';
import {CodexSessionRegistry} from '../../providers/codex/session-registry.mjs';
import {CodexLifecycle} from '../../providers/codex/lifecycle.mjs';
import {createTransientContentStore} from '../../lib/transient-content.mjs';
async function runWindow(directory){
 const window=JSON.parse(fs.readFileSync(path.join(directory,'admission.json'),'utf8'));
 if(!Number.isSafeInteger(window.startedAtMs)||!Number.isSafeInteger(window.deadlineAtMs)||window.deadlineAtMs<=window.startedAtMs||window.deadlineAtMs-window.startedAtMs>2700000||typeof window.leasePath!=='string'||!((window.policyOnly===true&&window.maxNativeTurns===0)||(window.policyOnly===false&&window.maxNativeTurns===2&&window.maxSessions===1&&window.maxSteers===1&&window.maxInterrupts===1&&window.maxResumes===1&&window.requireProcessTreeExit===true&&window.reasoning==='xhigh')))throw Error('INVALID_WINDOW');
 const admission=path.join(directory,'usage.json'),stopFile=path.join(directory,'stop.json');
 const outerBudget=createNativeQualificationBudget({startedAtMs:window.startedAtMs,durationMs:window.deadlineAtMs-window.startedAtMs,initialBaseline:window.baselineRemaining,initialResetAt:window.resetAt,quotaPoints:window.quotaPoints??1});
 await runQualifiedDispatch({budget:outerBudget,readUsage:()=>JSON.parse(fs.readFileSync(admission,'utf8')),isStopped:()=>fs.existsSync(stopFile),acquireLease:()=>acquireQualificationLease(window.leasePath),dispatch:async check=>{
 const continuation=false,prior=null,priorReceiptSha256=null,worktree=process.cwd(),evidenceRoot=path.join(directory,'native-'+randomUUID()),evidenceDir=evidenceRoot;
 let attemptNo=0;
 const operationCaps={'thread/start':['sessions',window.maxSessions??4],'turn/start':['turns',window.maxNativeTurns],'turn/steer':['steers',window.maxSteers??0],'turn/interrupt':['interrupts',window.maxInterrupts??0],'thread/resume':['resumes',window.maxResumes??0]};
 const consumeOperation=method=>{const [kind,cap]=operationCaps[method],file=path.join(directory,'operation-admissions.json'),state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{counts:{},events:[]};if(!Number.isSafeInteger(cap)||cap<0||(state.counts[kind]??0)>=cap)throw Error('OPERATION_LIMIT');state.counts[kind]=(state.counts[kind]??0)+1;state.events.push({method,kind,sequence:state.counts[kind],atMs:Date.now()});fs.writeFileSync(file+'.tmp',JSON.stringify(state));fs.renameSync(file+'.tmp',file);};
 const guardedFactory=options=>{
  let launchPhase='SPAWN_PLAN';
  const before=options.beforeSpawn;
  let runtime;
  try{
  runtime=OwnedCodexRuntime.launch({...options,processTreeHost:jobHost??undefined,beforeSpawn:()=>{launchPhase='AUTHORITY_BEFORE_SPAWN';before();launchPhase='WINDOW_BEFORE_SPAWN';check();const file=path.join(directory,'runtime-admissions.json');const state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{launches:[]};const limit=window.maxNativeRuntimes??2;if(!Number.isSafeInteger(limit)||limit<1||limit>4||!Array.isArray(state.launches)||state.launches.length>=limit)throw Error('RUNTIME_LIMIT');attemptNo=state.launches.length+1;state.launches.push({attempt:attemptNo,atMs:Date.now()});const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(state));fs.renameSync(temp,file);launchPhase='NATIVE_SPAWN_CALL';}});
  }catch(e){let profileCurrent=true;try{options.profile.assertCurrent();}catch{profileCurrent=false;}fs.writeFileSync(path.join(directory,'pre-spawn-'+randomUUID()+'.json'),JSON.stringify({phase:launchPhase,profileCurrent,code:e.code??'CONTROL_ERROR'}));throw e;}
  return {get metadata(){return runtime.metadata;},get exited(){return runtime.exited;},get closed(){return runtime.closed;},assertCurrent:()=>runtime.assertCurrent(),initialized:o=>runtime.initialized(o),stop:async o=>{const result=await runtime.stop(o);fs.writeFileSync(path.join(directory,'job-exit-'+attemptNo+'.json'),JSON.stringify(result,null,2));return result;},waitForExit:()=>runtime.waitForExit(),request:async(method,params,opts)=>{
   const guarded=operationCaps[method]?{...opts,beforeWrite:()=>{opts.beforeWrite();check();consumeOperation(method);}}:opts;
   const result=await runtime.request(method,params,guarded);
   if(method==='thread/start'||method==='thread/resume'){
    const norm=value=>path.resolve(value).replace(/^\\\\\?\\/,'').toLowerCase();const classify=value=>typeof value!=='string'?'INVALID':norm(value)===norm(path.join(options.profile.codexHome,'AGENTS.md'))?'SELECTED_HOME_AGENTS':norm(value)===norm(path.join(options.profile.codexHome,'AGENTS.override.md'))?'SELECTED_HOME_OVERRIDE':norm(value)===norm(path.join(options.root.directory,'AGENTS.md'))?'PROJECT_AGENTS':path.isAbsolute(value)?'OTHER_ABSOLUTE':'NON_PATH';
    const metadata={method,requestedTierDefault:params.serviceTier==='default',responseTierNull:result.serviceTier===null,responseTierDefault:result.serviceTier==='default',configRead:'NOT_REQUESTED_BOUNDED_DIAGNOSTIC',instructionSourceClasses:Array.isArray(result.instructionSources)?result.instructionSources.map(classify):null};
    fs.writeFileSync(path.join(directory,'policy-metadata-'+attemptNo+'.json'),JSON.stringify(metadata,null,2));
    process.stdout.write(JSON.stringify({stage:'POLICY_METADATA',...metadata})+'\n');
   }return result;
  }};
 };
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));const startedAt=window.startedAtMs,deadline=window.deadlineAtMs;
if(Date.now()>=deadline)throw Error('FIXED_DEADLINE_EXPIRED');
let baseline=null,reset=null,launches=prior?.launches??0,turns=prior?.turns??0,step='SETUP',cleanupFailed=false;
const results=[];const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
const budgetGate=outerBudget;
function budget(cleanup=false){if(cleanup)return;check();let sample;try{sample=JSON.parse(fs.readFileSync(admission,'utf8'));}catch{budgetGate.unavailable();}const current=budgetGate.observe(sample);baseline=current.baselineRemaining;reset=current.resetAt;return current;}
async function permit(next){step=next;emit({stage:'WAIT_QUOTA',next,launches,turns});for(;;){const current=budget();if(current.stage===next)return;await pause(200);}}
const cleanups=[];const t={after:fn=>cleanups.push(fn)};let f,registry,content,profile,lifecycle,jobHost=null,currentRuntime=null,sessionId=randomUUID();
const runtimeIds=[...(prior?.runtimeIds??[])];
function op(action,{runtimeId=currentRuntime,turnId=null}={}){const base=f.operation(),at=Date.now(),until=action==='runtime.stop'?at+30000:Math.min(deadline,at+90000);return {...base,action,target:{...base.target,runtimeId,sessionId:action.startsWith('runtime.')?null:sessionId,turnId},context:{...base.context,grantRevision:2},createdAtMs:at,deadlineAtMs:until,timeoutMs:until-at};}
function consent(operation,text){const bytes=Buffer.from(text),id=randomUUID();try{content.reserve({id,scopeId:operation.operationId,kind:'turn-consent',ttlMs:30000,bytes});}finally{bytes.fill(0);}return id;}
async function final(operation,expected,timeout=20000){const until=Math.min(deadline,Date.now()+timeout);while(Date.now()<until){budget();const state=lifecycle.operation(operation.operationId).state;if(state===expected)return state;if(['COMPLETED','FAILED','INTERRUPTED','UNKNOWN'].includes(state))throw Error('UNEXPECTED_NATIVE_FINAL');await pause(100);}throw Error('NATIVE_FINAL_TIMEOUT');}
async function stopCurrent(){if(!currentRuntime||!lifecycle)return;if(lifecycle.status().runtimeCount===0){currentRuntime=null;return;}const stopped=await lifecycle.stopOwnedRuntime(op('runtime.stop'));results.push({stage:'OWNED_RUNTIME_EXIT',runtimeId:currentRuntime,processExitConfirmed:stopped.processExitConfirmed,processTreeExitConfirmed:stopped.processTreeExitConfirmed});if(window.requireProcessTreeExit&&!stopped.processTreeExitConfirmed)throw Error('TREE_EXIT_UNVERIFIED');currentRuntime=null;}
try{
  f=await fixture(t,{clock:Date.now});
  const grant={...f.grant,expiresAtMs:Date.now()+900000,grantRevision:2,actions:['runtime.launch','runtime.stop','session.create','session.resume','turn.start','turn.steer','turn.interrupt','control.inspect']};f.authority.putGrant(f.ownerSession.credential,{requestId:randomUUID(),value:grant,expectedRevision:1});
  registry=CodexSessionRegistry.open({directory:f.directory,owner:f.ownerBoundary,guard:()=>{f.root.assertCurrent();f.lease.assertCurrent();}});content=createTransientContentStore();
  const home=path.join(process.env.USERPROFILE,'.codex');profile=CodexProfile.open({profileId:f.profileId,accountRef:randomUUID(),executable:path.join(process.env.LOCALAPPDATA,'OpenAI/Codex/bin/2993767bd1dfb009/codex.exe'),codexHome:home,owner:NativeProfileBoundary.open({directory:home,account:f.account}),schemaFile:path.resolve('.local/p3-compatibility/normal/codex_app_server_protocol.v2.schemas.json'),homeConfiguration:JSON.parse(fs.readFileSync(fs.existsSync(path.join(directory,'selected-profile-policy.json'))?path.join(directory,'selected-profile-policy.json'):'.local/p3-compatibility/selected-profile-policy.json')),selectExistingAccount:true,globalAgentsConsent:window.globalAgentsConsent,reasoningEffort:window.reasoning??'high'});
  if(window.requireProcessTreeExit){jobHost=WindowsJobHost.create({directory:f.directory,owner:f.ownerBoundary});f.addCleanup(()=>jobHost.close());}
  lifecycle=new CodexLifecycle({profile,root:f.root,lease:f.lease,policy:f.policy,registry,journal:f.journal,content,runtimeFactory:guardedFactory,authorize:async(operation,stage)=>{budget(operation.action==='runtime.stop');const assertion=f.authority.issue(f.aliceSession.credential,{operation,stage,connection:f.connection});f.policy.verifyAssertion({operation,stage,assertion});return {assertion,permit:f.authority.consume(assertion)};}});
  emit({stage:'PREPARED',workspace:f.root.directory,profileLabel:'Existing Windows signed-in Codex profile',maxRuntimes:window.maxNativeRuntimes??2,maxTurns:window.maxNativeTurns,deadlineAtMs:deadline});
  await permit('LAUNCH_CREATE');currentRuntime=randomUUID();runtimeIds.push(currentRuntime);launches++;await lifecycle.launchRuntime(op('runtime.launch'));await lifecycle.createSession(op('session.create'));results.push({stage:'NATIVE_CREATE',sessionId});
  if(!window.policyOnly){
  await permit('TURN_STEER_INTERRUPT');const first=op('turn.start');turns++;const accepted=await lifecycle.startTurn(first,consent(first,'TEST_ONLY disposable qualification. Do not use tools, read files, access network, or modify anything. Reason about enumerating solutions to the ten queens puzzle; present up to three hundred solutions.'));const steer=op('turn.steer',{turnId:accepted.turnId});await lifecycle.steerTurn(steer,consent(steer,'Continue reasoning about the same synthetic puzzle without tools or reading any files.'));const interrupt=op('turn.interrupt',{turnId:accepted.turnId});await lifecycle.interruptTurn(interrupt);await final(first,'INTERRUPTED');results.push({stage:'NATIVE_STEER_INTERRUPT',nativeFinal:'INTERRUPTED'});
  await permit('STOP_RELAUNCH_RESUME');await stopCurrent();currentRuntime=randomUUID();runtimeIds.push(currentRuntime);launches++;await lifecycle.launchRuntime(op('runtime.launch'));await lifecycle.resumeOwnedSession(op('session.resume'));results.push({stage:'NATIVE_OWNED_RESUME',sessionId});
  await permit('FOLLOWUP');const followup=op('turn.start');turns++;await lifecycle.startTurn(followup,consent(followup,'TEST_ONLY resumed qualification. Reply with exactly P3_RESUME_OK. Do not use tools, read files, access network or change anything.'));await final(followup,'COMPLETED',60000);results.push({stage:'NATIVE_RESUMED_FOLLOWUP',nativeFinal:'COMPLETED'});
  }
  await stopCurrent();emit({stage:window.policyOnly?'NATIVE_POLICY_PASS':'NATIVE_QUALIFICATION_PASS',launches,turns});
}catch(error){results.push({stage:'STOPPED',at:step,code:typeof error.code==='string'?error.code:typeof error.message==='string'&&/^[A-Z_]+$/.test(error.message)?error.message:'CONTROL_ERROR'});emit({stage:'NATIVE_QUALIFICATION_INCOMPLETE',last:results.at(-1)});process.exitCode=1;}
finally{
  try{await stopCurrent();}catch{cleanupFailed=true;results.push({stage:'CLEANUP_UNVERIFIED'});process.exitCode=1;}
  fs.mkdirSync(evidenceDir,{recursive:true});
  let evidenceOwnerOk=true;
  if(f){const acl=spawnSync('icacls.exe',[evidenceDir,'/inheritance:r','/grant:r','*'+f.account+':(OI)(CI)F','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F'],{windowsHide:true,stdio:'ignore',timeout:5000});if(acl.status!==0){evidenceOwnerOk=false;cleanupFailed=true;process.exitCode=1;emit({stage:'EVIDENCE_OWNER_BOUNDARY_FAILED'});}}
  if(!cleanupFailed){registry?.close();f?.journal.close();f?.store.close();if(f){for(const name of ['codex-lineage.sqlite','journal/control.sqlite','control-authority.sqlite']){const from=path.join(f.directory,name);if(fs.existsSync(from))fs.copyFileSync(from,path.join(evidenceDir,path.basename(name)));else{cleanupFailed=true;process.exitCode=1;results.push({stage:'METADATA_BACKUP_INCOMPLETE'});}}}}
  const receipt={version:1,qualification:(window.policyOnly?results.some(r=>r.stage==='NATIVE_CREATE'):results.some(r=>r.stage==='NATIVE_RESUMED_FOLLOWUP'))&&!cleanupFailed?(window.policyOnly?'POLICY_PASS':'PASS'):'INCOMPLETE',results,launches,turns,sessionId,runtimeIds,workspace:f?.root.directory??null,profileLabel:'Existing Windows signed-in Codex profile',model:'gpt-6.1-sol',effort:window.reasoning??'high',requestedTier:'default',servedBillingTier:'UNOBSERVABLE',sandbox:'read-only',credentialsCopied:false,loginOrConfigChanged:false,privateRepositoryInput:false,rawOutputCaptured:false,preservation:'Native provider history untouched; closed metadata databases retained',cleanupVerified:!cleanupFailed,startedAtMs:startedAt,endedAtMs:Date.now(),baselineRemaining:baseline,resetAt:reset,continuation,priorReceiptSha256,originalStartedAtMs:prior?.startedAtMs??startedAt,authorizedDeadlineAtMs:deadline,budget:budgetGate.status(),worktree};if(evidenceOwnerOk)fs.writeFileSync(path.join(evidenceDir,'native-receipt.json'),JSON.stringify(receipt,null,2));
  content?.close();profile?.close();if(!cleanupFailed){try{lifecycle?.close();}catch{}for(const cleanup of cleanups.reverse())await cleanup();}
  emit({stage:'NATIVE_RECEIPT_SAVED',qualification:receipt.qualification,cleanupVerified:receipt.cleanupVerified});
}

 }});
}
try{
 if(process.argv.length!==5||process.argv[2]!=='--run-owned-native-fixture'||process.argv[3]!=='--window')throw Error('EXPLICIT_WINDOW_REQUIRED');
 await runWindow(path.resolve(process.argv[4]));
}catch(error){const code=typeof error.code==='string'&&/^[A-Z_]{1,64}$/.test(error.code)?error.code:typeof error.message==='string'&&/^[A-Z_]{1,64}$/.test(error.message)?error.message:'CONTROL_ERROR';process.stdout.write(JSON.stringify({stage:'QUALIFICATION_DISPATCH_REFUSED',code})+'\n');process.exitCode=1;}