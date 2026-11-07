// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {FleetHub} from '../lib/fleet.mjs';

function fixture(){
 const now=Date.parse('2026-11-01T19:00:00Z');
 const local={host:{id:'desktop-hub',name:'TEST_ONLY desktop',cpu:10},observedAt:new Date(now-1000).toISOString(),sessions:[{id:'local-work',hostId:'desktop-hub',events:[]}],events:[],coverage:{}};
 const hub=new FleetHub();hub.hosts=[{id:'desktop-hub'},{id:'pi-node'}];hub.states=new Map([['desktop-hub',{...local}],['pi-node',{receivedAt:now-2000,observedAt:new Date(now-2200).toISOString(),sessions:[{id:'node-work',hostId:'pi-node'}]}]]);hub.journal={status:()=>({epoch:'TEST_ONLY'}),latest:()=>[]};
 return {hub,local,now};
}
test('an enrolled desktop hub without a collector receipt stays visible with each local and Node session once',()=>{
 const {hub,local,now}=fixture(),before=structuredClone([...hub.states]);
 const value=hub.snapshot(local,now);
 assert.equal(value.hosts.find(h=>h.id==='desktop-hub').status,'online');
 assert.equal(value.hosts.find(h=>h.id==='desktop-hub').receivedAt,local.observedAt);
 assert.deepEqual(value.sessions.map(s=>s.id),['local-work','node-work']);
 assert.equal(value.hosts.find(h=>h.id==='pi-node').status,'online');
 assert.deepEqual([...hub.states],before);
});
test('an invalid remote receipt cannot blank the desktop or other captured Node records',()=>{
 for(const receivedAt of [undefined,'invalid',NaN,Infinity,8640000000000001]){
  const {hub,local,now}=fixture();hub.states.get('pi-node').receivedAt=receivedAt;
  const value=hub.snapshot(local,now),node=value.hosts.find(h=>h.id==='pi-node');
  assert.equal(node.receivedAt,null);assert.equal(node.status,'not connected');
  assert.equal(value.hosts.find(h=>h.id==='desktop-hub').status,'online');
  assert.equal(value.sessions.some(s=>s.id==='node-work'),true);
 }
});
test('local source time is not invented when unavailable, and disabled enrollment remains disabled',()=>{
 const {hub,local,now}=fixture();local.observedAt='invalid';hub.hosts[0].disabled=true;
 const value=hub.snapshot(local,now),host=value.hosts.find(h=>h.id==='desktop-hub');
 assert.equal(host.status,'disabled');assert.equal(host.receivedAt,null);
});
