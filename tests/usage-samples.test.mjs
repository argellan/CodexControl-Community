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
import {normalizeUsageSample,validateUsageSampleRow,captureUsageSamples,summarizeUsageSamples,readUsageSampleAnalytics,USAGE_SAMPLE_COLUMNS} from '../lib/usage-samples.mjs';
import {installUsageSchema,validateUsageDatabase,recordUsage} from '../lib/usage-history.mjs';
import {selectArchiveBatch,acknowledgeArchiveBatch,archiveStatus,validateArchiveDatabase,bootstrapUsageArchive} from '../lib/usage-archive.mjs';
const now=Date.parse('2026-10-20T12:00:00Z'),context={hostId:'host',receivedMs:now,sourceRole:'codex-source'};
const source=(extra={})=>({session_id:'session',source_id:'a'.repeat(64),source_record_key:'b'.repeat(64),source_offset:10,source_kind:'token_usage_record',usage_scope:'response',source_ms:now-1,time_basis:'source',native_thread_id:'thread',native_turn_id:'turn',native_response_id:'response',input_tokens:100,cached_input_tokens:70,cache_write_input_tokens:0,output_tokens:20,reasoning_output_tokens:10,total_tokens:120,reported_mask:63,provider_reported_mask:0,synthesized_mask:0,...extra});
const fixture=fn=>{const db=new DatabaseSync(':memory:');try{installUsageSchema(db);return fn(db);}finally{db.close();}};
function legacy(db){for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE '%usage_samples_v2%' OR name LIKE 'usage_samples_%')").all())db.exec('DROP TRIGGER '+row.name);db.exec("DROP TABLE usage_samples_v2; DROP TABLE usage_capture_cursors; DROP INDEX usage_archive_sample_receipt; UPDATE usage_meta SET value='1' WHERE key='schemaVersion'");}
const receipt=batch=>({version:1,batchId:batch.batchId,rawSha256:batch.rawSha256,records:batch.records,itemIds:batch.itemIds,receiverId:'test',durable:true});

