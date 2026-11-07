// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {lazyWorkspace} from '../public/lazy-workspace.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
test('does not load until requested, shares loading, and opens only the latest section',async()=>{
 const ready=deferred(),calls=[];let loaded=0,created=0;
 const view=lazyWorkspace({load:()=>{loaded++;return ready.promise;},create:()=>{created++;return {open:section=>calls.push(section)};}});
 assert.equal(loaded,0);assert.equal(view.isOpen,false);
 const first=view.open('general'),second=view.open('sources');assert.equal(view.isOpen,true);
 ready.resolve({});await Promise.all([first,second]);assert.equal(loaded,1);assert.equal(created,1);assert.deepEqual(calls,['sources']);
 await view.open('history');assert.equal(loaded,1);assert.deepEqual(calls,['sources','history']);
});
test('authority invalidation cancels an in-flight open and permits a fresh authorized request',async()=>{
 const ready=deferred();let created=0,opened=0,invalidated=0;
 const view=lazyWorkspace({load:()=>ready.promise,create:()=>{created++;return {open:()=>opened++,invalidate:()=>invalidated++};}});
 const stale=view.open();view.invalidate();ready.resolve({});await stale;
 assert.equal(created,0);assert.equal(opened,0);assert.equal(view.isOpen,false);
 await view.open();assert.equal(opened,1);view.invalidate();assert.equal(invalidated,1);
});
test('failed import is retryable with visible error and no permanently busy state',async()=>{
 let attempts=0;const errors=[],pending=[];
 const view=lazyWorkspace({load:()=>{if(++attempts===1)throw new Error('offline');return {};},create:()=>({open:()=>42}),onError:e=>errors.push(e.message),onPending:v=>pending.push(v)});
 await view.open();assert.deepEqual(errors,['offline']);assert.equal(view.isOpen,false);
 assert.equal(await view.open(),42);assert.equal(attempts,2);assert.deepEqual(pending,[true,false,true,false]);
});
test('open state follows the mounted dialog after loading and invalidate closes through the supplied policy',async()=>{
 const instance={isOpen:false,open(){this.isOpen=true;},close(){this.isOpen=false;}};
 const view=lazyWorkspace({load:()=>({}),create:()=>instance,invalidate:x=>x.close()});
 await view.open();assert.equal(view.isOpen,true);instance.close();assert.equal(view.isOpen,false);
 await view.open();view.invalidate();assert.equal(view.isOpen,false);
});
