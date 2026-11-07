// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {wheelZoom,clampZoom,zoomGeometry,anchoredScroll} from '../public/view-zoom.mjs';

test('zoom stays bounded for pixel, line and page wheels without accepting invalid input',()=>{
 assert.equal(clampZoom(Infinity),1);assert.equal(clampZoom(100),3);assert.equal(clampZoom(-1),.5);
 assert.ok(wheelZoom(1,-10)>1);assert.ok(wheelZoom(1,10)<1);assert.equal(wheelZoom(1,NaN),1);
 assert.equal(wheelZoom(1,1,1),wheelZoom(1,16));assert.equal(wheelZoom(1,1,2,80),wheelZoom(1,80));
 assert.equal(wheelZoom(3,-10000),3);assert.equal(wheelZoom(.5,10000),.5);
});
test('cursor anchored zoom keeps the same world point and centers a zoomed out scene',()=>{
 const input={width:900,height:400,worldWidth:1200,worldHeight:600,baseScale:2/3};
 const before=zoomGeometry({...input,zoom:1.5}),after=zoomGeometry({...input,zoom:2}),anchor={x:300,y:200},scroll={x:100,y:80};
 const next=anchoredScroll(before,after,anchor,scroll);
 for(const axis of ['x','y'])assert.ok(Math.abs((scroll[axis]+anchor[axis]-before[axis])/before.scale-(next[axis]+anchor[axis]-after[axis])/after.scale)<1e-9);
 const small=zoomGeometry({...input,zoom:.5});assert.ok(small.x>0&&small.y>0);assert.deepEqual(anchoredScroll(after,small,anchor,next),{x:0,y:0});
});
test('panning and zoom preserve world bounds at the extreme edges and after resizing',()=>{
 const before=zoomGeometry({width:600,height:300,zoom:2}),after=zoomGeometry({width:300,height:150,worldWidth:600,worldHeight:300,zoom:3});
 const scroll=anchoredScroll(before,after,{x:600,y:300},{x:600,y:300});
 assert.ok(scroll.x>=0&&scroll.x<=after.extentWidth-after.width);assert.ok(scroll.y>=0&&scroll.y<=after.extentHeight-after.height);
 assert.equal(after.worldWidth,before.worldWidth);assert.equal(after.worldHeight,before.worldHeight);
});
