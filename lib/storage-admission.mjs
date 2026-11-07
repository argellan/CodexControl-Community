// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {statfsSync} from 'node:fs';
import path from 'node:path';

// Logical admission charge, not a measurement or promise of physical allocation.
// Charge UTF-8 payload/key copies, indexes and fixed per-version overhead. The
// independent fresh filesystem reserve protects SQLite/WAL working space.
export const DEFAULT_STORAGE_ADMISSION=Object.freeze({sourceBytes:128*1048576,freeBytes:1073741824,freeFraction:.1,workingBytes:64*1048576});
export class StorageBackpressure extends Error{constructor(){super('Storage admission deferred');this.name='StorageBackpressure';this.code='STORAGE_BACKPRESSURE';this.status=503;this.retryAfter=60;}}
export const isStorageBackpressure=error=>error instanceof StorageBackpressure;
export const ADMISSION_TABLE_COLUMNS=Object.freeze({storage_admission_sources:['schema_version','host_id','pending_records','logical_bytes']});
const tableSql='CREATE TABLE storage_admission_sources(schema_version INTEGER NOT NULL CHECK(schema_version=1),host_id TEXT PRIMARY KEY,pending_records INTEGER NOT NULL CHECK(pending_records>=0),logical_bytes INTEGER NOT NULL CHECK(logical_bytes>=0))';
const host=alias=>`json_extract(${alias}.payload,'$.host_id')`;
const charge=alias=>`(4096+8*(length(CAST(${alias}.payload AS BLOB))+length(CAST(${alias}.row_key AS BLOB))+length(CAST(${alias}.source_table AS BLOB))+length(CAST(${host(alias)} AS BLOB))))`;
const validAck=`EXISTS(SELECT 1 FROM usage_archive_receipts WHERE batch_id=NEW.ack_batch AND raw_sha256=batch_id AND receiver_id=(SELECT value FROM usage_archive_meta WHERE key='receiverId'))`;
export const ADMISSION_TRIGGERS=Object.freeze({
 storage_admission_insert:`CREATE TRIGGER storage_admission_insert AFTER INSERT ON usage_archive_outbox WHEN NEW.ack_batch IS NULL BEGIN INSERT INTO storage_admission_sources(schema_version,host_id,pending_records,logical_bytes) VALUES(1,${host('NEW')},1,${charge('NEW')}) ON CONFLICT(host_id) DO UPDATE SET pending_records=pending_records+1,logical_bytes=logical_bytes+excluded.logical_bytes; END`,
 storage_admission_ack_guard:`CREATE TRIGGER storage_admission_ack_guard BEFORE UPDATE OF ack_batch ON usage_archive_outbox WHEN OLD.ack_batch IS NULL AND NEW.ack_batch IS NOT NULL AND NOT (${validAck}) BEGIN SELECT RAISE(ABORT,'Archive admission receipt required'); END`,
 storage_admission_ack:`CREATE TRIGGER storage_admission_ack AFTER UPDATE OF ack_batch ON usage_archive_outbox WHEN OLD.ack_batch IS NULL AND NEW.ack_batch IS NOT NULL AND ${validAck} BEGIN UPDATE storage_admission_sources SET pending_records=pending_records-1,logical_bytes=logical_bytes-${charge('OLD')} WHERE host_id=${host('OLD')}; END`
});
const normalized=sql=>sql.replace(/\s+/g,' ').replace(/;$/,'').trim();
const expected={storage_admission_sources:tableSql,...ADMISSION_TRIGGERS};
const objects=db=>db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name LIKE 'storage_admission_%'").all();
function checkSchema(rows){if(rows.length!==Object.keys(expected).length||rows.some(row=>!Object.hasOwn(expected,row.name)||normalized(row.sql)!==normalized(expected[row.name])||row.type!==(row.name==='storage_admission_sources'?'table':'trigger')))throw new Error('Invalid storage admission schema');}
export function validateStorageAdmission(db,{counters=true}={}){
 const rows=objects(db);if(!rows.length)return {legacy:true};checkSchema(rows);
 if(counters){
  const actual=db.prepare(`SELECT ${host('o')} AS host_id,COUNT(*) AS pending_records,SUM(${charge('o')}) AS logical_bytes FROM usage_archive_outbox AS o WHERE ack_batch IS NULL GROUP BY ${host('o')}`).all();
  const stored=db.prepare('SELECT * FROM storage_admission_sources').all(),map=new Map(actual.map(row=>[row.host_id,row]));
  for(const row of stored){const current=map.get(row.host_id);if(row.schema_version!==1||typeof row.host_id!=='string'||!row.host_id||!Number.isSafeInteger(row.pending_records)||!Number.isSafeInteger(row.logical_bytes)||row.pending_records!==(current?.pending_records??0)||row.logical_bytes!==(current?.logical_bytes??0))throw new Error('Storage admission accounting mismatch');map.delete(row.host_id);}
  if(map.size)throw new Error('Storage admission accounting missing');
 }
 return {schemaVersion:1};
}
export function installStorageAdmission(db){
 // One consistent aggregate only when upgrading a legacy database. All future
 // source versions (including bootstrap/head_follow=0) and ACKs use triggers.
 db.exec('SAVEPOINT storage_admission_install');try{
  const rows=objects(db);if(rows.length){checkSchema(rows);db.exec('RELEASE storage_admission_install');return;}
  db.exec(tableSql);
  db.exec(`INSERT INTO storage_admission_sources SELECT 1,${host('o')},COUNT(*),SUM(${charge('o')}) FROM usage_archive_outbox AS o WHERE ack_batch IS NULL GROUP BY ${host('o')}`);
  for(const sql of Object.values(ADMISSION_TRIGGERS))db.exec(sql);
  db.exec('RELEASE storage_admission_install');
 }catch(error){db.exec('ROLLBACK TO storage_admission_install; RELEASE storage_admission_install');throw error;}
}
export function sourceOutstanding(db,hostId){return db.prepare('SELECT pending_records,logical_bytes FROM storage_admission_sources WHERE host_id=?').get(hostId)??{pending_records:0,logical_bytes:0};}
export function storageAdmissionOptions(options={}){
 const result={...DEFAULT_STORAGE_ADMISSION,...options};
 for(const key of ['sourceBytes','freeBytes','workingBytes'])if(!Number.isSafeInteger(result[key])||result[key]<0)throw new Error('Invalid storage admission option');
 if(typeof result.freeFraction!=='number'||!Number.isFinite(result.freeFraction)||result.freeFraction<0||result.freeFraction>1||result.statfs!==undefined&&typeof result.statfs!=='function')throw new Error('Invalid storage admission option');
 return result;
}
export function requireStorageReserve(file,options,additionalBytes=0,additionalFiles=0){
 if(!Number.isSafeInteger(additionalBytes)||additionalBytes<0||!Number.isSafeInteger(additionalFiles)||additionalFiles<0)throw new StorageBackpressure();
 let disk;try{disk=(options.statfs??statfsSync)(path.dirname(file));}catch{throw new StorageBackpressure();}
 // Filesystems without a finite inode pool report files=0 (for example NTFS).
 if(additionalFiles>0&&Number.isSafeInteger(disk.files)&&disk.files>0&&(!Number.isSafeInteger(disk.ffree)||disk.ffree<Math.max(2,Math.ceil(disk.files*options.freeFraction))+additionalFiles))throw new StorageBackpressure();
 const available=Number(disk.bavail)*Number(disk.bsize),total=Number(disk.blocks)*Number(disk.bsize);
 if(!Number.isSafeInteger(available)||!Number.isSafeInteger(total)||available<0||total<0||available<Math.max(options.freeBytes,total*options.freeFraction)+options.workingBytes+additionalBytes)throw new StorageBackpressure();
}
export function requireSourceCapacity(before,after,options){if(after.logical_bytes>before.logical_bytes&&after.logical_bytes>options.sourceBytes)throw new StorageBackpressure();}
