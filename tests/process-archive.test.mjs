// Author: Bishop Crockett; Owner: Argellan.com; License: MIT; SPDX-License-Identifier: MIT
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {spawn,spawnSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';import {gzipSync} from 'node:zlib';import {fileURLToPath} from 'node:url';
import {processFixture} from './helpers/private-process-fixture.mjs';
import {HistoryJournal} from '../lib/history.mjs';import {pumpUsageArchive,validateArchiveSenderConfig} from '../scripts/archive-usage.mjs';import {selectProcessArchiveBatch,processArchiveStatus,acknowledgeProcessArchive} from '../lib/process-archive.mjs';
import {processCharge} from '../lib/process-history.mjs';
import {sourceOutstanding} from '../lib/storage-admission.mjs';
const ID='8bc63ea3-56d7-4ae5-bc32-fec7bdfd25b8',script=fileURLToPath(new URL('../scripts/archive-receiver.py',import.meta.url));
const frame=(sequence=1)=>({epoch:'11111111-1111-4111-8111-111111111111',snapshot:{schemaVersion:1,sourceKind:'local-os',hostId:'TEST_ONLY',bootId:'boot',sequence,observedAt:new Date(1767225600123+sequence).toISOString(),cores:8,collection:{status:'ok',complete:true,scope:'test'},processes:[{pid:42,parentPid:1,createdAt:'2026-01-01T00:00:00Z',executable:'node.exe',role:'Node.js runtime',family:'Codex',metricStatus:'ok',privateCommitBytes:1000,workingSetBytes:500,cpuTimeMs:20,ioBytes:0}]}});
function database(file,fn){const db=new DatabaseSync(file);try{db.exec('PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL;');return fn(db);}finally{db.close();}}
function receiver(config,input=Buffer.alloc(0),args=[]){return new Promise((resolve,reject)=>{const child=spawn(process.platform==='win32'?'python':'python3',['-B',script,'--config',config,...args],{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>{child.kill();reject(new Error('Fixture receiver timeout'));},15000);child.on('error',e=>{clearTimeout(timer);reject(e);});child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('close',code=>{clearTimeout(timer);resolve({code,out,err});});child.stdin.on('error',()=>{});child.stdin.end(input);});}
async function fixture(t){const owned=await processFixture('TEST_ONLY-CC-process-'),root=owned.root;t.after(owned.cleanup);const journal=await HistoryJournal.open({directory:root,storageAdmission:{freeBytes:0,freeFraction:0,workingBytes:0}}),configFile=path.join(root,'receiver.json');await fs.chmod(journal.file,0o600);await fs.writeFile(configFile,JSON.stringify({archiveDirectory:path.join(root,'cold'),catalogDirectory:path.join(root,'catalog'),receiverId:ID}),{mode:0o600});const config={version:1,database:journal.file,receiverId:ID,processHistory:true,maxBatches:2,ssh:{executable:process.execPath,host:'TEST_ONLY.example.test',user:'test',identityFile:path.join(root,'identity'),knownHostsFile:path.join(root,'known')}};const add=n=>journal.commit({hostId:'TEST_ONLY',state:{sessions:[]},processSamples:[frame(n)]});const local=fn=>database(journal.file,fn);const status=()=>local(db=>processArchiveStatus(db,'TEST_ONLY'));const transport=async a=>{const r=await receiver(configFile,a.compressed);assert.equal(r.code,0,r.err);return r.out;};return {root,journal,configFile,config,add,local,status,transport};}
test('process archive real receiver verifies exact bytes and retains local history after ACK',async t=>{const f=await fixture(t);f.add(1);f.add(2);assert.equal(f.status().pendingObservations,2);const sent=await pumpUsageArchive(f.config,{transport:f.transport});assert.equal(sent.records,2);assert.equal(f.status().pendingObservations,0);assert.deepEqual(f.local(db=>processArchiveStatus(db,'unobserved-host')),{status:'awaiting-capture',pendingObservations:0,lastArchivedSequence:0,evictionAllowed:false});const verify=await receiver(f.configFile,undefined,['--verify']);assert.equal(verify.code,0,verify.err);assert.equal(JSON.parse(verify.out).verified,true);const query=await receiver(f.configFile,undefined,['--query']);assert.equal(query.code,0,query.err);const records=query.out.trim().split('\n').map(JSON.parse);assert.equal(records.length,2);const local=f.local(db=>db.prepare('SELECT * FROM process_observations ORDER BY sequence').all());assert.deepEqual(records.map(x=>x.row),local.map(x=>({...x})));f.local(db=>db.exec('DELETE FROM process_observations'));assert.equal(f.local(db=>db.prepare('SELECT COUNT(*) n FROM process_observations').get().n),2);assert.throws(()=>f.local(db=>db.exec("UPDATE process_observations SET digest='bad'")),/immutable/);});
test('Community local receiver archives process history without replacing local records',async t=>{
 const f=await fixture(t);f.add(1);
 const python=spawnSync(process.platform==='win32'?'python':'python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8',timeout:5000,windowsHide:true});
 assert.equal(python.status,0,python.stderr);
 const {ssh,...base}=f.config;
 const local={...base,local:{python:python.stdout.trim(),script,config:f.configFile}};
 const result=await pumpUsageArchive(local);assert.equal(result.records,1);
 assert.equal(f.status().pendingObservations,0);
 const query=await receiver(f.configFile,undefined,['--query']);assert.equal(query.code,0,query.err);
 const stored=JSON.parse(query.out);assert.equal(stored.table,'process_observations');
 assert.equal(f.local(db=>db.prepare('SELECT COUNT(*) n FROM process_observations').get().n),1);
});
test('lost remote ACK freezes exact retry across restart and concurrent new capture',async t=>{const f=await fixture(t);f.add(1);let frozen;await assert.rejects(pumpUsageArchive(f.config,{transport:async a=>{frozen=a.batch;await f.transport(a);throw new Error('lost ACK');}}));f.add(2);assert.equal(f.status().pendingObservations,2);let first=true;await pumpUsageArchive(f.config,{transport:async a=>{if(first){assert.equal(a.batch.body,frozen.body);first=false;}return f.transport(a);}});assert.equal(f.status().pendingObservations,0);const q=await receiver(f.configFile,undefined,['--query']);assert.equal(q.out.trim().split('\n').length,2);});
test('foreign, incomplete and false durable receipts preserve all local versions',async t=>{const f=await fixture(t);f.add(1);for(const override of [{receiverId:'11111111-1111-4111-8111-111111111111'},{durable:false},{itemIds:[]}]){await assert.rejects(pumpUsageArchive(f.config,{transport:async a=>JSON.stringify({...JSON.parse(await f.transport(a)),...override})}));assert.equal(f.status().pendingObservations,1);}await pumpUsageArchive(f.config,{transport:f.transport});assert.equal(f.status().pendingObservations,0);await assert.rejects(pumpUsageArchive({...f.config,receiverId:'11111111-1111-4111-8111-111111111111'},{transport:f.transport}));});
test('outage, opt-out and size refusal retain pending custody; sender uses bounded admission',async t=>{const f=await fixture(t);f.add(1);await pumpUsageArchive({...f.config,processHistory:false},{transport:()=>assert.fail('opted out')});assert.equal(f.status().pendingObservations,1);assert.throws(()=>f.local(db=>selectProcessArchiveBatch(db,{receiverId:ID,maxBytes:1024})),/bound/);await assert.rejects(pumpUsageArchive(f.config,{transport:()=>{throw new Error('offline');}}));assert.equal(f.status().pendingObservations,1);assert.throws(()=>validateArchiveSenderConfig({...f.config,maxBatches:1}),/ARCHIVE_CONFIG/);});
test('receiver rejects injected raw command field and corruption never permits local deletion',async t=>{const f=await fixture(t);f.add(1);const batch=f.local(db=>selectProcessArchiveBatch(db,{receiverId:ID}));const record=JSON.parse(batch.body);record.row.commandLine='TEST_ONLY forbidden';const r=await receiver(f.configFile,gzipSync(Buffer.from(JSON.stringify(record)+'\n')));assert.notEqual(r.code,0);assert.equal(f.status().pendingObservations,1);await pumpUsageArchive(f.config,{transport:f.transport});const files=await fs.readdir(path.join(f.root,'cold','segments'),{recursive:true});const file=files.find(x=>x.endsWith('.jsonl.gz'));await fs.appendFile(path.join(f.root,'cold','segments',file),'TEST_ONLY-corrupt');const verify=await receiver(f.configFile,undefined,['--verify']);assert.notEqual(verify.code,0);f.local(db=>db.exec('DELETE FROM process_observations'));assert.equal(f.local(db=>db.prepare('SELECT COUNT(*) n FROM process_observations').get().n),1);});

test('optional analytics preserves V4 canonical line without counting OS metrics as tokens',async t=>{const f=await fixture(t);f.add(1);const batch=f.local(db=>selectProcessArchiveBatch(db,{receiverId:ID}));const code="import sys,json,importlib.util; spec=importlib.util.spec_from_file_location('a',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); line=sys.stdin.buffer.read().strip(); record=json.loads(line); values=m.item_values(record,line); assert values[-7:]==(None,)*7; assert values[2]==line.decode()+'\\n'; print('PASS')";const result=spawnSync(process.platform==='win32'?'python':'python3',['-B','-c',code,fileURLToPath(new URL('../scripts/archive-analytics.py',import.meta.url))],{input:batch.body,encoding:'utf8',timeout:15000,windowsHide:true});assert.equal(result.status,0,result.stderr);});

test('large process populations archive intact while legacy and process admission bounds remain enforced',async t=>{
 const f=await fixture(t),sample=frame(1),template=sample.snapshot.processes[0];
 sample.snapshot.processes=Array.from({length:900},(_,i)=>({...template,pid:1000+i}));
 f.journal.commit({hostId:'TEST_ONLY',state:{sessions:[]},processSamples:[sample]});
 const batch=f.local(db=>selectProcessArchiveBatch(db,{receiverId:ID}));
 assert.ok(Buffer.byteLength(batch.body)>131072);
 const result=await pumpUsageArchive(f.config,{transport:f.transport});assert.equal(result.records,1);
 const query=await receiver(f.configFile,undefined,['--query']);assert.equal(query.code,0,query.err);
 assert.equal(JSON.parse(JSON.parse(query.out).row.payload).snapshot.processes.length,900);
 assert.equal(f.status().pendingObservations,0);
 for(const version of [1,2,3]){
  const oversized=JSON.stringify({version,padding:'x'.repeat(131072)})+'\n';
  const r=await receiver(f.configFile,gzipSync(Buffer.from(oversized)));
  assert.notEqual(r.code,0);assert.match(r.err,/Archive record bound exceeded/);
 }
 const excessive=JSON.stringify({version:4,padding:'x'.repeat(2*524288+4096)})+'\n';
 const r=await receiver(f.configFile,gzipSync(Buffer.from(excessive)));
 assert.notEqual(r.code,0);assert.match(r.err,/Archive record bound exceeded/);
 assert.equal(f.local(db=>db.prepare('SELECT COUNT(*) n FROM process_observations').get().n),1);
});


test('verified process custody releases only its admission charge, never retained bytes',async t=>{
 const f=await fixture(t);f.add(1);const charge=()=>f.local(db=>processCharge(db,'TEST_ONLY')),first=charge();assert.ok(first>0);
 const batch=f.local(db=>selectProcessArchiveBatch(db,{receiverId:ID}));
 const receipt=JSON.parse(await f.transport({compressed:gzipSync(Buffer.from(batch.body))}));
 f.add(2);const total=charge();assert.ok(total>first);
 const ack=r=>f.local(db=>{db.exec('BEGIN IMMEDIATE');try{acknowledgeProcessArchive(db,{batch,receipt:r,receiverId:ID});db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}});
 assert.throws(()=>ack({...receipt,itemIds:[]}),/custody/);assert.equal(charge(),total);
 ack(receipt);assert.equal(charge(),total-first);
 const rows=f.local(db=>db.prepare('SELECT sequence,digest,payload FROM process_observations ORDER BY sequence').all());assert.equal(rows.length,2);
 assert.throws(()=>ack(receipt),/custody/);assert.equal(charge(),total-first);
 const prior=f.local(db=>sourceOutstanding(db,'TEST_ONLY').logical_bytes);f.journal.storageAdmission.sourceBytes=prior+total+500;
 // One new frame fits after one verified frame releases its charge. Keeping the
 // cumulative retained charge would reject it; the following frame still refuses.
 f.add(3);assert.throws(()=>f.add(4),e=>e.code==='STORAGE_BACKPRESSURE');
 assert.deepEqual(f.local(db=>db.prepare('SELECT sequence,digest,payload FROM process_observations ORDER BY sequence LIMIT 2').all()),rows);
 await assert.rejects(pumpUsageArchive(f.config,{transport:()=>{throw Error('offline');}}));const pending=charge();assert.ok(pending>0);
 await pumpUsageArchive(f.config,{transport:f.transport});assert.equal(charge(),0);
 const retained=f.local(db=>db.prepare('SELECT COUNT(*) n,SUM(bytes) bytes FROM process_observations').get());assert.equal(retained.n,3);assert.ok(retained.bytes>0);
 f.local(db=>db.exec('DELETE FROM process_observations'));assert.equal(f.local(db=>db.prepare('SELECT COUNT(*) n FROM process_observations').get().n),3);
 const restarted=await HistoryJournal.open({directory:f.root,storageAdmission:{freeBytes:0,freeFraction:0,workingBytes:0}});assert.equal(restarted.database(db=>processCharge(db,'TEST_ONLY')),0);
 restarted.storageAdmission.statfs=()=>({bavail:0,bsize:4096,blocks:1000});restarted.storageAdmission.freeBytes=1;
 assert.throws(()=>restarted.commit({hostId:'TEST_ONLY',state:{sessions:[]},processSamples:[frame(4)]}),e=>e.code==='STORAGE_BACKPRESSURE');
 assert.equal(f.local(db=>db.prepare('SELECT COUNT(*) n FROM process_observations').get().n),3);
});

test('existing exact receipts are honored without rewriting local process history',async t=>{
 const f=await fixture(t);f.add(1);await pumpUsageArchive(f.config,{transport:f.transport});f.add(2);
 const snapshot=f.local(db=>db.prepare('SELECT * FROM process_observations ORDER BY sequence').all());
 f.local(db=>db.exec('DROP INDEX IF EXISTS process_archive_sequence'));
 const j=await HistoryJournal.open({directory:f.root});
 assert.deepEqual(j.database(db=>db.prepare('SELECT * FROM process_observations ORDER BY sequence').all()),snapshot);
 assert.equal(j.database(db=>processCharge(db,'TEST_ONLY')),4096+8*snapshot[1].bytes);
 assert.equal(j.database(db=>processCharge(db,'unknown')),0);
 const plan=j.database(db=>db.prepare('EXPLAIN QUERY PLAN SELECT SUM(4096+8*bytes) FROM process_observations WHERE host_id=? AND sequence>(SELECT COALESCE(MAX(last_sequence),0) FROM process_archive_receipts)').all('TEST_ONLY'));
 assert.ok(plan.some(x=>x.detail.includes('process_host_sequence')));assert.ok(plan.some(x=>x.detail.includes('process_archive_sequence')));
});
