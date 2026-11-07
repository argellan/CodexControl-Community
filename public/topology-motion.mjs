// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {packetProgress} from './activity-map-model.mjs';

// Travel depicts a newly observed record, not execution duration or network speed.
export function topologyLegProgress({journey,leg}={},reference,{mode='live',freshIds,arrivalTimes}={}){
 if(!leg||!Number.isFinite(reference)||!Number.isFinite(leg.at)||typeof leg.eventId!=='string'||!leg.eventId||!['live','replay'].includes(mode))return null;
 let observedAt;
 if(mode==='live'){
  if(!(freshIds instanceof Set)||!freshIds.has(leg.eventId)||!(arrivalTimes instanceof Map))return null;
  observedAt=arrivalTimes.get(leg.eventId);if(!Number.isFinite(observedAt))return null;
 }
 const progress=packetProgress({...leg,observedAt},reference,mode,freshIds,leg.eventId);
 if(!Number.isFinite(progress)||progress<0||progress>=1)return null;
 const sharedOperation=mode==='live'&&journey?.kind==='operation'&&Array.isArray(journey.legs)&&
  journey.legs.some(l=>l.eventId===leg.eventId&&l.direction==='outbound')&&
  journey.legs.some(l=>l.eventId===leg.eventId&&l.direction==='return');
 if(!sharedOperation)return progress;
 const elapsed=reference-observedAt;
 if(leg.direction==='outbound')return elapsed<1200?elapsed/1200:null;
 if(leg.direction==='return')return elapsed>=1200?(elapsed-1200)/1200:null;
 return null;
}

// Connectivity and recorded work are separate observations. No status means running.
export function topologyObservationState(node,{mode='live',observationGap=false,reference=Date.now()}={}){
 const source=node?.source&&typeof node.source==='object'?node.source:node||{};
 const lastAt=Number.isFinite(source.lastAt)?source.lastAt:typeof source.lastAt==='string'?Date.parse(source.lastAt):null;
 const age=Number.isFinite(lastAt)&&Number.isFinite(reference)?reference-lastAt:null;
 const recent=age!==null&&age>=0&&age<15000;
 const status=source.status||source.state||'unknown';
 const value=(label,kind,detail)=>({label,kind,detail,lastAt:Number.isFinite(lastAt)?lastAt:null});
 if(source.type==='host'){
  if(mode==='replay')return value('Captured source','unknown','Inventory identifies this source; connectivity at the replay clock was not captured.');
  if(observationGap)return value('Feed unknown','unknown','The observer feed is unavailable; the last collector state does not establish current connectivity.');
  if(status==='online')return value('Collector online','online','A collector heartbeat was captured; this does not establish an active job.');
  if(['offline','disconnected','stale','expired','disabled'].includes(status))return value(status==='stale'?'Collector stale':status==='expired'?'Enrollment expired':status==='disabled'?'Source disabled':'Collector offline','offline','Current collector evidence is unavailable; retained work stays inspectable.');
  return value('Source unknown','unknown','Collector connectivity is not established by the available evidence.');
 }
 if(observationGap&&mode==='live')return value('Feed unknown','unknown','Retained records remain available; current activity is unknown.');
 if(status==='source unavailable')return value('Source unknown','unknown','No current source observation establishes the state of this work.');
 if(status==='waiting for input')return value('Input requested','attention','A captured input request has no matching captured resolution.');
 if(['failed','interrupted'].includes(status))return value('Failure recorded','attention','The source recorded this outcome; acceptance is separate.');
 if(status==='no result observed'||status==='start observed'&&!recent)return value('No captured result','unknown','A start was captured without a matching result; this does not establish running work.');
 const labels={'result recorded':'Result recorded','operation recorded':'Operation recorded','completed on target':'Target completion recorded','resolution recorded':'Resolution recorded','result without start':'Result recorded / no start','start observed':'Start recorded','progress observed':'Progress reported','recent record':'Recent record','last observed':'Retained record'};
 const label=labels[status]||(source.resultObserved===true?'Result recorded':source.type==='service'?'Interface observed':'Last observation');
 if(recent)return value(label,'recent','The source recorded activity recently; this does not establish ongoing execution.');
 if(Number.isFinite(lastAt))return value(label,'retained','Retained source evidence remains inspectable; no current execution is established.');
 return value(label,'unknown','No valid source timestamp establishes the recency of this observation.');
}
