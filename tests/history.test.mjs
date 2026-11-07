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
const {HistoryJournal}=await import('../lib/history.mjs').catch(()=>({}));
const event=(id,at='2026-10-20T00:00:00Z')=>({id,hostId:'host',sessionId:'session',sourceId:'source',at,kind:'tool.start',callId:id,label:'exec',delivery:'live'});
async function fixture(fn,options={}){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cc-history-'));try{assert.equal(typeof HistoryJournal,'function');await fn(await HistoryJournal.open({directory:dir,...options}),dir);}finally{await fs.rm(dir,{recursive:true,force:true});}}
test('journal commits events and host state together, survives restart and deduplicates retransmission',()=>fixture(async(journal,dir)=>{
 const first=journal.commit({hostId:'host',state:{id:'host',batchId:'B'},events:[event('one'),event('two')]});
 assert.equal(first.added,2);assert.equal(journal.commit({hostId:'host',state:{id:'host',batchId:'retry'},events:[event('two')]}).added,0);
 const restarted=await HistoryJournal.open({directory:dir});assert.equal(restarted.status().epoch,journal.status().epoch);assert.equal(restarted.state('host').batchId,'retry');
 const page=restarted.read({after:0});assert.deepEqual(page.events.map(e=>e.id),['one','two']);assert.equal(page.nextCursor,2);assert.equal(page.caughtUp,true);
 assert.equal(journal.commit({hostId:'host',state:{batchId:'three'},events:[event('three')]}).added,1);assert.equal(restarted.read({after:2}).events[0].id,'three');
}));
test('snapshot high-water cursor cannot miss events committed between snapshot and recovery request',()=>fixture(async journal=>{
 journal.commit({hostId:'host',state:{},events:[event('first')]});const snapshot=journal.status();
 journal.commit({hostId:'host',state:{},events:[event('second')]});const page=journal.read({after:snapshot.latestSequence,epoch:snapshot.epoch});
 assert.deepEqual(page.events.map(e=>e.id),['second']);assert.equal(page.gap,null);assert.equal(page.nextCursor,2);
}));
test('unarchived events survive hot-cache targets while changed and future cursors remain explicit',()=>fixture(async journal=>{
 journal.commit({hostId:'host',state:{},events:[event('a'),event('b'),event('c'),event('d')]});
 assert.equal(journal.status().retainedEvents,4);const page=journal.read({after:0});assert.equal(page.gap,null);assert.deepEqual(page.events.map(e=>e.id),['a','b','c','d']);assert.equal(page.eventArchive.status,'not-configured');assert.equal(page.eventArchive.pendingRecords,4);
 assert.equal(journal.read({after:0,epoch:'other-journal'}).gap.reason,'journal-changed');assert.equal(journal.read({after:999}).gap.reason,'cursor-ahead');
 assert.equal(journal.status().completeHistory,false);
},{maxEvents:3}));
test('first-seen old source events stay durable until archive custody exists',()=>fixture(async journal=>{
 const old=event('old','2020-01-01T00:00:00Z');assert.equal(journal.commit({hostId:'host',state:{},events:[old]}).added,1);assert.equal(journal.read({after:0}).events[0].id,'old');assert.equal(journal.status().retentionFloor,0);
},{maxAgeMs:86400000,maxBytes:512}));
test('read pages have byte/item budgets, bounded time queries and canonical source timestamps',()=>fixture(async journal=>{
 journal.commit({hostId:'host',state:{},events:[event('late','2026-10-20T01:00:00Z'),event('early','2026-10-19T01:00:00Z'),event('third')]});
 const a=journal.read({after:0,limit:1});assert.equal(a.events.length,1);assert.equal(a.caughtUp,false);assert.equal(a.events[0].at,'2026-10-20T01:00:00Z');
 const b=journal.read({after:a.nextCursor,limit:1});assert.equal(b.events[0].id,'early');const bounded=journal.read({after:0,maxBytes:512});assert.ok(bounded.bytes<=512);assert.ok(bounded.events.length>0);
 const older=journal.read({before:'2026-10-20T00:00:00Z',limit:10});assert.deepEqual(older.events.map(e=>e.id),['early']);
 assert.throws(()=>journal.read({after:-1}),/cursor/);assert.throws(()=>journal.read({limit:99999}),/limit/);
}));
