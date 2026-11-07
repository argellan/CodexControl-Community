// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// Read-only source-time navigation. Input is the existing sanitized event stream;
// output deliberately contains identities and classifications, never event payloads.
const tuple=(...parts)=>JSON.stringify(parts.map(v=>typeof v==='string'?v:''));
const time=value=>typeof value==='number'?value:Date.parse(value);
const bounded=(value,fallback,min,max)=>Number.isFinite(Number(value))?Math.max(min,Math.min(max,Math.floor(Number(value)))):fallback;
const categories=new Set(['command','edit','research','agent','tool','remote','approval','error','usage','message']);
const failures=new Set(['failed','interrupted']);
const isError=e=>e.kind==='error'||e.category==='error'||failures.has(e.outcome);
const recordIdentities=new WeakMap();
const identity=e=>{let key=recordIdentities.get(e);if(key===undefined){key=tuple(e.hostId,e.sourceId,e.sessionId,e.id);recordIdentities.set(e,key);}return key;};
const groupIdentity=e=>tuple('turn',e.hostId,e.sourceId,e.sessionId,e.turnId);
const scopeIdentity=e=>tuple(e.hostId,e.sourceId,e.sessionId);
const seek=e=>({eventId:e.id,hostId:e.hostId,sourceId:e.sourceId,sessionId:e.sessionId,at:e.at});
const compare=(a,b)=>a.at-b.at||identity(a).localeCompare(identity(b));
const chronology=(a,b)=>a.start-b.start||a.id.localeCompare(b.id);
const attentionPriority=(a,b)=>Number(b.selected)-Number(a.selected)||Number(!!(b.errors||b.inputRequests||b.pendingCalls))-Number(!!(a.errors||a.inputRequests||a.pendingCalls))||b.end-a.end||a.id.localeCompare(b.id);
const emptyCounts=()=>({events:0,groups:0,tools:0,remoteJobs:0,errors:0,inputRequests:0,pendingCalls:0,openTurns:0});
const summary=(groups)=>groups.reduce((out,g)=>{out.groups++;out.events+=g.count;out.errors+=g.errors;out.inputRequests+=g.inputRequests;out.pendingCalls+=g.pendingCalls;return out;},{groups:0,events:0,errors:0,inputRequests:0,pendingCalls:0});

const recordCache=new WeakMap(),recordFields=['id','at','hostId','sourceId','sessionId','turnId','project','kind','category','outcome','callId','jobId','requestId','workerHostId','workerSessionId','startedAt','completedAt'];
function safeRecord(value){
 if(!value||typeof value!=='object'||typeof value.id!=='string'||!value.id)return null;
 const previous=recordCache.get(value);if(previous){let same=true;for(let i=0;i<recordFields.length;i++)if(!Object.is(value[recordFields[i]],previous.values[i])){same=false;break;}if(same)return previous.record;}
 const at=time(value.at);if(!Number.isFinite(at))return null;
 const text=key=>typeof value[key]==='string'?value[key]:'';
 const record={id:value.id,at,hostId:text('hostId'),sourceId:text('sourceId'),sessionId:text('sessionId'),turnId:text('turnId'),project:text('project'),kind:text('kind'),category:categories.has(value.category)?value.category:'agent',outcome:failures.has(value.outcome)?value.outcome:['completed','recorded','unverified','waiting','observed'].includes(value.outcome)?value.outcome:'unknown',callId:text('callId'),jobId:text('jobId'),requestId:text('requestId'),workerHostId:text('workerHostId'),workerSessionId:text('workerSessionId'),startedAt:time(value.startedAt),completedAt:time(value.completedAt)};
 recordCache.set(value,{values:recordFields.map(key=>value[key]),record});return record;
}

/**
 * buildTimelineNavigation(events, options)
 *
 * `reference` is milliseconds/ISO source clock. If omitted, the latest supplied
 * record is the reference; this function never reads wall time. `events` may
 * include older context for calls beginning before the visible window.
 *
 * Returned bins cover [start,end], including zero regions. Groups and rows are
 * bounded, chronological, and retain selection/attention before ordinary rows.
 * Every hidden record/attention signal remains accounted for in overflow counts.
 * Seek objects carry the exact host/source/session/event identity and timestamp.
 * Callers should use those objects when IDs can repeat between collectors.
 */
