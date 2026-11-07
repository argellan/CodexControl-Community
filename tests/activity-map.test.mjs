// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleEvents,buildSpans} from '../public/event-model.mjs';
const map=await import('../public/activity-map-model.mjs').catch(()=>({}));
const renderer=await import('../public/activity-map.mjs').catch(()=>({}));
const now=Date.parse('2026-10-20T06:00:00Z');
const hosts=[{id:'laptop',name:'Lenovo',role:'codex-source',status:'online',deviceClass:'laptop'},{id:'pi',name:'Execution Pi',role:'execution-target',status:'online',deviceClass:'raspberry-pi'}];
const sessions=[{id:'parent',hostId:'laptop',project:'Control'},{id:'child',hostId:'laptop',project:'Control',parentId:'parent',nickname:'Volta'}];
const e=(id,kind,seconds,extra={})=>({id,kind,at:new Date(now+seconds*1000).toISOString(),hostId:'laptop',sourceId:'source',sessionId:'parent',turnId:'turn',category:'command',label:'exec',callId:'C',delivery:'live',...extra});
function project(events,options={}){assert.equal(typeof map.projectActivity,'function');return map.projectActivity({events,hosts,sessions,reference:now,windowMs:60000,...options});}

test('tool journeys have separate outbound and returning legs bound to the complete scoped call identity',()=>{
 const result=project([e('start','tool.start',-8),e('end','tool.end',-2)]);
 const journey=result.journeys.find(j=>j.kind==='tool');assert.equal(journey.status,'result recorded');assert.deepEqual(journey.eventIds,['start','end']);
 assert.equal(journey.legs.length,2);assert.equal(journey.legs[0].from,journey.legs[1].to);assert.equal(journey.legs[0].to,journey.legs[1].from);
 const other=project([e('start','tool.start',-8),e('other-end','tool.end',-2,{sourceId:'other-source'})]);
 assert.equal(other.journeys.filter(j=>j.kind==='tool').length,2);assert.equal(other.journeys.filter(j=>j.status==='result without start').length,1);
});
test('quiet windows retain fleet stations and observed routes without generating new traffic',()=>{
 const result=project([e('start','tool.start',-240),e('end','tool.end',-238)]);
 assert.equal(result.quiet,true);assert.ok(result.nodes.some(n=>n.id==='host:pi'));assert.equal(result.journeys.length,1);assert.equal(result.recentEventCount,0);
 assert.equal(map.packetProgress({at:now-238000},now,'live',new Set(['end']),'end'),null);
});
test('quiet observation planes retain a bounded set of the most recently observed workers with explicitly historical traces',()=>{
 const retained=Array.from({length:12},(_,i)=>({id:'retained-'+i,hostId:'laptop',project:'Control'}));
 const events=retained.flatMap((s,i)=>[e('old-start-'+i,'tool.start',-600-i*60,{sessionId:s.id,callId:s.id}),e('old-end-'+i,'tool.end',-598-i*60,{sessionId:s.id,callId:s.id})]);
 for(const maxWorkers of [6,8]){
  const result=project(events,{sessions:retained,maxWorkers}),workers=result.nodes.filter(n=>['worker','subagent'].includes(n.type));
  assert.equal(workers.length,maxWorkers);assert.equal(result.hiddenWorkers,12-maxWorkers);assert.equal(result.quiet,true);assert.equal(result.recentEventCount,0);
  assert.deepEqual(new Set(workers.map(n=>n.sessionId)),new Set(retained.slice(0,maxWorkers).map(s=>s.id)));
  assert.ok(workers.every(n=>n.recency==='retained'&&n.subtitle.startsWith('Retained / ')));
  const plane=renderer.projectFlowPlane(result,{reference:now,windowMs:60000,width:1000});assert.equal(plane.lanes.length,maxWorkers);assert.ok(plane.traces.every(t=>t.historical));
  for(const j of result.journeys)for(const leg of j.legs)assert.equal(map.packetProgress({...leg,observedAt:now},now,'live',new Set(),leg.eventId),null);
 }
});
test('presentation worker context preference is bounded and project grouping uses explicit source metadata',()=>{
 const retained=Array.from({length:12},(_,i)=>({id:'preference-'+i,hostId:'laptop',project:i%2?'Real alpha':'Real beta'}));
 const events=retained.map((s,i)=>e('preference-event-'+i,'tool.end',-600-i*60,{sessionId:s.id,callId:s.id}));
 const result=project(events,{sessions:retained,preferences:{planeWorkers:8}}),workers=result.nodes.filter(n=>['worker','subagent'].includes(n.type));
 assert.equal(workers.length,8);assert.ok(workers.every(n=>n.project===retained.find(s=>s.id===n.sessionId).project));
 assert.equal(project(events,{sessions:retained,preferences:{planeWorkers:1000}}).nodes.filter(n=>n.type==='worker').length,6);
});
test('recent and focused workers retain priority while older observed workers fill remaining context slots',()=>{
 const retained=Array.from({length:10},(_,i)=>({id:'context-'+i,hostId:'laptop',project:'Control'}));
 const events=retained.map((s,i)=>e('context-event-'+i,'tool.end',i===0?-1:-600-i*60,{sessionId:s.id,callId:s.id}));
 const result=project(events,{sessions:retained,focus:'laptop/context-9',maxWorkers:6}),workers=result.nodes.filter(n=>['worker','subagent'].includes(n.type));
 assert.equal(workers.length,6);assert.ok(workers.some(n=>n.sessionId==='context-0'&&n.recency==='recent'));assert.ok(workers.some(n=>n.sessionId==='context-9'&&n.recency==='retained'));
 assert.deepEqual(new Set(workers.map(n=>n.sessionId)),new Set(['context-0','context-9','context-1','context-2','context-3','context-4']));
});
test('retained context filling respects a narrowed session scope and does not add unrelated workers',()=>{
 const retained=Array.from({length:10},(_,i)=>({id:'scope-'+i,hostId:'laptop',project:'Control'}));
 const events=retained.map((s,i)=>e('scope-event-'+i,'tool.end',-600-i*60,{sessionId:s.id,callId:s.id}));
 const result=project(events,{sessions:retained,focus:'laptop/scope-5',filter:{sessionId:'laptop/scope-5'},maxWorkers:8});
 assert.deepEqual(result.nodes.filter(n=>['worker','subagent'].includes(n.type)).map(n=>n.sessionId),['scope-5']);
});
test('remote job telemetry is a report from the execution host, never a fabricated dispatch or worker acknowledgement',()=>{
 const result=project([e('job','remote.progress',-1,{hostId:'pi',sessionId:'job',category:'remote',workerHostId:'laptop',workerSessionId:'parent',callId:'J',jobId:'J',progress:40})]);
 const journey=result.journeys.find(j=>j.kind==='job');assert.equal(journey.legs[0].from,'host:pi');assert.equal(journey.legs[0].to,'worker:laptop/parent');assert.match(journey.evidence,/explicit worker binding/);assert.equal(journey.progress,40);
 const unbound=project([e('job','remote.start',-1,{hostId:'pi',category:'remote',sessionId:'job',workerSessionId:'parent',workerHostId:null})]);
 assert.equal(unbound.journeys.filter(j=>j.kind==='job').length,0);assert.equal(unbound.unmapped,1);
});
test('focusing a worker preserves its explicitly bound remote jobs in both the map and synchronized timeline',()=>{
 const remote=e('remote','remote.start',-2,{hostId:'pi',sessionId:'remote-job',category:'remote',workerHostId:'laptop',workerSessionId:'parent',jobId:'job'});
 const result=project([remote],{filter:{hostId:'laptop',sessionId:'laptop/parent'}});assert.equal(result.journeys.filter(j=>j.kind==='job').length,1);
 const visible=visibleEvents([remote],now,60000,{hostId:'laptop',sessionHostId:'laptop',sessionId:'parent',includeRelated:true});assert.equal(visible.length,1);
 const span=buildSpans(visible,now)[0];assert.equal(span.workerHostId,'laptop');assert.equal(span.workerSessionId,'parent');
 assert.equal(visibleEvents([remote],now,60000,{hostId:'laptop',sessionHostId:'different-host',sessionId:'parent',includeRelated:true}).length,0);
});
test('agent branches require explicit same-host parent metadata and do not turn genealogy into tool traffic',()=>{
 const result=project([e('child-event','turn',-2,{sessionId:'child',category:'turn'})]);
 const relationship=result.edges.find(edge=>edge.kind==='parent');assert.equal(relationship.from,'worker:laptop/parent');assert.equal(relationship.to,'worker:laptop/child');assert.equal(relationship.eventIds.length,0);
 assert.equal(result.nodes.find(n=>n.id==='worker:laptop/child').type,'subagent');
});
test('replay does not reveal future results or use a captured final job label as historical state',()=>{
 const result=project([e('start','tool.start',-10),e('end','tool.end',20)],{sessions:[...sessions,{id:'job',hostId:'pi',nickname:'Completed later',role:'execution-job'}]});
 assert.equal(result.journeys[0].status,'start observed');assert.deepEqual(result.journeys[0].eventIds,['start']);assert.equal(result.journeys[0].legs.length,1);
 assert.ok(!JSON.stringify(result).includes('Completed later'));
});
test('provider destinations require a tool identity; generic shell labels do not prove a GitHub hop',()=>{
 const generic=project([e('generic','tool.start',-1,{label:'exec github something'})]);assert.ok(!generic.nodes.some(n=>n.id==='service:github'));
 const github=project([e('github','tool.start',-1,{label:'mcp__codex_apps__github__get_pull_request',category:'tool'})]);assert.ok(github.nodes.some(n=>n.id==='service:github'));
});
test('approval paths remain waiting until the matching scoped request resolution is captured',()=>{
 const request=e('ask','approval',-20,{requestId:'R',category:'approval'});
 const waiting=project([request,e('unrelated','resolution',-2,{requestId:'other'})]);assert.equal(waiting.journeys.find(j=>j.kind==='review').status,'waiting for input');
 const resolved=project([request,e('answer','resolution',-1,{requestId:'R'})]);const journey=resolved.journeys.find(j=>j.kind==='review');assert.equal(journey.status,'resolution recorded');assert.equal(journey.legs.length,2);
});
test('unanswered old calls and disconnected sources report uncertainty instead of running forever',()=>{
 const old=project([e('start','tool.start',-120)]);assert.equal(old.journeys[0].status,'no result observed');
 const gap=project([e('start','tool.start',-2)],{hosts:hosts.map(h=>({...h,status:'disconnected'}))});assert.equal(gap.journeys[0].status,'source unavailable');
});
test('packet position uses event time once; polling the same event cannot relaunch it',()=>{
 assert.equal(typeof map.packetProgress,'function');const leg={at:now-500};const fresh=new Set(['event']);
 assert.equal(map.packetProgress(leg,now,'live',new Set(),'event'),null);
 const progress=map.packetProgress(leg,now,'live',fresh,'event');assert.ok(progress>0&&progress<1);assert.equal(map.packetProgress(leg,now+4000,'live',fresh,'event'),null);
 assert.equal(map.packetProgress(leg,now,'replay',new Set(),'event'),progress);
});
test('a newly delivered live record gets one arrival animation despite collection latency; replay still uses source time',()=>{
 const leg={at:now-8000,observedAt:now-100};const fresh=new Set(['arrival']);
 const t=map.packetProgress(leg,now,'live',fresh,'arrival');assert.ok(t>0&&t<.1);
 assert.equal(map.packetProgress(leg,now,'replay',fresh,'arrival'),null);
 assert.equal(map.packetProgress(leg,now+3000,'live',fresh,'arrival'),null);
});
test('crowded fleets bound visible workers, retain actual counts and place stations deterministically',()=>{
 const many=Array.from({length:300},(_,i)=>({id:'worker'+i,hostId:'laptop',project:'Control'}));
 const events=many.map((s,i)=>e('event'+i,'turn',-i,{sessionId:s.id,category:'turn'}));const a=project(events,{sessions:many}),b=project(events.slice().reverse(),{sessions:many.slice().reverse()});
 assert.ok(a.nodes.filter(n=>['worker','subagent'].includes(n.type)).length<=6);assert.equal(a.workerCount,300);assert.ok(a.hiddenWorkers>0);
 assert.deepEqual(a.nodes.map(n=>[n.id,n.x,n.y]),b.nodes.map(n=>[n.id,n.x,n.y]));
});
test('tool routes bypass unrelated fleet station boxes so their geometry cannot imply an invented server hop',()=>{
 assert.equal(typeof renderer.routeCurve,'function');
 for(const width of [640,667,1243])for(const y of [41,78,115,152])for(const returning of [false,true]){
  const worker={x:width*.365,y:97.5},service={x:width*.9,y};
  const curve=renderer.routeCurve(returning?service:worker,returning?worker:service,{from:returning?'service:command':'worker:source',to:returning?'worker:source':'service:command',kind:returning?'return':'outbound'},width,195);
  for(let i=0;i<=200;i++){const [x,y]=renderer.routePoint(curve,i/200);const inFleet=x>width*.65-64&&x<width*.65+64&&y>23&&y<171;assert.equal(inFleet,false,`Unrelated fleet station touched at ${x},${y} on width ${width}`);}
 }
});


