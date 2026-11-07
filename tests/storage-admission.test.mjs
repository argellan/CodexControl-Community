// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {HistoryJournal} from '../lib/history.mjs';
import {FleetHub} from '../lib/fleet.mjs';
import {installUsageSchema,recordUsage} from '../lib/usage-history.mjs';
import {selectArchiveBatch,acknowledgeArchiveBatch,recordSourceVersion,bootstrapUsageArchive} from '../lib/usage-archive.mjs';
import {installStorageAdmission,validateStorageAdmission,sourceOutstanding,ADMISSION_TRIGGERS,StorageBackpressure} from '../lib/storage-admission.mjs';
import {inspectJournal} from '../lib/administration.mjs';
import {createServer} from './fixture-server.mjs';

const now=Date.now(),at=n=>new Date(now+n).toISOString(),hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const session=(n=0,tokens=100)=>({id:'session',project:'TEST_ONLY',provider:'openai',model:'model',usageObservedAt:at(n),tokens:{input_tokens:tokens,cached_input_tokens:20,output_tokens:10,total_tokens:tokens+10}});
const account=(n=0,tokens=123)=>({version:1,source:'codex-app-server',status:'available',observedAt:at(n),lastAttemptAt:at(n),accountKey:'a'.repeat(64),planType:'pro',limitsObservedAt:at(n),usageObservedAt:at(n),limits:[],summary:{lifetimeTokens:tokens,peakDailyTokens:tokens,longestRunningTurnSec:10,currentStreakDays:3,longestStreakDays:5},dailyUsageBuckets:[{startDate:new Date(now).toISOString().slice(0,10),tokens}],errorCode:null});
const sample=(n=0)=>({session_id:'session',source_id:'a'.repeat(64),source_record_key:hash(String(n)),source_offset:n,source_kind:'token_usage_record',usage_scope:'response',source_ms:now-1,time_basis:'source',native_thread_id:'thread',native_turn_id:'turn',native_response_id:'response-'+n,input_tokens:100,cached_input_tokens:70,cache_write_input_tokens:0,output_tokens:20,reasoning_output_tokens:10,total_tokens:120,reported_mask:63,provider_reported_mask:0,synthesized_mask:0});
const highDisk=()=>({bavail:1000000,bsize:4096,blocks:1000000});
const options={sourceBytes:15000,freeBytes:0,workingBytes:0,freeFraction:0,statfs:highDisk};
async function fixture(fn,storageAdmission=options){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-storage-TEST_ONLY-'));try{const journal=await HistoryJournal.open({directory,storageAdmission});return await fn(journal,directory);}finally{await fs.rm(directory,{recursive:true,force:true});}}
const receipt=batch=>({version:1,batchId:batch.batchId,rawSha256:batch.rawSha256,records:batch.records,itemIds:batch.itemIds,receiverId:'TEST_ONLY',durable:true});
const drain=db=>{let batch,total=0;while((batch=selectArchiveBatch(db))){total+=acknowledgeArchiveBatch(db,{batch,receipt:receipt(batch),expectedReceiverId:'TEST_ONLY'}).acknowledged;}return total;};
const dump=journal=>journal.database(db=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM ${name}`).all()])));
const event=n=>({id:'event-'+n,sessionId:'session',at:at(n),kind:'operation'});

test('quota blocks new unique numeric usage before ACK and rolls back every version, event, state and cursor',()=>fixture(journal=>{
 const cursor={version:1,lastFileKey:null,files:{}};
 journal.commit({hostId:'host',state:{batchId:'accepted'},usageSamples:[sample()],usageCursor:cursor,now});
 const before=dump(journal);
 assert.throws(()=>journal.commit({hostId:'host',state:{batchId:'refused',sessions:[session(-1)],accountUsage:account(-1)},events:[event(-1)],usageSamples:[sample(1)],usageCursor:{...cursor,lastFileKey:'c'.repeat(64)},now}),error=>error instanceof StorageBackpressure&&error.status===503&&error.retryAfter===60);
 assert.deepEqual(dump(journal),before);
 journal.database(db=>validateStorageAdmission(db));
}));

test('source isolation, no-growth retries above quota and exact receipt drain allow progress again',()=>fixture(journal=>{
 journal.commit({hostId:'host',state:{},usageSamples:[sample()],now});
 journal.storageAdmission.sourceBytes=1;
 assert.equal(journal.commit({hostId:'host',state:{},usageSamples:[sample()],now}).samples.added,0);
 assert.throws(()=>journal.commit({hostId:'host',state:{},usageSamples:[sample(1)],now}),StorageBackpressure);
 journal.storageAdmission.sourceBytes=15000;
 journal.commit({hostId:'other',state:{},usageSamples:[sample(1)],now});
 journal.database(db=>{assert.equal(sourceOutstanding(db,'host').pending_records,1);assert.equal(sourceOutstanding(db,'other').pending_records,1);drain(db);assert.deepEqual({...sourceOutstanding(db,'host')},{pending_records:0,logical_bytes:0});validateStorageAdmission(db);});
 journal.commit({hostId:'host',state:{},usageSamples:[sample(1)],now});
 journal.database(db=>validateStorageAdmission(db));
}));

test('legacy session growth and same-timestamp corrected versions cannot bypass admission without numeric samples',()=>fixture(journal=>{
 journal.commit({hostId:'host',state:{sessions:[session(-1000)]},now:now-1000});
 journal.storageAdmission.sourceBytes=journal.database(db=>sourceOutstanding(db,'host').logical_bytes)+1;
 const before=dump(journal);
 for(const reading of [session(-1,200),session(-1000,999)]){assert.throws(()=>journal.commit({hostId:'host',state:{sessions:[reading]},now}),StorageBackpressure);assert.deepEqual(dump(journal),before);}
},{...options,sourceBytes:100000}));

test('all six source tables, mutable revisions and historical head_follow=0 consume exact durable counters',()=>fixture(journal=>{
 journal.commit({hostId:'host',state:{sessions:[session(-1000)],accountUsage:account(-1000)},usageSamples:[sample()],now:now-1000});
 journal.commit({hostId:'host',state:{sessions:[session(-1,200)],accountUsage:account(-1,200)},now});
 journal.database(db=>{
  assert.equal(db.prepare('SELECT COUNT(DISTINCT source_table) n FROM usage_archive_outbox').get().n,6);
  const before=sourceOutstanding(db,'host'),row=db.prepare('SELECT * FROM usage_observations ORDER BY sequence LIMIT 1').get();
  recordSourceVersion(db,{table:'usage_observations',row:{...row,input_tokens:999}});
  assert.equal(sourceOutstanding(db,'host').pending_records,before.pending_records+1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_archive_outbox WHERE head_follow=0').get().n,1);
  assert.ok(sourceOutstanding(db,'host').logical_bytes>before.logical_bytes);validateStorageAdmission(db);
  const batch=selectArchiveBatch(db);assert.throws(()=>acknowledgeArchiveBatch(db,{batch,receipt:{...receipt(batch),durable:false},expectedReceiverId:'TEST_ONLY'}));
  assert.equal(sourceOutstanding(db,'host').pending_records,before.pending_records+1);
  acknowledgeArchiveBatch(db,{batch,receipt:receipt(batch),expectedReceiverId:'TEST_ONLY'});
  assert.equal(sourceOutstanding(db,'host').pending_records,0);
  assert.equal(acknowledgeArchiveBatch(db,{batch,receipt:receipt(batch),expectedReceiverId:'TEST_ONLY'}).idempotent,true);validateStorageAdmission(db);
 });
},{...options,sourceBytes:1000000}));

test('legacy migration aggregates once, bootstrap and a separate archive process maintain counters',()=>fixture(async(journal,directory)=>{
 journal.commit({hostId:'host',state:{sessions:[session(-1)]},now});
 journal.database(db=>{for(const name of Object.keys(ADMISSION_TRIGGERS))db.exec('DROP TRIGGER '+name);db.exec('DROP TABLE storage_admission_sources');});
 assert.doesNotThrow(()=>inspectJournal(journal.file));
 const reopened=await HistoryJournal.open({directory,storageAdmission:options});
 reopened.database(db=>{validateStorageAdmission(db);assert.equal(sourceOutstanding(db,'host').pending_records,2);});
 const separate=new DatabaseSync(reopened.file);try{drain(separate);validateStorageAdmission(separate);assert.equal(sourceOutstanding(separate,'host').logical_bytes,0);}finally{separate.close();}
 reopened.database(db=>validateStorageAdmission(db));
 const db=new DatabaseSync(':memory:');try{installUsageSchema(db);recordUsage(db,{hostId:'legacy',state:{sessions:[session(-1)]},now});for(const name of Object.keys(ADMISSION_TRIGGERS))assert.equal(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name),undefined);installStorageAdmission(db);bootstrapUsageArchive(db);validateStorageAdmission(db);assert.ok(sourceOutstanding(db,'legacy').pending_records>0);}finally{db.close();}
}));

test('partial or altered accounting schema and corrupt backup counters are refused; consistent backup reopens',()=>fixture(async(journal,directory)=>{
 journal.commit({hostId:'host',state:{},usageSamples:[sample()],now});
 const copied=path.join(directory,'copy.sqlite'),db=new DatabaseSync(journal.file);try{await backup(db,copied);}finally{db.close();}
 assert.doesNotThrow(()=>inspectJournal(copied));
 const copy=new DatabaseSync(copied);try{copy.exec('UPDATE storage_admission_sources SET logical_bytes=logical_bytes+1');}finally{copy.close();}
 assert.throws(()=>inspectJournal(copied),/Storage admission/);
 journal.database(db=>db.exec('DROP TRIGGER storage_admission_ack'));
 assert.throws(()=>inspectJournal(journal.file),/Storage admission/);
 await assert.rejects(HistoryJournal.open({directory,storageAdmission:options}),/storage admission schema/);
}));

test('migration refuses an altered accounting trigger instead of silently repairing it',()=>{
 const db=new DatabaseSync(':memory:');try{installUsageSchema(db);installStorageAdmission(db);db.exec('DROP TRIGGER storage_admission_ack_guard');db.exec("CREATE TRIGGER storage_admission_ack_guard BEFORE UPDATE OF ack_batch ON usage_archive_outbox BEGIN SELECT 1; END");assert.throws(()=>installStorageAdmission(db),/schema/);assert.throws(()=>validateStorageAdmission(db),/schema/);}finally{db.close();}
});

test('fresh filesystem guard refuses writes at configured reserve and preserves prior data',()=>fixture(journal=>{
 journal.commit({hostId:'host',state:{batchId:'before'},usageSamples:[sample()],now});const before=dump(journal);let calls=0;
 journal.storageAdmission={...options,freeBytes:100,freeFraction:.1,workingBytes:64,statfs:()=>{calls++;return {bavail:163,bsize:1,blocks:1000};}};
 assert.throws(()=>journal.commit({hostId:'host',state:{batchId:'after'},usageSamples:[sample(1)],now}),StorageBackpressure);assert.equal(calls,1);assert.deepEqual(dump(journal),before);
 journal.storageAdmission.statfs=()=>({bavail:164,bsize:1,blocks:1000});journal.commit({hostId:'host',state:{},now});
 journal.storageAdmission.statfs=()=>{throw new Error('TEST_ONLY filesystem unavailable');};assert.throws(()=>journal.commit({hostId:'host',state:{},now}),StorageBackpressure);
}));

test('filesystem reserve is checked after opening the database and acquiring BEGIN IMMEDIATE',()=>fixture(journal=>{
 const original=journal.database.bind(journal),before=dump(journal);let available=1000,checked=false;
 journal.storageAdmission={...options,workingBytes:1,statfs:()=>{checked=true;return {bavail:available,bsize:1,blocks:1000};}};
 journal.database=fn=>{available=0;return original(fn);};
 assert.throws(()=>journal.commit({hostId:'host',state:{},usageSamples:[sample()],now}),StorageBackpressure);assert.equal(checked,true);assert.deepEqual(dump(journal),before);
}));

test('authenticated exact wire retry is read-only under pressure after restart; changed bytes or identity cannot bypass',()=>fixture(async(journal,directory)=>{
 const hosts=[{id:'host',tokenHash:hash('key')},{id:'other',tokenHash:hash('other')}],payload={hostId:'host',batchId:'batch',observedAt:at(-1),sessions:[],events:[],usageSamples:[sample()]};
 let hub=await FleetHub.open({directory,hosts,historyOptions:{storageAdmission:options}}),server=createServer({hub});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let origin=`http://127.0.0.1:${server.address().port}`,wire=JSON.stringify(payload);
 const post=(body,token='key')=>fetch(origin+'/api/collector',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body});
 try{let r=await post(wire);assert.equal(r.status,200);assert.equal((await r.json()).usageSamplesCount,1);
  server.closeAllConnections();await new Promise(r=>server.close(r));
  hub=await FleetHub.open({directory,hosts,historyOptions:{storageAdmission:{...options,statfs:()=>({bavail:0,bsize:1,blocks:1000}),workingBytes:1}}});server=createServer({hub});await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
  const before=dump(hub.journal);r=await post(wire);assert.equal(r.status,200);assert.equal((await r.json()).added,0);assert.deepEqual(dump(hub.journal),before);
  for(const changed of [wire+' ',JSON.stringify({...payload,usageSamples:[sample(1)]})]){r=await post(changed);assert.equal(r.status,503);assert.equal(r.headers.get('retry-after'),'60');assert.equal(await r.text(),'Collector batch refused');}
  r=await post(wire,'other');assert.equal(r.status,403);r=await post(wire,'wrong');assert.equal(r.status,401);assert.deepEqual(dump(hub.journal),before);
  hub.journal.database(db=>{const legacy=hub.journal.state('host');delete legacy.collectorBatchFingerprint;db.prepare('UPDATE host_state SET payload=? WHERE host_id=?').run(JSON.stringify(legacy),'host');});
  // The current process still proves its earlier durable collector acceptance.
  // An actual legacy startup has no such proof and must use normal admission.
  const legacyBefore=dump(hub.journal);r=await post(wire);assert.equal(r.status,200);assert.deepEqual(dump(hub.journal),legacyBefore);
  server.closeAllConnections();await new Promise(r=>server.close(r));
  hub=await FleetHub.open({directory,hosts,historyOptions:{storageAdmission:{...options,statfs:()=>({bavail:0,bsize:1,blocks:1000}),workingBytes:1}}});server=createServer({hub});await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
  r=await post(wire);assert.equal(r.status,503);assert.deepEqual(dump(hub.journal),legacyBefore);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}));

