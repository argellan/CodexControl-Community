// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import crypto from 'node:crypto';
import {sanitizeAccountUsage} from './account-usage.mjs';
import {installUsageArchive,installUsageSampleArchive,validateArchiveDatabase,archiveDeletionGuard,archiveStatus,recordSourceVersion} from './usage-archive.mjs';
import {USAGE_SAMPLE_COLUMNS,installUsageSamples,validateUsageSamples} from './usage-samples.mjs';
import {validateUsageCursor} from './observer.mjs';

// This journal records observations, not invoices or a provider token stream.
// Cached input is included in input; only uncachedInputTokens is additive to it.
export const DEFAULT_USAGE_RETENTION=Object.freeze({rawAgeMs:30*86400000,maxRawObservations:200000,maxSampleObservations:50000,maxAccountObservations:50000,dailyAgeMs:730*86400000,maxDailyRows:200000,maxBaselines:200000,trimIntervalMs:60000,maxGapMs:120000,windowMs:60000});
export const USAGE_TABLE_COLUMNS=Object.freeze({
 usage_meta:['key','value'],
 usage_baselines:['host_id','session_id','project','provider','model','source_ms','received_ms','input_tokens','cached_input_tokens','output_tokens','total_tokens','has_delta'],
 usage_observations:['sequence','host_id','session_id','project','provider','model','source_ms','received_ms','interval_ms','status','input_tokens','cached_input_tokens','output_tokens','total_tokens','delta_input','delta_cached','delta_uncached','delta_output','delta_total'],
 usage_daily:['host_id','session_id','segment_key','project','provider','model','day','input_tokens','cached_input_tokens','uncached_input_tokens','output_tokens','total_tokens','observations','partial_observations','overflow','first_ms','last_ms'],
 account_usage_observations:['sequence','host_id','sample_key','observed_ms','limits_ms','usage_ms','received_ms','account_identity','payload'],
 account_usage_daily:['host_id','account_identity','day','tokens','observed_ms','received_ms'],
 usage_samples_v2:USAGE_SAMPLE_COLUMNS,
 usage_capture_cursors:['host_id','payload']
});
const fields=['input_tokens','cached_input_tokens','output_tokens','total_tokens'];
const deltaFields=['inputTokens','cachedInputTokens','uncachedInputTokens','outputTokens','totalTokens'];
const sqlDelta=['delta_input','delta_cached','delta_uncached','delta_output','delta_total'];
const dailyFields=['input_tokens','cached_input_tokens','uncached_input_tokens','output_tokens','total_tokens'];
const statuses=new Set(['baseline','delta','partial','reset','gap','out-of-order','future','stale']);
const iso=n=>Number.isSafeInteger(n)&&n>=0?new Date(n).toISOString():null;
const stamp=v=>{const n=typeof v==='string'?Date.parse(v):NaN;return Number.isSafeInteger(n)&&n>=0?n:null;};
const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const text=(v,max=256)=>typeof v==='string'&&v.length>0&&v.length<=max&&v.isWellFormed()&&!/[\x00-\x1f\x7f]/.test(v)?v:null;
const add=(a,b)=>a===null?b:b===null?a:Number.isSafeInteger(a+b)?a+b:null;
const bad=message=>{throw Object.assign(new Error(message),{status:400});};
const segmentKey=(project,provider,model)=>crypto.createHash('sha256').update(JSON.stringify([project,provider,model])).digest('hex');
function clock(now){if(!Number.isSafeInteger(now)||now<0||now>8640000000000000)bad('Invalid usage clock');return now;}
function retentionOf(v={}){const r={...DEFAULT_USAGE_RETENTION,...v};for(const k of Object.keys(DEFAULT_USAGE_RETENTION))if(!Number.isSafeInteger(r[k])||r[k]<1)bad('Invalid usage retention');if(r.windowMs>120000||r.maxGapMs>300000||r.maxRawObservations>200000||r.maxSampleObservations>200000||r.maxAccountObservations>200000||r.maxDailyRows>200000||r.maxBaselines>200000)bad('Invalid usage retention');return r;}
function scope({hostIds=null,projectIds=null,sessionId=null}={},alias=''){
 const conditions=[],args=[],prefix=alias?alias+'.':'';
 for(const [key,values] of [['host_id',hostIds],['project',projectIds]])if(values!==null){if(!Array.isArray(values)||values.length>256||values.some(v=>!text(v)))bad('Invalid usage scope');conditions.push(values.length?`${prefix}${key} IN (${values.map(()=>'?').join(',')})`:'0');args.push(...values);}
 if(sessionId!==null){if(!text(sessionId))bad('Invalid usage session');conditions.push(`${prefix}session_id=?`);args.push(sessionId);}
 return {where:conditions.join(' AND ')||'1',args,scoped:hostIds!==null||projectIds!==null||sessionId!==null};
}
function metadata(db){return Object.fromEntries(db.prepare('SELECT key,value FROM usage_meta').all().map(r=>[r.key,r.value]));}
function metaSet(db,key,value){db.prepare('INSERT INTO usage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value));}
function counters(db){return {observations:db.prepare('SELECT COUNT(*) n FROM usage_observations').get().n,accounts:db.prepare('SELECT COUNT(*) n FROM account_usage_observations').get().n,daily:db.prepare('SELECT COUNT(*) n FROM usage_daily').get().n,accountDaily:db.prepare('SELECT COUNT(*) n FROM account_usage_daily').get().n,baselines:db.prepare('SELECT COUNT(*) n FROM usage_baselines').get().n};}

export function installUsageSchema(db){
 db.exec(`CREATE TABLE IF NOT EXISTS usage_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS usage_baselines(host_id TEXT NOT NULL,session_id TEXT NOT NULL,project TEXT,provider TEXT,model TEXT,source_ms INTEGER NOT NULL,received_ms INTEGER NOT NULL,input_tokens INTEGER,cached_input_tokens INTEGER,output_tokens INTEGER,total_tokens INTEGER,has_delta INTEGER NOT NULL,PRIMARY KEY(host_id,session_id));
 CREATE INDEX IF NOT EXISTS usage_baseline_received ON usage_baselines(received_ms);
 CREATE INDEX IF NOT EXISTS usage_baseline_scope ON usage_baselines(host_id,project,source_ms);
 CREATE TABLE IF NOT EXISTS usage_observations(sequence INTEGER PRIMARY KEY AUTOINCREMENT,host_id TEXT NOT NULL,session_id TEXT NOT NULL,project TEXT,provider TEXT,model TEXT,source_ms INTEGER NOT NULL,received_ms INTEGER NOT NULL,interval_ms INTEGER,status TEXT NOT NULL,input_tokens INTEGER,cached_input_tokens INTEGER,output_tokens INTEGER,total_tokens INTEGER,delta_input INTEGER,delta_cached INTEGER,delta_uncached INTEGER,delta_output INTEGER,delta_total INTEGER,UNIQUE(host_id,session_id,source_ms));
 CREATE INDEX IF NOT EXISTS usage_observation_source ON usage_observations(source_ms,sequence);
 CREATE INDEX IF NOT EXISTS usage_observation_received ON usage_observations(received_ms,sequence);
 CREATE INDEX IF NOT EXISTS usage_observation_scope ON usage_observations(host_id,project,sequence);
 CREATE TABLE IF NOT EXISTS usage_daily(host_id TEXT NOT NULL,session_id TEXT NOT NULL,segment_key TEXT NOT NULL,project TEXT,provider TEXT,model TEXT,day TEXT NOT NULL,input_tokens INTEGER,cached_input_tokens INTEGER,uncached_input_tokens INTEGER,output_tokens INTEGER,total_tokens INTEGER,observations INTEGER NOT NULL,partial_observations INTEGER NOT NULL,overflow INTEGER NOT NULL,first_ms INTEGER NOT NULL,last_ms INTEGER NOT NULL,PRIMARY KEY(host_id,session_id,day,segment_key));
 CREATE INDEX IF NOT EXISTS usage_daily_day ON usage_daily(day);
 CREATE INDEX IF NOT EXISTS usage_daily_scope ON usage_daily(host_id,project,day);
 CREATE TABLE IF NOT EXISTS account_usage_observations(sequence INTEGER PRIMARY KEY AUTOINCREMENT,host_id TEXT NOT NULL,sample_key TEXT NOT NULL,observed_ms INTEGER,limits_ms INTEGER,usage_ms INTEGER,received_ms INTEGER NOT NULL,account_identity TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(host_id,sample_key));
 CREATE INDEX IF NOT EXISTS account_native_digest ON account_usage_observations(account_identity,json_extract(payload,'$.nativeAnalytics.digest'),sequence) WHERE json_extract(payload,'$.nativeAnalytics.data') IS NOT NULL;
 CREATE INDEX IF NOT EXISTS account_usage_received ON account_usage_observations(received_ms,sequence);
 CREATE INDEX IF NOT EXISTS account_usage_identity_time ON account_usage_observations(account_identity,limits_ms,sequence);
 CREATE TABLE IF NOT EXISTS account_usage_daily(host_id TEXT NOT NULL,account_identity TEXT NOT NULL,day TEXT NOT NULL,tokens INTEGER NOT NULL,observed_ms INTEGER NOT NULL,received_ms INTEGER NOT NULL,PRIMARY KEY(host_id,account_identity,day));
 CREATE INDEX IF NOT EXISTS account_usage_daily_day ON account_usage_daily(day);`);
 const insert=db.prepare('INSERT OR IGNORE INTO usage_meta(key,value) VALUES(?,?)');
 for(const [k,v] of Object.entries({schemaVersion:'1',streamGeneration:crypto.randomUUID(),lastTrimMs:'0',trimmedRaw:'0',trimmedDaily:'0',trimmedBaselines:'0',burnLossThroughMs:'0',firstRecordedAt:'0',...counters(db)}))insert.run(k,String(v));
 installUsageArchive(db);
 if(metadata(db).schemaVersion==='1'){
  // Verify original V1 custody before adding anything. Preserve all existing
  // in-flight bytes, receipts and heads inside the same atomic migration.
  validateUsageDatabase(db);validateArchiveDatabase(db);
  db.exec('SAVEPOINT usage_samples_migration');try{installUsageSamples(db);installUsageSampleArchive(db);metaSet(db,'schemaVersion','2');db.exec('RELEASE usage_samples_migration');}catch(error){db.exec('ROLLBACK TO usage_samples_migration; RELEASE usage_samples_migration');throw error;}
 }else if(metadata(db).schemaVersion==='2')validateUsageSamples(db,{rows:false});else throw new Error('Unsupported usage database version');
}
export function rotateUsageGeneration(db){if(!db.prepare("SELECT 1 n FROM sqlite_master WHERE type='table' AND name='usage_meta'").get())return null;const generation=crypto.randomUUID();metaSet(db,'streamGeneration',generation);return generation;}

function trimUsage(db,now,r,m){
 const total=Number(m.observations)+Number(m.accounts),dailyTotal=Number(m.daily)+Number(m.accountDaily);
 const samples=db.prepare('SELECT COUNT(*) n FROM usage_samples_v2').get().n;
 let sampleRemoved=0;
 if(samples>r.maxSampleObservations)sampleRemoved=db.prepare(`DELETE FROM usage_samples_v2 WHERE sample_key IN (SELECT s.sample_key FROM usage_archive_heads AS h JOIN usage_samples_v2 AS s ON s.sample_key=json_extract(h.row_key,'$.sample_key') WHERE h.source_table='usage_samples_v2' AND h.ack_batch IS NOT NULL AND ${archiveDeletionGuard('usage_samples_v2','s')} LIMIT ?)`).run(Math.min(1000,samples-r.maxSampleObservations)).changes;
 if(now-Number(m.lastTrimMs)<r.trimIntervalMs&&now>=Number(m.lastTrimMs)&&total<=r.maxRawObservations&&Number(m.accounts)<=r.maxAccountObservations&&dailyTotal<=r.maxDailyRows&&Number(m.baselines)<=r.maxBaselines){if(sampleRemoved)metaSet(db,'trimmedRaw',Number(m.trimmedRaw)+sampleRemoved);return;}
 let trimmedRaw=sampleRemoved,trimmedDaily=0,trimmedBaselines=0;
 let burnLoss=Number(m.burnLossThroughMs||0);
 const ageLoss=db.prepare('SELECT MAX(source_ms) n FROM usage_observations WHERE '+archiveDeletionGuard('usage_observations')+' AND received_ms<? AND source_ms>? AND source_ms<=? AND received_ms>? AND received_ms<=? AND status IN (\'delta\',\'partial\')').get(now-r.rawAgeMs,now-r.windowMs,now,now-r.windowMs,now).n;
 if(ageLoss!==null)burnLoss=Math.max(burnLoss,ageLoss);
 for(const table of ['usage_observations','account_usage_observations'])trimmedRaw+=db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE received_ms<? AND ${archiveDeletionGuard(table)} ORDER BY received_ms LIMIT 1000)`).run(now-r.rawAgeMs).changes;
 trimmedRaw+=db.prepare(`DELETE FROM usage_samples_v2 WHERE sample_key IN (SELECT sample_key FROM usage_samples_v2 WHERE received_ms<? AND ${archiveDeletionGuard('usage_samples_v2')} ORDER BY received_ms,sample_key LIMIT 1000)`).run(now-r.rawAgeMs).changes;
 const accountCount=db.prepare('SELECT COUNT(*) n FROM account_usage_observations').get().n;
 if(accountCount>r.maxAccountObservations)trimmedRaw+=db.prepare('DELETE FROM account_usage_observations WHERE sequence IN (SELECT sequence FROM account_usage_observations WHERE '+archiveDeletionGuard('account_usage_observations')+' ORDER BY received_ms,sequence LIMIT ?)').run(Math.min(1000,accountCount-r.maxAccountObservations)).changes;
 const rawCount=db.prepare('SELECT (SELECT COUNT(*) FROM usage_observations)+(SELECT COUNT(*) FROM account_usage_observations) n').get().n;
 if(rawCount>r.maxRawObservations){
  const remove=db.prepare(`SELECT kind,sequence,source_ms,received_ms,status FROM (SELECT 'session' kind,sequence,source_ms,received_ms,status FROM usage_observations WHERE ${archiveDeletionGuard('usage_observations')} UNION ALL SELECT 'account' kind,sequence,NULL source_ms,received_ms,NULL status FROM account_usage_observations WHERE ${archiveDeletionGuard('account_usage_observations')}) ORDER BY received_ms,sequence LIMIT ?`).all(Math.min(1000,rawCount-r.maxRawObservations));
  const a=db.prepare('DELETE FROM usage_observations WHERE sequence=?'),b=db.prepare('DELETE FROM account_usage_observations WHERE sequence=?');for(const row of remove){if(row.kind==='session'&&['delta','partial'].includes(row.status)&&row.source_ms>now-r.windowMs&&row.source_ms<=now&&row.received_ms>now-r.windowMs&&row.received_ms<=now)burnLoss=Math.max(burnLoss,row.source_ms);trimmedRaw+=(row.kind==='session'?a:b).run(row.sequence).changes;}
 }
 const day=new Date(Math.max(0,now-r.dailyAgeMs)).toISOString().slice(0,10);
 for(const table of ['usage_daily','account_usage_daily'])trimmedDaily+=db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE day<? AND ${archiveDeletionGuard(table)} ORDER BY day LIMIT 1000)`).run(day).changes;
 const dailyCount=db.prepare('SELECT (SELECT COUNT(*) FROM usage_daily)+(SELECT COUNT(*) FROM account_usage_daily) n').get().n;
 if(dailyCount>r.maxDailyRows){
  const remove=db.prepare(`SELECT kind,host_id,session_id,segment_key,account_identity,day FROM (SELECT 'session' kind,host_id,session_id,segment_key,NULL account_identity,day FROM usage_daily WHERE ${archiveDeletionGuard('usage_daily')} UNION ALL SELECT 'account' kind,host_id,NULL session_id,NULL segment_key,account_identity,day FROM account_usage_daily WHERE ${archiveDeletionGuard('account_usage_daily')}) ORDER BY day,host_id LIMIT ?`).all(Math.min(1000,dailyCount-r.maxDailyRows));
  const a=db.prepare('DELETE FROM usage_daily WHERE host_id=? AND session_id=? AND day=? AND segment_key=?'),b=db.prepare('DELETE FROM account_usage_daily WHERE host_id=? AND account_identity=? AND day=?');for(const row of remove)trimmedDaily+=(row.kind==='session'?a.run(row.host_id,row.session_id,row.day,row.segment_key):b.run(row.host_id,row.account_identity,row.day)).changes;
 }
 trimmedBaselines+=db.prepare('DELETE FROM usage_baselines WHERE rowid IN (SELECT rowid FROM usage_baselines WHERE received_ms<? AND '+archiveDeletionGuard('usage_baselines')+' ORDER BY received_ms LIMIT 1000)').run(now-r.rawAgeMs).changes;
 const baselineCount=db.prepare('SELECT COUNT(*) n FROM usage_baselines').get().n;
 if(baselineCount>r.maxBaselines)trimmedBaselines+=db.prepare('DELETE FROM usage_baselines WHERE rowid IN (SELECT rowid FROM usage_baselines WHERE '+archiveDeletionGuard('usage_baselines')+' ORDER BY received_ms LIMIT ?)').run(Math.min(1000,baselineCount-r.maxBaselines)).changes;
 for(const [key,value] of Object.entries({...counters(db),lastTrimMs:now,burnLossThroughMs:burnLoss,trimmedRaw:Number(m.trimmedRaw)+trimmedRaw,trimmedDaily:Number(m.trimmedDaily)+trimmedDaily,trimmedBaselines:Number(m.trimmedBaselines)+trimmedBaselines}))metaSet(db,key,value);
}

