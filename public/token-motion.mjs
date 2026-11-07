// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {topologyCurve} from './topology-map.mjs';
import {DEFAULT_TOKEN_PALETTE} from './token-palette.mjs';

// These packets represent batches of observed token-counter increases. They are
// not dollar amounts, individual streamed tokens, or measured network transfers.
export const TOKEN_KINDS=DEFAULT_TOKEN_PALETTE.series;
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const at=value=>typeof value==='number'?value:Date.parse(value);
const workerId=row=>'worker:'+row.hostId+'/'+row.sessionId;
const providerKnown=row=>typeof row?.provider==='string'&&['openai','codex'].includes(row.provider.toLowerCase());
const validRow=row=>row&&integer(row.sequence)&&row.sequence>0&&typeof row.id==='string'&&row.id.length<=128&&typeof row.hostId==='string'&&typeof row.sessionId==='string';
const freshRow=(row,now)=>['delta','partial'].includes(row.status)&&Number.isFinite(at(row.receivedAt))&&now-at(row.receivedAt)>=-2000&&now-at(row.receivedAt)<=15000&&Number.isFinite(at(row.sourceAt))&&now-at(row.sourceAt)>=-2000&&now-at(row.sourceAt)<=15000;
const cursorPrefix='codexcontrol-token-cursor-v1:';
function hash(value){let h=2166136261;for(const c of value){h^=c.codePointAt(0);h=Math.imul(h,16777619);}return (h>>>0).toString(16);}