export function buildTimelineNavigation(events,options={}){
 const candidates=(Array.isArray(events)?events:[]).map(safeRecord).filter(Boolean);
 const requested=time(options.reference),reference=Number.isFinite(requested)?requested:candidates.reduce((n,e)=>Math.max(n,e.at),0);
 const windowMs=bounded(options.windowMs,60000,1,31536000000),start=reference-windowMs;
 const binCount=bounded(options.bins,48,1,256),maxGroups=bounded(options.maxGroups,32,1,128),maxRows=bounded(options.maxRowsPerGroup,12,1,64),maxRecords=bounded(options.maxRecordsPerRow,64,2,256);
 const related=options.includeRelated!==false;
 const inScope=e=>(!options.hostId||e.hostId===options.hostId||related&&e.workerHostId===options.hostId)&&(!options.sessionId||e.sessionId===options.sessionId&&(!options.sessionHostId||e.hostId===options.sessionHostId)||related&&e.workerSessionId===options.sessionId&&(!options.sessionHostId||e.workerHostId===options.sessionHostId))&&(!options.project||e.project===options.project);
 const selected=e=>e.id===options.selectedEventId&&(!options.selectedHostId||e.hostId===options.selectedHostId)&&(!options.selectedSourceId||e.sourceId===options.selectedSourceId)&&(!options.selectedSessionId||e.sessionId===options.selectedSessionId);
 // Sort before dedupe so repeated snapshots and input order cannot change a row.
 const unique=new Map();
 candidates.filter(e=>e.at<=reference&&inScope(e)).sort((a,b)=>compare(a,b)||JSON.stringify(a).localeCompare(JSON.stringify(b))).forEach(e=>{if(!unique.has(identity(e)))unique.set(identity(e),e);});
 // Map insertion preserves the already sorted/deduplicated chronology.
 const records=[...unique.values()],visible=records.filter(e=>e.at>=start),visibleIds=new Set(visible.map(identity));
 const bins=Array.from({length:binCount},(_,i)=>({id:i,start:start+windowMs*i/binCount,end:start+windowMs*(i+1)/binCount,count:0,errors:0,inputRequests:0,pendingCalls:0,starts:0,results:0,categories:{},seek:null,selected:false}));
 const binById=new Map(),binPriorities=new Map();
 const binSeek=(bin,e,priority=0)=>{const score=selected(e)?4:priority;if(!bin.seek||score>=(binPriorities.get(bin.id)||0)){bin.seek=seek(e);binPriorities.set(bin.id,score);}};
 for(const e of visible){const bin=bins[Math.min(binCount-1,Math.floor((e.at-start)/windowMs*binCount))];bin.count++;bin.errors+=isError(e)?1:0;bin.starts+=e.kind.endsWith('.start')||e.kind==='turn'?1:0;bin.results+=e.kind.endsWith('.end')||e.kind==='complete'||e.kind==='resolution'?1:0;bin.categories[e.category]=(bin.categories[e.category]||0)+1;binSeek(bin,e,isError(e)?2:0);bin.selected||=selected(e);binById.set(identity(e),bin);}
 const rows=[],paired=new Map(),requests=new Map();
 for(const e of records){
  if(e.kind==='tool.start'||e.kind==='tool.end'||e.kind.startsWith('remote.')){
   const type=e.kind.startsWith('remote.')?'remote':'tool',call=type==='remote'?e.jobId||e.callId:e.callId;
   // Missing correlation IDs are individual records, never an invented pair.
   const id=call?tuple(type,e.hostId,e.sourceId,e.sessionId,e.turnId,call):tuple(type,'unpaired',identity(e));
   if(!paired.has(id))paired.set(id,{id,type,records:[]});paired.get(id).records.push(e);
  }else if(e.kind==='approval'||e.kind==='resolution'){
   const id=e.requestId?tuple('request',scopeIdentity(e),e.requestId):tuple('request','unpaired',identity(e));
   if(!requests.has(id))requests.set(id,{id,type:'request',records:[]});requests.get(id).records.push(e);
  }else if(options.includeGroups!==false)rows.push({id:tuple('record',identity(e)),type:e.kind==='operation'?'operation':'event',records:[e]});
 }
 rows.push(...paired.values(),...requests.values());
 if(options.includeGroups===false){
  // Spans view needs exact navigation bins, including unresolved requests and
  // calls, but not thousands of hidden turn/row objects. Correlation and seek
  // priority are identical to the full projection below.
  for(const row of rows){const request=row.type==='request',begin=request?row.records.findLast(e=>e.kind==='approval'):row.records.find(e=>e.kind.endsWith('.start')),finish=row.records.findLast(e=>e.kind.endsWith('.end')||e.kind==='resolution'),pending=request?!!begin&&(!finish||finish.at<begin.at):!!begin&&!finish;if(!pending||!visibleIds.has(identity(begin)))continue;const bin=binById.get(identity(begin));if(request)bin.inputRequests++;else bin.pendingCalls++;binSeek(bin,begin,request?3:1);}
  return {reference,start,end:reference,windowMs,bins,groups:[],counts:null,overflow:null,selected:null,projection:'density-only'};
 }
 const groups=new Map(),counts=emptyCounts();counts.events=visible.length;
 for(const row of rows){
  const all=row.records,shown=all.filter(e=>visibleIds.has(identity(e)));if(!shown.length)continue;
  const first=all[0],last=all.at(-1),request=row.type==='request',begin=request?all.findLast(e=>e.kind==='approval'):all.find(e=>e.kind.endsWith('.start')),finish=all.findLast(e=>e.kind.endsWith('.end')||e.kind==='resolution');
  const pendingRequest=request&&!!begin&&(!finish||finish.at<begin.at);
  const pendingCall=(row.type==='tool'||row.type==='remote')&&!!begin&&!finish;
  let status=isError(last)?'failure-recorded':row.type==='tool'||row.type==='remote'?begin?finish?'result-recorded':'no-result-observed':finish?'result-without-start':'progress-observed':request?pendingRequest?'waiting-for-input':'resolution-recorded':last.kind==='complete'?'turn-ended':last.kind==='turn'?'turn-start-observed':'recorded';
  const durationStart=row.type==='operation'?first.startedAt:begin?.at,durationEnd=row.type==='operation'?first.completedAt:pendingRequest?undefined:finish?.at;
  const valid=Number.isFinite(durationStart)&&Number.isFinite(durationEnd)&&durationEnd>=durationStart;
  if(Number.isFinite(durationStart)&&Number.isFinite(durationEnd)&&durationEnd<durationStart)status='invalid-source-timing';
  const groupEvent=begin||first,groupId=groupIdentity(groupEvent);
  if(!groups.has(groupId))groups.set(groupId,{id:groupId,hostId:groupEvent.hostId,sourceId:groupEvent.sourceId,sessionId:groupEvent.sessionId,turnId:groupEvent.turnId||null,project:groupEvent.project,start:Infinity,end:-Infinity,count:0,errors:0,inputRequests:0,pendingCalls:0,toolCount:0,remoteCount:0,selected:false,status:'recorded',rows:[],seek:null,lastTurn:null});
  const group=groups.get(groupId),errors=shown.filter(isError).length;
  const preview=shown.length<=maxRecords?shown:shown.slice().sort((a,b)=>Number(selected(b))-Number(selected(a))||b.at-a.at||identity(a).localeCompare(identity(b))).slice(0,maxRecords).sort(compare);
  const projected={id:row.id,type:row.type,label:request?'Input request':row.type==='tool'?'Tool activity':row.type==='remote'?'Remote job':last.kind==='turn'?'Turn start':last.kind==='complete'?'Turn end':row.type==='operation'?'Operation record':'Source event',category:request?'approval':last.category,start:Number.isFinite(durationStart)?durationStart:first.at,end:Number.isFinite(durationEnd)?durationEnd:last.at,durationMs:valid?durationEnd-durationStart:null,count:shown.length,errors,inputRequests:pendingRequest?1:0,pendingCalls:pendingCall?1:0,status,selected:shown.some(selected),seek:seek(shown.at(-1)),records:preview.map(seek),overflow:{records:shown.length-preview.length}};
  if(projected.selected)projected.seek=seek(shown.find(selected));
  for(const e of shown){const bin=binById.get(identity(e));if(pendingRequest&&e===begin){bin.inputRequests++;binSeek(bin,e,3);}if(pendingCall&&e===begin){bin.pendingCalls++;binSeek(bin,e,1);}if(e.kind==='turn'||e.kind==='complete')if(!group.lastTurn||compare(e,group.lastTurn)>0)group.lastTurn=e;}
  group.start=Math.min(group.start,...shown.map(e=>e.at));group.end=Math.max(group.end,...shown.map(e=>e.at));group.count+=shown.length;group.errors+=errors;group.inputRequests+=projected.inputRequests;group.pendingCalls+=projected.pendingCalls;group.selected||=projected.selected;group.toolCount+=row.type==='tool'?1:0;group.remoteCount+=row.type==='remote'?1:0;group.rows.push(projected);
  if(!group.seek||projected.selected||!group.selected&&projected.seek.at>group.seek.at)group.seek=projected.seek;
  counts.tools+=row.type==='tool'?1:0;counts.remoteJobs+=row.type==='remote'?1:0;
 }
 const allGroups=[...groups.values()];
 for(const group of allGroups){
  group.status=group.inputRequests?'waiting-for-input':group.errors?'failure-recorded':group.pendingCalls?'no-result-observed':group.lastTurn?.kind==='complete'?'turn-ended':group.lastTurn?.kind==='turn'?'turn-start-observed':'recorded';
  counts.errors+=group.errors;counts.inputRequests+=group.inputRequests;counts.pendingCalls+=group.pendingCalls;counts.openTurns+=group.lastTurn?.kind==='turn'?1:0;
  delete group.lastTurn;
  group.rows.sort(attentionPriority);const hidden=group.rows.slice(maxRows);group.rows=group.rows.slice(0,maxRows).sort(chronology);
  group.overflow={rows:hidden.length,events:hidden.reduce((n,r)=>n+r.count,0),errors:hidden.reduce((n,r)=>n+r.errors,0),inputRequests:hidden.reduce((n,r)=>n+r.inputRequests,0),pendingCalls:hidden.reduce((n,r)=>n+r.pendingCalls,0)};
 }
 counts.groups=allGroups.length;
 allGroups.sort(attentionPriority);
 const hiddenGroups=allGroups.slice(maxGroups),shownGroups=allGroups.slice(0,maxGroups).sort(chronology);
 return {reference,start,end:reference,windowMs,bins,groups:shownGroups,counts,overflow:summary(hiddenGroups),selected:shownGroups.flatMap(g=>g.rows).find(r=>r.selected)?.seek||null};
}