test('legacy non-string labels remain untrusted text instead of breaking provider projection',()=>{
 for(const label of [null,false,42,{},[]]){
  const result=project([e('legacy-label','tool.start',-1,{label})]);
  assert.equal(result.journeys[0].label,'Unlabeled operation');
  assert.equal(result.nodes.some(n=>n.id==='service:github'),false);
  assert.equal(map.toolDestination(label).id,'tools');
 }
});

test('large retained channels keep exact source evidence and counts but bound edge identity samples',()=>{
 const events=Array.from({length:20000},(_,i)=>e('bulk-'+i,'operation',-20+i/1000,{callId:'bulk-'+i}));
 const result=project(events,{selectedEvent:'bulk-0'}),edge=result.edges.find(edge=>edge.kind==='return');
 assert.equal(result.records.length,20000);assert.equal(result.journeys.length,20000);assert.equal(result.recentEventCount,20000);
 assert.equal(edge.count,20000);assert.equal(edge.recordCount,20000);assert.equal(edge.journeyCount,20000);
 assert.ok(edge.eventIds.length<=512);assert.ok(edge.journeyIds.length<=128);
 assert.equal(edge.hiddenRecordCount,20000-edge.eventIds.length);assert.equal(edge.hiddenJourneyCount,20000-edge.journeyIds.length);
 assert.ok(edge.eventIds.includes('bulk-0'));assert.ok(edge.journeyIds.includes('operation:bulk-0'));
});


