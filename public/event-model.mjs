// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {canonicalSessions} from './ui-model.mjs';

const retainedKinds=new Set(['turn','complete','error','approval','resolution','operation','tool.start','tool.end','message','remote.start','remote.end','remote.progress']);
const retainedTextFields='id sourceId sessionId project turnId at timeOrigin receivedAt delivery kind label category callId startedAt completedAt outcome childId requestId hostId hostName jobId workerHostId workerSessionId workerCallId'.split(' ');
// Old journal records remain evidence; project only primitive, well-formed text.
// Invalid identity/kind/time records are quarantined from visual consumers.
export function canonicalEvents(value){
 const result=[];
 for(const event of (Array.isArray(value)?value:[]).slice(-20000)){
  if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.id!=='string'||!event.id||typeof event.sessionId!=='string'||!event.sessionId||typeof event.at!=='string'||!Number.isFinite(Date.parse(event.at))||!retainedKinds.has(event.kind))continue;
  const normalized={...event};for(const key of retainedTextFields)if(Object.hasOwn(event,key))normalized[key]=typeof event[key]==='string'?event[key].replace(/[\x00-\x1f\x7f]/g,'').slice(0,512).toWellFormed():null;
  if(!normalized.id||!normalized.sessionId)continue;
  normalized.at=new Date(event.at).toISOString();normalized.label=typeof normalized.label==='string'&&normalized.label.trim()?normalized.label:event.kind;
  // Preserve this optional typed fact only. Legacy and malformed optional
  // fields remain ordinary events, without inferred compaction semantics.
  if(event.kind==='operation'&&event.operationType==='context-compaction')normalized.operationType='context-compaction';else delete normalized.operationType;
  for(const key of ['offset','exitCode'])if(Object.hasOwn(event,key))normalized[key]=typeof event[key]==='number'&&Number.isFinite(event[key])?event[key]:null;
  if(Object.hasOwn(event,'progress'))normalized.progress=typeof event.progress==='number'&&Number.isFinite(event.progress)&&event.progress>=0&&event.progress<=100?event.progress:null;
  result.push(normalized);
 }
 return result;
}

