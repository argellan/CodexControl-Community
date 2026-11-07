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
test('a journal page cannot mix counters and rows across an independent writer commit',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-read-snapshot-TEST_ONLY-'));let release;const prepare=DatabaseSync.prototype.prepare;
 try{
  const journal=await HistoryJournal.open({directory}),other=await HistoryJournal.open({directory});release=journal.retainConnection();
  const commit=id=>other.commit({hostId:'TEST_ONLY-host',state:{id},events:[{id,at:new Date().toISOString(),kind:'operation'}]});commit('first');let interleaved=false;
  DatabaseSync.prototype.prepare=function(sql,...args){
   if(!interleaved&&sql==="SELECT seq FROM sqlite_sequence WHERE name='events'"){interleaved=true;commit('second');}
   return prepare.call(this,sql,...args);
  };
  const page=journal.read();assert.equal(interleaved,true);assert.equal(page.retainedEvents,page.events.length,'one page must describe one database snapshot');assert.equal(page.latestSequence,1);assert.deepEqual(page.events.map(e=>e.id),['first']);
  DatabaseSync.prototype.prepare=prepare;assert.equal(journal.read().retainedEvents,2);
 }finally{DatabaseSync.prototype.prepare=prepare;release?.();await fs.rm(directory,{recursive:true,force:true});}
});
