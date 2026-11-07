// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// Metadata-only observation projections. These helpers never control a provider.
const safe=(v,max=120)=>typeof v==='string'?v.replace(/[\x00-\x1f\x7f]/g,'').slice(0,max):null;
const numeric=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
const time=v=>{const n=typeof v==='number'?v:Date.parse(v);return Number.isFinite(n)?n:null;};
const stamp=v=>time(v)===null?null:new Date(time(v)).toISOString();
const tokenKeys=['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
const tokens=v=>{if(!v||typeof v!=='object'||Array.isArray(v))return null;const entries=tokenKeys.filter(k=>numeric(v[k])!==null).map(k=>[k,v[k]]);return entries.length?Object.fromEntries(entries):null;};
const bounded=(v,fallback,min,max)=>Number.isFinite(v)?Math.max(min,Math.min(max,Math.floor(v))):fallback;
const hostId=s=>s.hostId||'local';
const key=s=>hostId(s)+'/'+(s.id||s.sessionId);
const accountKey=v=>typeof v==='string'&&/^[a-f0-9]{64}$/i.test(v)?v.toLowerCase():null;
const windowValue=v=>v&&typeof v==='object'&&!Array.isArray(v)&&numeric(v.usedPercent)!==null?{usedPercent:v.usedPercent,windowDurationMins:numeric(v.windowDurationMins),resetsAt:numeric(v.resetsAt)}:null;

// A source must explicitly establish an opaque account identity. Native log
// collectors currently cannot, so their accountKey is always null.
export function sanitizeUsageLimits(value){
 if(!Array.isArray(value))return null;
 const result=[];
 for(const v of value.slice(0,8)){
  if(!v||typeof v!=='object'||Array.isArray(v))continue;
  const primary=windowValue(v.primary),secondary=windowValue(v.secondary),observedAt=stamp(v.observedAt);
  if((!primary&&!secondary)||!observedAt)continue;
  result.push({limitId:safe(v.limitId,80)||'unlabelled',limitName:safe(v.limitName,80),planType:safe(v.planType,40),accountKey:accountKey(v.accountKey),observedAt,primary,primaryObservedAt:primary?(stamp(v.primaryObservedAt)||observedAt):null,secondary,secondaryObservedAt:secondary?(stamp(v.secondaryObservedAt)||observedAt):null});
 }
 return result.length?result:null;
}

function workerProjection(session,events,host,now,staleAfterMs){
 const records=events.filter(e=>e.sessionId===session.id&&hostId(e)===hostId(session)&&time(e.at)!==null&&time(e.at)<=now).sort((a,b)=>time(a.at)-time(b.at)||String(a.id).localeCompare(String(b.id)));
 const open=new Map(),waiting=new Map(),counts={started:0,returned:0,operations:0,failed:0};let terminal=null,last=null;
 const toolKey=e=>[hostId(e),e.sourceId||'',e.sessionId,e.turnId||'',e.callId].join('|');
 const requestKey=e=>[hostId(e),e.sourceId||'',e.sessionId,e.turnId||'',e.requestId||e.id].join('|');
 for(const e of records){
  last=e;
  if(e.kind==='turn')terminal=null;
  if(e.kind==='tool.start'){terminal=null;counts.started++;if(e.callId)open.set(toolKey(e),e);}
  if(e.kind==='tool.end'){counts.returned++;if(e.callId)open.delete(toolKey(e));}
  if(e.kind==='operation')counts.operations++;
  if(e.kind==='error'||['failed','interrupted'].includes(e.outcome))counts.failed++;
  if(e.kind==='approval')waiting.set(requestKey(e),e);
  if(e.kind==='resolution'&&e.requestId)waiting.delete(requestKey(e));
  if(['complete','error','remote.end'].includes(e.kind))terminal=e;
 }
 const fallback=time(session.lastEventAt),lastAt=last?time(last.at):fallback!==null&&fallback<=now?fallback:null;
 const ageMs=lastAt===null?null:Math.max(0,now-lastAt),sourceStatus=host?.status||'unknown';
 const sourceUnavailable=host&&!['online'].includes(sourceStatus);
 const capturedTerminal=terminal&&(!last||time(terminal.at)>=time(last.at)||last.kind==='tool.end');
 let state='quiet',label='Last observed';
 if(sourceUnavailable){state='source-unavailable';label='Source '+sourceStatus;}
 else if(waiting.size){state='waiting';label='Input requested';}
 else if(capturedTerminal){state=terminal.kind==='error'||['failed','interrupted'].includes(terminal.outcome)?'interrupted':'completed';label=state==='completed'?'Turn completed · acceptance unverified':'Interrupted / failure recorded';}
 else if(open.size){state=ageMs!==null&&ageMs<=staleAfterMs&&sourceStatus==='online'?'active':'unconfirmed';label=state==='active'?'Tool activity observed':'No result observed';}
 else if(!lastAt){state='unknown';label='No activity captured';}
 const usageAt=time(session.usageObservedAt),futureUsage=usageAt!==null&&usageAt>now;
 const lastTokens=futureUsage?null:tokens(session.lastTokens),totalTokens=futureUsage?null:tokens(session.tokens),contextWindow=numeric(session.contextWindow);
 const usedTokens=lastTokens?.total_tokens??null,usedPercent=usedTokens!==null&&contextWindow>0?Math.max(0,Math.min(100,usedTokens/contextWindow*100)):null;
 const unresolvedTools=open.size;
 const openTools=capturedTerminal?[]:[...open.values()].slice(-16).map(e=>({id:safe(e.id,200),callId:safe(e.callId),sourceId:safe(e.sourceId,200),turnId:safe(e.turnId),label:safe(e.label,140)||'Tool call',category:safe(e.category,40)||'tool',at:stamp(e.at),ageMs:Math.max(0,now-time(e.at))}));
 return {id:safe(session.id,200),key:key(session),hostId:hostId(session),hostName:safe(session.hostName||host?.name),nickname:safe(session.nickname),project:safe(session.project),parentId:safe(session.parentId,200),forkedFrom:safe(session.forkedFrom,200),model:safe(session.model),effort:safe(session.effort,40),lastEventAt:lastAt===null?null:new Date(lastAt).toISOString(),lastEventId:safe(last?.id,200),lastLabel:safe(last?.label,140),ageMs,sourceStatus,lifecycle:{state,label,acceptance:state==='completed'?'unverified':null},waitingCount:waiting.size,openTools,unresolvedTools,toolCounts:counts,reportedToolCount:numeric(session.tools),reportedChangeCount:numeric(session.changes),captureIncomplete:session.capture?.tailLimited===true||session.capture?.backlogged===true||session.capture?.reset===true||numeric(session.capture?.partialBytes)>0,tokens:totalTokens,context:{usedTokens,maxTokens:contextWindow,usedPercent,observedAt:futureUsage?null:stamp(session.usageObservedAt),label:'Last reported model context'},usageLimits:futureUsage?null:sanitizeUsageLimits(session.usageLimits)};
}

export function buildWorkerSummary({sessions=[],events=[],hosts=[],sessionId,hostId:requestedHost='local',now=Date.now(),staleAfterMs=15000,maxChildren=24}={}){
 const timestamp=time(now)??Date.now(),source=sessions.find(s=>s.id===sessionId&&hostId(s)===requestedHost);if(!source)return null;
 const threshold=bounded(staleAfterMs,15000,1000,300000),host=hosts.find(h=>h.id===requestedHost);
 const eventGroups=new Map(),seen=new Set();
 for(const e of events)if(hostId(e)===requestedHost&&typeof e.id==='string'&&time(e.at)!==null&&time(e.at)<=timestamp){const identity=[hostId(e),e.sourceId||'',e.sessionId,e.id].join('|');if(seen.has(identity))continue;seen.add(identity);if(!eventGroups.has(e.sessionId))eventGroups.set(e.sessionId,[]);eventGroups.get(e.sessionId).push(e);}
 const project=s=>workerProjection(s,eventGroups.get(s.id)||[],host,timestamp,threshold);
 const parent=source.parentId&&source.parentId!==source.id?sessions.find(s=>s.id===source.parentId&&hostId(s)===requestedHost):null;
 const children=sessions.filter(s=>s.parentId===source.id&&s.id!==source.id&&hostId(s)===requestedHost).sort((a,b)=>(time(b.lastEventAt)||0)-(time(a.lastEventAt)||0)||String(a.id).localeCompare(String(b.id)));
 const limit=bounded(maxChildren,24,1,64);
 return {...project(source),parent:parent?project(parent):null,parentMissing:!!source.parentId&&!parent,children:children.slice(0,limit).map(project),childrenTotal:children.length,childrenTruncated:Math.max(0,children.length-limit),capturedEventCount:eventGroups.get(source.id)?.length||0};
}

function projectedWindow(value,observedAt,now,staleAfterMs,sourceStatus){
 if(!value)return null;
 const observed=time(observedAt),reset=value.resetsAt===null?null:value.resetsAt*1000;
 if(observed!==null&&observed>now)return null;
 const expired=reset!==null&&reset<=now;
 const stale=observed===null||now-observed>staleAfterMs||sourceStatus!=='online';
 return {...value,remainingPercent:Math.max(0,Math.min(100,100-value.usedPercent)),observedAt,ageMs:observed===null?null:Math.max(0,now-observed),resetInMs:reset===null?null:Math.max(0,reset-now),state:expired?'expired':stale?'stale':'observed'};
}

export function buildUsageSummary({sessions=[],hosts=[],now=Date.now(),staleAfterMs=300000}={}){
 const timestamp=time(now)??Date.now(),threshold=bounded(staleAfterMs,300000,1000,3600000),hostMap=new Map(hosts.map(h=>[h.id,h])),threadCounters=new Map(),threadSources=new Map();
 let excludedForks=0,unknownSessions=0;
 const accounts=new Map(),unlinked=new Map();
 for(const s of sessions){
  const usageAt=time(s.usageObservedAt),future=usageAt!==null&&usageAt>timestamp,counter=future?null:tokens(s.tokens);
  // Session IDs are scoped to their observing host. Copies on another host
  // remain separate observations; they are not an account-wide billing sum.
  const id=JSON.stringify([hostId(s),s.id||s.sessionId]),source=threadSources.get(id)||{hostId:hostId(s),hostName:safe(s.hostName),fork:false};
  source.fork=source.fork||!!s.forkedFrom;threadSources.set(id,source);
  if(!s.forkedFrom&&counter?.total_tokens!==undefined){
   const previous=threadCounters.get(id),at=usageAt??time(s.lastEventAt)??0,model=safe(s.model)||'Unknown model';
   if(!previous||at>previous.at||at===previous.at&&(counter.total_tokens>previous.tokens.total_tokens||counter.total_tokens===previous.tokens.total_tokens&&model.localeCompare(previous.model)>0))threadCounters.set(id,{tokens:counter,at,model});
  }
  for(const q of sanitizeUsageLimits(s.usageLimits)||[]){
   if(time(q.observedAt)>timestamp)continue;
   const linked=!!q.accountKey,groupKey=(linked?q.accountKey:hostId(s)+'/'+s.id)+'/'+q.limitId;
   const groups=linked?accounts:unlinked,previous=groups.get(groupKey),source=hostId(s)+'/'+s.id;
   if(previous){
    previous.sources.add(source);
    const old=previous.report,newest=time(q.observedAt)>time(old.observedAt);
    const merged=newest?{...old,limitName:q.limitName||old.limitName,planType:q.planType||old.planType,observedAt:q.observedAt,hostId:hostId(s),sessionId:s.id}:{...old};
    for(const field of ['primary','secondary'])if(q[field]&&(!old[field]||time(q[field+'ObservedAt'])>time(old[field+'ObservedAt']))){merged[field]=q[field];merged[field+'ObservedAt']=q[field+'ObservedAt'];previous.windowHosts[field]=hostId(s);}
    previous.report=merged;
   }else groups.set(groupKey,{report:{...q,hostId:hostId(s),sessionId:s.id},sources:new Set([source]),windowHosts:{primary:hostId(s),secondary:hostId(s)}});
  }
 }
 const quotaProjection=entry=>{const r=entry.report;return {...r,sourceCount:entry.sources.size,primary:projectedWindow(r.primary,r.primaryObservedAt,timestamp,threshold,hostMap.get(entry.windowHosts.primary)?.status||'unknown'),secondary:projectedWindow(r.secondary,r.secondaryObservedAt,timestamp,threshold,hostMap.get(entry.windowHosts.secondary)?.status||'unknown')};};
 const pools=[...accounts.values()].map(quotaProjection).sort((a,b)=>time(b.observedAt)-time(a.observedAt));
 const sightings=[...unlinked.values()].map(quotaProjection).sort((a,b)=>time(b.observedAt)-time(a.observedAt));
 const models=new Map(),hostCounters=new Map();let observedTotal=0,sessionsWithReadings=0;
 const hostRow=(id,name)=>{if(!hostCounters.has(id)){const host=hostMap.get(id);hostCounters.set(id,{hostId:id,hostName:safe(host?.name)||name||safe(id)||'Unknown source',sourceStatus:safe(host?.status,40)||'unknown',totalTokens:null,sessionsWithReadings:0,excludedForks:0,unknownSessions:0,lastObservedAt:null,sharePercent:null});}return hostCounters.get(id);};
 for(const host of hosts)hostRow(host.id,null);
 for(const [id,source] of threadSources){
  const row=hostRow(source.hostId,source.hostName),entry=threadCounters.get(id);
  if(source.fork){excludedForks++;row.excludedForks++;continue;}
  if(!entry){unknownSessions++;row.unknownSessions++;continue;}
  observedTotal+=entry.tokens.total_tokens;sessionsWithReadings++;row.totalTokens=(row.totalTokens??0)+entry.tokens.total_tokens;row.sessionsWithReadings++;
  if(entry.at>(time(row.lastObservedAt)??0))row.lastObservedAt=stamp(entry.at);
  if(!models.has(entry.model))models.set(entry.model,{model:entry.model,totalTokens:0,sessions:0});const model=models.get(entry.model);model.totalTokens+=entry.tokens.total_tokens;model.sessions++;
 }
 const contributions=[...hostCounters.values()].map(row=>({...row,sharePercent:observedTotal>0&&row.totalTokens!==null?row.totalTokens/observedTotal*100:null})).sort((a,b)=>(b.totalTokens??-1)-(a.totalTokens??-1)||String(a.hostId).localeCompare(String(b.hostId)));
 return {tokens:{observedTotal:sessionsWithReadings?observedTotal:null,sessionsWithReadings,excludedForks,unknownSessions,label:'Observed retained host/session counters · current-model attribution; fork totals excluded; copied sessions may overlap across hosts',complete:false},hosts:contributions,models:[...models.values()].sort((a,b)=>b.totalTokens-a.totalTokens||a.model.localeCompare(b.model)),quota:{state:pools.length?sightings.length?'mixed':'linked':sightings.length?'unlinked':'unavailable',pools,unlinked:sightings,accountCount:sightings.length?null:new Set(pools.map(p=>p.accountKey)).size||null,label:sightings.length?'Account-unlinked source reports · do not add allowances':'Explicit account quota reports'},billing:{status:'unavailable',subscriptionCost:null,estimatedApiCost:null,label:'Token observations are not subscription billing'}};
}