// Pure shared projection: the canvas, timeline, inspector and tests use these IDs and clocks.
const eventTimes=new WeakMap();
export function eventTime(e){
 const owner=Date,parse=owner.parse,at=e.at;
 if(typeof at!=='string'||e===null||typeof e!=='object'&&typeof e!=='function')return parse.call(owner,at);
 let descriptor;try{descriptor=Object.getOwnPropertyDescriptor(e,'at');}catch{return parse.call(owner,at);}
 // Accessors, inherited values and coercible objects retain direct parsing.
 if(!descriptor||!Object.hasOwn(descriptor,'value')||descriptor.value!==at)return parse.call(owner,at);
 const cached=eventTimes.get(e);if(cached&&cached.at===at&&cached.parse===parse&&cached.owner===owner)return cached.time;
 const time=parse.call(owner,at);eventTimes.set(e,{at,parse,owner,time});return time;
}
export const matchesCategory=(e,category)=>!category||(category==='error'?(e.kind==='error'||e.category==='error'||['failed','interrupted'].includes(e.outcome)):e.category===category||e.kind===category);
export function visibleEvents(events,reference,windowMs,filter={}){
 return events.filter(e=>{const t=eventTime(e),host=!filter.hostId||e.hostId===filter.hostId||filter.includeRelated&&e.workerHostId===filter.hostId,session=!filter.sessionId||e.sessionId===filter.sessionId&&(!filter.sessionHostId||e.hostId===filter.sessionHostId)||filter.includeRelated&&e.workerSessionId===filter.sessionId&&(!filter.sessionHostId||e.workerHostId===filter.sessionHostId);return t<=reference&&t>=reference-windowMs&&host&&session&&(!filter.project||e.project===filter.project)&&matchesCategory(e,filter.category)&&(!filter.search||(e.label+' '+e.project+' '+e.sessionId).toLowerCase().includes(filter.search.toLowerCase()));});
}
export function buildSpans(...args){const iterator=buildSpanStages(...args);let step;do{step=iterator.next();}while(!step.done);return step.value;}
export function* buildSpanStages(events,reference,observations={}){
 const spans=[],calls=new Map();
 let scanned=0;const key=e=>JSON.stringify([e.hostId,e.sourceId,e.sessionId,e.turnId,e.callId||e.id]);
 for(const e of events){
  if(++scanned%512===0)yield;
  if(eventTime(e)>reference)continue;
  if(e.kind==='operation'){
   const start=Date.parse(e.startedAt),end=Date.parse(e.completedAt);
   const valid=Number.isFinite(start)&&Number.isFinite(end)&&end>=start;
   spans.push({id:e.id,eventId:e.id,sessionId:e.sessionId,hostId:e.hostId,label:e.label,category:e.category,start:Number.isFinite(start)?start:eventTime(e),end:Number.isFinite(end)?end:eventTime(e),durationMs:valid?end-start:null,status:valid?'closed':Number.isFinite(start)&&Number.isFinite(end)?'invalid':'orphan',outcome:e.outcome});
  }else if(['tool.start','tool.end','remote.start','remote.end'].includes(e.kind)){
   const k=key(e);let pair=calls.get(k);if(!pair){pair={};calls.set(k,pair);}if(e.kind.endsWith('.start'))pair.start=e;else pair.end=e;
  }
 }
 for(const pair of calls.values()){
  if(++scanned%512===0)yield;
  const e=pair.start||pair.end,start=pair.start?eventTime(pair.start):null,end=pair.end?eventTime(pair.end):null;
  const observed=Math.min(reference,observations[(e.hostId||'local')+'/'+e.sessionId]??observations[e.sessionId]??reference);
  spans.push({id:e.id,eventId:pair.end?.id||e.id,sessionId:e.sessionId,hostId:e.hostId,workerHostId:e.workerHostId,workerSessionId:e.workerSessionId,label:pair.start?.label||'Result · start unavailable',category:pair.start?.category||'tool',start:start??end,end:end??Math.max(start,observed),durationMs:start!==null&&end!==null&&end>=start?end-start:null,status:start===null?'orphan':end===null?'open':end<start?'invalid':'closed',outcome:pair.end?.outcome||'unconfirmed',startEventId:pair.start?.id,endEventId:pair.end?.id});
 }
 return spans.sort((a,b)=>a.start-b.start||a.id.localeCompare(b.id));
}
export function aggregateEvents(events,ceiling=350,binMs=100){
 if(events.length<=ceiling)return events.map(e=>({...e,count:1,members:[e.id]}));
 const groups=new Map(),result=[];
 for(const e of events){
  if(e.outcome==='failed'||e.kind==='error'||e.kind==='approval'){result.push({...e,count:1,members:[e.id]});continue;}
  const key=[e.sourceId,e.sessionId,e.kind,e.category,Math.floor(eventTime(e)/binMs)].join('|');
  if(!groups.has(key))groups.set(key,{...e,count:0,members:[],binMs});const g=groups.get(key);g.count++;g.members.push(e.id);
 }
 if(groups.size>ceiling&&binMs<3600000)return aggregateEvents(events,ceiling,binMs*2);
 return [...result,...groups.values()];
}
function replayWindow(bounds,windowMs,observed){
 if(!windowMs)return [...bounds];
 const end=Math.min(bounds[1],Number.isFinite(observed)?observed:bounds[1]);
 return [Math.min(end,Math.max(bounds[0],end-windowMs)),end];
}
export class EventStore {
 constructor(){this.events=new Map();this.cacheOrder=new Map();this.cacheArrival=0;this.seenIds=new Map();this.latestSequence=0;this.journalEpoch=null;this.sessions=[];this.hosts=[];this.initialized=false;this.mode='live';this.gaps=[];this.disconnectedAt=null;this.playing=false;this.speed=1;this.clock=0;this.frozen=null;this.lastObserved=0;this.newTotal=0;}
 ingest(snapshot){
  const observed=Date.parse(snapshot.observedAt),gap=this.disconnectedAt!==null||this.initialized&&observed-this.lastObserved>10000,fresh=[];
  const epoch=snapshot.history?.epoch,reportedSequence=snapshot.history?.latestSequence;
  // Restoring an older journal keeps its epoch. A current hub snapshot reports
  // the global sequence even for scoped reads; stale responses cannot reset it.
  const rolledBack=epoch===this.journalEpoch&&Number.isSafeInteger(reportedSequence)&&reportedSequence>=0&&reportedSequence<this.latestSequence&&Number.isFinite(observed)&&observed>=this.lastObserved;
  if(typeof epoch==='string'&&(epoch!==this.journalEpoch||rolledBack)){this.journalEpoch=epoch;this.latestSequence=0;}
  const previousSequence=this.latestSequence;
  if(gap){this.gaps.push({start:this.disconnectedAt??this.lastObserved,end:observed});this.gaps=this.gaps.slice(-40);this.disconnectedAt=null;}
  for(const e of canonicalEvents(snapshot.events)){
   const sequence=Number.isSafeInteger(e.journalSequence)&&e.journalSequence>0?e.journalSequence:0,seen=this.seenIds.has(e.id)||sequence>0&&sequence<=previousSequence;
   this.latestSequence=Math.max(this.latestSequence,sequence);
   if(this.events.has(e.id))continue;this.events.set(e.id,e);
   // Hub receipt time is assigned after collector authentication; source clocks
   // remain evidence, never a browser-cache retention priority. Old backfill
   // keeps its receipt order even when fetched after current activity.
   const received=Date.parse(e.receivedAt),arrival=++this.cacheArrival;
   this.cacheOrder.set(e.id,{received:Number.isFinite(received)?received:Number.isFinite(observed)?observed:0,sequence,arrival});
   this.seenIds.set(e.id,true);
   if(!seen&&this.initialized&&!gap&&this.mode==='live'&&e.delivery!=='bootstrap'&&e.delivery!=='backfill'&&eventTime(e)>this.lastObserved-3000&&eventTime(e)<=observed+1000)fresh.push(e);
  }
  if(this.events.size>20000){const sorted=[...this.events.keys()].sort((a,b)=>{const x=this.cacheOrder.get(a),y=this.cacheOrder.get(b);return x.received-y.received||x.sequence-y.sequence||x.arrival-y.arrival;});for(const id of sorted.slice(0,sorted.length-20000)){this.events.delete(id);this.cacheOrder.delete(id);}}
  while(this.seenIds.size>40000)this.seenIds.delete(this.seenIds.keys().next().value);
  const retainedFresh=fresh.filter(e=>this.events.has(e.id));
  this.sessions=canonicalSessions(snapshot.sessions);this.hosts=snapshot.hosts||[];this.lastObserved=observed;this.initialized=true;this.newTotal+=retainedFresh.length;return retainedFresh;
 }
 disconnect(now){if(this.disconnectedAt===null)this.disconnectedAt=now;}
 enterReplay(at,windowMs){this.mode='replay';this.frozen=[...this.events.values()];this.frozenSessions=structuredClone(this.sessions);this.frozenHosts=structuredClone(this.hosts);this.replayGaps=structuredClone(this.gaps);this.replayObserved=this.lastObserved;this.fullBounds=this.frozen.length?[Math.min(...this.frozen.map(eventTime)),Math.max(...this.frozen.map(eventTime))]:[this.lastObserved,this.lastObserved];this.bounds=replayWindow(this.fullBounds,windowMs,this.replayObserved);this.clock=Math.max(this.bounds[0],Math.min(this.bounds[1],at??this.bounds[0]));this.playing=false;}
 setReplayWindow(windowMs){this.bounds=replayWindow(this.fullBounds,windowMs,this.replayObserved);this.seek(this.clock);}
 enterHistoryReplay(events){this.enterReplay();this.frozen=canonicalEvents(events).slice(0,1000);this.frozenHosts=this.hosts.map(h=>({...h,status:'historical / unknown',telemetry:null,gaps:[]}));this.historyReplay=true;this.fullBounds=this.frozen.length?[Math.min(...this.frozen.map(eventTime)),Math.max(...this.frozen.map(eventTime))]:[this.lastObserved,this.lastObserved];this.bounds=[...this.fullBounds];this.clock=this.bounds[1];}
 seek(at){this.clock=Math.max(this.bounds[0],Math.min(this.bounds[1],at));}
 advance(milliseconds){if(this.mode==='replay'&&this.playing){this.seek(this.clock+milliseconds*this.speed);if(this.clock>=this.bounds[1])this.playing=false;}}
 goLive(){this.mode='live';this.frozen=null;this.frozenSessions=null;this.playing=false;this.historyReplay=false;}
 viewEvents(){return this.mode==='replay'?this.frozen:[...this.events.values()];}
 viewHosts(){return this.mode==='replay'?this.frozenHosts:this.hosts;}
 viewSessions(){return this.mode==='replay'?this.frozenSessions:this.sessions;}
 referenceTime(now=Date.now()){return this.mode==='replay'?this.clock:now;}
}