test('43-column canonical samples retain all six counters and source/context identity without inventing production attribution',()=>{
 const row=normalizeUsageSample(source({project:'調査 🛰️',context_model:'configured'}),context);assert.equal(Object.keys(row).length,43);assert.deepEqual(Object.keys(row),USAGE_SAMPLE_COLUMNS);assert.equal(row.producing_model,null);assert.equal(row.context_model,'configured');assert.equal(row.cache_write_input_tokens,0);assert.equal(validateUsageSampleRow(row),row);
 const later=normalizeUsageSample(source({project:'調査 🛰️',context_model:'configured'}),{...context,receivedMs:now+100});assert.equal(later.sample_key,row.sample_key);
 const semantic=USAGE_SAMPLE_COLUMNS.filter(k=>!['sample_key','received_ms'].includes(k)).map(k=>row[k]);assert.equal(row.sample_key,crypto.createHash('sha256').update(JSON.stringify(semantic)).digest('hex'));
});
test('present invalid counters, absent counters and zero remain distinct; inconsistent safe values remain evidence',()=>{
 const row=normalizeUsageSample(source({input_tokens:null,cached_input_tokens:700,output_tokens:2,reasoning_output_tokens:10}),context);assert.equal(row.input_tokens,null);assert.equal(row.cached_input_tokens,700);assert.equal(row.reasoning_output_tokens,10);
 assert.throws(()=>normalizeUsageSample(source({reported_mask:62}),context));assert.throws(()=>normalizeUsageSample(source({producing_model:'invented'}),context));assert.throws(()=>normalizeUsageSample(source({prompt:'private'}),context));assert.throws(()=>normalizeUsageSample(source({provider_reported_mask:1,synthesized_mask:1}),context));
});
test('accounting class is derived from trusted role and fork evidence, never supplied by a collector',()=>{
 assert.equal(normalizeUsageSample(source({forked_from_id:'parent'}),context).accounting_class,'fork-excluded');assert.equal(normalizeUsageSample(source({forked_from_id:'parent'}),{...context,sourceRole:'execution-target'}).accounting_class,'execution-excluded');assert.equal(normalizeUsageSample(source(),{...context,sourceRole:'unknown'}).accounting_class,'unknown');assert.throws(()=>normalizeUsageSample(source({accounting_class:'candidate'}),context));
});
test('sample capture, archive outbox and caller rollback remain atomic; exact retry does not write another item',()=>fixture(db=>{
 bootstrapUsageArchive(db);db.exec('BEGIN');captureUsageSamples(db,[source()],context);assert.equal(archiveStatus(db).pendingRecords,1);db.exec('ROLLBACK');assert.equal(archiveStatus(db).pendingRecords,0);
 const first=captureUsageSamples(db,[source()],context);assert.deepEqual(first,{received:1,added:1,duplicates:0});const sequence=db.prepare("SELECT seq FROM sqlite_sequence WHERE name='usage_archive_outbox'").get().seq;assert.equal(captureUsageSamples(db,[source()],{...context,receivedMs:now+100}).added,0);assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='usage_archive_outbox'").get().seq,sequence);
 const batch=selectArchiveBatch(db),item=JSON.parse(batch.body);assert.equal(item.version,2);assert.equal(item.table,'usage_samples_v2');assert.deepEqual(Object.keys(item.row),USAGE_SAMPLE_COLUMNS);validateArchiveDatabase(db);
}));
test('UPDATE and INSERT OR REPLACE cannot mutate an immutable sample even with recursive triggers disabled',()=>fixture(db=>{
 captureUsageSamples(db,[source()],context);const before=db.prepare('SELECT * FROM usage_samples_v2').get();db.exec('PRAGMA recursive_triggers=OFF');assert.throws(()=>db.exec('UPDATE usage_samples_v2 SET input_tokens=0'));assert.throws(()=>db.prepare(`INSERT OR REPLACE INTO usage_samples_v2 VALUES(${USAGE_SAMPLE_COLUMNS.map(()=>'?')})`).run(...USAGE_SAMPLE_COLUMNS.map(k=>before[k])));assert.deepEqual(db.prepare('SELECT * FROM usage_samples_v2').get(),before);
}));
test('hot sample eviction is impossible until its exact current version has a durable receiver receipt',()=>fixture(db=>{
 bootstrapUsageArchive(db);captureUsageSamples(db,[source()],context);assert.equal(db.prepare('DELETE FROM usage_samples_v2').run().changes,0);const batch=selectArchiveBatch(db);acknowledgeArchiveBatch(db,{batch,receipt:receipt(batch),expectedReceiverId:'test'});assert.equal(db.prepare('DELETE FROM usage_samples_v2').run().changes,1);validateArchiveDatabase(db);
}));
test('V1 migration preserves exact in-flight retry bytes, old table schemas, heads and receipts',()=>fixture(db=>{
 legacy(db);validateUsageDatabase(db);db.prepare("INSERT INTO account_usage_daily VALUES('host','unlinked','2026-10-19',12,?,?)").run(now,now);db.exec("UPDATE usage_meta SET value='1' WHERE key='accountDaily'");bootstrapUsageArchive(db);const before=selectArchiveBatch(db);const schemas=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' OR type='table'").all();installUsageSchema(db);assert.equal(validateUsageDatabase(db).schemaVersion,2);assert.deepEqual(selectArchiveBatch(db),before);for(const row of schemas)assert.equal(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(row.name).sql,row.sql);acknowledgeArchiveBatch(db,{batch:before,receipt:receipt(before),expectedReceiverId:'test'});validateArchiveDatabase(db);
}));
test('a damaged V2 schema is refused without opportunistic trigger repair',()=>fixture(db=>{
 db.exec('DROP TRIGGER usage_archive_usage_samples_v2_insert');assert.throws(()=>installUsageSchema(db),/archive triggers/);assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='usage_archive_usage_samples_v2_insert'").get(),undefined);
}));
test('startup refuses missing append-only guards before accepting any writable source state',()=>fixture(db=>{db.exec('DROP TRIGGER usage_samples_immutable; DROP TRIGGER usage_samples_no_replace');assert.throws(()=>installUsageSchema(db));}));
test('V2 hot retention removes only acknowledged samples and keeps pending evidence past limits',()=>fixture(db=>{
 bootstrapUsageArchive(db);captureUsageSamples(db,[source()],context);recordUsage(db,{hostId:'host',state:{},now:now+1000,retention:{rawAgeMs:1,trimIntervalMs:1,maxRawObservations:1}});assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_samples_v2').get().n,1);const batch=selectArchiveBatch(db);acknowledgeArchiveBatch(db,{batch,receipt:receipt(batch),expectedReceiverId:'test'});recordUsage(db,{hostId:'host',state:{},now:now+2000,retention:{rawAgeMs:1,trimIntervalMs:1,maxRawObservations:1}});assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_samples_v2').get().n,0);validateArchiveDatabase(db);
}));
test('pressure recovery drains exact-receipted samples each poll while age trimming is not due, preserving pending rows',()=>fixture(db=>{
 bootstrapUsageArchive(db);
 const rows=Array.from({length:2010},(_,i)=>source({source_offset:i,source_record_key:crypto.createHash('sha256').update(String(i)).digest('hex'),native_response_id:'response-'+i}));
 for(let i=0;i<2005;i+=256)captureUsageSamples(db,rows.slice(i,Math.min(2005,i+256)),context);
 let batch;while((batch=selectArchiveBatch(db)))acknowledgeArchiveBatch(db,{batch,receipt:receipt(batch),expectedReceiverId:'test'});
 captureUsageSamples(db,rows.slice(2005),context);
 db.prepare("UPDATE usage_meta SET value=? WHERE key='lastTrimMs'").run(String(now));
 const pendingBefore=archiveStatus(db).pendingRecords;
 const poll=offset=>recordUsage(db,{hostId:'host',state:{},now:now+offset,retention:{maxSampleObservations:1,trimIntervalMs:60000}});
 poll(1);assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_samples_v2').get().n,1010);
 poll(2);assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_samples_v2').get().n,10);
 poll(3);assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_samples_v2').get().n,5);
 poll(4);assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_samples_v2').get().n,5);
 assert.equal(archiveStatus(db).pendingRecords,pendingBefore);assert.equal(db.prepare("SELECT value FROM usage_meta WHERE key='lastTrimMs'").get().value,String(now));
 assert.deepEqual(db.prepare('SELECT source_offset FROM usage_samples_v2 ORDER BY source_offset').all().map(r=>r.source_offset),[2005,2006,2007,2008,2009]);
 assert.equal(db.prepare("SELECT value FROM usage_meta WHERE key='trimmedRaw'").get().value,'2005');validateArchiveDatabase(db);
}));

