// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {NativeAccountAnalytics} from './native-account-analytics.mjs';
import {DesktopExecutableResolver} from './codex-executable.mjs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {stat} from 'node:fs/promises';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const label=value=>typeof value==='string'&&value.length>0&&value.length<=128&&value.isWellFormed()&&!/[\x00-\x1f\x7f]/.test(value)?value:null;
const summaryFields=['lifetimeTokens','peakDailyTokens','longestRunningTurnSec','currentStreakDays','longestStreakDays'];
const allowedMethods=new Set(['initialize','account/read','account/rateLimits/read','account/usage/read']);
const emptySummary=()=>Object.fromEntries(summaryFields.map(field=>[field,null]));
const reachedTypes=new Set(['rate_limit_reached','workspace_owner_credits_depleted','workspace_member_credits_depleted','workspace_owner_usage_limit_reached','workspace_member_usage_limit_reached']);
const limitStateKeys=['ordinaryUsageAllowed','rateLimitResetCredits'];
const copy=value=>structuredClone(value);
const observerError=code=>Object.assign(new Error('Codex account observation unavailable'),{observerCode:code});
const launchError=error=>Object.assign(observerError('spawn-failed'),{missingExecutableCandidate:error?.code==='ENOENT'});

// ENOENT can also mean a missing loader. Confirm only the configured path,
// without discovery or execution, and share the original observation deadline.
async function diagnoseLaunch(error,executable,statExecutable,remainingMs){
 if(!error.missingExecutableCandidate)return 'spawn-failed';
 let timer;
 try{return await Promise.race([
  Promise.resolve().then(()=>statExecutable(executable)).then(()=>'spawn-failed',error=>['ENOENT','ENOTDIR'].includes(error?.code)?'executable-missing':'spawn-failed'),
  new Promise(resolve=>{timer=setTimeout(()=>resolve('spawn-failed'),remainingMs);})
 ]);}finally{clearTimeout(timer);}
}

export function validateAccountObserverConfiguration(configuration){
 if(!object(configuration)||configuration.enabled!==true)throw new Error('Account observer requires explicit local enablement');
 if(configuration.nativeAnalytics!==undefined&&typeof configuration.nativeAnalytics!=='boolean')throw new Error('Invalid native analytics policy');
 const executable=configuration.executable;
 if(typeof executable!=='string'||!executable||executable.length>1024||/[\x00-\x1f\x7f]/.test(executable)||/^(?:\\\\|\/\/)/.test(executable)||!path.posix.isAbsolute(executable)&&!path.win32.isAbsolute(executable)||/\.(?:bat|cmd|ps1)$/i.test(executable))throw new Error('Account observer requires an absolute local executable');
 if(configuration.accountKey!==undefined&&configuration.accountKey!==null&&(typeof configuration.accountKey!=='string'||! /^[a-f0-9]{64}$/.test(configuration.accountKey)))throw new Error('Invalid opaque account observation key');
 for(const [field,min,max] of [['intervalMs',60000,300000],['timeoutMs',250,30000]])if(configuration[field]!==undefined&&(!Number.isSafeInteger(configuration[field])||configuration[field]<min||configuration[field]>max))throw new Error('Invalid account observer '+field);
 if(configuration.followDesktopUpdates!==undefined&&typeof configuration.followDesktopUpdates!=='boolean')throw new Error('Invalid desktop update policy');
 return {...(configuration.nativeAnalytics===true?{nativeAnalytics:true}:{}),...(configuration.followDesktopUpdates?{followDesktopUpdates:true}:{}),executable,accountKey:configuration.accountKey??null,intervalMs:configuration.intervalMs??60000,timeoutMs:configuration.timeoutMs??15000};
}

