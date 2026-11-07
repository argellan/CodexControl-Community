// Elapsed-time interpolation with original-renderer fallback. Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
export class NativeTimelineMotion {
 constructor({timeline}={}){this.timeline=timeline;this.items=new Map();this.generation=0;this.sampleTime=null;this.counts={created:0,cancelled:0,reused:0,fallbacks:0,driftRebases:0};}
 begin(time){this.generation++;this.sampleTime=Number.isFinite(time)?time:null;}
 cancel(element){const item=this.items.get(element);if(item){item.animation.cancel();this.items.delete(element);this.counts.cancelled++;}}
 cancelAll(){for(const element of [...this.items.keys()])this.cancel(element);}
 end(){for(const [element,item] of this.items)if(item.generation!==this.generation)this.cancel(element);}
 translate(element,{enabled,x,velocity,reference,identity,expires}){
  // The caller may pair a source reference with performance.now(), whose origin
  // matches the default document timeline without its frozen-frame delay.
  const timelineTime=this.timeline?.currentTime,documentTime=this.sampleTime??timelineTime;
  if(!Number.isFinite(timelineTime)||!enabled||typeof element?.animate!=='function'||![x,velocity,reference,expires,documentTime].every(Number.isFinite)||expires-reference<32||velocity===0){this.cancel(element);return false;}
  const old=this.items.get(element),expected=old?old.x+old.velocity*(documentTime-old.documentTime):null;
  if(old&&old.identity===identity&&old.velocity===velocity&&reference>=old.reference&&reference<old.expires&&Math.abs(expected-x)<=.05){old.generation=this.generation;this.counts.reused++;return true;}
  if(old&&old.identity===identity&&Math.abs(expected-x)>.05)this.counts.driftRebases++;
  this.cancel(element);
  const duration=Math.min(60000,expires-reference),to=x+velocity*duration;
  let animation;try{animation=element.animate([{transform:`translateX(${x.toFixed(3)}px)`},{transform:`translateX(${to.toFixed(3)}px)`}],{duration,easing:'linear',fill:'both'});animation.startTime=documentTime;this.items.set(element,{animation,x,velocity,reference,documentTime,identity,expires:reference+duration,generation:this.generation});this.counts.created++;return true;}catch{try{animation?.cancel();}catch{}this.counts.fallbacks++;return false;}
 }
 diagnostics(){return {active:this.items.size,...this.counts};}
}
