// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {TaskLabelReader} from './task-labels.mjs';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex').slice(0,28);
const safe=(value,max=120)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,max):null;
const iso=value=>Number.isFinite(typeof value==='number'?value:Date.parse(value))?new Date(value).toISOString():null;
const toolName=value=>safe(value,100)?.replace(/[^a-zA-Z0-9_.:/-]/g,'')||'tool';
const numeric=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const usage=value=>{if(!value||typeof value!=='object'||Array.isArray(value))return null;const entries=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'].filter(k=>Number.isSafeInteger(value[k])&&value[k]>=0).map(k=>[k,value[k]]);return entries.length?Object.fromEntries(entries):null;};
const fullHash=value=>crypto.createHash('sha256').update(value).digest('hex');
const usageCounterFields=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
const sourceObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const sourceText=(value,max=256)=>typeof value==='string'&&value.length>0&&value.length<=max&&value.isWellFormed()&&!/[\x00-\x1f\x7f]/.test(value)?value:null;
const sourceMilliseconds=value=>{
 if(typeof value!=='string'&&typeof value!=='number')return null;
 if(typeof value==='string'){const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);if(!m||+m[4]>23||+m[5]>59||+m[6]>59)return null;const day=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));if(day.getUTCFullYear()!==+m[1]||day.getUTCMonth()!==+m[2]-1||day.getUTCDate()!==+m[3])return null;}
 const n=typeof value==='number'?value:Date.parse(value);return Number.isSafeInteger(n)&&n>=0&&n<=8640000000000000?n:null;
};

function sourceContext(record,previous={},metadata={}){
 const result={turnId:sourceText(previous.turnId),provider:sourceText(previous.provider,128)??sourceText(metadata.model_provider,128),model:sourceText(previous.model,128),effort:sourceText(previous.effort,64),project:sourceText(previous.project)??sourceText(path.win32.basename(typeof metadata.cwd==='string'?metadata.cwd:''),256)};
 if(record?.type==='turn_context'&&sourceObject(record.payload)){
  const p=record.payload;result.turnId=sourceText(p.turn_id);result.model=sourceText(p.model,128);result.effort=sourceText(p.effort??p.reasoning_effort,64);
  if(typeof p.cwd==='string')result.project=sourceText(path.win32.basename(p.cwd),256);
 }
 return result;
}

// Numeric source evidence is separate from the presentation event tail. Context
// identifies the saved configuration at this line, never a producing model.
export function extractUsageSamples(record,{metadata={},context={},sourceId=null,sourceOffset=null}={}){
 if(!sourceObject(record)||!sourceObject(record.payload))return [];
 const p=record.payload,kind=record.type==='token_usage_record'?'token_usage_record':record.type==='event_msg'&&p.type==='token_count'?'token_count':null;
 if(!kind)return [];
 const sessionId=sourceText(metadata.id??metadata.session_id);if(!sessionId)return [];
 const sourceMs=sourceMilliseconds(record.timestamp),metadataMs=sourceMilliseconds(metadata.timestamp),forkedFrom=sourceText(metadata.forked_from_id),c=sourceContext(null,context,metadata);
 const groups=kind==='token_usage_record'?[['response',p.usage],['turn-total',p.turn_token_usage],['thread-total',p.thread_token_usage]]:[['thread-total',p.info?.total_token_usage],['last-response',p.info?.last_token_usage]];
 const base={session_id:sessionId,source_id:typeof sourceId==='string'&&/^[a-f0-9]{64}$/.test(sourceId)?sourceId:null,source_offset:Number.isSafeInteger(sourceOffset)&&sourceOffset>=0?sourceOffset:null,source_kind:kind,source_version:sourceText(metadata.cli_version,128),source_ms:sourceMs,time_basis:sourceMs===null?'receipt':'source',project:c.project??null,native_thread_id:sourceText(p.thread_id),native_session_id:sourceText(p.session_id),native_turn_id:sourceText(p.turn_id),native_root_turn_id:sourceText(p.root_turn_id),native_response_id:sourceText(p.response_id),context_turn_id:c.turnId??null,context_provider:c.provider??null,context_model:c.model??null,context_effort:c.effort??null,context_service_tier:null,context_speed:null,producing_provider:null,producing_model:null,producing_effort:null,producing_service_tier:null,producing_speed:null,forked_from_id:forkedFrom,inherited_history:forkedFrom===null?0:sourceMs===null||metadataMs===null?null:sourceMs<metadataMs?1:0,provider_reported_mask:0,synthesized_mask:0};
 const values=groups.filter(([,v])=>sourceObject(v)).map(([scope,value])=>{
  let mask=0;const counters=Object.fromEntries(usageCounterFields.map((field,i)=>{if(Object.hasOwn(value,field))mask|=1<<i;return [field,Number.isSafeInteger(value[field])&&value[field]>=0?value[field]:null];}));
  return {usage_scope:scope,...counters,reported_mask:mask};
 });
 if(!values.length)return [];
 const recordKey=fullHash(JSON.stringify([base,values]));
 return values.map(value=>({...base,source_record_key:recordKey,...value}));
}

