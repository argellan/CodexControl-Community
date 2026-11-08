// Author: Bishop Crockett; Owner: Argellan.com; License: MIT; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {processFixture} from './helpers/private-process-fixture.mjs';
import {HistoryJournal} from '../lib/history.mjs';
import {Administration,inspectJournal} from '../lib/administration.mjs';
import {ConfigurationStore} from '../lib/configuration.mjs';
import {DEFAULT_CONFIGURATION} from '../public/settings-schema.mjs';
import {validateProcessBackup,processBackupObjectNames} from '../lib/process-backup.mjs';
import {selectProcessArchiveBatch,acknowledgeProcessArchive} from '../lib/process-archive.mjs';
import {selectArchiveBatch,acknowledgeArchiveBatch} from '../lib/usage-archive.mjs';
import {processCharge} from '../lib/process-history.mjs';
import {restoreInstance} from '../scripts/restore-instance.mjs';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const receiverId='11111111-1111-4111-8111-111111111111',actor={id:'owner',role:'admin'};
const frame=n=>({epoch:receiverId,snapshot:{schemaVersion:1,sourceKind:'local-os',hostId:'test-host',bootId:'test-boot',sequence:n,observedAt:new Date(1767225600000+n*1000).toISOString(),cores:8,collection:{status:'ok',complete:true,scope:'test'},processes:[10,11].map(pid=>({pid,parentPid:pid===11?10:1,createdAt:'2026-01-01T00:00:00Z',executable:'node.exe',role:'Node.js runtime',family:'Codex',metricStatus:'ok',privateCommitBytes:1000*n,cpuTimeMs:10*n}))}});
const receipt=batch=>({version:1,receiverId,durable:true,batchId:batch.batchId,rawSha256:batch.rawSha256,records:batch.records,itemIds:batch.itemIds});
function archive(journal){journal.database(db=>{
 let batch;while((batch=selectArchiveBatch(db)))acknowledgeArchiveBatch(db,{batch,expectedReceiverId:receiverId,receipt:receipt(batch)});
 while((batch=selectProcessArchiveBatch(db,{receiverId})))acknowledgeProcessArchive(db,{batch,receiverId,receipt:receipt(batch)});
});}
const dump=journal=>journal.database(db=>Object.fromEntries(processBackupObjectNames('table').map(name=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all().map(row=>({...row}))])));
async function setup(root){
 const administration=await Administration.open({directory:path.join(root,'administration'),initial:{instanceId:'test-process-backup',viewers:[{id:'owner',label:'Owner',role:'admin',hostIds:null,projectIds:null,tokenHash:hash('TEST_ONLY-token')}],hosts:[]}});
 const configuration=await ConfigurationStore.open({directory:path.join(root,'configuration'),initial:DEFAULT_CONFIGURATION});
 const journal=await HistoryJournal.open({directory:root,storageAdmission:{freeBytes:0,freeFraction:0,workingBytes:0}});
 await fs.writeFile(path.join(root,'runtime.pid'),JSON.stringify({pid:2147483647,instanceId:'test-process-backup'}));
 return {root,administration,configuration,journal,add:n=>journal.commit({hostId:'test-host',state:{sessions:[]},processSamples:[frame(n)]})};
}
async function fixture(t){const owned=await processFixture('TEST_ONLY-CC-process-'),root=owned.root;t.after(owned.cleanup);return setup(root);}
async function copiedDb(f,name,mutate){const file=path.join(f.root,name+'.sqlite'),source=new DatabaseSync(f.journal.file,{readOnly:true});try{await backup(source,file);}finally{source.close();}const db=new DatabaseSync(file);try{mutate?.(db);}finally{db.close();}return file;}
function alteredTable(db,name,from,to){
 const rows=db.prepare('SELECT type,sql FROM sqlite_master WHERE tbl_name=? AND sql IS NOT NULL').all(name),table=rows.find(row=>row.type==='table');
 assert.ok(table.sql.includes(from));db.exec('DROP TABLE '+name);db.exec(table.sql.replace(from,to));for(const row of rows.filter(row=>row.type!=='table'))db.exec(row.sql);
}

