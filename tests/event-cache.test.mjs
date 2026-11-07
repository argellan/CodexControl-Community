// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventStore,visibleEvents,eventTime} from '../public/event-model.mjs';

const NOW=Date.parse('2026-10-20T12:00:00Z'),at=offset=>new Date(NOW+offset).toISOString();
const event=(id,source=0,receipt=0,sequence=1,extra={})=>({id,hostId:'TEST_ONLY-source',sourceId:'TEST_ONLY-log',sessionId:'TEST_ONLY-worker',kind:'message',label:'TEST_ONLY observed record',at:at(source),receivedAt:at(receipt),journalSequence:sequence,delivery:'live',...extra});
const ingest=(store,events,observed=0,epoch='TEST_ONLY-journal')=>store.ingest({observedAt:at(observed),events,sessions:[],hosts:[],history:{epoch}});
function flood(store,count=21000){for(let start=0;start<count;start+=1000)ingest(store,Array.from({length:Math.min(1000,count-start)},(_,j)=>event('future-'+(start+j),86400000,-1000,start+j+1)));}

test('over twenty thousand future records cannot retain priority over later current arrivals',()=>{
 const store=new EventStore();flood(store);assert.equal(store.events.size,20000);
 const current=event('current',0,0,21001,{hostId:'TEST_ONLY-unrelated-host',project:'TEST_ONLY-visible'}),before=structuredClone(current);
 const fresh=ingest(store,[current]);assert.deepEqual(fresh.map(e=>e.id),['current']);assert.equal(store.events.size,20000);assert.ok(store.events.has('current'));
 const visible=visibleEvents(store.viewEvents(),NOW,60000,{hostId:current.hostId,project:current.project});assert.deepEqual(visible.map(e=>e.id),['current']);assert.deepEqual(current,before);assert.equal(store.events.get('future-20999').at,at(86400000));
});

test('late future backfill cannot displace a more recently received ordinary record',()=>{
 const store=new EventStore();ingest(store,[event('current',0,0,30000)]);
 for(let start=0;start<21000;start+=1000)assert.equal(ingest(store,Array.from({length:1000},(_,j)=>event('late-'+(start+j),86400000,-1000,start+j+1,{delivery:'backfill'}))).length,0);
 assert.equal(store.events.size,20000);assert.ok(store.events.has('current'));assert.deepEqual(visibleEvents(store.viewEvents(),NOW,60000).map(e=>e.id),['current']);
});

test('receipt order and journal sequence handle reversed backfill arrays without source-time preference',()=>{
 const store=new EventStore(),records=Array.from({length:20000},(_,i)=>event('cached-'+i,0,-1000,i+1));ingest(store,records);
 const old=event('old-backfill',86400000,-2000,1,{delivery:'backfill'});assert.deepEqual(ingest(store,[old]),[]);assert.equal(store.events.has(old.id),false);
 const newest=event('newest',-86400000,-1000,20001,{delivery:'backfill'});ingest(store,[newest]);assert.ok(store.events.has(newest.id));assert.equal(store.events.has('cached-0'),false);
 const replay=new EventStore();ingest(replay,[...records].reverse());ingest(replay,[newest]);assert.deepEqual([...replay.events.keys()].sort(),[...store.events.keys()].sort());assert.equal(replay.cacheOrder.size,20000);
});

test('duplicates and evicted refresh records never animate again or refresh retention order',()=>{
 const store=new EventStore();ingest(store,[],-1);const first=event('first',0,0,1),fresh=ingest(store,[first]);assert.equal(fresh.length,1);assert.deepEqual(ingest(store,[{...first,receivedAt:at(1000)}],1000),[]);assert.equal(store.events.get('first').receivedAt,first.receivedAt);
 ingest(store,Array.from({length:20000},(_,i)=>event('next-'+i,1000,1000,i+2)),1000);assert.equal(store.events.has('first'),false);assert.deepEqual(ingest(store,[first],1000),[]);assert.equal(store.events.has('first'),false);
 // The journal watermark also suppresses repeat animation beyond ID-cache age.
 store.seenIds.clear();assert.deepEqual(ingest(store,[first],1000),[]);
});

test('legacy records use observed receipt fallback and bounded deduplication without modifying evidence',()=>{
 const store=new EventStore();ingest(store,[],-1);const legacy=event('legacy',0,0,1);delete legacy.receivedAt;delete legacy.journalSequence;const before=structuredClone(legacy);
 assert.equal(ingest(store,[legacy]).length,1);ingest(store,Array.from({length:20000},(_,i)=>{const e=event('fallback-'+i,86400000,1000,i+1);delete e.receivedAt;delete e.journalSequence;return e;}),1000);
 assert.equal(store.events.has('legacy'),false);assert.deepEqual(ingest(store,[legacy],1000),[]);assert.ok(store.events.has('legacy'));assert.deepEqual(legacy,before);assert.ok(store.seenIds.size<=40000);assert.equal(store.cacheOrder.size,20000);
});