function dailyRecord(db,row,deltas,prepared){
 const day=new Date(row.source_ms).toISOString().slice(0,10),segment=segmentKey(row.project,row.provider,row.model),previous=(prepared.sessionGet??=db.prepare('SELECT * FROM usage_daily WHERE host_id=? AND session_id=? AND day=? AND segment_key=?')).get(row.host_id,row.session_id,day,segment);
 const overflow=previous?.overflow===1||dailyFields.some((k,i)=>previous?.[k]!==null&&previous?.[k]!==undefined&&deltas[i]!==null&&!Number.isSafeInteger(previous[k]+deltas[i]));
 const values=dailyFields.map((_,i)=>overflow?null:previous?add(previous[dailyFields[i]],deltas[i]):deltas[i]);
 const known=deltas.some(v=>v!==null);if(!known)return 0;
 (prepared.sessionSet??=db.prepare(`INSERT INTO usage_daily(host_id,session_id,segment_key,project,provider,model,day,${dailyFields.join(',')},observations,partial_observations,overflow,first_ms,last_ms) VALUES(${Array(17).fill('?').join(',')}) ON CONFLICT(host_id,session_id,day,segment_key) DO UPDATE SET ${dailyFields.map(k=>k+'=excluded.'+k).join(',')},observations=excluded.observations,partial_observations=excluded.partial_observations,overflow=excluded.overflow,first_ms=excluded.first_ms,last_ms=excluded.last_ms`)).run(row.host_id,row.session_id,segment,row.project,row.provider,row.model,day,...values,(previous?.observations||0)+1,(previous?.partial_observations||0)+(row.status==='partial'||overflow?1:0),overflow?1:0,previous?.first_ms??row.source_ms,row.source_ms);
 return previous?0:1;
}

