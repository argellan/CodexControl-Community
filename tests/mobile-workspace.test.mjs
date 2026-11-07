// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptiveOverviewMode,mobileViewFromHash,adaptivePanels} from '../public/mobile-workspace.mjs';
test('adaptive views keep Fleet and Activity available without changing the saved desktop mode',()=>{
 for(const savedMode of ['full','compact','mini']){
  const saved={overviewMode:savedMode};
  assert.equal(adaptiveOverviewMode(saved.overviewMode,true),'full');
  assert.equal(adaptiveOverviewMode(saved.overviewMode,false),savedMode);
  assert.equal(saved.overviewMode,savedMode);
 }
});
test('only known mobile routes select a panel; foreign fragments return to Overview',()=>{
 for(const view of ['overview','fleet','activity','more'])assert.equal(mobileViewFromHash('#view-'+view),view);
 for(const hash of ['','#main','#view-settings','#view-<script>'])assert.equal(mobileViewFromHash(hash),'overview');
});

test('adaptive render panels follow visible navigation without losing desktop capabilities',()=>{
 const all={workers:true,timeline:true,map:true,inspector:true};assert.deepEqual(adaptivePanels(),all);
 for(const [width,height] of [[390,844],[844,390],[1024,480]])for(const mapOpen of [false,true])assert.deepEqual(adaptivePanels({adaptive:true,width,height,mapOpen}),{workers:false,timeline:!mapOpen,map:mapOpen,inspector:false});
 assert.deepEqual(adaptivePanels({adaptive:true,width:768,height:1024}),{...all,inspector:false});
 for(const view of ['fleet','activity','more'])assert.deepEqual(adaptivePanels({adaptive:true,width:390,height:844,view}),{workers:view==='fleet',timeline:view==='activity',map:false,inspector:false});
});