test('recent replay uses observed time, all replay retains future evidence, and live ingestion cannot alter frozen replay',()=>{
 const store=new EventStore(),current=event('current',-1000,-1000,1),future=event('future',86400000,0,2);ingest(store,[current,future]);
 store.enterReplay(NOW+86400000,60000);assert.deepEqual(store.bounds,[NOW-1000,NOW]);assert.equal(store.clock,NOW);assert.deepEqual(visibleEvents(store.viewEvents(),store.clock,60000).map(e=>e.id),['current']);
 const frozen=JSON.stringify(store.viewEvents());assert.deepEqual(ingest(store,[event('during-replay',1000,1000,3)],1000),[]);assert.equal(JSON.stringify(store.viewEvents()),frozen);assert.ok(store.events.has('during-replay'));
 store.setReplayWindow(null);assert.equal(store.bounds[1],eventTime(future));store.seek(eventTime(future));assert.ok(visibleEvents(store.viewEvents(),store.clock,60000).some(e=>e.id==='future'));
 store.setReplayWindow(60000);assert.equal(store.bounds[1],NOW);store.goLive();assert.deepEqual(ingest(store,[event('during-replay',1000,1000,3)],1000),[]);assert.equal(ingest(store,[event('live-positive',2000,2000,4)],2000).length,1);
});

test('future-only recent replay has valid bounds and history replay preserves exact supplied source clocks',()=>{
 const store=new EventStore();ingest(store,[event('future',86400000,0,1)]);store.enterReplay(undefined,60000);assert.deepEqual(store.bounds,[NOW,NOW]);assert.equal(visibleEvents(store.viewEvents(),store.clock,60000).length,0);
 const history=event('historical',-86400000,-86400000,1);store.enterHistoryReplay([history]);assert.equal(store.clock,eventTime(history));assert.deepEqual(store.viewEvents(),[history]);assert.equal(store.events.has(history.id),false);
});

test('journal replacement resets sequence animation suppression without replaying old cached identities',()=>{
 const store=new EventStore();ingest(store,[event('old',0,0,500)]);const next=event('replacement',1000,1000,1);assert.deepEqual(ingest(store,[next],1000,'TEST_ONLY-replaced').map(e=>e.id),['replacement']);assert.deepEqual(ingest(store,[next],1000,'TEST_ONLY-replaced'),[]);
});

test('same-epoch restore rollback admits distinct new records once while preserving retained and evicted seen IDs',()=>{
 const store=new EventStore(),snapshot=(events,observed,latestSequence)=>({observedAt:at(observed),events,sessions:[],hosts:[],history:{epoch:'TEST_ONLY-same',latestSequence}});
 const old=event('old-evicted',-1000,-1000,1),retained=event('old-retained',0,0,20001);
 store.ingest(snapshot([old],-1000,1));store.ingest(snapshot([...Array.from({length:19999},(_,i)=>event('fill-'+i,0,0,i+2)),retained],0,20001));assert.equal(store.events.has(old.id),false);assert.ok(store.events.has(retained.id));
 const fresh=event('new-after-restore',1000,1000,10),before=structuredClone(fresh);
 assert.deepEqual(store.ingest(snapshot([{...old,journalSequence:8},{...retained,journalSequence:9},fresh],1000,10)).map(e=>e.id),[fresh.id]);assert.deepEqual(fresh,before);assert.deepEqual(store.ingest(snapshot([fresh],1000,10)),[]);
 const next=event('new-next',2000,2000,11);assert.deepEqual(store.ingest(snapshot([next],2000,11)).map(e=>e.id),[next.id]);assert.deepEqual(store.ingest(snapshot([next],2000,11)),[]);
});

test('scope changes and stale lower-sequence responses do not reset the current global watermark',()=>{
 const store=new EventStore(),snapshot=(events,observed,latestSequence)=>({observedAt:at(observed),events,sessions:[],hosts:[],history:{epoch:'TEST_ONLY-same',latestSequence}});
 store.ingest(snapshot([event('baseline',0,0,500)],0,500));assert.deepEqual(store.ingest(snapshot([event('scoped-old',1000,1000,20)],1000,500)),[]);assert.equal(store.latestSequence,500);
 assert.deepEqual(store.ingest(snapshot([event('stale-response',0,0,21)],0,21)),[]);assert.equal(store.latestSequence,500);
 store.enterReplay(NOW);const frozen=JSON.stringify(store.viewEvents()),bounds=[...store.bounds];store.ingest(snapshot([event('restored-during-replay',2000,2000,10)],2000,10));assert.equal(JSON.stringify(store.viewEvents()),frozen);assert.deepEqual(store.bounds,bounds);store.goLive();assert.deepEqual(store.ingest(snapshot([event('restored-during-replay',2000,2000,10)],2000,10)),[]);assert.equal(store.ingest(snapshot([event('fresh-after-replay',3000,3000,11)],3000,11)).length,1);
});