// Invoke inside the caller's existing transaction. A retry inserts neither a
// second observation nor a second daily delta, and cannot renew source freshness.
export function recordUsage(db,{hostId,state={},now=Date.now(),retention={}}={}){
 clock(now);if(!text(hostId))bad('Invalid usage host');const r=retentionOf(retention),m=metadata(db);
 const result={observations:0,accounts:0,daily:0,accountDaily:0,baselines:0,excluded:0,invalid:0,sourceRevisions:0};
 const hostRole=state.coverage?.role??state.host?.role??state.role;
 const sessions=Array.isArray(state.sessions)?state.sessions:[];if(sessions.length>4096)bad('Usage session bound exceeded');
 // Prepare daily queries only when used, and retain them only for this operation.
 const dailyStatements={};
 const insert=db.prepare(`INSERT OR IGNORE INTO usage_observations(host_id,session_id,project,provider,model,source_ms,received_ms,interval_ms,status,${fields.join(',')},${sqlDelta.join(',')}) VALUES(${Array(18).fill('?').join(',')})`);
 const baselineGet=db.prepare('SELECT * FROM usage_baselines WHERE host_id=? AND session_id=?');
 const observationGet=db.prepare('SELECT * FROM usage_observations WHERE host_id=? AND session_id=? AND source_ms=?');
 const baselineSet=db.prepare(`INSERT INTO usage_baselines(host_id,session_id,project,provider,model,source_ms,received_ms,${fields.join(',')},has_delta) VALUES(${Array(12).fill('?').join(',')}) ON CONFLICT(host_id,session_id) DO UPDATE SET project=excluded.project,provider=excluded.provider,model=excluded.model,source_ms=excluded.source_ms,received_ms=excluded.received_ms,${fields.map(k=>k+'=excluded.'+k).join(',')},has_delta=excluded.has_delta`);
 for(const s of sessions){
  if(hostRole==='execution-target'||s?.forkedFrom||s?.role==='execution-target'||s?.role==='execution-job'){result.excluded++;continue;}
  const id=text(s?.id),source=stamp(s?.usageObservedAt),values=fields.map(k=>count(s?.tokens?.[k]));
  if(!id||source===null||values.every(v=>v===null)){result.invalid++;continue;}
  const project=text(s.project),provider=text(s.provider,128),model=text(s.model,128);
  // Invalid cache relationships are unknown rather than negative uncached work.
  if(values[0]!==null&&values[1]!==null&&values[1]>values[0])values[1]=null;
  const previous=baselineGet.get(hostId,id);
  if(previous&&source===previous.source_ms&&previous.project===project&&previous.provider===provider&&previous.model===model&&fields.every((k,i)=>previous[k]===values[i]))continue;
  let status='baseline',interval=null,deltas=Array(5).fill(null),advance=true;
  if(source>now){status='future';advance=false;}
  else if(now-source>r.maxGapMs){status='stale';advance=false;}
  else if(previous&&source<=previous.source_ms){status='out-of-order';advance=false;}
  else if(previous&&(previous.project!==project||previous.provider!==provider||previous.model!==model))status='baseline';
  else if(previous){
   interval=source-previous.source_ms;
   if(interval>r.maxGapMs||now-previous.received_ms>r.maxGapMs||now<previous.received_ms)status='gap';
   else if(fields.some((k,i)=>values[i]!==null&&previous[k]!==null&&values[i]<previous[k]))status='reset';
   else {
    const d=fields.map((k,i)=>values[i]!==null&&previous[k]!==null?values[i]-previous[k]:null);
    if(d[0]!==null&&d[1]!==null&&d[1]>d[0])d[1]=null;
    const uncached=d[0]!==null&&d[1]!==null&&d[0]>=d[1]?d[0]-d[1]:null;
    deltas=[d[0],d[1],uncached,d[2],d[3]];
    status=deltas.every(v=>v!==null)?'delta':'partial';
   }
  }
  const row={host_id:hostId,session_id:id,project,provider,model,source_ms:source,received_ms:now,interval_ms:interval,status};
  // Even an ignored AUTOINCREMENT insert writes sqlite_sequence. Old source
  // readings can recur on every poll without advancing a baseline; look up the
  // exact source identity first so a duplicate poll stays a read-only operation.
  const existing=observationGet.get(hostId,id,source);
  const added=existing?0:insert.run(hostId,id,project,provider,model,source,now,interval,status,...values,...deltas).changes;
  if(!added){
   // Source timestamps are not unique report identities. Preserve a changed
   // same-time reading without turning its zero interval into token burn.
   if(existing&&(existing.project!==project||existing.provider!==provider||existing.model!==model||fields.some((k,i)=>existing[k]!==values[i])))result.sourceRevisions+=recordSourceVersion(db,{table:'usage_observations',row:{...existing,project,provider,model,received_ms:now,interval_ms:null,status:'out-of-order',...Object.fromEntries(fields.map((k,i)=>[k,values[i]])),...Object.fromEntries(sqlDelta.map(k=>[k,null]))}});
   if(previous&&source===previous.source_ms&&source<=now&&now-source<=r.maxGapMs)baselineSet.run(hostId,id,project,provider,model,source,now,...values,0);
   continue;
  }
  result.observations++;
  // A bit per measured delta preserves unknown fields during a quiet window.
  // A source that has never reported cache/output cannot become a zero meter.
  if(advance||previous&&source===previous.source_ms&&source<=now&&now-source<=r.maxGapMs){const mask=['delta','partial'].includes(status)?deltas.reduce((mask,value,i)=>value===null?mask:mask|(1<<i),0):0;baselineSet.run(hostId,id,project,provider,model,source,now,...values,mask);if(!previous)result.baselines++;}
  if(['delta','partial'].includes(status))result.daily+=dailyRecord(db,row,deltas,dailyStatements);
 }
 if(hostRole!=='execution-target'&&state.accountUsage){
  let account;try{account=sanitizeAccountUsage(state.accountUsage);}catch{result.invalid++;}
  if(account){
   // Repeating hundreds of daily buckets every minute would dominate Pi disk.
   // Their source totals live in account_usage_daily; snapshots keep metadata.
   const observed=stamp(account.observedAt),limits=stamp(account.limitsObservedAt),usage=stamp(account.usageObservedAt);
   // Undated source buckets cannot receive an invented observation timestamp.
   // Keep that exceptional full report instead of losing its source values.
   const payload=JSON.stringify({...account,dailyUsageBuckets:usage===null?account.dailyUsageBuckets:null}),key=crypto.createHash('sha256').update(payload).digest('hex'),identity=account.accountKey??'unlinked';
   if(Buffer.byteLength(payload)>131072){result.invalid++;}
   else {
   const added=db.prepare('INSERT OR IGNORE INTO account_usage_observations(host_id,sample_key,observed_ms,limits_ms,usage_ms,received_ms,account_identity,payload) VALUES(?,?,?,?,?,?,?,?)').run(hostId,key,observed,limits,usage,now,identity,payload).changes;
   result.accounts+=added;
   if(usage!==null)for(const day of account.dailyUsageBuckets||[]){
    const previous=(dailyStatements.accountGet??=db.prepare('SELECT observed_ms,tokens FROM account_usage_daily WHERE host_id=? AND account_identity=? AND day=?')).get(hostId,identity,day.startDate);
    if(usage>now||Date.parse(day.startDate+'T00:00:00Z')>now||previous&&previous.observed_ms>usage){result.sourceRevisions+=recordSourceVersion(db,{table:'account_usage_daily',row:{host_id:hostId,account_identity:identity,day:day.startDate,tokens:day.tokens,observed_ms:usage,received_ms:now}});continue;}
    if(previous&&previous.observed_ms===usage&&previous.tokens===day.tokens)continue;
    (dailyStatements.accountSet??=db.prepare('INSERT INTO account_usage_daily(host_id,account_identity,day,tokens,observed_ms,received_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(host_id,account_identity,day) DO UPDATE SET tokens=excluded.tokens,observed_ms=excluded.observed_ms,received_ms=excluded.received_ms')).run(hostId,identity,day.startDate,day.tokens,usage,now);if(!previous)result.accountDaily++;
   }
   }
  }
 }
 if(result.observations||result.accounts||result.accountDaily){if(!Number(m.firstRecordedAt))metaSet(db,'firstRecordedAt',now);for(const k of ['observations','accounts','daily','accountDaily','baselines']){m[k]=String(Number(m[k]||0)+result[k]);metaSet(db,k,m[k]);}}
 trimUsage(db,now,r,m);return result;
}

