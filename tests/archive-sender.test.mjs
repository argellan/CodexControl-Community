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
import {gunzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {installUsageSchema,recordUsage} from '../lib/usage-history.mjs';
import {installUsageArchive,archiveStatus} from '../lib/usage-archive.mjs';
import {validateArchiveSenderConfig,loadArchiveSenderConfig,archiveSshArguments,pumpUsageArchive,sendArchiveOverSsh,acquireArchiveLock,reclaimArchivePages} from '../scripts/archive-usage.mjs';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';

const RECEIVER='70105d47-af72-42fb-a835-97e2509d28b8',OTHER='f42a4f46-bcd8-48c0-937f-9b4ad7accc44',NOW=Date.parse('2026-10-20T12:00:00Z');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const baseConfig=database=>({version:1,database,receiverId:RECEIVER,ssh:{executable:process.execPath,host:'archive.example.test',port:22,user:'codex_archive',identityFile:path.join(path.dirname(database),'identity'),knownHostsFile:path.join(path.dirname(database),'known_hosts')}});
test('page reclamation is bounded, preserves live rows and never enables or runs a full vacuum',()=>{
 for(const mode of [0,2]){const db=new DatabaseSync(':memory:');try{db.exec(`PRAGMA auto_vacuum=${mode}; CREATE TABLE test_data(id INTEGER PRIMARY KEY,body BLOB);`);const insert=db.prepare('INSERT INTO test_data(body) VALUES(zeroblob(8192))');for(let i=0;i<400;i++)insert.run();db.exec('DELETE FROM test_data WHERE id<390');const before=db.prepare('PRAGMA freelist_count').get().freelist_count,count=db.prepare('SELECT COUNT(*) n FROM test_data').get().n,pages=reclaimArchivePages(db,{maxPages:64});assert.equal(db.prepare('PRAGMA auto_vacuum').get().auto_vacuum,mode);assert.equal(db.prepare('SELECT COUNT(*) n FROM test_data').get().n,count);assert.ok(pages<=64&&pages>=0);assert.equal(pages,mode===2?Math.min(64,before):0);assert.throws(()=>reclaimArchivePages(db,{maxPages:257}));}finally{db.close();}}
});
function receipt({config,batch,compressed}){return JSON.stringify({version:1,batchId:batch.batchId,rawSha256:batch.rawSha256,compressedSha256:hash(compressed),receivedCompressedSha256:hash(compressed),records:batch.records,receiverId:config.receiverId,durable:true,itemIds:batch.itemIds,segment:'segments/2026/10/'+batch.batchId+'.ndjson.gz'});}
function status(file){const db=new DatabaseSync(file);try{return archiveStatus(db);}finally{db.close();}}
async function fixture(fn,{sessions=3}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'codex-archive-sender-')),database=path.join(directory,'history.sqlite'),config=baseConfig(database);let db=new DatabaseSync(database);
 try{
  installUsageSchema(db);installUsageArchive(db);
  for(let i=0;i<sessions;i++)recordUsage(db,{hostId:'TEST_ONLY_source',now:NOW,state:{sessions:[{id:'TEST_ONLY_session_'+i,project:'TEST_ONLY_project',provider:'openai',model:'TEST_ONLY_model',usageObservedAt:new Date(NOW).toISOString(),tokens:{input_tokens:1000,cached_input_tokens:250,output_tokens:100,total_tokens:1100}}]}});
  db.close();db=null;await fs.chmod(database,0o600);await fs.writeFile(config.ssh.identityFile,'TEST_ONLY no private key',{mode:0o600});await fs.writeFile(config.ssh.knownHostsFile,'TEST_ONLY no remote host',{mode:0o600});
  return await fn({directory,database,config});
 }finally{db?.close();await fs.rm(directory,{recursive:true,force:true});}
}

test('sender config is bounded, absolute and refuses option or unknown-field injection',()=>{
 const config=baseConfig(path.join(os.tmpdir(),'TEST_ONLY.sqlite'));assert.equal(validateArchiveSenderConfig(config).maxBatches,4);assert.equal(validateArchiveSenderConfig(config).maxRecords,1000);assert.equal(validateArchiveSenderConfig(config).maxBytes,2097152);
 assert.equal(validateArchiveSenderConfig({...config,maxBatches:32}).maxBatches,32);
 for(const bad of [{database:'relative.sqlite'},{receiverId:'wrong'},{maxBatches:33},{maxRecords:1001},{maxBytes:2097153},{bootstrapLimit:1001},{timeoutMs:30001},{token:'TEST_ONLY'}])assert.throws(()=>validateArchiveSenderConfig({...config,...bad}),/ARCHIVE_CONFIG/);
 for(const bad of [{host:'-oProxyCommand=bad'},{host:'server;command'},{host:'server\nother'},{user:'root;command'},{port:0},{identityFile:'relative'},{password:'bad'}])assert.throws(()=>validateArchiveSenderConfig({...config,ssh:{...config.ssh,...bad}}),/ARCHIVE_CONFIG/);
});