const cursorContextFields={turnId:256,provider:128,model:128,effort:64,project:256};
export function validateUsageCursor(value){
 if(value===undefined||value===null)return {version:1,lastFileKey:null,files:{}};
 if(!sourceObject(value)||Object.keys(value).some(k=>!['version','lastFileKey','files'].includes(k))||value.version!==1||!sourceObject(value.files)||Object.keys(value.files).length>20000||value.lastFileKey!==null&&!/^[a-f0-9]{64}$/.test(value.lastFileKey))throw new Error('Invalid numeric usage cursor');
 for(const [key,entry]of Object.entries(value.files)){
  if(!/^[a-f0-9]{64}$/.test(key)||!sourceObject(entry)||Object.keys(entry).some(k=>!['generation','baseGeneration','offset','size','statKey','anchorHash','anchorLength','context'].includes(k))||!/^[a-f0-9]{64}$/.test(entry.generation)||!/^[a-f0-9]{64}$/.test(entry.baseGeneration)||![entry.offset,entry.size,entry.anchorLength].every(n=>Number.isSafeInteger(n)&&n>=0)||entry.offset>entry.size||entry.anchorLength>64||entry.anchorLength>entry.offset||typeof entry.statKey!=='string'||entry.statKey.length>200||!/^[0-9.:-]+$/.test(entry.statKey)||entry.anchorHash!==null&&!/^[a-f0-9]{64}$/.test(entry.anchorHash)||!sourceObject(entry.context)||Object.keys(entry.context).some(k=>!Object.hasOwn(cursorContextFields,k)))throw new Error('Invalid numeric usage cursor entry');
  for(const [field,max]of Object.entries(cursorContextFields))if(entry.context[field]!==null&&sourceText(entry.context[field],max)===null)throw new Error('Invalid numeric usage cursor context');
 }
 if(Buffer.byteLength(JSON.stringify(value))>16777216)throw new Error('Numeric usage cursor exceeds bound; checkpoint retained');
 return structuredClone(value);
}

export function sanitizeUsageCoverage(value){
 if(!sourceObject(value))return null;
 const result={version:1,source:'codex-rollout-numeric'};
 for(const field of ['discoveredFiles','scannedFiles','unscannedFiles','readBytes','sampleCount','sampleBytes','heldFiles','incompleteFiles','invalidRecords','resetFiles','errorsTruncated'])if(Number.isSafeInteger(value[field])&&value[field]>=0)result[field]=value[field];
 result.backlogged=value.backlogged===true;
 if(typeof value.inventoryLimited==='boolean')result.inventoryLimited=value.inventoryLimited;
 const codes=new Set(['metadata-unavailable','metadata-invalid','metadata-identity-unavailable','source-symlink-refused','source-unavailable','cursor-capacity-refused','read-budget-exhausted','source-read-unavailable','record-size-refused','invalid-json-record']);
 result.errors=Array.isArray(value.errors)?value.errors.slice(0,32).filter(e=>sourceObject(e)&&typeof e.sourceId==='string'&&/^[a-f0-9]{64}$/.test(e.sourceId)&&codes.has(e.code)).map(e=>({sourceId:e.sourceId,code:e.code})):[];
 return result;
}

