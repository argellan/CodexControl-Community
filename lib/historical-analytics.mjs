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
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {readPrivateKeyFile} from './private-key-file.mjs';

export const HISTORICAL_ANALYTICS_LIMITS=Object.freeze({requestBytes:65536,responseBytes:262144,stderrBytes:16384,maxRows:1000,maxHosts:64,maxDays:3660});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const own=(value,keys,required=keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k))&&required.every(k=>Object.hasOwn(value,k));
const integer=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const label=(value,max=256)=>typeof value==='string'&&value.length>0&&value.length<=max&&value.isWellFormed()&&!/[\x00-\x1f\x7f]/.test(value);
const nullableLabel=value=>value===null||label(value);
const absolute=value=>label(value,1024)&&path.isAbsolute(value)&&! /^(?:\\\\|\/\/)/.test(value);
// OpenSSH expands tokens/environment variables in file settings. Require
// literal paths and quote the pin file so spaces cannot become extra files.
const sshFile=value=>absolute(value)&&!/["%$]/.test(value)&&(process.platform==='win32'||!value.includes('\\'));
const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?Z$/.test(value)&&Number.isFinite(Date.parse(value))&&day(value.slice(0,10));
const decimal=value=>value===null||typeof value==='string'&&/^(?:0|[1-9]\d{0,127})$/.test(value);
const ratio=value=>value===null||typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
const percentile=value=>value===null||typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER;
const fail=(code,status=503)=>{throw Object.assign(new Error(status===400?'Invalid historical analytics query':status===429?'Historical analytics busy':'Historical analytics unavailable'),{code,status,...(status===429?{retryAfter:1}:{})});};

// This is a private runtime setting. Paths refer to dedicated local files;
// there is no caller-supplied executable argument, remote command or SQL.
export function validateHistoricalAnalyticsConfig(value){
 const fields=['version','engine','expectedReceiverId','ssh','local','timeoutMs','minIntervalMs'];
 if(!own(value,fields,['version','engine','expectedReceiverId'])||value.version!==1||value.engine!=='duckdb'||!UUID.test(value.expectedReceiverId||''))fail('ANALYTICS_CONFIG');
 if(Boolean(value.local)===Boolean(value.ssh))fail('ANALYTICS_CONFIG');
 const local=value.local;if(local&&(!own(local,['python','script','config'])||Object.values(local).some(v=>!absolute(v))))fail('ANALYTICS_CONFIG');
 const ssh=value.ssh;
 if(!local&&(!own(ssh,['executable','host','port','user','identityFile','knownHostsFile'],['executable','host','user','identityFile','knownHostsFile'])||!absolute(ssh.executable)||!sshFile(ssh.identityFile)||!sshFile(ssh.knownHostsFile)||typeof ssh.host!=='string'||ssh.host.length>253||!/^\w[\w.:-]*$/.test(ssh.host)||typeof ssh.user!=='string'||!/^[_a-zA-Z][_a-zA-Z0-9.-]{0,63}$/.test(ssh.user)||!integer(ssh.port??22,1,65535)))fail('ANALYTICS_CONFIG');
 const timeoutMs=value.timeoutMs??20000,minIntervalMs=value.minIntervalMs??1000;
 if(!integer(timeoutMs,50,30000)||!integer(minIntervalMs,250,60000))fail('ANALYTICS_CONFIG');
 return Object.freeze({version:1,engine:'duckdb',expectedReceiverId:value.expectedReceiverId,...(local?{local:Object.freeze({...local})}:{ssh:Object.freeze({...ssh,port:ssh.port??22})}),timeoutMs,minIntervalMs});
}

async function checkedPath(file,{executable=false}={}){
 if(!absolute(file))fail('ANALYTICS_CONFIG');
 const stat=await fs.lstat(file),real=path.resolve(await fs.realpath(file)),resolved=path.resolve(file),same=process.platform==='win32'?real.toLowerCase()===resolved.toLowerCase():real===resolved;
 if(!stat.isFile()||stat.isSymbolicLink()||!same||stat.size<1||stat.size>(executable?536870912:65536))fail('ANALYTICS_CONFIG');
 if(process.platform!=='win32'&&(stat.uid!==process.getuid()&&stat.uid!==0||(stat.mode&0o022)!==0||executable&&(stat.mode&0o111)===0))fail('ANALYTICS_CONFIG');
}

export async function checkHistoricalAnalyticsFiles(config){
 try{
  if(config.local){await checkedPath(config.local.python,{executable:true});await checkedPath(config.local.script);await checkedPath(config.local.config);const bytes=await readPrivateKeyFile(config.local.config,{maxBytes:65536});bytes.fill(0);return;}
  await checkedPath(config.ssh.executable,{executable:true});
  // Reuse the bounded owner-private POSIX/Windows ACL check. Key bytes never
  // leave this function and are overwritten immediately after the check.
  for(const file of [config.ssh.identityFile,config.ssh.knownHostsFile]){
   await checkedPath(file);const bytes=await readPrivateKeyFile(file,{maxBytes:65536});bytes.fill(0);
  }
 }catch{fail('ANALYTICS_CONFIG');}
}

export function validateHistoricalQuery(value,options={}){
 const fields=['version','report','fromDay','toDay','allowedHostIds','hostId','project','source','limit'];
 if(!own(value,fields,['report','fromDay','toDay'])||value.version!==undefined&&value.version!==1||!['daily','responses'].includes(value.report)||!day(value.fromDay)||!day(value.toDay))fail('ANALYTICS_QUERY',400);
 const span=(Date.parse(value.toDay)-Date.parse(value.fromDay))/86400000;
 if(span<0||span>=HISTORICAL_ANALYTICS_LIMITS.maxDays||value.hostId!==undefined&&!label(value.hostId)||value.project!==undefined&&!label(value.project)||value.report==='daily'&&(!['session-deltas','account-daily'].includes(value.source)||value.source==='account-daily'&&value.project!==undefined)||value.report==='responses'&&value.source!==undefined)fail('ANALYTICS_QUERY',400);
 const limit=value.limit??100;if(!integer(limit,1,HISTORICAL_ANALYTICS_LIMITS.maxRows))fail('ANALYTICS_QUERY',400);
 const allowedHostIds=Object.hasOwn(options,'allowedHostIds')?options.allowedHostIds:value.allowedHostIds;
 if(allowedHostIds!==undefined&&(!Array.isArray(allowedHostIds)||allowedHostIds.length>HISTORICAL_ANALYTICS_LIMITS.maxHosts||allowedHostIds.some(v=>!label(v))||new Set(allowedHostIds).size!==allowedHostIds.length))fail('ANALYTICS_QUERY',400);
 return {version:1,report:value.report,fromDay:value.fromDay,toDay:value.toDay,...(allowedHostIds===undefined?{}:{allowedHostIds:[...allowedHostIds]}),...(value.hostId===undefined?{}:{hostId:value.hostId}),...(value.project===undefined?{}:{project:value.project}),...(value.source===undefined?{}:{source:value.source}),limit};
}

export function historicalQueryFromParams(params){
 const allowed=['report','fromDay','toDay','hostId','project','source','limit'],value={};
 for(const key of params.keys()){
  if(!allowed.includes(key)||params.getAll(key).length!==1||!params.get(key)||params.get(key).length>256)fail('ANALYTICS_QUERY',400);
  value[key]=params.get(key);
 }
 if(Object.hasOwn(value,'limit')){if(!/^[1-9]\d{0,3}$/.test(value.limit))fail('ANALYTICS_QUERY',400);value.limit=Number(value.limit);}
 return validateHistoricalQuery(value);
}

// JSON.parse alone silently accepts duplicate keys. Scan structure first so a
// malformed engine document cannot select different values in different tools.
export function parseHistoricalJson(raw,maxBytes=HISTORICAL_ANALYTICS_LIMITS.responseBytes){
 if(Buffer.isBuffer(raw)){try{raw=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{fail('ANALYTICS_RESPONSE');}}
 if(typeof raw!=='string'||Buffer.byteLength(raw)>maxBytes)fail('ANALYTICS_RESPONSE');
 let index=0,nodes=0;
 const whitespace=()=>{while(/[\t\r\n ]/.test(raw[index]??'!'))index++;};
 const string=()=>{const start=index++;while(index<raw.length){const next=raw[index++];if(next==='"'){try{return JSON.parse(raw.slice(start,index));}catch{fail('ANALYTICS_RESPONSE');}}if(next==='\\')index++;}fail('ANALYTICS_RESPONSE');};
 const value=depth=>{
  if(depth>16||++nodes>100000)fail('ANALYTICS_RESPONSE');whitespace();const ch=raw[index];
  if(ch==='"'){string();return;}
  if(ch==='{'||ch==='['){const object=ch==='{',end=object?'}':']',keys=new Set();index++;whitespace();if(raw[index]===end){index++;return;}
   for(;;){if(object){whitespace();if(raw[index]!=='"')fail('ANALYTICS_RESPONSE');const key=string();if(keys.has(key))fail('ANALYTICS_RESPONSE');keys.add(key);whitespace();if(raw[index++]!==':')fail('ANALYTICS_RESPONSE');}value(depth+1);whitespace();if(raw[index]===end){index++;return;}if(raw[index++]!==',')fail('ANALYTICS_RESPONSE');}
  }
  const match=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(index));if(!match)fail('ANALYTICS_RESPONSE');index+=match[0].length;
 };
 value(0);whitespace();if(index!==raw.length)fail('ANALYTICS_RESPONSE');
 try{return JSON.parse(raw);}catch{fail('ANALYTICS_RESPONSE');}
}

const dailyMetrics=['input','cached','uncached','output','total'],responseMetrics=['input','cached','cacheWrite','output','reasoning','total'],ratioFields=['cacheHit','reasoningShare','newInputFraction'];
function metricGroup(values,known,metrics,records){
 if(!own(values,metrics)||!own(known,metrics))return false;
 return metrics.every(k=>decimal(values[k])&&integer(known[k],0,records)&&(known[k]===0)===(values[k]===null));
}

export function validateHistoricalResponse(value,{request,expectedReceiverId}={}){
 const query=validateHistoricalQuery(request),fields=['version','engine','engineVersion','receiverId','report','generatedAt','coverage','rows'];
 if(!own(value,fields)||value.version!==1||value.engine!=='duckdb'||typeof value.engineVersion!=='string'||!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value.engineVersion)||value.engineVersion.length>64||!UUID.test(value.receiverId||'')||expectedReceiverId!==undefined&&value.receiverId!==expectedReceiverId||value.report!==query.report||!timestamp(value.generatedAt)||!Array.isArray(value.rows)||value.rows.length>query.limit)fail('ANALYTICS_RESPONSE');
 const coverage=value.coverage,counts=['projectedSegments','pendingSegments','projectedItems','archiveItems','matchedRows','returnedRows','conflictRows','excludedRows'];
 if(!own(coverage,['completeHistory','source','aggregation','headReconstruction',...counts,'lastProjectedAt','truncated'])||coverage.completeHistory!==false||coverage.source!=='verified-archive-projection'||coverage.aggregation!=='known-subtotals'||coverage.headReconstruction!=='unavailable'||counts.some(k=>!integer(coverage[k]))||coverage.lastProjectedAt!==null&&!timestamp(coverage.lastProjectedAt)||coverage.returnedRows!==value.rows.length||coverage.matchedRows<coverage.returnedRows||coverage.truncated!==(coverage.matchedRows>coverage.returnedRows))fail('ANALYTICS_RESPONSE');
 const groups=new Set();
 for(const row of value.rows){
  if(!row||!label(row.hostId)||!nullableLabel(row.project)||query.allowedHostIds!==undefined&&!query.allowedHostIds.includes(row.hostId)||query.hostId!==undefined&&query.hostId!==row.hostId||query.project!==undefined&&query.project!==row.project)fail('ANALYTICS_RESPONSE');
  let group;
  if(query.report==='daily'){
   if(!own(row,['day','hostId','project','accountIdentity','source','records','values','known'])||!day(row.day)||row.day<query.fromDay||row.day>query.toDay||row.source!==query.source||!(row.accountIdentity===null||row.accountIdentity==='unlinked'||typeof row.accountIdentity==='string'&&/^[a-f0-9]{64}$/.test(row.accountIdentity))||!integer(row.records)||!metricGroup(row.values,row.known,dailyMetrics,row.records))fail('ANALYTICS_RESPONSE');
   group=JSON.stringify([row.day,row.hostId,row.project,row.accountIdentity,row.source]);
  }else{
   const rowCounts=['responseCount','duplicateRows','conflictRows','identityMissingRows','excludedRows'];
   if(!own(row,['hostId','project',...rowCounts,'totals','known','ratios','ratioCoverage','percentiles'])||rowCounts.some(k=>!integer(row[k]))||!metricGroup(row.totals,row.known,responseMetrics,row.responseCount)||!own(row.ratios,ratioFields)||ratioFields.some(k=>!ratio(row.ratios[k]))||!own(row.ratioCoverage,ratioFields)||!own(row.percentiles,['totalP50','totalP95','outputP50','outputP95'])||Object.values(row.percentiles).some(v=>!percentile(v)))fail('ANALYTICS_RESPONSE');
   for(const key of ratioFields){const c=row.ratioCoverage[key];if(!own(c,['numerator','denominator','comparableRows','excludedRows'])||!decimal(c.numerator)||!decimal(c.denominator)||!integer(c.comparableRows,0,row.responseCount)||!integer(c.excludedRows)||c.comparableRows===0&&(c.numerator!==null||c.denominator!==null||row.ratios[key]!==null)||c.comparableRows>0&&(c.numerator===null||c.denominator===null)||c.denominator==='0'&&row.ratios[key]!==null)fail('ANALYTICS_RESPONSE');}
   group=JSON.stringify([row.hostId,row.project]);
  }
  if(groups.has(group))fail('ANALYTICS_RESPONSE');groups.add(group);
 }
 if(Buffer.byteLength(JSON.stringify(value))>HISTORICAL_ANALYTICS_LIMITS.responseBytes)fail('ANALYTICS_RESPONSE');return value;
}

