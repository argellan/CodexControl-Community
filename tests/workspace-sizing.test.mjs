// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceMinimum,mountWorkspaceSizing} from '../public/workspace-sizing.mjs';
test('minimums are derived from visible chrome and usable content rather than screen resolution',()=>{
 assert.deepEqual(workspaceMinimum({stage:196,mapChrome:113,flowOnly:true,timelineChrome:100,timelineContent:56,timelineFloor:168,divider:8}),{map:309,timeline:0,total:309});
 assert.deepEqual(workspaceMinimum({stage:196,mapChrome:113,timelineChrome:100,timelineContent:56,timelineFloor:168,divider:8}),{map:309,timeline:168,total:485});
 assert.deepEqual(workspaceMinimum({stage:336,mapChrome:210,timelineChrome:190,timelineContent:96,timelineFloor:288,divider:8}),{map:546,timeline:288,total:842});
});
test('subpixel measurements round upward and malformed measurements cannot collapse a valid minimum',()=>{
 const value=workspaceMinimum({stage:196.2,mapChrome:99.1,timelineChrome:100.2,timelineContent:60.1,timelineFloor:168,divider:8});assert.equal(value.map,296);assert.equal(value.timeline,168);assert.equal(value.total,472);
 assert.deepEqual(workspaceMinimum({stage:NaN,mapChrome:120,timelineChrome:-4,timelineContent:Infinity,divider:8}),{map:120,timeline:0,total:128});
});

test('the sizing observer excludes scroll content, coalesces notifications and avoids redundant writes',()=>{
 let frame,notify,flowOnly=false,writes=0,disconnected=false;const values={};
 const node=(height,scroll=false)=>({children:[],getBoundingClientRect(){if(scroll)throw Error('A retained data list must not size the page');return {height};},matches(){return scroll;},style:{}});
 const stage=node(196),header=node(60),footer=node(40),list=node(100000,true),timeline=node(0),panel=node(0),stack=node(0),cockpit=node(0),divider=node(8),root=node(0);panel.children=[header,stage,footer];timeline.children=[node(50),list,node(20)];
 panel.querySelector=()=>stage;stack.querySelector=selector=>selector==='.waterfall-panel'?panel:timeline;stack.classList={contains:()=>flowOnly};cockpit.querySelector=()=>stack;cockpit.style.setProperty=(key,value)=>{values[key]=value;writes++;};
 const document={documentElement:root,getElementById:id=>id==='cockpit'?cockpit:divider,fonts:{addEventListener(){},removeEventListener(){}}};
 const window={requestAnimationFrame(fn){frame=fn;return 1;},cancelAnimationFrame(){frame=null;},ResizeObserver:class{constructor(fn){notify=fn;}observe(){}disconnect(){disconnected=true;}},getComputedStyle:n=>({display:'block',marginTop:'0',marginBottom:'0',paddingTop:'0',paddingBottom:'0',borderTopWidth:'1',borderBottomWidth:'1',fontSize:'14px',minHeight:n===stage?'196px':'0px'}),addEventListener(){},removeEventListener(){}};
 const mounted=mountWorkspaceSizing({document,window});frame();assert.equal(values['--map-pane-min-height'],'298px');assert.equal(values['--workspace-min-height'],'474px');assert.equal(writes,3);
 notify();notify();frame();assert.equal(writes,3);flowOnly=true;notify();frame();assert.equal(values['--workspace-min-height'],'298px');mounted.destroy();assert.equal(disconnected,true);
});