async function bytesAt(handle,size,position){const b=Buffer.alloc(size),result=await handle.read(b,0,size,position);return b.subarray(0,result.bytesRead);}
async function usageMetadata(handle,size,read=bytesAt){
 let prefix=await read(handle,Math.min(size,65536),0),end=prefix.indexOf(10);
 if(end<0&&size>prefix.length){const next=await read(handle,Math.min(size,1048576)-prefix.length,prefix.length);prefix=Buffer.concat([prefix,next]);end=prefix.indexOf(10);}
 if(end<0)throw new Error('metadata-unavailable');
 let first;try{first=JSON.parse(prefix.subarray(0,end).toString('utf8'));}catch{throw new Error('metadata-invalid');}
 const value=first?.payload;if(first?.type!=='session_meta'||!sourceObject(value)||!sourceText(value.id??value.session_id))throw new Error('metadata-identity-unavailable');
 const timestamp=sourceMilliseconds(value.timestamp),cwd=typeof value.cwd==='string'?value.cwd:'';
 const metadata={id:sourceText(value.id??value.session_id),timestamp:timestamp===null?null:new Date(timestamp).toISOString(),model_provider:sourceText(value.model_provider,128),cli_version:sourceText(value.cli_version,128),forked_from_id:sourceText(value.forked_from_id)};
 return {metadata,context:sourceContext(null,{}, {...metadata,cwd}),offset:end+1};
}