function windowOf(value){
 if(!object(value))return null;
 const usedPercent=typeof value.usedPercent==='number'&&Number.isFinite(value.usedPercent)&&value.usedPercent>=0&&value.usedPercent<=100?value.usedPercent:null;
 const windowDurationMins=count(value.windowDurationMins),resetsAt=count(value.resetsAt);
 return usedPercent===null&&windowDurationMins===null&&resetsAt===null?null:{usedPercent,windowDurationMins,resetsAt};
}
function limitExtras(value){
 const result={};
 if(Object.hasOwn(value,'credits')){
  const credits=value.credits;
  if(credits===null)result.credits=null;
  else if(object(credits)&&typeof credits.hasCredits==='boolean'&&typeof credits.unlimited==='boolean'){
   result.credits={hasCredits:credits.hasCredits,unlimited:credits.unlimited};
   if(credits.balance===null||typeof credits.balance==='string'&&credits.balance.length<=64&&/^\d+(?:\.\d+)?$/.test(credits.balance))result.credits.balance=credits.balance;
  }
 }
 if(value.spendControlReached===null||typeof value.spendControlReached==='boolean')result.spendControlReached=value.spendControlReached;
 if(value.individualLimit===null)result.individualLimit=null;
 if(value.normalModelSlug===null||typeof value.normalModelSlug==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value.normalModelSlug))result.normalModelSlug=value.normalModelSlug;
 if(value.rateLimitReachedType===null||reachedTypes.has(value.rateLimitReachedType))result.rateLimitReachedType=value.rateLimitReachedType;
 return result;
}
export function normalizeAccountLimitState(response){
 if(!object(response))throw observerError('invalid-response');const result={};
 if(response.ordinaryUsageAllowed===null||typeof response.ordinaryUsageAllowed==='boolean')result.ordinaryUsageAllowed=response.ordinaryUsageAllowed;
 const credits=response.rateLimitResetCredits;
 if(credits===null)result.rateLimitResetCredits=null;
 else if(object(credits)&&count(credits.availableCount)!==null){
  result.rateLimitResetCredits={availableCount:credits.availableCount};
  // The owned native probe qualified only null/empty detail rows. Retain the
  // count without copying unqualified identifiers, descriptions or raw JSON.
  if(credits.credits===null||Array.isArray(credits.credits)&&credits.credits.length===0)result.rateLimitResetCredits.credits=credits.credits===null?null:[];
 }
 return result;
}
export function normalizeAccountLimits(response){
 if(!object(response))throw observerError('invalid-response');
 let values=[];
 if(object(response.rateLimitsByLimitId))values=Object.entries(response.rateLimitsByLimitId).slice(0,256).map(([id,value])=>({id,value}));
 else if(object(response.rateLimits))values=[{id:'codex',value:response.rateLimits}];
 else if(response.rateLimits!==null&&response.rateLimitsByLimitId!==null)throw observerError('invalid-response');
 const seen=new Set(),limits=[];
 for(const {id,value}of values){if(!object(value))continue;const limitId=label(value.limitId)??label(id)??'codex';if(seen.has(limitId))continue;seen.add(limitId);limits.push({limitId,limitName:label(value.limitName),planType:label(value.planType),primary:windowOf(value.primary),secondary:windowOf(value.secondary),...limitExtras(value)});if(limits.length===8)break;}
 return limits;
}
export function normalizeAccountTokenUsage(response){
 if(!object(response)||!object(response.summary))throw observerError('invalid-response');
 const summary=Object.fromEntries(summaryFields.map(field=>[field,count(response.summary[field])]));
 let dailyUsageBuckets=null;
 if(Array.isArray(response.dailyUsageBuckets)){
  const days=new Map();
  for(const bucket of response.dailyUsageBuckets.slice(0,366)){
   if(!object(bucket)||typeof bucket.startDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(bucket.startDate)||count(bucket.tokens)===null)continue;
   const stamp=Date.parse(bucket.startDate+'T00:00:00Z');if(!Number.isFinite(stamp)||new Date(stamp).toISOString().slice(0,10)!==bucket.startDate)continue;
   days.set(bucket.startDate,{startDate:bucket.startDate,tokens:bucket.tokens});
  }
  dailyUsageBuckets=[...days.values()].sort((a,b)=>a.startDate.localeCompare(b.startDate));
 }else if(response.dailyUsageBuckets!==undefined&&response.dailyUsageBuckets!==null)throw observerError('invalid-response');
 return {summary,dailyUsageBuckets,...(response.threadUsage===null?{threadUsage:null}:{})};
}

