// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';import assert from 'node:assert/strict';import {CapturedSpanCache} from '../public/span-cache.mjs';import {buildSpans} from '../public/event-model.mjs';
const now=Date.parse('2026-10-24T12:00:00Z'),event=(id,kind,offset,extra={})=>Object.freeze({id,hostId:'host',sourceId:'source',sessionId:'worker',turnId:'turn',callId:'call',kind,at:new Date(now+offset).toISOString(),label:id,category:'command',...extra});
function project(cache,events,reference,observations={}){const iterator=cache.project(events,reference,observations);let step;do{step=iterator.next();}while(!step.done);assert.deepEqual(step.value,buildSpans(events,reference,observations));return step.value;}
test('captured span cache matches full projection across appends, open clocks, future eligibility, replay and eviction',()=>{
 const cache=new CapturedSpanCache(),a=event('start','tool.start',-1000),b=event('end','tool.end',0),orphan=event('orphan','tool.end',-2000,{callId:'orphan'}),future=event('future','tool.start',1000,{callId:'future'});let records=[a,orphan,future];project(cache,records,now,{'host/worker':now-500});project(cache,records,now+500,{'host/worker':now});project(cache,records,now+1000);records=[...records,b];const closed=project(cache,records,now+1500);const next=project(cache,[...records,event('other','tool.start',1200,{callId:'other'})],now+2000);assert.equal(next.find(s=>s.id==='start'),closed.find(s=>s.id==='start'));project(cache,records,now-500);project(cache,[orphan,b],now);project(cache,[event('replacement','operation',0,{startedAt:new Date(now-20).toISOString(),completedAt:new Date(now).toISOString()})],now);
});
test('same call IDs stay isolated by source, host and turn; out-of-order appends preserve source semantics',()=>{
 const cache=new CapturedSpanCache();let records=[event('a','tool.start',-100),event('b','remote.start',-50,{hostId:'other'}),event('c','tool.end',0,{turnId:'other'}),event('d','tool.end',-10)];project(cache,records,now);records=[...records,event('e','tool.start',-200),event('f','remote.end',0,{hostId:'other'})];project(cache,records,now);project(cache,[...records,event('g','tool.end',-300)],now);
});
test('cancelling staged preparation cannot publish a partially changed cache',()=>{
 const cache=new CapturedSpanCache(),initial=[event('a','tool.start',-100),event('b','tool.end',0)];const first=project(cache,initial,now),many=[...initial,...Array.from({length:1200},(_,i)=>event('more'+i,'tool.start',0,{callId:'more'+i}))];const iterator=cache.project(many,now);assert.equal(iterator.next().done,false);iterator.return();assert.equal(cache.events.length,2);assert.equal(project(cache,initial,now)[0],first[0]);assert.equal(project(cache,many,now).length,1201);
});