function observation(row){return {sequence:row.sequence,id:'usage:'+row.sequence,hostId:row.host_id,sessionId:row.session_id,project:row.project,provider:row.provider,model:row.model,sourceAt:iso(row.source_ms),receivedAt:iso(row.received_ms),intervalMs:row.interval_ms,status:row.status,...Object.fromEntries(deltaFields.map((k,i)=>[k,row[sqlDelta[i]]])),counters:{inputTokens:row.input_tokens,cachedInputTokens:row.cached_input_tokens,outputTokens:row.output_tokens,totalTokens:row.total_tokens}};}
const sumSql=sqlDelta.map(k=>`SUM(CAST(${k} AS REAL)) AS ${k}`).join(',');
function aggregateTotals(row,windowMs){const values=Object.fromEntries(deltaFields.map((k,i)=>[k,count(row[sqlDelta[i]])]));return {...values,inputPerSecond:values.inputTokens===null?null:values.inputTokens/(windowMs/1000),cachedInputPerSecond:values.cachedInputTokens===null?null:values.cachedInputTokens/(windowMs/1000),uncachedInputPerSecond:values.uncachedInputTokens===null?null:values.uncachedInputTokens/(windowMs/1000),outputPerSecond:values.outputTokens===null?null:values.outputTokens/(windowMs/1000)};}

