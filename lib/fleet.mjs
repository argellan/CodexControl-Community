// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {HistoryJournal} from './history.mjs';
import {JournalWriter} from './journal-writer.mjs';
import {isStorageBackpressure} from './storage-admission.mjs';
import {sanitizeAccountUsage} from './account-usage.mjs';
import {sanitizeCompanion} from './desktop-companion.mjs';
import {sanitizeUsageLimits} from '../public/worker-model.mjs';
import {normalizeTaskLabelMetadata,TASK_LABEL_SOURCE} from './task-labels.mjs';
import {normalizeUsageSample} from './usage-samples.mjs';
import {sanitizeUsageCoverage,validateUsageCursor} from './observer.mjs';

const eventFields=new Set('id sourceId offset sessionId project projectBasis turnId at timeOrigin receivedAt delivery kind label category callId startedAt completedAt outcome exitCode childId requestId hostId hostName jobId workerHostId workerSessionId workerCallId progress operationType'.split(' '));
const numericEventFields=new Set(['offset','exitCode','progress']);
const sessionFields=new Set('id project cwd origin provider version parentId agentPath nickname forkedFrom taskLabel taskLabelSource taskLabelUpdatedAt state model effort tokens lastTokens usageObservedAt usageLimits contextWindow tools changes lastEventAt modifiedAt size capture hostId hostName role workerHostId workerCallId'.split(' '));
const allowedKinds=new Set(['turn','complete','error','approval','resolution','operation','tool.start','tool.end','message','remote.start','remote.end','remote.progress']);
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const seconds=(value,fallback,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max?value:fallback;
const sourceRoleFor=host=>host.role===undefined||host.role==='hub'?'codex-source':['codex-source','execution-target','execution-job'].includes(host.role)?host.role:'unknown';
function collectorCoverage(value){
 const result={};
 for(const field of ['identityVerified','configurationManaged'])if(typeof value?.[field]==='boolean')result[field]=value[field];
 if(value?.configurationRevision===null||Number.isSafeInteger(value?.configurationRevision)&&value.configurationRevision>=0)result.configurationRevision=value.configurationRevision;
 if(value?.numericUsage){const usage=sanitizeUsageCoverage(value.numericUsage);if(usage)result.numericUsage=usage;}
 return result;
}
function validateObject(object,fields){if(!object||typeof object!=='object'||Array.isArray(object)||Object.keys(object).some(k=>!fields.has(k)))fail('Unsupported payload field');}
function safeValue(value,key){
 if(value===null||typeof value==='boolean')return value;
 if(typeof value==='number')return Number.isFinite(value)?value:null;
 if(typeof value==='string')return value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,key==='cwd'?600:240).toWellFormed();
 if(key==='usageLimits')return sanitizeUsageLimits(value);
 if(['tokens','lastTokens'].includes(key)&&value&&typeof value==='object')return Object.fromEntries(['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'].filter(k=>Number.isSafeInteger(value[k])&&value[k]>=0).map(k=>[k,value[k]]));
 if(key==='capture'&&value&&typeof value==='object')return Object.fromEntries(['checkedAt','offset','partialBytes','reset','backlogged','tailLimited','retained'].filter(k=>['string','number','boolean'].includes(typeof value[k])).map(k=>[k,safeValue(value[k],k)]));
 return null;
}
function installationSessionProjection(previous,sessions,payload){
 const observedAt=payload.observedAt,observedMs=Date.parse(observedAt),completedAt=previous&&Object.hasOwn(previous,'installationSessionObservedAt')?previous.installationSessionObservedAt:previous?.observedAt;
 const completedMs=Date.parse(completedAt),projection={sessions:previous?.sessions??[],installationSessionObservedAt:completedAt??null};
 let staging=previous?.installationSessionFrames;
 if(Object.hasOwn(payload,'sessionFrame')){
  const frame=payload.sessionFrame;
  if(!frame||typeof frame!=='object'||Array.isArray(frame)||Object.keys(frame).some(k=>!['id','index','count'].includes(k))||typeof frame.id!=='string'||!/^[a-f0-9]{64}$/.test(frame.id)||!Number.isSafeInteger(frame.count)||frame.count<1||frame.count>4096||!Number.isSafeInteger(frame.index)||frame.index<0||frame.index>=frame.count)fail('Invalid session frame');
  if(staging?.id===frame.id&&(staging.count!==frame.count||staging.observedAt!==observedAt))fail('Conflicting session frame metadata');
  if(Number.isFinite(completedMs)&&observedMs<=completedMs)return {...projection,...(staging?{installationSessionFrames:staging}:{})};
  if(staging&&Date.parse(staging.observedAt)>observedMs)return {...projection,installationSessionFrames:staging};
  if(staging&&staging.id!==frame.id&&staging.observedAt===observedAt)fail('Conflicting session frame identity');
  staging=staging?.id===frame.id?{...staging,parts:{...staging.parts}}:{id:frame.id,count:frame.count,observedAt,parts:{}};
  // Current display names may change between retries; compare source session
  // metadata independently of that receiver-owned presentation field.
  const sourceSessions=rows=>JSON.stringify(rows.map(({hostName,...s})=>s));
  if(Object.hasOwn(staging.parts,frame.index)&&sourceSessions(staging.parts[frame.index])!==sourceSessions(sessions))fail('Conflicting session frame part');
  staging.parts[frame.index]=sessions;
  const identities=new Set();let count=0;
  for(const part of Object.values(staging.parts))for(const session of part){if(identities.has(session.id))fail('Duplicate session identity across session frames');identities.add(session.id);count++;}
  if(count>65536||Buffer.byteLength(JSON.stringify(staging))>16*1048576)fail('Session frame accumulation exceeds bound',413);
  if(Object.keys(staging.parts).length===staging.count)return {sessions:Array.from({length:staging.count},(_,index)=>staging.parts[index]).flat(),installationSessionObservedAt:observedAt};
  return {...projection,installationSessionFrames:staging};
 }
 if(!Number.isFinite(completedMs)||observedMs>=completedMs){projection.sessions=sessions;projection.installationSessionObservedAt=observedAt;}
 if(staging&&observedMs<Date.parse(staging.observedAt))projection.installationSessionFrames=staging;
 return projection;
}
export class FleetHub {
 writer=null;
 writerOwners=0;
 writerClosing=null;
 writerShutdown=false;
 retainJournalWriter(){
  this.writerOwners++;let released=false,releaseWork;
  return ()=>{
   if(released)return releaseWork??Promise.resolve();released=true;
   if(--this.writerOwners>0)return Promise.resolve();
   this.writerShutdown=true;const drain=this.queue;
   const closing=(async()=>{await drain;const writer=this.writer;if(writer){await writer.close();if(this.writer===writer)this.writer=null;}})();
   this.writerClosing=closing;
   releaseWork=closing.finally(()=>{if(this.writerClosing===closing){this.writerClosing=null;this.writerShutdown=false;}});
   return releaseWork;
  };
 }
 async writeJournal(args){
  // Function-valued reserve probes are an existing in-process integration seam.
  // Keep their exact locked-transaction semantics on the synchronous path.
  let writer;
  try{
   if(!this.writerOwners||typeof this.journal.storageAdmission.statfs==='function')return await this.journal.commit(args);
   writer=this.writer??=new JournalWriter(this.journal);
   return await writer.commit(JSON.stringify(args),this.journal.storageAdmission);
  }catch(error){
   if(!error.journalOutcome||error.journalOutcome==='uncertain'){
    error.journalOutcome='uncertain';
    this.fenced=true;this.generation++;
    try{
     await writer?.abort(error);if(this.writer===writer)this.writer=null;
     const restored=new Map();for(const host of this.hosts){const state=this.journal.state(host.id);if(state)restored.set(host.id,state);}
     this.states=restored;this.localObservedAt=undefined;this.fenced=false;
    }catch{error.recoveryFailed=true;}
   }else if(writer?.closed&&this.writer===writer)this.writer=null;
   throw error;
  }
 }
 pendingJobs=0;
 pendingBytes=0;
 generation=0;
 fenced=false;
 enqueue(value,operation){
  if(this.fenced||this.writerShutdown&&!this.writerOwners)return Promise.reject(Object.assign(new Error('Journal recovery is pending'),{code:'JOURNAL_RECOVERY_PENDING',status:503}));
  let bytes,owned;try{
   // Count retained work, including the in-flight job. The multiplier budgets
   // the snapshot, serialization and worker clone; caller-owned data is external.
   bytes=Buffer.byteLength(JSON.stringify(value))*4+65536;
   if(this.pendingJobs>=32||bytes+this.pendingBytes>64*1048576)return Promise.reject(Object.assign(new Error('Journal queue is full'),{code:'JOURNAL_QUEUE_BACKPRESSURE',status:503,retryAfter:1}));
   owned=structuredClone(value);
  }catch(error){return Promise.reject(error);}
  const generation=this.generation,closing=this.writerClosing;this.pendingJobs++;this.pendingBytes+=bytes;
  const job=this.queue.then(async()=>{
   if(closing)await closing;
   if(this.fenced||generation!==this.generation)throw Object.assign(new Error('Journal generation changed; retry from durable state'),{code:'JOURNAL_GENERATION_CHANGED',status:503});
   return operation(owned);
  }).finally(()=>{this.pendingJobs--;this.pendingBytes-=bytes;});
  this.queue=job.catch(()=>{});return job;
 }
 readProjection(input,read){return this.enqueue(input,owned=>{const value=read(owned);if(value&&typeof value.then==='function')throw new Error('Journal read projection must be synchronous');return value;});}
 captureRead(local,read){
  // A running desktop collector owns source capture and its durable queue.
  // API reads wait behind that queue, then read the committed local state.
  // Enqueuing the observer's growing event arrays again for every reader can
  // exhaust admission before the collector has finished its single write.
  if(this.localCaptureHostId&&local.host?.id===this.localCaptureHostId)return this.readProjection({host:{id:local.host.id,name:local.host.name}},owned=>{
   const committed=this.journal.state(owned.host.id);
   return read(committed??{observedAt:null,host:owned.host,sessions:[],events:[],coverage:{captureDeferred:true}});
  });
  return this.enqueue(local,async captured=>{
  try{await this.captureLocalNow(captured);}catch(error){
   if(!isStorageBackpressure(error))throw error;
   const committed=this.journal.state(captured.host.id),host=committed?.host?.id===captured.host.id?committed.host:{id:captured.host.id,name:captured.host.name};
   captured={...(committed??{}),host,sessions:Array.isArray(committed?.sessions)?committed.sessions:[],events:Array.isArray(committed?.events)?committed.events:[],coverage:{...(committed?.coverage??{}),captureDeferred:true}};
  }
  const value=read(captured);if(value&&typeof value.then==='function')throw new Error('Journal read projection must be synchronous');return value;
 });}
 setHosts(hosts){
  if(!Array.isArray(hosts)||hosts.length>64||hosts.some(h=>!h||typeof h!=='object'||!/^[-a-z0-9]{1,64}$/.test(h.id)||!/^[a-f0-9]{64}$/.test(h.tokenHash)))throw new Error('Invalid enrollment configuration');
  if(new Set(hosts.map(h=>h.id)).size!==hosts.length)throw new Error('Duplicate host identity');
  // Installation trust loads after the journal. Read only validated, enabled
  // managed identities, and publish neither inventory nor state on read failure.
  const nextHosts=structuredClone(hosts),nextStates=new Map(),now=Date.now();
  for(const host of nextHosts){
   if(host.disabled||host.expiresAt&&Date.parse(host.expiresAt)<=now)continue;
   const state=this.states.get(host.id)??(host.installationManaged?this.journal.state(host.id):null);
   if(state){const {events,...metadata}=state;nextStates.set(host.id,metadata);}
  }
  this.hosts=nextHosts;this.states=nextStates;
 }
 static async open({directory,hosts=[],historyOptions={}}){
  if(hosts.length>64||hosts.some(h=>!/^[-a-z0-9]{1,64}$/.test(h.id)||!/^[a-f0-9]{64}$/.test(h.tokenHash)))throw new Error('Invalid enrollment configuration');
  if(new Set(hosts.map(h=>h.id)).size!==hosts.length)throw new Error('Duplicate host identity');
  await fs.mkdir(directory,{recursive:true,mode:0o700});const hub=new FleetHub();hub.directory=directory;hub.hosts=hosts;hub.states=new Map();hub.queue=Promise.resolve();hub.journal=await HistoryJournal.open({directory,...historyOptions});
  for(const host of hosts){let state=hub.journal.state(host.id);if(!state){try{const raw=await fs.readFile(path.join(directory,host.id+'.json'),'utf8');if(raw.length>24000000)throw new Error('Fleet checkpoint exceeds bound');const legacy=JSON.parse(raw),{events,...metadata}=legacy;hub.journal.commit({hostId:host.id,state:metadata,events:events||[]});state=metadata;}catch(error){if(error.code!=='ENOENT')throw error;}}if(state){const {events,...metadata}=state;hub.states.set(host.id,metadata);}}
  return hub;
 }
 ingest(token,payload,options){return this.enqueue(payload,owned=>this.commit(token,owned,options));}
 authenticateCollector(token){
  if(typeof token!=='string'||token.length>4096)return null;
  const digest=crypto.createHash('sha256').update(String(token||'')).digest();
  const host=this.hosts.find(h=>crypto.timingSafeEqual(Buffer.from(h.tokenHash,'hex'),digest));return host&&!host.disabled&&(!host.expiresAt||Date.parse(host.expiresAt)>Date.now())?host:null;
 }
 async commit(token,payload,{wireSha256}={}){
  const host=this.authenticateCollector(token);if(!host)fail('Unauthorized',401);
  validateObject(payload,new Set(['hostId','batchId','observedAt','sessions','events','coverage','host','accountUsage','usageSamples','desktopCompanion','sessionFrame']));
  if(payload.hostId!==host.id)fail('Host identity mismatch',403);
  if(typeof payload.batchId!=='string'||payload.batchId.length>100||!Number.isFinite(Date.parse(payload.observedAt)))fail('Invalid batch');
  if(!Array.isArray(payload.sessions)||payload.sessions.length>128||!Array.isArray(payload.events)||payload.events.length>500)fail('Batch exceeds limit',413);
  const fingerprint=wireSha256??crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  if(!/^[a-f0-9]{64}$/.test(fingerprint))fail('Invalid batch fingerprint');
  // Cached proof is the last accepted collector batch; archive ACKs cannot change it.
  const prior=this.states.get(host.id)?.collectorBatchFingerprint;
  if(prior?.version===1&&prior.hostId===host.id&&prior.batchId===payload.batchId&&prior.sha256===fingerprint){const status=this.journal.status([host.id]);return {batchId:payload.batchId,hostId:host.id,added:0,retained:status.retainedEvents,journalSequence:status.latestSequence,...(Object.hasOwn(payload,'usageSamples')?{usageSamplesCount:payload.usageSamples.length,usageSamplesSha256:crypto.createHash('sha256').update(JSON.stringify(payload.usageSamples)).digest('hex')}:{})};}
  const sessionIds=new Set(),textFields=new Set('id project cwd origin provider version parentId agentPath nickname forkedFrom taskLabel taskLabelSource taskLabelUpdatedAt state model effort lastEventAt modifiedAt hostId hostName role workerHostId workerCallId'.split(' '));
  const sessions=payload.sessions.map(s=>{validateObject(s,sessionFields);for(const [k,v] of Object.entries(s))if(textFields.has(k)&&v!==null&&typeof v!=='string')fail('Invalid session metadata');const identity=safeValue(s.id,'id');if(typeof identity!=='string'||!identity||sessionIds.has(identity))fail('Duplicate or invalid session identity');sessionIds.add(identity);if(typeof s.id!=='string'||!s.id||s.id.length>200)fail('Invalid session');const taskFields=['taskLabel','taskLabelSource','taskLabelUpdatedAt'],hasTask=taskFields.some(k=>Object.hasOwn(s,k));if(hasTask&&s.taskLabelSource!==null&&s.taskLabelSource!==undefined&&s.taskLabelSource!==TASK_LABEL_SOURCE)fail('Invalid task label provenance');const task=hasTask?normalizeTaskLabelMetadata(s):{};return {...Object.fromEntries(Object.entries(s).filter(([k])=>!taskFields.includes(k)).map(([k,v])=>[k,safeValue(v,k)])),...task,hostId:host.id,hostName:host.label||host.id};});
  const incoming=payload.events.map(e=>{
   validateObject(e,eventFields);for(const [key,value] of Object.entries(e)){if(value===undefined||value===null)continue;if(numericEventFields.has(key)){if(typeof value!=='number'||!Number.isFinite(value))fail('Invalid event numeric metadata');}else if(typeof value!=='string'||!value.isWellFormed())fail('Invalid event text metadata');}if(typeof e.id!=='string'||!e.id||e.id.length>160||!allowedKinds.has(e.kind)||!Number.isFinite(Date.parse(e.at))||typeof e.sessionId!=='string'||!safeValue(e.sessionId,'sessionId')||!safeValue(e.id,'id'))fail('Invalid event');
   if(e.sourceId!==undefined&&e.sourceId!==null&&(typeof e.sourceId!=='string'||!e.sourceId||e.sourceId.length>240||/[\x00-\x1f\x7f]/.test(e.sourceId)))fail('Invalid event source identity');
   if(Object.hasOwn(e,'operationType')&&(e.operationType!=='context-compaction'||e.kind!=='operation'))fail('Invalid event operation type');
   if(e.progress!==undefined&&e.progress!==null&&(typeof e.progress!=='number'||!Number.isFinite(e.progress)||e.progress<0||e.progress>100))fail('Invalid event progress');
   return {...Object.fromEntries(Object.entries(e).map(([k,v])=>[k,safeValue(v,k)])),at:new Date(e.at).toISOString(),label:typeof e.label==='string'&&safeValue(e.label,'label').trim()?safeValue(e.label,'label'):e.kind,id:host.id+':'+safeValue(e.id,'id'),sourceId:host.id+':'+(safeValue(e.sourceId,'sourceId')||'log'),hostId:host.id,hostName:host.label||host.id,receivedAt:new Date().toISOString(),delivery:e.delivery==='bootstrap'?'bootstrap':Date.now()-Date.parse(e.at)>10000?'backfill':e.delivery};
  });
  const accountUsage=sanitizeAccountUsage(payload.accountUsage);
  const previous=this.states.get(host.id);
  const receivedAt=Date.now(),gap=previous&&receivedAt-previous.receivedAt>15000?{start:previous.receivedAt,end:receivedAt}:null;
  const usageSamples=Object.hasOwn(payload,'usageSamples')?payload.usageSamples:[];
  if(!Array.isArray(usageSamples)||usageSamples.length>1000||Buffer.byteLength(JSON.stringify(usageSamples))>1048576)fail('Usage samples exceed batch limit',413);
  const sourceRole=sourceRoleFor(host);
  for(const sample of usageSamples)normalizeUsageSample(sample,{hostId:host.id,receivedMs:receivedAt,sourceRole});
  const eventLimit=Math.min(12000,Math.floor(50000/Math.max(1,this.hosts.length)));
  if(gap)for(const e of incoming)if(e.delivery!=='bootstrap')e.delivery='backfill';
  const telemetry=payload.host?Object.fromEntries(['platform','node','cpu','cores','totalMemory','freeMemory','uptime'].map(k=>[k,safeValue(payload.host[k],k)])):null;
  if(telemetry&&Array.isArray(payload.host.services))telemetry.services=payload.host.services.slice(0,12).map(s=>Object.fromEntries(['unit','state','subState','pid','memory','cpuNanoseconds'].map(k=>[k,safeValue(s[k],k)])));
  const state={telemetry,credentialGeneration:host.credentialGeneration??1,id:host.id,label:host.label||host.id,receivedAt,observedAt:payload.observedAt,clockOffsetMs:receivedAt-Date.parse(payload.observedAt),batchId:payload.batchId,...installationSessionProjection(previous,sessions,payload),coverage:{limit:Number(payload.coverage?.limit)||128,allDatedFolders:payload.coverage?.allDatedFolders===true,tailBytes:Number(payload.coverage?.tailBytes)||262144,eventLimit,role:host.role||'codex-source',jobFeed:safeValue(payload.coverage?.jobFeed,'jobFeed'),invalidRecords:Number(payload.coverage?.invalidRecords)||0,completeHistory:false,...collectorCoverage(payload.coverage)},gaps:[...(previous?.gaps||[]),...(gap?[gap]:[])].slice(-40)};
  if(accountUsage)state.accountUsage=accountUsage;
  if(payload.desktopCompanion){if(sourceRole!=='codex-source')fail('Desktop companion requires a Codex source');state.desktopCompanion=sanitizeCompanion(payload.desktopCompanion);if(previous?.desktopCompanion?.selectionKey!==state.desktopCompanion.selectionKey)incoming.push({id:host.id+':desktop-dot:'+state.desktopCompanion.selectionKey,sourceId:host.id+':desktop-companion',sessionId:'desktop-companion',project:'Desktop companion',kind:'operation',category:'companion.selection',label:'Desktop Dot artwork selected',at:state.desktopCompanion.observedAt,receivedAt:new Date(receivedAt).toISOString(),timeOrigin:'source',delivery:receivedAt-Date.parse(state.desktopCompanion.observedAt)>10000?'backfill':'live',hostId:host.id,hostName:host.label||host.id});}
  state.collectorBatchFingerprint={version:1,hostId:host.id,batchId:payload.batchId,sha256:fingerprint};
  // Preserve the existing HistoryJournal 2MiB host-state admission contract.
  // A rejected frame stays in sender custody; no events or cursor publish here.
  if(Buffer.byteLength(JSON.stringify(state))>2097152)fail('Session projection exceeds journal state bound',413);
  const committed=await this.writeJournal({hostId:host.id,state,events:incoming,usageSamples,sourceRole});
  this.states.set(host.id,state);
  return {batchId:payload.batchId,hostId:host.id,added:committed.added,retained:this.journal.status([host.id]).retainedEvents,journalSequence:committed.latestSequence,...(Object.hasOwn(payload,'usageSamples')?{usageSamplesCount:usageSamples.length,usageSamplesSha256:crypto.createHash('sha256').update(JSON.stringify(usageSamples)).digest('hex')}:{})};
 }
 captureLocal(local,{usageCapture}={}){return this.enqueue({local,usageCapture},owned=>this.captureLocalNow(owned.local,{usageCapture:owned.usageCapture}));}
 async captureLocalNow(local,{usageCapture}={}){
  if(this.localObservedAt===local.observedAt&&!usageCapture)return {added:0};
  const {events,...metadata}=local;metadata.sessions=(metadata.sessions||[]).map(({events,...session})=>session);
  const samples=usageCapture?.usageSamples??[];if(!Array.isArray(samples)||samples.length>1000)fail('Usage samples exceed batch limit',413);
  if(usageCapture)metadata.coverage={...metadata.coverage,numericUsage:sanitizeUsageCoverage(usageCapture.coverage)};
  const usageCursor=usageCapture?.nextCursor===undefined?undefined:validateUsageCursor(usageCapture.nextCursor);
  const result=await this.writeJournal({hostId:local.host.id,state:metadata,events,usageSamples:samples,...(usageCursor===undefined?{}:{usageCursor}),sourceRole:'codex-source'});this.localObservedAt=local.observedAt;return result;
 }
 snapshot(local,now=Date.now(),{includeEvents=true,hostIds,projectIds}={}){
  const staleAfter=seconds(this.healthThresholds?.sourceStaleSeconds,15,5,3600)*1000,offlineAfter=Math.max(staleAfter+1000,seconds(this.healthThresholds?.sourceOfflineSeconds,30,10,7200)*1000);
  const validTime=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=8640000000000000;
  const hosts=this.hosts.map(h=>{
   const s=this.states.get(h.id),isLocal=h.id===local.host.id;
   // Local capture has source time, not a remote collector receipt. Missing or
   // malformed remote receipt times remain unknown without breaking the fleet.
   const sourceTime=isLocal?Date.parse(local.observedAt):null;
   const received=validTime(s?.receivedAt)?s.receivedAt:validTime(sourceTime)?sourceTime:null;
   const age=received===null?null:now-received;
   return {id:h.id,name:h.label||h.id,role:h.role||'codex-source',deviceClass:h.deviceClass||'unknown',preferredAddress:h.preferredAddress||null,alternateAddresses:h.alternateAddresses||[],telemetry:isLocal?local.host:s?.telemetry||null,credentialGeneration:s?.credentialGeneration??null,reportedSessionCount:isLocal?local.sessions.length:s?.sessions?.length??0,status:h.disabled?'disabled':h.expiresAt&&Date.parse(h.expiresAt)<=now?'expired':age===null?'not connected':age>offlineAfter?'disconnected':age>staleAfter?'stale':'online',receivedAt:received===null?null:new Date(received).toISOString(),sourceObservedAt:isLocal?local.observedAt:s?.observedAt||null,clockOffsetMs:s?.clockOffsetMs??null,gaps:s?.gaps||[],coverage:isLocal?local.coverage:s?.coverage||null};
  });
  if(local.host.id&&!hosts.some(h=>h.id===local.host.id))hosts.unshift({id:local.host.id,name:local.host.name,role:'hub',deviceClass:local.host.deviceClass||'unknown',status:'online',receivedAt:new Date(now).toISOString(),gaps:[],telemetry:local.host});
  const remote=this.hosts.filter(h=>h.id!==local.host.id&&!h.disabled&&(!h.expiresAt||Date.parse(h.expiresAt)>now)).flatMap(h=>{const state=this.states.get(h.id);return state?[{...state,sessions:state.sessions.map(s=>({...s,hostName:h.label||h.id}))}]:[];});return {...local,observedAt:new Date(now).toISOString(),mode:'read-only-fleet-observer',history:this.journal.status(hostIds,projectIds),hosts,sessions:[...local.sessions.map(({events,...session})=>session),...remote.flatMap(s=>s.sessions)],events:includeEvents?this.journal.latest({hostIds,projectIds}):[],coverage:{...local.coverage,enrolledHosts:hosts.length,connectedHosts:hosts.filter(h=>h.status==='online').length,persistentRemoteHistory:true,durableJournal:true,bootstrapEventLimit:5000,bootstrapByteLimit:4194304,fleetEventLimit:50000}};
 }
}