// The caller persists nextCursor only after the matching usageSamples batch is
// durably acknowledged. This reader never consumes the display reader's tails.
export class UsageSourceReader {
 async read(files,cursor,{maxSamples=256,maxBytes=524288,maxReadBytes=4194304,maxFiles=128}={}){
  if(!Array.isArray(files)||files.length>20000||![[maxSamples,3,1000],[maxBytes,8192,1048576],[maxReadBytes,65536,8388608],[maxFiles,1,256]].every(([v,min,max])=>Number.isSafeInteger(v)&&v>=min&&v<=max))throw new Error('Invalid numeric usage read bounds');
  const nextCursor=validateUsageCursor(cursor),entries=[],seen=new Set();
  for(const item of files){const file=typeof item==='string'?item:item?.file;if(typeof file!=='string'||!path.isAbsolute(file)||!file.endsWith('.jsonl'))throw new Error('Numeric usage source requires explicit absolute JSONL files');const key=fullHash(path.resolve(file));if(!seen.has(key)){seen.add(key);entries.push({file,key});}}
  const usageSamples=[],coverage={version:1,source:'codex-rollout-numeric',discoveredFiles:entries.length,scannedFiles:0,unscannedFiles:0,readBytes:0,sampleCount:0,sampleBytes:0,backlogged:false,heldFiles:0,incompleteFiles:0,invalidRecords:0,resetFiles:0,errors:[],errorsTruncated:0};
  const read=async(handle,size,position)=>{if(size>maxReadBytes-coverage.readBytes)throw new Error('read-budget-exhausted');const b=await bytesAt(handle,size,position);coverage.readBytes+=b.length;return b;};
  const diagnose=(key,code)=>{coverage.heldFiles++;coverage.backlogged=true;if(coverage.errors.length<32)coverage.errors.push({sourceId:key,code});else coverage.errorsTruncated++;};
  const previousIndex=entries.findIndex(e=>e.key===nextCursor.lastFileKey),start=previousIndex<0?0:(previousIndex+1)%Math.max(1,entries.length);let exhausted=false;
  for(let n=0;n<entries.length&&coverage.scannedFiles<maxFiles;n++){
   if(exhausted||coverage.readBytes>=maxReadBytes){coverage.backlogged=true;break;}
   const {file,key}=entries[(start+n)%entries.length];coverage.scannedFiles++;nextCursor.lastFileKey=key;let handle;
   try{
    if((await fs.lstat(file)).isSymbolicLink())throw new Error('source-symlink-refused');
    handle=await fs.open(file,'r');const stat=await handle.stat();if(!stat.isFile()||!Number.isSafeInteger(stat.size)||stat.size<1)throw new Error('source-unavailable');
    const statKey=`${stat.size}:${stat.mtimeMs}:${stat.birthtimeMs}:${stat.ino}`,old=nextCursor.files[key];
    if(old&&old.statKey===statKey&&old.offset===stat.size)continue;
    const initial=await usageMetadata(handle,stat.size,read),baseGeneration=fullHash(JSON.stringify([key,stat.birthtimeMs,stat.ino,initial.metadata,initial.context]));
    let entry=old?structuredClone(old):null,reset=!!old&&(old.offset>stat.size||old.baseGeneration!==baseGeneration);
    // A replacement or in-place rewrite starts a new capture generation. An
    // append leaves the previously committed byte positions and identities stable.
    const originalGeneration=old?.generation;
    if(old&&old.anchorLength&&old.offset<=stat.size){const anchor=await read(handle,old.anchorLength,old.offset-old.anchorLength);if(fullHash(anchor)!==old.anchorHash)reset=true;}
    if(old&&old.statKey!==statKey&&old.offset===stat.size)reset=true;
    if(!entry||reset){entry={generation:reset?fullHash(JSON.stringify([baseGeneration,originalGeneration,statKey])):baseGeneration,baseGeneration,offset:initial.offset,size:stat.size,statKey,anchorHash:null,anchorLength:0,context:initial.context};if(reset)coverage.resetFiles++;}
    if(!Object.hasOwn(nextCursor.files,key)&&Object.keys(nextCursor.files).length>=20000)throw new Error('cursor-capacity-refused');
    const available=Math.max(0,Math.min(stat.size-entry.offset,maxReadBytes-coverage.readBytes-64,262144));
    let bytes=await read(handle,available,entry.offset);
    while(bytes.indexOf(10)<0&&bytes.length<stat.size-entry.offset&&bytes.length<2097153){const extra=Math.max(0,Math.min(262144,stat.size-entry.offset-bytes.length,2097153-bytes.length,maxReadBytes-coverage.readBytes-64));if(!extra)break;bytes=Buffer.concat([bytes,await read(handle,extra,entry.offset+bytes.length)]);}
    const origin=entry.offset;let startLine=0,end;
    while((end=bytes.indexOf(10,startLine))>=0){
     const line=bytes.subarray(startLine,end);if(line.length>2097152){diagnose(key,'record-size-refused');break;}
     if(!line.toString('utf8').trim()){entry.offset=origin+end+1;startLine=end+1;continue;}
     let record;try{record=JSON.parse(line.toString('utf8'));}catch{coverage.invalidRecords++;diagnose(key,'invalid-json-record');break;}
     const context=sourceContext(record,entry.context,initial.metadata),samples=extractUsageSamples(record,{metadata:initial.metadata,context,sourceId:entry.generation,sourceOffset:origin+startLine}),sampleBytes=samples.reduce((sum,sample)=>sum+Buffer.byteLength(JSON.stringify(sample)),0);
     if(usageSamples.length+samples.length>maxSamples||coverage.sampleBytes+sampleBytes>maxBytes){coverage.backlogged=true;exhausted=true;break;}
     usageSamples.push(...samples);coverage.sampleBytes+=sampleBytes;entry.context=context;entry.offset=origin+end+1;startLine=end+1;
    }
    if(entry.offset<stat.size){coverage.backlogged=true;const remainder=bytes.length-startLine;if(remainder>2097152)diagnose(key,'record-size-refused');else if(origin+bytes.length===stat.size&&remainder>0&&bytes.indexOf(10,startLine)<0)coverage.incompleteFiles++;}
    entry.size=stat.size;entry.statKey=statKey;entry.anchorLength=Math.min(64,entry.offset);entry.anchorHash=entry.anchorLength?fullHash(await read(handle,entry.anchorLength,entry.offset-entry.anchorLength)):null;nextCursor.files[key]=entry;
   }catch(error){const allowed=new Set(['metadata-unavailable','metadata-invalid','metadata-identity-unavailable','source-symlink-refused','source-unavailable','cursor-capacity-refused','read-budget-exhausted']);diagnose(key,allowed.has(error.message)?error.message:'source-read-unavailable');if(error.message==='read-budget-exhausted')exhausted=true;}
   finally{await handle?.close();}
  }
  coverage.unscannedFiles=Math.max(0,entries.length-coverage.scannedFiles);if(coverage.unscannedFiles)coverage.backlogged=true;coverage.sampleCount=usageSamples.length;
  validateUsageCursor(nextCursor);return {usageSamples,nextCursor,coverage};
 }
}
const category=name=>/apply_patch/.test(name)?'edit':/web|search|browse/.test(name)?'research':/spawn|agent|collaboration/.test(name)?'agent':/exec|command|stdin/.test(name)?'command':'tool';
const limitWindow=value=>value&&typeof value==='object'&&numeric(value.used_percent)!==null?{usedPercent:value.used_percent,windowDurationMins:numeric(value.window_minutes),resetsAt:numeric(value.resets_at)}:null;

