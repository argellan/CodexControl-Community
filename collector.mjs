// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import os from 'node:os';
import {sampleTarget} from './lib/targets.mjs';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {RetryPolicy} from './public/retry-policy.mjs';
import {createCodexAccountObserver} from './lib/codex-account-observer.mjs';
import {sanitizeAccountUsage} from './lib/account-usage.mjs';
import {createDesktopCompanionObserver} from './lib/desktop-companion.mjs';
import {validateUsageCursor,sanitizeUsageCoverage} from './lib/observer.mjs';
import {createProcessObserver} from './lib/process-observer.mjs';
import {processDigest,normalizeProcessSamples} from './lib/process-history.mjs';

export function sourceAddresses(configuration,interfaces=os.networkInterfaces()){
 const assigned=new Set(Object.values(interfaces).flat().map(i=>i.address));const preferred=(configuration.localAddresses||[]).filter(ip=>assigned.has(ip));return preferred.length?preferred:[undefined];
}
const identityCache=new WeakMap(),configurationCache=new WeakMap();
const retryable=new Set(['EHOSTUNREACH','ETIMEDOUT','ECONNREFUSED','ECONNRESET','EADDRNOTAVAIL','ENETUNREACH']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function accountUsageForBatch(value){try{return sanitizeAccountUsage(value);}catch{return null;}}
function endpointOf(configuration,route){
 const endpoint=new URL(route,configuration.url);
 if(endpoint.protocol!=='https:'&&!(endpoint.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)))throw new Error('Collector requires HTTPS or a loopback SSH tunnel');
 if(endpoint.username||endpoint.password)throw new Error('Collector endpoint must not contain credentials');return endpoint;
}
function machineGuard(configuration,hostname=os.hostname()){
 if(configuration.expectedHostname!==undefined&&(typeof configuration.expectedHostname!=='string'||!configuration.expectedHostname||configuration.expectedHostname.length>253||/[\x00-\x1f\x7f]/.test(configuration.expectedHostname)||configuration.expectedHostname.toLowerCase()!==hostname.toLowerCase()))throw new Error('Collector expected hostname mismatch; no credential sent');
}
function signature(configuration,localAddress){return JSON.stringify([new URL(configuration.url).origin,configuration.hostId,configuration.expectedInstanceId,configuration.expectedHostname,configuration.caFile,configuration.caPem?crypto.createHash('sha256').update(String(configuration.caPem)).digest('hex'):null,localAddress??null]);}
function cacheFor(store,configuration){let cache=store.get(configuration);if(!cache){cache=new Map();store.set(configuration,cache);}return cache;}
function saveCache(cache,key,value){cache.set(key,value);while(cache.size>8)cache.delete(cache.keys().next().value);}
async function certificateAuthority(configuration){
 if(configuration.caPem!==undefined){if(typeof configuration.caPem!=='string'||!configuration.caPem||Buffer.byteLength(configuration.caPem)>1048576)throw new Error('Invalid inline collector CA');return configuration.caPem;}
 if(configuration.caFile){const stat=await fs.stat(configuration.caFile);if(!stat.isFile()||stat.size<1||stat.size>1048576)throw new Error('Invalid collector CA file');return fs.readFile(configuration.caFile);}return undefined;
}
async function requestJSON(configuration,route,{method='GET',body,authenticated=false,localAddress,maxBytes=8192,unsupported=[]}={}){
 const endpoint=endpointOf(configuration,route),ca=await certificateAuthority(configuration),encoded=body===undefined?undefined:JSON.stringify(body),headers={accept:'application/json'};
 if(authenticated)headers.authorization='Bearer '+configuration.token;
 if(encoded!==undefined){if(Buffer.byteLength(encoded)>(route==='/api/collector/companion'?11534336:2097152))throw new Error('Collector batch exceeds byte bound');headers['content-type']='application/json';headers['content-length']=Buffer.byteLength(encoded);}
 const timeoutMs=Number.isFinite(configuration.timeoutMs)?Math.max(1,Math.min(60000,configuration.timeoutMs)):10000;
 return new Promise((resolve,reject)=>{
  let timer,settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
  const request=(endpoint.protocol==='https:'?https:http).request(endpoint,{method,ca,localAddress,headers,timeout:timeoutMs,rejectUnauthorized:true},response=>{
   let size=0;const chunks=[];response.on('data',chunk=>{size+=Buffer.byteLength(chunk);if(size>maxBytes){finish(new Error('Collector response exceeds bound'));request.destroy();}else chunks.push(Buffer.from(chunk));});response.on('aborted',()=>finish(Object.assign(new Error('Collector response interrupted'),{code:'ECONNRESET'})));response.on('error',error=>finish(error));response.on('end',()=>{try{if(unsupported.includes(response.statusCode)){finish(null,{unsupported:true,status:response.statusCode});return;}if(response.statusCode!==200){const guidance=response.headers['retry-after'];throw Object.assign(new Error('Collector endpoint refused request: '+response.statusCode),{status:response.statusCode,retryAfter:[429,503].includes(response.statusCode)&&typeof guidance==='string'&&guidance.length<=128?guidance:undefined});}const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!object(result))throw new Error('Invalid collector JSON response');finish(null,result);}catch(error){finish(error);}});
  });const timeout=()=>request.destroy(Object.assign(new Error('Collector endpoint timeout'),{code:'ETIMEDOUT'}));timer=setTimeout(timeout,timeoutMs);request.on('timeout',timeout);request.on('error',error=>finish(error));request.end(encoded);
 });
}
export async function verifyCollectorIdentity(configuration,localAddress,{now=Date.now(),hostname=os.hostname()}={}){
 machineGuard(configuration,hostname);const endpoint=endpointOf(configuration,'/api/identity');
 if(configuration.expectedInstanceId===undefined||configuration.expectedInstanceId===null)return {verified:false,reason:'legacy-unpinned',origin:endpoint.origin};
 if(typeof configuration.expectedInstanceId!=='string'||!configuration.expectedInstanceId||configuration.expectedInstanceId.length>128||/[\x00-\x1f\x7f]/.test(configuration.expectedInstanceId))throw new Error('Invalid expected instance identity');
 const cache=cacheFor(identityCache,configuration),key=signature(configuration,localAddress),old=cache.get(key);if(old&&now>=old.checkedAt&&now-old.checkedAt<30000)return {...old.result,cached:true};
 const response=await requestJSON(configuration,'/api/identity',{localAddress});
 if(response.deploymentId!==configuration.expectedInstanceId||response.readOnly!==true||response.protocolVersion!==1)throw new Error('Collector endpoint identity or protocol mismatch; no credential sent');
 const result={verified:true,origin:endpoint.origin,instanceId:response.deploymentId,protocolVersion:1};saveCache(cache,key,{checkedAt:now,result});return result;
}
async function onInterface(configuration,action,explicit){let lastError;for(const address of explicit!==undefined?[explicit]:sourceAddresses(configuration)){try{return await action(address);}catch(error){lastError=error;if(!retryable.has(error.code))throw error;}}throw lastError;}
export async function pollProcessCapabilities(configuration){
 return onInterface(configuration,async address=>{
  const identity=await verifyCollectorIdentity(configuration,address);
  if(!identity.verified)return {unsupported:true};
  return requestJSON(configuration,'/api/collector/process-capabilities',{authenticated:true,localAddress:address,unsupported:[404,503]});
 });
}
function validateSources(value,hostId){
 if(!Array.isArray(value)||value.length>256)throw new Error('Invalid collector source configuration');const fields=new Set(['id','hostId','kind','path','intervalMs','enabled']),seen=new Set();
 return value.map(source=>{if(!object(source)||Object.keys(source).some(k=>!fields.has(k))||!['id','hostId','kind','path','intervalMs','enabled'].every(k=>Object.hasOwn(source,k))||typeof source.id!=='string'||!/^[a-z0-9][-a-z0-9_]{0,63}$/.test(source.id)||seen.has(source.id)||source.hostId!==hostId||!['codex-log','job-feed','execution-target'].includes(source.kind)||typeof source.path!=='string'||source.path.length>1024||/[\x00-\x1f\x7f]/.test(source.path)||typeof source.enabled!=='boolean'||!Number.isSafeInteger(source.intervalMs)||source.intervalMs<250||source.intervalMs>300000)throw new Error('Invalid collector source configuration');
  if(source.kind==='execution-target'?source.path!=='':!source.path||source.path.includes('://')||!path.posix.isAbsolute(source.path)&&!path.win32.isAbsolute(source.path)||/(?:^|[\\/])(?:auth\.json|credentials?(?:\.[^\\/]*)?|tokens?(?:\.[^\\/]*)?|id_(?:rsa|ed25519)(?:\.pub)?|[^\\/]*\.(?:pem|pfx|p12|key))$/i.test(source.path))throw new Error('Unsupported collector source path');seen.add(source.id);return {...source};});
}
export async function pollCollectorConfiguration(configuration,{localAddress,now=Date.now(),force=false}={}){
 return onInterface(configuration,async address=>{
  const identity=await verifyCollectorIdentity(configuration,address,{now});if(!identity.verified)return {supported:false,managed:false,identityVerified:false,revision:null,sources:null,changed:false};
  const cache=cacheFor(configurationCache,configuration),key=signature(configuration,address),old=cache.get(key);if(!force&&old&&now>=old.checkedAt&&now-old.checkedAt<30000)return {...old.result,sources:old.result.sources?.map(s=>({...s}))??null,changed:false};
  const response=await requestJSON(configuration,'/api/collector/config',{authenticated:true,localAddress:address,maxBytes:524288,unsupported:[404,503]});
  if(response.unsupported){const result={supported:false,managed:false,identityVerified:true,revision:old?.result.revision??null,sources:null,changed:false};saveCache(cache,key,{checkedAt:now,result});return result;}
  if(!Number.isSafeInteger(response.revision)||response.revision<0||typeof response.managed!=='boolean'||response.managed&&response.revision<1||Object.keys(response).some(k=>!['revision','sources','managed'].includes(k)))throw new Error('Invalid collector configuration response');
  const sources=validateSources(response.sources,configuration.hostId);if(!response.managed&&sources.length)throw new Error('Invalid unmanaged collector source configuration');const result={supported:true,managed:response.managed,identityVerified:true,revision:response.revision,sources,changed:old?.result.revision!==response.revision||old?.result.managed!==response.managed};saveCache(cache,key,{checkedAt:now,result:{...result,sources:sources.map(s=>({...s}))}});return result;
 },localAddress);
}
export function applyCollectorSources(configuration,sources,{configureObservation}={}){
 const safe=validateSources(sources,configuration.hostId),enabled=safe.filter(s=>s.enabled),feeds=enabled.filter(s=>s.kind==='job-feed');
 if(feeds.length>1||enabled.filter(s=>s.kind==='codex-log').length>4)throw new Error('Collector source configuration exceeds runtime root limits');
 if(configuration.role==='execution-target'){if(enabled.some(s=>s.kind==='codex-log')||feeds.some(s=>!path.isAbsolute(s.path)))throw new Error('Unsupported execution-target source kind or path');if(feeds.length)configuration.jobFile=feeds[0].path;else delete configuration.jobFile;return {applied:true,jobFeedConfigured:!!feeds.length};}
 if(typeof configureObservation!=='function')throw new Error('Collector observation configuration unavailable');configureObservation(safe);return {applied:true};
}
const samplesDigest=samples=>crypto.createHash('sha256').update(JSON.stringify(samples)).digest('hex');
async function transmit(configuration,payload,localAddress){
 const ack=await requestJSON(configuration,'/api/collector',{method:'POST',body:payload,authenticated:true,localAddress,maxBytes:16000});
 if(ack.batchId!==payload.batchId||ack.hostId!==configuration.hostId)throw new Error('Acknowledgement identity mismatch');
 if(Object.hasOwn(payload,'usageSamples')&&(ack.usageSamplesCount!==payload.usageSamples.length||ack.usageSamplesSha256!==samplesDigest(payload.usageSamples)))throw new Error('Usage sample acknowledgement mismatch; pending batch retained');
 if(payload.processSamples&&(ack.processSamplesCount!==payload.processSamples.length||ack.processSamplesSha256!==processDigest(payload.processSamples)))throw new Error('Process acknowledgement mismatch; pending batch retained');
 return ack;
}
export async function sendBatch(configuration,payload){
 if(!object(payload)||!Array.isArray(payload.events)||payload.events.length>500)throw new Error('Collector batch exceeds event bound');
 if(Object.hasOwn(payload,'usageSamples')&&(!Array.isArray(payload.usageSamples)||payload.usageSamples.length>1000||Buffer.byteLength(JSON.stringify(payload.usageSamples))>1048576))throw new Error('Collector usage batch exceeds bound');
 if(payload.processSamples)normalizeProcessSamples(payload.processSamples,configuration.hostId);
 if(Buffer.byteLength(JSON.stringify(payload))>2097152)throw new Error('Collector batch exceeds byte bound');
 return onInterface(configuration,async address=>{const identity=await verifyCollectorIdentity(configuration,address);if(!identity.verified)throw new Error('Collector endpoint identity is not pinned; enroll this source before sending credentials');return transmit(configuration,payload,address);});
}

