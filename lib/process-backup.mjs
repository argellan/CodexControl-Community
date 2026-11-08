// Author: Bishop Crockett; Owner: Argellan.com; License: MIT; SPDX-License-Identifier: MIT
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {installProcessSchema,normalizeProcessSamples} from './process-history.mjs';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const fail=()=>{throw new Error('Process history schema or custody validation failed');};
const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const objects=db=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name GLOB 'process_*' OR tbl_name GLOB 'process_*' ORDER BY name").all();
const normalized=sql=>sql?.replace(/\s+/g,' ').trim();
// Construct the exact application-owned DDL in memory, never execute backup DDL.
// Supported complete contracts: absent (legacy), pre-archive V0, pre-index V1, V2.
// These are inspection contract versions; older databases have no version marker.
let contract;
function schemaContract(){
 if(contract)return contract;
 const reference=new DatabaseSync(':memory:');
 try{installProcessSchema(reference);contract=objects(reference);}finally{reference.close();}
 return contract;
}
export function processBackupObjectNames(type){return schemaContract().filter(row=>row.type===type).map(row=>row.name);}
function archiveLine(row){
 const itemId=hash(row.host_id+'\n'+row.observer_epoch+'\n'+row.source_sequence+'\n'+row.digest);
 return {version:4,itemId,sequence:row.sequence,table:'process_observations',rowKey:{host_id:row.host_id,observer_epoch:row.observer_epoch,source_sequence:row.source_sequence},recordedAt:new Date(row.received_ms).toISOString(),row};
}
function exactBatch(db,after,last,count){
 if(!integer(last,after+1)||!integer(count,1)||count>1000)fail();
 const rows=db.prepare('SELECT * FROM process_observations WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT 1001').all(after,last);
 if(rows.length!==count||rows.at(-1)?.sequence!==last)fail();
 const lines=rows.map(archiveLine),body=lines.map(row=>JSON.stringify(row)+'\n').join('');
 if(Buffer.byteLength(body)>2097152)fail();
 return {body,digest:hash(body),itemIds:lines.map(row=>row.itemId)};
}
export function validateProcessBackup(db){
 const found=objects(db);if(!found.length)return null;
 const current=schemaContract(),indexed=found.some(row=>row.name==='process_archive_sequence');
 const archiveObject=row=>row.tbl_name.startsWith('process_archive_')||['process_preserve_versions','process_preserve_history'].includes(row.name);
 const archived=found.some(archiveObject);
 const expected=current.filter(row=>(archived||!archiveObject(row))&&(indexed||row.name!=='process_archive_sequence'));
 if(found.length!==expected.length)fail();
 for(let i=0;i<found.length;i++){
  const a=found[i],b=expected[i];
  if(a.type!==b.type||a.name!==b.name||a.tbl_name!==b.tbl_name||normalized(a.sql)!==normalized(b.sql))fail();
 }
 let observations=0,bytes=0,lastSequence=0;
 for(const row of db.prepare('SELECT * FROM process_observations ORDER BY sequence').iterate()){
  if(!integer(row.sequence,lastSequence+1)||!integer(row.bytes,1)||row.bytes>524288||Buffer.byteLength(row.payload)!==row.bytes||hash(row.payload)!==row.digest||!integer(row.received_ms)||!integer(row.observed_ms)||!integer(row.source_sequence,1))fail();
  const frame=JSON.parse(row.payload),safe=normalizeProcessSamples([frame],row.host_id)[0];
  if(JSON.stringify(safe)!==row.payload||frame.epoch!==row.observer_epoch||frame.snapshot.sequence!==row.source_sequence||Date.parse(frame.snapshot.observedAt)!==row.observed_ms)fail();
  observations++;bytes+=row.bytes;lastSequence=row.sequence;
 }
 const sequence=db.prepare("SELECT seq FROM sqlite_sequence WHERE name='process_observations'").get()?.seq??0;
 if(!integer(sequence,lastSequence))fail();
 if(db.prepare('SELECT 1 FROM process_observations p LEFT JOIN host_state h ON h.host_id=p.host_id WHERE h.host_id IS NULL LIMIT 1').get())fail();
 // Full-fidelity rows remain authoritative; projections must match in both directions.
 const expectedTotals='SELECT host_id,COUNT(*) AS n,SUM(bytes) AS bytes FROM process_observations GROUP BY host_id';
 const expectedStorage='SELECT host_id,SUM(4096+8*bytes) AS logical_bytes FROM process_observations GROUP BY host_id';
 for(const [table,projection] of [['process_totals',expectedTotals],['process_storage',expectedStorage]]){
  if(db.prepare(`SELECT * FROM (${projection} EXCEPT SELECT * FROM ${table}) LIMIT 1`).get()||db.prepare(`SELECT * FROM (SELECT * FROM ${table} EXCEPT ${projection}) LIMIT 1`).get())fail();
 }
 if(!archived)return {schemaVersion:0,observations,bytes,lastSequence,receipts:0,archivedThrough:0,pendingObservations:observations,inflightRecords:0};
 let cursor=0,receiver=null,receipts=0;
 for(const row of db.prepare('SELECT * FROM process_archive_receipts ORDER BY last_sequence').iterate()){
  if(!uuid(row.receiver_id)||receiver&&receiver!==row.receiver_id||Buffer.byteLength(row.receipt)>262144)fail();
  const exact=exactBatch(db,cursor,row.last_sequence,row.records),receipt=JSON.parse(row.receipt);
  if(row.batch_id!==exact.digest||!receipt||Object.keys(receipt).some(key=>!['version','batchId','rawSha256','records','receiverId','durable','itemIds','segment'].includes(key))||receipt.version!==1||receipt.batchId!==exact.digest||receipt.rawSha256!==exact.digest||receipt.records!==row.records||receipt.receiverId!==row.receiver_id||receipt.durable!==true||JSON.stringify(receipt.itemIds)!==JSON.stringify(exact.itemIds)||receipt.segment!==undefined&&(typeof receipt.segment!=='string'||receipt.segment.length>512))fail();
  receiver=row.receiver_id;cursor=row.last_sequence;receipts++;
 }
 const pending=db.prepare('SELECT * FROM process_archive_inflight').all();if(pending.length>1)fail();
 if(pending.length){
  const row=pending[0];if(row.id!==1||!uuid(row.receiver_id)||receiver&&receiver!==row.receiver_id||Buffer.byteLength(row.body)>2097152)fail();
  const exact=exactBatch(db,cursor,row.last_sequence,row.records);if(row.body!==exact.body||row.batch_id!==exact.digest)fail();
 }
 const pendingObservations=db.prepare('SELECT COUNT(*) AS n FROM process_observations WHERE sequence>?').get(cursor).n;
 return {schemaVersion:indexed?2:1,observations,bytes,lastSequence,receipts,archivedThrough:cursor,pendingObservations,inflightRecords:pending[0]?.records??0};
}
