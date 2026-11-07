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
import {spawn} from 'node:child_process';
import {gzipSync,gunzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {installUsageSchema,recordUsage} from '../lib/usage-history.mjs';
import {bootstrapUsageArchive,selectArchiveBatch,archiveStatus} from '../lib/usage-archive.mjs';
import {pumpUsageArchive} from '../scripts/archive-usage.mjs';

const PYTHON=process.env.CODEX_TEST_PYTHON||(process.platform==='win32'?'python':'python3');
const RECEIVER=fileURLToPath(new URL('../scripts/archive-receiver.py',import.meta.url));
const ID='8bc63ea3-56d7-4ae5-bc32-fec7bdfd25b8',NOW=Date.parse('2026-10-20T12:00:00Z');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const session=(n=1000,offset=0)=>({id:'TEST_ONLY_worker',project:'TEST_ONLY_project',provider:'openai',model:'TEST_ONLY_model',usageObservedAt:new Date(NOW+offset).toISOString(),tokens:{input_tokens:n,cached_input_tokens:n/4,output_tokens:n/10,total_tokens:n+n/10}});
function local(database,fn){const db=new DatabaseSync(database);try{db.exec('PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL;');return fn(db);}finally{db.close();}}
function write(database,n=1000,offset=0){return local(database,db=>recordUsage(db,{hostId:'TEST_ONLY_source',state:{sessions:[session(n,offset)]},now:NOW+offset}));}
function launch(config,input=Buffer.alloc(0),args=[]){return new Promise((resolve,reject)=>{
 const child=spawn(PYTHON,[RECEIVER,'--config',config,...args],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});let stdout='',stderr='',done=false;
 const timer=setTimeout(()=>{child.kill('SIGKILL');if(!done){done=true;reject(new Error('TEST_ONLY receiver timed out'));}},15000);
 child.on('error',error=>{clearTimeout(timer);if(!done){done=true;reject(error);}});child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>4194304)child.kill('SIGKILL');});child.stderr.on('data',chunk=>{stderr+=chunk;if(stderr.length>131072)child.kill('SIGKILL');});child.stdin.on('error',()=>{});
 child.on('close',code=>{clearTimeout(timer);if(!done){done=true;resolve({code,stdout,stderr});}});child.stdin.end(input);
 });}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-archive-E2E-TEST_ONLY-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const database=path.join(root,'history.sqlite'),receiverConfig=path.join(root,'receiver.json'),cold=path.join(root,'cold'),catalog=path.join(root,'catalog');
 local(database,db=>installUsageSchema(db));await fs.chmod(database,0o600);await fs.writeFile(receiverConfig,JSON.stringify({archiveDirectory:cold,catalogDirectory:catalog,receiverId:ID}),{mode:0o600});
 const config={version:1,database,receiverId:ID,ssh:{executable:process.execPath,host:'TEST_ONLY.example.test',port:22,user:'TEST_ONLY_archive',identityFile:path.join(root,'TEST_ONLY_identity'),knownHostsFile:path.join(root,'TEST_ONLY_known_hosts')}};
 const receive=async compressed=>{const result=await launch(receiverConfig,compressed);assert.equal(result.code,0,result.stderr);return result.stdout;};
 const transport=async args=>receive(args.compressed),health=()=>local(database,db=>archiveStatus(db));
 const query=async()=>{const result=await launch(receiverConfig,undefined,['--query']);assert.equal(result.code,0,result.stderr);return result.stdout.trim()?result.stdout.trim().split('\n').map(JSON.parse):[];};
 return {root,database,receiverConfig,cold,config,receive,transport,health,query};
}

test('real Python receiver and Node pump preserve exact captured records and durable ACKs',async t=>{
 const f=await fixture(t);write(f.database);write(f.database,1600,1000);const result=await pumpUsageArchive(f.config,{transport:f.transport});assert.ok(result.records>0);assert.equal(f.health().pendingRecords,0);assert.equal(f.health().receiverId,ID);const records=await f.query();assert.equal(records.length,result.records);assert.equal(new Set(records.map(row=>row.itemId)).size,records.length);assert.ok(records.some(item=>item.table==='usage_observations'&&item.row.delta_input===600));
 const again=await pumpUsageArchive(f.config,{transport:async()=>assert.fail('all captured versions were already archived')});assert.equal(again.records,0);assert.equal((await f.query()).length,records.length);
});

