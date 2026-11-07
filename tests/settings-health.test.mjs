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
import {collectionHealth,preservationHealth} from '../lib/settings-health.mjs';
import {HistoryJournal} from '../lib/history.mjs';

test('source health distinguishes unknown coverage and never copies sensitive or event data',()=>{
 const snapshot={observedAt:'2026-10-21T00:00:00Z',hosts:[{id:'a',name:'TEST_ONLY A',status:'online',receivedAt:'2026-10-21T00:00:00Z',sourceObservedAt:null,gaps:[],coverage:null,token:'SECRET_CANARY',events:[{prompt:'PRIVATE_CANARY'}]}, {id:'b',status:'invented',gaps:[{}],coverage:{completeHistory:false,limit:128,invalidRecords:2,numericUsage:{backlogged:true}}}]};
 const out=collectionHealth(snapshot);assert.equal(out.accountWideCoverage,false);assert.equal(out.hosts[0].coverage,null);assert.equal(out.hosts[0].runtimeVersion,null);assert.equal(out.hosts[0].compatibility,'not reported');assert.equal(out.hosts[1].state,'unknown');assert.equal(out.hosts[1].gapCount,1);assert.equal(out.hosts[1].coverage.numericUsage.backlogged,true);
 assert.ok(!JSON.stringify(out).includes('CANARY'));assert.equal(collectionHealth(null).hosts.length,0);assert.equal(collectionHealth({hosts:Array.from({length:200},(_,i)=>({id:String(i)}))}).hosts.length,64);
});

test('custody diagnostics read exact pending versions without changing rows, receipts, or schema',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'codexcontrol-TEST_ONLY-health-'));
 try{const journal=await HistoryJournal.open({directory});journal.commit({hostId:'test',state:{},events:[{id:'test-one',hostId:'test',at:'2026-10-21T00:00:00Z',kind:'turn'}]});
  const before=journal.database(db=>({changes:db.prepare('SELECT total_changes() n').get().n,schema:db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),events:db.prepare('SELECT * FROM events').all(),outbox:db.prepare('SELECT * FROM usage_archive_outbox').all()}));
  const result=preservationHealth(journal);assert.equal(result.retentionMode,'verified-archive-only');assert.equal(result.archive.pendingRecords,before.outbox.length);assert.equal(result.scope,'captured usage versions');
  const after=journal.database(db=>({changes:db.prepare('SELECT total_changes() n').get().n,schema:db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),events:db.prepare('SELECT * FROM events').all(),outbox:db.prepare('SELECT * FROM usage_archive_outbox').all()}));assert.deepEqual(after,before);
  assert.equal(preservationHealth(null).status,'unavailable');
 }finally{const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('codexcontrol-TEST_ONLY-health-'));await fs.rm(resolved,{recursive:true,force:true});}
});