function densityNavigation(records,visibleIds,binById,binSeek,{reference,start,windowMs,bins}){
 const paired=new Map(),requests=new Map();
 for(const e of records){
  if(e.kind==='tool.start'||e.kind==='tool.end'||e.kind.startsWith('remote.')){
   const type=e.kind.startsWith('remote.')?'remote':'tool',call=type==='remote'?e.jobId||e.callId:e.callId,id=call?tuple(type,e.hostId,e.sourceId,e.sessionId,e.turnId,call):tuple(type,'unpaired',identity(e));
   let row=paired.get(id);if(!row){row={begin:null,finish:null};paired.set(id,row);}if(!row.begin&&e.kind.endsWith('.start'))row.begin=e;if(e.kind.endsWith('.end')||e.kind==='resolution')row.finish=e;
  }else if(e.kind==='approval'||e.kind==='resolution'){
   const id=e.requestId?tuple('request',scopeIdentity(e),e.requestId):tuple('request','unpaired',identity(e));let row=requests.get(id);if(!row){row={begin:null,finish:null};requests.set(id,row);}if(e.kind==='approval')row.begin=e;if(e.kind.endsWith('.end')||e.kind==='resolution')row.finish=e;
  }
 }
 const pending=(row,request)=>{const {begin,finish}=row;if(!(request?!!begin&&(!finish||finish.at<begin.at):!!begin&&!finish)||!visibleIds.has(identity(begin)))return;const bin=binById.get(identity(begin));if(request)bin.inputRequests++;else bin.pendingCalls++;binSeek(bin,begin,request?3:1);};
 // Legacy rows append all call rows before request rows. Preserve their first
 // insertion order because equal-priority pending seeks are last-wins.
 for(const row of paired.values())pending(row,false);for(const row of requests.values())pending(row,true);
 return {reference,start,end:reference,windowMs,bins,groups:[],counts:null,overflow:null,selected:null,projection:'density-only'};
}

