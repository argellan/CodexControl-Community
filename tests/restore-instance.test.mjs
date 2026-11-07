// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {Administration} from '../lib/administration.mjs';
import {ConfigurationStore} from '../lib/configuration.mjs';
import {HistoryJournal} from '../lib/history.mjs';
import {DEFAULT_CONFIGURATION} from '../public/settings-schema.mjs';
import {TokenMotion} from '../public/token-motion.mjs';
import {selectArchiveBatch,acknowledgeArchiveBatch,archiveStatus} from '../lib/usage-archive.mjs';
import {acquireArchiveLock} from '../scripts/archive-usage.mjs';
const restore=await import('../scripts/restore-instance.mjs').catch(()=>({}));
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const actor={id:'owner',role:'admin'};
const archiveAll=journal=>journal.database(db=>{let batch;while((batch=selectArchiveBatch(db))){acknowledgeArchiveBatch(db,{batch,expectedReceiverId:'TEST_ONLY_archive',receipt:{version:1,batchId:batch.batchId,rawSha256:batch.rawSha256,records:batch.records,itemIds:batch.itemIds,receiverId:'TEST_ONLY_archive',durable:true}});}});
const snapshotFiles=async root=>{const files=['history.sqlite','configuration/configuration.json','configuration/configuration.last-good.json','administration/administration.json'],result={};for(const file of files)result[file]=hash(await fs.readFile(path.join(root,file)));return result;};
const fixture=async fn=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'cc-offline-restore-'));try{
 const administration=await Administration.open({directory:path.join(root,'administration'),initial:{instanceId:'restore-fixture',viewers:[{id:'owner',label:'Owner',role:'admin',hostIds:null,projectIds:null,tokenHash:hash('fixture-owner')}],hosts:[]}}),configuration=await ConfigurationStore.open({directory:path.join(root,'configuration'),initial:DEFAULT_CONFIGURATION}),journal=await HistoryJournal.open({directory:root});
 const tokenAt=Date.now()-8000,usageState=(n,at)=>({sessions:[{id:'TEST_ONLY worker',project:'TEST_ONLY',provider:'openai',usageObservedAt:new Date(at).toISOString(),tokens:{input_tokens:n,cached_input_tokens:n/2,output_tokens:n/10,total_tokens:n+n/10}}]});
 journal.commit({hostId:'source',state:usageState(100,tokenAt),events:[{id:'before',hostId:'source',kind:'turn',at:new Date().toISOString()}]});
 archiveAll(journal);
 const backup=await administration.createBackup({journal,configuration:await configuration.read(),actor});await administration.stageRestore({id:backup.id,actor});
 journal.commit({hostId:'source',state:usageState(200,tokenAt+1000),events:[{id:'after',hostId:'source',kind:'turn',at:new Date().toISOString()}]});const next=structuredClone(DEFAULT_CONFIGURATION);next.general.instanceName='After backup';await configuration.save({revision:1,configuration:next,actor});
 archiveAll(journal);
 await fs.writeFile(path.join(root,'runtime.pid'),JSON.stringify({pid:2147483647,instanceId:'restore-fixture'}));return await fn({root,administration,configuration,journal,backup});
}finally{await fs.rm(root,{recursive:true,force:true});}};

test('offline restore validates staged backup, preserves prior files and restores metadata without touching security',()=>fixture(async({root,journal,configuration})=>{
 assert.equal(typeof restore.restoreInstance,'function');const before=await snapshotFiles(root),receipt=await restore.restoreInstance({dataDirectory:root});
 assert.equal(receipt.status,'restored');assert.equal(receipt.requiresRestart,true);assert.equal(receipt.serviceStarted,false);assert.equal(journal.status().retainedEvents,1);assert.deepEqual(journal.latest().map(e=>e.id),['before']);assert.equal((await configuration.read()).configuration.general.instanceName,DEFAULT_CONFIGURATION.general.instanceName);
 const after=await snapshotFiles(root);assert.equal(after['administration/administration.json'],before['administration/administration.json']);assert.ok(receipt.previousDirectory.startsWith(root+path.sep));
 for(const file of ['history.sqlite','configuration/configuration.json','configuration/configuration.last-good.json'])assert.equal(hash(await fs.readFile(path.join(receipt.previousDirectory,'original',file))),before[file]);assert.ok((await fs.stat(path.join(root,'administration','restore-staging','pending','manifest.json'))).isFile());
}));