test('reads serve committed data with captureDeferred during pressure, catch no unrelated failures and keep local cursor',()=>fixture(async(journal,directory)=>{
 const hub=await FleetHub.open({directory,historyOptions:{storageAdmission:options}}),local={observedAt:at(-100),host:{id:'local',name:'TEST_ONLY'},sessions:[session(-100)],events:[event(-100)],coverage:{}};
 await hub.captureLocal(local);const before=dump(hub.journal),cursor=hub.journal.usageCursor('local');
 hub.journal.storageAdmission={...options,workingBytes:1,statfs:()=>({bavail:0,bsize:1,blocks:1000})};
 const fresh={...local,observedAt:at(1),sessions:[{...session(1),id:'uncommitted'}]},server=createServer({hub,viewTokenHash:hash('viewer'),readSnapshot:async()=>fresh});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const origin=`http://127.0.0.1:${server.address().port}`,headers={authorization:'Bearer viewer'};for(const endpoint of ['/api/snapshot','/api/events','/api/history','/api/account/usage']){const r=await fetch(origin+endpoint,{headers});assert.equal(r.status,200,endpoint);const body=await r.json();assert.equal(body.coverage.captureDeferred,true,endpoint);assert.ok(!JSON.stringify(body).includes('uncommitted'));}assert.deepEqual(dump(hub.journal),before);assert.deepEqual(hub.journal.usageCursor('local'),cursor);assert.equal(hub.localObservedAt,local.observedAt);
  hub.journal.commit=()=>{throw new Error('TEST_ONLY unexpected failure');};const response=await fetch(origin+'/api/snapshot',{headers});assert.equal(response.status,503);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
},{...options,sourceBytes:100000}));

