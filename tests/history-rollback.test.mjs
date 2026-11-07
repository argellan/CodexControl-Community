// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {HistoryJournal} from '../lib/history.mjs';import {exportLegacyCheckpoints} from '../scripts/export-legacy-checkpoints.mjs';
test('rollback export preserves source journal and refuses existing output',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-rollback-'));
 try{const journal=await HistoryJournal.open({directory});journal.commit({hostId:'remote',state:{id:'remote',sessions:[],receivedAt:Date.now()},events:[{id:'one',hostId:'remote',at:new Date().toISOString()}]});journal.commit({hostId:'hub',state:{host:{id:'hub'}},events:[]});
 const before=await fs.readFile(journal.file),output=path.join(directory,'new-export'),result=await exportLegacyCheckpoints(journal.file,output);
 assert.equal(result.hosts.length,1);assert.equal(JSON.parse(await fs.readFile(path.join(output,'remote.json'))).events[0].id,'one');
 assert.deepEqual(await fs.readFile(journal.file),before);await assert.rejects(exportLegacyCheckpoints(journal.file,output),/exist/i);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