test('a live process PID blocks restore before active files change',()=>fixture(async({root})=>{
 await fs.writeFile(path.join(root,'runtime.pid'),JSON.stringify({pid:process.pid,instanceId:'restore-fixture'}));const before=await snapshotFiles(root);await assert.rejects(restore.restoreInstance({dataDirectory:root}),/live|running|offline/i);assert.deepEqual(await snapshotFiles(root),before);
}));

test('restore refuses newer unarchived usage without stranding it in a retired database',()=>fixture(async({root,journal})=>{
 const at=new Date().toISOString();journal.commit({hostId:'source',state:{sessions:[{id:'TEST_ONLY worker',usageObservedAt:at,tokens:{input_tokens:300}}]},events:[]});
 const before=await snapshotFiles(root),pending=journal.database(db=>archiveStatus(db).pendingRecords);assert.ok(pending>0);
 await assert.rejects(restore.restoreInstance({dataDirectory:root}),/archive.*incomplete|pending records/i);
 assert.deepEqual(await snapshotFiles(root),before);assert.equal(journal.database(db=>archiveStatus(db).pendingRecords),pending);
 assert.deepEqual((await fs.readdir(root)).filter(n=>n.startsWith('restore-previous-')),[]);
}));

test('restore and archive sender share one exclusive database replacement lock',()=>fixture(async({root})=>{
 const release=await acquireArchiveLock(path.join(root,'history.sqlite'));try{const before=await snapshotFiles(root);await assert.rejects(restore.restoreInstance({dataDirectory:root}),/Archive sender is active/);assert.deepEqual(await snapshotFiles(root),before);}finally{await release();}
 assert.equal((await restore.restoreInstance({dataDirectory:root})).status,'restored');
}));

test('an older own backup rotates the usage stream so existing and refreshed tabs recover without replay',()=>fixture(async({root,journal})=>{
 const before=journal.usage(),saved=new Map(),storage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v)},motion=new TokenMotion({storage});
 const payload=r=>({burnUsage:{...r.burn,epoch:r.epoch},usageHistory:r});
 motion.feed(payload(before));assert.equal(before.burn.lastSequence,2);
 const receipt=await restore.restoreInstance({dataDirectory:root}),restored=journal.usage();
 assert.equal(receipt.usageStreamRotated,true);assert.notEqual(restored.epoch,before.epoch);assert.equal(restored.burn.lastSequence,1);
 motion.feed(payload(restored));assert.equal(motion.packets.length,0);assert.equal(motion.cursor,1);
 const reloaded=new TokenMotion({storage});reloaded.feed(payload(restored));assert.equal(reloaded.packets.length,0);
 const at=new Date().toISOString();journal.commit({hostId:'source',state:{sessions:[{id:'TEST_ONLY worker',project:'TEST_ONLY',provider:'openai',usageObservedAt:at,tokens:{input_tokens:150,cached_input_tokens:60,output_tokens:20,total_tokens:170}}]},events:[]});
 const next=journal.usage();motion.feed(payload(next));reloaded.feed(payload(next));assert.ok(motion.packets.length>0);assert.ok(reloaded.packets.length>0);
 assert.equal(next.burn.inputTokens,50);
}));

