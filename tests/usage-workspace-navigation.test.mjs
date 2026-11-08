// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {isUsageExitTarget,providerWindows,restoreUsageState} from '../public/usage-workspace.mjs';

function node(tag,{id='',mobile=false,parent=null}={}){
 return {tag,id,mobile,parent,closest(selector){for(let current=this;current;current=current.parent){if(current.id==='live'&&selector.includes('#live'))return current;if(current.mobile&&(selector.includes('[data-mobile-view]')&&!selector.includes('button[data-mobile-view]')||current.tag==='button'&&selector.includes('button[data-mobile-view]')))return current;}return null;}};
}
test('the document mobile-view state does not close Usage; actual navigation buttons do',()=>{
 const html=node('html',{mobile:true}),header=node('header',{parent:html}),usage=node('button',{id:'usage-open',parent:header}),live=node('button',{id:'live',parent:header}),mobile=node('button',{mobile:true,parent:html});
 assert.equal(isUsageExitTarget(usage),false);assert.equal(isUsageExitTarget(live),true);assert.equal(isUsageExitTarget(mobile),true);
});
test('provider windows remain separate by account and distinguish unavailable or stale values',()=>{
 const now=Date.parse('2026-11-07T12:00:00Z'),at=new Date(now-1000).toISOString(),account=(label,used,observedAt=at)=>({label,status:'available',limitsObservedAt:observedAt,limits:[{limitId:'codex',primary:{usedPercent:used,windowDurationMins:10080,resetsAt:Math.floor((now+hour)/1000)},secondary:{usedPercent:20,windowDurationMins:300,resetsAt:Math.floor((now+hour)/1000)}}]});
 const hour=3600000,value=providerWindows({accountUsage:{status:'available',accounts:[account('One',40),account('Two',120,new Date(now-300000).toISOString())]}},{now});
 assert.equal(value.accounts.length,2);assert.equal(value.accounts[0].windows.length,2);assert.equal(value.accounts[0].windows[0].remaining,60);assert.equal(value.accounts[0].windows[1].remaining,80);
 assert.equal(value.accounts[1].windows[0].remaining,null);assert.equal(value.accounts[1].state,'stale');assert.equal(providerWindows({accountUsage:{status:'restricted'}},{now}).restricted,true);
});
test('history restoration preserves valid analysis context and rejects invalid state',()=>{
 const saved={period:'6h',dimension:'project',contributor:'["TEST_ONLY"]',interval:23,record:'sample',page:2};
 assert.deepEqual(restoreUsageState(saved),saved);assert.equal(restoreUsageState({...saved,period:'forever'}),null);
 assert.deepEqual(restoreUsageState({...saved,interval:24,record:'x'.repeat(257),page:-1}),{...saved,interval:null,record:null,page:0});
});