test('cached source clocks invalidate on timestamp mutation and still obey replay, expiry and metadata',()=>{
 const record=e('mutable','tool.start',-8),events=[record];
 assert.equal(project(events).journeys[0].status,'start observed');
 assert.equal(project(events,{reference:now+10000}).journeys[0].status,'no result observed');
 assert.equal(project(events,{reference:now-9000}).journeys.length,0);
 record.at='invalid';assert.equal(project(events).records.length,0);
 record.at=new Date(now+1).toISOString();assert.equal(project(events).records.length,0);
 record.at=new Date(now-8000).toISOString();assert.equal(project(events).records.length,1);
 assert.equal(project(events,{hosts:hosts.map(h=>({...h,status:'offline'}))}).journeys[0].status,'source unavailable');
 assert.equal(project(events,{sessions:sessions.map(s=>({...s,nickname:'Renamed worker'}))}).nodes.find(n=>n.type==='worker').label,'Renamed worker');
 assert.equal(project(events,{reference:now+120000}).quiet,true);
 assert.equal(project(events,{filter:{search:'does-not-match'}}).records.length,0);
 const duplicate={...record,label:'Replacement evidence'};
 assert.equal(project([record,duplicate]).records[0],duplicate);
 assert.equal(project([duplicate,record]).records[0],record);
});