test('complete process backup and fresh-database restore preserve rows, parent links, receipts and frozen retry',async t=>{
 const f=await fixture(t);f.add(1);f.add(2);archive(f.journal);f.add(3);
 const frozen=f.journal.database(db=>selectProcessArchiveBatch(db,{receiverId})),expected=dump(f.journal);
 const made=await f.administration.createBackup({journal:f.journal,configuration:await f.configuration.read(),actor});
 assert.equal((await f.administration.verifyBackup(made.id)).valid,true);
 assert.equal(made.manifest.journal.processes.observations,3);assert.equal(made.manifest.journal.processes.receipts,1);assert.equal(made.manifest.journal.processes.inflightRecords,1);
 await f.administration.stageRestore({id:made.id,actor});
 const target=await setup(path.join(f.root,'fresh-target'));archive(target.journal);
 const stage='administration/restore-staging/pending';await fs.mkdir(path.dirname(path.join(target.root,stage)),{recursive:true});await fs.cp(path.join(f.root,stage),path.join(target.root,stage),{recursive:true});
 const originalHash=hash(await fs.readFile(f.journal.file));const result=await restoreInstance({dataDirectory:target.root});assert.equal(result.status,'restored');assert.equal(result.serviceStarted,false);
 const reopened=await HistoryJournal.open({directory:target.root});assert.deepEqual(dump(reopened),expected);assert.equal(hash(await fs.readFile(f.journal.file)),originalHash);
 // Independent SQL checks, not just the validator or an "opened successfully" assertion.
 reopened.database(db=>{
  assert.equal(db.prepare('SELECT COUNT(*) n FROM process_observations').get().n,3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM process_observations p LEFT JOIN host_state h ON h.host_id=p.host_id WHERE h.host_id IS NULL').get().n,0);
  const rows=db.prepare('SELECT payload,digest,bytes FROM process_observations ORDER BY sequence').all();
  for(const row of rows){assert.equal(hash(row.payload),row.digest);assert.equal(Buffer.byteLength(row.payload),row.bytes);const p=JSON.parse(row.payload).snapshot.processes;assert.equal(p[1].parentPid,p[0].pid);assert.notEqual(p[0].key,p[1].key);}
  assert.equal(db.prepare('SELECT SUM(n) n FROM process_totals').get().n,3);
  assert.equal(selectProcessArchiveBatch(db,{receiverId}).body,frozen.body);assert.equal(processCharge(db,'test-host'),4096+8*rows[2].bytes);
 });
});

test('complete pre-index V1 backup migrates to V2 without changing captured rows or receipts',async t=>{
 const f=await fixture(t);f.add(1);archive(f.journal);const expected=dump(f.journal);
 f.journal.database(db=>db.exec('DROP INDEX process_archive_sequence'));
 const before=inspectJournal(f.journal.file);assert.equal(before.processes.schemaVersion,1);
 const made=await f.administration.createBackup({journal:f.journal,configuration:DEFAULT_CONFIGURATION,actor});assert.equal((await f.administration.verifyBackup(made.id)).valid,true);
 const migrated=await HistoryJournal.open({directory:f.root});assert.equal(inspectJournal(migrated.file).processes.schemaVersion,2);assert.deepEqual(dump(migrated),expected);
});

test('legacy journal without any process schema remains supported and gains an empty schema on reopen',async t=>{
 const f=await fixture(t);f.journal.database(db=>{for(const name of processBackupObjectNames('trigger'))db.exec('DROP TRIGGER '+name);for(const name of processBackupObjectNames('table'))db.exec('DROP TABLE '+name);});
 assert.equal(inspectJournal(f.journal.file).processes,undefined);
 const made=await f.administration.createBackup({journal:f.journal,configuration:DEFAULT_CONFIGURATION,actor});assert.equal((await f.administration.verifyBackup(made.id)).valid,true);
 const reopened=await HistoryJournal.open({directory:f.root});assert.equal(inspectJournal(reopened.file).processes.observations,0);
});

test('complete pre-archive MVP schema preserves every frame when migrated, with no invented receipts',async t=>{
 const f=await fixture(t);f.add(1);f.add(2);const rows=dump(f.journal).process_observations;
 f.journal.database(db=>db.exec('DROP TRIGGER process_preserve_versions; DROP TRIGGER process_preserve_history; DROP TABLE process_archive_inflight; DROP TABLE process_archive_receipts;'));
 assert.equal(inspectJournal(f.journal.file).processes.schemaVersion,0);
 const made=await f.administration.createBackup({journal:f.journal,configuration:DEFAULT_CONFIGURATION,actor});assert.equal((await f.administration.verifyBackup(made.id)).valid,true);
 const migrated=await HistoryJournal.open({directory:f.root});assert.deepEqual(dump(migrated).process_observations,rows);const status=inspectJournal(migrated.file).processes;assert.equal(status.schemaVersion,2);assert.equal(status.pendingObservations,2);assert.equal(status.receipts,0);
});

test('strict schema rejects missing objects, unexpected objects, altered uniqueness and singleton constraints',async t=>{
 const f=await fixture(t);f.add(1);
 const cases=[
  db=>db.exec('DROP TABLE process_totals'),
  db=>db.exec('DROP INDEX process_host_sequence'),
  db=>db.exec('DROP TRIGGER process_preserve_versions'),
  db=>db.exec('CREATE TABLE process_surprise(secret TEXT)'),
  db=>db.exec('CREATE INDEX process_surprise ON process_observations(digest)'),
  db=>db.exec('DROP TRIGGER process_preserve_history; CREATE TRIGGER process_preserve_history BEFORE DELETE ON process_observations BEGIN SELECT 1; END'),
  db=>alteredTable(db,'process_archive_inflight','CHECK(id=1)','CHECK(id>0)'),
  db=>alteredTable(db,'process_observations','UNIQUE(host_id,observer_epoch,source_sequence)','UNIQUE(host_id,observer_epoch,source_sequence,digest)'),
 ];
 for(const [i,mutate] of cases.entries()){const file=await copiedDb(f,'schema-'+i,mutate);assert.throws(()=>inspectJournal(file),/schema|malformed|Process/i);}
 assert.equal(inspectJournal(f.journal.file).processes.observations,1);
});

test('data, digest, aggregate, receipt and inflight tampering fail closed',async t=>{
 const f=await fixture(t);f.add(1);archive(f.journal);f.add(2);f.journal.database(db=>selectProcessArchiveBatch(db,{receiverId}));
 const cases=[
  db=>db.exec('UPDATE process_storage SET logical_bytes=logical_bytes+1'),
  db=>db.exec('UPDATE process_totals SET n=n+1'),
  db=>db.exec('DELETE FROM host_state'),
  db=>db.exec("UPDATE process_archive_receipts SET receipt='{}'"),
  db=>db.exec("UPDATE process_archive_receipts SET receipt=json_set(receipt,'$.version',99)"),
  db=>db.exec('UPDATE process_archive_receipts SET last_sequence=2'),
  db=>db.exec("UPDATE process_archive_inflight SET body='{}'"),
  db=>db.exec("UPDATE process_archive_inflight SET receiver_id='22222222-2222-4222-8222-222222222222'"),
 ];
 for(const [i,mutate] of cases.entries()){const file=await copiedDb(f,'data-'+i,mutate);assert.throws(()=>inspectJournal(file),/Process/);}
 const file=await copiedDb(f,'bad-payload',db=>{
  const trigger=db.prepare("SELECT sql FROM sqlite_master WHERE name='process_preserve_versions'").get().sql;db.exec('DROP TRIGGER process_preserve_versions');db.exec("UPDATE process_observations SET payload='{}'");db.exec(trigger);
 });assert.throws(()=>inspectJournal(file),/Process/);
 assert.equal(inspectJournal(f.journal.file).processes.observations,2);
});

test('pending current process history blocks offline replacement and preserves original bytes',async t=>{
 const f=await fixture(t);f.add(1);archive(f.journal);const made=await f.administration.createBackup({journal:f.journal,configuration:DEFAULT_CONFIGURATION,actor});await f.administration.stageRestore({id:made.id,actor});f.add(2);
 const before=hash(await fs.readFile(f.journal.file));await assert.rejects(restoreInstance({dataDirectory:f.root}),/process history archive is incomplete/);assert.equal(hash(await fs.readFile(f.journal.file)),before);assert.equal(inspectJournal(f.journal.file).processes.pendingObservations,1);
});

test('interrupted offline install rolls back all process rows and custody exactly',async t=>{
 const f=await fixture(t);f.add(1);archive(f.journal);const made=await f.administration.createBackup({journal:f.journal,configuration:DEFAULT_CONFIGURATION,actor});await f.administration.stageRestore({id:made.id,actor});f.add(2);archive(f.journal);
 const before=dump(f.journal),beforeHash=hash(await fs.readFile(f.journal.file)),rename=fs.rename.bind(fs);let injected=false;
 t.mock.method(fs,'rename',async(source,destination)=>{if(!injected&&destination===path.join(f.root,'configuration','configuration.json')){injected=true;throw Object.assign(new Error('TEST_ONLY interruption'),{code:'EIO'});}return rename(source,destination);});
 await assert.rejects(restoreInstance({dataDirectory:f.root}),/rolled back/);assert.equal(injected,true);assert.equal(hash(await fs.readFile(f.journal.file)),beforeHash);assert.deepEqual(dump(f.journal),before);assert.equal(f.journal.database(validateProcessBackup).observations,2);
});

test('authorization loss during backup publication leaves no partial backup or source mutation',async t=>{
 const f=await fixture(t);f.add(1);const expected=dump(f.journal);let checks=0;
 await assert.rejects(f.administration.createBackup({journal:f.journal,configuration:DEFAULT_CONFIGURATION,actor,verifyAuthority:()=>{if(++checks===3)throw Error('TEST_ONLY authority revoked');}}),/revoked/);
 assert.deepEqual(dump(f.journal),expected);assert.deepEqual((await f.administration.listBackups()).backups,[]);assert.deepEqual(await fs.readdir(path.join(f.root,'administration','backups')),[]);
});
