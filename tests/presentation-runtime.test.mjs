// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {presentationClocks,presentationMotion,presentationAlerts} from '../public/presentation-runtime.mjs';
const now=Date.parse('2026-10-20T02:30:10.123Z');
const input=Object.freeze({id:'input',kind:'approval',at:'2026-01-01T00:00:00Z'}),failure=Object.freeze({id:'failure',kind:'error',outcome:'failed',at:'invalid'}),gap=Object.freeze({id:'gap',kind:'source-gap',at:null});
const attention=Object.freeze([input,failure,gap]);

test('clocks use the selected IANA zone, local calendar date, 24-hour format and milliseconds',()=>{
 const c=presentationClocks(now,{clockTimezone:'America/New_York',clockFormat:'24h',clockMilliseconds:true});
 assert.match(c.local,/22:30:10[.,]123/);assert.match(c.utc,/02:30:10[.,]123/);assert.match(c.zone,/EDT|GMT-4/);assert.match(c.date,/19/);
});
test('12-hour clocks and millisecond opt-out affect local and UTC consistently',()=>{
 const c=presentationClocks(now,{clockTimezone:'Asia/Tokyo',clockFormat:'12h',clockMilliseconds:false});
 assert.match(c.local,/11:30:10/);assert.match(c.local,/AM/i);assert.match(c.utc,/2:30:10/);assert.ok(!c.local.includes('.123'));assert.match(c.date,/20/);
});
test('invalid clocks expose unavailable state while epoch zero and historical timestamps remain valid',()=>{
 for(const value of [NaN,Infinity,'bad',null]){const c=presentationClocks(value,{clockTimezone:'UTC'});assert.equal(c.local,'—');assert.equal(c.utc,'—');}
 assert.match(presentationClocks(0,{clockTimezone:'UTC',clockFormat:'24h'}).utc,/00:00:00/);
 const badZone=presentationClocks(now,{clockTimezone:'Invalid/Zone'});assert.equal(badZone.local,'—');assert.equal(badZone.zone,'UNAVAILABLE');assert.match(badZone.utc,/02:30/);
});
test('clock midnight stays 00 in 24-hour mode and dates follow zone boundaries',()=>{
 const time=Date.parse('2026-10-20T00:00:00Z'),c=presentationClocks(time,{clockTimezone:'UTC',clockFormat:'24h',clockMilliseconds:false});assert.match(c.utc,/^00:00:00$/);assert.match(c.date,/20/);
});
test('motion honors system reduction and distinguishes a personal pause from reduced motion',()=>{
 assert.deepEqual(presentationMotion({motionMode:'system'},false),{reduced:false,paused:false});
 assert.deepEqual(presentationMotion({motionMode:'system'},true),{reduced:true,paused:false});
 assert.deepEqual(presentationMotion({motionMode:'reduced'},false),{reduced:true,paused:false});
 assert.deepEqual(presentationMotion({motionMode:'paused'},false),{reduced:false,paused:true});
 assert.deepEqual(presentationMotion({motionMode:'invalid'},true),{reduced:true,paused:false});
});
test('severity policy keeps critical input, warning failures and informational source gaps distinct',()=>{
 for(const [severity,ids] of [['info',['input','failure','gap']],['warning',['input','failure']],['critical',['input']]]){
  const result=presentationAlerts(attention,{policy:{minimumSeverity:severity},preferences:{},now});assert.deepEqual(result.visibleItems.map(i=>i.id),ids);assert.equal(result.glow,true);
 }
});
test('observed resource, quota and unanswered-tool alerts remain warnings under the default policy',()=>{
 const items=['resource-alert','quota-alert','tool-unanswered'].map((kind,i)=>Object.freeze({id:'warning'+i,kind,priority:1,attention:true,category:'error'}));
 const result=presentationAlerts(items,{now});assert.deepEqual(result.visibleItems,items);assert.equal(result.glow,true);
 assert.equal(presentationAlerts(items,{policy:{minimumSeverity:'critical'},now}).visibleItems.length,0);
});
test('personal quieting hides only matching eligible ticker items until expiry and leaves source evidence untouched',()=>{
 const preferences=Object.freeze({acknowledgedAlerts:Object.freeze([Object.freeze({id:'input',until:new Date(now+900000).toISOString()}),Object.freeze({id:'failure',until:new Date(now-1).toISOString()})])});
 const before=JSON.stringify({attention,preferences}),result=presentationAlerts(attention,{policy:{minimumSeverity:'info'},preferences,now});
 assert.deepEqual(result.visibleItems.map(i=>i.id),['failure','gap']);assert.equal(result.quietedCount,1);assert.equal(JSON.stringify({attention,preferences}),before);assert.equal(attention.length,3);assert.strictEqual(result.visibleItems[0],failure);
});
test('expired, invalid and excessive future quiet acknowledgements cannot silently suppress attention',()=>{
 const preferences={acknowledgedAlerts:[{id:'input',until:'nonsense'},{id:'failure',until:new Date(now).toISOString()},{id:'gap',until:new Date(now+48*3600000).toISOString()}]};
 const result=presentationAlerts(attention,{policy:{minimumSeverity:'info'},preferences,now});assert.equal(result.quietedCount,0);assert.equal(result.visibleItems.length,3);
});
test('overnight quiet hours use the requested IANA zone and suppress glow without hiding text',()=>{
 const policy={minimumSeverity:'info',quietHours:{enabled:true,start:'22:00',end:'07:00'}};
 const result=presentationAlerts(attention,{policy,preferences:{},now,timezone:'America/New_York'});assert.equal(result.quietHours,true);assert.equal(result.glow,false);assert.equal(result.visibleItems.length,3);assert.equal(result.tickerVisible,true);
 const utc=presentationAlerts(attention,{policy,preferences:{},now,timezone:'Asia/Tokyo'});assert.equal(utc.quietHours,false);assert.equal(utc.glow,true);
});
test('quiet-hour interval boundaries are start-inclusive and end-exclusive across overnight midnight',()=>{
 const policy={minimumSeverity:'info',quietHours:{enabled:true,start:'22:00',end:'07:00'}};
 for(const [iso,expected] of [['2026-10-20T21:59:59Z',false],['2026-10-20T22:00:00Z',true],['2026-10-21T00:00:00Z',true],['2026-10-21T06:59:59Z',true],['2026-10-21T07:00:00Z',false]])assert.equal(presentationAlerts(attention,{policy,now:Date.parse(iso),timezone:'UTC'}).quietHours,expected);
});
test('daytime, equal-boundary, invalid-time and disabled schedules remain explicit',()=>{
 const base={minimumSeverity:'info',quietHours:{enabled:true,start:'01:00',end:'03:00'}};assert.equal(presentationAlerts(attention,{policy:base,now,timezone:'UTC'}).quietHours,true);
 for(const quietHours of [{enabled:true,start:'02:30',end:'02:30'},{enabled:true,start:'25:99',end:'07:00'},{enabled:false,start:'01:00',end:'03:00'}])assert.equal(presentationAlerts(attention,{policy:{...base,quietHours},now,timezone:'UTC'}).quietHours,false);
});
test('invalid clocks or zones cannot activate quiet hours or expire a request by assumption',()=>{
 const policy={minimumSeverity:'info',quietHours:{enabled:true,start:'00:00',end:'23:59'}};
 for(const options of [{now:NaN,timezone:'UTC'},{now,timezone:'Invalid/Zone'}]){const r=presentationAlerts(attention,{policy,...options});assert.equal(r.quietHours,false);assert.equal(r.visibleItems.length,3);assert.equal(r.glow,true);}
});
test('presentation flags compose without changing evidence and ticker visibility survives an empty attention list',()=>{
 const result=presentationAlerts(attention,{policy:{minimumSeverity:'info',presentation:{ticker:false,glow:true}},preferences:{alertGlow:false},now});assert.equal(result.tickerVisible,false);assert.equal(result.glow,false);assert.equal(result.visibleItems.length,3);
 assert.equal(presentationAlerts([],{policy:{presentation:{ticker:true}},preferences:{alertTicker:true},now}).tickerVisible,true);
 assert.equal(presentationAlerts([],{policy:{},preferences:{},now}).glow,false);
});