test('warm source-clock cache reparses only changed string timestamps',()=>{
 const records=[e('cached-a','tool.start',-8),e('cached-b','tool.end',-2)];project(records);
 const parse=Date.parse,calls=[];Date.parse=value=>{calls.push(value);return parse(value);};
 try{
  project(records);assert.equal(calls.filter(value=>records.some(r=>r.at===value)).length,0);
  records[0].at=new Date(now-9000).toISOString();project(records);
  assert.equal(calls.filter(value=>value===records[0].at).length,1);
 }finally{Date.parse=parse;}
});

test('filtering precedes last-wins deduplication and keeps the exact accepted source references',()=>{
 const original=e('same','operation',-4,{project:'Control',label:'Original accepted'}),replacement={...original,label:'Last accepted'},other=e('other','operation',-3,{project:'Control'}),outside={...original,project:'Outside'},invalid={...original,at:'invalid'},future={...original,at:new Date(now+1).toISOString()};
 const events=[original,other,replacement,outside,invalid,future],before=JSON.stringify(events),result=project(events,{filter:{project:'Control'},selectedEvent:'same'});
 assert.deepEqual(result.records,[replacement,other]);assert.equal(result.records[0],replacement);assert.equal(result.journeys.find(j=>j.id==='operation:same').records[0],replacement);assert.equal(result.recentEventCount,2);assert.equal(result.journeys.length,2);assert.equal(JSON.stringify(events),before);
 assert.equal(project([replacement,original],{filter:{project:'Control'}}).records[0],original);
 assert.equal(project(events,{filter:{project:'Outside'}}).records[0],outside);
 assert.equal(project(events,{filter:{project:'Control'},reference:now-5000}).records.length,0);
 outside.project='Control';const changed=project(events,{filter:{project:'Control'}});assert.equal(changed.records[0],outside);assert.equal(changed.journeys.find(j=>j.id==='operation:same').label,outside.label);
});

