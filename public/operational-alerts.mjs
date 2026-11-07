// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {buildUsageSummary} from './worker-model.mjs';

// Presentation evidence only. These records never resolve approvals, attribute
// host resource use to a job, or change a worker/provider/source state.
const text=(value,max=120)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,max):'';
const time=value=>{const number=typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(number)?number:null;};
const percent=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100;
const threshold=(value,fallback,min=0,max=100)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max?value:fallback;
const identityPart=value=>encodeURIComponent(String(value??'').toWellFormed());
const identity=parts=>parts.map(identityPart).join(':');
const threadKey=event=>identity([event.hostId,event.sourceId,event.sessionId]);
const callKey=event=>identity([event.hostId,event.sourceId,event.sessionId,event.turnId,event.callId]);
const identityFields=['hostId','sourceId','sessionId','id','turnId','callId','kind'];
function stringIdentity(event){
 // Accessors, inherited fields and coercible values keep the original read and
 // String-conversion order, including call fields on non-tool records.
 try{for(const key of identityFields){const field=Object.getOwnPropertyDescriptor(event,key);if(field){if(!('value' in field)||field.value!==null&&field.value!==undefined&&typeof field.value!=='string')return false;}else if(key in event)return false;}}catch{return false;}
 return true;
}
const stamp=value=>new Date(value).toISOString();
const base=(id,kind,hostId,at,label)=>({id,kind,category:'error',hostId,at:stamp(at),sourceAt:stamp(at),label,priority:1,attention:true,severity:'warning'});
const format=value=>Number(value.toFixed(1));

function freshHost(host,now,ttl){
 if(!host||typeof host.id!=='string'||!host.id||host.status!=='online')return null;
 const source=time(host.sourceObservedAt??host.receivedAt),received=time(host.receivedAt);
 if(source===null||source>now||now-source>ttl)return null;
 if(host.receivedAt!==undefined&&host.receivedAt!==null&&(received===null||received>now||now-received>ttl))return null;
 return source;
}