// Only an owned, local stdio process is opened. Neither a network listener nor a
// thread is created. Raw provider output, auth state and error messages stay here.
function openReadOnlyClient(configuration,{spawnProcess=spawn,onChild=()=>{}}={}){
 let child,closed=false,nextId=0,buffer='',bytes=0,timer,killTimer;const pending=new Map();
 const fail=error=>{if(closed)return;closed=true;clearTimeout(timer);for(const waiter of pending.values())waiter.reject(error);pending.clear();if(child){child.stdin?.end();child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),250);killTimer.unref();}onChild(null);};
 try{child=spawnProcess(configuration.executable,['app-server'],{stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});onChild(child);}catch(error){throw launchError(error);}
 child.on('error',error=>fail(launchError(error)));
 child.on('exit',()=>{clearTimeout(killTimer);fail(observerError('process-exited'));clearTimeout(killTimer);});
 child.stdin.on('error',()=>fail(observerError('process-exited')));
 child.stdout.on('error',()=>fail(observerError('process-exited')));
 child.stderr.on('error',()=>fail(observerError('process-exited')));
 const budget=chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>524288){fail(observerError('output-limit'));return false;}return true;};
 child.stderr.on('data',chunk=>{budget(chunk);});
 child.stdout.setEncoding('utf8');
 child.stdout.on('data',chunk=>{
  if(closed||!budget(chunk))return;buffer+=chunk;if(buffer.length>262144){fail(observerError('output-limit'));return;}
  let end;while(!closed&&(end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(!line)continue;let message;try{message=JSON.parse(line);}catch{fail(observerError('invalid-response'));return;}
   if(!object(message)){fail(observerError('invalid-response'));return;}
   if(typeof message.method==='string'){if(Object.hasOwn(message,'id')){fail(observerError('unexpected-request'));return;}continue;}
   const waiter=pending.get(message.id);if(!waiter)continue;pending.delete(message.id);
   if(Object.hasOwn(message,'error')){const code=message.error?.code;waiter.reject(observerError(code===-32601?'unsupported-method':'rpc-unavailable'));}
   else if(Object.hasOwn(message,'result'))waiter.resolve(message.result);
   else waiter.reject(observerError('invalid-response'));
  }
 });
 timer=setTimeout(()=>fail(observerError('timeout')),configuration.timeoutMs);
 const write=message=>{if(closed)throw observerError('process-exited');try{child.stdin.write(JSON.stringify(message)+'\n');}catch{fail(observerError('process-exited'));throw observerError('process-exited');}};
 return {
  request(method,params){if(!allowedMethods.has(method))return Promise.reject(observerError('method-refused'));if(closed)return Promise.reject(observerError('process-exited'));return new Promise((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});try{write({id,method,...(params===undefined?{}:{params})});}catch(error){pending.delete(id);reject(error);}});},
  initialized(){write({method:'initialized',params:{}});},
  close(){fail(observerError('stopped'));}
 };
}

