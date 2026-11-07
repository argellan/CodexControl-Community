// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {RenderScheduler} from '../public/render-scheduler.mjs';
test('cooperative refresh yields between stages without losing or reordering work',async()=>{const trace=[];const scheduler=new RenderScheduler({yieldTask:async()=>trace.push('paint')});function* stages(){trace.push('workers');yield;trace.push('timeline');yield;trace.push('map');}assert.equal(await scheduler.run(stages),true);assert.deepEqual(trace,['workers','paint','timeline','paint','map']);});
test('a synchronous interaction supersedes an unfinished refresh and closes its iterator',async()=>{const trace=[];let resume;const scheduler=new RenderScheduler({yieldTask:()=>new Promise(r=>resume=r)});function* old(){try{trace.push('old-start');yield;trace.push('stale-write');}finally{trace.push('closed');}}const pending=scheduler.run(old);scheduler.sync(function*(){trace.push('filter-selection');yield;trace.push('selected-map');});resume();assert.equal(await pending,false);assert.deepEqual(trace,['old-start','filter-selection','selected-map','closed']);});
test('hidden/settings guard stops further stages; later fresh work can run',async()=>{let active=true;const trace=[];const scheduler=new RenderScheduler({active:()=>active,yieldTask:async()=>{active=false;}});assert.equal(await scheduler.run(function*(){trace.push(1);yield;trace.push(2);}),false);active=true;scheduler.sync(function*(){trace.push(3);yield;});assert.deepEqual(trace,[1,3]);});
test('stage exceptions propagate, close the generator and permit recovery',async()=>{let closed=false;const scheduler=new RenderScheduler({yieldTask:async()=>{}});await assert.rejects(scheduler.run(function*(){try{yield;throw new Error('failed');}finally{closed=true;}}),/failed/);assert.equal(closed,true);assert.equal(await scheduler.run(function*(){yield;}),true);});
test('focus wrapper surrounds each stage for both cooperative and immediate paths',async()=>{let count=0;const scheduler=new RenderScheduler({yieldTask:async()=>{},step:fn=>{count++;return fn();}});await scheduler.run(function*(){yield;});scheduler.sync(function*(){yield;});assert.equal(count,4);});
