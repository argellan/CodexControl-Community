import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {installUsageSchema,recordUsage} from '../lib/usage-history.mjs';
import {installUsageArchive,validateArchiveDatabase,archiveStatus,selectArchiveBatch,recordSourceVersion} from '../lib/usage-archive.mjs';
import {sanitizeAccountUsage} from '../lib/account-usage.mjs';
import {nativeAnalyticsReference} from '../lib/native-account-analytics.mjs';
import {Administration} from '../lib/administration.mjs';
import {HistoryJournal} from '../lib/history.mjs';
import {DEFAULT_CONFIGURATION} from '../public/settings-schema.mjs';
const row=JSON.parse(await fs.readFile(new URL('./fixtures/optional-native-archive-row.json',import.meta.url),'utf8'));
const account=()=>JSON.parse(row.payload),sha=v=>crypto.createHash('sha256').update(v).digest('hex');

test('canonical optional-native account payload above generic bound retains exact pending custody',()=>{
 const db=new DatabaseSync(':memory:');try{installUsageSchema(db);installUsageArchive(db);const a=account();assert.equal(JSON.stringify(sanitizeAccountUsage(a)),row.payload);assert.ok(Buffer.byteLength(row.payload)>32768&&Buffer.byteLength(row.payload)<131072);
 recordUsage(db,{hostId:row.host_id,state:{accountUsage:a,sessions:[]},now:row.received_ms});const before=archiveStatus(db).pendingRecords;assert.ok(before>0);validateArchiveDatabase(db);const batch=selectArchiveBatch(db);assert.ok(batch.records>0);assert.equal(archiveStatus(db).pendingRecords,before);
 const archived=batch.body.trim().split('\n').map(JSON.parse).find(i=>i.table==='account_usage_observations');assert.equal(archived.row.payload,row.payload);assert.equal(archived.row.sample_key,sha(row.payload));
 recordUsage(db,{hostId:row.host_id,state:{accountUsage:a,sessions:[]},now:row.received_ms});assert.equal(archiveStatus(db).pendingRecords,before);
 const next={...a,nativeAnalytics:nativeAnalyticsReference(a.nativeAnalytics),lastAttemptAt:new Date(row.received_ms+1000).toISOString()};recordUsage(db,{hostId:row.host_id,state:{accountUsage:next,sessions:[]},now:row.received_ms+1000});validateArchiveDatabase(db);assert.ok(archiveStatus(db).pendingRecords>=before);
 }finally{db.close();}
});

test('native account corruption and mismatched archived source hashes still fail closed',()=>{
 const a=account();assert.throws(()=>sanitizeAccountUsage({...a,nativeAnalytics:{...a.nativeAnalytics,digest:'f'.repeat(64)}}));assert.throws(()=>sanitizeAccountUsage({...a,nativeAnalytics:{...a.nativeAnalytics,version:999}}));
 const db=new DatabaseSync(':memory:');try{installUsageSchema(db);installUsageArchive(db);recordUsage(db,{hostId:row.host_id,state:{accountUsage:a,sessions:[]},now:row.received_ms});validateArchiveDatabase(db);
 // Tamper only a disposable synthetic database, retaining all original evidence.
 const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='usage_archive_outbox'").all();for(const t of triggers)db.exec('DROP TRIGGER "'+t.name.replaceAll('"','""')+'"');db.prepare("UPDATE usage_archive_outbox SET payload=replace(payload,?,?) WHERE source_table='account_usage_observations'").run(row.sample_key,'0'.repeat(64));for(const t of triggers)db.exec(t.sql);assert.throws(()=>validateArchiveDatabase(db));
 }finally{db.close();}
});

