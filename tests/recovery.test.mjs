// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';import assert from 'node:assert/strict';
const {recoverPage,bootstrapCursor}=await import('../public/recovery-model.mjs').catch(()=>({}));
const event=(id,sequence)=>({id,hostId:'H',sessionId:'S',kind:'turn',label:'Observed turn',at:'2026-10-20T01:00:00Z',journalSequence:sequence,delivery:'live'});
import {EventStore} from '../public/event-model.mjs';
test('archive replay remains separate from the live ring and never invents historical host health',()=>{
 const store=new EventStore();store.ingest({observedAt:'2026-10-20T01:00:10Z',events:[event('live',5)],sessions:[{id:'S'}],hosts:[{id:'H',status:'online',telemetry:{cpu:1}}]});
 assert.equal(typeof store.enterHistoryReplay,'function');store.enterHistoryReplay([event('old',1)]);assert.equal(store.mode,'replay');assert.deepEqual(store.viewEvents().map(e=>e.id),['old']);assert.equal(store.viewHosts()[0].status,'historical / unknown');assert.equal(store.events.has('old'),false);store.goLive();assert.equal(store.viewEvents()[0].id,'live');
});
test('recovery cursor advances only with a valid ordered page and rejects replayed or malformed sequences',()=>{
 assert.equal(typeof recoverPage,'function');const state=bootstrapCursor({epoch:'E',latestSequence:4});
 const result=recoverPage(state,{epoch:'E',nextCursor:6,latestSequence:6,caughtUp:true,events:[event('five',5),event('six',6)],gap:null});assert.equal(result.state.after,6);assert.equal(state.after,4);assert.equal(result.events[0].delivery,'live');
 assert.throws(()=>recoverPage(state,{epoch:'E',nextCursor:6,latestSequence:6,caughtUp:true,events:[event('six',6),event('five',5)]}),/sequence/);
 assert.throws(()=>recoverPage(state,{epoch:'E',nextCursor:3,latestSequence:6,caughtUp:true,events:[]}),/cursor/);
});
test('disconnect, incomplete catch-up and journal gaps suppress live animation while preserving exact source identities',()=>{
 const state=bootstrapCursor({epoch:'E',latestSequence:4});
 const result=recoverPage(state,{epoch:'E',nextCursor:5,latestSequence:9,caughtUp:false,events:[event('five',5)],gap:null});assert.equal(result.events[0].delivery,'backfill');assert.equal(result.state.recovering,true);
 const resumed=recoverPage({...state,recovering:true},{epoch:'E',nextCursor:6,latestSequence:6,caughtUp:true,events:[event('six',6)],gap:null});assert.equal(resumed.events[0].delivery,'backfill');assert.equal(resumed.state.recovering,false);
 const replaced=recoverPage(state,{epoch:'N',nextCursor:1,latestSequence:1,caughtUp:true,events:[event('one',1)],gap:{reason:'journal-changed'}});assert.equal(replaced.events[0].delivery,'backfill');assert.equal(replaced.events[0].id,'one');assert.equal(replaced.state.epoch,'N');assert.equal(replaced.gap.reason,'journal-changed');
});
