// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {eventTime,canonicalEvents,visibleEvents,buildSpans,buildSpanStages,EventStore} from '../public/event-model.mjs';
const NOW=Date.parse('2026-10-20T12:00:00Z'),at=offset=>new Date(NOW+offset).toISOString();
const outcome=fn=>{try{return {value:fn()};}catch(error){return {error:error.name,message:error.message};}};

test('stable own string clocks parse once, including NaN, and invalidate after mutation or parser replacement',()=>{
 const original=Date.parse;let parses=0;Date.parse=value=>{parses++;return original(value);};
 try{
  const event={at:at(0)};assert.equal(eventTime(event),NOW);assert.equal(eventTime(event),NOW);assert.equal(parses,1);
  event.at=at(1000);assert.equal(eventTime(event),NOW+1000);assert.equal(eventTime(event),NOW+1000);assert.equal(parses,2);
  event.at='invalid-source-clock';assert.ok(Number.isNaN(eventTime(event)));assert.ok(Number.isNaN(eventTime(event)));assert.equal(parses,3);
  event.at=at(0);assert.equal(eventTime(event),NOW);Date.parse=value=>original(value)+1;assert.equal(eventTime(event),NOW+1);
 }finally{Date.parse=original;}
});

test('primitive events and nonstring/coercible clock values retain raw Date.parse results and failures',()=>{
 for(const event of [null,undefined,0,false,'text',Symbol('event'),1n,()=>{}])assert.deepEqual(outcome(()=>eventTime(event)),outcome(()=>Date.parse(event.at)));
 for(const value of [undefined,null,0,1,false,true,NaN,Infinity,1n,Symbol('clock'),new String(at(0)),new Date(NOW),{toString:()=>at(0)}]){const event={at:value};assert.deepEqual(outcome(()=>eventTime(event)),outcome(()=>Date.parse(event.at)));assert.deepEqual(outcome(()=>eventTime(event)),outcome(()=>Date.parse(event.at)));}
 let coercions=0;const event={at:{toString(){return at(coercions++*1000);}}};assert.equal(eventTime(event),NOW);assert.equal(eventTime(event),NOW+1000);assert.equal(coercions,2);
 const date=new Date(NOW),dated={at:date};assert.equal(eventTime(dated),Date.parse(date));date.setTime(NOW+2000);assert.equal(eventTime(dated),Date.parse(date));
});

test('own/inherited accessors remain observable and data-to-accessor changes bypass prior cached clocks',()=>{
 const original=Date.parse;let parses=0,reads=0;Date.parse=value=>{parses++;return original(value);};
 try{
  const getter=()=>{reads++;return at(0);},own=Object.defineProperty({},'at',{configurable:true,get:getter}),inherited=Object.create(Object.defineProperty({},'at',{get:getter}));
  for(const event of [own,inherited]){assert.equal(eventTime(event),NOW);assert.equal(eventTime(event),NOW);}assert.equal(reads,4);assert.equal(parses,4);
  const mutable={at:at(0)};assert.equal(eventTime(mutable),NOW);assert.equal(eventTime(mutable),NOW);Object.defineProperty(mutable,'at',{get:getter,configurable:true});assert.equal(eventTime(mutable),NOW);assert.equal(eventTime(mutable),NOW);assert.equal(parses,7);assert.equal(reads,6);
  const inheritedData=Object.create({at:at(0)});eventTime(inheritedData);eventTime(inheritedData);assert.equal(parses,9);
  const throwing=Object.defineProperty({},'at',{get(){throw new RangeError('TEST_ONLY getter failure');}});assert.deepEqual(outcome(()=>eventTime(throwing)),outcome(()=>Date.parse(throwing.at)));
 }finally{Date.parse=original;}
});

test('refused proxy reflection falls back to the already-read raw value without introducing a failure',()=>{
 let reads=0;const event=new Proxy({at:at(0)},{get(target,key){if(key==='at')reads++;return target[key];},getOwnPropertyDescriptor(){throw new Error('TEST_ONLY reflection refused');}});assert.equal(eventTime(event),NOW);assert.equal(eventTime(event),NOW);assert.equal(reads,2);
});

test('direct parser receiver and accessor evaluation order are retained',()=>{
 const original=Date.parse;
 try{
  Date.parse=function(value){assert.equal(this,Date);return original(value);};assert.equal(eventTime({at:at(0)}),NOW);assert.equal(eventTime({at:0}),original(0));
  Date.parse=function(){assert.equal(this,Date);return 17;};const event=Object.defineProperty({},'at',{get(){Date.parse=()=>23;return at(0);}});assert.equal(eventTime(event),17);assert.equal(eventTime(event),23);
 }finally{Date.parse=original;}
});

test('future eligibility, window edges, mutations and replay clocks remain independent of cached timestamps',()=>{
 const records=canonicalEvents([{id:'start',sessionId:'s',hostId:'h',sourceId:'src',turnId:'t',callId:'c',kind:'tool.start',at:at(0),label:'Call'}, {id:'end',sessionId:'s',hostId:'h',sourceId:'src',turnId:'t',callId:'c',kind:'tool.end',at:at(1000),label:'Result'}]);
 assert.deepEqual(visibleEvents(records,NOW,1000).map(e=>e.id),['start']);assert.deepEqual(visibleEvents(records,NOW+1000,1000).map(e=>e.id),['start','end']);assert.deepEqual(visibleEvents(records,NOW-1,1000),[]);assert.deepEqual(visibleEvents(records,NOW+1001,1000).map(e=>e.id),['end']);
 assert.equal(buildSpans(records,NOW,{'h/s':NOW})[0].status,'open');assert.equal(buildSpans(records,NOW+1000,{'h/s':NOW+1000})[0].durationMs,1000);
 records[1].at=at(2000);assert.equal(buildSpans(records,NOW+1000,{'h/s':NOW+1000})[0].status,'open');assert.equal(buildSpans(records,NOW+2000,{'h/s':NOW+2000})[0].durationMs,2000);
 const store=new EventStore();store.ingest({observedAt:at(2000),events:records,sessions:[{id:'s',hostId:'h'}],hosts:[{id:'h',status:'online'}]});store.enterReplay(NOW,3000);const frozen=store.viewEvents();store.seek(NOW+2000);assert.equal(visibleEvents(frozen,store.clock,3000).length,2);store.seek(NOW);assert.equal(visibleEvents(frozen,store.clock,3000).length,1);
});

test('cooperative span projection preserves every paired source record and can stop between bounded batches',()=>{
 const reference=Date.parse('2026-10-24T12:00:00Z'),records=Array.from({length:5000},(_,i)=>Object.freeze({id:'TEST_ONLY_'+i,hostId:'host',sourceId:'source',sessionId:'worker',turnId:'turn',callId:'call_'+Math.floor(i/2),kind:i%2?'tool.end':'tool.start',at:new Date(reference-10000+i).toISOString(),label:'operation',category:'command'}));
 const iterator=buildSpanStages(records,reference);let step,yields=0;do{step=iterator.next();if(!step.done)yields++;}while(!step.done);assert.equal(step.value.length,2500);assert.ok(yields>=9);for(let i=0;i<2500;i++){const span=step.value[i];assert.equal(span.startEventId,'TEST_ONLY_'+(i*2));assert.equal(span.endEventId,'TEST_ONLY_'+(i*2+1));assert.equal(span.durationMs,1);assert.equal(span.status,'closed');}
 const stopped=buildSpanStages(records,reference);assert.equal(stopped.next().done,false);assert.equal(stopped.return().done,true);assert.equal(stopped.next().done,true);assert.equal(records.length,5000);
});
