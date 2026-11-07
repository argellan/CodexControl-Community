// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {projectFlowPlane,flowRoute,routePoint} from '../public/activity-map.mjs';

const reference=Date.parse('2026-10-20T10:00:00Z');
const nodes=[{id:'host:source',type:'host',label:'Source',status:'online',eventIds:[]},{id:'worker:source/a',type:'worker',sessionId:'a',hostId:'source',eventIds:[]},{id:'worker:source/b',type:'subagent',sessionId:'b',hostId:'source',parentId:'a',eventIds:[]},{id:'service:command',type:'service',label:'Commands',eventIds:[]},{id:'host:target',type:'host',label:'Target',status:'online',eventIds:[]}];
const journey=(i,worker='worker:source/a',kind='tool')=>({id:'J'+i,kind,from:kind==='job'?'host:target':worker,to:kind==='job'?worker:'service:command',latestAt:reference-i*1000,status:'result recorded',color:'#20cfff',label:'exec',category:'command',records:[{id:'start'+i,at:new Date(reference-i*1000-500).toISOString()},{id:'end'+i,at:new Date(reference-i*1000).toISOString()}],legs:kind==='job'?[{from:'host:target',to:worker,at:reference-i*1000,eventId:'end'+i,direction:'report'}]:[{from:worker,to:'service:command',at:reference-i*1000-500,eventId:'start'+i,direction:'outbound'},{from:'service:command',to:worker,at:reference-i*1000,eventId:'end'+i,direction:'return'}]});
const graph=journeys=>({nodes,journeys,edges:[],recentEventCount:0});

test('observation plane bounds each worker lane but retains selected evidence and accurate omitted counts',()=>{
 const result=projectFlowPlane(graph(Array.from({length:100},(_,i)=>({...journey(i),category:'category'+i}))),{reference,windowMs:60000,selectedJourney:'J90',width:800});
 assert.equal(result.lanes.length,2);assert.equal(result.traces.length,3);assert.ok(result.traces.some(t=>t.journey.id==='J90'));assert.equal(result.hiddenJourneys,97);
});
test('flow lane ordering and geometry are deterministic for source order changes and preserve explicit genealogy',()=>{
 const js=[journey(1),journey(2,'worker:source/b')];
 const a=projectFlowPlane(graph(js),{reference,width:800}),b=projectFlowPlane({...graph([...js].reverse()),nodes:[...nodes].reverse()},{reference,width:800});
 assert.deepEqual(a.lanes.map(l=>[l.node.id,l.y,l.parentId]),b.lanes.map(l=>[l.node.id,l.y,l.parentId]));assert.equal(a.lanes[1].parentId,'worker:source/a');
});
test('density bins use unique source records in the current window, excluding future and retained history',()=>{
 const a=journey(1),b=journey(1),old=journey(100),future=journey(-10);
 const result=projectFlowPlane(graph([a,b,old,future]),{reference,windowMs:60000,width:800});
 assert.equal(result.bins.reduce((n,b)=>n+b.count,0),2);assert.equal(result.uniqueWindowRecords,2);assert.ok(result.traces.find(t=>t.journey.id===old.id)?.historical!==false);
});
test('target reports point from the actual target toward the worker; no dispatch leg is invented',()=>{
 const result=projectFlowPlane(graph([journey(1,'worker:source/a','job')]),{reference,width:800});const trace=result.traces[0];
 assert.equal(trace.endpoint.id,'host:target');assert.equal(trace.journey.legs.length,1);
 const curve=flowRoute(trace,'report',result);assert.ok(routePoint(curve,0)[0]>routePoint(curve,1)[0]);
});
test('paired return routes occupy a distinct path and travel toward their recorded worker',()=>{
 const result=projectFlowPlane(graph([journey(1)]),{reference,width:800});const trace=result.traces[0];
 const outbound=flowRoute(trace,'outbound',result),back=flowRoute(trace,'return',result);
 assert.ok(routePoint(outbound,0)[0]<routePoint(outbound,1)[0]);assert.ok(routePoint(back,0)[0]>routePoint(back,1)[0]);assert.notDeepEqual(routePoint(outbound,.5),routePoint(back,.5));
});
test('quiet historical traces keep their recorded timestamps and are explicitly outside the selected window',()=>{
 const j=journey(500);const result=projectFlowPlane(graph([j]),{reference,windowMs:60000,width:800});
 assert.equal(result.traces[0].historical,true);assert.equal(result.traces[0].journey.latestAt,j.latestAt);assert.equal(result.uniqueWindowRecords,0);
});

test('repeated operations share an endpoint/category channel with truthful counts and unmodified source evidence',()=>{
 const js=Array.from({length:80},(_,i)=>journey(i));const result=projectFlowPlane(graph(js),{reference,width:800});
 assert.equal(result.traces.length,1);assert.equal(result.traces[0].related.length,80);assert.equal(result.traces[0].recordCount,160);assert.equal(result.hiddenJourneys,0);
 assert.equal(result.traces[0].journey.id,'J0');assert.equal(js[79].id,'J79');
});

