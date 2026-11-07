#!/usr/bin/env node
// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {validateHistoricalQuery,validateHistoricalResponse} from '../lib/historical-analytics.mjs';

const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const error=code=>Object.assign(new Error('Read-only query unavailable'),{queryCode:code});
const requireThat=(v,code='INVALID_ARGUMENT')=>{if(!v)throw error(code);};
const strict=(v,fields)=>requireThat(object(v)&&Object.keys(v).every(k=>fields.includes(k)));
const text=(v,max=256)=>typeof v==='string'&&v.length>0&&v.length<=max&&v.isWellFormed()&&!/[\x00-\x1f\x7f\\/@]|(?:\d{1,3}\.){3}\d{1,3}|^[A-Za-z]:/.test(v)?v:null;
const identifier=v=>text(v)&&/^[A-Za-z0-9._:-]+$/.test(v)?v:null;
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(v)&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
const choice=(v,allowed)=>allowed.includes(v)?v:null;
const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=Number.MAX_SAFE_INTEGER?v:null;
const fields=(v,names,convert=count)=>Object.fromEntries(names.map(k=>[k,convert(v?.[k])]));
const STATUS=['available','unavailable','restricted','multiple','stale','partial','observed','idle','baseline','online','disconnected','disabled','expired','not connected'];
const COVERAGE={scope:'authenticated viewer authorization',storage:'hub hot cache',completeHistory:false,nasArchiveQueried:false};
const WINDOWS_POWERSHELL='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const ACL_SCRIPT=String.raw`$ErrorActionPreference='Stop'
try {
 $request=[Console]::In.ReadToEnd() | ConvertFrom-Json
 if (@($request.PSObject.Properties.Name | Where-Object { $_ -notin @('path','privateMode') }).Count -or $request.path -isnot [string] -or $request.privateMode -isnot [bool]) { throw 'Refused' }
 $acl=[IO.File]::GetAccessControl($request.path)
 $current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $trusted=@($current,'S-1-5-18','S-1-5-32-544')
 if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'Refused' }
 $writes=([long][Security.AccessControl.FileSystemRights]'WriteData,AppendData,WriteExtendedAttributes,WriteAttributes,Delete,ChangePermissions,TakeOwnership') -bor 0x40000000 -bor 0x10000000
 foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted -and ($request.privateMode -or (($rule.FileSystemRights -band $writes) -ne 0))) { throw 'Refused' }
 }
 [Console]::Out.Write('PRIVATE_FILE_ACL_OK')
} catch { [Console]::Out.Write('PRIVATE_FILE_ACL_REFUSED'); exit 1 }`;

async function windowsPermissions(file,privateMode){
 return new Promise((resolve,reject)=>{
  let child,output='',bytes=0,settled=false;const finish=ok=>{if(settled)return;settled=true;clearTimeout(timer);ok?resolve():reject(error('PRIVATE_FILE_PERMISSIONS_UNQUALIFIED'));};
  try{child=spawn(WINDOWS_POWERSHELL,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ACL_SCRIPT,'utf16le').toString('base64')],{stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});}catch{reject(error('PRIVATE_FILE_PERMISSIONS_UNQUALIFIED'));return;}
  // Cold PowerShell startup can exceed two seconds on a busy Windows host.
  // Keep the ACL check bounded and fail closed without rejecting a private file.
  const timer=setTimeout(()=>{child.kill('SIGTERM');finish(false);},5000);
  child.on('error',()=>finish(false));child.stdin.on('error',()=>finish(false));child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>4096){child.kill('SIGTERM');finish(false);}else output+=chunk.toString('utf8');});child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>4096){child.kill('SIGTERM');finish(false);}});child.on('close',code=>finish(code===0&&output==='PRIVATE_FILE_ACL_OK'));child.stdin.end(JSON.stringify({path:file,privateMode}));
 });
}
async function checkedFile(file,{privateMode=true,maxBytes=16384}={}){
 requireThat(typeof file==='string'&&file.length<=1024&&path.isAbsolute(file)&&!/[\x00-\x1f\x7f]/.test(file)&&!/^(?:\\\\|\/\/)/.test(file),'CONFIG_REFUSED');
 const resolved=path.resolve(file),root=path.parse(resolved).root;let current=root;
 for(const piece of path.relative(root,resolved).split(path.sep)){current=path.join(current,piece);const stat=await fs.lstat(current);requireThat(!stat.isSymbolicLink(),'CONFIG_REFUSED');}
 const before=await fs.lstat(resolved);requireThat(before.isFile()&&before.size>0&&before.size<=maxBytes,'CONFIG_REFUSED');
 if(process.platform==='win32')await windowsPermissions(resolved,privateMode);
 const handle=await fs.open(resolved,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const stat=await handle.stat();requireThat(stat.isFile()&&stat.size>0&&stat.size<=maxBytes&&stat.ino===before.ino&&stat.dev===before.dev,'CONFIG_REFUSED');
  if(process.platform!=='win32'){requireThat(privateMode?stat.uid===process.getuid()&&(stat.mode&0o077)===0:[process.getuid(),0].includes(stat.uid)&&(stat.mode&0o022)===0,'PRIVATE_FILE_PERMISSIONS_UNQUALIFIED');}
  const buffer=Buffer.alloc(maxBytes+1);let used=0;while(used<buffer.length){const {bytesRead}=await handle.read(buffer,used,buffer.length-used,null);if(!bytesRead)break;used+=bytesRead;}requireThat(used<=maxBytes,'CONFIG_REFUSED');return buffer.subarray(0,used);
 }finally{await handle.close();}
}
async function configurationFrom(file){
 try{
  requireThat(typeof file==='string'&&!/^(?:auth\.json|credentials?(?:\..*)?|tokens?(?:\..*)?|id_(?:rsa|ed25519)(?:\.pub)?)$/i.test(path.basename(file)),'CONFIG_REFUSED');
  const c=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await checkedFile(file)));requireThat(object(c)&&Object.keys(c).every(k=>['version','origin','token','expectedInstanceId','caFile'].includes(k))&&c.version===1,'CONFIG_REFUSED');
  requireThat(typeof c.origin==='string'&&c.origin.length<=512&&typeof c.token==='string'&&/^[\x21-\x7e]{32,4096}$/.test(c.token)&&typeof c.expectedInstanceId==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(c.expectedInstanceId),'CONFIG_REFUSED');
  const u=new URL(c.origin);requireThat(u.origin===c.origin&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'&&!u.hostname.includes('*')&&(u.protocol==='https:'||u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)),'CONFIG_REFUSED');
  let ca;if(c.caFile!==undefined&&c.caFile!==null){ca=await checkedFile(c.caFile,{privateMode:false,maxBytes:1048576});requireThat(ca.includes('-----BEGIN CERTIFICATE-----')&&!ca.includes('PRIVATE KEY'),'CONFIG_REFUSED');}
  return {origin:u.origin,token:c.token,expectedInstanceId:c.expectedInstanceId,ca};
 }catch(e){throw error(e.queryCode??'CONFIG_REFUSED');}
}

const scopeProperties={hostId:{type:'string',pattern:'^[a-z0-9][-a-z0-9]{0,63}$'},project:{type:'string',minLength:1,maxLength:160},sessionId:{type:'string',minLength:1,maxLength:200}};
export const QUERY_DEFINITIONS=Object.freeze([
 {name:'summary',tool:'codexcontrol_summary',description:'Read scoped numeric usage, quotas and capture coverage. Details adds bounded derived analytics.',inputSchema:{type:'object',properties:{details:{type:'boolean'}},additionalProperties:false}},
 {name:'sources',tool:'codexcontrol_sources',description:'Read authorized source identities, roles, status and capture freshness, excluding addresses and paths.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'events',tool:'codexcontrol_events',description:'Read at most100 authorized hot-cache events after a durable cursor; excludes raw output and source paths.',inputSchema:{type:'object',properties:{...scopeProperties,after:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},epoch:{type:'string',minLength:1,maxLength:128},limit:{type:'integer',minimum:1,maximum:100}},additionalProperties:false}},
 {name:'usage-records',tool:'codexcontrol_usage_records',description:'Read bounded recent typed usage observations from the existing hot-cache details API, not the NAS archive.',inputSchema:{type:'object',properties:{...scopeProperties,limit:{type:'integer',minimum:1,maximum:100}},additionalProperties:false}},
 {name:'history-analytics',tool:'codexcontrol_history_analytics',description:'Read on-demand archived daily reports or native-response distributions through the optional historical engine. Requires unrestricted administrator access. Results are partial captured history with explicit known-subtotal, conflict and projection-lag evidence.',inputSchema:{type:'object',properties:{report:{type:'string',enum:['daily','responses']},fromDay:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'},toDay:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'},hostId:scopeProperties.hostId,project:scopeProperties.project,source:{type:'string',enum:['session-deltas','account-daily']},limit:{type:'integer',minimum:1,maximum:1000}},required:['report','fromDay','toDay'],additionalProperties:false}}
]);
export function validateQueryArguments(name,args={}){
 const definition=QUERY_DEFINITIONS.find(d=>d.name===name);requireThat(!!definition);strict(args,Object.keys(definition.inputSchema.properties));
 if(name==='history-analytics'){try{const {version,...query}=validateHistoricalQuery(args);return query;}catch{throw error('INVALID_ARGUMENT');}}
 if(Object.hasOwn(args,'details'))requireThat(typeof args.details==='boolean');
 if(Object.hasOwn(args,'limit'))requireThat(count(args.limit)!==null&&args.limit>=1&&args.limit<=100);
 if(Object.hasOwn(args,'after'))requireThat(count(args.after)!==null);
 if(Object.hasOwn(args,'epoch'))requireThat(identifier(args.epoch)&&args.epoch.length<=128);
 if(Object.hasOwn(args,'hostId'))requireThat(typeof args.hostId==='string'&&/^[a-z0-9][-a-z0-9]{0,63}$/.test(args.hostId));
 if(Object.hasOwn(args,'project'))requireThat(text(args.project,160)!==null);
 if(Object.hasOwn(args,'sessionId'))requireThat(identifier(args.sessionId)&&args.sessionId.length<=200);
 return {...args};
}
function queryPath(name,args){
 if(name==='history-analytics')return '/api/analytics/history?'+new URLSearchParams(Object.entries(args).map(([k,v])=>[k,String(v)]));
 const route=name==='sources'?'/api/snapshot':name==='events'?'/api/events':'/api/account/usage',params=new URLSearchParams();
 if(name==='sources')params.set('metadata','1');if(name==='usage-records'||args.details===true)params.set('details','1');
 if(name==='events'){params.set('after',String(args.after??0));params.set('limit',String(args.limit??50));if(args.epoch)params.set('epoch',args.epoch);}
 for(const key of ['hostId','project','sessionId'])if(args[key]!==undefined)params.set(key,args[key]);return route+(params.size?'?'+params:'');
}
async function getJSON(c,route,{authenticated=false,deadline,budget,maximum=2097152}={}){
 const url=new URL(route,c.origin);requireThat(url.origin===c.origin,'QUERY_REFUSED');const remaining=deadline-performance.now();if(remaining<=0)throw error('QUERY_TIMEOUT');
 return new Promise((resolve,reject)=>{
  let settled=false,timer;const finish=(e,value)=>{if(settled)return;settled=true;clearTimeout(timer);e?reject(e):resolve(value);};
  const headers={accept:'application/json','accept-encoding':'identity',host:url.host};if(authenticated)headers.authorization='Bearer '+c.token;
  const options={method:'GET',headers,agent:false,rejectUnauthorized:true,ca:c.ca};if(url.hostname==='localhost'){options.hostname='127.0.0.1';if(url.protocol==='https:')options.servername='localhost';}
  const req=(url.protocol==='https:'?https:http).request(url,options,res=>{
   res.on('error',()=>finish(error('QUERY_UNAVAILABLE')));const code=res.statusCode;if(code!==200){finish(error(code===401?'AUTH_REQUIRED':code===403?'FORBIDDEN':code===429?'RATE_LIMITED':code>=300&&code<400?'REDIRECT_REFUSED':'QUERY_UNAVAILABLE'));res.destroy();return;}
   if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){finish(error('RESPONSE_INVALID'));res.destroy();return;}
   let bytes=0;const chunks=[];res.on('data',chunk=>{bytes+=chunk.length;budget.remaining-=chunk.length;if(bytes>maximum||budget.remaining<0){finish(error('RESPONSE_LIMIT'));req.destroy();}else chunks.push(Buffer.from(chunk));});res.on('aborted',()=>finish(error('QUERY_UNAVAILABLE')));res.on('end',()=>{if(settled)return;try{const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));requireThat(object(data),'RESPONSE_INVALID');finish(null,data);}catch{finish(error('RESPONSE_INVALID'));}});
  });timer=setTimeout(()=>{finish(error('QUERY_TIMEOUT'));req.destroy();},remaining);req.on('error',()=>finish(error('QUERY_UNAVAILABLE')));req.end();
 });
}

function windowOf(v){return v===null||!object(v)?null:{usedPercent:number(v.usedPercent),windowDurationMins:count(v.windowDurationMins),resetsAt:count(v.resetsAt)};}
function limitsOf(values){return (Array.isArray(values)?values:[]).slice(0,8).map(v=>({limitId:text(v.limitId,128),planType:text(v.planType,64),primary:windowOf(v.primary),secondary:windowOf(v.secondary),credits:object(v.credits)?{hasCredits:typeof v.credits.hasCredits==='boolean'?v.credits.hasCredits:null,unlimited:typeof v.credits.unlimited==='boolean'?v.credits.unlimited:null,balance:typeof v.credits.balance==='string'&&/^-?\d{1,24}(?:\.\d{1,12})?$/.test(v.credits.balance)?v.credits.balance:null,unit:'source-unspecified'}:null,spendControlReached:typeof v.spendControlReached==='boolean'?v.spendControlReached:null}));}
function ratioOf(v){return {value:number(v?.value),...fields(v,['numerator','denominator','comparableRows','excludedRows']),reason:choice(v?.reason,['numeric-overflow','no-comparable-denominator']),classification:'derived',method:'ratio-of-sums'};}
function analyticsOf(v){return !object(v)?null:{version:count(v.version),observedAt:date(v.observedAt),coverage:{...fields(v.coverage,['retainedRows','matchingRows','returnedRows','excludedRows','identityMissing','conflictingResponses']),truncated:v.coverage?.truncated===true},responses:{status:choice(v.responses?.status,STATUS),responseCount:count(v.responses?.responseCount),totals:fields(v.responses?.totals,['input','cached','cacheWrite','output','reasoning','total']),ratios:Object.fromEntries(['cacheHit','reasoningShare','newInputFraction'].map(k=>[k,ratioOf(v.responses?.ratios?.[k])]))}};}
const counters=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
function sampleOf(v){
 const result={...fields(v,['source_offset','source_ms','received_ms','inherited_history','reported_mask','provider_reported_mask','synthesized_mask',...counters])};
 for(const key of ['sample_key','source_id','source_record_key'])result[key]=typeof v?.[key]==='string'&&/^[a-f0-9]{64}$/.test(v[key])?v[key]:null;
 for(const key of ['host_id','session_id','native_thread_id','native_session_id','native_turn_id','native_root_turn_id','native_response_id','context_turn_id','forked_from_id'])result[key]=identifier(v?.[key]);
 for(const key of ['source_version','project','context_provider','context_model','context_effort','context_service_tier','context_speed'])result[key]=text(v?.[key],key==='project'?256:128);
 result.source_kind=choice(v?.source_kind,['token_count','token_usage_record']);result.usage_scope=choice(v?.usage_scope,['thread-total','last-response','response','turn-total']);result.time_basis=choice(v?.time_basis,['source','receipt']);result.source_role=choice(v?.source_role,['codex-source','execution-target','execution-job','unknown']);result.accounting_class=choice(v?.accounting_class,['candidate','fork-excluded','execution-excluded','unknown']);result.producing_model=null;return result;
}
function projectResult(name,value,args){
 if(name==='history-analytics'){try{return validateHistoricalResponse(value,{request:{version:1,...args}});}catch{throw error('RESPONSE_INVALID');}}
 const result={version:1,query:name,observedAt:date(value.observedAt),coverage:{...COVERAGE}};
 if(name==='sources'){requireThat(Array.isArray(value.hosts)&&value.hosts.length<=64,'RESPONSE_INVALID');result.sources=value.hosts.map(h=>({hostId:identifier(h.id),role:choice(h.role,['hub','gateway','codex-source','execution-target']),deviceClass:choice(h.deviceClass,['laptop','workstation','rack-server','raspberry-pi','edge','cloud','unknown']),status:choice(h.status,STATUS),receivedAt:date(h.receivedAt),sourceObservedAt:date(h.sourceObservedAt),numericUsage:object(h.coverage?.numericUsage)?{...fields(h.coverage.numericUsage,['sampleCount','heldFiles','invalidRecords','unscannedFiles']),backlogged:h.coverage.numericUsage.backlogged===true}:null}));return result;}
 if(name==='events'){
  requireThat(Array.isArray(value.events)&&value.events.length<=100,'RESPONSE_INVALID');Object.assign(result,fields(value,['latestSequence','retentionFloor','gapThrough','nextCursor']));result.epoch=identifier(value.epoch);result.caughtUp=value.caughtUp===true;result.gap=value.gap?{reason:choice(value.gap.reason,['retention','journal-changed','cursor-ahead']),...fields(value.gap,['requested','floor','through'])}:null;
  result.events=value.events.map(e=>({id:identifier(e.id),hostId:identifier(e.hostId),sessionId:identifier(e.sessionId),project:text(e.project),turnId:identifier(e.turnId),callId:identifier(e.callId),at:date(e.at),receivedAt:date(e.receivedAt),journalSequence:count(e.journalSequence),kind:choice(e.kind,['turn','complete','error','approval','resolution','operation','tool.start','tool.end','message','remote.start','remote.end','remote.progress']),category:choice(e.category,['command','edit','research','agent','tool']),outcome:choice(e.outcome,['observed','recorded','completed','failed','waiting','unverified','interrupted']),delivery:choice(e.delivery,['live','bootstrap','backfill']),...(e.kind==='operation'&&e.operationType==='context-compaction'?{operationType:'context-compaction'}:{})}));return result;
 }
 if(name==='usage-records'){const a=value.sampleAnalytics;result.analytics=analyticsOf(a);requireThat(a===undefined||object(a)&&Array.isArray(a.recent)&&a.recent.length<=100,'RESPONSE_INVALID');result.records=(a?.recent??[]).slice(0,args.limit??20).map(sampleOf);result.recordsTruncated=(a?.recent?.length??0)>result.records.length||a?.coverage?.truncated===true;result.paginationAvailable=false;return result;}
 const account=value.accountUsage,burn=value.burnUsage;result.accountUsage={status:choice(account?.status,STATUS),scope:'account-wide',observedAt:date(account?.observedAt),limitsObservedAt:date(account?.limitsObservedAt),usageObservedAt:date(account?.usageObservedAt),accountCount:count(account?.accountCount),summary:object(account?.summary)?fields(account.summary,['lifetimeTokens','peakDailyTokens','longestRunningTurnSec','currentStreakDays','longestStreakDays']):null,accounts:(Array.isArray(account?.accounts)?account.accounts:[]).slice(0,16).map(a=>({status:choice(a.status,STATUS),planType:text(a.planType,64),observedAt:date(a.observedAt),limitsObservedAt:date(a.limitsObservedAt),usageObservedAt:date(a.usageObservedAt),ordinaryUsageAllowed:typeof a.ordinaryUsageAllowed==='boolean'?a.ordinaryUsageAllowed:null,resetCreditsAvailable:count(a.rateLimitResetCredits?.availableCount),limits:limitsOf(a.limits)}))};
 result.burn={status:choice(burn?.status,STATUS),observedAt:date(burn?.observedAt),windowMs:count(burn?.windowMs),...fields(burn,['inputTokens','cachedInputTokens','uncachedInputTokens','outputTokens','totalTokens']),...fields(burn,['inputPerSecond','cachedInputPerSecond','uncachedInputPerSecond','outputPerSecond'],number),complete:false,classification:'sampled-counter-increases'};
 if(args.details)result.analytics=analyticsOf(value.sampleAnalytics);return result;
}

export async function createQueryClient(configFile,{clock=Date.now}={}){
 const c=await configurationFrom(configFile),attempts=[];let busy=false;
 return Object.freeze({async query(name,args={}){
  const valid=validateQueryArguments(name,args);if(busy)throw error('BUSY');const now=clock();while(attempts.length&&attempts[0]<=now-60000)attempts.shift();if(attempts.length>=10)throw error('RATE_LIMITED');attempts.push(now);busy=true;
  try{const deadline=performance.now()+(name==='history-analytics'?30000:6000),budget={remaining:2097152},identity=await getJSON(c,'/api/identity',{deadline,budget,maximum:8192});requireThat(identity.deploymentId===c.expectedInstanceId&&identity.readOnly===true&&identity.protocolVersion===1,'INSTANCE_IDENTITY_MISMATCH');const data=await getJSON(c,queryPath(name,valid),{authenticated:true,deadline,budget}),result=projectResult(name,data,valid);requireThat(performance.now()<=deadline,'QUERY_TIMEOUT');const encoded=JSON.stringify(result);requireThat(Buffer.byteLength(encoded)<=262144,'OUTPUT_LIMIT');requireThat(!encoded.includes(c.token)&&!encoded.includes(JSON.stringify(c.token).slice(1,-1)),'PRIVATE_OUTPUT_REFUSED');return result;}catch(e){throw error(e.queryCode??'QUERY_UNAVAILABLE');}finally{busy=false;}
 }});
}
export async function readSingleQuery(input){const chunks=[];let bytes=0;for await(const chunk of input){bytes+=chunk.length;if(bytes>32770)throw error('INPUT_LIMIT');chunks.push(Buffer.from(chunk));}let line=Buffer.concat(chunks);if(line.at(-1)===10)line=line.subarray(0,-1);if(line.at(-1)===13)line=line.subarray(0,-1);requireThat(line.length>0&&line.length<=32768&&!line.includes(10),'INPUT_LIMIT');try{const request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));strict(request,['query','arguments']);requireThat(typeof request.query==='string');const args=request.arguments===undefined?{}:request.arguments;validateQueryArguments(request.query,args);return {query:request.query,arguments:args};}catch(e){throw error(e.queryCode??'INVALID_ARGUMENT');}}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{requireThat(process.argv.length===3,'CONFIG_REFUSED');const request=await readSingleQuery(process.stdin),client=await createQueryClient(process.argv[2]);console.log(JSON.stringify(await client.query(request.query,request.arguments)));}catch(e){console.log(JSON.stringify({version:1,status:'error',code:e.queryCode??'QUERY_UNAVAILABLE'}));process.exitCode=1;}
}
