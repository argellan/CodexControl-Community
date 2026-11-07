// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import crypto from 'node:crypto';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

export function installGitHubArchive(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS archive_receipts(batch_id TEXT PRIMARY KEY, receiver_id TEXT NOT NULL, last_sequence INTEGER NOT NULL, records INTEGER NOT NULL, bytes INTEGER NOT NULL, receipt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS archive_inflight(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL, batch_id TEXT NOT NULL, last_sequence INTEGER NOT NULL, records INTEGER NOT NULL, bytes INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS archive_health(id INTEGER PRIMARY KEY CHECK(id=1),attempt_at TEXT NOT NULL,error TEXT);`);
}

export function githubArchiveStatus(db) {
  const row = db.prepare('SELECT COALESCE(MAX(last_sequence),0) AS sequence,COALESCE(SUM(records),0) AS records,COALESCE(SUM(bytes),0) AS bytes,COUNT(*) AS receipts FROM archive_receipts').get();
  const pending = db.prepare('SELECT COUNT(*) AS pages,COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM observations WHERE sequence>?').get(row.sequence);
  const health=db.prepare('SELECT * FROM archive_health WHERE id=1').get();
  return {status:health?.error?'unavailable':!health?'not_configured':pending.pages?'pending':row.receipts?'healthy':'awaiting_capture',error:health?.error||null,lastAttemptAt:health?.attempt_at||null,evictionEnabled:false,receipts:row.receipts,archivedPages:row.records,archivedBytes:row.bytes,pendingPages:pending.pages,pendingBytes:pending.bytes,lastArchivedSequence:row.sequence};
}

export function selectGitHubArchiveBatch(db,{maxRecords=100,maxBytes=1048576}={}) {
  if (!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>1000||!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>2097152) throw new Error('Invalid GitHub archive bounds');
  const existing = db.prepare('SELECT * FROM archive_inflight WHERE id=1').get();
  if (existing) return batchOf(existing);
  db.exec('BEGIN IMMEDIATE');
  try {
    const inflight=db.prepare('SELECT * FROM archive_inflight WHERE id=1').get();
    if(inflight){db.exec('COMMIT');return batchOf(inflight);}
    const configuration=JSON.parse(db.prepare('SELECT payload FROM binding WHERE id=1').get().payload);
    const epoch=db.prepare('SELECT epoch FROM journal WHERE id=1').get().epoch;
    const cursor=db.prepare('SELECT COALESCE(MAX(last_sequence),0) AS n FROM archive_receipts').get().n;
    const rows=db.prepare('SELECT sequence,payload FROM observations WHERE sequence>? ORDER BY sequence LIMIT ?').all(cursor,maxRecords);
    let body='',last=0,count=0,logicalBytes=0;
    for(const source of rows){
      const captured=JSON.parse(source.payload), row={source_id:configuration.sourceId,host_id:configuration.hostId,project:configuration.project,epoch,sequence:source.sequence,payload:source.payload};
      const itemId=digest(epoch+'\n'+source.sequence+'\n'+source.payload);
      const record={version:3,itemId,sequence:source.sequence,table:'github_metadata',rowKey:{source_id:configuration.sourceId,epoch,sequence:source.sequence},recordedAt:captured.observedAt,row};
      const line=JSON.stringify(record)+'\n';
      if(Buffer.byteLength(body)+Buffer.byteLength(line)>maxBytes)break;
      body+=line;last=source.sequence;count++;logicalBytes+=Buffer.byteLength(source.payload);
    }
    if(!count){db.exec('COMMIT');if(rows.length)throw new Error('GitHub archive record exceeds batch bound');return null;}
    const batchId=digest(body);
    db.prepare('INSERT INTO archive_inflight VALUES(1,?,?,?,?,?)').run(body,batchId,last,count,logicalBytes);
    db.exec('COMMIT');return batchOf({body,batch_id:batchId,last_sequence:last,records:count,bytes:logicalBytes});
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
function batchOf(value){return {body:value.body,batchId:value.batch_id,rawSha256:value.batch_id,lastSequence:value.last_sequence,records:value.records,bytes:value.bytes,itemIds:value.body.trim().split('\n').map(line=>JSON.parse(line).itemId)};}

// The transport verifies receiver identity, durable receipt and exact membership
// before this transaction. Recheck the immutable pending bytes before advancement.
export function acknowledgeGitHubArchive(db,batch,receipt){
  if(!receipt||receipt.durable!==true||receipt.batchId!==batch.batchId||receipt.rawSha256!==digest(batch.body)||receipt.records!==batch.records||JSON.stringify(receipt.itemIds)!==JSON.stringify(batch.itemIds))throw new Error('Invalid GitHub archive receipt');
  db.exec('BEGIN IMMEDIATE');
  try{
    const pending=db.prepare('SELECT * FROM archive_inflight WHERE id=1').get();
    if(!pending||pending.batch_id!==batch.batchId||pending.body!==batch.body)throw new Error('GitHub archive batch changed');
    const previous=db.prepare('SELECT receiver_id FROM archive_receipts LIMIT 1').get();
    if(previous&&previous.receiver_id!==receipt.receiverId)throw new Error('GitHub archive receiver changed');
    db.prepare('INSERT INTO archive_receipts VALUES(?,?,?,?,?,?)').run(batch.batchId,receipt.receiverId,pending.last_sequence,pending.records,pending.bytes,JSON.stringify(receipt));
    db.prepare('DELETE FROM archive_inflight WHERE id=1 AND batch_id=?').run(batch.batchId);db.exec('COMMIT');
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
