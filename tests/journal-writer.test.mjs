// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {HistoryJournal} from '../lib/history.mjs';
import {JournalWriter} from '../lib/journal-writer.mjs';
const batch=id=>({hostId:'TEST_ONLY-source',state:{batch:id},events:[{id,sessionId:'TEST_ONLY-session',at:new Date().toISOString(),kind:'operation'}]});
async function fixture(fn){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-writer-TEST_ONLY-'));let writer,release;try{const journal=await HistoryJournal.open({directory});release=journal.retainConnection();writer=new JournalWriter(journal);await fn({journal,writer});}finally{if(writer)await writer.abort?.();if(writer&&!writer.closed){await writer.worker.terminate();await writer.exited;}release?.();await fs.rm(directory,{recursive:true,force:true});}}

test('matching-ID malformed success cannot acknowledge a journal write',()=>fixture(async({journal,writer})=>{
 const pending=writer.commit(JSON.stringify(batch('malformed')),journal.storageAdmission);
 const rejected=assert.rejects(pending,error=>error.journalOutcome==='uncertain'&&error.status===503);
 writer.worker.emit('message',{id:1,kind:'committed',result:{}});await rejected;
 assert.equal(writer.closed,true,'old writer must exit before uncertain outcome is released');
}));

test('malformed worker error cannot forge a successful HTTP status',()=>fixture(async({journal,writer})=>{
 const pending=writer.commit(JSON.stringify(batch('bad-error')),journal.storageAdmission);
 const rejected=assert.rejects(pending,error=>error.journalOutcome==='uncertain'&&error.status!==200);
 writer.worker.emit('message',{id:1,kind:'rejected',error:{message:'TEST_ONLY malformed',status:200,journalOutcome:'rolled-back'}});await rejected;
}));

test('native SQLite lock wait leaves the request loop runnable and confirms only committed rows',()=>fixture(async({journal,writer})=>{
 const lock=new DatabaseSync(journal.file);lock.exec('BEGIN IMMEDIATE');let settled=false,timerRan=false;
 const pending=writer.commit(JSON.stringify(batch('locked')),journal.storageAdmission).then(value=>{settled=true;return value;});
 try{await new Promise(resolve=>setTimeout(()=>{timerRan=true;assert.equal(settled,false);lock.exec('ROLLBACK');resolve();},150));const result=await pending;assert.equal(timerRan,true);assert.equal(result.added,1);assert.deepEqual(journal.read().events.map(e=>e.id),['locked']);}finally{if(lock.isTransaction)lock.exec('ROLLBACK');lock.close();}
}));

test('ordinary quota refusal remains typed and leaves every transaction table unchanged',()=>fixture(async({journal,writer})=>{
 const at=Date.now()-1,b=batch('quota');b.state.sessions=[{id:'TEST_ONLY-session',usageObservedAt:new Date(at).toISOString(),tokens:{input_tokens:100,cached_input_tokens:20,output_tokens:10,total_tokens:110}}];
 const dump=()=>journal.database(db=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM '+name).all()]))),before=dump();
 await assert.rejects(writer.commit(JSON.stringify(b),{...journal.storageAdmission,sourceBytes:1}),error=>error.name==='StorageBackpressure'&&error.code==='STORAGE_BACKPRESSURE'&&error.status===503&&error.retryAfter===60&&error.journalOutcome==='rolled-back');
 assert.deepEqual(dump(),before);
 const accepted=await writer.commit(JSON.stringify(batch('after-quota')),journal.storageAdmission);assert.equal(accepted.added,1);
}));

test('closing admission rejects racing commands and waits for worker exit',()=>fixture(async({journal,writer})=>{
 await writer.commit(JSON.stringify(batch('before-close')),journal.storageAdmission);
 const closing=writer.close();await assert.rejects(writer.commit(JSON.stringify(batch('during-close')),journal.storageAdmission));await closing;assert.equal(writer.closed,true);assert.equal(journal.status().retainedEvents,1);
}));

test('uncertain native failures retain a sanitized diagnostic cause without becoming success',()=>fixture(async({journal,writer})=>{
 const pending=writer.commit(JSON.stringify(batch('uncertain-cause')),journal.storageAdmission);
 const rejected=assert.rejects(pending,error=>error.status===503&&error.journalOutcome==='uncertain'&&error.cause?.code==='ERR_SQLITE_ERROR'&&error.cause?.sqliteCode===10);
 writer.worker.emit('message',{id:1,kind:'rejected',error:{message:'TEST_ONLY native failure',code:'ERR_SQLITE_ERROR',sqliteCode:10,journalOutcome:'uncertain'}});await rejected;assert.equal(writer.closed,true);
}));