test('already frozen extended-year account batches retry byte-exact and allow later fleet records to drain',async t=>{
 const f=await fixture(t),stamp='+010000-01-01T00:00:00.000Z',account={version:1,source:'codex-app-server',status:'partial',observedAt:stamp,lastAttemptAt:stamp,accountKey:null,planType:null,limitsObservedAt:stamp,usageObservedAt:null,limits:[],summary:{},dailyUsageBuckets:null,errorCode:null};
 local(f.database,db=>recordUsage(db,{hostId:'TEST_ONLY_source',state:{sessions:[],accountUsage:account},now:NOW}));
 const frozen=local(f.database,db=>{bootstrapUsageArchive(db);return selectArchiveBatch(db);});assert.ok(frozen.body.includes(stamp));
 const pending=f.health().pendingRecords;assert.ok(pending>0);write(f.database,1000,1000);let first=true;
 const result=await pumpUsageArchive(f.config,{transport:async args=>{if(first){assert.equal(args.batch.batchId,frozen.batchId);assert.equal(args.batch.body,frozen.body);assert.deepEqual(args.batch.itemIds,frozen.itemIds);first=false;}return f.transport(args);}});
 assert.ok(result.records>pending);assert.equal(f.health().pendingRecords,0);const archived=await f.query(),accountRow=archived.find(r=>r.table==='account_usage_observations');assert.equal(JSON.parse(accountRow.row.payload).lastAttemptAt,stamp);assert.ok(archived.some(r=>r.table==='usage_observations'));assert.equal(new Set(archived.map(r=>r.itemId)).size,archived.length);
});

test('real remote commit followed by lost ACK retries without duplication despite new ingestion',async t=>{
 const f=await fixture(t);write(f.database);let original,stored;
 await assert.rejects(pumpUsageArchive(f.config,{transport:async args=>{original=args.batch;stored=JSON.parse(await f.receive(args.compressed));write(f.database,1600,1000);throw Object.assign(new Error('TEST_ONLY lost ACK after remote fsync'),{code:'ARCHIVE_TRANSPORT_FAILED'});}}),/ARCHIVE_TRANSPORT_FAILED/);assert.ok(f.health().pendingRecords>0);assert.equal(f.health().lastSuccessAt,null);
 let calls=0;await pumpUsageArchive(f.config,{transport:async args=>{calls++;if(calls===1){assert.equal(args.batch.body,original.body);assert.equal(args.batch.batchId,stored.batchId);}return f.transport(args);}});assert.ok(calls>=2);assert.equal(f.health().pendingRecords,0);const records=await f.query();assert.equal(new Set(records.map(row=>row.itemId)).size,records.length);assert.ok(records.some(item=>item.table==='usage_observations'&&item.row.delta_input===600));
});

test('real raw-address retry accepts the stored gzip encoding when sender gzip header differs',async t=>{
 const f=await fixture(t);write(f.database);const batch=local(f.database,db=>{bootstrapUsageArchive(db);return selectArchiveBatch(db);});const normal=gzipSync(Buffer.from(batch.body),{level:1}),alternate=Buffer.from(normal);alternate[4]=alternate[4]===1?2:1;assert.deepEqual(gunzipSync(alternate),Buffer.from(batch.body));assert.notEqual(digest(alternate),digest(normal));
 const first=JSON.parse(await f.receive(alternate));assert.equal(first.compressedSha256,digest(alternate));let duplicate;
 const result=await pumpUsageArchive(f.config,{transport:async args=>{assert.equal(digest(args.compressed),digest(normal));const raw=await f.receive(args.compressed);duplicate=JSON.parse(raw);assert.equal(duplicate.compressedSha256,digest(alternate));assert.equal(duplicate.receivedCompressedSha256,digest(normal));return raw;}});assert.equal(result.records,batch.records);assert.equal(duplicate.batchId,batch.batchId);assert.equal(f.health().pendingRecords,0);assert.deepEqual(await fs.readFile(path.join(f.cold,first.segment)),alternate);assert.equal((await f.query()).length,batch.records);
});

