// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {readNativeAnalytics} from './native-account-analytics.mjs';
import {readProjectActivity} from './project-activity.mjs';
import {readAllowanceHistory} from './allowance-history.mjs';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs/promises';
import {statSync,statfsSync} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {installUsageSchema,recordUsage,readUsage} from './usage-history.mjs';
import {bootstrapUsageArchive} from './usage-archive.mjs';
import {captureUsageSamples,readUsageSampleAnalytics} from './usage-samples.mjs';
import {validateUsageCursor} from './observer.mjs';
import {deriveQuotaPace} from './usage-insights.mjs';
import {installStorageAdmission,sourceOutstanding,requireStorageReserve,requireSourceCapacity,storageAdmissionOptions} from './storage-admission.mjs';
function scopePredicate(hostIds,projectIds){const conditions=[],args=[];if(Array.isArray(hostIds)){conditions.push(hostIds.length?'host_id IN ('+hostIds.map(()=>'?').join(',')+')':'0');args.push(...hostIds);}if(Array.isArray(projectIds)){conditions.push(projectIds.length?"(json_extract(payload,'$.projectBasis')='source-context' AND json_extract(payload,'$.project') IN ("+projectIds.map(()=>'?').join(',')+'))':'0');args.push(...projectIds);}return {where:conditions.length?conditions.join(' AND '):'1',args,scoped:conditions.length>0};}