test('response totals deduplicate native identities, separate cumulative scopes, preserve unknowns and use weighted ratios',()=>{
 const a=normalizeUsageSample(source(),context),copy=normalizeUsageSample(source({source_record_key:'c'.repeat(64)}),context),b=normalizeUsageSample(source({source_record_key:'d'.repeat(64),native_response_id:'response2',input_tokens:900,cached_input_tokens:90,output_tokens:80,reasoning_output_tokens:8,total_tokens:980}),context),cumulative=normalizeUsageSample(source({usage_scope:'thread-total',input_tokens:999999}),context);
 const report=summarizeUsageSamples([a,copy,b,cumulative],{now});assert.equal(report.responses.responseCount,2);assert.equal(report.responses.totals.input,1000);assert.equal(report.responses.ratios.cacheHit.value,.16);assert.equal(report.responses.ratios.reasoningShare.value,.18);assert.equal(report.responses.turns[0].responseCount,2);assert.equal(report.recent.length,4);
 const conflict=normalizeUsageSample(source({source_record_key:'e'.repeat(64),input_tokens:99}),context),bad=summarizeUsageSamples([a,conflict],{now});assert.equal(bad.responses.responseCount,0);assert.equal(bad.coverage.conflictingResponses,1);assert.equal(bad.responses.ratios.cacheHit.value,null);
});
test('sample analytics applies host/project/session SQL scope before counts and aggregation',()=>fixture(db=>{
 captureUsageSamples(db,[source({project:'Visible'})],context);captureUsageSamples(db,[source({project:'Secret'})],{...context,hostId:'other'});const report=readUsageSampleAnalytics(db,{now,hostIds:['host'],projectIds:['Visible']});assert.equal(report.coverage.retainedRows,1);assert.equal(report.responses.totals.input,100);assert.equal(report.recent[0].host_id,'host');assert.equal(JSON.stringify(report).includes('Secret'),false);assert.equal(readUsageSampleAnalytics(db,{now,hostIds:[]}).coverage.retainedRows,0);
}));
test('native thread/session boundaries and configured providers never merge into one comparison bucket',()=>{
 const a=normalizeUsageSample(source({context_model:'shared',context_provider:'provider-a'}),context),b=normalizeUsageSample(source({source_record_key:'c'.repeat(64),native_thread_id:'other-thread',context_model:'shared',context_provider:'provider-b'}),context),c=normalizeUsageSample(source({source_record_key:'d'.repeat(64),native_response_id:'third',native_session_id:'other-native-session',context_model:'shared',context_provider:'provider-a'}),context);
 const report=summarizeUsageSamples([a,b,c],{now});assert.equal(report.responses.turns.length,3);assert.equal(report.responses.dimensions.length,2);assert.deepEqual(new Set(report.responses.dimensions.map(r=>r.contextProvider)),new Set(['provider-a','provider-b']));
});
