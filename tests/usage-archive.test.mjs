// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {installUsageSchema,recordUsage,USAGE_TABLE_COLUMNS} from '../lib/usage-history.mjs';
import {sanitizeAccountUsage} from '../lib/account-usage.mjs';
import {installUsageArchive,bootstrapUsageArchive,selectArchiveBatch,acknowledgeArchiveBatch,archiveStatus,archiveDeletionGuard,setArchiveHealth,validateArchiveDatabase,recordSourceVersion,ARCHIVE_TABLE_COLUMNS,ARCHIVE_SOURCE_COLUMNS,ARCHIVE_TRIGGER_NAMES} from '../lib/usage-archive.mjs';

const NOW=Date.parse('2026-10-20T12:00:00Z'),at=n=>new Date(NOW+n).toISOString();
const session=(n=0,tokens=1000)=>({id:'session',project:'Alpha',provider:'openai',model:'model',usageObservedAt:at(n),tokens:{input_tokens:tokens,cached_input_tokens:Math.floor(tokens/4),output_tokens:Math.floor(tokens/10),total_tokens:tokens+Math.floor(tokens/10)}});
const account=(n=0,tokens=123)=>({version:1,source:'codex-app-server',status:'available',observedAt:at(n),lastAttemptAt:at(n),accountKey:'a'.repeat(64),planType:'pro',limitsObservedAt:at(n),usageObservedAt:at(n),limits:[],summary:{lifetimeTokens:tokens,peakDailyTokens:tokens,longestRunningTurnSec:10,currentStreakDays:3,longestStreakDays:5},dailyUsageBuckets:[{startDate:'2026-10-19',tokens}],errorCode:null});
function fixture(fn){const db=new DatabaseSync(':memory:');try{installUsageSchema(db);installUsageArchive(db);return fn(db);}finally{db.close();}}
const write=(db,n=0,tokens=1000,extra={})=>recordUsage(db,{hostId:'host',state:{sessions:[session(n,tokens)],...extra},now:NOW+n});
const receipt=(batch,extra={})=>({version:1,batchId:batch.batchId,rawSha256:batch.rawSha256,records:batch.records,receiverId:'receiver-test',durable:true,itemIds:[...batch.itemIds],compressedSha256:'c'.repeat(64),...extra});
const ack=(db,batch=selectArchiveBatch(db))=>acknowledgeArchiveBatch(db,{batch,receipt:receipt(batch),expectedReceiverId:'receiver-test'});
function removeArchive(db){for(const name of ARCHIVE_TRIGGER_NAMES)db.exec(`DROP TRIGGER ${name}`);for(const name of Object.keys(ARCHIVE_TABLE_COLUMNS))db.exec(`DROP TABLE ${name}`);}
function seedAll(db){write(db,0,1000);write(db,1000,1500,{accountUsage:account(1000)});}

