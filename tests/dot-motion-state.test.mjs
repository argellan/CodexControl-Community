// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {mountCompanion} from '../public/companion-panel.mjs';
test('Dot motion state follows activity, pause and visibility without repeated root writes',()=>{
 const saved={document:globalThis.document,location:globalThis.location};
 const changes=[],state=new Proxy({},{set(target,key,value){changes.push([key,value]);target[key]=value;return true;}}),events={};
 const label={textContent:''},presence={textContent:''},sprite={style:{setProperty(){}},classList:{add(){},remove(){}}};
 const button={dataset:{},querySelector:selector=>selector==='b'?label:selector==='.jona-placeholder'?sprite:presence,setAttribute(){},addEventListener(){}};
 let sessions=[],paused=false,reduced=false;
 globalThis.document={hidden:false,documentElement:{dataset:state},addEventListener:(type,fn)=>{events[type]=fn;}};
 globalThis.location={origin:'https://test.invalid'};
 try{
  const panel=mountCompanion({button,openDetails(){},getSessions:()=>sessions,getSnapshot:()=>({hosts:[{id:'test-host',status:'online'}]}),getMotion:()=>({paused,reduced})});
  assert.equal(state.dotActivity,'quiet');assert.equal(state.dotSuspended,'false');
  sessions=[{id:'test-session',hostId:'test-host',lastEventAt:new Date().toISOString()}];panel.update();assert.equal(state.dotActivity,'activity');
  const stable=changes.length;panel.update();assert.equal(changes.length,stable);
  paused=true;panel.update();assert.equal(state.dotSuspended,'true');
  globalThis.document.hidden=true;events.visibilitychange();globalThis.document.hidden=false;events.visibilitychange();assert.equal(state.dotSuspended,'true');
  paused=false;reduced=true;panel.update();assert.equal(state.dotSuspended,'true');
  reduced=false;panel.update();assert.equal(state.dotSuspended,'false');
  globalThis.document.hidden=true;events.visibilitychange();assert.equal(state.dotSuspended,'true');
 }finally{for(const [key,value]of Object.entries(saved))if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
});