test('read deferral safely handles a committed legacy or collector state without a local host object',()=>fixture(async(journal,directory)=>{
 const hub=await FleetHub.open({directory,historyOptions:{storageAdmission:options}});
 hub.journal.commit({hostId:'local',state:{observedAt:at(-1),sessions:[{id:'durable-session',hostId:'local'}]},now});
 hub.journal.storageAdmission={...options,workingBytes:1,statfs:()=>({bavail:0,bsize:1,blocks:1000})};
 const server=createServer({hub,viewTokenHash:hash('viewer'),viewers:[{id:'scoped',label:'TEST_ONLY',role:'viewer',tokenHash:hash('scoped'),hostIds:['local'],projectIds:null}],readSnapshot:async()=>({observedAt:at(1),host:{id:'local',name:'TEST_ONLY',freeMemory:12345},sessions:[{id:'uncommitted-session'}],events:[],coverage:{}})});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{for(const token of ['viewer','scoped']){const r=await fetch(`http://127.0.0.1:${server.address().port}/api/snapshot`,{headers:{authorization:'Bearer '+token}});assert.equal(r.status,200);const body=await r.json();assert.equal(body.host.id,'local');assert.equal(body.coverage.captureDeferred,true);assert.equal(body.sessions[0].id,'durable-session');assert.ok(!JSON.stringify(body).includes('uncommitted-session'));assert.equal(body.host.freeMemory,undefined);}}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}));
