// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import crypto from 'node:crypto';
const time=v=>{const n=typeof v==='number'?v:typeof v==='string'?Date.parse(v):NaN;return Number.isSafeInteger(n)&&n>=0&&n<=8640000000000000?n:null;};
const percent=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100;
const safe=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v.isWellFormed()&&!/[\x00-\x1f\x7f]/.test(v);

// Forecasts compare one source's actual allowance readings. They do not
// convert tokens into subscription usage or pool independent quota windows.
export function deriveQuotaPace(observations,{now=Date.now(),minimumSpanMs=1800000,maximumGapMs=900000}={}){
 if(!Array.isArray(observations)||observations.length>512||time(now)===null||!Number.isSafeInteger(minimumSpanMs)||minimumSpanMs<60000||!Number.isSafeInteger(maximumGapMs)||maximumGapMs<60000)throw new Error('Invalid quota pace input');
 const groups=new Map();
 for(const entry of observations){const at=time(entry?.limitsAt),received=time(entry?.receivedAt),report=entry?.accountUsage;if(!safe(entry?.hostId)||at===null||received===null||at>now||received>now||!report||!Array.isArray(report.limits))continue;
  for(const limit of report.limits.slice(0,8))for(const window of ['primary','secondary']){const value=limit?.[window];if(!safe(limit?.limitId)||!value||!percent(value.usedPercent)||!Number.isSafeInteger(value.windowDurationMins)||value.windowDurationMins<1||!Number.isSafeInteger(value.resetsAt)||value.resetsAt*1000<=now||time(value.resetsAt*1000)===null)continue;
   const key=JSON.stringify([entry.hostId,entry.identity??'unlinked',report.planType,limit.limitId,window,value.windowDurationMins,value.resetsAt]);
   if(!groups.has(key))groups.set(key,{hostId:entry.hostId,limitId:limit.limitId,window,windowDurationMins:value.windowDurationMins,resetsAt:new Date(value.resetsAt*1000).toISOString(),points:new Map()});
   const group=groups.get(key),old=group.points.get(at);if(old===undefined)group.points.set(at,value.usedPercent);else if(old!==value.usedPercent)group.points.set(at,null);
  }
 }
 const latest=new Map();for(const group of groups.values()){const identity=JSON.stringify([group.hostId,group.limitId,group.window]),at=Math.max(...group.points.keys());latest.set(identity,Math.max(latest.get(identity)??0,at));}
 return [...groups.entries()].slice(0,128).map(([key,group])=>{
  const points=[...group.points].sort((a,b)=>a[0]-b[0]),tail=[];let boundary=null;
  for(const point of points){const previous=tail.at(-1);if(point[1]===null){tail.length=0;boundary='conflicting-source-time';continue;}if(previous&&(point[0]-previous[0]>maximumGapMs||point[1]<previous[1])){tail.length=0;boundary=point[1]<previous[1]?'allowance-regressed':'capture-gap';}tail.push(point);}
  const first=tail[0],last=tail.at(-1),span=first&&last?last[0]-first[0]:0,superseded=!!last&&last[0]<latest.get(JSON.stringify([group.hostId,group.limitId,group.window])),stale=!last||now-last[0]>300000,comparable=!stale&&!superseded&&tail.length>=3&&span>=minimumSpanMs;
  const perHour=comparable?(last[1]-first[1])*3600000/span:null,remaining=last?100-last[1]:null,runwayHours=perHour>0?remaining/perHour:null,positiveSlopes=[];
  for(let i=1;i<tail.length;i++){const slope=(tail[i][1]-tail[i-1][1])*3600000/(tail[i][0]-tail[i-1][0]);if(slope>0)positiveSlopes.push(slope);}
  const range=comparable&&positiveSlopes.length?{fastHours:remaining/Math.max(...positiveSlopes),slowHours:remaining/Math.min(...positiveSlopes)}:null;
  return {id:'quota-pace-'+crypto.createHash('sha256').update(key).digest('hex').slice(0,16),hostId:group.hostId,limitId:group.limitId,window:group.window,windowDurationMins:group.windowDurationMins,resetsAt:group.resetsAt,status:comparable?'estimated':'unavailable',classification:'estimated',usedPercent:last?.[1]??null,remainingPercent:remaining,observedAt:last?new Date(last[0]).toISOString():null,observations:tail.length,spanMs:span,percentagePointsPerHour:perHour,runwayHours,runwayRange:range,minimumSpanMs,maximumGapMs,boundary,reason:superseded?'superseded-source-window':stale?'stale-source':tail.length<3?'insufficient-distinct-readings':span<minimumSpanMs?'insufficient-time-span':perHour===0?'no-observed-increase':null,scope:'single-source allowance window',caveat:'Conditional forecast from comparable source readings, not a guarantee or token-to-quota conversion. Source continuity is assumed; provider-account identity across machines is not established.'};
 });
}
