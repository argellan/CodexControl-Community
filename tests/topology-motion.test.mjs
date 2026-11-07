// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';

const motion=await import('../public/topology-motion.mjs').catch(()=>({}));
const reference=Date.parse('2026-10-20T10:00:00Z');
const outbound={from:'worker:source/a',to:'service:command',eventId:'operation',direction:'outbound',at:reference-2000};
const returning={from:'service:command',to:'worker:source/a',eventId:'operation',direction:'return',at:reference-1000};
const operation={kind:'operation',legs:[outbound,returning]};
const live={mode:'live',freshIds:new Set(['operation']),arrivalTimes:new Map([['operation',reference]])};
const progress=(journey,leg,at,options=live)=>{
 assert.equal(typeof motion.topologyLegProgress,'function');
 return motion.topologyLegProgress({journey,leg},at,options);
};
const state=(node,options={})=>{
 assert.equal(typeof motion.topologyObservationState,'function');
 return motion.topologyObservationState(node,{reference,...options});
};

test('one live operation observation traverses outbound before its shared-record return',()=>{
 for(const [elapsed,wantOut,wantReturn] of [[0,0,null],[600,.5,null],[1199,1199/1200,null],[1200,null,0],[1800,null,.5],[2399,null,1199/1200],[2400,null,null]]){
  assert.equal(progress(operation,outbound,reference+elapsed),wantOut);
  assert.equal(progress(operation,returning,reference+elapsed),wantReturn);
 }
});

test('distinct call-start and result records keep their own independent live arrival times',()=>{
 const start={...outbound,eventId:'start'},end={...returning,eventId:'end'},journey={kind:'tool',legs:[start,end]};
 const options={mode:'live',freshIds:new Set(['start','end']),arrivalTimes:new Map([['start',reference-600],['end',reference-120]])};
 assert.equal(progress(journey,start,reference,options),.25);
 assert.equal(progress(journey,end,reference,options),.05);
});

test('a result-only operation uses the full return route without fabricating an outbound stage',()=>{
 const journey={kind:'operation',legs:[returning]};
 assert.equal(progress(journey,returning,reference+600),.25);
 assert.equal(journey.legs.length,1);
});

test('replay follows each original source timestamp without live half-route staging',()=>{
 const options={mode:'replay',freshIds:new Set(),arrivalTimes:new Map([['operation',reference+50000]])};
 assert.equal(progress(operation,outbound,reference-200,options),.75);
 assert.equal(progress(operation,returning,reference-400,options),.25);
 assert.equal(progress(operation,returning,reference-1001,options),null);
});

test('missing freshness or arrival evidence never invents a live marker',()=>{
 for(const options of [
  {mode:'live',freshIds:new Set(),arrivalTimes:live.arrivalTimes},
  {mode:'live',freshIds:new Set(['operation'])},
  {mode:'live',freshIds:new Set(['operation']),arrivalTimes:new Map()},
  {mode:'live',freshIds:new Set(['operation']),arrivalTimes:new Map([['operation',NaN]])},
  {mode:'live',freshIds:['operation'],arrivalTimes:live.arrivalTimes},
  {mode:'live',freshIds:new Set(['operation']),arrivalTimes:{operation:reference}},
 ])assert.equal(progress(operation,outbound,reference+100,options),null);
 assert.equal(progress(operation,outbound,reference-1),null);
 assert.equal(progress(operation,outbound,reference+2400),null);
 // A duplicate snapshot has no newly admitted record, even at the old arrival clock.
 assert.equal(progress(operation,outbound,reference+100,{...live,freshIds:new Set()}),null);
});

test('invalid leg clocks or modes do not return NaN or synthetic progress',()=>{
 for(const leg of [{...returning,at:NaN},{...returning,at:undefined},null])assert.equal(progress(operation,leg,reference,{mode:'replay'}),null);
 assert.equal(progress(operation,returning,NaN,{mode:'replay'}),null);
 assert.equal(progress(operation,returning,reference,{...live,mode:'unknown'}),null);
});

test('host connectivity describes collector evidence while replay and observation gaps remain unknown',()=>{
 const host={type:'host',status:'online',lastAt:reference-100};
 assert.equal(state(host).kind,'online');
 assert.match(state(host).label,/collector/i);
 for(const options of [{mode:'replay'},{observationGap:true}]){
  const value=state(host,options);assert.equal(value.kind,'unknown');assert.equal(value.label,options.mode==='replay'?'Captured source':'Feed unknown');
 }
 assert.equal(state({...host,status:'disconnected'}).kind,'offline');
 assert.equal(state({...host,status:'historical / unknown'}).kind,'unknown');
});

test('worker result states qualify recorded observations rather than asserting running work',()=>{
 const worker={type:'worker',status:'result recorded',lastAt:reference-1000};
 const recent=state(worker);assert.equal(recent.kind,'recent');assert.match(recent.label,/result.*recorded/i);
 const retained=state({...worker,lastAt:reference-60000});assert.equal(retained.kind,'retained');assert.match(retained.label,/result.*recorded/i);
 assert.equal(state({...worker,status:'start observed',lastAt:reference-60000}).kind,'unknown');
 assert.match(state({...worker,status:'start observed',lastAt:reference-60000}).label,/no captured result/i);
 assert.equal(state(worker,{observationGap:true}).kind,'unknown');
 for(const value of [recent,retained,state({...worker,status:'start observed'})])assert.doesNotMatch(value.label,/running/i);
});

test('input requests and recorded failures receive explicit attention independently of color',()=>{
 assert.equal(state({type:'human',status:'waiting for input',lastAt:reference-1000}).kind,'attention');
 assert.match(state({type:'human',status:'waiting for input'}).label,/input/i);
 assert.equal(state({type:'subagent',status:'failed',lastAt:reference-1000}).kind,'attention');
 assert.match(state({type:'subagent',status:'failed'}).label,/recorded/i);
 assert.equal(state({type:'worker',status:'recent record'}).kind,'unknown');
});