test('optional-native backup has exact hashes and offline staging preserves active journal and pending records',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-interface-native-TEST_ONLY-'));let journal;
 try{const actor={id:'owner',role:'admin'},administration=await Administration.open({directory:path.join(directory,'admin'),initial:{instanceId:'test-only',viewers:[{id:'owner',label:'TEST_ONLY owner',role:'admin',hostIds:null,projectIds:null,tokenHash:sha('TEST_ONLY fixture access')}],hosts:[]}});journal=await HistoryJournal.open({directory:path.join(directory,'history')});journal.commit({hostId:row.host_id,state:{accountUsage:account(),sessions:[]},events:[]});const pending=journal.usage().archive.pendingRecords;
 const backup=await administration.createBackup({journal,configuration:DEFAULT_CONFIGURATION,actor});const verified=await administration.verifyBackup(backup.id);assert.equal(verified.valid,true);for(const f of backup.manifest.files){const bytes=await fs.readFile(path.join(directory,'admin','backups',backup.id,f.name));assert.equal(sha(bytes),f.sha256);assert.equal(bytes.length,f.bytes);}
 const state=await administration.state(),staged=await administration.stageRestore({id:backup.id,revision:state.revision,actor});assert.equal(staged.staged,true);assert.equal(staged.applyMode,'offline-cli-only');assert.equal(journal.usage().archive.pendingRecords,pending);assert.equal(journal.status().retainedEvents,0);
 }finally{await journal?.close?.();const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('cc-interface-native-TEST_ONLY-'));await fs.rm(resolved,{recursive:true,force:true});}
});
// A valid gzip FEXTRA header varies encoded size without changing decoded
// analytics or its digest. Every account/envelope still passes canonical checks.
function multibyteBoundaryAccount(targetBytes){
 const a=account(),gz=Buffer.from(a.nativeAnalytics.data,'base64'),extraBytes=73728-gz.length-2,header=Buffer.from(gz.subarray(0,10)),length=Buffer.alloc(2);assert.ok(extraBytes>=0&&extraBytes<=65535);header[3]|=4;length.writeUInt16LE(extraBytes);
 a.nativeAnalytics={...a.nativeAnalytics,data:Buffer.concat([header,length,Buffer.alloc(extraBytes),gz.subarray(10)]).toString('base64')};
 const maximum=Number.MAX_SAFE_INTEGER,wide='界'.repeat(128);a.planType=wide;a.summary=Object.fromEntries(Object.keys(a.summary).map(key=>[key,maximum]));a.dailyUsageBuckets=Array.from({length:366},(_,i)=>({startDate:new Date(Date.UTC(2025,0,1)+i*86400000).toISOString().slice(0,10),tokens:maximum}));
 a.limits=Array.from({length:8},(_,i)=>({limitId:'界'.repeat(127)+i,limitName:wide,planType:wide,primary:{usedPercent:99.99999999999999,windowDurationMins:maximum,resetsAt:maximum},secondary:{usedPercent:99.99999999999999,windowDurationMins:maximum,resetsAt:maximum},credits:{hasCredits:true,unlimited:true,balance:'9'.repeat(64)},spendControlReached:true,individualLimit:null,normalModelSlug:'m'.repeat(128),rateLimitReachedType:'workspace_member_credits_depleted'}));a.ordinaryUsageAllowed=true;a.rateLimitResetCredits={availableCount:maximum,credits:[]};a.threadUsage=null;
 let remaining=Buffer.byteLength(JSON.stringify(sanitizeAccountUsage(a)))-targetBytes;assert.ok(remaining>3);if(remaining%2){a.planType=a.planType.slice(0,-1);remaining-=3;}
 const fields=[[a,'planType'],...a.limits.flatMap(limit=>[[limit,'limitName'],[limit,'planType']])];for(const [object,key]of fields){const replace=Math.min(object[key].length,remaining/2);object[key]='a'.repeat(replace)+object[key].slice(replace);remaining-=replace*2;if(!remaining)break;}assert.equal(remaining,0);
 return sanitizeAccountUsage(a);
}
function boundaryDatabase(){const db=new DatabaseSync(':memory:');installUsageSchema(db);installUsageArchive(db);recordUsage(db,{hostId:row.host_id,state:{accountUsage:account(),sessions:[{id:'test-worker',project:'Alpha',provider:'openai',model:'test-model',usageObservedAt:new Date(row.received_ms).toISOString(),tokens:{input_tokens:100,cached_input_tokens:20,output_tokens:10,total_tokens:110}}]},now:row.received_ms});return db;}
const pendingSnapshot=db=>db.prepare('SELECT item_id,source_table,row_key,payload,ack_batch,head_follow FROM usage_archive_outbox ORDER BY sequence').all();

