// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// Bounded presentation of already-authorized source records. No capture or I/O.
import {eventTime} from './event-model.mjs';
import {presentationValue} from './ui-model.mjs';

const sourceKey=e=>(e.hostId||'local')+'/'+e.sessionId;
const failure=e=>e.kind==='error'||['failed','interrupted'].includes(e.outcome);
const priority=(e,selected)=>e.id===selected||e.members?.includes(selected)?4:failure(e)?3:e.kind==='approval'?2:0;
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const colors={command:'#20cfff',edit:'#ff9b18',research:'#00f5c8',agent:'#c675ff',tool:'#5cecff',turn:'#ff59ce',complete:'#78ff9b',message:'#a18bff',approval:'#ffdb27',resolution:'#78ff9b',error:'#ff3b64',remote:'#7cff4d'};
const tone=(e,p=colors)=>failure(e)?presentationValue(p,'error',colors.error):presentationValue(p,e.category,presentationValue(p,e.kind,presentationValue(p,'tool',colors.tool)));

function clustered(events,budget,windowMs,selected){
 const types=new Set(events.map(e=>[e.category,e.kind,e.outcome||''].join('|'))),binMs=Math.max(50,windowMs/Math.max(1,Math.floor(budget/Math.max(1,types.size)/2))),groups=new Map();
 for(const e of events){
  const at=eventTime(e),key=[Math.floor(at/binMs),e.category,e.kind,e.outcome||''].join('|');let group=groups.get(key);
  if(!group){group={...e,members:[],count:0,firstAt:at,lastAt:at,binMs,sourceKeys:new Set()};groups.set(key,group);}
  group.members.push(e.id);group.sourceKeys.add(sourceKey(e));group.count++;group.firstAt=Math.min(group.firstAt,at);group.lastAt=Math.max(group.lastAt,at);
  if(e.id===selected){Object.assign(group,e);group.selected=true;}
 }
 for(const g of groups.values()){g.sourceCount=g.sourceKeys.size;g.mixedSources=g.sourceCount>1;delete g.sourceKeys;}
 let result=[...groups.values()];
 if(result.length>budget){
  result.sort((a,b)=>priority(b,selected)-priority(a,selected)||b.lastAt-a.lastAt);
  const rest=result.splice(Math.max(0,budget-1)),representative=rest[0];
  result.push({...representative,id:'ribbon-cluster:'+representative.id,label:'Additional recorded events',mixed:true,members:rest.flatMap(e=>e.members),count:rest.reduce((n,e)=>n+e.count,0),firstAt:Math.min(...rest.map(e=>e.firstAt)),lastAt:Math.max(...rest.map(e=>e.lastAt))});
 }
 for(const group of result){group.binMs=Math.max(1,group.lastAt-group.firstAt);group.plotAt=group.selected?eventTime(group):(group.firstAt+group.lastAt)/2;}
 return result.sort((a,b)=>a.plotAt-b.plotAt);
}

