// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
const activity=await import('../public/worker-activity.mjs').catch(()=>({}));
const reference=Date.parse('2026-10-20T18:00:00Z');
const node={id:'worker:source/parent',type:'worker',hostId:'source',sessionId:'parent',project:'Alpha',lastAt:reference-1000,lastLabel:'exec · result recorded',status:'waiting for input'};
const event=(id,kind,offset=-1000,extra={})=>({id,kind,at:new Date(reference+offset).toISOString(),hostId:'source',sourceId:'native',sessionId:'parent',turnId:'turn',callId:id,label:'exec',...extra});
const observe=(records=[],extra={},worker=node,graphExtra={})=>{
 assert.equal(typeof activity.workerActivity,'function');
 return activity.workerActivity(worker,{records,journeys:[],nodes:[],...graphExtra},{reference,windowMs:60000,...extra});
};
const route=(value,extra={})=>{
 assert.equal(typeof activity.routeObservation,'function');
 return activity.routeObservation(value,{reference,windowMs:60000,...extra});
};

test('a generic orchestration result describes an observed tool batch without asserting a current running task',()=>{
 const value=observe([event('result','tool.end',-1000,{label:'exec · result recorded'})]);
 assert.equal(value.action,'Tool batch');assert.equal(value.eventId,'result');assert.equal(value.actionAt,reference-1000);assert.equal(value.status,'observed');assert.match(value.label,/result.*recorded/i);assert.equal(value.source,'observed');assert.equal(value.isRecent,true);
 assert.doesNotMatch(value.label+' '+value.action,/running|executing|in progress/i);
});

test('new completion evidence supersedes stale map waiting state and older requests',()=>{
 const records=[event('ask','approval',-20000,{requestId:'R',label:'Input requested'}),event('answer','resolution',-15000,{requestId:'R',label:'Request resolution recorded'}),event('done','complete',-1000,{label:'Turn completed · acceptance unverified'})];
 const value=observe(records);assert.equal(value.status,'completed');assert.equal(value.eventId,'done');assert.match(value.label,/completed.*unverified/i);assert.doesNotMatch(value.label,/input requested/i);
});

test('final answers are captured unverified outcomes and a later new call starts a new observed cycle',()=>{
 const complete=event('final','message',-2000,{label:'Final answer recorded · acceptance unverified'}),value=observe([complete]);
 assert.equal(value.status,'completed');assert.match(value.label,/final.*recorded.*unverified/i);
 const next=observe([complete,event('new-call','tool.start',-1000,{label:'read_file'})]);assert.equal(next.status,'observed');assert.equal(next.action,'Reading files');assert.equal(next.eventId,'new-call');assert.doesNotMatch(next.label,/completed/i);
});

test('request resolution preserves complete host source session turn and request identity',()=>{
 const ask=event('ask','approval',-3000,{requestId:'R',label:'Input requested'});
 for(const patch of [{sourceId:'other'},{sessionId:'child'},{turnId:'other'},{hostId:'other'}]){
  const value=observe([ask,event('wrong','resolution',-2000,{requestId:'R',label:'Request resolution recorded',...patch})]);assert.equal(value.status,'waiting');assert.equal(value.eventId,'ask');
 }
 const resolved=observe([ask,event('resolved','resolution',-1000,{requestId:'R',label:'Request resolution recorded'})]);assert.equal(resolved.status,'observed');assert.match(resolved.label,/resolution.*recorded/i);
});

test('a delayed resolution of an older request does not replace a newer completed turn',()=>{
 const value=observe([event('ask','approval',-8000,{requestId:'R',label:'Input requested'}),event('done','complete',-3000,{label:'Turn completed · acceptance unverified'}),event('late-resolution','resolution',-1000,{requestId:'R',label:'Request resolution recorded'})]);
 assert.equal(value.status,'completed');assert.equal(value.eventId,'done');assert.match(value.label,/completed/i);
});

test('future source records and future node fallback metadata are unavailable at the selected clock',()=>{
 const value=observe([event('future','complete',5000,{label:'FUTURE_PRIVATE_LABEL'})],{}, {...node,lastAt:reference+5000,lastLabel:'FUTURE_PRIVATE_LABEL',eventIds:['future']});
 assert.equal(value.source,'unavailable');assert.equal(value.actionAt,null);assert.equal(value.eventId,null);assert.equal(value.isRecent,false);assert.ok(!JSON.stringify(value).includes('FUTURE_PRIVATE_LABEL'));
});

