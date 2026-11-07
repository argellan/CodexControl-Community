// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {projectRibbon,ribbonLayout,ribbonX,ribbonGapRows} from '../public/event-ribbon.mjs';
const reference=1800000000000,windowMs=60000;
const event=(id,age=1000,extra={})=>({id,hostId:'A',sessionId:'one',sourceId:'source',at:new Date(reference-age).toISOString(),kind:'tool.start',category:'command',label:'Recorded command',...extra});
const project=(events,extra={})=>projectRibbon({events,reference,windowMs,...extra});
test('ribbon conserves every source record while bounding markers and worker lanes',()=>{
 const events=Array.from({length:5000},(_,i)=>event('e'+i,i*11,{sessionId:'w'+i%40,kind:i%7?'tool.start':'error',category:i%3?'command':'edit',outcome:i%7?'recorded':'failed'}));
 const original=JSON.stringify(events),model=project(events,{maxLanes:6,maxMarkers:180,selectedEvent:'e4999'});
 assert.equal(model.total,5000);assert.equal(model.lanes.length,6);assert.ok(model.markers.length<=180);
 assert.equal(model.lanes.reduce((n,l)=>n+l.count,0),5000);assert.equal(model.markers.reduce((n,m)=>n+m.count,0),5000);
 assert.equal(new Set(model.markers.flatMap(m=>m.members)).size,5000);assert.ok(model.lanes.some(l=>l.sourceKey==='A/w39'&&!l.overflow));
 assert.ok(model.markers.some(m=>m.members.includes('e4999')));assert.equal(JSON.stringify(events),original);
});
test('source identity stays host scoped; stable lanes and quiet retained workers do not invent events',()=>{
 const events=[event('a'),event('b',2000,{hostId:'B'})],sessions=[{hostId:'A',id:'one',nickname:'Orion'},{hostId:'B',id:'one',nickname:'Lyra'},{hostId:'C',id:'quiet'}];
 const first=project(events,{sessions}),next=project([...events].reverse(),{sessions,previousOrder:first.order});
 assert.deepEqual(next.order,first.order);assert.equal(next.lanes.length,2);assert.deepEqual(new Set(next.lanes.map(l=>l.label)),new Set(['Orion','Lyra']));
 assert.equal(project([],{sessions}).lanes.length,0);
});
test('future, invalid and expired records never become fresh density; time axis is linear',()=>{
 const model=project([event('old',60001),event('future',-1),event('invalid',0,{at:'bad'}),event('current',0),event('edge',60000)]);
 assert.equal(model.total,2);assert.equal(model.lanes[0].bins.reduce((n,b)=>n+b.count,0),2);
 const layout=ribbonLayout(1000,400,4);assert.equal(ribbonX(reference,reference,windowMs,layout),layout.right);assert.equal(ribbonX(reference-windowMs,reference,windowMs,layout),layout.left);
 assert.equal(ribbonX(reference-30000,reference,windowMs,layout),(layout.right+layout.left)/2);
});
test('capture gaps affect only evidenced sources; global gaps remain explicit',()=>{
 const model=project([event('a'),event('b',1000,{hostId:'B'})]);
 assert.deepEqual(ribbonGapRows({hostId:'A'},model),[0]);assert.deepEqual(ribbonGapRows({hostId:null},model),[0,1]);assert.deepEqual(ribbonGapRows({hostId:'missing'},model),[]);
});
test('failure and input clusters retain their type and selected evidence under burst saturation',()=>{
 const events=Array.from({length:2000},(_,i)=>event('e'+i,i*20));events.push(event('failed',5000,{kind:'error',outcome:'failed'}),event('input',5000,{kind:'approval',category:'approval'}));
 const model=project(events,{selectedEvent:'failed',maxMarkers:40});
 assert.ok(model.markers.find(m=>m.members.includes('failed')).outcome==='failed');assert.ok(model.markers.find(m=>m.members.includes('input')).kind==='approval');
 assert.equal(model.lanes[0].failures,1);assert.equal(model.lanes[0].inputs,1);assert.equal(model.markers.reduce((n,m)=>n+m.count,0),2002);
});
test('overflow source gaps remain source-specific evidence, and layouts stay in bounds',()=>{
 const model=project(Array.from({length:20},(_,i)=>event('e'+i,1000,{hostId:'h'+i,sessionId:'s'+i})),{maxLanes:3});
 const overflow=model.lanes.at(-1);assert.equal(overflow.overflow,true);assert.equal(overflow.sources.length,18);
 assert.deepEqual(ribbonGapRows({hostId:overflow.sources[0].hostId},model),[2]);
 for(const [w,h] of [[320,140],[720,260],[1536,640]]){const l=ribbonLayout(w,h,3);assert.ok(l.left<l.right);assert.ok(l.top>=0);assert.ok(l.bottom<=h);assert.ok(l.rowHeight>0);}
});
