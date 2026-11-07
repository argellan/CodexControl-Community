// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// View geometry only. Zoom never changes capture, source scope or time windows.
export const ZOOM_MIN=.5,ZOOM_MAX=3;
export const clampZoom=value=>Math.max(ZOOM_MIN,Math.min(ZOOM_MAX,Number.isFinite(value)?value:1));
export function wheelZoom(current,delta,mode=0,page=600){
 if(!Number.isFinite(delta)||delta===0)return clampZoom(current);
 const pixels=delta*(mode===1?16:mode===2?page:1);
 return clampZoom(current*Math.exp(-Math.max(-100,Math.min(100,pixels))*.002));
}
export function zoomGeometry({width,height,worldWidth=width,worldHeight=height,baseScale=1,zoom=1}){
 const scale=baseScale*clampZoom(zoom),w=worldWidth*scale,h=worldHeight*scale;
 return {scale,width,height,worldWidth,worldHeight,x:Math.max(0,(width-w)/2),y:Math.max(0,(height-h)/2),extentWidth:Math.max(width,w),extentHeight:Math.max(height,h)};
}
export function anchoredScroll(before,after,anchor,scroll={x:0,y:0}){
 if(!before)return {x:0,y:0};
 const axis=(point,start,end,position,extent,viewport)=>Math.max(0,Math.min(extent-viewport,(position+point-start)/before.scale*after.scale+end-point));
 return {x:axis(anchor.x,before.x,after.x,scroll.x,after.extentWidth,after.width),y:axis(anchor.y,before.y,after.y,scroll.y,after.extentHeight,after.height)};
}