test('worker activity never leaks another machine session or explicitly restricted source',()=>{
 const own={...node,sourceId:'native',lastAt:null,lastLabel:null};
 const value=observe([event('other-host','tool.start',-100,{hostId:'other',label:'FOREIGN_HOST'}),event('other-session','tool.start',-100,{sessionId:'child',label:'FOREIGN_SESSION'}),event('other-source','tool.start',-100,{sourceId:'other',label:'FOREIGN_SOURCE'}),event('own','tool.end',-2000,{label:'apply_patch · result recorded'})],{},own);
 assert.equal(value.eventId,'own');assert.equal(value.action,'Editing files');assert.ok(!JSON.stringify(value).includes('FOREIGN_'));
});

test('execution job reports require the exact worker binding and describe target reports rather than dispatch',()=>{
 const target=event('job','remote.progress',-500,{hostId:'target',sessionId:'job',workerHostId:'source',workerSessionId:'parent',jobId:'J',label:'Artifact checks',progress:40});
 const value=observe([target]);assert.equal(value.source,'observed');assert.equal(value.action,'Artifact checks');assert.equal(value.status,'reported');assert.match(value.label,/target.*report/i);assert.doesNotMatch(value.label,/dispatch|running|completed turn/i);
 const unavailable={...node,lastAt:null,lastLabel:null};for(const workerHostId of [null,'other'])assert.equal(observe([{...target,workerHostId}],{},unavailable).source,'unavailable');
 const wrong=observe([{...target,workerSessionId:'child'}],{},unavailable);assert.equal(wrong.source,'unavailable');
});

test('known tool identities have meaningful names while arbitrary command text is never parsed into a destination',()=>{
 for(const [name,want] of [['exec_command','Command call'],['functions.exec','Tool batch'],['apply_patch','Editing files'],['read_file','Reading files'],['search_query','Searching sources'],['mcp__cua_repl.js','Browser tools']])assert.equal(observe([event('call','tool.start',-1000,{label:name})]).action,want);
 const value=observe([event('call','tool.start',-1000,{label:'exec curl https://github.example/secret'})]);assert.equal(value.action,'exec curl https://github.example/secret');assert.doesNotMatch(value.action,/GitHub connector|Command call/);
});

test('enriched action labels are admitted only with the matching record clock and identity',()=>{
 const record=event('call','tool.start',-1000,{label:'exec'}),worker={...node,lastAt:reference-1000,eventIds:['call'],activityAt:reference-1000,activityLabel:'Checking release artifacts'};
 assert.equal(observe([record],{},worker).action,'Checking release artifacts');
 assert.equal(observe([record],{}, {...worker,activityAt:reference+5000,activityLabel:'FUTURE_ACTION'}).action,'Tool batch');
});

test('old starts without matching results are unconfirmed and retained records remain explicitly historical',()=>{
 const open=observe([event('start','tool.start',-30000)]);assert.equal(open.status,'unconfirmed');assert.match(open.label,/no captured result/i);assert.doesNotMatch(open.label,/running/i);
 const old=observe([event('result','tool.end',-120000)]);assert.equal(old.kind,'retained');assert.equal(old.isRecent,false);assert.match(old.label,/retained/i);
});

test('live feed gaps preserve inspectable observed action while current state becomes unknown',()=>{
 const records=[event('result','tool.end')],value=observe(records,{observationGap:true});assert.equal(value.source,'observed');assert.equal(value.eventId,'result');assert.equal(value.status,'unknown');assert.equal(value.kind,'unknown');assert.match(value.label,/feed unknown/i);
 const unavailable=observe(records,{},node,{nodes:[{id:'host:source',type:'host',status:'disconnected'}]});assert.equal(unavailable.kind,'unknown');assert.match(unavailable.label,/source unavailable/i);
});

test('replay qualifies historical state and never consumes later live records or unqualified node state',()=>{
 const value=observe([event('record','tool.end',-1000),event('future','complete',2000,{label:'FUTURE'})],{mode:'replay'});assert.equal(value.kind,'replay');assert.match(value.label,/captured/i);assert.equal(value.eventId,'record');assert.ok(!JSON.stringify(value).includes('FUTURE'));
});

test('actual last-event metadata provides lifecycle when journeys contain only an older result',()=>{
 const result=event('result','tool.end',-5000),complete=event('done','complete',-1000,{label:'Turn completed · acceptance unverified'}),worker={...node,lastEvent:complete};
 const value=observe([],{},worker,{journeys:[{from:node.id,to:'service:command',records:[result]}]});assert.equal(value.eventId,'done');assert.equal(value.status,'completed');
});

