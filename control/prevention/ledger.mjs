// Author: Bishop Crockett
// Owner: Argellan.com
// Optional local accounting foundation. Importing it installs no runtime hooks.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {ControlError,isControlError} from '../lib/errors.mjs';
import {strictRecord,uuid,integer,opaqueToken,arrayValues,canonicalJson,deepFreeze,enumValue} from '../lib/privacy.mjs';
import {assertLocalOwner,localDirectory} from '../broker/local-owner.mjs';
const fail=code=>{throw new ControlError(code);};
const digest=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const refused=code=>({refused:code});
const ddl=`
CREATE TABLE schema_info(id INTEGER PRIMARY KEY CHECK(id=1),sha256 TEXT NOT NULL) STRICT;
CREATE TABLE families(family_id TEXT PRIMARY KEY,root_task_id TEXT NOT NULL,used_units INTEGER NOT NULL DEFAULT 0,reserved_units INTEGER NOT NULL DEFAULT 0,closeout_used INTEGER NOT NULL DEFAULT 0,stop_reason TEXT,closeout_only INTEGER NOT NULL DEFAULT 0,deny_latch INTEGER NOT NULL DEFAULT 0,last_clock_ms INTEGER NOT NULL,last_observed_ms INTEGER,reset_at INTEGER,remaining REAL) STRICT;
CREATE TABLE tasks(task_id TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES families(family_id),parent_task_id TEXT REFERENCES tasks(task_id),manifest_json TEXT NOT NULL,sha256 TEXT NOT NULL) STRICT;
CREATE INDEX task_family ON tasks(family_id);
CREATE TRIGGER immutable_tasks_update BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER immutable_tasks_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TABLE reservations(operation_id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(task_id),family_id TEXT NOT NULL REFERENCES families(family_id),units INTEGER NOT NULL,remaining_units INTEGER NOT NULL,purpose TEXT NOT NULL,state TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,known_not_executed INTEGER NOT NULL DEFAULT 0,retry_evidence TEXT) STRICT;
CREATE INDEX reservation_family ON reservations(family_id);
CREATE TABLE usage_events(event_id TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES families(family_id),sha256 TEXT NOT NULL,metadata_json TEXT NOT NULL) STRICT;
CREATE TABLE telemetry(sample_id TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES families(family_id),sha256 TEXT NOT NULL,metadata_json TEXT NOT NULL) STRICT;
CREATE TABLE receipts(receipt_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,sha256 TEXT NOT NULL,metadata_json TEXT NOT NULL) STRICT;
CREATE TABLE audit(sequence INTEGER PRIMARY KEY,at_ms INTEGER NOT NULL,family_id TEXT NOT NULL,kind TEXT NOT NULL,subject_id TEXT NOT NULL) STRICT;
CREATE TABLE counters(id INTEGER PRIMARY KEY CHECK(id=1),audit_bytes INTEGER NOT NULL) STRICT;
INSERT INTO counters VALUES(1,0);
PRAGMA user_version=1;`;
const schemaSha=digest({ddl});
function list(value){const result=arrayValues(value,1,32).map(opaqueToken);if(new Set(result).size!==result.length)fail('INVALID_INPUT');return result;}
function manifest(value){
 strictRecord(value,['version','taskId','familyId','parentTaskId','authority','scope','definitionOfDone','budget','deadlineAtMs','closeoutReserveMs','requested','observable','enforcement']);
 if(value.version!==1)fail('INVALID_INPUT');
 strictRecord(value.authority,['kind','evidenceRef']);enumValue(value.authority.kind,['OWNER']);opaqueToken(value.authority.evidenceRef);
 strictRecord(value.budget,['unit','approved','limitUnits','closeoutReserveUnits','warningPermille','noNewPermille']);
 enumValue(value.budget.unit,['RECORDED_TOKENS','LOCAL_JOBS']);if(typeof value.budget.approved!=='boolean')fail('INVALID_INPUT');
 if(value.budget.approved)integer(value.budget.limitUnits,1,1000000000);else if(value.budget.limitUnits!==null)fail('INVALID_INPUT');
 integer(value.budget.closeoutReserveUnits,0,value.budget.limitUnits??0);integer(value.budget.warningPermille,1,999);integer(value.budget.noNewPermille,value.budget.warningPermille+1,1000);
 for(const [item,nullable] of [[value.requested,false],[value.observable,true]]){strictRecord(item,['model','effort','tier']);if(!(nullable&&item.model===null))opaqueToken(item.model);if(!(nullable&&item.effort===null))enumValue(item.effort,['low','medium','high','xhigh','max','ultra']);if(!(nullable&&item.tier===null))enumValue(item.tier,['default']);}
 for(const field of ['model','effort','tier'])if(value.observable[field]!==null&&value.observable[field]!==value.requested[field])fail('STALE_CONTEXT');
 enumValue(value.enforcement,['ADVISORY','SUPPORTED_INVOKER']);
 return deepFreeze({version:1,taskId:uuid(value.taskId),familyId:uuid(value.familyId),parentTaskId:uuid(value.parentTaskId,true),authority:{...value.authority},scope:list(value.scope),definitionOfDone:list(value.definitionOfDone),budget:{...value.budget},deadlineAtMs:integer(value.deadlineAtMs,1),closeoutReserveMs:integer(value.closeoutReserveMs),requested:{...value.requested},observable:{...value.observable},enforcement:value.enforcement});
}
/** Trusted local caller accounting; authority references are records, not credential verification. */
export class PreventionLedger{
 #db;#owner;#directory;#now;#age;#closed=false;#maxBytes;#identity;
 static open(options){return new PreventionLedger(options);}
 constructor(options){
  strictRecord(options,['directory','owner','now','maxTelemetryAgeMs','maxAuditBytes'],['directory','owner']);
  const {directory,owner,now=Date.now,maxTelemetryAgeMs=90000,maxAuditBytes=8*1024*1024}=options;
  if(typeof now!=='function')fail('INVALID_INPUT');this.#now=now;this.#age=integer(maxTelemetryAgeMs,1,90000);this.#maxBytes=integer(maxAuditBytes,4096,1024*1024*1024);
  try{
   this.#directory=localDirectory(directory);assertLocalOwner(owner,this.#directory);this.#owner=owner;
   const file=path.join(this.#directory,'prevention.sqlite');
   for(const name of [file,file+'-wal',file+'-shm'])if(fs.existsSync(name)){const s=fs.lstatSync(name);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)fail('CONTROL_DISABLED');}
   this.#db=new DatabaseSync(file);this.#identity=fs.lstatSync(file);this.#db.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
   this.#db.exec('BEGIN IMMEDIATE');try{const version=this.#db.prepare('PRAGMA user_version').get().user_version;if(version===0){if(this.#db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get())fail('SCHEMA_MISMATCH');this.#db.exec(ddl);this.#db.prepare('INSERT INTO schema_info VALUES(1,?)').run(schemaSha);}else if(version!==1||this.#db.prepare('SELECT sha256 FROM schema_info WHERE id=1').get()?.sha256!==schemaSha)fail('SCHEMA_MISMATCH');this.#db.exec('COMMIT');}catch(e){this.#db.exec('ROLLBACK');throw e;}
   if(this.#db.prepare('PRAGMA quick_check(1)').get().quick_check!=='ok')fail('STORAGE_UNAVAILABLE');
  }catch(e){try{this.#db?.close();}catch{}this.#closed=true;if(isControlError(e))throw e;fail('STORAGE_UNAVAILABLE');}
 }
 #assert(){try{if(this.#closed)fail('CLOSED');this.#owner.assertCurrent();const s=fs.lstatSync(path.join(this.#directory,'prevention.sqlite'));if(s.isSymbolicLink()||s.dev!==this.#identity.dev||s.ino!==this.#identity.ino)fail('STALE_CONTEXT');}catch(e){if(isControlError(e))throw e;fail('STORAGE_UNAVAILABLE');}}
 #write(fn){this.#assert();let begun=false,result;try{this.#db.exec('BEGIN IMMEDIATE');begun=true;result=fn();this.#db.exec('COMMIT');begun=false;}catch(e){if(begun)try{this.#db.exec('ROLLBACK');}catch{}if(isControlError(e))throw e;if(Number.isInteger(e?.errcode)&&[5,6].includes(e.errcode&255))fail('CONFLICT');fail('STORAGE_UNAVAILABLE');}if(result?.refused)fail(result.refused);return deepFreeze(result);}
 #read(fn){this.#assert();try{return deepFreeze(fn());}catch(e){if(isControlError(e))throw e;fail('STORAGE_UNAVAILABLE');}}
 #task(id){const r=this.#db.prepare('SELECT * FROM tasks WHERE task_id=?').get(uuid(id));if(!r)fail('NOT_FOUND');const value=manifest(JSON.parse(r.manifest_json));if(digest(value)!==r.sha256)fail('SCHEMA_MISMATCH');return {value,sha256:r.sha256};}
 #family(id){const f=this.#db.prepare('SELECT * FROM families WHERE family_id=?').get(uuid(id));if(!f)fail('NOT_FOUND');return f;}
 #op(id){const r=this.#db.prepare('SELECT * FROM reservations WHERE operation_id=?').get(uuid(id));if(!r)fail('NOT_FOUND');return r;}
 #audit(familyId,kind,subjectId,emergency=false){const count=this.#db.prepare('SELECT audit_bytes FROM counters WHERE id=1').get().audit_bytes;if(count+256>this.#maxBytes+(emergency?1024*1024:0))fail('CAPACITY');this.#db.prepare('INSERT INTO audit(at_ms,family_id,kind,subject_id) VALUES(?,?,?,?)').run(integer(this.#now()),familyId,kind,subjectId);this.#db.prepare('UPDATE counters SET audit_bytes=audit_bytes+256 WHERE id=1').run();}
 #stop(id,reason){this.#db.prepare('UPDATE families SET stop_reason=COALESCE(stop_reason,?),closeout_only=1 WHERE family_id=?').run(reason,id);}
 #state(id){const f=this.#family(id),m=this.#task(f.root_task_id).value,committed=f.used_units+f.reserved_units;return {familyId:id,usedUnits:f.used_units,reservedUnits:f.reserved_units,stopReason:f.stop_reason,closeoutOnly:!!f.closeout_only,deniedActionHold:!!f.deny_latch,warning:m.budget.approved&&committed*1000>=m.budget.limitUnits*m.budget.warningPermille,lastObservedAtMs:f.last_observed_ms,resetAt:f.reset_at,remaining:f.remaining};}
 #admission(task,purpose,allowDeniedRetry=false){
  const f=this.#family(task.familyId),root=this.#task(f.root_task_id).value,at=integer(this.#now());
  if(!root.budget.approved)return 'CONTROL_DISABLED';
  if(purpose==='CLOSEOUT')return null;if(f.deny_latch&&!allowDeniedRetry)return 'CONTROL_DISABLED';
  let reason=null;if(at<f.last_clock_ms)reason='CLOCK_INVALID';else if(f.stop_reason)reason=f.stop_reason;else if(at>=task.deadlineAtMs)reason='DEADLINE';else if(f.last_observed_ms===null||at-f.last_observed_ms>this.#age)reason='TELEMETRY_STALE';
  if(reason){this.#stop(task.familyId,reason);return 'CONTROL_DISABLED';}
  this.#db.prepare('UPDATE families SET last_clock_ms=? WHERE family_id=?').run(at,task.familyId);
  if(at>=task.deadlineAtMs-task.closeoutReserveMs||f.closeout_only||(f.used_units+f.reserved_units)*1000>=root.budget.limitUnits*root.budget.noNewPermille){this.#db.prepare('UPDATE families SET closeout_only=1 WHERE family_id=?').run(task.familyId);return 'CAPACITY';}
  return null;
 }
 manifest(taskId){return this.#read(()=>this.#task(taskId));}
 state(familyId){return this.#read(()=>this.#state(uuid(familyId)));}
 operation(operationId){return this.#read(()=>{const r=this.#op(operationId);return {operationId:r.operation_id,state:r.state,remainingUnits:r.remaining_units,attempt:r.attempt};});}
 admitManifest(input){const m=manifest(input),sha=digest(m);return this.#write(()=>{
  const prior=this.#db.prepare('SELECT sha256 FROM tasks WHERE task_id=?').get(m.taskId);if(prior){if(prior.sha256!==sha)fail('CONFLICT');return {duplicate:true,sha256:sha};}
  if(m.parentTaskId===null){if(this.#db.prepare('SELECT 1 FROM families WHERE family_id=?').get(m.familyId))fail('CONFLICT');if(m.deadlineAtMs<=integer(this.#now()))fail('EXPIRED');this.#db.prepare('INSERT INTO families(family_id,root_task_id,last_clock_ms) VALUES(?,?,?)').run(m.familyId,m.taskId,integer(this.#now()));}
  else{const parent=this.#task(m.parentTaskId).value;this.#family(m.familyId);if(parent.familyId!==m.familyId||m.deadlineAtMs>parent.deadlineAtMs||m.closeoutReserveMs<parent.closeoutReserveMs||canonicalJson(m.budget)!==canonicalJson(parent.budget)||canonicalJson(m.requested)!==canonicalJson(parent.requested)||canonicalJson(m.authority)!==canonicalJson(parent.authority)||m.enforcement!==parent.enforcement||m.scope.some(x=>!parent.scope.includes(x)))fail('INVALID_INPUT');if(this.#db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE family_id=?').get(m.familyId).n>=64)fail('CAPACITY');let depth=0,current=parent;while(current.parentTaskId!==null){if(++depth>=8)fail('CAPACITY');current=this.#task(current.parentTaskId).value;}const reason=this.#admission(parent,'WORK');if(reason)return refused(reason);}
  this.#db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(m.taskId,m.familyId,m.parentTaskId,canonicalJson(m),sha);this.#audit(m.familyId,'MANIFEST',m.taskId);return {duplicate:false,sha256:sha};
 });}
 observe(familyId,input){familyId=uuid(familyId);let sample;try{strictRecord(input,['sampleId','remaining','resetAt','observedAtMs']);sample={sampleId:uuid(input.sampleId),remaining:input.remaining,resetAt:integer(input.resetAt,1),observedAtMs:integer(input.observedAtMs)};if(typeof sample.remaining!=='number'||!Number.isFinite(sample.remaining)||sample.remaining<0||sample.remaining>100||Object.is(sample.remaining,-0))fail('INVALID_INPUT');}catch{return this.telemetryUnavailable(familyId,'TELEMETRY_INVALID');}
  return this.#write(()=>{const f=this.#family(familyId),sha=digest(sample),prior=this.#db.prepare('SELECT * FROM telemetry WHERE sample_id=?').get(sample.sampleId);if(prior){if(prior.sha256!==sha||prior.family_id!==familyId){this.#stop(familyId,'TELEMETRY_CONFLICT');return refused('CONFLICT');}return this.#state(familyId);}
   const at=integer(this.#now());let reason=null;if(sample.observedAtMs>at||at-sample.observedAtMs>this.#age||sample.resetAt*1000<=at)reason='TELEMETRY_STALE';else if(f.reset_at!==null&&sample.resetAt!==f.reset_at)reason='WEEKLY_RESET';else if(f.remaining!==null&&sample.remaining>f.remaining)reason='REPLENISHMENT';else if(sample.remaining<5)reason='CAMPAIGN_FLOOR';else if(f.last_observed_ms!==null&&sample.observedAtMs<f.last_observed_ms)reason='TELEMETRY_ORDER';
   this.#db.prepare('INSERT INTO telemetry VALUES(?,?,?,?)').run(sample.sampleId,familyId,sha,canonicalJson(sample));this.#db.prepare('UPDATE families SET last_observed_ms=?,reset_at=?,remaining=? WHERE family_id=?').run(sample.observedAtMs,sample.resetAt,sample.remaining,familyId);if(reason)this.#stop(familyId,reason);this.#audit(familyId,'TELEMETRY',sample.sampleId,true);return this.#state(familyId);
  });
 }
 telemetryUnavailable(familyId,reason='TELEMETRY_UNAVAILABLE'){familyId=uuid(familyId);enumValue(reason,['TELEMETRY_UNAVAILABLE','TELEMETRY_INVALID']);return this.#write(()=>{this.#family(familyId);this.#stop(familyId,reason);this.#audit(familyId,reason,randomUUID(),true);return this.#state(familyId);});}
 stop(familyId,reason){familyId=uuid(familyId);enumValue(reason,['OWNER_STOP','CAMPAIGN_STOP']);return this.#write(()=>{this.#family(familyId);this.#stop(familyId,reason);this.#audit(familyId,reason,randomUUID(),true);return this.#state(familyId);});}
 reserve(taskId,operationId,units,purpose='WORK'){
  taskId=uuid(taskId);operationId=uuid(operationId);integer(units,1,1000000000);enumValue(purpose,['WORK','CLOSEOUT']);
  return this.#write(()=>{if(this.#db.prepare('SELECT 1 FROM reservations WHERE operation_id=?').get(operationId))fail('REPLAY_UNAVAILABLE');const task=this.#task(taskId).value,reason=this.#admission(task,purpose);if(reason)return refused(reason);const f=this.#family(task.familyId),budget=this.#task(f.root_task_id).value.budget;
   if(f.used_units+f.reserved_units+units>budget.limitUnits)fail('CAPACITY');
   if(purpose==='WORK'&&(f.used_units+f.reserved_units+units>budget.limitUnits-budget.closeoutReserveUnits||(f.used_units+f.reserved_units+units)*1000>budget.limitUnits*budget.noNewPermille))fail('CAPACITY');
   if(purpose==='CLOSEOUT'){const held=this.#db.prepare("SELECT COALESCE(SUM(remaining_units),0) AS n FROM reservations WHERE family_id=? AND purpose='CLOSEOUT'").get(task.familyId).n;if(held+f.closeout_used+units>budget.closeoutReserveUnits)fail('CAPACITY');}
   this.#db.prepare('INSERT INTO reservations(operation_id,task_id,family_id,units,remaining_units,purpose,state) VALUES(?,?,?,?,?,?,?)').run(operationId,taskId,task.familyId,units,units,purpose,'RESERVED');this.#db.prepare('UPDATE families SET reserved_units=reserved_units+? WHERE family_id=?').run(units,task.familyId);this.#audit(task.familyId,'RESERVE',operationId);return {operationId,state:'RESERVED'};
  });
 }
 start(operationId){operationId=uuid(operationId);return this.#write(()=>{const op=this.#op(operationId);if(op.state!=='RESERVED')fail('REPLAY_UNAVAILABLE');const reason=this.#admission(this.#task(op.task_id).value,op.purpose,op.attempt===1);if(reason)return refused(reason);this.#db.prepare("UPDATE reservations SET state='RUNNING' WHERE operation_id=?").run(operationId);this.#audit(op.family_id,'START',operationId);return {operationId,state:'RUNNING'};});}
 recordUsage(input){strictRecord(input,['eventId','taskId','operationId','source','units']);const value={eventId:uuid(input.eventId),taskId:uuid(input.taskId),operationId:uuid(input.operationId,true),source:enumValue(input.source,['OWNER','CHILD','MONITOR']),units:integer(input.units,0,1000000000)};return this.#write(()=>{const task=this.#task(value.taskId).value,sha=digest(value),old=this.#db.prepare('SELECT * FROM usage_events WHERE event_id=?').get(value.eventId);if(old){if(old.sha256!==sha||old.family_id!==task.familyId){this.#stop(task.familyId,'USAGE_CONFLICT');return refused('CONFLICT');}return {duplicate:true};}
   const f=this.#family(task.familyId);if(f.used_units+value.units>1000000000000)fail('CAPACITY');let released=0,closeout=0;
   if(value.operationId!==null){const op=this.#op(value.operationId);if(op.task_id!==value.taskId||op.family_id!==task.familyId)fail('INVALID_INPUT');released=Math.min(value.units,op.remaining_units);closeout=op.purpose==='CLOSEOUT'?value.units:0;this.#db.prepare('UPDATE reservations SET remaining_units=remaining_units-? WHERE operation_id=?').run(released,value.operationId);}
   this.#db.prepare('INSERT INTO usage_events VALUES(?,?,?,?)').run(value.eventId,task.familyId,sha,canonicalJson(value));this.#db.prepare('UPDATE families SET used_units=used_units+?,reserved_units=reserved_units-?,closeout_used=closeout_used+? WHERE family_id=?').run(value.units,released,closeout,task.familyId);const after=this.#family(task.familyId),budget=this.#task(after.root_task_id).value.budget;if(budget.approved&&after.used_units+after.reserved_units>budget.limitUnits)this.#stop(task.familyId,'BUDGET_EXCEEDED');this.#audit(task.familyId,'USAGE',value.eventId,true);return {duplicate:false};
  });}
 #receipt(operationId,input){strictRecord(input,['receiptId','outcome','executionKnown','cleanupVerified']);const value={receiptId:uuid(input.receiptId),operationId:uuid(operationId),outcome:enumValue(input.outcome,['COMPLETED','FAILED','CANCELLED','UNKNOWN']),executionKnown:input.executionKnown,cleanupVerified:input.cleanupVerified};if(typeof value.executionKnown!=='boolean'||typeof value.cleanupVerified!=='boolean')fail('INVALID_INPUT');return value;}
 finish(operationId,input){operationId=uuid(operationId);const receipt=this.#receipt(operationId,input),sha=digest(receipt);return this.#write(()=>{const op=this.#op(operationId),old=this.#db.prepare('SELECT sha256 FROM receipts WHERE receipt_id=?').get(receipt.receiptId);if(old){if(old.sha256!==sha)fail('CONFLICT');return {duplicate:true};}if(op.state==='CLOSED')fail('CONFLICT');this.#db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(receipt.receiptId,operationId,sha,canonicalJson(receipt));
   if(receipt.outcome==='UNKNOWN'||!receipt.executionKnown||!receipt.cleanupVerified)this.#db.prepare("UPDATE reservations SET state='UNKNOWN' WHERE operation_id=?").run(operationId);
   else{this.#db.prepare('UPDATE families SET reserved_units=reserved_units-? WHERE family_id=?').run(op.remaining_units,op.family_id);this.#db.prepare("UPDATE reservations SET state='CLOSED',remaining_units=0 WHERE operation_id=?").run(operationId);}
   this.#audit(op.family_id,'FINISH',receipt.receiptId,true);return {duplicate:false,state:this.#op(operationId).state};
  });}
 #actionReceipt(operationId,receiptId,kind,knownNotExecuted=null){const value={operationId,receiptId,kind,knownNotExecuted},sha=digest(value),prior=this.#db.prepare('SELECT sha256 FROM receipts WHERE receipt_id=?').get(receiptId);if(prior){if(prior.sha256!==sha)fail('CONFLICT');return true;}this.#db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(receiptId,operationId,sha,canonicalJson(value));return false;}
 cancel(operationId,receiptId){operationId=uuid(operationId);receiptId=uuid(receiptId);return this.#write(()=>{const op=this.#op(operationId);if(this.#actionReceipt(operationId,receiptId,'CANCEL'))return {state:op.state,duplicate:true};if(!['RESERVED','RUNNING','CANCEL_REQUESTED'].includes(op.state))fail('INVALID_TRANSITION');if(op.state==='RESERVED'){this.#db.prepare('UPDATE families SET reserved_units=reserved_units-? WHERE family_id=?').run(op.remaining_units,op.family_id);this.#db.prepare("UPDATE reservations SET state='CLOSED',remaining_units=0 WHERE operation_id=?").run(operationId);}else this.#db.prepare("UPDATE reservations SET state='CANCEL_REQUESTED' WHERE operation_id=?").run(operationId);this.#audit(op.family_id,'CANCEL',receiptId,true);return {state:this.#op(operationId).state};});}
 deny(operationId,receiptId,knownNotExecuted){operationId=uuid(operationId);receiptId=uuid(receiptId);if(typeof knownNotExecuted!=='boolean')fail('INVALID_INPUT');return this.#write(()=>{const op=this.#op(operationId);if(this.#actionReceipt(operationId,receiptId,'DENY',knownNotExecuted))return {state:op.state,duplicate:true};if(!['RESERVED','RUNNING'].includes(op.state))fail('INVALID_TRANSITION');this.#db.prepare("UPDATE reservations SET state='DENIED',known_not_executed=? WHERE operation_id=?").run(knownNotExecuted?1:0,operationId);this.#db.prepare('UPDATE families SET deny_latch=1 WHERE family_id=?').run(op.family_id);this.#audit(op.family_id,'DENIED',receiptId,true);return {state:'DENIED'};});}
 authorizeRetry(operationId,input){operationId=uuid(operationId);strictRecord(input,['evidenceRef','materiallyRelevant','knownNotExecuted']);opaqueToken(input.evidenceRef);if(input.materiallyRelevant!==true||input.knownNotExecuted!==true)fail('CONTROL_DISABLED');return this.#write(()=>{const op=this.#op(operationId);if(op.state!=='DENIED'||!op.known_not_executed||op.attempt!==0||op.retry_evidence===input.evidenceRef||input.evidenceRef===this.#task(op.task_id).value.authority.evidenceRef)fail('CONTROL_DISABLED');const reason=this.#admission(this.#task(op.task_id).value,op.purpose,true);if(reason)return refused(reason);this.#db.prepare("UPDATE reservations SET state='RESERVED',attempt=1,retry_evidence=? WHERE operation_id=?").run(input.evidenceRef,operationId);this.#audit(op.family_id,'RETRY_AUTHORITY',operationId);return {state:'RESERVED',attempt:1};});}
 async invokeReserved(operationId,invoke){operationId=uuid(operationId);if(typeof invoke!=='function')fail('INVALID_INPUT');this.start(operationId);try{return await invoke();}catch(e){this.finish(operationId,{receiptId:randomUUID(),outcome:'UNKNOWN',executionKnown:false,cleanupVerified:false});if(isControlError(e))throw e;fail('CONTROL_ERROR');}}
 get enforcement(){return deepFreeze({libraryInvocations:'ENFORCED_WHEN_CALLER_USES_INVOKE_RESERVED',nativeModelSteps:'ADVISORY_NOT_INTEGRATED',billing:'NOT_A_HARD_CAP',authorityEvidence:'CALLER_ASSERTED_NOT_CREDENTIAL_VERIFICATION'});}
 close(){if(this.#closed)return;this.#db.close();this.#closed=true;}
}