test('owner config loads from private ordinary files and never exposes key contents',()=>fixture(async({directory,config})=>{
 const file=path.join(directory,'archive.json');await fs.writeFile(file,JSON.stringify(config),{mode:0o600});const loaded=await loadArchiveSenderConfig(file);assert.equal(loaded.receiverId,RECEIVER);assert.equal(Object.hasOwn(loaded,'identity'),false);assert.equal(Object.hasOwn(loaded.ssh,'password'),false);
 await fs.writeFile(file,'{invalid');await assert.rejects(loadArchiveSenderConfig(file),/ARCHIVE_CONFIG/);
}));

test('POSIX group-readable archive config is rejected before connection', {skip:process.platform==='win32'?'POSIX mode enforcement does not apply to Windows':false},()=>fixture(async({directory,config})=>{
 const file=path.join(directory,'archive.json');await fs.writeFile(file,JSON.stringify(config),{mode:0o644});await fs.chmod(file,0o644);await assert.rejects(loadArchiveSenderConfig(file),/ARCHIVE_CONFIG_PERMISSIONS/);
}));

test('SSH uses pinned host verification, dedicated file identity, no shell and exact archive command',()=>{
 const config=validateArchiveSenderConfig(baseConfig(path.join(os.tmpdir(),'TEST_ONLY.sqlite'))),args=archiveSshArguments(config);assert.equal(args.at(-1),'archive');assert.equal(args.includes('BatchMode=yes'),true);assert.equal(args.includes('StrictHostKeyChecking=yes'),true);assert.equal(args.includes('IdentitiesOnly=yes'),true);assert.equal(args.includes('PasswordAuthentication=no'),true);assert.equal(args.includes('KbdInteractiveAuthentication=no'),true);assert.equal(args.includes('UserKnownHostsFile='+config.ssh.knownHostsFile),true);assert.equal(args.includes(config.ssh.identityFile),true);assert.equal(args.includes('StrictHostKeyChecking=no'),false);assert.equal(args.includes('TEST_ONLY no private key'),false);
});

test('pump sends bounded gzip NDJSON, validates custody receipt, and commits the ACK',()=>fixture(async({database,config})=>{
 const batches=[];const result=await pumpUsageArchive({...config,maxRecords:2},{transport:async args=>{batches.push(args.batch);const body=gunzipSync(args.compressed).toString('utf8');assert.equal(body,args.batch.body);assert.equal(body.endsWith('\n'),true);assert.equal(hash(body),args.batch.batchId);assert.ok(args.batch.records<=2);assert.ok(Buffer.byteLength(body)<=2097152);return receipt(args);},now:()=>NOW});
 assert.equal(result.status,'complete');assert.ok(result.batches>0&&result.batches<=4);assert.ok(result.records>0);assert.equal(status(database).receiverId,RECEIVER);assert.equal(status(database).errorCode,null);assert.equal(status(database).lastSuccessAt,new Date(NOW).toISOString());
 assert.equal(new Set(batches.flatMap(batch=>batch.itemIds)).size,result.records);
}));

test('a full successful rerun does not upload or acknowledge a prior record again',()=>fixture(async({database,config})=>{
 let calls=0;const transport=async args=>{calls++;return receipt(args);};await pumpUsageArchive(config,{transport,now:()=>NOW});const count=calls;const again=await pumpUsageArchive(config,{transport,now:()=>NOW+1000});assert.equal(again.records,0);assert.equal(calls,count);assert.equal(status(database).pendingRecords,0);
}));

test('network failure leaves all records pending and retry reuses exact batch evidence',()=>fixture(async({database,config})=>{
 let original;await assert.rejects(pumpUsageArchive(config,{transport:async args=>{original=args.batch;throw new Error('SECRET TEST_ONLY remote path');},now:()=>NOW}),error=>error.code==='ARCHIVE_FAILED'&&!error.message.includes('SECRET'));
 const failed=status(database);assert.ok(failed.pendingRecords>0);assert.equal(failed.acknowledgedRecords,0);assert.equal(failed.errorCode,'ARCHIVE_FAILED');
 await pumpUsageArchive(config,{transport:async args=>{assert.equal(args.batch.body,original.body);assert.equal(args.batch.batchId,original.batchId);return receipt(args);},now:()=>NOW+1000});assert.equal(status(database).pendingRecords,0);assert.equal(status(database).lastSuccessAt,new Date(NOW+1000).toISOString());
}));