test('missing captures and invalid clocks do not turn generic node status into active work',()=>{
 const value=observe([],{}, {...node,lastAt:null,lastLabel:null,status:'running'});assert.equal(value.source,'unavailable');assert.equal(value.kind,'unknown');assert.doesNotMatch(value.label,/running/i);
 const invalid=observe([event('bad','tool.start',-1000,{at:'invalid'})],{}, {...node,lastAt:null,lastLabel:null});assert.equal(invalid.eventId,null);
});

test('route metadata stays a relationship in replay and feed outages',()=>{
 for(const extra of [{},{mode:'replay'},{observationGap:true}]){const value=route({metadata:true,kind:'parent',latestAt:reference-1000},extra);assert.equal(value.state,'relationship');assert.match(value.label,/relationship/i);assert.doesNotMatch(value.label,/live|recent/i);}
});

test('route record age separates recently observed links from retained paths without asserting live execution',()=>{
 const recent=route({kind:'outbound',latestAt:reference-1000,legs:[{leg:{at:reference-1000}}]});assert.equal(recent.state,'recent');assert.equal(recent.label,'RECENT');assert.match(recent.detail,/record|captur/i);
 const retained=route({kind:'return',latestAt:reference-120000,legs:[{leg:{at:reference-120000}}]});assert.equal(retained.state,'retained');assert.equal(retained.label,'RETAINED');
 assert.equal(route({kind:'return',legs:[{leg:{at:reference-60000}}]}).state,'recent');
 assert.equal(route({kind:'return',latestAt:reference-1000}).state,'unknown');
});

test('replay routes and live feed loss remain explicitly qualified rather than current traffic',()=>{
 const value={kind:'return',latestAt:reference-1000,legs:[{leg:{at:reference-1000}}]};assert.equal(route(value,{mode:'replay'}).state,'replay');assert.equal(route(value,{mode:'replay'}).label,'REPLAY');assert.equal(route(value,{observationGap:true}).state,'unknown');assert.equal(route({kind:'return'},{mode:'replay'}).state,'replay');
 assert.equal(route({kind:'return',latestAt:reference+1000}).state,'unknown');assert.equal(route({kind:'return'}).state,'unknown');
});

test('a new result on the shared journey cannot refresh an older outbound route',()=>{
 const old=event('start','tool.start',-120000),fresh=event('result','tool.end',-1000);
 const value=route({kind:'outbound',eventIds:['start'],legs:[{leg:{eventId:'start',at:reference-120000}}],related:[{records:[old,fresh]}]});assert.equal(value.state,'retained');
 const result=route({kind:'return',eventIds:['result'],legs:[{leg:{eventId:'result',at:reference-1000}}],related:[{records:[old,fresh]}]});assert.equal(result.state,'recent');
});

test('native assignment title stays distinct from the latest observed action',()=>{
 const value=observe([event('end','tool.end')],{}, {...node,taskLabel:'Release artifact review',taskLabelSource:'native-thread-name'});
 assert.equal(value.action,'Tool batch');assert.equal(value.taskLabel,'Release artifact review');assert.equal(value.taskLabelSource,'native-thread-name');
});

test('an operation completion cannot refresh the same record outbound leg before the recent window',()=>{
 const operation=event('paired','operation',-1000);
 const outbound={kind:'outbound',eventIds:['paired'],legs:[{leg:{eventId:'paired',at:reference-120000}}],related:[{records:[operation]}]};
 assert.equal(route(outbound).state,'retained');
 assert.equal(route({...outbound,kind:'return',legs:[{leg:{eventId:'paired',at:reference-1000}}]}).state,'recent');
 assert.equal(route({...outbound,legs:[{leg:{eventId:'paired',at:reference+1000}}]}).state,'unknown');
});

test('later worker activity does not clear an unresolved input request',()=>{
 const request=event('input','approval',-3000,{requestId:'r1'});
 for(const later of [event('message','message',-1000,{label:'Agent message recorded'}),event('result','tool.end'),event('remote','remote.progress',-1000,{workerHostId:node.hostId,workerSessionId:node.sessionId})]){
  const value=observe([request,later]);assert.equal(value.status,'waiting');assert.match(value.label,/input requested/i);assert.equal(value.eventId,later.id);
 }
 assert.equal(observe([request,event('resolved','resolution',-1000,{requestId:'r1'})]).status,'observed');
});