export class TokenMotion{
 constructor({storage=null,maxPackets=48}={}){this.storage=storage;this.maxPackets=Math.min(48,Math.max(1,maxPackets|0));this.key=null;this.cursor=0;this.packets=[];this.rows=[];this.burn=null;this.mode='live';this.sequence=0;this.needsPrime=false;}
 setStorage(storage){this.storage=storage;}
 clear(){this.packets=[];}
 // Called on view/clock changes even when the usage feed has not polled yet.
 setMode(mode){mode=mode==='replay'?'replay':'live';if(mode!==this.mode){this.mode=mode;this.clear();this.key=null;}}
 feed(payload,{scope='all',mode='live',now=Date.now(),reduced=false,paused=false}={}){
  this.setMode(mode);const burn=payload?.burnUsage,history=payload?.usageHistory;
  if(!burn||typeof burn.epoch!=='string'||!burn.epoch||burn.epoch.length>128||!integer(burn.lastSequence??burn.latestSequence)){this.clear();this.key=null;this.rows=[];this.burn=null;return this.state();}
  const sequence=burn.lastSequence??burn.latestSequence,key=cursorPrefix+hash(burn.epoch+'\n'+String(scope));
  if(key===this.key&&sequence<this.sequence)return this.state();
  const rows=[...new Map((Array.isArray(history?.observations)?history.observations:[]).filter(row=>validRow(row)&&row.sequence<=sequence).map(row=>[row.sequence,row])).values()].sort((a,b)=>a.sequence-b.sequence).slice(-512);
  this.rows=rows;this.burn=burn;this.sequence=sequence;
  if(key!==this.key){this.key=key;let saved=0;try{const value=Number(this.storage?.getItem(key));if(integer(value))saved=value;}catch{}this.cursor=Math.max(saved,sequence);this.clear();this.needsPrime=mode!=='live'||reduced||paused;this.persist();return this.state();}
  // Suppression consumes the watermark. Returning from replay, pause or reduced
  // motion cannot turn a retained counter batch into a new burst.
  const previous=this.cursor;this.cursor=Math.max(previous,sequence);this.persist();
  this.packets=this.packets.filter(packet=>now<packet.start+packet.duration);
  if(mode!=='live'||reduced||paused){this.clear();this.needsPrime=true;return this.state();}
  if(this.needsPrime){this.needsPrime=false;this.clear();return this.state();}
  const candidates=rows.filter(row=>row.sequence>previous&&freshRow(row,now)&&providerKnown(row));
  const additions=[];
  for(const row of candidates.slice(-16))for(const [kind,definition] of Object.entries(TOKEN_KINDS)){
   const amount=row[definition.field];if(!integer(amount)||amount===0)continue;
   const count=Math.min(4,1+Math.floor(Math.log10(amount))),duration=2400;
   for(let i=0;i<count;i++)additions.push({id:row.id+':'+kind+':'+i,observationId:row.id,sequence:row.sequence,workerId:workerId(row),kind,amount,representedTokens:amount/count,start:now+i*130+(kind==='cached'?65:kind==='output'?130:0),duration});
  }
  // Fairly preserve at least one marker per observed worker/kind before extras.
  const first=new Map();for(const packet of additions)if(!first.has(packet.observationId+':'+packet.kind))first.set(packet.observationId+':'+packet.kind,packet);
  const ordered=[...first.values(),...additions.filter(packet=>!first.has(packet.observationId+':'+packet.kind)||first.get(packet.observationId+':'+packet.kind)!==packet)];
  this.packets=[...ordered.slice(0,this.maxPackets),...this.packets].slice(0,this.maxPackets);return this.state();
 }
 persist(){try{
  const storage=this.storage;if(!storage||typeof storage.key!=='function'||typeof storage.removeItem!=='function'||typeof storage.setItem!=='function')return;
  const size=storage.length;if(!integer(size))return;const owned=[];
  // Enumerate before removal because Storage.key indexes shift after deletion.
  // Only our numeric watermarks are pruned; credentials and display preferences
  // in the same store are never read or removed.
  for(let i=0;i<size;i++){const key=storage.key(i);if(typeof key==='string'&&key.startsWith(cursorPrefix))owned.push(key);}
  const limit=owned.includes(this.key)?32:31,remove=Math.max(0,owned.length-limit);
  for(const key of owned.filter(key=>key!==this.key).slice(0,remove))storage.removeItem(key);
  storage.setItem(this.key,String(this.cursor));
 }catch{}}
 hasPending(now,{mode='live',reduced=false,paused=false}={}){
  this.setMode(mode);if(mode!=='live'||reduced||paused){this.clear();this.needsPrime=true;return false;}
  let keep=0;for(const packet of this.packets)if(now<packet.start+packet.duration)this.packets[keep++]=packet;this.packets.length=keep;return keep>0;
 }
 // The overlay visits immutable packet identities without allocating a cloned
 // packet and temporary arrays on every browser frame. The public frame helper
 // retains its value-returning behavior for other consumers.
 visitFrame(now,options,visit){
  if(!this.hasPending(now,options))return 0;let count=0;
  for(const packet of this.packets)if(now>=packet.start){visit(packet,(now-packet.start)/packet.duration);count++;}return count;
 }
 frame(now,options={}){const result=[];this.visitFrame(now,options,(packet,progress)=>result.push({...packet,progress}));return result;}
 state(){return {cursor:this.cursor,packets:this.packets.length,rows:this.rows,burn:this.burn};}
}

// Usage is drawn on a separate, explicitly labeled model-usage channel. It never
// borrows a command, GitHub or execution-target route from the event graph.
export function projectTokenChannels(layout,rows=[]){
 if(!layout)return {anchor:null,channels:[],mapped:0,unmapped:0};
 const actors=new Map(layout.nodes.filter(actor=>!actor.hidden&&['worker','subagent'].includes(actor.node.type)).map(actor=>[actor.node.id,actor])),workers=new Map();let unmapped=0;
 for(const row of rows){if(!validRow(row)||!['delta','partial'].includes(row.status))continue;const id=workerId(row);if(!providerKnown(row)||!actors.has(id)){unmapped++;continue;}workers.set(id,row);}
 if(!workers.size)return {anchor:null,channels:[],mapped:0,unmapped};
 const candidates=[];for(const y of [58,layout.height-84,layout.height*.5])for(const x of [layout.width-88,layout.width*.72,layout.width*.60]){
  let clearance=Infinity;for(const actor of layout.nodes.filter(a=>!a.hidden))clearance=Math.min(clearance,Math.hypot(actor.x-x,actor.y-y));candidates.push({x,y,radius:17,clearance});
 }
 const anchor=candidates.sort((a,b)=>b.clearance-a.clearance||b.x-a.x||a.y-b.y)[0],channels=[];
 for(const [id,row] of workers){const actor=actors.get(id);channels.push({workerId:id,row,input:topologyCurve(actor,anchor,{width:layout.width,height:layout.height,kind:'outbound',side:-1}),output:topologyCurve(anchor,actor,{width:layout.width,height:layout.height,kind:'return',side:-1})});}
 return {anchor,channels,mapped:workers.size,unmapped};
}