export function historicalSshArguments(config){
 const empty=process.platform==='win32'?'NUL':'/dev/null',knownHosts=process.platform==='win32'?config.ssh.knownHostsFile.replaceAll('\\','/'):config.ssh.knownHostsFile;
 return ['-T','-F',empty,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes','-o','IdentityAgent=none','-o','PreferredAuthentications=publickey','-o','PasswordAuthentication=no','-o','KbdInteractiveAuthentication=no','-o','GSSAPIAuthentication=no','-o','HostbasedAuthentication=no','-o','ForwardAgent=no','-o','ForwardX11=no','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no','-o','ControlMaster=no','-o','ControlPath=none','-o','ControlPersist=no','-o','ProxyCommand=none','-o','ProxyJump=none','-o','VerifyHostKeyDNS=no','-o','UpdateHostKeys=no','-o',`GlobalKnownHostsFile=${empty}`,'-o','ConnectTimeout=5','-o','ConnectionAttempts=1','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-o',`UserKnownHostsFile="${knownHosts}"`,'-i',config.ssh.identityFile,'-p',String(config.ssh.port),'-l',config.ssh.user,'--',config.ssh.host,'analytics-query'];
}

export async function sendHistoricalOverSsh({config,request,signal},dependencies={}){
 const query=validateHistoricalQuery(request);if(!Array.isArray(query.allowedHostIds))fail('ANALYTICS_QUERY',400);
 const payload=JSON.stringify(query)+'\n';if(Buffer.byteLength(payload)>HISTORICAL_ANALYTICS_LIMITS.requestBytes)fail('ANALYTICS_QUERY',400);
 return new Promise((resolve,reject)=>{
  let child,settled=false,errorCode=null,size=0,stderrSize=0,timer,killTimer;const chunks=[];
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const terminate=code=>{if(settled||errorCode)return;errorCode=code;chunks.length=0;child?.kill('SIGTERM');killTimer=setTimeout(()=>child?.kill('SIGKILL'),250);killTimer.unref();};
  const abort=()=>terminate('ANALYTICS_ABORTED');
  if(signal?.aborted){try{fail('ANALYTICS_ABORTED');}catch(error){finish(error);}return;}
  try{child=(dependencies.spawn??spawn)(config.local?config.local.python:config.ssh.executable,config.local?['-I','-B',config.local.script,'--config',config.local.config,'--query']:historicalSshArguments(config),{stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});}catch{try{fail('ANALYTICS_TRANSPORT');}catch(error){finish(error);}return;}
  signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>terminate('ANALYTICS_TIMEOUT'),config.timeoutMs);
  child.on('error',()=>{
   // Spawn failure has no owned process. Later errors may mean kill(EPERM),
   // not exit: retain the physical request/admission slot until actual close.
   // Keep listening through SIGKILL escalation, which can fail independently.
   if(child.pid){terminate('ANALYTICS_TRANSPORT');return;}
   try{fail('ANALYTICS_TRANSPORT');}catch(error){finish(error);}
  });
  child.stdout.on('data',chunk=>{if(errorCode||settled)return;size+=chunk.length;if(size>HISTORICAL_ANALYTICS_LIMITS.responseBytes)terminate('ANALYTICS_RESPONSE');else chunks.push(chunk);});
  child.stderr.on('data',chunk=>{stderrSize+=chunk.length;if(stderrSize>HISTORICAL_ANALYTICS_LIMITS.stderrBytes)terminate('ANALYTICS_TRANSPORT');});
  child.stdin.on('error',()=>terminate('ANALYTICS_TRANSPORT'));
  child.once('close',code=>{if(errorCode||code!==0){try{fail(errorCode??'ANALYTICS_TRANSPORT');}catch(error){finish(error);}}else finish(null,Buffer.concat(chunks,size));});
  child.stdin.end(payload);
 });
}

