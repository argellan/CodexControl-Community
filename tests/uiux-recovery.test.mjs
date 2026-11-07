// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {ContextTrail} from '../public/investigation-workspace.mjs';
const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf("$('reset-filters').addEventListener('click',"),end=source.indexOf("$('clear-selection').addEventListener",start);
const handler=source.slice(start,end);
function scenario(scope){
 const nodes=Object.fromEntries(['reset-filters','host-filter','project-filter','category-filter','search','announcer'].map(id=>[id,{value:'',hidden:false,focus(options){this.focused=options;},addEventListener(type,fn){this.click=fn;}}]));
 Object.assign(nodes['host-filter'],{value:scope?'TEST_ONLY-host':''});nodes['category-filter'].value='research';nodes.search.value='NO_MATCH_TEST_ONLY';
 const records=Object.freeze([{id:'source-1',sourceId:'TEST_ONLY-source',at:'2026-10-21T00:00:00Z'}]);
 const sandbox={nodes,records,selectedSession:scope?'TEST_ONLY-host/session':'',selectedEvent:'source-1',selectedAggregate:{members:['source-1']},mapInspection:{title:'old'},activityMap:{selection:'source-1'},feedLimit:400,windowMs:300000,replayClock:123456,mode:'replay',preferences:Object.freeze({overviewMode:'mini',motionMode:'paused'}),renders:0,refreshes:0};
 sandbox.$=id=>nodes[id];sandbox.usageScope=()=>nodes['host-filter'].value||sandbox.selectedSession;sandbox.render=()=>{sandbox.renders++;nodes['reset-filters'].hidden=true;};sandbox.accountUsageController={refresh(){sandbox.refreshes++;}};
 sandbox.trail=new ContextTrail();
 sandbox.investigation={remember(){sandbox.trail.push({host:nodes['host-filter'].value,project:nodes['project-filter'].value,category:nodes['category-filter'].value,search:nodes.search.value,session:sandbox.selectedSession,event:sandbox.selectedEvent,mode:sandbox.mode,at:sandbox.replayClock,windowMs:sandbox.windowMs});}};
 vm.createContext(sandbox);vm.runInContext(handler,sandbox);nodes['reset-filters'].click();return sandbox;
}
for(const scope of [false,true])test('filter recovery preserves source, replay and preferences; usage refresh follows scope '+scope,()=>{
 const x=scenario(scope);
 assert.equal(x.trail.items.length,1);assert.deepEqual(x.trail.pop(),{host:scope?'TEST_ONLY-host':'',project:'',category:'research',search:'NO_MATCH_TEST_ONLY',session:scope?'TEST_ONLY-host/session':'',event:'source-1',mode:'replay',at:123456,windowMs:300000});
 for(const id of ['host-filter','project-filter','category-filter','search'])assert.equal(x.nodes[id].value,'');
 assert.equal(x.selectedSession,'');assert.equal(x.selectedEvent,'');assert.equal(x.selectedAggregate,null);assert.equal(x.activityMap.selection,null);assert.equal(x.mapInspection,null);assert.equal(x.feedLimit,200);
 assert.equal(x.windowMs,300000);assert.equal(x.replayClock,123456);assert.equal(x.mode,'replay');assert.equal(x.preferences.overviewMode,'mini');assert.equal(x.preferences.motionMode,'paused');assert.equal(x.records[0].id,'source-1');assert.equal(x.records.length,1);
 assert.equal(x.renders,1);assert.equal(x.refreshes,Number(scope));assert.equal(x.nodes['host-filter'].focused.preventScroll,true);assert.match(x.nodes.announcer.textContent,/replay position kept/);
});