test('wrong instance, corrupt staged bytes and manifest path escape are refused without active mutations',async()=>{
 for(const variant of ['instance','checksum','path'])await fixture(async({root})=>{const stage=path.join(root,'administration','restore-staging','pending'),manifestFile=path.join(stage,'manifest.json'),manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
  if(variant==='instance')manifest.instanceId='foreign-instance';if(variant==='path')manifest.files[0].name='../../outside';if(variant==='checksum')await fs.appendFile(path.join(stage,'configuration.json'),'corrupt');await fs.writeFile(manifestFile,JSON.stringify(manifest));const before=await snapshotFiles(root);await assert.rejects(restore.restoreInstance({dataDirectory:root}));assert.deepEqual(await snapshotFiles(root),before);
 });
});

test('missing process guard and relative data paths fail closed',()=>fixture(async({root})=>{
 const before=await snapshotFiles(root);await fs.unlink(path.join(root,'runtime.pid'));await assert.rejects(restore.restoreInstance({dataDirectory:root}),/guard|PID|process/i);await assert.rejects(restore.restoreInstance({dataDirectory:'relative-data'}),/absolute/i);assert.deepEqual(await snapshotFiles(root),before);
}));

test('a post-journal configuration install failure rolls back originals and leaves a failed receipt',t=>fixture(async({root})=>{
 const before=await snapshotFiles(root),rename=fs.rename.bind(fs);let injected=false;
 t.mock.method(fs,'rename',async(source,destination)=>{if(!injected&&destination===path.join(root,'configuration','configuration.json')){injected=true;throw Object.assign(new Error('Injected install failure'),{code:'EIO'});}return rename(source,destination);});
 await assert.rejects(restore.restoreInstance({dataDirectory:root}),/restore|rolled|install/i);assert.equal(injected,true);assert.deepEqual(await snapshotFiles(root),before);
 const directories=(await fs.readdir(root)).filter(n=>n.startsWith('restore-previous-'));assert.equal(directories.length,1);const receipt=JSON.parse(await fs.readFile(path.join(root,directories[0],'receipt.json'),'utf8'));assert.equal(receipt.status,'failed-rolled-back');assert.equal(receipt.serviceStarted,false);
}));

test('a staged-directory junction is refused before active files change',()=>fixture(async({root})=>{
 const stage=path.join(root,'administration','restore-staging','pending'),held=stage+'-held',foreign=await fs.mkdtemp(path.join(os.tmpdir(),'cc-restore-foreign-'));
 try{await fs.rename(stage,held);await fs.symlink(foreign,stage,process.platform==='win32'?'junction':'dir');const before=await snapshotFiles(root);await assert.rejects(restore.restoreInstance({dataDirectory:root}),/symbolic|junction|escape/i);assert.deepEqual(await snapshotFiles(root),before);}
 finally{await fs.unlink(stage).catch(()=>{});await fs.rm(foreign,{recursive:true,force:true});}
}));


test('older history/config restore retains current enrollment generation, revocation receipts and audit',()=>fixture(async({root,administration})=>{
 const host={id:'test-recovery-device',label:'TEST_ONLY recovery device'},requestId=crypto.randomUUID(),state=await administration.state(),first=await administration.enrollSource({revision:state.revision,host,actor,requestId,expectedHostname:'TEST-ONLY'}),second=await administration.enrollSource({revision:first.revision,host,actor,requestId:crypto.randomUUID(),expectedHostname:'TEST-ONLY',replace:true,expectedGeneration:1});await administration.revokeSource({revision:second.revision,id:host.id,actor});
 const file=path.join(root,'administration','administration.json'),before=await fs.readFile(file);await restore.restoreInstance({dataDirectory:root});assert.deepEqual(await fs.readFile(file),before);
 const current=await Administration.open({directory:path.dirname(file)}),receipt=await current.enrollmentReceipt({requestId,actor});assert.equal(receipt.source.status,'revoked');assert.equal(receipt.source.credentialGeneration,2);assert.equal((await current.audit()).at(-2).action,'replace-source');
}));
