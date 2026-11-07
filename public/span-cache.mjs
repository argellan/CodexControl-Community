// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {buildSpans,eventTime} from './event-model.mjs';

// This cache consumes the observer's append-only, immutable captured record
// objects. It is a presentation projection only; replay, eviction or replacement
// of an input prefix rebuilds it. Open operations still follow the source clock.
export class CapturedSpanCache{
 constructor(){this.events=[];this.groups=new Map();this.operations=[];this.reference=-Infinity;this.nextEligible=Infinity;}
 *project(events,reference,observations={}){
  const append=reference>=this.reference&&reference<this.nextEligible&&events.length>=this.events.length&&this.events.every((event,index)=>event===events[index]);
  const groups=new Map(append?this.groups:[]),operations=append?[...this.operations]:[],changed=new Set();let nextEligible=append?this.nextEligible:Infinity,scanned=0;
  for(let i=append?this.events.length:0;i<events.length;i++){
   if(++scanned%512===0)yield;const event=events[i],at=eventTime(event);if(at>reference){nextEligible=Math.min(nextEligible,at);continue;}
   if(event.kind==='operation'){operations.push(...buildSpans([event],reference,observations));continue;}
   if(!['tool.start','tool.end','remote.start','remote.end'].includes(event.kind))continue;
   const key=JSON.stringify([event.hostId,event.sourceId,event.sessionId,event.turnId,event.callId||event.id]);
   let group=groups.get(key);if(!changed.has(key)){group={...group};groups.set(key,group);changed.add(key);}group[event.kind.endsWith('.start')?'start':'end']=event;
  }
  const spans=[...operations];for(const [key,group] of groups){
   if(++scanned%512===0)yield;let span=group.span;
   if(!span||changed.has(key)||!group.end){const next=buildSpans([group.start,group.end].filter(Boolean),reference,observations)[0];if(!span||changed.has(key)||span.end!==next.end){span=next;groups.set(key,{...group,span});}}
   spans.push(span);
  }
  spans.sort((a,b)=>a.start-b.start||a.id.localeCompare(b.id));
  this.events=[...events];this.groups=groups;this.operations=operations;this.reference=reference;this.nextEligible=nextEligible;return spans;
 }
}