export function projectRibbon({events=[],sessions=[],spans=[],reference,windowMs=60000,maxLanes=6,maxMarkers=240,previousOrder=[],selectedEvent='',selectedSession='',palette=colors}={}){
 const inventory=new Map(sessions.map(s=>[(s.hostId||'local')+'/'+s.id,s])),groups=new Map(),start=reference-windowMs;
 for(const e of events){
  const at=eventTime(e);if(!Number.isFinite(at)||at<start||at>reference)continue;
  const id=sourceKey(e);let lane=groups.get(id);
  if(!lane){const s=inventory.get(id)||{};lane={id,sourceKey:id,hostId:e.hostId||'local',sessionId:e.sessionId,label:s.nickname||s.id?.slice(0,8)||e.sessionId?.slice(0,8)||'Unknown worker',project:s.project||e.project||'Project unavailable',host:s.hostName||e.hostName||e.hostId||'Local',events:[],count:0,failures:0,inputs:0,lastAt:0};groups.set(id,lane);}
  lane.events.push(e);lane.count++;lane.failures+=Number(failure(e));lane.inputs+=Number(e.kind==='approval');lane.lastAt=Math.max(lane.lastAt,at);
 }
 const previous=new Map(previousOrder.map((id,i)=>[id,i]));
 const all=[...groups.values()].sort((a,b)=>(previous.get(a.id)??Infinity)-(previous.get(b.id)??Infinity)||a.id.localeCompare(b.id));
 const selectedSource=events.find(e=>e.id===selectedEvent);const focus=selectedSource?sourceKey(selectedSource):selectedSession;
 const cap=clamp(Math.floor(maxLanes),2,10),shown=all.slice(0,all.length>cap?cap-1:cap);
 if(focus&&!shown.some(l=>l.id===focus)&&groups.has(focus)){if(shown.length)shown[shown.length-1]=groups.get(focus);else shown.push(groups.get(focus));}
 const visible=new Set(shown.map(l=>l.id)),hidden=all.filter(l=>!visible.has(l.id));
 if(hidden.length){shown.push({id:'ribbon-overflow',overflow:true,label: hidden.length+' more workers',host:'Grouped display · inspect to expand',project:'Source records retained',sources:hidden,events:hidden.flatMap(l=>l.events),count:hidden.reduce((n,l)=>n+l.count,0),failures:hidden.reduce((n,l)=>n+l.failures,0),inputs:hidden.reduce((n,l)=>n+l.inputs,0),lastAt:Math.max(...hidden.map(l=>l.lastAt))});}
 const budget=Math.max(1,Math.floor(maxMarkers/Math.max(1,shown.length))),markers=[];let peak=1;
 for(const [row,lane] of shown.entries()){
  lane.row=row;lane.bins=Array.from({length:48},()=>({count:0,categories:new Map()}));
  for(const e of lane.events){const bin=lane.bins[clamp(Math.floor((eventTime(e)-start)/windowMs*48),0,47)],color=tone(e,palette);bin.count++;bin.categories.set(color,(bin.categories.get(color)||0)+1);peak=Math.max(peak,bin.count);}
  for(const bin of lane.bins)bin.color=[...bin.categories].sort((a,b)=>b[1]-a[1])[0]?.[0]||colors.tool;
  lane.color=[...lane.bins].sort((a,b)=>b.count-a.count)[0]?.color||colors.tool;
  lane.markers=clustered(lane.events,budget,windowMs,selectedEvent).map(e=>({...e,row,color:tone(e,palette)}));markers.push(...lane.markers);
 }
 const rows=new Map(shown.flatMap(l=>l.overflow?l.sources.map(s=>[s.id,l.row]):[[l.id,l.row]]));
 const visibleSpans=spans.filter(s=>rows.has(sourceKey(s))&&s.end>=start&&s.start<=reference);
 visibleSpans.sort((a,b)=>Number([b.id,b.startEventId,b.endEventId].includes(selectedEvent))-Number([a.id,a.startEventId,a.endEventId].includes(selectedEvent))||b.end-a.end);
 return {reference,windowMs,total:all.reduce((n,l)=>n+l.count,0),workers:all.length,lanes:shown,order:all.map(l=>l.id),markers,peak,hidden,spanCount:visibleSpans.length,spans:visibleSpans.slice(0,256).map(s=>({...s,row:rows.get(sourceKey(s))}))};
}

export function ribbonLayout(width,height,count){
 const left=clamp(width*.20,Math.min(92,width*.3),206),right=Math.max(left+20,width-(width<520?12:52)),top=Math.min(31,height*.2),bottom=Math.max(top+1,height-13);
 return {width,height,left,right,top,bottom,rowHeight:(bottom-top)/Math.max(1,count),plotWidth:right-left};
}
export const ribbonX=(at,reference,windowMs,layout)=>layout.left+(at-(reference-windowMs))/windowMs*layout.plotWidth;
export function ribbonGapRows(gap,model){return model.lanes.filter(l=>!gap.hostId||l.hostId===gap.hostId||l.overflow&&l.sources.some(s=>s.hostId===gap.hostId)).map(l=>l.row);}

function glyph(ctx,e,x,y,r){
 ctx.beginPath();
 if(e.mixed||e.mixedSources){ctx.rect(x-r,y-r,r*2,r*2);ctx.stroke();ctx.fillRect(x-1,y-1,2,2);}
 else if(failure(e)){ctx.moveTo(x-r,y-r);ctx.lineTo(x+r,y+r);ctx.moveTo(x+r,y-r);ctx.lineTo(x-r,y+r);ctx.stroke();}
 else if(e.kind==='approval'){ctx.moveTo(x,y-r-2);ctx.lineTo(x+r+1,y+r);ctx.lineTo(x-r-1,y+r);ctx.closePath();ctx.stroke();}
 else if(e.category==='edit'){ctx.rect(x-r,y-r,r*2,r*2);ctx.stroke();}
 else if(e.kind?.endsWith('.start')){ctx.moveTo(x,y-r);ctx.lineTo(x+r,y);ctx.lineTo(x,y+r);ctx.lineTo(x-r,y);ctx.closePath();ctx.stroke();}
 else{ctx.arc(x,y,r,0,Math.PI*2);if(e.kind?.endsWith('.end')||e.kind==='complete')ctx.stroke();else ctx.fill();}
}