for(const [bytes,accepted]of [[131071,true],[131072,true],[131073,false]])test('multibyte canonical account archive byte boundary '+bytes+' '+(accepted?'accepted':'rejected'),t=>{
 const a=multibyteBoundaryAccount(bytes),payload=JSON.stringify(a);assert.equal(Buffer.byteLength(payload),bytes);assert.ok(payload.length<131072);assert.ok(payload.includes('界'));assert.equal(a.nativeAnalytics.data.length,98304);assert.equal(JSON.stringify(sanitizeAccountUsage(a)),payload);
 const db=boundaryDatabase();try{const source=db.prepare('SELECT * FROM account_usage_observations ORDER BY sequence LIMIT 1').get(),version={...source,payload,sample_key:sha(payload)},before=pendingSnapshot(db),versionsBefore=db.prepare('SELECT COUNT(*) AS n FROM usage_archive_source_versions').get().n;
 if(accepted){assert.equal(recordSourceVersion(db,{table:'account_usage_observations',row:version}),1);assert.equal(recordSourceVersion(db,{table:'account_usage_observations',row:version}),0);const after=pendingSnapshot(db);assert.deepEqual(after.slice(0,before.length),before);assert.equal(after.length,before.length+1);assert.equal(after.at(-1).ack_batch,null);assert.equal(JSON.parse(after.at(-1).payload).payload,payload);assert.equal(JSON.parse(after.at(-1).payload).sample_key,sha(payload));validateArchiveDatabase(db);const batch=selectArchiveBatch(db);assert.equal(sha(batch.body),batch.rawSha256);assert.equal(archiveStatus(db).pendingRecords,after.length);}
 else{assert.throws(()=>recordSourceVersion(db,{table:'account_usage_observations',row:version}),/Invalid archived account usage/);assert.deepEqual(pendingSnapshot(db),before);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_archive_source_versions').get().n,versionsBefore);validateArchiveDatabase(db);}
 t.diagnostic(JSON.stringify({bytes,characters:payload.length,sampleSha256:sha(payload),accepted,pendingPreserved:true}));
 }finally{db.close();}
});

test('boundary records retain canonical JSON, sample hash and unrelated native/text bounds',()=>{
 const db=boundaryDatabase();try{const source=db.prepare('SELECT * FROM account_usage_observations ORDER BY sequence LIMIT 1').get(),a=multibyteBoundaryAccount(131072),payload=JSON.stringify(a),before=pendingSnapshot(db);assert.throws(()=>recordSourceVersion(db,{table:'account_usage_observations',row:{...source,payload,sample_key:'0'.repeat(64)}}),/Invalid archived account usage/);
 const small=account(),noncanonical=JSON.stringify(Object.fromEntries(Object.entries(small).reverse()));assert.ok(Buffer.byteLength(noncanonical)<131072);assert.throws(()=>recordSourceVersion(db,{table:'account_usage_observations',row:{...source,payload:noncanonical,sample_key:sha(noncanonical)}}),/Invalid archived account usage/);
 assert.throws(()=>sanitizeAccountUsage({...a,planType:'界'.repeat(129)}));assert.throws(()=>sanitizeAccountUsage({...a,nativeAnalytics:{...a.nativeAnalytics,data:a.nativeAnalytics.data+'AAAA'}}));
 const baseline=db.prepare('SELECT * FROM usage_baselines LIMIT 1').get();assert.ok(baseline);for(const invalid of [{...baseline,project:'p'.repeat(257)},{...baseline,model:'m'.repeat(129)}])assert.throws(()=>recordSourceVersion(db,{table:'usage_baselines',row:invalid}),/Invalid usage archive row value/);assert.deepEqual(pendingSnapshot(db),before);validateArchiveDatabase(db);
 }finally{db.close();}
});