test('replay admits assignment titles only when their native metadata update timestamp is valid and already captured',()=>{
 const records=[event('end','tool.end')],worker={...node,taskLabel:'PRIVATE_FUTURE_TASK',taskLabelSource:'native-thread-name'};
 for(const taskLabelUpdatedAt of [undefined,'invalid',new Date(reference+1000).toISOString()]){const value=observe(records,{mode:'replay'},{...worker,taskLabelUpdatedAt});assert.equal(value.taskLabel,null);assert.equal(value.taskLabelSource,null);assert.ok(!JSON.stringify(value).includes('PRIVATE_FUTURE_TASK'));}
 const value=observe(records,{mode:'replay'},{...worker,taskLabel:'Captured assignment',taskLabelUpdatedAt:new Date(reference-2000).toISOString()});assert.equal(value.taskLabel,'Captured assignment');assert.equal(value.taskLabelUpdatedAt,new Date(reference-2000).toISOString());
});

test('retained string clocks are reused without freezing replay expiry source state or changed timestamps',()=>{
 const records=[event('cached-start','tool.start',-2000),event('cached-end','tool.end',-1000)],parse=Date.parse;let calls=0;
 Date.parse=function(value){calls++;assert.equal(this,Date);return parse.call(this,value);};
 try{
  assert.equal(observe(records).eventId,'cached-end');assert.equal(calls,2);calls=0;
  assert.equal(observe(records,{reference:reference+60000}).kind,'retained');
  assert.equal(observe(records,{mode:'replay',reference:reference-1500}).eventId,'cached-start');
  assert.equal(observe(records,{reference:reference+15000}).eventId,'cached-end');
  assert.equal(observe(records,{observationGap:true}).kind,'unknown');
  assert.equal(observe(records,{},node,{nodes:[{id:'host:source',type:'host',status:'offline'}]}).kind,'unknown');
  assert.equal(calls,0,'Only source clocks are retained; every current state still uses its reference and health');
  records[1].at='invalid';assert.equal(observe(records).eventId,'cached-start');assert.equal(calls,1);calls=0;
  assert.equal(observe(records).eventId,'cached-start');assert.equal(calls,0,'Invalid string clocks also have mutation-checked entries');
  records[1].at=new Date(reference+1).toISOString();assert.equal(observe(records).eventId,'cached-start');assert.equal(calls,1);calls=0;
  records[1].at=new Date(reference-500).toISOString();assert.equal(observe(records).eventId,'cached-end');assert.equal(calls,1);
 }finally{Date.parse=parse;}
});

test('worker source clock reads preserve timestamp before parser order and never cache accessors or inherited values',()=>{
 const parseDescriptor=Object.getOwnPropertyDescriptor(Date,'parse'),parse=Date.parse,at=new Date(reference-1000).toISOString();
 for(const inherited of [false,true]){
  const log=[],record=event('accessor','tool.end');delete record.at;
  const owner=inherited?Object.create(Object.getPrototypeOf(record)):record;
  Object.defineProperty(owner,'at',{get(){log.push('at');return at;},configurable:true});if(inherited)Object.setPrototypeOf(record,owner);
  Object.defineProperty(Date,'parse',{configurable:true,get(){log.push('parse');return function(value){log.push('call');assert.equal(this,Date);return parse.call(this,value);};}});
  try{assert.equal(observe([record]).eventId,'accessor');assert.deepEqual(log,['at','parse','call','at','parse','call']);}
  finally{Object.defineProperty(Date,'parse',parseDescriptor);}
 }
});

test('worker clock reuse preserves numeric and empty values and invalidates when Date.parse changes',()=>{
 const own={...node,lastAt:null,lastLabel:null},parse=Date.parse,record=event('clock','tool.end');let calls=0;
 Date.parse=function(value){calls++;return parse.call(this,value);};
 try{
  for(const at of [null,undefined,'',NaN,Infinity]){record.at=at;assert.equal(observe([record],{},own).eventId,null);}
  record.at=reference-1000;assert.equal(observe([record],{},own).actionAt,reference-1000);assert.equal(calls,0);
  record.at=new Date(reference-1000).toISOString();assert.equal(observe([record],{},own).eventId,'clock');assert.equal(calls,1);
  Date.parse=function(value){calls++;assert.equal(this,Date);return parse.call(this,value)+2000;};
  assert.equal(observe([record],{},own).eventId,null);assert.equal(calls,2,'A replacement parser cannot reuse the previous parsed clock');
  Date.parse=function(value){calls++;return parse.call(this,value);};assert.equal(observe([record],{},own).eventId,'clock');assert.equal(calls,3);
 }finally{Date.parse=parse;}
});