async function requestHistoricalUpstream(configuration,request,{signal,validate}){
 let base;try{base=new URL(configuration.url);}catch{fail('ANALYTICS_UNAVAILABLE');}
 if(base.username||base.password||base.protocol!=='https:'&&!(base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname)))fail('ANALYTICS_UNAVAILABLE');
 const params=new URLSearchParams();for(const key of ['report','fromDay','toDay','hostId','project','source','limit'])if(request[key]!==undefined)params.set(key,String(request[key]));
 const url=new URL('/api/analytics/history?'+params,base);let ca;
 if(configuration.caFile){const stat=await fs.stat(configuration.caFile);if(!stat.isFile()||stat.size>1048576)fail('ANALYTICS_UNAVAILABLE');ca=await fs.readFile(configuration.caFile,{signal});if(ca.length>1048576)fail('ANALYTICS_UNAVAILABLE');}
 validate?.();
 return new Promise((resolve,reject)=>{
  let response,settled=false;const finish=(error,value)=>{if(settled)return;settled=true;if(error){response?.destroy();connection.destroy();reject(error);}else resolve(value);};
  const connection=(url.protocol==='https:'?https:http).request(url,{method:'GET',ca,rejectUnauthorized:true,signal,headers:{authorization:'Bearer '+configuration.token}},res=>{
   response=res;let bytes=0;const chunks=[];
   // Refuse from the status alone; consuming an untrusted error representation
   // must never turn an authoritative authentication denial into another status.
   if(res.statusCode!==200){const status=[400,401,403,405,429,503].includes(res.statusCode)?res.statusCode:503;finish(Object.assign(new Error(status===401?'Viewer authentication required':status===403?'Administrator access required':status===429?'Historical analytics busy':'Historical analytics unavailable'),{status,code:'ANALYTICS_UPSTREAM',...(status===429?{retryAfter:1}:{})}));return;}
   if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'||res.headers['content-length']!==undefined&&(!/^\d+$/.test(res.headers['content-length'])||Number(res.headers['content-length'])>HISTORICAL_ANALYTICS_LIMITS.responseBytes)){finish(new Error('Invalid historical analytics upstream'));return;}
   res.on('error',error=>finish(error));res.on('data',chunk=>{bytes+=chunk.length;if(bytes>HISTORICAL_ANALYTICS_LIMITS.responseBytes)finish(new Error('Historical analytics upstream exceeds bound'));else chunks.push(chunk);});
   res.on('end',()=>{
    if(settled)return;
    try{const result=parseHistoricalJson(Buffer.concat(chunks,bytes));validate?.();finish(null,result);}catch(error){finish(error);}
   });
  });
  connection.on('error',error=>finish(error));connection.end();
 });
}

