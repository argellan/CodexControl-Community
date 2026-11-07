// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// Small stages may share a frame. Once that paint budget is spent, wait for an
// actual paint opportunity: priority task continuations alone can starve frames.
// The timeout settles a frame suspended when the tab becomes hidden.
let channel,paintedAt=-Infinity;const pending=[];
function paintOpportunity(){return new Promise(resolve=>{let frame,timer,after,done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(after);if(frame!==undefined)cancelAnimationFrame(frame);paintedAt=performance.now();resolve();};timer=setTimeout(finish,50);frame=requestAnimationFrame(()=>{after=setTimeout(finish,0);});});}
export function yieldToPaint(){
 if(performance.now()-paintedAt>=8)return paintOpportunity();
 if(typeof globalThis.scheduler?.yield==='function')return globalThis.scheduler.yield();
 if(typeof globalThis.MessageChannel==='function'){channel??=new MessageChannel();channel.port1.onmessage=()=>pending.shift()?.();return new Promise(resolve=>{pending.push(resolve);channel.port2.postMessage(null);});}
 return new Promise(resolve=>setTimeout(resolve,0));
}
export class RenderScheduler{
 constructor({yieldTask=yieldToPaint,active=()=>true,step=fn=>fn()}={}){Object.assign(this,{yieldTask,active,step,generation:0});}
 cancel(){this.generation++;}
 sync(factory){this.cancel();const iterator=factory();try{while(!this.step(()=>iterator.next()).done){/* Explicit interactions finish immediately. */}}finally{iterator.return?.();}}
 async run(factory){const generation=++this.generation,iterator=factory();try{while(generation===this.generation&&this.active()){if(this.step(()=>iterator.next()).done)return true;await this.yieldTask();}return false;}finally{iterator.return?.();}}
}
