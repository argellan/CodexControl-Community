// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalDesktopObservation} from '../lib/local-desktop-observation.mjs';
test('desktop capture includes its own account and selected Dot without a network collector',async()=>{
 const local={host:{id:'desktop'},sessions:[{id:'work'}],events:[{id:'source-record'}]},accountUsage={status:'available',limits:[{usedPercent:25}]},dot={name:'Selected Dot',artworkSha256:'a'.repeat(64)};
 let published=false,selected=null,stopped=0;
 const observer=createLocalDesktopObservation({accountObserver:{enabled:true},desktopCompanion:{enabled:true}},{directory:'TEST_ONLY',hostId:'desktop',accountFactory:()=>({sample:()=>accountUsage,stop:()=>stopped++}),companionFactory:()=>({sample:()=>selected,poll:async publish=>{await publish(dot,'TEST_ONLY artwork');selected=dot;}}),publishCompanion:async()=>{published=true;}});
 const first=await observer.read(async()=>local);assert.deepEqual(first.accountUsage,accountUsage);await new Promise(r=>setImmediate(r));
 const next=await observer.read(async()=>local);assert.equal(published,true);assert.deepEqual(next.desktopCompanion,dot);assert.deepEqual(next.events,local.events);assert.deepEqual(next.sessions,local.sessions);
 await observer.close();await observer.close();assert.equal(stopped,1);assert.deepEqual(await observer.read(async()=>local),local);
});
test('disabled desktop observers leave source capture intact and publish no activity or artwork',async()=>{
 let publication=0;const local={host:{id:'desktop'},sessions:[],events:[]};
 const observer=createLocalDesktopObservation({}, {directory:'TEST_ONLY',hostId:'desktop',accountFactory:()=>null,companionFactory:()=>null,publishCompanion:()=>publication++});
 assert.deepEqual(await observer.read(async()=>local),local);assert.equal(observer.metadata(),null);assert.equal(publication,0);await observer.close();
});
