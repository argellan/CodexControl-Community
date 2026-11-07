// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import crypto from 'node:crypto';
import {sanitizeAccountUsage} from './account-usage.mjs';
import {USAGE_SAMPLE_COLUMNS,validateUsageSampleRow} from './usage-samples.mjs';

// This outbox is part of the SAME SQLite transaction as captured usage. Hot
// retention is a cache policy: it must never delete the only captured copy.
// Stable random item identities also survive a restore that reuses sequences.
export const ARCHIVE_SOURCE_COLUMNS=Object.freeze({
 usage_observations:['sequence','host_id','session_id','project','provider','model','source_ms','received_ms','interval_ms','status','input_tokens','cached_input_tokens','output_tokens','total_tokens','delta_input','delta_cached','delta_uncached','delta_output','delta_total'],
 usage_daily:['host_id','session_id','segment_key','project','provider','model','day','input_tokens','cached_input_tokens','uncached_input_tokens','output_tokens','total_tokens','observations','partial_observations','overflow','first_ms','last_ms'],
 usage_baselines:['host_id','session_id','project','provider','model','source_ms','received_ms','input_tokens','cached_input_tokens','output_tokens','total_tokens','has_delta'],
 account_usage_observations:['sequence','host_id','sample_key','observed_ms','limits_ms','usage_ms','received_ms','account_identity','payload'],
 account_usage_daily:['host_id','account_identity','day','tokens','observed_ms','received_ms']
});
export const ARCHIVE_PRIMARY_KEYS=Object.freeze({usage_observations:['sequence'],usage_daily:['host_id','session_id','day','segment_key'],usage_baselines:['host_id','session_id'],account_usage_observations:['sequence'],account_usage_daily:['host_id','account_identity','day']});
export const ARCHIVE_TABLE_COLUMNS=Object.freeze({
 usage_archive_meta:['key','value'],
 usage_archive_outbox:['sequence','item_id','source_table','row_key','payload','recorded_at','ack_batch','head_follow'],
 usage_archive_heads:['source_table','row_key','item_id','sequence','payload','ack_batch'],
 usage_archive_receipts:['batch_id','raw_sha256','receiver_id','records','received_at','receipt'],
 usage_archive_inflight:['singleton','batch_id','raw_sha256','records','item_ids','body'],
 usage_archive_source_versions:['version_key','item_id','seen_ms']
});
const TABLES=Object.keys(ARCHIVE_SOURCE_COLUMNS),hex=/^[a-f0-9]{64}$/;
const allColumns={...ARCHIVE_SOURCE_COLUMNS,usage_samples_v2:USAGE_SAMPLE_COLUMNS},allKeys={...ARCHIVE_PRIMARY_KEYS,usage_samples_v2:['sample_key']};
const sampleTable=db=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_samples_v2'").get();
const tablesFor=db=>sampleTable(db)?[...TABLES,'usage_samples_v2']:TABLES;
const statuses=new Set(['unconfigured','pending','archiving','healthy','blocked','error','sending','failed','idle']);
const errors=new Set(['unconfigured','transport-failed','receiver-unavailable','receipt-invalid','archive-invalid','archive-failed','disk-pressure','bootstrap-pending','ARCHIVE_TRANSPORT_TIMEOUT','ARCHIVE_TRANSPORT_FAILED','ARCHIVE_TRANSPORT_OUTPUT','ARCHIVE_RECEIPT','ARCHIVE_ABORTED','ARCHIVE_DATABASE','ARCHIVE_FAILED']);
const metaKeys=new Set(['schemaVersion','bootstrapComplete','receiverId','status','lastAttemptAt','lastSuccessAt','errorCode']);
const schemas={
 usage_archive_meta:'CREATE TABLE usage_archive_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
 usage_archive_outbox:'CREATE TABLE usage_archive_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,item_id TEXT NOT NULL UNIQUE,source_table TEXT NOT NULL,row_key TEXT NOT NULL,payload TEXT NOT NULL,recorded_at TEXT NOT NULL,ack_batch TEXT,head_follow INTEGER NOT NULL DEFAULT 1 CHECK(head_follow IN (0,1)))',
 usage_archive_heads:'CREATE TABLE usage_archive_heads(source_table TEXT NOT NULL,row_key TEXT NOT NULL,item_id TEXT NOT NULL,sequence INTEGER NOT NULL,payload TEXT NOT NULL,ack_batch TEXT,PRIMARY KEY(source_table,row_key))',
 usage_archive_receipts:'CREATE TABLE usage_archive_receipts(batch_id TEXT PRIMARY KEY,raw_sha256 TEXT NOT NULL,receiver_id TEXT NOT NULL,records INTEGER NOT NULL,received_at TEXT NOT NULL,receipt TEXT NOT NULL)',
 usage_archive_inflight:'CREATE TABLE usage_archive_inflight(singleton INTEGER PRIMARY KEY CHECK(singleton=1),batch_id TEXT NOT NULL,raw_sha256 TEXT NOT NULL,records INTEGER NOT NULL,item_ids TEXT NOT NULL,body TEXT NOT NULL)',
 usage_archive_source_versions:'CREATE TABLE usage_archive_source_versions(version_key TEXT PRIMARY KEY,item_id TEXT NOT NULL,seen_ms INTEGER NOT NULL)'
};
const indexSchemas={usage_archive_pending:'CREATE INDEX usage_archive_pending ON usage_archive_outbox(ack_batch,sequence)',usage_archive_head_receipt:'CREATE INDEX usage_archive_head_receipt ON usage_archive_heads(ack_batch)',usage_archive_outbox_receipt:'CREATE INDEX usage_archive_outbox_receipt ON usage_archive_outbox(ack_batch)',usage_archive_source_seen:'CREATE INDEX usage_archive_source_seen ON usage_archive_source_versions(seen_ms)'};
const sampleHeadIndex='CREATE INDEX usage_archive_sample_receipt ON usage_archive_heads(source_table,ack_batch,row_key)';
const fail=message=>{throw new Error(message);};
const positive=n=>Number.isSafeInteger(n)&&n>0;
const time=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const receiver=v=>typeof v==='string'&&v.length>0&&v.length<=128&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(v);
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const sameKeys=(value,keys)=>plain(value)&&JSON.stringify(Object.keys(value))===JSON.stringify(keys);
const jsonSql=(columns,alias)=>`json_object(${columns.flatMap(k=>[`'${k}'`,`${alias?alias+'.':''}${k}`]).join(',')})`;
function assertTable(table){if(!Object.hasOwn(allColumns,table))fail('Unknown usage archive source');return table;}
function prefix(alias){if(alias!==undefined&&alias!==''&&!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias))fail('Invalid usage archive alias');return alias||'';}
function meta(db){return Object.fromEntries(db.prepare('SELECT key,value FROM usage_archive_meta').all().map(r=>[r.key,r.value]));}
function set(db,key,value){db.prepare('INSERT INTO usage_archive_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value));}
function atomic(db,fn){const name='usage_archive_'+crypto.randomBytes(8).toString('hex');db.exec(`SAVEPOINT ${name}`);try{const result=fn();db.exec(`RELEASE ${name}`);return result;}catch(error){db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);throw error;}}
function bound(value,fallback,max,name){value=value??fallback;if(!positive(value)||value>max)fail('Invalid archive '+name);return value;}

// Keep the current row fingerprint as well as its key. Even a mutable daily
// rollup may be evicted only after its latest revision has a verified receipt.
export function archiveDeletionGuard(table,alias=''){
 assertTable(table);prefix(alias);const source=alias||table;
 return `EXISTS(SELECT 1 FROM usage_archive_heads AS archive_guard_head JOIN usage_archive_receipts AS archive_guard_receipt ON archive_guard_receipt.batch_id=archive_guard_head.ack_batch WHERE archive_guard_head.source_table='${table}' AND archive_guard_head.row_key=${jsonSql(allKeys[table],source)} AND archive_guard_head.payload=${jsonSql(allColumns[table],source)} AND archive_guard_receipt.raw_sha256=archive_guard_receipt.batch_id AND archive_guard_receipt.receiver_id=(SELECT value FROM usage_archive_meta WHERE key='receiverId'))`;
}
function triggerSchemas(samples=false){
 const result={
  usage_archive_follow_insert:`CREATE TRIGGER usage_archive_follow_insert AFTER INSERT ON usage_archive_outbox WHEN NEW.head_follow=1 BEGIN INSERT INTO usage_archive_heads(source_table,row_key,item_id,sequence,payload,ack_batch) VALUES(NEW.source_table,NEW.row_key,NEW.item_id,NEW.sequence,NEW.payload,NULL) ON CONFLICT(source_table,row_key) DO UPDATE SET item_id=excluded.item_id,sequence=excluded.sequence,payload=excluded.payload,ack_batch=NULL; END`,
  usage_archive_immutable:`CREATE TRIGGER usage_archive_immutable BEFORE UPDATE ON usage_archive_outbox WHEN NEW.sequence IS NOT OLD.sequence OR NEW.item_id IS NOT OLD.item_id OR NEW.source_table IS NOT OLD.source_table OR NEW.row_key IS NOT OLD.row_key OR NEW.payload IS NOT OLD.payload OR NEW.recorded_at IS NOT OLD.recorded_at OR NEW.head_follow IS NOT OLD.head_follow BEGIN SELECT RAISE(ABORT,'Archive items are immutable'); END`,
  usage_archive_preserve_pending:`CREATE TRIGGER usage_archive_preserve_pending BEFORE DELETE ON usage_archive_outbox WHEN OLD.ack_batch IS NULL OR NOT EXISTS(SELECT 1 FROM usage_archive_receipts WHERE batch_id=OLD.ack_batch AND receiver_id=(SELECT value FROM usage_archive_meta WHERE key='receiverId')) BEGIN SELECT RAISE(ABORT,'Unacknowledged archive item'); END`
 };
 for(const table of samples?[...TABLES,'usage_samples_v2']:TABLES){
  const key=jsonSql(allKeys[table],'NEW'),payload=jsonSql(allColumns[table],'NEW');
  const insert=`INSERT INTO usage_archive_outbox(item_id,source_table,row_key,payload,recorded_at) VALUES(lower(hex(randomblob(32))),'${table}',${key},${payload},strftime('%Y-%m-%dT%H:%M:%fZ','now'));`;
  const oldKey=jsonSql(allKeys[table],'OLD'),oldPayload=jsonSql(allColumns[table],'OLD');
  const preserveOld=`INSERT INTO usage_archive_outbox(item_id,source_table,row_key,payload,recorded_at) SELECT lower(hex(randomblob(32))),'${table}',${oldKey},${oldPayload},strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS(SELECT 1 FROM usage_archive_heads WHERE source_table='${table}' AND row_key=${oldKey});`;
  result['usage_archive_'+table+'_insert']=`CREATE TRIGGER usage_archive_${table}_insert AFTER INSERT ON ${table} BEGIN ${insert} END`;
  if(table!=='usage_samples_v2')result['usage_archive_'+table+'_update']=`CREATE TRIGGER usage_archive_${table}_update AFTER UPDATE ON ${table} WHEN ${payload}<>${oldPayload} BEGIN ${preserveOld} ${insert} DELETE FROM usage_archive_heads WHERE source_table='${table}' AND row_key=${oldKey} AND ${oldKey}<>${key}; END`;
  result['usage_archive_'+table+'_guard']=`CREATE TRIGGER usage_archive_${table}_guard BEFORE DELETE ON ${table} WHEN NOT (${archiveDeletionGuard(table,'OLD')}) BEGIN SELECT RAISE(IGNORE); END`;
  result['usage_archive_'+table+'_delete']=`CREATE TRIGGER usage_archive_${table}_delete AFTER DELETE ON ${table} BEGIN DELETE FROM usage_archive_heads WHERE source_table='${table}' AND row_key=${jsonSql(allKeys[table],'OLD')}; END`;
 }
 return result;
}
export const ARCHIVE_TRIGGER_NAMES=Object.freeze(Object.keys(triggerSchemas(true)));
const normalizeSql=v=>v.replace(/\bIF NOT EXISTS\s+/gi,'').replace(/\s+/g,' ').replace(/;$/,'').trim();

export function installUsageArchive(db){
 return atomic(db,()=>{
  for(const [table,columns] of Object.entries(ARCHIVE_SOURCE_COLUMNS))if(JSON.stringify(db.prepare(`PRAGMA table_info(${table})`).all().map(v=>v.name))!==JSON.stringify(columns))fail('Incompatible archive source schema: '+table);
  const present=Object.keys(ARCHIVE_TABLE_COLUMNS).filter(table=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  if(present.length){if(present.length!==Object.keys(ARCHIVE_TABLE_COLUMNS).length)fail('Incomplete usage archive schema');validateArchiveSchema(db);}
  else if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name LIKE 'usage_archive_%' LIMIT 1").get())fail('Incomplete usage archive schema');
  for(const sql of Object.values(schemas))db.exec(sql.replace('CREATE TABLE ','CREATE TABLE IF NOT EXISTS '));
  for(const sql of Object.values(indexSchemas))db.exec(sql.replace('CREATE INDEX ','CREATE INDEX IF NOT EXISTS '));
  if(sampleTable(db))db.exec(sampleHeadIndex.replace('CREATE INDEX ','CREATE INDEX IF NOT EXISTS '));
  for(const sql of Object.values(triggerSchemas(sampleTable(db))))db.exec(sql.replace('CREATE TRIGGER ','CREATE TRIGGER IF NOT EXISTS '));
  const insert=db.prepare('INSERT OR IGNORE INTO usage_archive_meta(key,value) VALUES(?,?)');
  for(const [k,v] of Object.entries({schemaVersion:'1',bootstrapComplete:'0',receiverId:'',status:'unconfigured',lastAttemptAt:'',lastSuccessAt:'',errorCode:'unconfigured'}))insert.run(k,v);
  return archiveStatus(db);
 });
}

// Called only inside the V1->V2 migration after V1 custody has been verified.
// A damaged V2 store must be refused, never silently repaired on startup.
export function installUsageSampleArchive(db){
 if(db.prepare("SELECT value FROM usage_meta WHERE key='schemaVersion'").get()?.value!=='1'||!sampleTable(db))fail('Invalid usage sample migration');
 validateArchiveSchema(db,{samples:false});
 const legacy=triggerSchemas(false);for(const [name,sql] of Object.entries(triggerSchemas(true)))if(!Object.hasOwn(legacy,name))db.exec(sql);
 db.exec(sampleHeadIndex);
}

// Bounded migration. Triggers are installed before this sweep, so concurrent
// new capture cannot fall between a bootstrap row and live recording.
export function bootstrapUsageArchive(db,{limit=1000}={}){
 limit=bound(limit,1000,1000,'bootstrap limit');
 return atomic(db,()=>{
  if(meta(db).bootstrapComplete==='1')return {added:0,complete:true};
  let added=0;
  const insert=db.prepare('INSERT INTO usage_archive_outbox(item_id,source_table,row_key,payload,recorded_at) VALUES(?,?,?,?,?)');
  for(const table of tablesFor(db)){
   const key=jsonSql(allKeys[table],'source');
   const rows=db.prepare(`SELECT ${key} AS row_key,${jsonSql(allColumns[table],'source')} AS payload FROM ${table} AS source WHERE NOT EXISTS(SELECT 1 FROM usage_archive_heads AS head WHERE head.source_table=? AND head.row_key=${key}) LIMIT ?`).all(table,limit-added);
   for(const row of rows){insert.run(crypto.randomBytes(32).toString('hex'),table,row.row_key,row.payload,new Date().toISOString());added++;}
   if(added===limit)return {added,complete:false};
  }
  set(db,'bootstrapComplete','1');return {added,complete:true};
 });
}

function record(row){return {version:row.source_table==='usage_samples_v2'?2:1,itemId:row.item_id,sequence:row.sequence,table:row.source_table,rowKey:JSON.parse(row.row_key),recordedAt:row.recorded_at,row:JSON.parse(row.payload)};}
function recordLine(row){return JSON.stringify(record(row))+'\n';}

// A source can correct counters without advancing its timestamp, or report a
// corrected older account day. Preserve that supplied row-shaped evidence
// without making it the hot projection or granting that projection custody.
// The dedup cache is expendable metadata, never the only retained usage copy.
// Expiry may cause a report to be archived again; it cannot discard an item.
export function recordSourceVersion(db,{table,row}={}){
 assertTable(table);const canonical=canonicalSourceRow(table,row),payload=JSON.stringify(canonical);
 if(table==='usage_observations'||table==='account_usage_observations'){
  const source=db.prepare(`SELECT * FROM ${table} WHERE sequence=?`).get(canonical.sequence);
  if(!source||source.host_id!==canonical.host_id||table==='usage_observations'&&(source.session_id!==canonical.session_id||source.source_ms!==canonical.source_ms)||table==='account_usage_observations'&&(source.observed_ms!==canonical.observed_ms||source.account_identity!==canonical.account_identity))fail('Historical source version requires a real source identity');
 }
 const semantic=Object.fromEntries(Object.entries(canonical).filter(([key])=>key!=='received_ms')),versionKey=hash(JSON.stringify([table,semantic]));
 return atomic(db,()=>{
  const now=Date.now(),previous=db.prepare('SELECT item_id FROM usage_archive_source_versions WHERE version_key=?').get(versionKey);
  if(previous){db.prepare('UPDATE usage_archive_source_versions SET seen_ms=? WHERE version_key=?').run(now,versionKey);return 0;}
  const itemId=crypto.randomBytes(32).toString('hex'),rowKey=JSON.stringify(Object.fromEntries(allKeys[table].map(key=>[key,canonical[key]])));
  db.prepare('INSERT INTO usage_archive_outbox(item_id,source_table,row_key,payload,recorded_at,head_follow) VALUES(?,?,?,?,?,0)').run(itemId,table,rowKey,payload,new Date(now).toISOString());
  db.prepare('INSERT INTO usage_archive_source_versions(version_key,item_id,seen_ms) VALUES(?,?,?)').run(versionKey,itemId,now);
  db.prepare('DELETE FROM usage_archive_source_versions WHERE version_key IN (SELECT version_key FROM usage_archive_source_versions WHERE seen_ms<? ORDER BY seen_ms LIMIT 1000)').run(now-30*86400000);
  const count=db.prepare('SELECT COUNT(*) AS n FROM usage_archive_source_versions').get().n;
  if(count>200000)db.prepare('DELETE FROM usage_archive_source_versions WHERE version_key IN (SELECT version_key FROM usage_archive_source_versions ORDER BY seen_ms,version_key LIMIT ?)').run(Math.min(1000,count-200000));
  return 1;
 });
}

export function selectArchiveBatch(db,{maxRecords=1000,maxBytes=2097152}={}){
 maxRecords=bound(maxRecords,1000,1000,'record limit');maxBytes=bound(maxBytes,2097152,2097152,'byte limit');
 return atomic(db,()=>{
  const inflight=db.prepare('SELECT * FROM usage_archive_inflight WHERE singleton=1').get();
  if(inflight){const batch={version:1,batchId:inflight.batch_id,rawSha256:inflight.raw_sha256,records:inflight.records,itemIds:JSON.parse(inflight.item_ids),body:inflight.body};checkedBatch(batch);return batch;}
  const rows=db.prepare('SELECT * FROM usage_archive_outbox WHERE ack_batch IS NULL ORDER BY sequence LIMIT ?').iterate(maxRecords),lines=[],itemIds=[];let bytes=0;
  for(const row of rows){assertArchiveRow(row);const line=recordLine(row),size=Buffer.byteLength(line);if(bytes+size>maxBytes){if(!lines.length)fail('Archive item exceeds batch budget');break;}lines.push(line);itemIds.push(row.item_id);bytes+=size;}
  if(!lines.length)return null;
  const body=lines.join(''),rawSha256=hash(body),batch={version:1,batchId:rawSha256,rawSha256,records:itemIds.length,itemIds,body};
  db.prepare('INSERT INTO usage_archive_inflight(singleton,batch_id,raw_sha256,records,item_ids,body) VALUES(1,?,?,?,?,?)').run(rawSha256,rawSha256,batch.records,JSON.stringify(itemIds),body);
  return batch;
 });
}

function validateReceipt(receipt,batch,expectedReceiverId){
 if(!plain(receipt)||receipt.version!==1||receipt.batchId!==batch.batchId||receipt.rawSha256!==batch.rawSha256||receipt.records!==batch.records||receipt.durable!==true||!receiver(expectedReceiverId)||receipt.receiverId!==expectedReceiverId||!Array.isArray(receipt.itemIds)||JSON.stringify(receipt.itemIds)!==JSON.stringify(batch.itemIds)||receipt.compressedSha256!==undefined&&!hex.test(receipt.compressedSha256))fail('Invalid durable archive receipt');
 // Receipt paths or diagnostics are intentionally not accepted into SQLite.
 return {version:1,batchId:receipt.batchId,rawSha256:receipt.rawSha256,records:receipt.records,receiverId:receipt.receiverId,durable:true,itemIds:[...receipt.itemIds],...(receipt.compressedSha256?{compressedSha256:receipt.compressedSha256}:{})};
}
function checkedBatch(batch){
 if(!plain(batch)||batch.version!==1||!hex.test(batch.rawSha256)||batch.batchId!==batch.rawSha256||!positive(batch.records)||batch.records>1000||!Array.isArray(batch.itemIds)||batch.itemIds.length!==batch.records||new Set(batch.itemIds).size!==batch.records||batch.itemIds.some(id=>!hex.test(id))||typeof batch.body!=='string'||Buffer.byteLength(batch.body)>2097152||!batch.body.endsWith('\n')||hash(batch.body)!==batch.rawSha256)fail('Invalid archive batch');
}
function compact(db,limit=1000){
 const removed=db.prepare('DELETE FROM usage_archive_outbox WHERE sequence IN (SELECT sequence FROM usage_archive_outbox WHERE ack_batch IS NOT NULL ORDER BY sequence LIMIT ?)').run(limit).changes;
 // A small retry tail preserves idempotence even when all hot rows from a
 // just-acknowledged batch were already superseded by later revisions.
 db.prepare('DELETE FROM usage_archive_receipts WHERE batch_id IN (SELECT receipt.batch_id FROM usage_archive_receipts AS receipt WHERE NOT EXISTS(SELECT 1 FROM usage_archive_heads WHERE ack_batch=receipt.batch_id) AND NOT EXISTS(SELECT 1 FROM usage_archive_outbox WHERE ack_batch=receipt.batch_id) AND receipt.batch_id NOT IN (SELECT batch_id FROM usage_archive_receipts ORDER BY received_at DESC,rowid DESC LIMIT 64) LIMIT ?)').run(limit);
 return removed;
}
export function acknowledgeArchiveBatch(db,{batch,receipt,expectedReceiverId}={}){
 checkedBatch(batch);const safe=validateReceipt(receipt,batch,expectedReceiverId);
 return atomic(db,()=>{
  const m=meta(db);if(m.receiverId&&m.receiverId!==expectedReceiverId)fail('Archive receiver identity change requires migration');
  const existing=db.prepare('SELECT * FROM usage_archive_receipts WHERE batch_id=?').get(batch.batchId);
  if(existing){
   if(existing.receipt!==JSON.stringify(safe))fail('Conflicting durable archive receipt');
   // Already compacted rows are a valid crash retry only with this exact
   // stored receipt; never acknowledge missing rows on a new receipt.
   for(const id of batch.itemIds){const row=db.prepare('SELECT * FROM usage_archive_outbox WHERE item_id=?').get(id);if(row&&row.ack_batch!==batch.batchId)fail('Archive retry item differs');}
   db.prepare('DELETE FROM usage_archive_inflight WHERE batch_id=?').run(batch.batchId);
   return {acknowledged:0,idempotent:true,compacted:compact(db)};
  }
  const inflight=db.prepare('SELECT * FROM usage_archive_inflight WHERE singleton=1').get();
  if(!inflight||inflight.batch_id!==batch.batchId||inflight.body!==batch.body||inflight.item_ids!==JSON.stringify(batch.itemIds))fail('Archive batch is not the frozen in-flight batch');
  const getItem=db.prepare('SELECT * FROM usage_archive_outbox WHERE item_id=?'),rows=batch.itemIds.map(id=>getItem.get(id));
  if(rows.some(row=>!row||row.ack_batch!==null)||rows.map(recordLine).join('')!==batch.body)fail('Archive batch no longer matches captured items');
  for(const row of rows)assertArchiveRow(row);
  const at=new Date().toISOString();
  db.prepare('INSERT INTO usage_archive_receipts(batch_id,raw_sha256,receiver_id,records,received_at,receipt) VALUES(?,?,?,?,?,?)').run(batch.batchId,batch.rawSha256,expectedReceiverId,batch.records,at,JSON.stringify(safe));
  if(!m.receiverId)set(db,'receiverId',expectedReceiverId);
  // Use the existing head primary key. An item-only lookup would scan every
  // retained head for each receipt item as the append-only sample table grows.
  const mark=db.prepare('UPDATE usage_archive_outbox SET ack_batch=? WHERE item_id=? AND ack_batch IS NULL'),head=db.prepare('UPDATE usage_archive_heads SET ack_batch=? WHERE source_table=? AND row_key=? AND item_id=?');
  for(const row of rows){mark.run(batch.batchId,row.item_id);if(row.head_follow===1)head.run(batch.batchId,row.source_table,row.row_key,row.item_id);}
  db.prepare('DELETE FROM usage_archive_inflight WHERE batch_id=?').run(batch.batchId);
  set(db,'status','healthy');set(db,'errorCode','');set(db,'lastSuccessAt',at);
  return {acknowledged:batch.records,idempotent:false,compacted:compact(db)};
 });
}

export function setArchiveHealth(db,value={}){
 if(!plain(value)||Object.keys(value).some(k=>!['receiverId','status','lastAttemptAt','lastSuccessAt','errorCode'].includes(k)))fail('Invalid archive health');
 if(value.receiverId!==undefined&&!receiver(value.receiverId)||value.status!==undefined&&!statuses.has(value.status)||value.errorCode!==undefined&&value.errorCode!==null&&value.errorCode!==''&&!errors.has(value.errorCode)||['lastAttemptAt','lastSuccessAt'].some(k=>value[k]!==undefined&&value[k]!==null&&value[k]!==''&&!time(value[k])))fail('Invalid archive health');
 return atomic(db,()=>{const m=meta(db);if(value.receiverId&&m.receiverId&&value.receiverId!==m.receiverId)fail('Archive receiver identity change requires migration');for(const [k,v] of Object.entries(value))set(db,k,v??'');return archiveStatus(db);});
}
export function archiveStatus(db){
 const m=meta(db),counts=db.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(ack_batch IS NULL),0) AS pending,COALESCE(SUM(ack_batch IS NOT NULL),0) AS acknowledged,MIN(CASE WHEN ack_batch IS NULL THEN recorded_at END) AS oldestPendingAt FROM usage_archive_outbox').get();
 return {version:1,bootstrapComplete:m.bootstrapComplete==='1',pendingRecords:counts.pending,acknowledgedRecords:counts.acknowledged,outboxRecords:counts.total,heads:db.prepare('SELECT COUNT(*) AS n FROM usage_archive_heads').get().n,receipts:db.prepare('SELECT COUNT(*) AS n FROM usage_archive_receipts').get().n,inflightRecords:db.prepare('SELECT records FROM usage_archive_inflight WHERE singleton=1').get()?.records||0,oldestPendingAt:counts.oldestPendingAt,receiverId:m.receiverId||null,status:m.status,lastAttemptAt:m.lastAttemptAt||null,lastSuccessAt:m.lastSuccessAt||null,errorCode:m.errorCode||null,retentionRequiresArchive:true};
}

const textFields=new Set(['host_id','session_id','project','provider','model','segment_key','day','status','sample_key','account_identity','payload']);
const counterFields=['input_tokens','cached_input_tokens','output_tokens','total_tokens'],deltaFields=['delta_input','delta_cached','delta_uncached','delta_output','delta_total'];
const validMillis=value=>Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000;
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const validIdentity=value=>value==='unlinked'||typeof value==='string'&&hex.test(value);
function canonicalSourceRow(table,input){
 const columns=allColumns[table];
 if(!plain(input)||Object.keys(input).length!==columns.length||Object.keys(input).some(key=>!columns.includes(key)))fail('Invalid usage archive row shape');
 const row=Object.fromEntries(columns.map(key=>[key,input[key]]));
 if(table==='usage_samples_v2'){validateUsageSampleRow(row);return row;}
 for(const [k,v] of Object.entries(row))if(v!==null&&(textFields.has(k)?typeof v!=='string'||!v.isWellFormed()||v.length>(k==='payload'?(table==='account_usage_observations'?131072:32768):['provider','model'].includes(k)?128:256)||/[\x00-\x1f\x7f]/.test(v):!Number.isSafeInteger(v)||v<0))fail('Invalid usage archive row value');
 const text=(value,max=256)=>typeof value==='string'&&value.length>0&&value.length<=max;
 if(!text(row.host_id)||ARCHIVE_PRIMARY_KEYS[table].some(key=>row[key]===null||row[key]===undefined)||Object.hasOwn(row,'sequence')&&!positive(row.sequence)||Object.hasOwn(row,'session_id')&&!text(row.session_id)||Object.hasOwn(row,'account_identity')&&!validIdentity(row.account_identity))fail('Invalid usage archive source identity');
 for(const key of ['project','provider','model'])if(Object.hasOwn(row,key)&&row[key]!==null&&!text(row[key],key==='project'?256:128))fail('Invalid usage archive dimension');
 for(const key of ['source_ms','received_ms','first_ms','last_ms'])if(Object.hasOwn(row,key)&&!validMillis(row[key]))fail('Invalid usage archive timestamp');
 for(const key of ['observed_ms','limits_ms','usage_ms'])if(Object.hasOwn(row,key)&&row[key]!==null&&!validMillis(row[key]))fail('Invalid usage archive timestamp');
 if(Object.hasOwn(row,'day')&&!validDay(row.day))fail('Invalid usage archive day');
 if(['usage_observations','usage_baselines'].includes(table)&&counterFields.every(key=>row[key]===null))fail('Invalid usage archive counters');
 if(table==='usage_baselines'&&(!Number.isSafeInteger(row.has_delta)||row.has_delta>31||row.cached_input_tokens!==null&&row.input_tokens!==null&&row.cached_input_tokens>row.input_tokens))fail('Invalid archived usage baseline');
 if(table==='usage_observations'){
  const accepted=['delta','partial'].includes(row.status);
  if(!new Set(['baseline','delta','partial','reset','gap','out-of-order','future','stale']).has(row.status)||row.interval_ms!==null&&!positive(row.interval_ms)||!accepted&&deltaFields.some(key=>row[key]!==null)||accepted&&(row.interval_ms===null||row.interval_ms>300000)||row.status==='delta'&&deltaFields.some(key=>row[key]===null)||row.delta_cached!==null&&row.delta_input!==null&&row.delta_cached>row.delta_input||row.delta_uncached!==null&&(row.delta_input===null||row.delta_cached===null||row.delta_uncached!==row.delta_input-row.delta_cached))fail('Invalid archived usage observation');
 }
 if(table==='usage_daily'){
  const daily=['input_tokens','cached_input_tokens','uncached_input_tokens','output_tokens','total_tokens'];
  if(row.segment_key!==hash(JSON.stringify([row.project,row.provider,row.model]))||!positive(row.observations)||row.partial_observations===null||row.partial_observations>row.observations||![0,1].includes(row.overflow)||row.overflow===1&&daily.some(key=>row[key]!==null)||row.first_ms>row.last_ms)fail('Invalid archived usage day');
 }
 if(table==='account_usage_observations'){
  let account;try{account=sanitizeAccountUsage(JSON.parse(row.payload));}catch{fail('Invalid archived account usage');}
  const stamp=value=>{const parsed=value===null?NaN:Date.parse(value);return Number.isSafeInteger(parsed)&&parsed>=0?parsed:null;};
  if(JSON.stringify(account)!==row.payload||Buffer.byteLength(row.payload)>131072||hash(row.payload)!==row.sample_key||(account.accountKey??'unlinked')!==row.account_identity||stamp(account.observedAt)!==row.observed_ms||stamp(account.limitsObservedAt)!==row.limits_ms||stamp(account.usageObservedAt)!==row.usage_ms)fail('Invalid archived account usage');
 }
 if(table==='account_usage_daily'&&(row.tokens===null||!validMillis(row.observed_ms)))fail('Invalid archived account day');
 return row;
}
function assertArchiveRow(value){
 if(!positive(value.sequence)||!hex.test(value.item_id)||!Object.hasOwn(allColumns,value.source_table)||!time(value.recorded_at)||value.ack_batch!==null&&!hex.test(value.ack_batch)||value.head_follow!==undefined&&![0,1].includes(value.head_follow))fail('Invalid usage archive item');
 let row,key;try{row=JSON.parse(value.payload);key=JSON.parse(value.row_key);}catch{fail('Invalid usage archive JSON');}
 const columns=allColumns[value.source_table],keys=allKeys[value.source_table];
 if(!sameKeys(row,columns)||!sameKeys(key,keys)||JSON.stringify(canonicalSourceRow(value.source_table,row))!==value.payload||JSON.stringify(key)!==value.row_key||keys.some(k=>row[k]!==key[k]))fail('Invalid usage archive row shape');
 return row;
}

export function validateArchiveSchema(db,{samples=sampleTable(db)}={}){
 for(const [table,columns] of Object.entries(ARCHIVE_TABLE_COLUMNS))if(JSON.stringify(db.prepare(`PRAGMA table_info(${table})`).all().map(v=>v.name))!==JSON.stringify(columns)||normalizeSql(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql||'')!==normalizeSql(schemas[table]))fail('Invalid usage archive schema: '+table);
 const archiveTriggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'usage_archive_%'").all(),expectedTriggers=triggerSchemas(samples);
 if(archiveTriggers.length!==Object.keys(expectedTriggers).length||archiveTriggers.some(t=>!expectedTriggers[t.name]||normalizeSql(t.sql)!==normalizeSql(expectedTriggers[t.name])))fail('Invalid usage archive triggers');
 for(const [name,sql] of Object.entries(indexSchemas))if(normalizeSql(db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name)?.sql||'')!==normalizeSql(sql))fail('Invalid usage archive indexes');
 if(samples&&normalizeSql(db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='usage_archive_sample_receipt'").get()?.sql||'')!==normalizeSql(sampleHeadIndex))fail('Invalid usage archive sample index');
 return {version:1};
}

// Backup verification is deliberately thorough and off the ingestion path.
// Old pre-archive backups remain readable; partially present archive schemas
// and altered triggers are rejected instead of silently losing custody.
export function validateArchiveDatabase(db){
 const present=Object.keys(ARCHIVE_TABLE_COLUMNS).filter(table=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
 const archiveTriggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'usage_archive_%'").all();
 if(!present.length&&!archiveTriggers.length)return {version:1,legacy:true,pendingRecords:0};
 if(present.length!==Object.keys(ARCHIVE_TABLE_COLUMNS).length)fail('Incomplete usage archive schema');
 validateArchiveSchema(db);
 const m=meta(db);if(Object.keys(m).length!==metaKeys.size||Object.keys(m).some(k=>!metaKeys.has(k))||m.schemaVersion!=='1'||!['0','1'].includes(m.bootstrapComplete)||m.receiverId!==''&&!receiver(m.receiverId)||!statuses.has(m.status)||m.errorCode!==''&&!errors.has(m.errorCode)||[m.lastAttemptAt,m.lastSuccessAt].some(v=>v!==''&&!time(v)))fail('Invalid usage archive metadata');
 const receipts=new Map();
 for(const r of db.prepare('SELECT * FROM usage_archive_receipts').iterate()){
  let receipt;try{receipt=JSON.parse(r.receipt);}catch{fail('Invalid stored archive receipt');}
  const fake={batchId:r.batch_id,rawSha256:r.raw_sha256,records:r.records,itemIds:receipt.itemIds};
  if(!hex.test(r.batch_id)||r.batch_id!==r.raw_sha256||!positive(r.records)||r.records>1000||!time(r.received_at)||!Array.isArray(receipt.itemIds)||receipt.itemIds.length!==r.records||new Set(receipt.itemIds).size!==r.records||receipt.itemIds.some(id=>!hex.test(id))||JSON.stringify(validateReceipt(receipt,fake,r.receiver_id))!==r.receipt||r.receiver_id!==m.receiverId)fail('Invalid stored archive receipt');
  receipts.set(r.batch_id,new Set(receipt.itemIds));
 }
 for(const row of db.prepare('SELECT * FROM usage_archive_outbox').iterate()){assertArchiveRow(row);if(row.ack_batch!==null&&!receipts.get(row.ack_batch)?.has(row.item_id))fail('Archive item lacks durable receipt');}
 const inflight=db.prepare('SELECT * FROM usage_archive_inflight').all();
 if(inflight.length>1)fail('Invalid archive in-flight batch');
 for(const row of inflight){const batch={version:1,batchId:row.batch_id,rawSha256:row.raw_sha256,records:row.records,itemIds:JSON.parse(row.item_ids),body:row.body};checkedBatch(batch);const rows=batch.itemIds.map(id=>db.prepare('SELECT * FROM usage_archive_outbox WHERE item_id=?').get(id));if(row.singleton!==1||rows.some(item=>!item||item.ack_batch!==null)||rows.map(recordLine).join('')!==batch.body)fail('Archive in-flight batch differs from outbox');}
 for(const h of db.prepare('SELECT * FROM usage_archive_heads').iterate()){
  const item=db.prepare('SELECT * FROM usage_archive_outbox WHERE item_id=?').get(h.item_id);
  assertArchiveRow({...h,item_id:h.item_id,source_table:h.source_table,row_key:h.row_key,recorded_at:item?.recorded_at||'2000-01-01T00:00:00.000Z'});
  if(item?.head_follow===0||h.ack_batch===null&&(!item||item.sequence!==h.sequence||item.source_table!==h.source_table||item.row_key!==h.row_key||item.payload!==h.payload)||h.ack_batch!==null&&!receipts.get(h.ack_batch)?.has(h.item_id))fail('Archive head lacks custody');
  const key=JSON.parse(h.row_key),keys=allKeys[h.source_table],row=db.prepare(`SELECT ${jsonSql(allColumns[h.source_table],'')} AS payload FROM ${h.source_table} WHERE ${keys.map(k=>k+'=?').join(' AND ')}`).get(...keys.map(k=>key[k]));
  if(!row||row.payload!==h.payload)fail('Archive head differs from captured usage');
 }
 for(const version of db.prepare('SELECT * FROM usage_archive_source_versions').iterate()){
  if(!hex.test(version.version_key)||!hex.test(version.item_id)||!validMillis(version.seen_ms))fail('Invalid archive source-version cache');
  const item=db.prepare('SELECT * FROM usage_archive_outbox WHERE item_id=?').get(version.item_id);
  if(item){const row=JSON.parse(item.payload),semantic=Object.fromEntries(Object.entries(row).filter(([key])=>key!=='received_ms'));if(item.head_follow!==0||version.version_key!==hash(JSON.stringify([item.source_table,semantic])))fail('Archive source-version cache differs from item');}
 }
 if(m.bootstrapComplete==='1')for(const table of tablesFor(db)){const key=jsonSql(allKeys[table],'source');if(db.prepare(`SELECT 1 FROM ${table} AS source WHERE NOT EXISTS(SELECT 1 FROM usage_archive_heads AS h WHERE h.source_table=? AND h.row_key=${key}) LIMIT 1`).get(table))fail('Archive bootstrap lost a source row');}
 return {version:1,legacy:false,...archiveStatus(db)};
}