// T3-inspired sequence/snapshot recovery; see THIRD_PARTY_NOTICES.md and the
// pinned reuse review. Native source IDs/timestamps remain independent of this cursor.
export class HistoryJournal {
 #keeper=null;
 // Keep WAL open for an explicitly owned server lifetime. Operation connections
 // stay isolated; FULL commit durability and SQLite's normal checkpoint budget
 // remain unchanged. The final owner releases and checkpoints on server close.
 retainConnection(){
  if(!this.#keeper){const db=new DatabaseSync(this.file);try{db.exec('PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL;');}catch(error){db.close();throw error;}this.#keeper={db,owners:0};}
  const keeper=this.#keeper;keeper.owners++;let released=false;
  return ()=>{if(released)return;released=true;if(--keeper.owners===0){this.#keeper=null;keeper.db.close();}};
 }
 static async open({directory,maxEvents=200000,maxBytes=96*1024*1024,maxAgeMs=7*86400000,storageAdmission={}}={}) {
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const journal=new HistoryJournal();Object.assign(journal,{file:path.join(directory,'history.sqlite'),maxEvents,maxBytes,maxAgeMs,storageAdmission:storageAdmissionOptions(storageAdmission)});
  journal.database(db=>{
   // Choose page reclamation before WAL initializes a new database. Existing
   // non-vacuum stores require explicit offline maintenance; startup never
   // performs an unbounded rewrite of an existing journal.
   db.exec('PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
   db.exec(`CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL,host_id TEXT NOT NULL,occurred_ms INTEGER NOT NULL,received_ms INTEGER NOT NULL,payload TEXT NOT NULL,bytes INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS event_time ON events(occurred_ms,sequence);
    CREATE INDEX IF NOT EXISTS event_host ON events(host_id,sequence);
    CREATE INDEX IF NOT EXISTS event_received ON events(received_ms,sequence);
    CREATE TABLE IF NOT EXISTS host_state(host_id TEXT PRIMARY KEY,payload TEXT NOT NULL);`);
   const insert=db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)');
   for(const [k,v] of Object.entries({epoch:crypto.randomUUID(),floor:'0',gapThrough:'0',retainedBytes:'0',retainedEvents:'0'}))insert.run(k,v);
   installUsageSchema(db);
   installStorageAdmission(db);
   bootstrapUsageArchive(db,{limit:1000});
  });await fs.chmod(journal.file,0o600);return journal;
 }
 database(fn){const db=new DatabaseSync(this.file);try{db.exec('PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL;');return fn(db);}finally{db.close();}}
 // Keep multi-query projections consistent with the independent archive writer.
 // The read transaction ends before any asynchronous response delivery.
 readDatabase(fn){return this.database(db=>{db.exec('BEGIN');try{const value=fn(db);db.exec('COMMIT');return value;}catch(error){if(db.isTransaction)try{db.exec('ROLLBACK');}catch{}throw error;}});}
 metadata(db){return Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all().map(r=>[r.key,r.value]));}
 statusIn(db,hostIds,projectIds){const m=this.metadata(db),scope=scopePredicate(hostIds,projectIds),scoped=scope.scoped,counts=scoped?db.prepare(`SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes,COALESCE(MAX(sequence),0) AS latest FROM events WHERE ${scope.where}`).get(...scope.args):null,latest=scoped?counts.latest:db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get()?.seq||0;
  return {schemaVersion:1,epoch:m.epoch,latestSequence:latest,retentionFloor:scoped?0:Number(m.floor),gapThrough:scoped?0:Number(m.gapThrough),retainedEvents:scoped?counts.n:Number(m.retainedEvents),retainedBytes:scoped?counts.bytes:Number(m.retainedBytes),scope:scoped?'authorized-hosts':'fleet',maxEvents:this.maxEvents,maxBytes:this.maxBytes,maxAgeMs:this.maxAgeMs,eventArchive:{status:'not-configured',pendingRecords:scoped?counts.n:Number(m.retainedEvents),receiptRequired:true},completeHistory:false};}
 status(hostIds,projectIds){return this.readDatabase(db=>this.statusIn(db,hostIds,projectIds));}
 state(hostId){return this.readDatabase(db=>{const r=db.prepare('SELECT payload FROM host_state WHERE host_id=?').get(hostId);return r?JSON.parse(r.payload):null;});}
 usageCursor(hostId){return this.readDatabase(db=>{const row=db.prepare('SELECT payload FROM usage_capture_cursors WHERE host_id=?').get(hostId);return row?validateUsageCursor(JSON.parse(row.payload)):null;});}
 sampleAnalytics(options={}){return this.readDatabase(db=>{const report=readUsageSampleAnalytics(db,options);if(options.includeAccount){const ids=options.hostIds,where=Array.isArray(ids)?ids.length?'host_id IN ('+ids.map(()=>'?').join(',')+')':'0':'1';const rows=db.prepare(`SELECT host_id,account_identity,limits_ms,received_ms,payload FROM account_usage_observations WHERE ${where} ORDER BY sequence DESC LIMIT 512`).all(...(ids||[]));report.quotaPace=deriveQuotaPace(rows.map(row=>({hostId:row.host_id,identity:row.account_identity,limitsAt:row.limits_ms,receivedAt:row.received_ms,accountUsage:JSON.parse(row.payload)})),{now:options.now});}return report;});}
 nativeAnalytics(options={}){return this.readDatabase(db=>readNativeAnalytics(db,options));}
 projectActivity(options={}){return this.readDatabase(db=>readProjectActivity(db,options));}
 allowanceHistory(options={}){const now=options.now??Date.now(),key=JSON.stringify([options.accountKey,options.limitId,options.slot,options.range,[...(options.hostIds||[])].sort()]);this.allowanceCache??=new Map();const cached=this.allowanceCache.get(key);if(cached&&now>=cached.at&&now-cached.at<60000)return cached.value;const value=this.readDatabase(db=>readAllowanceHistory(db,{...options,now}));if(this.allowanceCache.size>=12)this.allowanceCache.delete(this.allowanceCache.keys().next().value);this.allowanceCache.set(key,{at:now,value});return value;}
 usage(options={}){return this.readDatabase(db=>{const usage=readUsage(db,options);if(usage.archive.status!=='restricted'){
   const now=Date.now();if(!this.archiveDisk||now-this.archiveDisk.at>15000){try{const disk=statfsSync(path.dirname(this.file)),safe=n=>Number.isSafeInteger(n)&&n>=0?n:null;let bytes=0;for(const suffix of ['', '-wal','-shm'])try{bytes+=statSync(this.file+suffix).size;}catch(error){if(error.code!=='ENOENT')throw error;}const available=safe(disk.bavail*disk.bsize),total=safe(disk.blocks*disk.bsize);this.archiveDisk={at:now,value:{checkedAt:new Date(now).toISOString(),databaseBytes:safe(bytes),availableBytes:available,totalBytes:total,pressure:available!==null&&total!==null&&available<Math.max(1073741824,total*.1)}};}catch{this.archiveDisk={at:now,value:{status:'unavailable'}};}}
   usage.archive.storage=this.archiveDisk.value;
  }return {...usage,epoch:this.metadata(db).epoch+':'+usage.streamGeneration};});}
 latest({hostId,hostIds,projectIds,limit=5000,maxBytes=4194304}={}){return this.readDatabase(db=>{const scope=scopePredicate(hostIds,projectIds),conditions=[scope.where],args=scope.args;if(hostId){conditions.push('host_id=?');args.push(hostId);}const events=[];let bytes=0;for(const r of db.prepare(`SELECT payload,sequence,bytes FROM events WHERE ${conditions.join(' AND ')} ORDER BY sequence DESC LIMIT ?`).iterate(...args,limit)){if(bytes+r.bytes>maxBytes)break;bytes+=r.bytes;events.push({...JSON.parse(r.payload),journalSequence:r.sequence});}return events.reverse();});}
 commit({hostId,state,events=[],usageSamples=[],usageCursor,sourceRole='unknown',now=Date.now()}) {
  if(typeof hostId!=='string'||!hostId||events.length>15000)throw new Error('Invalid history batch');
  const rows=events.map(e=>{const text=JSON.stringify(e),bytes=Buffer.byteLength(text);if(typeof e.id!=='string'||!Number.isFinite(Date.parse(e.at))||bytes>32768)throw new Error('Invalid history event');return {e,text,bytes};});
  const stateText=JSON.stringify(state);if(Buffer.byteLength(stateText)>2097152)throw new Error('History state exceeds bound');
  const cursorText=usageCursor===undefined?null:JSON.stringify(validateUsageCursor(usageCursor));
  return this.database(db=>{let began=false,commitAttempted=false;try{db.exec('BEGIN IMMEDIATE');began=true;
   const outstanding=sourceOutstanding(db,hostId);
   const m=this.metadata(db),insert=db.prepare('INSERT INTO events(event_id,host_id,occurred_ms,received_ms,payload,bytes) SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM events WHERE event_id=?)');let added=0,bytes=0;
   requireStorageReserve(this.file,this.storageAdmission);
   for(const r of rows){const result=insert.run(r.e.id,hostId,Date.parse(r.e.at),now,r.text,r.bytes,r.e.id);if(result.changes){added++;bytes+=r.bytes;}}
   db.prepare('INSERT INTO host_state(host_id,payload) VALUES(?,?) ON CONFLICT(host_id) DO UPDATE SET payload=excluded.payload').run(hostId,stateText);
   recordUsage(db,{hostId,state,now});
   const samples=captureUsageSamples(db,usageSamples,{hostId,receivedMs:now,sourceRole});
   if(cursorText!==null)db.prepare('INSERT INTO usage_capture_cursors(host_id,payload) VALUES(?,?) ON CONFLICT(host_id) DO UPDATE SET payload=excluded.payload WHERE payload<>excluded.payload').run(hostId,cursorText);
   requireSourceCapacity(outstanding,sourceOutstanding(db,hostId),this.storageAdmission);
   // Age, row and byte limits are hot-cache targets, never authority to delete
   // a captured event. There is no event-archive receipt path in V1. Keep the
   // exact row locally until a verified archive integration can prove custody;
   // filesystem reserve admission fails closed before disk exhaustion.
   const count=Number(m.retainedEvents)+added,total=Number(m.retainedBytes)+bytes;
   const update=db.prepare('UPDATE metadata SET value=? WHERE key=?');for(const [key,value] of Object.entries({retainedEvents:count,retainedBytes:total}))update.run(String(value),key);
   const status=this.statusIn(db);commitAttempted=true;db.exec('COMMIT');return {added,...status,samples};
  }catch(error){
   // Preserve the initiating error. SQLite can auto-rollback on native I/O or
   // FULL errors; a second ROLLBACK must not hide that original failure.
   let rolledBack=false;
   if(db.isTransaction){try{db.exec('ROLLBACK');rolledBack=!db.isTransaction;}catch{}}
   else rolledBack=!commitAttempted;
   error.journalOutcome=!began&&!commitAttempted?'not-started':rolledBack?'rolled-back':'uncertain';
   throw error;
  }});
 }
 read({after=0,epoch,limit=500,maxBytes=1048576,before,beforeSequence=0,hostId,hostIds,projectIds,sessionId,project}={}) {
  if(!Number.isSafeInteger(after)||after<0)throw Object.assign(new Error('Invalid history cursor'),{status:400});
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000||!Number.isSafeInteger(maxBytes)||maxBytes<512||maxBytes>2097152)throw Object.assign(new Error('Invalid history limit'),{status:400});
  if(before!==undefined&&!Number.isFinite(Date.parse(before)))throw Object.assign(new Error('Invalid history time'),{status:400});
  if(!Number.isSafeInteger(beforeSequence)||beforeSequence<0)throw Object.assign(new Error('Invalid history cursor'),{status:400});
  return this.readDatabase(db=>{const status=this.statusIn(db,hostIds,projectIds);let cursor=after,gap=null;
   if(epoch&&epoch!==status.epoch){gap={reason:'journal-changed',requested:after};cursor=status.retentionFloor;}
   else if(after>status.latestSequence){gap={reason:'cursor-ahead',requested:after};cursor=status.retentionFloor;}
   else if(after<status.retentionFloor||after<status.gapThrough){gap={reason:'retention',requested:after,floor:status.retentionFloor,through:status.gapThrough};cursor=Math.max(after,status.retentionFloor);}
   const history=before!==undefined,conditions=history?['(occurred_ms<? OR (occurred_ms=? AND sequence<?))']:['sequence>?','sequence<=?'],args=history?[Date.parse(before),Date.parse(before),beforeSequence]:[cursor,status.latestSequence];
   if(hostId){conditions.push('host_id=?');args.push(hostId);}if(sessionId){conditions.push("json_extract(payload,'$.sessionId')=?");args.push(sessionId);}
   const scoped=scopePredicate(hostIds,projectIds);conditions.push(scoped.where);args.push(...scoped.args);if(project){conditions.push("json_extract(payload,'$.project')=?");args.push(project);}
   const rows=db.prepare(`SELECT sequence,payload,bytes FROM events WHERE ${conditions.join(' AND ')} ORDER BY ${history?'occurred_ms DESC,sequence DESC':'sequence ASC'} LIMIT ?`).all(...args,limit+1),events=[];let size=0,next=cursor;
   for(const r of rows){if(events.length>=limit)break;if(size+r.bytes>maxBytes){if(!events.length)throw Object.assign(new Error('Event exceeds page budget'),{status:413});break;}events.push({...JSON.parse(r.payload),journalSequence:r.sequence});size+=r.bytes;next=r.sequence;}
   const caughtUp=events.length===rows.length;
   if(!history&&caughtUp)next=status.latestSequence;
   return {...status,events,nextCursor:next,caughtUp,gap,bytes:size,olderBefore:history&&events.length?events.at(-1).at:null,olderSequence:history&&events.length?events.at(-1).journalSequence:null};
  });
 }
}