// Input collections are already bounded by the observer/browser ring. Scan
// limits also prevent an accidentally unbounded imported collection from
// monopolizing the main thread; the result itself never exceeds forty rows.
export function* operationalAlertStages({events=[],sessions=[],hosts=[],usage=null,burnSpikes=[],now=Date.now(),thresholds={}}={}){
 const timestamp=time(now);if(timestamp===null)return [];
 const ttl=threshold(thresholds?.sourceStaleSeconds,15,5,3600)*1000;
 const toolAge=threshold(thresholds?.toolUnansweredSeconds,15,5,3600)*1000;
 const cpuLimit=threshold(thresholds?.cpuPercent,90),memoryLimit=threshold(thresholds?.memoryPercent,90),quotaLimit=threshold(thresholds?.quotaRemainingPercent,10);
 const hostMap=new Map(),items=[];
 for(const host of (Array.isArray(hosts)?hosts:[]).slice(0,256)){
  const observed=freshHost(host,timestamp,ttl);if(observed===null)continue;
  hostMap.set(host.id,{host,observed});
  const name=text(host.name||host.label||host.id),telemetry=host.telemetry;
  if(percent(telemetry?.cpu)&&telemetry.cpu>cpuLimit)items.push({...base('load:'+identity([host.id,'cpu']),'resource-alert',host.id,observed,`${name} · host CPU ${format(telemetry.cpu)}% above ${cpuLimit}% · all host processes`),metric:'cpu',measuredPercent:telemetry.cpu,thresholdPercent:cpuLimit});
  const total=telemetry?.totalMemory,free=telemetry?.freeMemory;
  if(typeof total==='number'&&Number.isFinite(total)&&total>0&&typeof free==='number'&&Number.isFinite(free)&&free>=0&&free<=total){const used=(total-free)/total*100;if(used>memoryLimit)items.push({...base('load:'+identity([host.id,'memory']),'resource-alert',host.id,observed,`${name} · host RAM ${format(used)}% above ${memoryLimit}% · all host processes`),metric:'memory',measuredPercent:used,thresholdPercent:memoryLimit});}
 }

 const byHost=new Map();
 for(const session of (Array.isArray(sessions)?sessions:[]).slice(0,16384))if(session&&hostMap.has(session.hostId)){if(!byHost.has(session.hostId))byHost.set(session.hostId,[]);byHost.get(session.hostId).push(session);}
 const readings=new Map();
 for(const [hostId,sourceSessions] of byHost){
  const {host}=hostMap.get(hostId),usage=buildUsageSummary({sessions:sourceSessions,hosts:[host],now:timestamp,staleAfterMs:300000});
  for(const report of [...usage.quota.pools,...usage.quota.unlinked])for(const window of ['primary','secondary']){
   const reading=report[window];if(!reading||reading.state!=='observed'||!percent(reading.usedPercent))continue;
   const observed=time(reading.observedAt);if(observed===null)continue;
   // Selecting one fresh source sighting is not pooling allowances. Unknown
   // accounts remain explicitly unlinked, including on the same host.
   const key=identity([hostId,report.limitId,window,report.accountKey||'unlinked']);
   const previous=readings.get(key),candidate={key,hostId,report,window,reading,observed};
   if(!previous||observed>previous.observed||observed===previous.observed&&String(report.sessionId).localeCompare(String(previous.report.sessionId))>0)readings.set(key,candidate);
  }
 }
 for(const {key,hostId,report,window,reading,observed} of readings.values())if(reading.remainingPercent<quotaLimit){
  const linked=!!report.accountKey,name=text(hostMap.get(hostId).host.name||hostId),limit=text(report.limitName||report.limitId,80),qualification=linked?'explicit account report':'account-unlinked source report';
  // No account identity, token, cost, or inferred total allowance is emitted.
  const id='quota:'+identity([hostId,report.limitId,window,linked?opaque(key):'unlinked']);
  items.push({...base(id,'quota-alert',hostId,observed,`${name} · ${limit} ${window} ${format(reading.remainingPercent)}% remaining · ${qualification}`),window,remainingPercent:reading.remainingPercent,thresholdPercent:quotaLimit,accountLinked:linked,sourceSessionId:text(report.sessionId,200)});
 }

 const open=new Map(),returns=new Map(),latest=new Map(),terminals=new Map(),seen=new Set(),prefixes=new Map();let prefixCount=0;
 const threadPrefix=(host,source,session)=>{
  source=source??'';let sources=prefixes.get(host),threads=sources?.get(source),prefix=threads?.get(session);
  if(prefix===undefined){prefix=identity([host,source,session]);if(prefixCount<1024){if(!sources){sources=new Map();prefixes.set(host,sources);}if(!threads){threads=new Map();sources.set(source,threads);}threads.set(session,prefix);prefixCount++;}}
  return prefix;
 };
 let scanned=0;
 for(const event of (Array.isArray(events)?events:[]).slice(-100000)){
  if(++scanned%512===0)yield;
  if(!event||!hostMap.has(event.hostId)||typeof event.sessionId!=='string'||!event.sessionId)continue;
  const at=time(event.at);if(at===null||at>timestamp)continue;
  const strings=stringIdentity(event);let thread,call;
  if(strings)thread=threadPrefix(event.hostId,event.sourceId,event.sessionId);
  const id=strings?thread+':'+identityPart(event.id):identity([event.hostId,event.sourceId,event.sessionId,event.id]);if(seen.has(id))continue;seen.add(id);
  if(strings){if(event.kind==='tool.start'||event.kind==='tool.end')call=thread+':'+identityPart(event.turnId)+':'+identityPart(event.callId);}else{thread=threadKey(event);call=callKey(event);}
  latest.set(thread,Math.max(latest.get(thread)??-Infinity,at));
  if(event.kind==='tool.start'&&typeof event.callId==='string'&&event.callId&&at>(open.get(call)?.at??-Infinity))open.set(call,{event,at,thread});
  if(event.kind==='tool.end')returns.set(call,Math.max(returns.get(call)??-Infinity,at));
  if(['complete','error','remote.end'].includes(event.kind))terminals.set(thread,Math.max(terminals.get(thread)??-Infinity,at));
 }
 for(const [key,{event,at,thread}] of open){
  const last=latest.get(thread);if(timestamp-at<=toolAge||last===undefined||timestamp-last>ttl||(returns.get(key)??-Infinity)>=at||(terminals.get(thread)??-Infinity)>=at)continue;
  const host=hostMap.get(event.hostId).host,name=text(host.name||event.hostId),label=text(event.label)||'Recorded tool';
  items.push({...base('tool-unanswered:'+key,'tool-unanswered',event.hostId,at,`${name} · ${label} · no captured result for ${Math.floor((timestamp-at)/1000)}s; this thread is still reporting`),eventId:text(event.id,240),sessionId:text(event.sessionId,200),sourceId:text(event.sourceId,240),turnId:text(event.turnId,200),callId:text(event.callId,200),lastSourceAt:stamp(last),project:text(event.project,160),ageMs:timestamp-at});
 }
 const payloadAt=time(usage?.observedAt),payloadFresh=payloadAt!==null&&payloadAt<=timestamp&&timestamp-payloadAt<=30000;
 if(payloadFresh){
  const archive=usage?.usageHistory?.archive,pending=archive?.pendingRecords,oldest=time(archive?.oldestPendingAt);
  if(archive&&archive.status!=='restricted'&&(archive.status==='failed'||archive.storage?.pressure===true||Number.isSafeInteger(pending)&&pending>0&&(archive.status==='unconfigured'||oldest!==null&&oldest<=timestamp-300000))){
   const label=archive.storage?.pressure===true?'Archive storage pressure':archive.status==='failed'?'Archive transfer failed':archive.status==='unconfigured'?'Archive destination missing':'Archive backlog older than 5 minutes';
   items.push({...base('usage:archive-backlog','archive-alert',null,payloadAt,`${label} · ${Number.isSafeInteger(pending)?pending.toLocaleString():'unknown'} pending record versions remain protected on the Pi`),target:'storage',pendingRecords:Number.isSafeInteger(pending)?pending:null,oldestPendingAt:oldest===null?null:stamp(oldest)});
  }
  const accounts=usage.accountUsage?.status==='restricted'?[]:Array.isArray(usage.accountUsage?.accounts)?usage.accountUsage.accounts:[];
  for(const account of accounts.slice(0,16)){
   const observed=time(account.limitsObservedAt);if(observed===null||observed>timestamp||timestamp-observed>120000)continue;
   const accountId=opaque(account.accountKey||JSON.stringify(account.hostIds||[])),hostId=Array.isArray(account.hostIds)?account.hostIds.find(id=>typeof id==='string')||null:null;
   if(account.ordinaryUsageAllowed===false)items.push({...base('account-blocked:'+accountId,'account-permission-alert',hostId,observed,'Account source reports ordinary included usage is blocked · percentage/reset does not establish recovery'),target:'weekly'});
   for(const limit of (Array.isArray(account.limits)?account.limits:[]).slice(0,8))for(const name of ['primary','secondary']){
    const window=limit?.[name],reset=time(typeof window?.resetsAt==='number'?window.resetsAt*1000:window?.resetsAt);if(!percent(window?.usedPercent)||reset!==null&&reset<=timestamp)continue;
    const remaining=100-window.usedPercent;if(remaining>=quotaLimit)continue;
    items.push({...base('account-quota:'+identity([accountId,limit.limitId,name]),'account-quota-alert',hostId,observed,`Account allowance · ${text(limit.limitId,80)} ${name} · ${format(remaining)}% remaining · source-wide, not assigned to a worker`),target:'weekly',window:name,remainingPercent:remaining,thresholdPercent:quotaLimit});
   }
  }
  for(const spike of (Array.isArray(burnSpikes)?burnSpikes:[]).slice(0,16)){const source=time(spike?.at);if(spike?.kind==='burn-spike'&&source!==null&&source<=timestamp&&timestamp-source<=120000)items.push(spike);}
 }
 return items.sort((a,b)=>time(b.at)-time(a.at)||a.id.localeCompare(b.id)).slice(0,40);
}

export function attentionCaption(item){return ({'collector-unavailable':'SOURCE NOT REPORTING','weekly-quota-burn':'WEEKLY QUOTA BURN','quota-stale':'QUOTA UNKNOWN','telemetry-stale':'TELEMETRY STALE',approval:'INPUT REQUIRED','source-gap':'SOURCE GAP','resource-alert':'HOST RESOURCE','quota-alert':'SOURCE QUOTA','account-quota-alert':'ACCOUNT QUOTA','account-permission-alert':'ACCOUNT BLOCKED','archive-alert':'ARCHIVE BACKLOG','burn-spike':'OBSERVED BURN SPIKE','tool-unanswered':'NO CAPTURED RESULT'})[item?.kind]||(item?.attention?'RECORDED FAILURE':'RECORDED ACTIVITY');}

// This short presentation identifier provides stable row identity only. It is
// deliberately unrelated to authentication or authorization.
function opaque(value){let result=2166136261;for(const character of value)result=Math.imul(result^character.charCodeAt(0),16777619)>>>0;return result.toString(16).padStart(8,'0');}

export function operationalAlerts(options){const stages=operationalAlertStages(options);let step;do{step=stages.next();}while(!step.done);return step.value;}