export function readUsage(db,{now=Date.now(),hostIds=null,projectIds=null,sessionId=null,limit=100,afterSequence=0,includeAccount=false,retention={}}={}){
 clock(now);if(!Number.isSafeInteger(limit)||limit<1||limit>200)bad('Invalid usage limit');if(!Number.isSafeInteger(afterSequence)||afterSequence<0)bad('Invalid usage cursor');
 const r=retentionOf(retention),s=scope({hostIds,projectIds,sessionId}),m=metadata(db),start=now-r.windowMs;
 const latestSequence=db.prepare(`SELECT COALESCE(MAX(sequence),0) n FROM usage_observations WHERE ${s.where}`).get(...s.args).n;
 const firstSequence=db.prepare(`SELECT MIN(sequence) n FROM usage_observations WHERE ${s.where}`).get(...s.args).n??null;
 const raw=db.prepare(`SELECT * FROM usage_observations WHERE ${s.where} AND sequence>? ORDER BY sequence ${afterSequence===0?'DESC':'ASC'} LIMIT ?`).all(...s.args,afterSequence,limit+1);
 const observations=raw.slice(0,limit).map(observation);if(afterSequence===0)observations.reverse();
 const caughtUp=afterSequence===0||raw.length<=limit,nextCursor=observations.at(-1)?.sequence??afterSequence;
 const recentWhere=`source_ms>? AND source_ms<=? AND received_ms>? AND received_ms<=? AND status IN ('delta','partial') AND ${s.where}`,recentArgs=[start,now,start,now,...s.args];
 // These sums cover every matching observation, independently of the bounded
 // animation page. REAL avoids SQLite int64 overflow; unsafe results are null.
 const pairedWhere='delta_input IS NOT NULL AND delta_cached IS NOT NULL AND delta_cached<=delta_input';
 // Omitting ELSE preserves NULL sums when no comparable pair exists; COUNT is 0.
 const aggregate=db.prepare(`SELECT COUNT(*) n,${sumSql},MAX(source_ms) source,MAX(received_ms) received,SUM(CASE WHEN status='partial' THEN 1 ELSE 0 END) partial,COUNT(CASE WHEN ${pairedWhere} THEN 1 END) paired_rows,SUM(CASE WHEN ${pairedWhere} THEN CAST(delta_input AS REAL) END) paired_input,SUM(CASE WHEN ${pairedWhere} THEN CAST(delta_cached AS REAL) END) paired_cached FROM usage_observations WHERE ${recentWhere}`).get(...recentArgs);
 const pairedInput=count(aggregate.paired_input),pairedCached=count(aggregate.paired_cached),pairedRows=aggregate.paired_rows,pairValid=pairedInput!==null&&pairedCached!==null&&pairedInput>0;
 const ratios={cacheHit:{value:pairValid?pairedCached/pairedInput:null,numerator:pairedCached,denominator:pairedInput,comparableRows:pairedRows,excludedRows:aggregate.n-pairedRows,classification:'derived',method:'ratio-of-sums',reason:pairValid?null:'no-comparable-denominator'},newInputFraction:{value:pairValid?(pairedInput-pairedCached)/pairedInput:null,numerator:pairValid?pairedInput-pairedCached:null,denominator:pairedInput,comparableRows:pairedRows,excludedRows:aggregate.n-pairedRows,classification:'derived',method:'ratio-of-sums',reason:pairValid?null:'no-comparable-denominator'}};
 const dimensionSql=['project','provider','model'].map(k=>`CASE WHEN COUNT(DISTINCT COALESCE(${k},char(0)))=1 THEN MAX(${k}) ELSE NULL END ${k}`).join(',');
 const mixedSql=['project','provider','model'].map(k=>`COUNT(DISTINCT COALESCE(${k},char(0)))>1`).join(' OR ');
 const workerRows=db.prepare(`SELECT host_id,session_id,${dimensionSql},(${mixedSql}) mixed_dimensions,COUNT(*) n,${sumSql},MAX(source_ms) source,MAX(received_ms) received FROM usage_observations WHERE ${recentWhere} GROUP BY host_id,session_id ORDER BY source DESC,host_id,session_id LIMIT 201`).all(...recentArgs);
 const workerCount=db.prepare(`SELECT COUNT(*) n FROM (SELECT host_id,session_id FROM usage_observations WHERE ${recentWhere} GROUP BY host_id,session_id)`).get(...recentArgs).n;
 const fresh=`source_ms<=${now} AND source_ms>=${now-r.maxGapMs} AND received_ms<=${now} AND received_ms>=${now-r.maxGapMs}`;
 const baselineCounts=db.prepare(`SELECT COUNT(*) n,SUM(CASE WHEN ${fresh} THEN 1 ELSE 0 END) fresh,SUM(CASE WHEN has_delta=0 AND ${fresh} THEN 1 ELSE 0 END) warming,${deltaFields.map((_,i)=>`SUM(CASE WHEN (has_delta & ${1<<i})<>0 AND ${fresh} THEN 1 ELSE 0 END) known_${i}`).join(',')},MAX(source_ms) source,MAX(received_ms) received FROM usage_baselines WHERE ${s.where}`).get(...s.args);
 const problemRows=db.prepare(`SELECT status,COUNT(*) n FROM usage_observations WHERE received_ms>=? AND received_ms<=? AND ${s.where} AND status NOT IN ('delta') GROUP BY status`).all(start,now,...s.args);
 const problems=Object.fromEntries(problemRows.map(row=>[row.status,row.n]));
 const workers=workerRows.slice(0,200).map(row=>({hostId:row.host_id,sessionId:row.session_id,project:row.project,provider:row.provider,model:row.model,mixedDimensions:row.mixed_dimensions===1,observedAt:iso(row.source),receivedAt:iso(row.received),observations:row.n,...aggregateTotals(row,r.windowMs)}));
 const total=aggregateTotals(aggregate,r.windowMs),anyPartial=aggregate.partial>0||Object.values(total).some(v=>v===null);
 const retentionWindowIncomplete=Number(m.burnLossThroughMs)>start&&Number(m.burnLossThroughMs)<=now;
 let status=aggregate.n?(anyPartial||retentionWindowIncomplete||baselineCounts.warming>0||Object.keys(problems).some(k=>!['baseline'].includes(k))?'partial':'observed'):baselineCounts.fresh?(baselineCounts.warming===baselineCounts.fresh?'baseline':'idle'):baselineCounts.n?'stale':'unavailable';
 // No observation in a window after a complete warm-up is a sampled zero;
 // a first baseline, missing data or stale source remains unknown.
 if(!aggregate.n&&status==='idle'){
  for(let i=0;i<deltaFields.length;i++)total[deltaFields[i]]=baselineCounts['known_'+i]===baselineCounts.fresh?0:null;
  for(const [rate,k] of [['inputPerSecond','inputTokens'],['cachedInputPerSecond','cachedInputTokens'],['uncachedInputPerSecond','uncachedInputTokens'],['outputPerSecond','outputTokens']])total[rate]=total[k]===null?null:0;
  if(retentionWindowIncomplete||deltaFields.some(k=>total[k]===null))status='partial';
 }
 const coverage={complete:false,sampled:true,rateBasis:`Accepted counter increases observed in the last ${r.windowMs/1000} seconds divided by ${r.windowMs/1000}; batches are not provider streaming timing.`,windowObservationCount:aggregate.n,retentionWindowIncomplete,scanLimited:false,workersTruncated:workerRows.length>200,baselineSessions:baselineCounts.n,freshBaselineSessions:baselineCounts.fresh||0,warmingSessions:baselineCounts.warming||0,problems,copiedSessionsMayOverlap:true,forksExcluded:true};
 const burn={status,windowMs:r.windowMs,maxGapMs:r.maxGapMs,observedAt:iso(aggregate.n?aggregate.source:baselineCounts.source),receivedAt:iso(aggregate.n?aggregate.received:baselineCounts.received),lastSequence:latestSequence,latestSequence,streamGeneration:m.streamGeneration,workerCount,workers,...total,ratios,complete:false,coverage};
 const dailyRows=db.prepare(`SELECT * FROM usage_daily WHERE ${s.where} ORDER BY day DESC,host_id,session_id LIMIT ?`).all(...s.args,limit+1);
 const daily=dailyRows.slice(0,limit).map(row=>({hostId:row.host_id,sessionId:row.session_id,project:row.project,provider:row.provider,model:row.model,day:row.day,...Object.fromEntries(deltaFields.map((k,i)=>[k,row[dailyFields[i]]])),observations:row.observations,partialObservations:row.partial_observations,overflow:row.overflow===1,firstAt:iso(row.first_ms),lastAt:iso(row.last_ms)}));
 const accountAllowed=includeAccount&&projectIds===null&&sessionId===null,accountScope=scope({hostIds});
 const storage={scope:s.scoped?'authorized observations':'fleet',schemaVersion:1,rawRetentionDays:r.rawAgeMs/86400000,maxRawObservations:r.maxRawObservations,maxAccountObservations:r.maxAccountObservations,dailyRetentionDays:r.dailyAgeMs/86400000,maxDailyRows:r.maxDailyRows,maxBaselines:r.maxBaselines,completeHistory:false,retainedObservations:db.prepare(`SELECT COUNT(*) n FROM usage_observations WHERE ${s.where}`).get(...s.args).n,retainedDailyRows:db.prepare(`SELECT COUNT(*) n FROM usage_daily WHERE ${s.where}`).get(...s.args).n,retainedBaselines:baselineCounts.n,firstSequence,latestSequence,limitsApplyAcrossFleet:true,accountHistoryIncluded:accountAllowed,archiveRequiredBeforeEviction:true,retentionMode:'verified-archive-only',notes:'Raw and daily limits are hot-cache targets only. Unarchived versions are preserved even beyond these targets. Full usage history is retained in lossless archive batches; account daily values are source totals and are not added across machines.'};
 if(!s.scoped){storage.firstRecordedAt=Number(m.firstRecordedAt)>0?iso(Number(m.firstRecordedAt)):null;storage.trimmedRaw=Number(m.trimmedRaw);storage.trimmedDaily=Number(m.trimmedDaily);storage.trimmedBaselines=Number(m.trimmedBaselines);}
 storage.schemaVersion=Number(m.schemaVersion);storage.maxSampleObservations=r.maxSampleObservations;
 const response={burn,observations,daily,...(includeAccount&&projectIds===null&&sessionId===null?{archive:archiveStatus(db)}:{archive:{status:'restricted',preservation:'Unarchived records are protected from eviction.'}}),streamGeneration:m.streamGeneration,latestSequence,nextCursor:caughtUp?latestSequence:nextCursor,caughtUp,observationsTruncated:raw.length>limit,gap:afterSequence>latestSequence?'cursor-ahead':afterSequence>0&&firstSequence!==null&&afterSequence<firstSequence-1?'retention':null,dailyTruncated:dailyRows.length>limit,storage};
 if(accountAllowed){
  storage.retainedAccountObservations=db.prepare(`SELECT COUNT(*) n FROM account_usage_observations WHERE ${accountScope.where}`).get(...accountScope.args).n;storage.retainedAccountDailyRows=db.prepare(`SELECT COUNT(*) n FROM account_usage_daily WHERE ${accountScope.where}`).get(...accountScope.args).n;
  response.accountObservations=db.prepare(`SELECT sequence,host_id,observed_ms,limits_ms,usage_ms,received_ms,payload FROM account_usage_observations WHERE ${accountScope.where} ORDER BY sequence DESC LIMIT ?`).all(...accountScope.args,limit).map(row=>{const account=JSON.parse(row.payload);delete account.accountKey;delete account.nativeAnalytics;return {sequence:row.sequence,hostId:row.host_id,observedAt:iso(row.observed_ms),limitsObservedAt:iso(row.limits_ms),usageObservedAt:iso(row.usage_ms),receivedAt:iso(row.received_ms),accountUsage:account};});
  response.accountDaily=db.prepare(`SELECT host_id,day,tokens,observed_ms,received_ms FROM account_usage_daily WHERE ${accountScope.where} ORDER BY day DESC,host_id LIMIT ?`).all(...accountScope.args,limit).map(row=>({hostId:row.host_id,day:row.day,tokens:row.tokens,observedAt:iso(row.observed_ms),receivedAt:iso(row.received_ms)}));
 }
 return response;
}

