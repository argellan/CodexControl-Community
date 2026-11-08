// Author: Bishop Crockett; Owner: Argellan.com; License: MIT; SPDX-License-Identifier: MIT
import crypto from 'node:crypto';
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const fail=()=>{throw new Error('Invalid process archive custody');};
const exists=db=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='process_observations'").get();
export function installProcessArchive(db){
 if(!exists(db))return false;
 db.exec(`CREATE TABLE IF NOT EXISTS process_archive_receipts(batch_id TEXT PRIMARY KEY,receiver_id TEXT NOT NULL,last_sequence INTEGER NOT NULL,records INTEGER NOT NULL,receipt TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS process_archive_sequence ON process_archive_receipts(last_sequence);
 CREATE TABLE IF NOT EXISTS process_archive_inflight(id INTEGER PRIMARY KEY CHECK(id=1),receiver_id TEXT NOT NULL,body TEXT NOT NULL,batch_id TEXT NOT NULL,last_sequence INTEGER NOT NULL,records INTEGER NOT NULL);
 CREATE TRIGGER IF NOT EXISTS process_preserve_versions BEFORE UPDATE ON process_observations BEGIN SELECT RAISE(ABORT,'Process observations are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS process_preserve_history BEFORE DELETE ON process_observations BEGIN SELECT RAISE(IGNORE); END;`);
 return true;
}
const batchOf=r=>({version:4,body:r.body,batchId:r.batch_id,rawSha256:r.batch_id,lastSequence:r.last_sequence,records:r.records,itemIds:r.body.trim().split('\n').map(line=>JSON.parse(line).itemId)});
function checkReceiver(db,id){
 if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))fail();
 const row=db.prepare('SELECT receiver_id FROM process_archive_receipts LIMIT 1').get();if(row&&row.receiver_id!==id)fail();
}
export function selectProcessArchiveBatch(db,{receiverId,maxRecords=100,maxBytes=2097152}={}){
 if(!exists(db))return null;
 if(!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>1000||!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>2097152)fail();
 checkReceiver(db,receiverId);
 const old=db.prepare('SELECT * FROM process_archive_inflight WHERE id=1').get();if(old){if(old.receiver_id!==receiverId)fail();return batchOf(old);}
 const cursor=db.prepare('SELECT COALESCE(MAX(last_sequence),0) AS n FROM process_archive_receipts').get().n;
 const rows=db.prepare('SELECT * FROM process_observations WHERE sequence>? ORDER BY sequence LIMIT ?').all(cursor,maxRecords);let body='',last=0,count=0;
 for(const row of rows){
  if(hash(row.payload)!==row.digest)fail();
  const itemId=hash(row.host_id+'\n'+row.observer_epoch+'\n'+row.source_sequence+'\n'+row.digest);
  const record={version:4,itemId,sequence:row.sequence,table:'process_observations',rowKey:{host_id:row.host_id,observer_epoch:row.observer_epoch,source_sequence:row.source_sequence},recordedAt:new Date(row.received_ms).toISOString(),row};
  const line=JSON.stringify(record)+'\n';if(Buffer.byteLength(body)+Buffer.byteLength(line)>maxBytes)break;body+=line;last=row.sequence;count++;
 }
 if(!count){if(rows.length)throw new Error('Process archive record exceeds batch bound');return null;}
 const batchId=hash(body);db.prepare('INSERT INTO process_archive_inflight VALUES(1,?,?,?,?,?)').run(receiverId,body,batchId,last,count);return batchOf({body,batch_id:batchId,last_sequence:last,records:count});
}
export function acknowledgeProcessArchive(db,{batch,receipt,receiverId}){
 checkReceiver(db,receiverId);const pending=db.prepare('SELECT * FROM process_archive_inflight WHERE id=1').get();
 if(!pending||pending.receiver_id!==receiverId||pending.body!==batch.body||pending.batch_id!==batch.batchId||batch.batchId!==hash(batch.body))fail();
 const exact=batchOf(pending);
 if(!receipt||receipt.version!==1||receipt.receiverId!==receiverId||receipt.durable!==true||receipt.batchId!==exact.batchId||receipt.rawSha256!==exact.batchId||receipt.records!==exact.records||JSON.stringify(receipt.itemIds)!==JSON.stringify(exact.itemIds))fail();
 db.prepare('INSERT INTO process_archive_receipts VALUES(?,?,?,?,?)').run(exact.batchId,receiverId,exact.lastSequence,exact.records,JSON.stringify(receipt));db.prepare('DELETE FROM process_archive_inflight WHERE id=1').run();
 // Local history remains intact even after verification. No eviction is enabled.
}
export function processArchiveStatus(db,hostId){
 const tables=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='process_archive_receipts'").get();
 const cursor=tables?db.prepare('SELECT COALESCE(MAX(last_sequence),0) AS n FROM process_archive_receipts').get().n:0;
 const pending=db.prepare('SELECT COUNT(*) AS n FROM process_observations WHERE host_id=? AND sequence>?').get(hostId,cursor).n;
 const archived=db.prepare('SELECT MAX(sequence) AS n FROM process_observations WHERE host_id=? AND sequence<=?').get(hostId,cursor).n;
 return {status:pending?'pending-local-custody':archived?'verified-local-retained':'awaiting-capture',pendingObservations:pending,lastArchivedSequence:archived??0,evictionAllowed:false};
}