function paintTokenCoin(ctx,x,y,kind,progress,{vivid=true,palette=DEFAULT_TOKEN_PALETTE}={}){
 const definition=palette.series[kind];if(!definition)return;
 const radius=5.5,face=Math.max(.24,Math.abs(Math.cos(progress*Math.PI*3)));
 ctx.save();ctx.translate(x,y);ctx.globalAlpha=.95;ctx.fillStyle=definition.color;ctx.strokeStyle=definition.color;ctx.shadowColor=definition.color;ctx.shadowBlur=vivid?10:0;ctx.lineWidth=1.1;
 ctx.beginPath();if(typeof ctx.ellipse==='function')ctx.ellipse(0,0,radius*face,radius,0,0,Math.PI*2);else ctx.arc(0,0,radius,0,Math.PI*2);ctx.fill();
 ctx.shadowBlur=0;ctx.fillStyle=palette.face;ctx.beginPath();if(typeof ctx.ellipse==='function')ctx.ellipse(0,0,radius*.66*face,radius*.66,0,0,Math.PI*2);else ctx.arc(0,0,radius*.66,0,Math.PI*2);ctx.fill();
 if(face>.55&&typeof ctx.fillText==='function'){ctx.fillStyle=definition.color;ctx.font='bold 7px monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(definition.glyph,0,.5);}ctx.restore();
}

// Keep at most 144 small, high-resolution sprites (about 2.25 MiB of pixels)
// across palette/theme/glow choices and 24 rotation poses. Travel remains
// continuous; only the face is sampled. Rasterization is reused until eviction.
const coinSprites=new Map(),coinPoses=24,coinSize=32,coinScale=2;
function coinSprite(kind,pose,vivid,palette){
 const key=palette.id+':'+kind+':'+Number(vivid)+':'+pose;if(coinSprites.has(key))return coinSprites.get(key);
 let canvas;if(typeof globalThis.OffscreenCanvas==='function')canvas=new OffscreenCanvas(coinSize*coinScale,coinSize*coinScale);
 else if(typeof globalThis.document?.createElement==='function'){canvas=document.createElement('canvas');canvas.width=canvas.height=coinSize*coinScale;}
 const painter=canvas?.getContext?.('2d');if(!painter)return null;
 painter.scale(coinScale,coinScale);paintTokenCoin(painter,coinSize/2,coinSize/2,kind,pose/coinPoses/3,{vivid,palette});if(coinSprites.size>=144)coinSprites.delete(coinSprites.keys().next().value);coinSprites.set(key,canvas);return canvas;
}
export function drawTokenCoin(ctx,x,y,kind,progress,{vivid=true,palette=DEFAULT_TOKEN_PALETTE}={}){
 if(!TOKEN_KINDS[kind])return;
 if(typeof ctx.drawImage==='function'){
  const phase=((progress*3)%1+1)%1,pose=Math.round(phase*coinPoses)%coinPoses,sprite=coinSprite(kind,pose,vivid,palette);
  if(sprite){ctx.drawImage(sprite,x-coinSize/2,y-coinSize/2,coinSize,coinSize);return;}
 }
 paintTokenCoin(ctx,x,y,kind,progress,{vivid,palette});
}