async function syncDirectory(directory){let handle;try{handle=await fs.open(directory,'r');await handle.sync();}catch(error){if(process.platform!=='win32'||!['EPERM','EISDIR','EINVAL','EBADF'].includes(error.code))throw error;}finally{await handle?.close();}}
async function writeDurablePrivateJSON(file,value){
 await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const temporary=file+'.tmp-'+crypto.randomUUID();let handle;
 try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify(value));await handle.sync();await handle.close();handle=null;await fs.rename(temporary,file);await syncDirectory(path.dirname(file));}
 catch(error){await handle?.close();try{await fs.unlink(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}throw error;}
}
function cursorDestination(configuration){return {hostId:configuration.hostId,origin:endpointOf(configuration,'/api/collector').origin,instanceId:configuration.expectedInstanceId??null};}
function sameDestination(value,expected){return object(value)&&Object.keys(value).length===3&&value.hostId===expected.hostId&&value.origin===expected.origin&&value.instanceId===expected.instanceId;}
async function readBoundedJSON(file,maximum){const stat=await fs.stat(file);if(!stat.isFile()||stat.size>maximum)throw new Error('Collector checkpoint exceeds byte bound');return JSON.parse(await fs.readFile(file,'utf8'));}
export async function runCollectorLoop(cycle,{intervalMs=2000,signal,clock,wallClock,random,wait=(ms,signal)=>delay(ms,undefined,{signal})}={}){
 const retry=new RetryPolicy({intervalMs,maxMs:60000,clock,wallClock,random});
 while(!signal?.aborted){
  if(retry.begin()){
   try{await cycle();retry.succeed();}
   catch(error){retry.fail(error);console.error(new Date().toISOString()+' '+error.message+'; pending batch retained');}
  }
  if(signal?.aborted)return;
  try{await wait(Math.max(1,retry.remaining()),signal);}catch(error){if(signal?.aborted&&error.name==='AbortError')return;throw error;}
 }
}
export async function runCollector(configPath,{once=false,processObserverFactory=createProcessObserver,targetSnapshotFactory=sampleTarget}={}){
 const configuration=JSON.parse(await fs.readFile(configPath,'utf8'));
 if(!/^[-a-z0-9]{1,64}$/.test(configuration.hostId)||typeof configuration.token!=='string'||configuration.token.length<32)throw new Error('Invalid collector configuration');
 machineGuard(configuration);
 const accountObserver=configuration.role==='execution-target'?null:createCodexAccountObserver(configuration.accountObserver);
 if(configuration.sessionRoot)process.env.CODEX_CONTROL_SESSION_ROOT=configuration.sessionRoot;
 process.env.CODEX_CONTROL_HOST_ID=configuration.hostId;
 let snapshot,configureObservation,readUsageSamples;if(configuration.role==='execution-target')snapshot=()=>targetSnapshotFactory(configuration);else{const module=await import('./server.mjs');snapshot=module.snapshot;configureObservation=module.configureObservation;readUsageSamples=module.readUsageSamples;if(typeof readUsageSamples!=='function')throw new Error('Durable numeric usage source reader unavailable');if(!once)module.watchSessionInventory();}
 const spool=configuration.spool||configPath+'.outbox',cursorFile=spool+'.usage-cursor.json',destination=cursorDestination(configuration),seen=new Set(),bootstrapIds=new Set();let pending,pendingPersisted=false,pendingCursor=null,usageCursor=null,observed=false,appliedRevision=null,configurationManaged=false,forceConfigurationPoll=false;
 try{const saved=await readBoundedJSON(cursorFile,17825792);if(!object(saved)||saved.version!==1||!sameDestination(saved.destination,destination))throw new Error('Numeric usage cursor destination mismatch; checkpoint retained');usageCursor=validateUsageCursor(saved.cursor);}catch(error){if(error.code!=='ENOENT')throw error;}
 try{
  const stored=await readBoundedJSON(spool,20971520),enveloped=object(stored)&&stored.version===2&&object(stored.payload);
  if(enveloped){if(!Array.isArray(stored.payload.usageSamples))throw new Error('Pending collector usage custody is invalid; batch retained');if(Object.keys(stored).some(k=>!['version','destination','payload','usageCursor'].includes(k))||!Object.hasOwn(stored,'usageCursor')||!sameDestination(stored.destination,destination))throw new Error('Pending collector destination mismatch; batch retained');pending=stored.payload;pendingCursor=validateUsageCursor(stored.usageCursor);}
  else pending=stored;
  if(!object(pending)||pending.hostId!==configuration.hostId||!Array.isArray(pending.events)||pending.events.length>500||!Array.isArray(pending.sessions)||pending.sessions.length>128||Buffer.byteLength(JSON.stringify(pending))>2097152||Object.hasOwn(pending,'usageSamples')&&(!Array.isArray(pending.usageSamples)||pending.usageSamples.length>1000))throw new Error('Invalid pending collector batch');
  // Preserve exact V2 wire bytes across retry. The legacy optional-account
  // recovery rule applies only to old payload-only spools without usage custody.
  if(!enveloped&&!pending.processSamples&&Object.hasOwn(pending,'accountUsage')){const safe=accountUsageForBatch(pending.accountUsage);if(safe)pending.accountUsage=safe;else delete pending.accountUsage;}
  pendingPersisted=true;
 }catch(e){if(e.code!=='ENOENT')throw e;}
 const processObserver=processObserverFactory(configuration);let processCapability=null,processCapabilityUntil=0;
 const processSpool=spool+'.process.json';let stagedProcesses=null,processPersisted=false;
 try{const staged=await readBoundedJSON(processSpool,600000);if(!object(staged)||staged.version!==1||!sameDestination(staged.destination,destination))throw new Error('Process custody destination mismatch; observation retained');normalizeProcessSamples(staged.samples,configuration.hostId);stagedProcesses=staged.samples;processPersisted=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 const desktopObserver=configuration.role==='execution-target'?null:createDesktopCompanionObserver(configuration.desktopCompanion,{directory:spool+'.companion'});
 const observeDesktop=()=>desktopObserver?.poll(async(metadata,artwork)=>onInterface(configuration,async address=>{const identity=await verifyCollectorIdentity(configuration,address);if(!identity.verified)throw new Error('Desktop companion requires a pinned hub');const ack=await requestJSON(configuration,'/api/collector/companion',{method:'POST',body:{metadata,artwork},authenticated:true,localAddress:address,maxBytes:4096});if(ack.artworkSha256!==metadata.artworkSha256)throw new Error('Desktop companion acknowledgement mismatch');}));
 const cycle=async()=>{
  if(!once)void observeDesktop();else await observeDesktop();
  const policy=await pollCollectorConfiguration(configuration,{force:forceConfigurationPoll});forceConfigurationPoll=false;
  if(policy.supported&&policy.managed&&policy.revision!==appliedRevision){applyCollectorSources(configuration,policy.sources,{configureObservation});appliedRevision=policy.revision;configurationManaged=true;}else if(policy.supported&&!policy.managed){configurationManaged=false;appliedRevision=null;}
  if(!pending){
   let processSamples=stagedProcesses||[];if(!stagedProcesses&&configuration.processTelemetry?.enabled===true){if(Date.now()>=processCapabilityUntil){processCapability=await pollProcessCapabilities(configuration);processCapabilityUntil=Date.now()+30000;}if(processCapability?.processTelemetryV1===true){processSamples=await processObserver.poll();if(processSamples.length)stagedProcesses=processSamples;}}
   if(stagedProcesses&&!processPersisted){await writeDurablePrivateJSON(processSpool,{version:1,destination,samples:stagedProcesses});processPersisted=true;}
   const data=await snapshot();if(!observed){for(const e of data.events)bootstrapIds.add(e.id);observed=true;}const events=data.events.filter(e=>!seen.has(e.id)).slice(0,500).map(e=>configuration.role==='execution-target'?{...e,delivery:bootstrapIds.has(e.id)?'bootstrap':Date.now()-Date.parse(e.at)<10000?'live':'backfill'}:e);
   const accountUsage=accountUsageForBatch(accountObserver?(once?await accountObserver.poll():accountObserver.sample()):null);
   const usageCapture=readUsageSamples?await readUsageSamples(usageCursor):null;
   if(usageCapture){if(!Array.isArray(usageCapture.usageSamples)||usageCapture.usageSamples.length>1000)throw new Error('Invalid numeric usage capture');pendingCursor=validateUsageCursor(usageCapture.nextCursor);}
   pending={...(processSamples.length?{processSamples}:{}),hostId:configuration.hostId,batchId:crypto.randomUUID(),observedAt:data.observedAt,sessions:data.sessions.map(({events,...s})=>s),events,coverage:{...data.coverage,identityVerified:policy.identityVerified===true,configurationRevision:appliedRevision,configurationManaged,...(usageCapture?{numericUsage:sanitizeUsageCoverage(usageCapture.coverage)}:{})},host:data.host,...(accountUsage?{accountUsage}:{}),...(usageCapture?{usageSamples:usageCapture.usageSamples}:{}),...(desktopObserver?.sample()?{desktopCompanion:desktopObserver.sample()}:{})};
   if(Buffer.byteLength(JSON.stringify(pending))>2097152)throw new Error('Collector batch exceeds byte bound; source cursor retained');
   pendingPersisted=false;
  }
  if(!pendingPersisted){await writeDurablePrivateJSON(spool,pendingCursor!==null?{version:2,destination,payload:pending,usageCursor:pendingCursor}:pending);pendingPersisted=true;}
  const ack=await sendBatch(configuration,pending);if(Number.isSafeInteger(ack.configurationRevision)&&ack.configurationRevision!==policy.revision)forceConfigurationPoll=true;for(const e of pending.events)seen.add(e.id);if(seen.size>30000){const old=[...seen].slice(0,seen.size-24000);old.forEach(id=>seen.delete(id));}
  if(pendingCursor!==null){await writeDurablePrivateJSON(cursorFile,{version:1,destination,cursor:pendingCursor});usageCursor=pendingCursor;}
  if(pending.accountUsage?.nativeAnalytics?.digest)accountObserver?.acknowledgeAnalytics(pending.accountUsage.nativeAnalytics.digest);
  if(stagedProcesses&&pending.processSamples&&processDigest(stagedProcesses)===processDigest(pending.processSamples)){await fs.unlink(processSpool);await syncDirectory(path.dirname(processSpool));stagedProcesses=null;processPersisted=false;}
  await fs.unlink(spool);await syncDirectory(path.dirname(spool));pending=null;pendingCursor=null;return ack;
 };
 if(once){try{return await cycle();}finally{accountObserver?.stop();}}
 console.log('Codex-Control read-only collector started: '+configuration.hostId);
 const stopAccountObserver=()=>accountObserver?.stop(),signals=new Map(),shutdown=new AbortController();
 if(accountObserver){process.once('exit',stopAccountObserver);for(const [signal,status]of [['SIGINT',130],['SIGTERM',143]]){const stop=()=>{shutdown.abort();stopAccountObserver();setTimeout(()=>process.exit(status),300);};signals.set(signal,stop);process.once(signal,stop);}}
 try{return await runCollectorLoop(cycle,{signal:shutdown.signal,intervalMs:Math.max(1000,Math.min(60000,Number.isFinite(configuration.intervalMs)?configuration.intervalMs:2000))});}
 finally{stopAccountObserver();process.removeListener('exit',stopAccountObserver);for(const [signal,stop]of signals)process.removeListener(signal,stop);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runCollector(path.resolve(process.argv[2]||'.local/collector.json'),{once:process.argv.includes('--once')}).catch(error=>{console.error(error.message);process.exitCode=1;});