// One actual in-flight operation, no queue. If an injected or broken transport
// ignores cancellation, the HTTP timeout still fires and its slot stays held
// until that operation settles; a timeout cannot create overlapping processes.
export function createHistoricalAnalytics(configuration,{transport=sendHistoricalOverSsh,checkFiles=checkHistoricalAnalyticsFiles,now=()=>performance.now(),upstream}={}){
 let busy=false,nextAt=-Infinity;
 return {async query(input,{validate,signal}={}){
  const request=validateHistoricalQuery(input);let config;
  if(upstream)config={timeoutMs:30000,minIntervalMs:1000};
  else{if(!configuration)fail('ANALYTICS_UNAVAILABLE');config=validateHistoricalAnalyticsConfig(configuration);if(!Array.isArray(request.allowedHostIds))fail('ANALYTICS_QUERY',400);}
  validate?.();if(signal?.aborted)fail('ANALYTICS_ABORTED');const admittedAt=now();if(busy||admittedAt<nextAt)fail('ANALYTICS_BUSY',429);busy=true;nextAt=admittedAt+config.minIntervalMs;
  const controller=new AbortController();let timer,rejectCancelled;
  const cancelled=new Promise((_,reject)=>rejectCancelled=reject),abort=()=>{controller.abort();try{fail('ANALYTICS_ABORTED');}catch(error){rejectCancelled(error);}};
  signal?.addEventListener('abort',abort,{once:true});
  const physical=(async()=>{try{if(upstream)return await requestHistoricalUpstream(upstream,request,{signal:controller.signal,validate});await checkFiles(config);if(controller.signal.aborted)fail('ANALYTICS_ABORTED');validate?.();const raw=await transport({config,request,signal:controller.signal});if(controller.signal.aborted)fail('ANALYTICS_ABORTED');return parseHistoricalJson(raw);}finally{busy=false;}})();
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();try{fail('ANALYTICS_TIMEOUT');}catch(error){reject(error);}},config.timeoutMs);});
  try{const result=await Promise.race([physical,deadline,cancelled]);validate?.();return validateHistoricalResponse(result,{request,expectedReceiverId:upstream?undefined:config.expectedReceiverId});}
  catch(error){if([400,401,403,405,429].includes(error.status))throw error;fail(['ANALYTICS_CONFIG','ANALYTICS_RESPONSE','ANALYTICS_TIMEOUT','ANALYTICS_UNAVAILABLE'].includes(error.code)?error.code:'ANALYTICS_UNAVAILABLE');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }};
}