// Used for backup/restore validation, never on the hot poll path. Unknown
// columns are a refusal rather than silently restoring an incompatible store.
export function validateUsageDatabase(db){
 const version=metadata(db).schemaVersion;
 for(const [table,columns] of Object.entries(USAGE_TABLE_COLUMNS)){if(['usage_samples_v2','usage_capture_cursors'].includes(table)&&version==='1'){if(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table))throw new Error('Unexpected V2 usage table');continue;}const actual=db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name);if(JSON.stringify(actual)!==JSON.stringify(columns))throw new Error('Invalid usage database schema: '+table);}
 const validTime=v=>Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
 const optionalTime=v=>v===null||validTime(v),optionalText=(v,max=256)=>v===null||text(v,max)!==null;
 const validDay=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
 const identity=v=>v==='unlinked'||typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
 const dimensions=row=>text(row.host_id)!==null&&text(row.session_id)!==null&&optionalText(row.project)&&optionalText(row.provider,128)&&optionalText(row.model,128);
 const countersValid=(row,keys)=>keys.every(k=>row[k]===null||count(row[k])!==null);
 const m=metadata(db),expected=['schemaVersion','lastTrimMs','trimmedRaw','trimmedDaily','trimmedBaselines','burnLossThroughMs','firstRecordedAt','observations','accounts','daily','accountDaily','baselines'];
 if(Object.keys(m).length!==expected.length+1||expected.some(k=>!Object.hasOwn(m,k)||!/^\d+$/.test(m[k])||!Number.isSafeInteger(Number(m[k])))||!['1','2'].includes(m.schemaVersion)||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(m.streamGeneration||''))throw new Error('Invalid usage metadata');
 for(const row of db.prepare('SELECT * FROM usage_baselines').iterate())if(!dimensions(row)||!validTime(row.source_ms)||!validTime(row.received_ms)||!countersValid(row,fields)||fields.every(k=>row[k]===null)||!Number.isSafeInteger(row.has_delta)||row.has_delta<0||row.has_delta>31||row.cached_input_tokens!==null&&row.input_tokens!==null&&row.cached_input_tokens>row.input_tokens)throw new Error('Invalid usage baseline');
 for(const row of db.prepare('SELECT * FROM usage_observations').iterate()){
  const accepted=['delta','partial'].includes(row.status);
  if(!dimensions(row)||!count(row.sequence)||!statuses.has(row.status)||!validTime(row.source_ms)||!validTime(row.received_ms)||row.interval_ms!==null&&(!Number.isSafeInteger(row.interval_ms)||row.interval_ms<1)||!countersValid(row,[...fields,...sqlDelta])||fields.every(k=>row[k]===null)||!accepted&&sqlDelta.some(k=>row[k]!==null)||accepted&&(row.interval_ms===null||row.interval_ms>300000)||row.status==='delta'&&sqlDelta.some(k=>row[k]===null)||row.delta_cached!==null&&row.delta_input!==null&&row.delta_cached>row.delta_input||row.delta_uncached!==null&&(row.delta_input===null||row.delta_cached===null||row.delta_uncached!==row.delta_input-row.delta_cached))throw new Error('Invalid usage observation');
 }
 for(const row of db.prepare('SELECT * FROM usage_daily').iterate())if(!dimensions(row)||row.segment_key!==segmentKey(row.project,row.provider,row.model)||!validDay(row.day)||!countersValid(row,dailyFields)||count(row.observations)===null||row.observations<1||count(row.partial_observations)===null||row.partial_observations>row.observations||![0,1].includes(row.overflow)||row.overflow&&dailyFields.some(k=>row[k]!==null)||!validTime(row.first_ms)||!validTime(row.last_ms)||row.first_ms>row.last_ms)throw new Error('Invalid usage daily history');
 for(const row of db.prepare('SELECT * FROM account_usage_observations').iterate()){
  let value;try{value=sanitizeAccountUsage(JSON.parse(row.payload));}catch{throw new Error('Invalid account usage history');}
  if(!text(row.host_id)||!count(row.sequence)||!identity(row.account_identity)||!optionalTime(row.observed_ms)||!optionalTime(row.limits_ms)||!optionalTime(row.usage_ms)||!validTime(row.received_ms)||JSON.stringify(value)!==row.payload||Buffer.byteLength(row.payload)>131072||crypto.createHash('sha256').update(row.payload).digest('hex')!==row.sample_key||(value.accountKey??'unlinked')!==row.account_identity||stamp(value.observedAt)!==row.observed_ms||stamp(value.limitsObservedAt)!==row.limits_ms||stamp(value.usageObservedAt)!==row.usage_ms)throw new Error('Invalid account usage history');
 }
 for(const row of db.prepare('SELECT * FROM account_usage_daily').iterate())if(!text(row.host_id)||!identity(row.account_identity)||!validDay(row.day)||count(row.tokens)===null||!validTime(row.observed_ms)||!validTime(row.received_ms))throw new Error('Invalid account daily history');
 const actual=counters(db);if(Object.entries(actual).some(([key,n])=>Number(m[key])!==n))throw new Error('Invalid usage retained counts');
 const samples=version==='2'?validateUsageSamples(db):null;
 if(version==='2')for(const row of db.prepare('SELECT * FROM usage_capture_cursors').iterate()){if(!text(row.host_id)||typeof row.payload!=='string'||Buffer.byteLength(row.payload)>16777216)throw new Error('Invalid private usage cursor');const cursor=validateUsageCursor(JSON.parse(row.payload));if(JSON.stringify(cursor)!==row.payload)throw new Error('Invalid private usage cursor');}
 return {schemaVersion:Number(version),...actual,...(samples!==null?{samples}:{})};
}