export class EventRibbon {
 constructor(document){this.layer=document.createElement('canvas');this.model=null;this.order=[];this.geometryKey='';}
 update(input){this.input=input;this.model=null;}
 prepare(width,height,dpr,theme,vivid){
  const key=[width,height,dpr,theme.dark,vivid].join('|');
  if(this.model&&this.geometryKey===key)return false;
  this.geometryKey=key;this.model=projectRibbon({...this.input,previousOrder:this.order,maxLanes:clamp(Math.floor((height-30)/42),2,8)});this.order=this.model.order;
  const model=this.model,layout=this.layout=ribbonLayout(width,height,model.lanes.length);
  this.layer.width=Math.max(1,Math.round(width*dpr));this.layer.height=Math.max(1,Math.round(height*dpr));const g=this.layer.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);
  // Density is projected once per source/scope update, never rescanned per frame.
  for(const lane of model.lanes){
   const y=layout.top+(lane.row+.5)*layout.rowHeight,amplitude=Math.min(22,layout.rowHeight*.31);
   const samples=[0,...lane.bins.map(b=>Math.log1p(b.count)/Math.log1p(model.peak)*amplitude),0],step=layout.plotWidth/48;
   const gradient=g.createLinearGradient(layout.left,0,layout.right,0);
   lane.bins.forEach((b,i)=>gradient.addColorStop((i+.5)/48,b.color));
   const path=side=>{for(let i=0;i<samples.length;i++){const x=layout.left+(i-.5)*step,py=y+side*samples[i];if(i===0)g.moveTo(x,py);else{const px=layout.left+(i-1.5)*step,previousY=y+side*samples[i-1];g.bezierCurveTo(px+step*.5,previousY,x-step*.5,py,x,py);}}};
   g.save();g.beginPath();g.rect(layout.left,layout.top,layout.plotWidth,layout.bottom-layout.top);g.clip();
   g.strokeStyle=gradient;g.lineWidth=1.4;g.shadowColor=lane.color;g.shadowBlur=vivid?10:0;
   for(const side of [-1,1]){g.beginPath();path(side);g.globalAlpha=theme.dark?.8:.85;g.stroke();}
   g.shadowBlur=0;g.globalAlpha=theme.dark?.18:.12;g.fillStyle=gradient;
   g.beginPath();path(-1);for(let i=samples.length-1;i>=0;i--){const x=layout.left+(i-.5)*step;g.lineTo(x,y+samples[i]);}g.closePath();g.fill();
   // Thin category strands make an overflow ribbon readable without suggesting
   // that records from different workers are a single operation.
   const strandColors=[...new Set(lane.bins.flatMap(b=>[...b.categories.keys()]))];
   if(strandColors.length>1)for(const [index,c] of strandColors.entries()){
    g.beginPath();let drawing=false;for(let i=0;i<lane.bins.length;i++){const b=lane.bins[i],n=b.categories.get(c)||0;if(!n){drawing=false;continue;}const x=layout.left+(i+.5)*step,spread=Math.log1p(b.count)/Math.log1p(model.peak)*amplitude,py=y+(index/(strandColors.length-1)-.5)*spread*1.55;drawing?g.lineTo(x,py):g.moveTo(x,py);drawing=true;}g.strokeStyle=c;g.globalAlpha=.85;g.lineWidth=1.5;g.stroke();
   }g.restore();
  }
  return true;
 }
 draw(ctx,{width,height,dpr,now,theme,vivid=true,reduced=false,paused=false,mode='live',selectedEvent='',freshIds=new Set(),gaps=[]}={}){
  const changed=this.prepare(width,height,dpr,theme,vivid),model=this.model,l=this.layout,hits=[];
  ctx.clearRect(0,0,width,height);ctx.font='11px '+(theme.font||'system-ui,sans-serif');ctx.textBaseline='middle';
  const text=theme.text||'#e9f0fa',dim=theme.dim||'#96a8bf';
  for(let i=0;i<=4;i++){const x=l.left+l.plotWidth*i/4;ctx.strokeStyle=theme.line||'#2b394d';ctx.globalAlpha=.65;ctx.setLineDash([2,5]);ctx.beginPath();ctx.moveTo(x,l.top-5);ctx.lineTo(x,l.bottom);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;ctx.fillStyle=i===4?(this.input.palette?.research||dim):dim;ctx.textAlign=i===4?'right':i===0?'left':'center';ctx.fillText(i===4?(mode==='replay'?'CURSOR':'NOW'):'−'+Math.round((1-i/4)*model.windowMs/1000)+'s',x,13);}
  ctx.textAlign='left';
  for(const lane of model.lanes){const y=l.top+(lane.row+.5)*l.rowHeight;ctx.fillStyle=lane.row%2?'#5c93c006':'#5c93c00b';ctx.fillRect(0,l.top+lane.row*l.rowHeight,width,l.rowHeight);ctx.strokeStyle=theme.line||'#2b394d';ctx.globalAlpha=.6;ctx.beginPath();ctx.moveTo(l.left,y);ctx.lineTo(l.right,y);ctx.stroke();ctx.globalAlpha=1;}
  ctx.save();ctx.beginPath();ctx.rect(l.left,l.top,l.plotWidth,l.bottom-l.top);ctx.clip();
  const drift=(now-model.reference)/model.windowMs*l.plotWidth;ctx.drawImage(this.layer,-drift,0,width,height);
  for(const span of model.spans){const x=ribbonX(span.start,now,model.windowMs,l),end=ribbonX(span.end,now,model.windowMs,l),y=l.top+(span.row+.5)*l.rowHeight+Math.min(17,l.rowHeight*.27);ctx.strokeStyle=tone(span,this.input.palette);ctx.lineWidth=2;ctx.globalAlpha=.5;ctx.setLineDash(span.status==='closed'?[]:[3,4]);ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(end,y);ctx.stroke();}ctx.setLineDash([]);ctx.globalAlpha=1;
  for(const gap of gaps){
   const x=clamp(ribbonX(gap.start,now,model.windowMs,l),l.left,l.right),end=clamp(ribbonX(gap.end,now,model.windowMs,l),l.left,l.right);if(end<x||end<=l.left||x>=l.right)continue;
   for(const row of ribbonGapRows(gap,model)){const y=l.top+row*l.rowHeight,w=Math.max(3,end-x);ctx.fillStyle='#ffdb2724';ctx.fillRect(x,y,w,l.rowHeight);ctx.strokeStyle='#ffdb2799';ctx.save();ctx.beginPath();ctx.rect(x,y,w,l.rowHeight);ctx.clip();for(let dx=-l.rowHeight;dx<w;dx+=10){ctx.beginPath();ctx.moveTo(x+dx,y+l.rowHeight);ctx.lineTo(x+dx+l.rowHeight,y);ctx.stroke();}ctx.restore();if(w>42){ctx.fillStyle=theme.dark?'#ffdb27':'#735000';ctx.fillText('GAP',x+4,y+8);}}
  }
  const usedBadges=[];
  for(const e of model.markers){
   const x=ribbonX(e.plotAt,now,model.windowMs,l);if(x<l.left||x>l.right)continue;
   const y=l.top+(e.row+.5)*l.rowHeight,selected=e.members.includes(selectedEvent),r=selected?6:clamp(3+Math.log2(e.count+1),4,7),c=e.color;
   ctx.strokeStyle=c;ctx.fillStyle=c;ctx.lineWidth=selected?2.4:1.7;
   if(vivid){ctx.globalAlpha=.13;ctx.beginPath();ctx.arc(x,y,r+5,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;}
   glyph(ctx,e,x,y,r);hits.push({x,y,event:e});
   if(selected){ctx.strokeStyle=text;ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(x,y,11,0,Math.PI*2);ctx.stroke();}
   const elapsed=now-e.lastAt;if(!reduced&&!paused&&mode==='live'&&elapsed>=0&&elapsed<1800&&e.members.some(id=>freshIds.has(id))){ctx.strokeStyle=c;ctx.globalAlpha=(1-elapsed/1800)*.7;ctx.beginPath();ctx.arc(x,y,8+elapsed/120,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=1;}
   if(e.count>1){const w=12+String(e.count).length*7,bx=x+8,by=y-16;if(bx+w<l.right&&!usedBadges.some(b=>b.row===e.row&&Math.abs(b.x-bx)<w+6)){usedBadges.push({row:e.row,x:bx});ctx.fillStyle=theme.panel||'#101722';ctx.fillRect(bx-2,by-7,w,15);ctx.fillStyle=c;ctx.fillText('×'+e.count,bx,by);}}
  }
  ctx.restore();
  for(const lane of model.lanes){if(width<520)continue;const y=l.top+(lane.row+.5)*l.rowHeight;ctx.fillStyle=dim;ctx.font='10px '+(theme.font||'system-ui,sans-serif');ctx.textAlign='right';ctx.fillText(String(lane.count),width-8,y-10);ctx.fillText('events',width-8,y+3);ctx.textAlign='left';}
  ctx.textBaseline='alphabetic';ctx.globalAlpha=1;
  return {hits,changed,model,layout:l,markers:hits.length};
 }
 describe(){const m=this.model;return m?`${m.total} source records across ${m.workers} workers. Left is older; right is now. Ribbon thickness is event density, not tokens or progress. ${m.markers.length} inspectable visual clusters.`:'No events in this window.';}
}