test('all captured usage tables are covered with exact source columns and transactional triggers',()=>fixture(db=>{
 for(const [table,columns] of Object.entries(ARCHIVE_SOURCE_COLUMNS))assert.deepEqual(columns,USAGE_TABLE_COLUMNS[table]);
 seedAll(db);const tables=db.prepare('SELECT DISTINCT source_table FROM usage_archive_outbox').all().map(r=>r.source_table).sort();assert.deepEqual(tables,Object.keys(ARCHIVE_SOURCE_COLUMNS).sort());
 const batch=selectArchiveBatch(db),items=batch.body.trimEnd().split('\n').map(JSON.parse);
 assert.equal(batch.records,7);assert.equal(new Set(batch.itemIds).size,batch.records);assert.equal(crypto.createHash('sha256').update(batch.body).digest('hex'),batch.rawSha256);
 for(const item of items){assert.deepEqual(Object.keys(item),['version','itemId','sequence','table','rowKey','recordedAt','row']);assert.match(item.itemId,/^[a-f0-9]{64}$/);assert.deepEqual(Object.keys(item.row),ARCHIVE_SOURCE_COLUMNS[item.table]);for(const [k,v] of Object.entries(item.rowKey))assert.equal(item.row[k],v);}
 assert.equal(validateArchiveDatabase(db).pendingRecords,7);
}));
test('capture and its archive outbox roll back together under the caller transaction',()=>fixture(db=>{
 db.exec('BEGIN IMMEDIATE');seedAll(db);assert.ok(archiveStatus(db).pendingRecords>0);db.exec('ROLLBACK');assert.equal(archiveStatus(db).pendingRecords,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_observations').get().n,0);validateArchiveDatabase(db);
}));
test('no-op updates produce no archive records and meaningful mutable revisions retain old values',()=>fixture(db=>{
 seedAll(db);const before=archiveStatus(db).pendingRecords;
 db.exec('UPDATE usage_daily SET input_tokens=input_tokens');assert.equal(archiveStatus(db).pendingRecords,before);
 db.exec('UPDATE usage_daily SET input_tokens=input_tokens+1');assert.equal(archiveStatus(db).pendingRecords,before+1);
 const values=db.prepare("SELECT json_extract(payload,'$.input_tokens') AS tokens FROM usage_archive_outbox WHERE source_table='usage_daily' ORDER BY sequence").all().map(r=>r.tokens);assert.deepEqual(values,[500,501]);validateArchiveDatabase(db);
}));
test('all five hot tables refuse eviction until the latest captured revision is acknowledged',()=>fixture(db=>{
 seedAll(db);for(const table of Object.keys(ARCHIVE_SOURCE_COLUMNS)){const before=db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;db.exec(`DELETE FROM ${table}`);assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,before);assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${archiveDeletionGuard(table)}`).get().n,0);}
 ack(db);for(const table of Object.keys(ARCHIVE_SOURCE_COLUMNS)){assert.ok(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${archiveDeletionGuard(table)}`).get().n>0);db.exec(`DELETE FROM ${table}`);assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);}assert.equal(archiveStatus(db).heads,0);validateArchiveDatabase(db);
}));
test('a new daily or baseline revision cannot inherit the prior version receipt',()=>fixture(db=>{
 seedAll(db);ack(db);assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM usage_daily WHERE ${archiveDeletionGuard('usage_daily')}`).get().n,1);
 write(db,2000,2000,{accountUsage:account(2000,222)});for(const table of ['usage_daily','usage_baselines','account_usage_daily']){assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${archiveDeletionGuard(table)}`).get().n,0);db.exec(`DELETE FROM ${table}`);assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,1);}ack(db);validateArchiveDatabase(db);
}));
test('outage and raw retention pressure preserve every captured observation in SQLite',()=>fixture(db=>{
 const retention={rawAgeMs:1,maxRawObservations:1,maxBaselines:1,maxDailyRows:1,trimIntervalMs:1};
 for(let i=0;i<30;i++)recordUsage(db,{hostId:'host',state:{sessions:[session(i*1000,1000+i*100)]},now:NOW+i*1000,retention});
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_observations').get().n,30);assert.equal(archiveStatus(db).pendingRecords,89);assert.equal(archiveStatus(db).receiverId,null);assert.equal(archiveStatus(db).status,'unconfigured');validateArchiveDatabase(db);
}));
test('bootstrap migration is bounded and protects existing rows before they have archive heads',()=>fixture(db=>{
 seedAll(db);removeArchive(db);assert.equal(validateArchiveDatabase(db).legacy,true);installUsageArchive(db);
 for(const table of Object.keys(ARCHIVE_SOURCE_COLUMNS))db.exec(`DELETE FROM ${table}`);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_observations').get().n,2);
 let result=bootstrapUsageArchive(db,{limit:1}),total=result.added,iterations=0;while(!result.complete){assert.equal(result.added,1);result=bootstrapUsageArchive(db,{limit:1});total+=result.added;if(++iterations>30)throw Error('Bootstrap never completed');}
 assert.equal(total,6);assert.equal(bootstrapUsageArchive(db,{limit:1}).added,0);assert.equal(archiveStatus(db).bootstrapComplete,true);validateArchiveDatabase(db);
}));
test('bootstrap plus writes do not duplicate current rows or miss updates during migration',()=>fixture(db=>{
 write(db);removeArchive(db);installUsageArchive(db);bootstrapUsageArchive(db,{limit:1});write(db,1000,1200);let result;do{result=bootstrapUsageArchive(db,{limit:2});}while(!result.complete);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_archive_heads WHERE source_table='usage_observations'").get().n,2);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_archive_outbox WHERE source_table='usage_baselines'").get().n,2);assert.deepEqual(db.prepare("SELECT json_extract(payload,'$.input_tokens') AS tokens FROM usage_archive_outbox WHERE source_table='usage_baselines' ORDER BY sequence").all().map(r=>r.tokens),[1000,1200]);validateArchiveDatabase(db);
}));
test('a primary-key update archives both identities without orphaning a current-row head',()=>fixture(db=>{
 write(db);db.exec("UPDATE usage_baselines SET session_id='renamed'");assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_archive_heads WHERE source_table='usage_baselines'").get().n,1);const batch=selectArchiveBatch(db),versions=batch.body.trimEnd().split('\n').map(JSON.parse).filter(v=>v.table==='usage_baselines');assert.deepEqual(versions.map(v=>v.rowKey.session_id),['session','renamed']);validateArchiveDatabase(db);
}));
test('failed or partial receipts never acknowledge any row or unblock pruning',()=>fixture(db=>{
 seedAll(db);const batch=selectArchiveBatch(db),before=archiveStatus(db).pendingRecords;
 for(const change of [{durable:false},{records:batch.records-1},{itemIds:batch.itemIds.slice(1)},{itemIds:[...batch.itemIds].reverse()},{rawSha256:'0'.repeat(64)},{batchId:'0'.repeat(64)},{receiverId:'wrong'},{compressedSha256:'invalid'}]){assert.throws(()=>acknowledgeArchiveBatch(db,{batch,receipt:receipt(batch,change),expectedReceiverId:'receiver-test'}),/receipt/);assert.equal(archiveStatus(db).pendingRecords,before);assert.equal(archiveStatus(db).receipts,0);}
 validateArchiveDatabase(db);
}));
test('ACK requires exact captured item bytes and cannot use an arbitrary high watermark',()=>fixture(db=>{
 seedAll(db);const batch=selectArchiveBatch(db),changed={...batch,body:batch.body.replace('Alpha','Other')};changed.rawSha256=changed.batchId=crypto.createHash('sha256').update(changed.body).digest('hex');assert.throws(()=>acknowledgeArchiveBatch(db,{batch:changed,receipt:receipt(changed),expectedReceiverId:'receiver-test'}),/frozen|captured/);
 assert.throws(()=>acknowledgeArchiveBatch(db,{batch:{...batch,throughSequence:999999,body:batch.body+'\n'},receipt:receipt(batch),expectedReceiverId:'receiver-test'}),/batch/);assert.equal(archiveStatus(db).pendingRecords,batch.records);validateArchiveDatabase(db);
}));
test('frozen in-flight batches are byte-identical after new capture and size-setting changes',()=>fixture(db=>{
 write(db);const first=selectArchiveBatch(db,{maxRecords:1});write(db,1000,1200);assert.deepEqual(selectArchiveBatch(db,{maxRecords:1000}),first);assert.equal(archiveStatus(db).inflightRecords,1);ack(db,first);const second=selectArchiveBatch(db);assert.notEqual(second.batchId,first.batchId);assert.equal(second.itemIds.includes(first.itemIds[0]),false);validateArchiveDatabase(db);
}));
test('exact durable ACK is idempotent after compaction, with head receipts still proving current custody',()=>fixture(db=>{
 seedAll(db);const batch=selectArchiveBatch(db);assert.equal(ack(db,batch).acknowledged,batch.records);assert.equal(archiveStatus(db).outboxRecords,0);assert.equal(archiveStatus(db).inflightRecords,0);assert.equal(ack(db,batch).idempotent,true);assert.equal(selectArchiveBatch(db),null);assert.equal(archiveStatus(db).heads,6);assert.equal(archiveStatus(db).receiverId,'receiver-test');validateArchiveDatabase(db);
}));
test('a superseded-only batch still has an idempotent retry receipt after compaction',()=>fixture(db=>{
 write(db);const first=selectArchiveBatch(db,{maxRecords:1});write(db,1000,1200);ack(db,first);assert.equal(ack(db,first).idempotent,true);validateArchiveDatabase(db);
}));
test('pending archive items are immutable and cannot be deleted before receipt',()=>fixture(db=>{
 write(db);assert.throws(()=>db.exec("UPDATE usage_archive_outbox SET payload='{}'"),/immutable/);assert.throws(()=>db.exec('DELETE FROM usage_archive_outbox'),/Unacknowledged/);assert.equal(archiveStatus(db).pendingRecords,2);validateArchiveDatabase(db);
}));
test('receiver binding cannot change accidentally and only fixed health codes are persisted',()=>fixture(db=>{
 assert.equal(setArchiveHealth(db,{receiverId:'receiver-test',status:'sending',lastAttemptAt:at(0),errorCode:null}).receiverId,'receiver-test');assert.throws(()=>setArchiveHealth(db,{receiverId:'other',status:'healthy'}),/migration/);assert.throws(()=>setArchiveHealth(db,{status:'failed',errorCode:'password was secret'}),/health/);assert.throws(()=>setArchiveHealth(db,{lastAttemptAt:'today'}),/health/);assert.throws(()=>setArchiveHealth(db,{message:'secret'}),/health/);setArchiveHealth(db,{status:'failed',errorCode:'ARCHIVE_TRANSPORT_FAILED'});seedAll(db);const batch=selectArchiveBatch(db);assert.throws(()=>acknowledgeArchiveBatch(db,{batch,receipt:receipt(batch,{receiverId:'other'}),expectedReceiverId:'other'}),/migration/);assert.equal(archiveStatus(db).pendingRecords,batch.records);validateArchiveDatabase(db);
}));
test('batch, bootstrap and SQL aliases enforce hard bounds',()=>fixture(db=>{
 seedAll(db);for(const value of [0,-1,1.2,1001]){assert.throws(()=>bootstrapUsageArchive(db,{limit:value}),/limit/);assert.throws(()=>selectArchiveBatch(db,{maxRecords:value}),/limit/);}assert.throws(()=>selectArchiveBatch(db,{maxBytes:2097153}),/limit/);assert.throws(()=>selectArchiveBatch(db,{maxBytes:1}),/budget/);assert.throws(()=>archiveDeletionGuard('events'),/source/);assert.throws(()=>archiveDeletionGuard('usage_daily','x); DROP TABLE events;--'),/alias/);const alias='source';ack(db);assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM usage_daily AS source WHERE ${archiveDeletionGuard('usage_daily',alias)}`).get().n,1);
}));
test('backup validator rejects partial schema, added columns, altered triggers and false receipt/heads',()=>{
 const mutations=[db=>db.exec('DROP TABLE usage_archive_inflight'),db=>db.exec('ALTER TABLE usage_archive_heads ADD COLUMN extra TEXT'),db=>db.exec(`DROP TRIGGER ${ARCHIVE_TRIGGER_NAMES[0]}`),db=>db.exec("UPDATE usage_archive_meta SET value='unknown' WHERE key='status'"),db=>db.exec("UPDATE usage_archive_heads SET payload='{}'"),db=>db.exec("UPDATE usage_archive_heads SET ack_batch='a'"),db=>db.exec("UPDATE usage_archive_inflight SET body='{}\n'")];
 for(const mutate of mutations)fixture(db=>{seedAll(db);selectArchiveBatch(db);validateArchiveDatabase(db);mutate(db);assert.throws(()=>validateArchiveDatabase(db));});
 fixture(db=>{seedAll(db);ack(db);db.exec("UPDATE usage_archive_receipts SET receiver_id='other'");assert.throws(()=>validateArchiveDatabase(db));});
});
test('startup refuses a partially present or modified archive schema instead of silently repairing custody',()=>{
 for(const mutate of [db=>db.exec('DROP TABLE usage_archive_inflight'),db=>db.exec(`DROP TRIGGER ${ARCHIVE_TRIGGER_NAMES[0]}`),db=>db.exec('ALTER TABLE usage_archive_heads ADD COLUMN extra TEXT')])fixture(db=>{seedAll(db);mutate(db);assert.throws(()=>installUsageArchive(db),/archive/);});
});
test('explicit same-source versions preserve full supplied provenance without touching or acknowledging hot heads',()=>fixture(db=>{
 seedAll(db);const heads=JSON.stringify(db.prepare('SELECT * FROM usage_archive_heads ORDER BY source_table,row_key').all()),original=db.prepare('SELECT * FROM usage_observations ORDER BY sequence LIMIT 1').get();
 const revised={...original,input_tokens:2000,cached_input_tokens:500,output_tokens:200,total_tokens:2200,received_ms:NOW+5000,status:'out-of-order',interval_ms:null,delta_input:null,delta_cached:null,delta_uncached:null,delta_output:null,delta_total:null};
 assert.equal(recordSourceVersion(db,{table:'usage_observations',row:revised}),1);assert.equal(JSON.stringify(db.prepare('SELECT * FROM usage_archive_heads ORDER BY source_table,row_key').all()),heads);assert.equal(db.prepare('SELECT input_tokens FROM usage_observations WHERE sequence=?').get(original.sequence).input_tokens,1000);
 const pending=db.prepare('SELECT * FROM usage_archive_outbox WHERE head_follow=0').get(),payload=JSON.parse(pending.payload);assert.equal(payload.sequence,original.sequence);assert.equal(payload.source_ms,original.source_ms);assert.equal(payload.received_ms,NOW+5000);assert.equal(payload.input_tokens,2000);
 const first=selectArchiveBatch(db,{maxRecords:1});ack(db,first);const rest=selectArchiveBatch(db);ack(db,rest);assert.equal(db.prepare('SELECT item_id FROM usage_archive_heads WHERE source_table=? AND row_key=?').get('usage_observations',pending.row_key).item_id===pending.item_id,false);validateArchiveDatabase(db);
}));
test('historical-only ACK cannot create a hot head or grant another row a prune receipt',()=>fixture(db=>{
 seedAll(db);const first=selectArchiveBatch(db);const day=db.prepare('SELECT * FROM account_usage_daily').get();assert.equal(recordSourceVersion(db,{table:'account_usage_daily',row:{...day,tokens:999,observed_ms:NOW-1000,received_ms:NOW+1000}}),1);ack(db,first);
 const hot=db.prepare('SELECT * FROM account_usage_daily').get();db.prepare('UPDATE account_usage_daily SET tokens=?').run(555);const unackedHead=db.prepare("SELECT * FROM usage_archive_heads WHERE source_table='account_usage_daily'").get();
 const historical=selectArchiveBatch(db,{maxRecords:1});assert.equal(JSON.parse(historical.body.trimEnd()).row.tokens,999);ack(db,historical);
 assert.deepEqual(db.prepare("SELECT * FROM usage_archive_heads WHERE source_table='account_usage_daily'").get(),unackedHead);assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM account_usage_daily WHERE ${archiveDeletionGuard('account_usage_daily')}`).get().n,0);db.exec('DELETE FROM account_usage_daily');assert.equal(db.prepare('SELECT tokens FROM account_usage_daily').get().tokens,555);assert.equal(hot.tokens,123);validateArchiveDatabase(db);
}));
test('source-version dedup canonicalizes columns, ignores only received time and preserves source corrections',()=>fixture(db=>{
 seedAll(db);const row=db.prepare('SELECT * FROM account_usage_daily').get();assert.equal(recordSourceVersion(db,{table:'account_usage_daily',row}),1);const pending=archiveStatus(db).pendingRecords;
 const reordered=Object.fromEntries(Object.entries({...row,received_ms:row.received_ms+1000}).reverse());assert.equal(recordSourceVersion(db,{table:'account_usage_daily',row:reordered}),0);assert.equal(archiveStatus(db).pendingRecords,pending);
 assert.equal(recordSourceVersion(db,{table:'account_usage_daily',row:{...row,tokens:row.tokens+1}}),1);assert.equal(recordSourceVersion(db,{table:'account_usage_daily',row:{...row,observed_ms:row.observed_ms+1}}),1);const saved=db.prepare('SELECT payload FROM usage_archive_outbox WHERE head_follow=0 ORDER BY sequence LIMIT 1').get();assert.deepEqual(JSON.parse(saved.payload),{...row});validateArchiveDatabase(db);
}));
test('a historical source-only record with a natural key never invents a source sequence or current head',()=>fixture(db=>{
 seedAll(db);const row={...db.prepare('SELECT * FROM account_usage_daily').get(),day:'2023-01-01',observed_ms:NOW-10000,received_ms:NOW};assert.equal(recordSourceVersion(db,{table:'account_usage_daily',row}),1);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_archive_heads WHERE source_table='account_usage_daily'").get().n,1);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM account_usage_daily WHERE day='2023-01-01'").get().n,0);const saved=JSON.parse(db.prepare('SELECT payload FROM usage_archive_outbox WHERE head_follow=0').get().payload);assert.equal(Object.hasOwn(saved,'sequence'),false);validateArchiveDatabase(db);
}));
test('explicit source versions reject invalid rows, fabricated sequence identities and account sample mismatches',()=>fixture(db=>{
 seedAll(db);const source=db.prepare('SELECT * FROM usage_observations ORDER BY sequence LIMIT 1').get(),day=db.prepare('SELECT * FROM account_usage_daily').get(),accountRow=db.prepare('SELECT * FROM account_usage_observations').get();
 for(const row of [{...source,sequence:9999},{...source,source_ms:source.source_ms+1},{...source,input_tokens:-1},{...source,status:'invented'},{...source,status:'delta',interval_ms:null},{...source,extra:'private'},{...source,host_id:null}])assert.throws(()=>recordSourceVersion(db,{table:'usage_observations',row}));
 for(const row of [{...day,day:'2026-02-31'},{...day,tokens:null},{...day,observed_ms:null},{...day,account_identity:'email@example.test'}])assert.throws(()=>recordSourceVersion(db,{table:'account_usage_daily',row}));
 assert.throws(()=>recordSourceVersion(db,{table:'account_usage_observations',row:{...accountRow,sample_key:'b'.repeat(64)}}));assert.throws(()=>recordSourceVersion(db,{table:'events',row:{}}));assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_archive_source_versions').get().n,0);validateArchiveDatabase(db);
}));
test('source-version cache eviction removes only dedup metadata and never pending evidence',()=>fixture(db=>{
 seedAll(db);const row=db.prepare('SELECT * FROM account_usage_daily').get();recordSourceVersion(db,{table:'account_usage_daily',row});const old=db.prepare('SELECT * FROM usage_archive_source_versions').get();db.exec('UPDATE usage_archive_source_versions SET seen_ms=0');recordSourceVersion(db,{table:'account_usage_daily',row:{...row,tokens:124}});assert.equal(db.prepare('SELECT 1 FROM usage_archive_source_versions WHERE version_key=?').get(old.version_key),undefined);assert.ok(db.prepare('SELECT 1 FROM usage_archive_outbox WHERE item_id=? AND ack_batch IS NULL').get(old.item_id));assert.equal(recordSourceVersion(db,{table:'account_usage_daily',row}),1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_archive_outbox WHERE head_follow=0').get().n,3);validateArchiveDatabase(db);
}));
test('sanitized undated full account buckets and pre-epoch source strings remain exact evidence',()=>fixture(db=>{
 const days=Array.from({length:366},(_,i)=>({startDate:new Date(NOW-i*86400000).toISOString().slice(0,10),tokens:i+1}));
 const value=sanitizeAccountUsage({...account(),observedAt:'1969-12-31T23:59:59.000Z',limitsObservedAt:'1969-12-31T23:59:59.000Z',usageObservedAt:null,dailyUsageBuckets:days}),payload=JSON.stringify(value),sample=crypto.createHash('sha256').update(payload).digest('hex');assert.ok(Buffer.byteLength(payload)>8192);assert.ok(Buffer.byteLength(payload)<32768);
 db.prepare('INSERT INTO account_usage_observations(host_id,sample_key,observed_ms,limits_ms,usage_ms,received_ms,account_identity,payload) VALUES(?,?,?,?,?,?,?,?)').run('host',sample,null,null,null,NOW,'a'.repeat(64),payload);
 const row=db.prepare('SELECT * FROM account_usage_observations').get();assert.equal(recordSourceVersion(db,{table:'account_usage_observations',row}),1);const batch=selectArchiveBatch(db),items=batch.body.trimEnd().split('\n').map(JSON.parse);assert.equal(items.length,2);for(const item of items){assert.equal(item.row.observed_ms,null);assert.equal(item.row.limits_ms,null);assert.equal(item.row.usage_ms,null);assert.equal(item.row.payload,payload);assert.equal(JSON.parse(item.row.payload).dailyUsageBuckets.length,366);}validateArchiveDatabase(db);
}));
test('caller rollback reverts explicit source versions and dedup cache together',()=>fixture(db=>{
 seedAll(db);const before=archiveStatus(db).pendingRecords,row=db.prepare('SELECT * FROM account_usage_daily').get();db.exec('BEGIN');recordSourceVersion(db,{table:'account_usage_daily',row});db.exec('ROLLBACK');assert.equal(archiveStatus(db).pendingRecords,before);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_archive_source_versions').get().n,0);validateArchiveDatabase(db);
}));
test('backup validation refuses source-version cache contamination and historical-head reassignment',()=>{
 for(const change of [db=>db.exec("UPDATE usage_archive_source_versions SET version_key='bad'"),db=>db.exec('UPDATE usage_archive_source_versions SET seen_ms=-1'),db=>db.exec("UPDATE usage_archive_source_versions SET item_id=(SELECT item_id FROM usage_archive_outbox WHERE head_follow=1 LIMIT 1)"),db=>db.exec("UPDATE usage_archive_heads SET item_id=(SELECT item_id FROM usage_archive_outbox WHERE head_follow=0 LIMIT 1) WHERE source_table='account_usage_daily'")])fixture(db=>{seedAll(db);recordSourceVersion(db,{table:'account_usage_daily',row:db.prepare('SELECT * FROM account_usage_daily').get()});change(db);assert.throws(()=>validateArchiveDatabase(db));});
});
test('dedup and immutable retry survive reopen and ACK compaction without requiring a hot historical head',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-source-version-')),file=path.join(dir,'history.sqlite');let db=new DatabaseSync(file);
 try{installUsageSchema(db);seedAll(db);const row=db.prepare('SELECT * FROM account_usage_daily').get();recordSourceVersion(db,{table:'account_usage_daily',row:{...row,tokens:999}});const first=selectArchiveBatch(db);db.close();db=new DatabaseSync(file);installUsageArchive(db);assert.deepEqual(selectArchiveBatch(db),first);assert.equal(recordSourceVersion(db,{table:'account_usage_daily',row:{...row,tokens:999,received_ms:row.received_ms+1000}}),0);ack(db,first);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_archive_outbox').get().n,0);assert.equal(recordSourceVersion(db,{table:'account_usage_daily',row:{...row,tokens:999,received_ms:row.received_ms+2000}}),0);assert.equal(archiveStatus(db).pendingRecords,0);validateArchiveDatabase(db);}finally{db.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('reopen preserves frozen retry and complete schema; copied older backups cannot collide on reused sequences',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-archive-')),file=path.join(dir,'history.sqlite'),old=path.join(dir,'old.sqlite');let db=new DatabaseSync(file);
 try{installUsageSchema(db);installUsageArchive(db);write(db);db.exec(`VACUUM INTO '${old.replace(/'/g,"''")}'`);const first=selectArchiveBatch(db);db.close();db=new DatabaseSync(file);installUsageArchive(db);assert.deepEqual(selectArchiveBatch(db),first);ack(db,first);write(db,1000,1200);const newer=selectArchiveBatch(db),newItems=newer.body.trimEnd().split('\n').map(JSON.parse);db.close();db=new DatabaseSync(old);installUsageArchive(db);write(db,1000,1200);const restored=selectArchiveBatch(db),restoredItems=restored.body.trimEnd().split('\n').map(JSON.parse);const reused=newItems.find(r=>r.table==='usage_observations'),restoredReused=restoredItems.find(r=>r.table==='usage_observations'&&r.row.source_ms===NOW+1000);assert.equal(restoredReused.sequence,reused.sequence);assert.notEqual(restoredReused.itemId,reused.itemId);validateArchiveDatabase(db);}finally{db.close();await fs.rm(dir,{recursive:true,force:true});}
});