test('receiver may durably store a batch before local failure; exact retry is safe',()=>fixture(async({database,config})=>{
 const remote=new Map();let first=true;const transport=async args=>{const value=receipt(args);assert.equal(remote.has(args.batch.batchId)?remote.get(args.batch.batchId):value,value);remote.set(args.batch.batchId,value);if(first){first=false;throw Object.assign(new Error('disconnect after remote fsync'),{code:'ARCHIVE_TRANSPORT_FAILED'});}return value;};
 await assert.rejects(pumpUsageArchive(config,{transport}),/ARCHIVE_TRANSPORT_FAILED/);assert.ok(status(database).pendingRecords>0);await pumpUsageArchive(config,{transport});assert.equal(remote.size,1);assert.equal(status(database).pendingRecords,0);
}));

test('an outage freezes the exact batch even while new usage arrives',()=>fixture(async({database,config})=>{
 let frozen;await assert.rejects(pumpUsageArchive(config,{transport:async args=>{frozen=args.batch;const db=new DatabaseSync(database);try{recordUsage(db,{hostId:'TEST_ONLY_source',now:NOW+1000,state:{sessions:[{id:'TEST_ONLY_session_0',project:'TEST_ONLY_project',provider:'openai',model:'TEST_ONLY_model',usageObservedAt:new Date(NOW+1000).toISOString(),tokens:{input_tokens:1600,cached_input_tokens:400,output_tokens:160,total_tokens:1760}}]}});}finally{db.close();}throw Object.assign(new Error('lost receipt'),{code:'ARCHIVE_TRANSPORT_FAILED'});}}),/ARCHIVE_TRANSPORT_FAILED/);
 const uploaded=[];await pumpUsageArchive(config,{transport:async args=>{uploaded.push(args.batch);if(uploaded.length===1){assert.equal(args.batch.body,frozen.body);assert.equal(args.batch.batchId,frozen.batchId);}return receipt(args);}});assert.ok(uploaded.length>=2);assert.equal(status(database).pendingRecords,0);
}));

test('partial run keeps successful ACKs and retries only the remaining records',()=>fixture(async({database,config})=>{
 const accepted=new Set();let calls=0;await assert.rejects(pumpUsageArchive({...config,maxRecords:2},{transport:async args=>{calls++;if(calls===2)throw Object.assign(new Error('outage'),{code:'ARCHIVE_TRANSPORT_FAILED'});for(const id of args.batch.itemIds)accepted.add(id);return receipt(args);}}),/ARCHIVE_TRANSPORT_FAILED/);assert.equal(accepted.size,2);assert.ok(status(database).pendingRecords>0);
 while(status(database).pendingRecords){await pumpUsageArchive({...config,maxRecords:2},{transport:async args=>{for(const id of args.batch.itemIds){assert.equal(accepted.has(id),false);accepted.add(id);}return receipt(args);}});}assert.ok(accepted.size>2);
}));

test('an empty database still binds the configured receiver and records an idle attempt',()=>fixture(async({database,config})=>{
 const result=await pumpUsageArchive(config,{transport:async()=>assert.fail('empty archive must not connect'),now:()=>NOW});assert.equal(result.records,0);const health=status(database);assert.equal(health.receiverId,RECEIVER);assert.equal(health.status,'idle');assert.equal(health.lastAttemptAt,new Date(NOW).toISOString());assert.equal(health.lastSuccessAt,null);
},{sessions:0}));

for(const field of ['receiverId','batchId','rawSha256','compressedSha256','receivedCompressedSha256','records','itemIds','durable','highCursor','segment'])test('forged '+field+' receipt cannot remove pending history',()=>fixture(async({database,config})=>{
 await assert.rejects(pumpUsageArchive(config,{transport:async args=>{const value=JSON.parse(receipt(args));if(field==='receiverId')value.receiverId=OTHER;else if(['batchId','rawSha256','receivedCompressedSha256'].includes(field))value[field]='f'.repeat(64);else if(field==='compressedSha256')value[field]='not-a-stored-sha256';else if(field==='records')value.records++;else if(field==='itemIds')value.itemIds=[...value.itemIds].reverse().map((id,i)=>i===0?'e'.repeat(64):id);else if(field==='durable')value.durable=false;else if(field==='segment')value.segment='../escaped';else value.highCursor=Number.MAX_SAFE_INTEGER;return JSON.stringify(value);}}),/ARCHIVE_RECEIPT/);
 assert.ok(status(database).pendingRecords>0);assert.equal(status(database).acknowledgedRecords,0);
}));

test('a stored gzip hash may differ when exact raw batch membership and received bytes are verified',()=>fixture(async({database,config})=>{
 await pumpUsageArchive(config,{transport:async args=>{const value=JSON.parse(receipt(args));value.compressedSha256='a'.repeat(64);return JSON.stringify(value);}});assert.equal(status(database).pendingRecords,0);
}));

