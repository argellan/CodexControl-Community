// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import crypto from 'node:crypto';

// Frozen V2 capture contract. Context describes configuration as of the record;
// neither currently qualified source establishes the producing model or tier.
export const USAGE_SAMPLE_COLUMNS=Object.freeze('sample_key host_id session_id source_id source_record_key source_offset source_kind source_version usage_scope source_ms received_ms time_basis project native_thread_id native_session_id native_turn_id native_root_turn_id native_response_id provider_account_key context_turn_id context_provider context_model context_effort context_service_tier context_speed producing_provider producing_model producing_effort producing_service_tier producing_speed forked_from_id inherited_history source_role accounting_class input_tokens cached_input_tokens cache_write_input_tokens output_tokens reasoning_output_tokens total_tokens reported_mask provider_reported_mask synthesized_mask'.split(' '));
export const USAGE_SAMPLE_COUNTERS=Object.freeze('input_tokens cached_input_tokens cache_write_input_tokens output_tokens reasoning_output_tokens total_tokens'.split(' '));
export const USAGE_SAMPLE_HASH_COLUMNS=Object.freeze(USAGE_SAMPLE_COLUMNS.filter(k=>k!=='sample_key'&&k!=='received_ms'));
export const USAGE_SAMPLE_SOURCE_COLUMNS=Object.freeze(USAGE_SAMPLE_COLUMNS.filter(k=>!['sample_key','host_id','received_ms','source_role','accounting_class','provider_account_key'].includes(k)));
const hex=/^[a-f0-9]{64}$/,roles=new Set(['codex-source','execution-target','execution-job','unknown']);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max=256)=>typeof v==='string'&&v.length>0&&v.length<=max&&v.isWellFormed()&&!/[\x00-\x1f\x7f]/.test(v);
const integer=(v,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
const fail=()=>{throw Object.assign(new Error('Invalid usage sample'),{status:400});};
function require(value){if(!value)fail();}
export function usageSampleKey(row){return crypto.createHash('sha256').update(JSON.stringify(USAGE_SAMPLE_HASH_COLUMNS.map(k=>row[k]))).digest('hex');}
export function validateUsageSampleRow(row){
 require(plain(row)&&Object.keys(row).length===USAGE_SAMPLE_COLUMNS.length&&USAGE_SAMPLE_COLUMNS.every(k=>Object.hasOwn(row,k)));
 require(text(row.host_id)&&text(row.session_id)&&hex.test(row.sample_key)&&hex.test(row.source_record_key));
 for(const key of ['source_id','provider_account_key'])require(row[key]===null||typeof row[key]==='string'&&hex.test(row[key]));
 require(row.source_offset===null||integer(row.source_offset));
 require(['token_count','token_usage_record'].includes(row.source_kind)&&['thread-total','last-response','response','turn-total'].includes(row.usage_scope));
 require(row.source_version===null||text(row.source_version,128));
 require(row.source_ms===null||integer(row.source_ms,8640000000000000));require(integer(row.received_ms,8640000000000000));
 require(row.time_basis===(row.source_ms===null?'receipt':'source'));
 for(const key of ['project','native_thread_id','native_session_id','native_turn_id','native_root_turn_id','native_response_id','context_turn_id','forked_from_id'])require(row[key]===null||text(row[key]));
 for(const key of ['context_provider','context_model'])require(row[key]===null||text(row[key],128));
 for(const key of ['context_effort','context_service_tier','context_speed'])require(row[key]===null||text(row[key],64));
 for(const key of ['producing_provider','producing_model','producing_effort','producing_service_tier','producing_speed'])require(row[key]===null);
 require(row.inherited_history===null||row.inherited_history===0||row.inherited_history===1);require(roles.has(row.source_role));
 require(['candidate','fork-excluded','execution-excluded','unknown'].includes(row.accounting_class));
 const expected=row.source_role==='execution-target'||row.source_role==='execution-job'?'execution-excluded':row.forked_from_id!==null||row.inherited_history===1?'fork-excluded':row.source_role==='codex-source'?'candidate':'unknown';
 require(row.accounting_class===expected);
 for(const key of ['reported_mask','provider_reported_mask','synthesized_mask'])require(integer(row[key],63));
 require(!(row.provider_reported_mask&~row.reported_mask)&&!(row.synthesized_mask&~row.reported_mask)&&!(row.provider_reported_mask&row.synthesized_mask));
 USAGE_SAMPLE_COUNTERS.forEach((key,i)=>require((row[key]===null||integer(row[key]))&&((row.reported_mask&(1<<i))||row[key]===null)));
 require(row.sample_key===usageSampleKey(row));return row;
}
export function normalizeUsageSample(input,{hostId,receivedMs,sourceRole,providerAccountKey=null}={}){
 require(plain(input)&&Object.keys(input).every(k=>USAGE_SAMPLE_SOURCE_COLUMNS.includes(k)));
 const row=Object.fromEntries(USAGE_SAMPLE_COLUMNS.map(k=>[k,null]));
 for(const key of USAGE_SAMPLE_SOURCE_COLUMNS)if(Object.hasOwn(input,key))row[key]=input[key];
 row.host_id=hostId;row.received_ms=receivedMs;row.source_role=sourceRole??'unknown';row.provider_account_key=providerAccountKey;
 row.accounting_class=row.source_role==='execution-target'||row.source_role==='execution-job'?'execution-excluded':row.forked_from_id!==null||row.inherited_history===1?'fork-excluded':row.source_role==='codex-source'?'candidate':'unknown';
 row.sample_key=usageSampleKey(row);return validateUsageSampleRow(row);
}

const textColumns=new Set('sample_key host_id session_id source_id source_record_key source_kind source_version usage_scope time_basis project native_thread_id native_session_id native_turn_id native_root_turn_id native_response_id provider_account_key context_turn_id context_provider context_model context_effort context_service_tier context_speed producing_provider producing_model producing_effort producing_service_tier producing_speed forked_from_id source_role accounting_class'.split(' '));
const required=new Set('host_id session_id source_record_key source_kind usage_scope received_ms time_basis source_role accounting_class reported_mask provider_reported_mask synthesized_mask'.split(' '));
export const USAGE_SAMPLE_SCHEMA='CREATE TABLE usage_samples_v2('+USAGE_SAMPLE_COLUMNS.map(k=>k==='sample_key'?'sample_key TEXT PRIMARY KEY NOT NULL':`${k} ${textColumns.has(k)?'TEXT':'INTEGER'}${required.has(k)?' NOT NULL':''}`).join(',')+')';
export const USAGE_SAMPLE_INDEXES=Object.freeze({usage_samples_received:'CREATE INDEX usage_samples_received ON usage_samples_v2(received_ms,sample_key)',usage_samples_session:'CREATE INDEX usage_samples_session ON usage_samples_v2(host_id,session_id,source_ms,sample_key)',usage_samples_time:'CREATE INDEX usage_samples_time ON usage_samples_v2(COALESCE(source_ms,received_ms),received_ms,sample_key)',usage_samples_count:'CREATE INDEX usage_samples_count ON usage_samples_v2(0)'});
export const USAGE_SAMPLE_IMMUTABLE_TRIGGERS=Object.freeze({usage_samples_immutable:'CREATE TRIGGER usage_samples_immutable BEFORE UPDATE ON usage_samples_v2 BEGIN SELECT RAISE(ABORT,\'Usage samples are immutable\'); END',usage_samples_no_replace:'CREATE TRIGGER usage_samples_no_replace BEFORE INSERT ON usage_samples_v2 WHEN EXISTS(SELECT 1 FROM usage_samples_v2 WHERE sample_key=NEW.sample_key) BEGIN SELECT RAISE(ABORT,\'Usage samples are immutable\'); END'});
export const USAGE_CAPTURE_CURSOR_SCHEMA='CREATE TABLE usage_capture_cursors(host_id TEXT PRIMARY KEY NOT NULL,payload TEXT NOT NULL)';
export function installUsageSamples(db){db.exec(USAGE_SAMPLE_SCHEMA);db.exec(USAGE_CAPTURE_CURSOR_SCHEMA);for(const sql of Object.values(USAGE_SAMPLE_INDEXES))db.exec(sql);for(const sql of Object.values(USAGE_SAMPLE_IMMUTABLE_TRIGGERS))db.exec(sql);}
export function validateUsageSamples(db,{rows=true}={}){
 const normalize=v=>v.replace(/\bIF NOT EXISTS\s+/gi,'').replace(/\s+/g,' ').replace(/;$/,'').trim();
 const actual=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='usage_samples_v2'").get()?.sql;
 require(typeof actual==='string'&&normalize(actual)===normalize(USAGE_SAMPLE_SCHEMA));
 require(normalize(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='usage_capture_cursors'").get()?.sql||'')===normalize(USAGE_CAPTURE_CURSOR_SCHEMA));
 for(const [name,sql] of Object.entries({...USAGE_SAMPLE_INDEXES,...USAGE_SAMPLE_IMMUTABLE_TRIGGERS}))require(normalize(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)?.sql||'')===normalize(sql));
 require(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'usage_samples_%'").all().length===Object.keys(USAGE_SAMPLE_IMMUTABLE_TRIGGERS).length);
 if(!rows)return null;
 for(const row of db.prepare('SELECT * FROM usage_samples_v2').iterate())validateUsageSampleRow(row);
 return db.prepare('SELECT COUNT(*) n FROM usage_samples_v2').get().n;
}
export function captureUsageSamples(db,samples,context){
 require(Array.isArray(samples)&&samples.length<=1024);const rows=samples.map(input=>normalizeUsageSample(input,context));
 const get=db.prepare('SELECT * FROM usage_samples_v2 WHERE sample_key=?'),insert=db.prepare(`INSERT INTO usage_samples_v2(${USAGE_SAMPLE_COLUMNS.join(',')}) VALUES(${USAGE_SAMPLE_COLUMNS.map(()=>'?').join(',')})`);
 let added=0;for(const row of rows){const previous=get.get(row.sample_key);if(previous){require(USAGE_SAMPLE_HASH_COLUMNS.every(k=>previous[k]===row[k]));continue;}insert.run(...USAGE_SAMPLE_COLUMNS.map(k=>row[k]));added++;}return {received:rows.length,added,duplicates:rows.length-added};
}

function queryScope({hostIds=null,projectIds=null,sessionId=null,from=0,to=Date.now()}={}){
 require(integer(from,8640000000000000)&&integer(to,8640000000000000)&&from<=to);
 const clauses=['COALESCE(source_ms,received_ms)>=?','COALESCE(source_ms,received_ms)<=?'],args=[from,to];
 for(const [column,values] of [['host_id',hostIds],['project',projectIds]])if(values!==null){require(Array.isArray(values)&&values.length<=256&&values.every(v=>text(v)));clauses.push(values.length?`${column} IN (${values.map(()=>'?')})`:'0');args.push(...values);}
 if(sessionId!==null){require(text(sessionId));clauses.push('session_id=?');args.push(sessionId);}return {where:clauses.join(' AND '),args};
}
const sampleOrder=(a,b)=>(b.source_ms??b.received_ms)-(a.source_ms??a.received_ms)||b.received_ms-a.received_ms||b.sample_key.localeCompare(a.sample_key);
const fields={input:'input_tokens',cached:'cached_input_tokens',cacheWrite:'cache_write_input_tokens',output:'output_tokens',reasoning:'reasoning_output_tokens',total:'total_tokens'};
function totals(rows){return Object.fromEntries(Object.entries(fields).map(([label,key])=>{let total=0;for(const row of rows){if(row[key]===null||!integer(total+row[key]))return [label,null];total+=row[key];}return [label,rows.length?total:null];}));}
function ratio(rows,numerator,denominator,{subtract=false}={}){
 let n=0,d=0,comparable=0;for(const row of rows){if(row[numerator]===null||row[denominator]===null||row[numerator]>row[denominator])continue;const add=subtract?row[denominator]-row[numerator]:row[numerator];if(!integer(n+add)||!integer(d+row[denominator]))return {value:null,comparableRows:comparable,excludedRows:rows.length-comparable,reason:'numeric-overflow'};n+=add;d+=row[denominator];comparable++;}
 return {value:d>0?n/d:null,numerator:n,denominator:d,comparableRows:comparable,excludedRows:rows.length-comparable,reason:d>0?null:'no-comparable-denominator',classification:'derived',method:'ratio-of-sums'};
}
export function summarizeUsageSamples(rows,{now=Date.now(),from=0,to=now,matchingRows=rows.length,retainedRows=rows.length,includeRecords=false}={}){
 const sorted=[...rows].sort(sampleOrder),candidates=sorted.filter(r=>r.accounting_class==='candidate'),byIdentity=new Map();let identityMissing=0;
 for(const row of candidates){if(row.usage_scope!=='response')continue;if(!row.native_response_id||!row.native_turn_id){identityMissing++;continue;}const key=JSON.stringify([row.host_id,row.session_id,row.native_thread_id,row.native_response_id]);if(!byIdentity.has(key))byIdentity.set(key,[]);byIdentity.get(key).push(row);}
 const responses=[];let conflictingResponses=0;
 for(const versions of byIdentity.values()){
  // Repeated source records do not establish another provider response. A
  // conflicting counter/configured turn identity stays unknown, not "latest".
  const first=versions[0],keys=[...USAGE_SAMPLE_COUNTERS,'native_session_id','native_turn_id','native_root_turn_id','project','context_provider','context_model','context_effort','context_service_tier','context_speed'];
  if(versions.some(row=>keys.some(k=>row[k]!==first[k]))){conflictingResponses++;continue;}responses.push(first);
 }
 const group=(keyFn,make)=>{const groups=new Map();for(const row of responses){const key=keyFn(row);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}return [...groups.values()].map(values=>({...make(values[0],values),...totals(values),responseCount:values.length,sourceAt:new Date(Math.max(...values.map(r=>r.source_ms??r.received_ms))).toISOString(),sampleKeys:values.slice(0,100).map(r=>r.sample_key),sampleKeysTruncated:values.length>100}));};
 const turns=group(row=>JSON.stringify([row.host_id,row.session_id,row.native_thread_id,row.native_session_id,row.native_turn_id]),(row,values)=>{const turn={hostId:row.host_id,sessionId:row.session_id,nativeThreadId:row.native_thread_id,nativeSessionId:row.native_session_id,turnId:row.native_turn_id,rootTurnId:row.native_root_turn_id,project:row.project,contextProvider:row.context_provider,contextModel:row.context_model,contextEffort:row.context_effort,contextServiceTier:row.context_service_tier,producingModel:null};for(const [key,column] of [['rootTurnId','native_root_turn_id'],['project','project'],['contextProvider','context_provider'],['contextModel','context_model'],['contextEffort','context_effort'],['contextServiceTier','context_service_tier']])if(values.some(r=>r[column]!==row[column])){turn[key]=null;turn.mixedContext=true;}return turn;});
 const dimensions=group(row=>JSON.stringify([row.host_id,row.project,row.context_provider,row.context_model,row.context_effort,row.context_service_tier]),row=>({hostId:row.host_id,project:row.project,contextProvider:row.context_provider,contextModel:row.context_model,contextEffort:row.context_effort,contextServiceTier:row.context_service_tier,attribution:'configured-context',producingModel:null}));
 const truncated=matchingRows>rows.length,coverage={retainedRows,matchingRows,returnedRows:rows.length,truncated,latestSourceAt:sorted.find(r=>r.source_ms!==null)?.source_ms??null,latestReceivedAt:rows.length?Math.max(...rows.map(r=>r.received_ms)):null,excludedRows:rows.length-candidates.length,identityMissing,conflictingResponses,notes:['Input includes cached input; reasoning is a subset of output. Never add subsets twice.','Only distinct native response identities contribute to response/turn totals. Cumulative and last-response snapshots remain evidence, not additive responses.','Host-scoped observations may overlap when source sessions are copied. No account-wide completeness or cross-host dedup is inferred.','Configured context is not a producing-model or service-tier attribution.']};
 for(const key of ['latestSourceAt','latestReceivedAt'])coverage[key]=coverage[key]===null?null:new Date(coverage[key]).toISOString();
 const records=includeRecords?responses.map(row=>({sampleKey:row.sample_key,hostId:row.host_id,sessionId:row.session_id,project:row.project,sourceId:row.source_id,sourceRecordKey:row.source_record_key,sourceOffset:row.source_offset,sourceKind:row.source_kind,sourceVersion:row.source_version,turnId:row.native_turn_id,responseId:row.native_response_id,sourceAt:row.source_ms===null?null:new Date(row.source_ms).toISOString(),receivedAt:new Date(row.received_ms).toISOString(),timeBasis:row.time_basis,accountAttribution:row.provider_account_key===null?'unknown':'linked',configuredModel:row.context_model,configuredEffort:row.context_effort,input:row.input_tokens,cached:row.cached_input_tokens,cacheWrite:row.cache_write_input_tokens,output:row.output_tokens,reasoning:row.reasoning_output_tokens,total:row.total_tokens,reportedMask:row.reported_mask,providerReportedMask:row.provider_reported_mask,synthesizedMask:row.synthesized_mask})):null;
 return {version:2,observedAt:new Date(now).toISOString(),scope:{from:new Date(from).toISOString(),to:new Date(to).toISOString(),kind:'captured-source-observations'},coverage,responses:{status:responses.length?truncated||conflictingResponses||identityMissing?'partial':'available':'unavailable',totals:totals(responses),ratios:{cacheHit:ratio(responses,'cached_input_tokens','input_tokens'),reasoningShare:ratio(responses,'reasoning_output_tokens','output_tokens'),newInputFraction:ratio(responses,'cached_input_tokens','input_tokens',{subtract:true})},responseCount:responses.length,turns:turns.slice(0,200),turnsTruncated:turns.length>200,dimensions:dimensions.slice(0,200),dimensionsTruncated:dimensions.length>200,...(includeRecords?{records,recordsTruncated:truncated}:{})},recent:sorted.slice(0,100)};
}
export function readUsageSampleAnalytics(db,{now=Date.now(),from=Math.max(0,now-86400000),to=now,hostIds=null,projectIds=null,sessionId=null,limit=5000,includeRecords=false}={}){
 require(typeof includeRecords==='boolean');
 require(integer(limit,5000)&&limit>=1);const s=queryScope({hostIds,projectIds,sessionId,from,to}),rows=db.prepare(`SELECT * FROM usage_samples_v2 WHERE ${s.where} ORDER BY COALESCE(source_ms,received_ms) DESC,received_ms DESC,sample_key DESC LIMIT ?`).all(...s.args,limit),matchingRows=db.prepare(`SELECT COUNT(*) n FROM usage_samples_v2 WHERE ${s.where}`).get(...s.args).n,retainedRows=db.prepare(`SELECT COUNT(*) n FROM usage_samples_v2 WHERE ${queryScope({hostIds,projectIds,sessionId,from:0,to:8640000000000000}).where}`).get(...queryScope({hostIds,projectIds,sessionId,from:0,to:8640000000000000}).args).n;
 return summarizeUsageSamples(rows,{now,from,to,matchingRows,retainedRows,includeRecords});
}