export class CodexAccountObserver {
 #localIdentity=null;
 #groupingRevoked=false;
 #launchFailure=null;
 constructor(configuration,{clock=Date.now,spawnProcess=spawn,statExecutable=stat,executableResolver=new DesktopExecutableResolver(),nativeAnalyticsFactory=()=>new NativeAccountAnalytics()}={}){
  this.configuration=validateAccountObserverConfiguration(configuration);this.nativeAnalytics=this.configuration.nativeAnalytics?nativeAnalyticsFactory():null;this.clock=clock;this.spawnProcess=spawnProcess;this.statExecutable=statExecutable;this.executableResolver=executableResolver;this.discovery=null;this.inFlight=null;this.nextPollAt=0;this.closed=false;this.client=null;
  this.value={version:1,source:'codex-app-server',status:'unavailable',observedAt:null,lastAttemptAt:null,accountKey:this.configuration.accountKey,planType:null,limitsObservedAt:null,usageObservedAt:null,limits:[],summary:emptySummary(),dailyUsageBuckets:null,errorCode:null};
 }
 acknowledgeAnalytics(digest){this.nativeAnalytics?.acknowledge(digest);if(this.value.nativeAnalytics?.digest===digest){const {data,...ref}=this.value.nativeAnalytics;this.value.nativeAnalytics=ref;}}
 #clearMetrics(){this.nativeAnalytics?.clear();delete this.value.nativeAnalytics;Object.assign(this.value,{observedAt:null,limitsObservedAt:null,usageObservedAt:null,limits:[],summary:emptySummary(),dailyUsageBuckets:null,planType:null});for(const key of [...limitStateKeys,'threadUsage'])delete this.value[key];}
 #bindAccount(account){
  // This comparison never leaves memory. The email is neither exported nor used
  // as a grouping key. Unknown identity cannot safely inherit cached sections.
  const type=label(account?.type),email=typeof account?.email==='string'&&account.email.length>0&&account.email.length<=320&&account.email.isWellFormed()&&!/[\x00-\x1f\x7f]/.test(account.email)?account.email:null;
  const identity=type&&email?type+'\0'+email:null;
  if(identity===null||this.#localIdentity!==null&&identity!==this.#localIdentity){this.#clearMetrics();this.#groupingRevoked=true;}
  this.#localIdentity=identity;this.value.accountKey=this.#groupingRevoked?null:this.configuration.accountKey;
 }
 snapshot(){return copy(this.value);}
 // Local-only diagnosis: the shared accountUsage wire schema stays unchanged.
 diagnostic(){return this.#launchFailure===null?null:{code:this.#launchFailure,action:'verify-configured-local-executable',nextAttemptAt:this.closed?null:new Date(this.nextPollAt).toISOString()};}
 sample(){if(!this.closed&&!this.inFlight&&this.clock()>=this.nextPollAt)void this.poll();return this.snapshot();}
 poll(){
  if(this.closed)return Promise.resolve(this.snapshot());if(this.inFlight)return this.inFlight;if(this.clock()<this.nextPollAt)return Promise.resolve(this.snapshot());
  const attemptedAt=this.clock();this.nextPollAt=attemptedAt+this.configuration.intervalMs;this.value.lastAttemptAt=new Date(attemptedAt).toISOString();
  this.inFlight=this.observe().finally(()=>{this.inFlight=null;});return this.inFlight;
 }
 async observe(){
  const startedAt=performance.now();this.#launchFailure=null;
  let succeeded=0,errors=[],nativeAccount=null;
  try{
   let executable=this.configuration.executable;
   if(this.configuration.followDesktopUpdates){this.discovery=new AbortController();try{executable=await this.executableResolver.resolve(executable,{timeoutMs:this.configuration.timeoutMs,signal:this.discovery.signal});}catch(error){throw launchError(error);}finally{this.discovery=null;}}
   if(this.closed)return this.snapshot();
   const timeoutMs=Math.max(1,this.configuration.timeoutMs-(performance.now()-startedAt));
   this.client=openReadOnlyClient({...this.configuration,executable,timeoutMs},{spawnProcess:this.spawnProcess});
   await this.client.request('initialize',{clientInfo:{name:'codexcontrol_observer',title:'CodexControl read-only account observer',version:'0.8.0'}});this.client.initialized();
   const account=await this.client.request('account/read',{refreshToken:false});
   if(!object(account)||!object(account.account)){this.#bindAccount(null);throw observerError('account-unavailable');}
   this.#bindAccount(account.account);nativeAccount=account.account;
   this.value.planType=label(account.account.planType);
   const measured=method=>this.client.request(method).then(result=>({result,at:new Date(this.clock()).toISOString()}));
   const results=await Promise.allSettled([measured('account/rateLimits/read'),measured('account/usage/read')]);
   for(let i=0;i<results.length;i++){
    const result=results[i];if(result.status==='rejected'){errors.push(result.reason?.observerCode??'rpc-unavailable');continue;}
    try{const {result:response,at}=result.value;if(i===0){const limits=normalizeAccountLimits(response),state=normalizeAccountLimitState(response);this.value.limits=limits;for(const key of limitStateKeys)delete this.value[key];Object.assign(this.value,state);this.value.limitsObservedAt=at;}else{const usage=normalizeAccountTokenUsage(response);delete this.value.threadUsage;Object.assign(this.value,usage);this.value.usageObservedAt=at;}this.value.observedAt=!this.value.observedAt||at>this.value.observedAt?at:this.value.observedAt;succeeded++;}catch(error){errors.push(error.observerCode??'invalid-response');}
   }
  }catch(error){if(error.observerCode==='spawn-failed')this.#launchFailure=await diagnoseLaunch(error,this.configuration.executable,this.statExecutable,Math.max(0,this.configuration.timeoutMs-(performance.now()-startedAt)));errors.push(error.observerCode??'rpc-unavailable');}
  finally{this.client?.close();this.client=null;}
  if(this.nativeAnalytics){const analytics=await this.nativeAnalytics.poll(nativeAccount);if(analytics&&!this.closed)this.value.nativeAnalytics=analytics;else delete this.value.nativeAnalytics;}
  this.value.status=succeeded===2?'available':succeeded?'partial':this.value.observedAt?'stale':'unavailable';this.value.errorCode=errors[0]??null;
  return this.snapshot();
 }
 stop(){this.closed=true;this.nativeAnalytics?.stop();this.discovery?.abort();this.client?.close();this.client=null;}
}

export function createCodexAccountObserver(configuration,dependencies){return configuration?.enabled===true?new CodexAccountObserver(configuration,dependencies):null;}
