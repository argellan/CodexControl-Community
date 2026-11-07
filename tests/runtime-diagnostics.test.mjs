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
import {runtimeDiagnostics} from '../lib/runtime-diagnostics.mjs';
import {HistoryJournal} from '../lib/history.mjs';

test('on-demand diagnostics report only this process and actual bounded journal files',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-diagnostics-'));
 try{
  const journal=await HistoryJournal.open({directory});
  journal.commit({hostId:'test',state:{},events:[{id:'one',at:new Date().toISOString(),hostId:'test',kind:'turn'}]});
  const first=await runtimeDiagnostics(journal),second=await runtimeDiagnostics(journal);
  assert.equal(first.scope,'observer process only');assert.equal(first.runtime.pid,process.pid);
  assert.ok(first.runtime.rssBytes>0);assert.ok(second.runtime.cpuPercent>=0);
  assert.ok(second.runtime.eventLoopUtilization>=0&&second.runtime.eventLoopUtilization<=1);
  assert.equal(first.journal.retainedEvents,1);
  assert.equal(first.storage.databaseBytes,(await fs.stat(journal.file)).size);
  assert.equal(first.storage.totalBytes,first.storage.databaseBytes+first.storage.walBytes+first.storage.sharedMemoryBytes);
  assert.equal(JSON.stringify(first).includes('commandLine'),false);assert.equal('processes' in first,false);
  const local=await runtimeDiagnostics();assert.equal(local.storage,null);assert.equal(local.journal,null);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
