// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {HistoryJournal} from '../lib/history.mjs';
import {FleetHub} from '../lib/fleet.mjs';
const at='2026-10-20T12:00:00Z';
const event=(id,extra={})=>({id,hostId:'local',sourceId:'log',sessionId:'session',turnId:'turn',at,kind:'tool.start',callId:id,label:'exec',...extra});
async function fixture(run){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-history-review-'));try{await run(directory);}finally{await fs.rm(directory,{recursive:true,force:true});}}

test('backward pagination retains equal-timestamp records across page boundaries',()=>fixture(async directory=>{
 const journal=await HistoryJournal.open({directory});journal.commit({hostId:'local',state:{},events:Array.from({length:5},(_,i)=>event('equal-'+i))});
 const first=journal.read({before:'2026-10-20T12:00:01Z',limit:2});
 assert.equal(first.events.length,2);assert.equal(first.caughtUp,false);
 // A continuation must identify the equal-time boundary row as well as its time.
 const second=journal.read({before:first.olderBefore,beforeSequence:first.olderSequence,limit:2});
 assert.equal(second.events.length,2);
 const third=journal.read({before:second.olderBefore,beforeSequence:second.olderSequence,limit:2});
 assert.equal(new Set([...first.events,...second.events,...third.events].map(e=>e.id)).size,5);
}));

test('local capture persists session metadata without nested event histories exceeding state budget',()=>fixture(async directory=>{
 const hub=await FleetHub.open({directory}),events=Array.from({length:5500},(_,i)=>event('e'+i,{label:'safe tool label '.repeat(12)}));
 const local={observedAt:at,host:{id:'local',name:'Fixture'},coverage:{},sessions:[{id:'session',project:'Fixture',events}],events};
 const committed=await hub.captureLocal(local);
 assert.equal(committed.added,events.length);const saved=hub.journal.state('local');assert.ok(!Object.hasOwn(saved.sessions[0],'events'));assert.equal(hub.journal.latest({limit:6000}).length,5500);
}));

test('quiet heartbeat commits preserve unarchived events despite hot-cache age target',()=>fixture(async directory=>{
 const journal=await HistoryJournal.open({directory,maxAgeMs:1000});
 journal.commit({hostId:'local',state:{batch:'first'},events:[event('old')],now:1000});
 journal.commit({hostId:'local',state:{batch:'heartbeat'},events:[],now:3000});
 assert.equal(journal.status().retainedEvents,1);assert.equal(journal.latest().length,1);assert.equal(journal.read({after:0}).gap,null);
}));

test('a mid-transaction SQLite failure rolls back preceding events, counters and host state together',()=>fixture(async directory=>{
 const journal=await HistoryJournal.open({directory});journal.commit({hostId:'local',state:{batch:'baseline'},events:[event('baseline')]});
 const before=journal.status();journal.database(db=>db.exec("CREATE TRIGGER reject_fixture BEFORE INSERT ON events WHEN NEW.event_id='explode' BEGIN SELECT RAISE(ABORT,'fixture failure'); END"));
 assert.throws(()=>journal.commit({hostId:'local',state:{batch:'uncommitted'},events:[event('partial'),event('explode')]}),/fixture failure/);
 assert.equal(journal.state('local').batch,'baseline');assert.deepEqual(journal.latest().map(e=>e.id),['baseline']);assert.deepEqual(journal.status(),before);
}));

test('metadata snapshots exclude nested local event arrays as well as the top-level history',()=>fixture(async directory=>{
 const hub=await FleetHub.open({directory}),events=[event('one')],local={observedAt:at,host:{id:'local',name:'Fixture'},coverage:{},sessions:[{id:'session',project:'Fixture',events}],events};
 const snapshot=hub.snapshot(local,Date.parse(at),{includeEvents:false});
 assert.deepEqual(snapshot.events,[]);assert.ok(!Object.hasOwn(snapshot.sessions[0],'events'));assert.equal(local.sessions[0].events.length,1);
}));

test('age-expired retransmissions deduplicate against retained original sequence',()=>fixture(async directory=>{
 const journal=await HistoryJournal.open({directory,maxAgeMs:1000}),old=event('old',{at:new Date(1000).toISOString()});
 journal.commit({hostId:'local',state:{},events:[old],now:1000});journal.commit({hostId:'local',state:{},events:[],now:3000});
 const retry=journal.commit({hostId:'local',state:{},events:[old],now:4000});
 assert.equal(retry.added,0);assert.equal(retry.retainedEvents,1);assert.equal(retry.latestSequence,1);
}));

test('out-of-order backfill remains recoverable beyond hot-cache age target',()=>fixture(async directory=>{
 const journal=await HistoryJournal.open({directory,maxAgeMs:1000});
 journal.commit({hostId:'local',state:{},events:[event('fresh',{at:new Date(10000).toISOString()}),event('late-backfill',{at:new Date(9100).toISOString()})],now:10000});
 journal.commit({hostId:'local',state:{},events:[],now:10150});
 assert.deepEqual(journal.latest().map(e=>e.id),['fresh','late-backfill']);
 const recovered=journal.read({after:0});assert.equal(recovered.gap,null);assert.deepEqual(recovered.events.map(e=>e.id),['fresh','late-backfill']);assert.equal(recovered.caughtUp,true);assert.equal(recovered.nextCursor,2);
}));