function recordLimits(session,value,at){
 if(!value||typeof value!=='object'||Array.isArray(value)||!at)return;
 const primary=limitWindow(value.primary),secondary=limitWindow(value.secondary);
 if(!primary&&!secondary)return;
 const limitId=safe(value.limit_id,80)||'unlabelled',previous=(session.usageLimits||[]).find(q=>q.limitId===limitId);
 const report={limitId,limitName:safe(value.limit_name,80)||previous?.limitName||null,planType:safe(value.plan_type,40)||previous?.planType||null,accountKey:null,observedAt:Date.parse(previous?.observedAt)>Date.parse(at)?previous.observedAt:at,primary:previous?.primary||null,primaryObservedAt:previous?.primaryObservedAt||null,secondary:previous?.secondary||null,secondaryObservedAt:previous?.secondaryObservedAt||null};
 for(const [field,window] of [['primary',primary],['secondary',secondary]])if(window&&(!report[field]||Date.parse(at)>=Date.parse(report[field+'ObservedAt']))){report[field]=window;report[field+'ObservedAt']=at;}
 session.usageLimits=[...(session.usageLimits||[]).filter(q=>q.limitId!==limitId),report].slice(-8);
}

class Summary {
 constructor(meta,sourceId){
  this.meta=meta;this.sourceId=sourceId;this.turnId=null;this.calls=new Map();
  const spawn=meta.source?.subagent?.thread_spawn;
  this.session={id:safe(meta.id||meta.session_id)||'unknown',project:path.win32.basename(meta.cwd||'')||'Unassigned',cwd:safe(meta.cwd,600),origin:typeof meta.source==='string'?safe(meta.source):spawn?'subagent':safe(meta.originator)||'unknown',provider:safe(meta.model_provider),version:safe(meta.cli_version),parentId:safe(spawn?.parent_thread_id||meta.parent_thread_id),agentPath:safe(meta.agent_path||spawn?.agent_path),nickname:safe(meta.agent_nickname||spawn?.agent_nickname),forkedFrom:safe(meta.forked_from_id),taskLabel:null,taskLabelSource:null,taskLabelUpdatedAt:null,state:'Unknown',model:null,effort:null,tokens:null,lastTokens:null,usageObservedAt:null,usageLimits:null,contextWindow:null,events:[],tools:0,changes:0,lastEventAt:null};
 }
 feed(record,offset,receivedAt,delivery='bootstrap'){
  const p=record.payload||{},s=this.session;
  // A fork may embed its parent's history. Never count that as child activity.
  if(this.meta.forked_from_id&&Date.parse(record.timestamp)<Date.parse(this.meta.timestamp))return;
  if(record.type==='turn_context'){
   this.turnId=safe(p.turn_id)||this.turnId;s.model=safe(p.model)||s.model;s.effort=safe(p.effort||p.reasoning_effort)||s.effort;
   if(typeof p.cwd==='string'){s.cwd=safe(p.cwd,600);s.project=path.win32.basename(s.cwd)||'Unassigned';}return;
  }
  if(record.type==='token_usage_record'){
   const total=usage(p.thread_token_usage),at=iso(record.timestamp);
   if(total&&at&&(!s.usageObservedAt||Date.parse(at)>=Date.parse(s.usageObservedAt))){s.tokens=total;s.usageObservedAt=at;}
   return;
  }
  if(p.type==='token_count'){
   const total=usage(p.info?.total_token_usage),last=usage(p.info?.last_token_usage),at=iso(record.timestamp)||receivedAt;
   if((total||last)&&(!s.usageObservedAt||Date.parse(at)>=Date.parse(s.usageObservedAt))){s.tokens=total||s.tokens;s.lastTokens=last||s.lastTokens;s.contextWindow=numeric(p.info?.model_context_window)??s.contextWindow;s.usageObservedAt=at;}
   recordLimits(s,p.rate_limits,iso(record.timestamp));return;
  }
  let e=null;
  if(record.type==='event_msg'){
   switch(p.type){
    case 'task_started':this.turnId=safe(p.turn_id)||this.turnId;s.state='Turn started';s.contextWindow=numeric(p.model_context_window)??s.contextWindow;e={kind:'turn',label:'Turn started',outcome:'observed'};break;
    case 'task_complete':case 'task_completed':s.state='Turn completed';e={kind:'complete',label:'Turn completed · acceptance unverified',outcome:'unverified'};break;
    case 'turn_aborted':s.state='Interrupted';e={kind:'error',label:'Turn interrupted',outcome:'interrupted'};break;
    case 'approval_requested':case 'request_user_input':s.state='Input requested';e={kind:'approval',label:p.type==='approval_requested'?'Approval requested':'Input requested',requestId:safe(p.request_id),outcome:'waiting'};break;
    case 'approval_resolved':case 'user_input_received':e={kind:'resolution',label:'Request resolution recorded',requestId:safe(p.request_id),outcome:'recorded'};break;
    case 'item_completed':{
     const item=p.item||{},names={CommandExecution:'Command execution',McpToolCall:`MCP / ${toolName(item.tool)}`,FileChange:'File change',SubAgentActivity:'Subagent activity',ImageView:'Image view',Extension:'Extension activity',ContextCompaction:'Context compaction',AgentMessage:'Agent message recorded'};
     if(!names[item.type])break;
     const failed=item.status==='failed'||item.status==='error'||(typeof item.exit_code==='number'&&item.exit_code!==0);
     e={kind:'operation',label:names[item.type],category:({CommandExecution:'command',FileChange:'edit',SubAgentActivity:'agent',Extension:'research'})[item.type]||'tool',callId:safe(item.id),startedAt:iso(p.started_at_ms),completedAt:iso(p.completed_at_ms),outcome:failed?'failed':item.status==='completed'?'completed':'recorded',exitCode:typeof item.exit_code==='number'?item.exit_code:null,childId:safe(item.agent_thread_id)};
     // Only the native typed item establishes compaction. Labels, arguments
     // and tool output never supply this discriminator.
     if(item.type==='ContextCompaction')e.operationType='context-compaction';
     if(item.type==='FileChange'&&item.status==='completed')s.changes++;
     break;
    }
   }
  }else if(record.type==='response_item'){
   if(p.type==='function_call'||p.type==='custom_tool_call'){
    const name=toolName(p.name),callId=safe(p.call_id||p.id);s.tools++;this.calls.set(callId,{name,category:category(name)});if(this.calls.size>1000)this.calls.delete(this.calls.keys().next().value);e={kind:'tool.start',label:name,category:category(name),callId,outcome:'observed'};
   }else if(p.type==='function_call_output'||p.type==='custom_tool_call_output'){
    // Never parse or expose arbitrary text output as a successful operation.
    const call=this.calls.get(safe(p.call_id));e={kind:'tool.end',label:call?call.name+' · result recorded':'Tool result recorded',category:call?.category||'tool',callId:safe(p.call_id),outcome:p.is_error===true?'failed':'recorded'};
   }else if(p.type==='message'&&p.role==='assistant'&&p.phase==='final_answer'){
    s.state='Final answer recorded';e={kind:'message',label:'Final answer recorded · acceptance unverified',outcome:'unverified'};
   }
  }
  if(!e)return;
  const at=iso(record.timestamp)||receivedAt;
  e={...e,id:hash(this.sourceId+'|'+offset+'|'+JSON.stringify(record)),sourceId:this.sourceId,offset,sessionId:s.id,project:s.project,projectBasis:'source-context',turnId:safe(p.turn_id)||this.turnId,at,timeOrigin:iso(record.timestamp)?'source':'received',receivedAt,delivery};
  s.lastEventAt=at;s.events.push(e);if(s.events.length>600)s.events.splice(0,s.events.length-600);
 }
}