test('narrow panes preserve a positive interaction span and both identity rails without horizontal stretching',()=>{
 for(const width of [350,381,667,1233])for(const fontSize of [14,16,20]){
  const result=projectFlowPlane(graph([journey(1)]),{reference,width,fontSize});
  assert.ok(result.left>=100);assert.ok(result.right>result.left+70);assert.ok(result.right<width-70);
  for(const direction of ['outbound','return'])for(let t=0;t<=1;t+=.05){const [x]=routePoint(flowRoute(result.traces[0],direction,result),t);assert.ok(x>=result.left-.01&&x<=result.right+.01);}
 }
});
test('presentation limits bound workers and channels while keeping the selected worker visible',()=>{
 const workers=Array.from({length:10},(_,i)=>({id:'worker:source/w'+i,type:'worker',hostId:'source',sessionId:'w'+i,lastAt:reference-i*1000,eventIds:[]}));
 const js=workers.flatMap((w,i)=>Array.from({length:4},(_,k)=>({...journey(i*4+k,w.id),category:'category'+k})));
 const g={...graph(js),nodes:[nodes[0],nodes[3],...workers]},result=projectFlowPlane(g,{reference,maxWorkers:8,maxPerWorker:2,selectedJourney:'J39'});
 assert.equal(result.lanes.length,8);assert.equal(result.traces.length,16);assert.ok(result.lanes.some(l=>l.node.id==='worker:source/w9'));assert.equal(result.hiddenJourneys,24);
 assert.equal(projectFlowPlane(g,{reference,maxWorkers:999,maxPerWorker:999}).lanes.length,6);
 assert.equal(projectFlowPlane(g,{reference,maxWorkers:999,maxPerWorker:999}).traces.length,18);
});
test('host and project grouping rearrange real workers with distinct group headings and no aggregate actors',()=>{
 const workers=[{...nodes[1],project:'Zulu',hostId:'source'},{...nodes[2],project:'Alpha',hostId:'target'}];
 const g={...graph([journey(1),journey(2,nodes[2].id)]),nodes:[nodes[0],nodes[3],nodes[4],...workers]},original=JSON.stringify(g);
 const byHost=projectFlowPlane(g,{reference,grouping:'host'}),byProject=projectFlowPlane(g,{reference,grouping:'project'});
 assert.deepEqual(byHost.groups.map(g=>g.label),['Source','Target']);assert.deepEqual(byProject.groups.map(g=>g.label),['Alpha','Zulu']);
 assert.equal(byProject.lanes[0].node.id,nodes[2].id);assert.equal(byProject.lanes.length,2);assert.ok(byProject.height>projectFlowPlane(g,{reference}).height);assert.equal(JSON.stringify(g),original);
});
test('plane visibility and compact labels change presentation while preserving source evidence and records',()=>{
 const g=graph([journey(1)]),original=JSON.stringify(g),shown=projectFlowPlane(g,{reference,width:900}),hidden=projectFlowPlane(g,{reference,width:900,showHosts:false,density:false,showTools:false,showBranches:false,labels:'compact'});
 assert.equal(hidden.hosts.length,0);assert.equal(hidden.showTools,false);assert.equal(hidden.showBranches,false);assert.equal(hidden.density,false);assert.equal(hidden.labels,'compact');assert.ok(hidden.top<shown.top);assert.ok(hidden.right>shown.right);
 assert.equal(hidden.traces[0].journey,shown.traces[0].journey);assert.equal(hidden.uniqueWindowRecords,shown.uniqueWindowRecords);assert.equal(JSON.stringify(g),original);
});
test('validated category colors affect only projected ribbons and density with truthful failure and return semantics',()=>{
 const j=journey(1),g=graph([j]),original=JSON.stringify(g),result=projectFlowPlane(g,{reference,colors:{command:'#123456',resolution:'#abcdef',error:'#fedcba',unknown:'#000000'}});
 assert.equal(result.traces[0].color,'#123456');assert.equal(result.traces[0].returnColor,'#abcdef');assert.ok(result.bins.some(b=>b.colors.has('#123456')));assert.equal(JSON.stringify(g),original);
 const failed=projectFlowPlane(graph([{...j,status:'failed'}]),{reference,colors:{command:'#123456',error:'#fedcba'}});assert.equal(failed.traces[0].color,'#fedcba');
 assert.equal(projectFlowPlane(g,{reference,colors:{command:'url(evil)'}}).traces[0].color,j.color);
});


test('compatibility flow projection bounds same-channel members without losing old selection or exact records',()=>{
 const js=Array.from({length:5000},(_,i)=>journey(i)),result=projectFlowPlane(graph(js),{reference,width:800,selectedJourney:'J4999'}),trace=result.traces[0];
 assert.ok(trace.related.length<=128);assert.ok(trace.related.some(j=>j.id==='J4999'));assert.equal(trace.journey.id,'J4999');
 assert.equal(trace.channelJourneyCount,5000);assert.equal(trace.recordCount,10000);assert.equal(trace.hiddenJourneyCount,5000-trace.related.length);
 assert.equal(result.hiddenJourneys,5000-trace.related.length);assert.equal(js[4999].records.length,2);
});