// Dedicated density-only projection for the browser's plain navigation options.
// The legacy navigator above remains unchanged, including its accessor/Proxy
// evaluation behavior. Only correlation summaries are needed by this API.
export function buildTimelineDensity(events,options={}){
 const candidates=(Array.isArray(events)?events:[]).map(safeRecord).filter(Boolean);
 const requested=time(options.reference),reference=Number.isFinite(requested)?requested:candidates.reduce((n,e)=>Math.max(n,e.at),0);
 const windowMs=bounded(options.windowMs,60000,1,31536000000),start=reference-windowMs,binCount=bounded(options.bins,48,1,256);
 const related=options.includeRelated!==false;
 const inScope=e=>(!options.hostId||e.hostId===options.hostId||related&&e.workerHostId===options.hostId)&&(!options.sessionId||e.sessionId===options.sessionId&&(!options.sessionHostId||e.hostId===options.sessionHostId)||related&&e.workerSessionId===options.sessionId&&(!options.sessionHostId||e.workerHostId===options.sessionHostId))&&(!options.project||e.project===options.project);
 const selected=e=>e.id===options.selectedEventId&&(!options.selectedHostId||e.hostId===options.selectedHostId)&&(!options.selectedSourceId||e.sourceId===options.selectedSourceId)&&(!options.selectedSessionId||e.sessionId===options.selectedSessionId);
 const unique=new Map();
 candidates.filter(e=>e.at<=reference&&inScope(e)).sort((a,b)=>compare(a,b)||JSON.stringify(a).localeCompare(JSON.stringify(b))).forEach(e=>{if(!unique.has(identity(e)))unique.set(identity(e),e);});
 const records=[...unique.values()],visible=records.filter(e=>e.at>=start),visibleIds=new Set(visible.map(identity));
 const bins=Array.from({length:binCount},(_,i)=>({id:i,start:start+windowMs*i/binCount,end:start+windowMs*(i+1)/binCount,count:0,errors:0,inputRequests:0,pendingCalls:0,starts:0,results:0,categories:{},seek:null,selected:false}));
 const binById=new Map(),binPriorities=new Map();
 const binSeek=(bin,e,priority=0)=>{const score=selected(e)?4:priority;if(!bin.seek||score>=(binPriorities.get(bin.id)||0)){bin.seek=seek(e);binPriorities.set(bin.id,score);}};
 for(const e of visible){const bin=bins[Math.min(binCount-1,Math.floor((e.at-start)/windowMs*binCount))];bin.count++;bin.errors+=isError(e)?1:0;bin.starts+=e.kind.endsWith('.start')||e.kind==='turn'?1:0;bin.results+=e.kind.endsWith('.end')||e.kind==='complete'||e.kind==='resolution'?1:0;bin.categories[e.category]=(bin.categories[e.category]||0)+1;binSeek(bin,e,isError(e)?2:0);bin.selected||=selected(e);binById.set(identity(e),bin);}
 if(!records.every(e=>typeof e.kind==='string'))return buildTimelineNavigation(events,{...options,includeGroups:false});
 return densityNavigation(records,visibleIds,binById,binSeek,{reference,start,windowMs,bins});
}