test('truncated, oversized and non-JSON receipts are sanitized and remain retryable',()=>fixture(async({database,config})=>{
 for(const raw of ['{truncated','x'.repeat(131073),'<html>TEST_ONLY path</html>']){await assert.rejects(pumpUsageArchive(config,{transport:async()=>raw}),/ARCHIVE_RECEIPT/);assert.ok(status(database).pendingRecords>0);}
}));

test('a hung transport times out within a bounded run and never ACKs',()=>fixture(async({database,config})=>{
 const started=performance.now();await assert.rejects(pumpUsageArchive({...config,timeoutMs:50},{transport:()=>new Promise(()=>{})}),/ARCHIVE_TRANSPORT_TIMEOUT/);assert.ok(performance.now()-started<1500);assert.equal(status(database).acknowledgedRecords,0);assert.ok(status(database).pendingRecords>0);
}));

test('two pumps cannot send concurrently; live PID lock is released after completion',()=>fixture(async({database,config})=>{
 let arrived,finish;const started=new Promise(resolve=>arrived=resolve),hold=new Promise(resolve=>finish=resolve);const first=pumpUsageArchive(config,{transport:async args=>{arrived();await hold;return receipt(args);}});await started;
 await assert.rejects(pumpUsageArchive(config,{transport:async()=>{assert.fail('second pump must not send');}}),/ARCHIVE_LOCKED/);finish();await first;await assert.rejects(fs.lstat(database+'.usage-archive.lock'),{code:'ENOENT'});
}));

test('a shared offline-restore archive lock blocks the pump through replacement and cleanup',()=>fixture(async({database,config})=>{
 const release=await acquireArchiveLock(database);try{await assert.rejects(pumpUsageArchive(config,{transport:async()=>assert.fail('restore holds the shared archive lock')}),/ARCHIVE_LOCKED/);await assert.rejects(acquireArchiveLock(database),/ARCHIVE_LOCKED/);}finally{await release();}
 await pumpUsageArchive(config,{transport:async args=>receipt(args)});assert.equal(status(database).pendingRecords,0);
}));

test('a dead same-user pump lock recovers without dropping archive rows',()=>fixture(async({database,config})=>{
 const lock=database+'.usage-archive.lock';await fs.mkdir(lock,{mode:0o700});await fs.writeFile(path.join(lock,'owner.json'),JSON.stringify({version:1,pid:2147483647,uid:process.getuid?.()??null,nonce:crypto.randomUUID()}),{mode:0o600});await pumpUsageArchive(config,{transport:async args=>receipt(args)});assert.equal(status(database).pendingRecords,0);await assert.rejects(fs.lstat(lock),{code:'ENOENT'});
}));

test('malformed lock fails closed and cannot cause a second sender',()=>fixture(async({database,config})=>{
 const lock=database+'.usage-archive.lock';await fs.mkdir(lock,{mode:0o700});await fs.writeFile(path.join(lock,'owner.json'),'not-json',{mode:0o600});await assert.rejects(pumpUsageArchive(config,{transport:async()=>assert.fail('must not send')}),/ARCHIVE_LOCK_INVALID/);
}));

test('cancellation leaves pending history without a successful receipt',()=>fixture(async({database,config})=>{
 const controller=new AbortController();controller.abort();await assert.rejects(pumpUsageArchive(config,{signal:controller.signal,transport:async()=>assert.fail('must not send')}),/ARCHIVE_ABORTED/);assert.equal(status(database).acknowledgedRecords,0);
}));

test('cancellation interrupts even an injected transport that ignores abort',()=>fixture(async({database,config})=>{
 const controller=new AbortController();const started=performance.now();const pump=pumpUsageArchive({...config,timeoutMs:1000},{signal:controller.signal,transport:async()=>{controller.abort();return new Promise(()=>{});}});await assert.rejects(pump,/ARCHIVE_ABORTED/);assert.ok(performance.now()-started<700);assert.equal(status(database).acknowledgedRecords,0);assert.ok(status(database).pendingRecords>0);
}));

test('SSH wrapper bounds stdout and sanitizes errors without logging remote stderr',async()=>{
 const config=validateArchiveSenderConfig(baseConfig(path.join(os.tmpdir(),'TEST_ONLY.sqlite')));let killed=false,options;
 const fakeSpawn=(executable,args,opts)=>{options=opts;const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{killed=true;setImmediate(()=>child.emit('close',1));};setImmediate(()=>child.stdout.write(Buffer.alloc(131073)));return child;};
 await assert.rejects(sendArchiveOverSsh({config,compressed:Buffer.from('TEST_ONLY'),timeoutMs:1000},{spawn:fakeSpawn}),/ARCHIVE_TRANSPORT_OUTPUT/);assert.equal(killed,true);assert.equal(options.shell,false);assert.equal(options.windowsHide,true);
});