test('an invalid received-stream hash cannot ACK an otherwise real durable receiver receipt',async t=>{
 const f=await fixture(t);write(f.database);await assert.rejects(pumpUsageArchive(f.config,{transport:async args=>{const receipt=JSON.parse(await f.receive(args.compressed));receipt.receivedCompressedSha256='f'.repeat(64);return JSON.stringify(receipt);}}),/ARCHIVE_RECEIPT/);assert.ok(f.health().pendingRecords>0);await pumpUsageArchive(f.config,{transport:f.transport});assert.equal(f.health().pendingRecords,0);
});

test('real committed ACK permits pruning only the exact covered version of a mutable row',async t=>{
 const f=await fixture(t);write(f.database);await pumpUsageArchive({...f.config,maxBatches:1},{transport:async args=>{const receipt=await f.receive(args.compressed);write(f.database,1600,1000);return receipt;}});assert.ok(f.health().pendingRecords>0);
 let trimClock=NOW+31*86400000;const trim=()=>local(f.database,db=>recordUsage(db,{hostId:'TEST_ONLY_source',state:{sessions:[]},now:++trimClock,retention:{rawAgeMs:1,dailyAgeMs:1,trimIntervalMs:1}}));trim();
 local(f.database,db=>{assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_observations WHERE sequence=1').get().n,0);assert.equal(db.prepare('SELECT input_tokens FROM usage_observations WHERE sequence=2').get().input_tokens,1600);assert.equal(db.prepare('SELECT input_tokens FROM usage_baselines').get().input_tokens,1600);assert.equal(db.prepare('SELECT input_tokens FROM usage_daily').get().input_tokens,600);});
 await pumpUsageArchive(f.config,{transport:f.transport});trim();local(f.database,db=>{assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_observations').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_baselines').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_daily').get().n,0);});
 const records=await f.query();assert.ok(records.some(item=>item.table==='usage_baselines'&&item.row.input_tokens===1000));assert.ok(records.some(item=>item.table==='usage_baselines'&&item.row.input_tokens===1600));assert.ok(records.some(item=>item.table==='usage_observations'&&item.row.sequence===1));assert.ok(records.some(item=>item.table==='usage_observations'&&item.row.sequence===2));
});
test('partial daily counters preserve frozen bytes and cannot block later source archival',async t=>{
 const f=await fixture(t),readings=[{cached_input_tokens:0},{cached_input_tokens:100},{input_tokens:1000,cached_input_tokens:100},{input_tokens:1001,cached_input_tokens:100}];
 for(const [i,tokens]of readings.entries())local(f.database,db=>recordUsage(db,{hostId:'TEST_ONLY_source',state:{sessions:[{...session(1000,i*1000),tokens}]},now:NOW+i*1000}));
 local(f.database,db=>{const row=db.prepare('SELECT * FROM usage_daily').get();assert.equal(row.input_tokens,1);assert.equal(row.cached_input_tokens,100);assert.ok(row.partial_observations>0);});
 const frozen=local(f.database,db=>{bootstrapUsageArchive(db);return selectArchiveBatch(db);}),wire=frozen.body.trim().split('\n').map(JSON.parse),daily=wire.find(r=>r.table==='usage_daily'&&r.row.input_tokens===1);
 assert.ok(daily);const invalid=structuredClone(daily);invalid.row.partial_observations=0;
 const refused=await launch(f.receiverConfig,gzipSync(Buffer.from(JSON.stringify(invalid)+'\n')));assert.notEqual(refused.code,0,'fully comparable daily counters still require cache <= input');
 local(f.database,db=>recordUsage(db,{hostId:'TEST_ONLY_other',state:{sessions:[session()]},now:NOW}));let first=true;
 await pumpUsageArchive(f.config,{transport:async args=>{if(first){assert.equal(args.batch.body,frozen.body);assert.equal(args.batch.batchId,frozen.batchId);assert.deepEqual(args.batch.itemIds,frozen.itemIds);first=false;}return f.transport(args);}});
 assert.equal(f.health().pendingRecords,0);const records=await f.query();assert.ok(records.some(r=>r.table==='usage_daily'&&r.row.input_tokens===1&&r.row.cached_input_tokens===100));assert.ok(records.some(r=>r.row.host_id==='TEST_ONLY_other'));
 assert.equal((await pumpUsageArchive(f.config,{transport:()=>assert.fail('acknowledged bytes must not resend')})).records,0);
});