export function summarizeRecords(records,meta,modifiedAt,size){
 const summary=new Summary(meta,hash(JSON.stringify([meta.id,meta.timestamp])));
 records.forEach((r,i)=>summary.feed(r,i,modifiedAt));
 return {...summary.session,modifiedAt,size};
}

async function precedingContext(handle,end){
 let position=end,read=0,suffix='';
 while(position>0&&read<8388608){
  const size=Math.min(262144,position),buffer=Buffer.alloc(size);position-=size;read+=size;await handle.read(buffer,0,size,position);
  const lines=(buffer.toString('utf8')+suffix).split('\n');suffix=position>0?lines.shift():'';
  for(let i=lines.length-1;i>=0;i--)if(lines[i].includes('"turn_context"')){try{const record=JSON.parse(lines[i]);if(record.type==='turn_context')return record;}catch{}}
  if(suffix.length>2097152)suffix='';
 }
 return null;
}

export class SessionReader {
 constructor({taskLabels=new TaskLabelReader(),sessionRoot}={}){this.files=new Map();this.taskLabels=taskLabels;this.sessionRoot=sessionRoot;}
 async read(file,options={}){
  const handle=await fs.open(file,'r');
  try{
   const stat=await handle.stat(),previous=this.files.get(file);
   if(previous&&previous.statKey===`${stat.size}:${stat.mtimeMs}:${stat.birthtimeMs}:${stat.ino}`){
    const s=previous.summary.session,task=await this.taskLabels.read(file,s.id,{sessionRoot:this.sessionRoot,...options});return {...s,...task,events:s.events.map(e=>({...e})),modifiedAt:stat.mtime.toISOString(),size:stat.size,capture:{checkedAt:new Date().toISOString(),offset:previous.offset,partialBytes:previous.carry.length,reset:false,backlogged:false,tailLimited:previous.truncated,retained:s.events.length}};
   }
   const prefix=Buffer.alloc(Math.min(stat.size,1048576));await handle.read(prefix,0,prefix.length,0);
   const firstEnd=prefix.indexOf(10);if(firstEnd<0)throw new Error('Metadata line exceeds read bound');
   const meta=JSON.parse(prefix.subarray(0,firstEnd).toString('utf8')).payload||{};
   const generation=hash(file+'|'+stat.birthtimeMs+'|'+stat.ino+'|'+prefix.subarray(0,firstEnd).toString());
   let reset=!!previous&&(previous.generation!==generation||stat.size<previous.offset);
   if(previous&&!reset&&previous.anchor.length){
    const check=Buffer.alloc(previous.anchor.length);await handle.read(check,0,check.length,previous.offset-check.length);reset=!check.equals(previous.anchor);
   }
   let state=previous;
   if(!state||reset){
    let offset=stat.size>262144?stat.size-262144:firstEnd+1;
    state={generation,offset,carry:Buffer.alloc(0),summary:new Summary(meta,generation),anchor:Buffer.alloc(0),truncated:offset>firstEnd+1};
    if(state.truncated){const probe=Buffer.alloc(Math.min(262144,stat.size-offset));await handle.read(probe,0,probe.length,offset);const newline=probe.indexOf(10);offset=newline<0?stat.size:offset+newline+1;state.offset=offset;}
    const context=await precedingContext(handle,state.offset);if(context)state.summary.feed(context,0,new Date().toISOString());
   }
   const backlogged=stat.size-state.offset>1048576;
   if(backlogged){state.offset=stat.size-1048576;state.carry=Buffer.alloc(0);state.truncated=true;}
   const count=stat.size-state.offset,chunk=Buffer.alloc(count);if(count)await handle.read(chunk,0,count,state.offset);
   let buffer=Buffer.concat([state.carry,chunk]),position=state.offset-state.carry.length;
   const receivedAt=new Date().toISOString();let start=0,newline;
   while((newline=buffer.indexOf(10,start))>=0){
    const line=buffer.subarray(start,newline);
    try{state.summary.feed(JSON.parse(line.toString('utf8')),position+start,receivedAt,!previous||reset||backlogged?'bootstrap':'live');}catch{/* Partial/malformed source records are excluded, never executed. */}
    start=newline+1;
   }
   state.carry=buffer.subarray(start);if(state.carry.length>2097152){state.carry=Buffer.alloc(0);state.truncated=true;}
   state.offset=stat.size;state.anchor=Buffer.alloc(Math.min(64,stat.size));await handle.read(state.anchor,0,state.anchor.length,stat.size-state.anchor.length);
   state.statKey=`${stat.size}:${stat.mtimeMs}:${stat.birthtimeMs}:${stat.ino}`;
   this.files.set(file,state);
   const s=state.summary.session,task=await this.taskLabels.read(file,s.id,{sessionRoot:this.sessionRoot,...options});
   // Event.project is captured at its own source offset. A later cwd/context
   // changes the session summary, never historical evidence or viewer scope.
   return {...s,...task,events:s.events.map(e=>({...e})),modifiedAt:stat.mtime.toISOString(),size:stat.size,capture:{checkedAt:receivedAt,offset:state.offset,partialBytes:state.carry.length,reset,backlogged,tailLimited:state.truncated,retained:s.events.length}};
  }finally{await handle.close();}
 }
 retain(files){for(const file of this.files.keys())if(!files.has(file))this.files.delete(file);}
}