test('record preparation skips holes includes inherited indices and never fills or mutates the input array',()=>{
 const first=e('first','operation',-5),inherited=e('inherited','operation',-4),last=e('last','operation',-3),events=new Array(7),prototype=Object.create(Array.prototype);events[1]=first;events[6]=last;
 Object.defineProperty(prototype,'3',{value:inherited,configurable:true});Object.setPrototypeOf(events,prototype);
 const keys=Reflect.ownKeys(events),descriptors=Object.getOwnPropertyDescriptors(events),result=project(events);
 assert.deepEqual(result,project([first,inherited,last]));assert.deepEqual(result.records,[first,inherited,last]);for(const record of result.records)assert.ok([first,inherited,last].includes(record));
 assert.deepEqual(Reflect.ownKeys(events),keys);assert.deepEqual(Object.getOwnPropertyDescriptors(events),descriptors);assert.equal(Object.getPrototypeOf(events),prototype);assert.equal(0 in events,false);assert.equal(Object.hasOwn(events,'3'),false);assert.equal(events.length,7);
});

test('record preparation snapshots length while observing indices inserted or deleted before their visit',()=>{
 const first=e('first','operation',-5),inserted=e('inserted','operation',-4),deleted=e('deleted','operation',-3),appended=e('appended','operation',-2),events=Object.assign(new Array(3),{0:first,2:deleted});let reads=0;
 Object.defineProperty(events,'0',{configurable:true,get(){reads++;events[1]=inserted;delete events[2];events.push(appended);return first;}});
 const result=project(events);assert.equal(reads,1);assert.deepEqual(result.records,[first,inserted]);assert.equal(result.records.includes(appended),false);assert.equal(result.records.includes(deleted),false);assert.equal(events.length,4);assert.equal(2 in events,false);
});
