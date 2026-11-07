// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync,backup} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {HistoryJournal} from '../lib/history.mjs';
import {FleetHub} from '../lib/fleet.mjs';
import {createServer} from './fixture-server.mjs';
const exists=async file=>fs.stat(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const close=server=>new Promise((resolve,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):resolve());});
const commit=(journal,id)=>journal.commit({hostId:'TEST_ONLY-local',state:{id:'TEST_ONLY-local',batch:id},events:[{id,hostId:'TEST_ONLY-local',at:'2026-10-25T12:00:00Z',kind:'operation'}]});
async function fixture(run){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-wal-lifetime-TEST_ONLY-'));const servers=[];try{const hub=await FleetHub.open({directory});await run({directory,hub,server(){const server=createServer({hub});servers.push(server);return server;}});}finally{for(const server of servers)if(server.listening)await close(server);await fs.rm(directory,{recursive:true,force:true});}}

test('a listening hub keeps WAL across request connections while every commit remains FULL and independently visible',()=>fixture(async({directory,hub,server})=>{
 const active=server();await listen(active);commit(hub.journal,'first');
 assert.equal(await exists(hub.journal.file+'-wal'),true,'live server must not checkpoint and delete WAL after each operation');
 assert.equal(hub.journal.database(db=>db.prepare('PRAGMA synchronous').get().synchronous),2);
 assert.equal(hub.journal.database(db=>db.prepare('PRAGMA journal_mode').get().journal_mode),'wal');
 const independent=await HistoryJournal.open({directory});assert.deepEqual(independent.read({after:0}).events.map(e=>e.id),['first']);
 commit(hub.journal,'second');assert.deepEqual(independent.read({after:0}).events.map(e=>e.id),['first','second']);
 await close(active);assert.equal(await exists(hub.journal.file+'-wal'),false,'last server closes its keeper and checkpoints');
 assert.deepEqual((await HistoryJournal.open({directory})).read({after:0}).events.map(e=>e.id),['first','second']);
}));

test('shared hub keepers survive one server closing and release only after the final server closes',()=>fixture(async({hub,server})=>{
 const first=server(),second=server();await listen(first);await listen(second);commit(hub.journal,'shared');
 await close(first);assert.equal(await exists(hub.journal.file+'-wal'),true);
 commit(hub.journal,'after-first-close');assert.equal(hub.journal.status().retainedEvents,2);
 await close(second);assert.equal(await exists(hub.journal.file+'-wal'),false);
}));

test('server relisten reacquires the keeper without stale handles or lost event versions',()=>fixture(async({hub,server})=>{
 const active=server();await listen(active);commit(hub.journal,'before-relisten');await close(active);
 await listen(active);commit(hub.journal,'after-relisten');assert.equal(await exists(hub.journal.file+'-wal'),true);
 await close(active);assert.equal(await exists(hub.journal.file+'-wal'),false);assert.equal(hub.journal.status().retainedEvents,2);
}));

test('online backup includes newly committed WAL records before the listening server closes',()=>fixture(async({directory,hub,server})=>{
 const active=server();await listen(active);commit(hub.journal,'wal-only-first');commit(hub.journal,'wal-only-second');
 assert.equal(await exists(hub.journal.file+'-wal'),true);
 const destination=path.join(directory,'TEST_ONLY-online-backup.sqlite'),source=new DatabaseSync(hub.journal.file,{readOnly:true});
 try{await backup(source,destination,{rate:128});}finally{source.close();}
 const saved=new DatabaseSync(destination,{readOnly:true});try{
  assert.equal(saved.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.deepEqual(saved.prepare('SELECT event_id FROM events ORDER BY sequence').all().map(row=>row.event_id),['wal-only-first','wal-only-second']);
  assert.equal(JSON.parse(saved.prepare("SELECT payload FROM host_state WHERE host_id='TEST_ONLY-local'").get().payload).batch,'wal-only-second');
 }finally{saved.close();}
 assert.equal(hub.journal.status().retainedEvents,2);
}));

test('FULL commits survive abrupt process death with the live keeper and recover all WAL records',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-wal-crash-TEST_ONLY-'));
 try{
  const child=`import fs from 'node:fs';const {FleetHub}=await import(${JSON.stringify(new URL('../lib/fleet.mjs',import.meta.url).href)});const {createServer}=await import(${JSON.stringify(new URL('./fixture-server.mjs',import.meta.url).href)});const hub=await FleetHub.open({directory:process.env.TEST_ONLY_CRASH_DIRECTORY});const server=createServer({hub});await new Promise(r=>server.listen(0,'127.0.0.1',r));for(const id of ['first','second'])hub.journal.commit({hostId:'TEST_ONLY-local',state:{batch:id},events:[{id,hostId:'TEST_ONLY-local',at:'2026-10-25T12:00:00Z',kind:'operation'}]});if(fs.statSync(hub.journal.file+'-wal').size<=0)throw Error('WAL absent before crash');process.stdout.write('TEST_ONLY_COMMITTED',()=>process.kill(process.pid,'SIGKILL'));`;
  let failure;try{await promisify(execFile)(process.execPath,['--input-type=module','-e',child],{env:{...process.env,TEST_ONLY_CRASH_DIRECTORY:directory},windowsHide:true,timeout:5000,maxBuffer:8192});}catch(error){failure=error;}
  assert.ok(failure,'child must terminate without graceful server/database close');assert.match(failure.stdout,/TEST_ONLY_COMMITTED/,failure.stderr||failure.message);assert.equal(failure.killed,false,'test timeout must not be the cause');
  assert.equal(await exists(path.join(directory,'history.sqlite-wal')),true);
  const recovered=await HistoryJournal.open({directory});assert.deepEqual(recovered.read({after:0}).events.map(e=>e.id),['first','second']);assert.equal(recovered.state('TEST_ONLY-local').batch,'second');
  commit(recovered,'third');assert.equal(recovered.status().retainedEvents,3);assert.equal(commit(recovered,'third').added,0);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
