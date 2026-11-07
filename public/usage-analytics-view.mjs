// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// Bounded presentation projections. Source records remain authoritative; none of
// these helpers executes work, invents routes or changes captured usage history.
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text=(value,max=160)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,max):'';
const at=value=>{const n=typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(n)?n:null;};
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const rate=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const numberFormat=new Intl.NumberFormat(),timeFormat=new Intl.DateTimeFormat(undefined,{dateStyle:'short',timeStyle:'medium'});
const full=value=>count(value)===null?'Unavailable':numberFormat.format(value);
const time=value=>at(value)===null?'Unavailable':timeFormat.format(at(value));
const key=parts=>JSON.stringify(parts);
const fields=[['input','input_tokens','I · Input including cache','burn-input'],['cached','cached_input_tokens','C · Cached input (subset)','burn-cache'],['cacheWrite','cache_write_input_tokens','Cache writes','burn-cache'],['output','output_tokens','O · Output including reasoning','burn-output'],['reasoning','reasoning_output_tokens','Reasoning (output subset)','burn-output'],['total','total_tokens','Reported total','']];
const fact=(label,value)=>`<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`;
const targetButton=(target,label)=>{const identity=Object.fromEntries(['hostId','sessionId','turnId','callId','sourceId','eventId','sampleKey'].filter(key=>typeof target[key]==='string'&&target[key]).map(key=>[key,text(target[key],512)]));return `<button type="button" data-usage-focus="${esc(JSON.stringify(identity))}">${esc(label)} ↗</button>`;};
const median=values=>{const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return !sorted.length?null:sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;};
const sameThread=(event,target)=>event.hostId===target.hostId&&event.sessionId===target.sessionId;

// Exact identities win. A turn or call mismatch never falls through to a
// different event and pretends to be a confirmed token→tool association.
export function resolveEvidenceTarget(target,events=[],sessions=[],{reference=Date.now()}={}){
 if(!target||typeof target!=='object'||!text(target.hostId,256))return null;
 const hostId=text(target.hostId,256),sessionId=text(target.sessionId,256),turnId=text(target.turnId,256),callId=text(target.callId,256),eventId=text(target.eventId,512),sourceId=text(target.sourceId,256);
 const records=(Array.isArray(events)?events:[]).filter(event=>event&&sameThread(event,{hostId,sessionId})&&(!sourceId||event.sourceId===sourceId)&&at(event.at)!==null&&at(event.at)<=reference);
 const exact=records.filter(event=>(!eventId||event.id===eventId)&&(!turnId||event.turnId===turnId)&&(!callId||event.callId===callId));
 exact.sort((a,b)=>at(b.at)-at(a.at)||String(a.id).localeCompare(String(b.id)));
 const event=exact[0],session=(Array.isArray(sessions)?sessions:[]).find(s=>s.hostId===hostId&&s.id===sessionId);
 if(event)return {hostId,sessionId,turnId:turnId||text(event.turnId,256),callId:callId||text(event.callId,256),eventId:event.id,at:at(event.at),match:eventId?'event':turnId?'turn':callId?'call':'session'};
 return {hostId,sessionId:sessionId&&(session||records.length)?sessionId:'',turnId,callId,eventId:'',at:null,match:session||records.length?'session-only':'host-only',missingExact:!!(eventId||turnId||callId)};
}

export function buildRecordedToolMetrics(events=[],{reference=Date.now()}={}){
 const pairs=new Map(),terminals=new Map(),terminalBuckets=[],times=new Map(),seen=new Map(),conflicts=new Set();let identityMissing=0,duplicateConflicts=0;
 // Cancellation is turn-wide, with strict identity equality (including an
 // absent source versus null). Index private clocks once rather than scanning
 // every terminal for every call. NaN must not gain Map's SameValueZero match.
 const terminalBucket=(event,create=false)=>{
  const identity=[event.hostId,event.sessionId,event.sourceId,event.turnId];if(identity.some(Number.isNaN))return null;
  let node=terminals;for(const part of identity.slice(0,-1)){if(!node.has(part)){if(!create)return null;node.set(part,new Map());}node=node.get(part);}
  const last=identity.at(-1);if(!node.has(last)){if(!create)return null;const bucket=[];node.set(last,bucket);terminalBuckets.push(bucket);}return node.get(last);
 };
 const hasCancellation=(start,end)=>{
  const clocks=terminalBucket(start);if(!clocks)return false;const from=times.get(start),to=end?times.get(end):Infinity;
  let low=0,high=clocks.length;while(low<high){const middle=(low+high)>>>1;if(clocks[middle]<from)low=middle+1;else high=middle;}
  return low<clocks.length&&clocks[low]<=to;
 };
 for(const event of (Array.isArray(events)?events:[]).slice(-20000)){
  if(!event)continue;const eventAt=at(event.at);if(eventAt===null||eventAt>reference)continue;times.set(event,eventAt);
  if(event.kind==='error'&&['interrupted','cancelled','canceled'].includes(event.outcome)){terminalBucket(event,true)?.push(eventAt);continue;}
  if(!['tool.start','tool.end'].includes(event.kind))continue;
  if(!event.hostId||!event.sessionId||!event.turnId||!event.callId||!event.id){identityMissing++;continue;}
  const identity=key([event.hostId,event.sourceId,event.sessionId,event.id]),signature=key([event.kind,event.at,event.turnId,event.callId,event.outcome]);
  const pairKey=key([event.hostId,event.sourceId,event.sessionId,event.turnId,event.callId]);
  if(seen.has(identity)){if(seen.get(identity).signature!==signature){duplicateConflicts++;conflicts.add(seen.get(identity).pairKey);conflicts.add(pairKey);}continue;}seen.set(identity,{signature,pairKey});
  if(!pairs.has(pairKey))pairs.set(pairKey,{starts:[],ends:[]});pairs.get(pairKey)[event.kind==='tool.start'?'starts':'ends'].push(event);
 }
 for(const bucket of terminalBuckets)bucket.sort((a,b)=>a-b);
 const rows=[],rowTimes=new Map();for(const [pairKey,pair] of pairs){
  const start=pair.starts[0],end=pair.ends[0],event=end||start,ambiguous=pair.starts.length>1||pair.ends.length>1||conflicts.has(pairKey);
  const cancelled=['interrupted','cancelled','canceled'].includes(end?.outcome)||!!start&&hasCancellation(start,end);
  const duration=start&&end&&!ambiguous&&times.get(end)>=times.get(start)?times.get(end)-times.get(start):null;
  const state=ambiguous?'ambiguous':cancelled?'cancelled':!start?'missing-start':!end?'missing-result':duration===null?'invalid-clock':end.outcome==='failed'?'failed':['completed','succeeded','success'].includes(end.outcome)?'completed':'outcome-unknown';
  const row={hostId:event.hostId,sessionId:event.sessionId,sourceId:event.sourceId??null,turnId:event.turnId??null,callId:event.callId,eventId:event.id,at:event.at,label:text(start?.label||end?.label||'Recorded tool'),state,durationMs:duration};rows.push(row);rowTimes.set(row,times.get(event));
 }
 rows.sort((a,b)=>rowTimes.get(b)-rowTimes.get(a)||a.eventId.localeCompare(b.eventId));const durations=rows.filter(r=>r.durationMs!==null).map(r=>r.durationMs).sort((a,b)=>a-b);
 return {calls:rows.length,matched:durations.length,completed:rows.filter(r=>r.state==='completed').length,failed:rows.filter(r=>r.state==='failed').length,cancelled:rows.filter(r=>r.state==='cancelled').length,unknown:rows.filter(r=>r.state==='outcome-unknown').length,missingStart:rows.filter(r=>r.state==='missing-start').length,missingResult:rows.filter(r=>r.state==='missing-result').length,ambiguous:rows.filter(r=>r.state==='ambiguous').length,invalidClock:rows.filter(r=>r.state==='invalid-clock').length,identityMissing,duplicateConflicts,p50Ms:median(durations),p95Ms:durations.length?durations[Math.ceil(durations.length*.95)-1]:null,rows:rows.slice(0,100),rowsTruncated:rows.length>100};
}

// Count only the qualified native discriminator. Labels, account estimates and
// token changes never establish that a context compaction occurred.
export function buildCompactionHistory(events=[],{reference=Date.now(),maxRows=24}={}){
 const supplied=Array.isArray(events)?events:[],records=supplied.slice(-20000),seen=new Map(),conflicts=new Set();let typed=0,duplicates=0,identityMissing=0,invalidClock=0,futureRows=0,untypedOperations=0;
 const isTyped=event=>event?.kind==='operation'&&event.operationType==='context-compaction';
 for(const event of records){
  if(!event||typeof event!=='object')continue;const qualified=isTyped(event),sourceAt=at(event.at);
  if(sourceAt===null){if(qualified)invalidClock++;continue;}if(!Number.isFinite(reference)||sourceAt>reference){if(qualified)futureRows++;continue;}
  if(event.kind==='operation'&&!Object.hasOwn(event,'operationType'))untypedOperations++;
  if(qualified)typed++;
  const parts=['hostId','sourceId','sessionId','id'].map(name=>typeof event[name]==='string'&&event[name].trim()&&event[name].length<=(name==='id'?512:256)?event[name]:null);
  if(parts.some(value=>value===null)){if(qualified)identityMissing++;continue;}
  const identity=key(parts),start=event.startedAt==null?null:at(event.startedAt),end=event.completedAt==null?null:at(event.completedAt),badClock=event.startedAt!=null&&start===null||event.completedAt!=null&&end===null||start!==null&&start>sourceAt||end!==null&&end>sourceAt||start!==null&&end!==null&&end<start;
  const signature=key([event.kind,event.operationType??null,sourceAt,start,end,event.turnId??null,event.callId??null,event.project??null,event.outcome??null]),previous=seen.get(identity);
  if(previous){if(previous.signature!==signature&&(qualified||previous.typed))conflicts.add(identity);else if(qualified&&previous.typed)duplicates++;previous.typed||=qualified;continue;}
  seen.set(identity,{signature,typed:qualified,badClock,event,sourceAt,start,end});if(qualified&&badClock)invalidClock++;
 }
 const all=[];for(const [identity,value] of seen){if(!value.typed||value.badClock||conflicts.has(identity)||!isTyped(value.event))continue;const event=value.event;all.push({hostId:event.hostId,sourceId:event.sourceId,sessionId:event.sessionId,eventId:event.id,turnId:typeof event.turnId==='string'?event.turnId:null,project:text(event.project),at:value.sourceAt,startedAt:value.start,completedAt:value.end,durationMs:value.start!==null&&value.end!==null?value.end-value.start:null});}
 all.sort((a,b)=>b.at-a.at||key([a.hostId,a.sourceId,a.sessionId,a.eventId]).localeCompare(key([b.hostId,b.sourceId,b.sessionId,b.eventId])));
 const limit=Number.isSafeInteger(maxRows)?Math.max(1,Math.min(100,maxRows)):24;
 return {status:typed?'observed':'unavailable',count:typed?all.length:null,rows:all.slice(0,limit),rowsTruncated:all.length>limit,duplicates,conflictingIdentities:conflicts.size,identityMissing,invalidClock,futureRows,untypedOperations,scannedRows:records.length,inputTruncated:supplied.length>records.length,complete:false};
}

export function renderCompactionHistory(events=[],{reference=Date.now(),scope='selected retained map scope'}={}){
 const history=buildCompactionHistory(events,{reference});
 return `<details class="usage-history-table"><summary>Captured context compactions · ${history.count===null?'Unavailable':full(history.count)+' unambiguous records'}</summary><p class="note">${esc(scope)} · event clock ${esc(time(reference))}. Counted from exact typed source operation records in this map window, not an account-wide total or native OTel estimate. Legacy records without the discriminator cannot establish zero compactions. Captured coverage is partial.</p><dl class="account-facts">${fact('Distinct typed source records',full(history.count))}${fact('Identical duplicates / conflicting identities',history.duplicates+' / '+history.conflictingIdentities)}${fact('Missing identity / invalid chronology',history.identityMissing+' / '+history.invalidClock)}${fact('Future typed / untyped legacy operations',history.futureRows+' / '+history.untypedOperations)}${fact('Scanned current-scope events',history.scannedRows+(history.inputTruncated?' · bounded input':'')+' · complete coverage not established')}</dl>${history.rows.length?`<div class="usage-table-scroll" tabindex="0" role="region" aria-label="Usage data table; scroll horizontally for more columns"><table><caption>Latest ${history.rows.length} of ${history.count} unambiguous captured compactions${history.rowsTruncated?' · bounded history preview':''}</caption><thead><tr><th scope="col">Exact event / source clock</th><th scope="col">Worker / project</th><th scope="col">Recorded interval</th></tr></thead><tbody>${history.rows.map(row=>`<tr><th scope="row">${targetButton(row,'Locate compaction')}<small>${esc(time(row.at))} · ${esc(row.sourceId)}</small></th><td>${esc(row.hostId)} / ${esc(row.sessionId)}<small>${esc(row.project||'Unknown project')}</small></td><td>${row.durationMs===null?'Unavailable':full(row.durationMs)+' ms'}<small>Source start ${esc(time(row.startedAt))} / completion ${esc(time(row.completedAt))}</small></td></tr>`).join('')}</tbody></table></div>`:'<p class="note">No unambiguous typed compaction record is available in the captured scope. This does not establish that none occurred.</p>'}</details>`;
}

export function renderComparableDimensions(responses={}){
 const supplied=Array.isArray(responses?.dimensions)?responses.dimensions:[],valid=supplied.filter(row=>row&&typeof row==='object'&&!Array.isArray(row)),shown=valid.slice(0,24),unknown=value=>text(value)||'Unknown (not captured)';
 return `<details class="usage-history-table"><summary>Comparable historical dimensions (${shown.length}${valid.length>shown.length?' of '+valid.length+' returned buckets':''}${responses?.dimensionsTruncated?' · source projection bounded':''})</summary><p class="note">Captured comparable native response identities grouped by host, project and configured provider/model/effort/service tier. Producing model unavailable. Unknown buckets remain separate; these are captured observations, not account-wide completeness. Input includes cache; output includes reasoning; subset columns must not be added again.</p>${shown.length?`<div class="usage-table-scroll" tabindex="0" role="region" aria-label="Usage data table; scroll horizontally for more columns"><table><thead><tr>${['Host','Project','Configured provider','Configured model','Configured effort','Configured service tier','Responses',...fields.map(field=>field[2]),'Latest source'].map(label=>`<th scope="col">${esc(label)}</th>`).join('')}</tr></thead><tbody>${shown.map(row=>`<tr><th scope="row">${esc(unknown(row.hostId))}</th>${['project','contextProvider','contextModel','contextEffort','contextServiceTier'].map(name=>`<td>${esc(unknown(row[name]))}</td>`).join('')}<td>${full(row.responseCount)}</td>${fields.map(field=>`<td class="${field[3]}">${full(row[field[0]])}</td>`).join('')}<td>${esc(time(row.sourceAt))}</td></tr>`).join('')}</tbody></table></div>${valid.length>shown.length||responses?.dimensionsTruncated?'<p class="note">Bounded dimension preview. Omitted buckets are not represented as zero; complete captured samples remain in durable history.</p>':''}`:'<p class="note">Comparable dimension buckets are unavailable in this response. Unknown native identities are excluded from comparable response sums.</p>'}${supplied.length>valid.length?'<p class="note">Malformed dimension rows were excluded from this presentation.</p>':''}</details>`;
}

const safeSum=(rows,field)=>{if(!rows.length)return null;let total=0;for(const row of rows){const value=count(row[field]);if(value===null||!Number.isSafeInteger(total+value))return null;total+=value;}return total;};
const familyTotals=rows=>({responseCount:safeSum(rows,'responseCount'),...Object.fromEntries(fields.map(([field])=>[field,safeSum(rows,field)]))});
export function buildCurrentFamilyUsage(report,sessions=[],{now=Date.now(),maxFamilies=12,lineageScope='Current selected-scope same-host parentId lineage',sessionRestricted=false}={}){
 const supplied=Array.isArray(sessions)?sessions:[],nodes=new Map(),conflictedNodes=new Set(),roots=new Map(),excluded={missingIdentity:0,duplicateLineage:0,missingParent:0,cycles:0,forks:0,invalidTurns:0,conflictingTurns:0,overlappingSamples:0};
 const identity=(host,id)=>key([host,id]);
 for(const session of supplied.slice(0,1000)){
  if(!session||!text(session.hostId,256)||!text(session.id,256)){excluded.missingIdentity++;continue;}
  const id=identity(session.hostId,session.id),signature=key([session.parentId??null,session.forkedFrom??null]);
  if(nodes.has(id)){if(nodes.get(id).signature!==signature)conflictedNodes.add(id);continue;}nodes.set(id,{session,signature});
 }
 function rootFor(id){
  if(roots.has(id))return roots.get(id);const trail=[],visited=new Set();let current=id,result;
  for(;;){
   if(roots.has(current)){result=roots.get(current);break;}
   if(visited.has(current)){result={reason:'cycles'};break;}visited.add(current);trail.push(current);
   const entry=nodes.get(current);if(!entry){result={reason:'missingParent'};break;}if(conflictedNodes.has(current)){result={reason:'duplicateLineage'};break;}
   const session=entry.session;if(session.forkedFrom){result={reason:'forks'};break;}if(!session.parentId){result={root:current};break;}
   current=identity(session.hostId,session.parentId);
  }
  for(const member of trail)roots.set(member,result);return result;
 }
 const linkedRoots=new Set();for(const [id,{session}] of nodes){const root=rootFor(id);if(root.reason){excluded[root.reason]++;continue;}if(session.parentId)linkedRoots.add(root.root);}
 const families=new Map();for(const root of linkedRoots){const session=nodes.get(root).session;families.set(root,{rootId:session.id,hostId:session.hostId,project:text(session.project),members:[],turns:[]});}
 for(const [id,{session}] of nodes){const root=rootFor(id);if(root.root&&families.has(root.root))families.get(root.root).members.push({hostId:session.hostId,sessionId:session.id,isRoot:id===root.root});}
 const suppliedTurns=Array.isArray(report?.responses?.turns)?report.responses.turns:[],turns=new Map(),conflicts=new Set(),sampleOwners=new Map(),from=at(report?.scope?.from),to=at(report?.scope?.to);
 for(const turn of suppliedTurns.slice(0,200)){
  const sourceAt=at(turn?.sourceAt);if(!turn||!text(turn.hostId,256)||!text(turn.sessionId,256)||!text(turn.turnId,256)||count(turn.responseCount)===null||turn.responseCount<1||sourceAt===null||sourceAt>now||from!==null&&sourceAt<from||to!==null&&sourceAt>to){excluded.invalidTurns++;continue;}
  const sampleKeys=[...new Set((Array.isArray(turn.sampleKeys)?turn.sampleKeys:[]).filter(value=>typeof value==='string').slice(0,100))].sort(),id=key([turn.hostId,turn.sessionId,turn.nativeThreadId??null,turn.nativeSessionId??null,turn.turnId]),signature=key([sourceAt,turn.responseCount,...fields.map(([field])=>count(turn[field])),sampleKeys,turn.sampleKeysTruncated===true]),previous=turns.get(id);
  if(previous){if(previous.signature!==signature)conflicts.add(id);continue;}turns.set(id,{turn,signature});
  for(const sampleKey of sampleKeys){if(sampleOwners.has(sampleKey)&&sampleOwners.get(sampleKey)!==id){conflicts.add(id);conflicts.add(sampleOwners.get(sampleKey));excluded.overlappingSamples++;}else sampleOwners.set(sampleKey,id);}
 }
 excluded.conflictingTurns=conflicts.size;
 for(const [id,{turn}] of turns){if(conflicts.has(id))continue;const root=rootFor(identity(turn.hostId,turn.sessionId));if(root.root&&families.has(root.root))families.get(root.root).turns.push(turn);}
 const all=[...families.values()].filter(family=>family.turns.length).map(family=>{
  const direct=family.turns.filter(turn=>turn.sessionId===family.rootId),descendants=family.turns.filter(turn=>turn.sessionId!==family.rootId),observedMembers=new Set(family.turns.map(turn=>turn.sessionId));
  return {...family,direct:familyTotals(direct),descendants:familyTotals(descendants),family:familyTotals(family.turns),missingMembers:family.members.filter(member=>!observedMembers.has(member.sessionId)).length};
 }).sort((a,b)=>a.hostId.localeCompare(b.hostId)||a.rootId.localeCompare(b.rootId));
 const limit=Number.isSafeInteger(maxFamilies)?Math.max(1,Math.min(24,maxFamilies)):12;
 return {status:all.length?'observed':'unavailable',families:all.slice(0,limit),familyCount:all.length,truncated:all.length>limit||supplied.length>1000||suppliedTurns.length>200||report?.responses?.turnsTruncated===true||report?.coverage?.truncated===true,qualifiedLinks:[...nodes].filter(([id,{session}])=>session.parentId&&rootFor(id).root).length,excluded,lineageScope:text(lineageScope,240),sessionRestricted:sessionRestricted===true,complete:false};
}

export function renderCurrentFamilyUsage(report,sessions=[],{now=Date.now(),lineageScope,sessionRestricted=false}={}){
 const value=buildCurrentFamilyUsage(report,sessions,{now,lineageScope,sessionRestricted});
 return `<details class="usage-history-table"><summary>Current root/direct and family usage · ${value.status}${value.sessionRestricted?' · selected-session partial':''}${value.truncated?' · bounded':''}</summary><p class="note">${esc(value.lineageScope)} applied to the returned comparable native response window. This is not historical lineage, parent cumulative counters, inherited fork usage or account-wide completeness. Input/cache and output/reasoning remain inclusive/subset counters.</p>${value.sessionRestricted?'<p class="account-status-warning">Selected-session response samples only. Other family members supply lineage context, not additional usage readings; this view cannot establish the full family total.</p>':''}<dl class="account-facts">${fact('Qualified parent links / visible families',value.qualifiedLinks+' / '+value.familyCount)}${fact('Missing identity / conflicting lineage / missing parent',value.excluded.missingIdentity+' / '+value.excluded.duplicateLineage+' / '+value.excluded.missingParent)}${fact('Cycle / fork exclusions',value.excluded.cycles+' / '+value.excluded.forks)}${fact('Invalid / conflicting turns / overlapping samples',value.excluded.invalidTurns+' / '+value.excluded.conflictingTurns+' / '+value.excluded.overlappingSamples)}</dl>${value.families.length?value.families.map(family=>`<details><summary>${esc(family.hostId)} / ${esc(family.rootId)} · ${family.members.length} current members</summary><p class="note">${family.missingMembers} members lack comparable returned response readings. Missing readings and per-field unknowns remain unavailable; no cumulative session or fork totals are added.</p><div class="usage-table-scroll" tabindex="0" role="region" aria-label="Usage data table; scroll horizontally for more columns"><table><thead><tr><th scope="col">Current lineage scope</th><th scope="col">Responses</th>${fields.map(field=>`<th scope="col">${esc(field[2])}</th>`).join('')}</tr></thead><tbody>${[['Root direct',family.direct],['Descendants',family.descendants],[value.sessionRestricted?'Selected-session contribution':'Captured family',family.family]].map(([label,totals])=>`<tr><th scope="row">${label}</th><td>${full(totals.responseCount)}</td>${fields.map(field=>`<td class="${field[3]}">${full(totals[field[0]])}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p>${family.members.slice(0,12).map(member=>targetButton(member,(member.isRoot?'Root ':'Descendant ')+member.sessionId)).join(' ')}</p>${family.members.length>12?'<p class="note">First twelve current member navigation controls shown.</p>':''}</details>`).join(''):'<p class="note">No qualified current parent links with comparable native response identities are available. Family/direct usage is unavailable.</p>'}${value.truncated?'<p class="note">This family view is bounded by returned response history and current selected-scope lineage; omitted data is not zero.</p>':''}</details>`;
}

const usageCoverageFields=[['discoveredFiles','Discovered files'],['scannedFiles','Scanned files'],['unscannedFiles','Unscanned files'],['heldFiles','Held files'],['incompleteFiles','Incomplete files'],['invalidRecords','Invalid records'],['resetFiles','Reset files'],['readBytes','Read bytes'],['sampleCount','Captured samples'],['sampleBytes','Sample bytes'],['errorsTruncated','Omitted reason records']];
const captureReasons=new Set(['metadata-unavailable','metadata-invalid','metadata-identity-unavailable','source-symlink-refused','source-unavailable','cursor-capacity-refused','read-budget-exhausted','source-read-unavailable','record-size-refused','invalid-json-record']);
const sourceVersion=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value)?value:'Unknown (not captured)';
export function renderSourceCaptureDiagnostics(hosts=[],sessions=[]){
 const supplied=Array.isArray(hosts)?hosts:[],shown=supplied.filter(host=>host&&typeof host==='object').slice(0,16),versions=new Map();
 for(const session of (Array.isArray(sessions)?sessions:[]).slice(0,1000)){if(!session||typeof session.hostId!=='string')continue;const version=sourceVersion(session.version);if(!versions.has(session.hostId))versions.set(session.hostId,new Map());const counts=versions.get(session.hostId);counts.set(version,(counts.get(version)||0)+1);}
 const label=(host,index)=>{const value=text(host.name||host.id,100);return !value||/[\\/:@]|\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(value)?'Authorized source '+(index+1):value;};
 return `<details class="usage-history-table"><summary>Selected-source capture diagnostics (${shown.length}${supplied.length>shown.length?' of '+supplied.length+' sources':''})</summary><p class="note">Allowlisted metadata from the supplied authorized source snapshot. Missing coverage is unavailable, not zero or proof of complete collection. Source versions describe captured session metadata. File paths, network addresses, source file identities and raw errors are omitted.</p>${shown.map((host,index)=>{
  const coverage=host.coverage?.numericUsage,valid=coverage&&typeof coverage==='object'&&!Array.isArray(coverage),reasonCounts=new Map();for(const record of (Array.isArray(coverage?.errors)?coverage.errors:[]).slice(0,32))if(captureReasons.has(record?.code))reasonCounts.set(record.code,(reasonCounts.get(record.code)||0)+1);
  const capturedVersions=[...(versions.get(host.id)||new Map())].sort((a,b)=>a[0].localeCompare(b[0])),status=['online','stale','disconnected','unavailable','never-seen'].includes(host.status)?host.status:'Unknown';
  return `<h4>${esc(label(host,index))}</h4><dl class="account-facts">${fact('Source status',status)}${fact('Numeric capture coverage',valid?'Reported · partial capture metadata':'Unavailable')}${fact('Coverage schema version',full(coverage?.version))}${fact('Numeric source',coverage?.source==='codex-rollout-numeric'?coverage.source:'Unknown')}${fact('Backlog',typeof coverage?.backlogged==='boolean'?coverage.backlogged?'Yes':'No':'Unavailable')}${fact('Inventory limited',typeof coverage?.inventoryLimited==='boolean'?coverage.inventoryLimited?'Yes':'No':'Unavailable')}${usageCoverageFields.map(([field,name])=>fact(name,full(coverage?.[field]))).join('')}${fact('Capture reasons',reasonCounts.size?[...reasonCounts].map(([reason,n])=>reason+' ('+n+')').join(' · '):'No allowlisted reason reported')}${fact('Captured session source versions',capturedVersions.length?capturedVersions.slice(0,16).map(([version,n])=>version+' ('+n+' sessions)').join(' · ')+(capturedVersions.length>16?' · additional version buckets omitted':''):'Unavailable')}</dl>`;
 }).join('')||'<p class="note">No selected-source coverage snapshot is available.</p>'}</details>`;
}

// A comparison needs three earlier non-overlapping windows. Sliding refreshes
// cannot pad the baseline, re-emit a spike or substitute for source continuity.
export class BurnSpikeTracker{
 constructor({ratio=3,minRate=1000,maxWorkers=64,maxWindows=8}={}){this.ratio=ratio;this.minRate=minRate;this.maxWorkers=Math.min(64,Math.max(1,maxWorkers));this.maxWindows=Math.min(8,Math.max(3,maxWindows));this.clear();}
 clear(){this.scope=null;this.epoch=null;this.sequence=null;this.observedAt=null;this.history=new Map();this.alerts=[];}
 observe(payload,{scope='all',now=Date.now()}={}){
  const burn=payload?.burnUsage,timestamp=at(burn?.observedAt),windowMs=count(burn?.windowMs),epoch=typeof burn?.epoch==='string'?burn.epoch:null,sequence=count(burn?.lastSequence??burn?.latestSequence);
  if(!burn||burn.status!=='observed'||timestamp===null||timestamp>now||now-timestamp>120000||!windowMs||windowMs>3600000){this.clear();return [];}
  if(this.scope!==scope||this.epoch!==epoch||this.sequence!==null&&sequence!==null&&sequence<this.sequence)this.clear();
  this.scope=scope;this.epoch=epoch;this.sequence=sequence;
  if(this.observedAt!==null&&timestamp<=this.observedAt)return this.current(now);this.observedAt=timestamp;
  const present=new Set(),alerts=[];
  for(const row of (Array.isArray(burn.workers)?burn.workers:[]).slice(0,this.maxWorkers)){
   if(!text(row?.hostId,256)||!text(row?.sessionId,256)||rate(row.inputPerSecond)===null||rate(row.outputPerSecond)===null||row.forkedFrom||row.gap===true)continue;
   const worker=key([row.hostId,row.sessionId]),measuredRate=row.inputPerSecond+row.outputPerSecond;if(!Number.isFinite(measuredRate))continue;present.add(worker);
   let history=this.history.get(worker)||[];const previous=history.at(-1);if(previous&&(previous.windowMs!==windowMs||timestamp-previous.at>windowMs*2))history=[];
   if(history.length&&timestamp-history.at(-1).at<windowMs){alerts.push(...this.alerts.filter(alert=>alert.hostId===row.hostId&&alert.sessionId===row.sessionId&&timestamp-at(alert.at)<windowMs));continue;}
   const baseline=median(history.map(value=>value.rate));
   if(history.length>=3&&baseline!==null&&baseline>0&&measuredRate>=this.minRate&&measuredRate>=baseline*this.ratio){
    const turn=(payload?.sampleAnalytics?.responses?.turns||[]).filter(t=>t.hostId===row.hostId&&t.sessionId===row.sessionId&&at(t.sourceAt)!==null&&at(t.sourceAt)<=timestamp&&at(t.sourceAt)>timestamp-windowMs).sort((a,b)=>at(b.sourceAt)-at(a.sourceAt))[0];
    alerts.push({id:'burn-spike:'+encodeURIComponent(worker)+':'+timestamp,kind:'burn-spike',category:'error',attention:true,severity:'warning',priority:1,hostId:row.hostId,sessionId:row.sessionId,turnId:turn?.turnId||null,project:text(row.project),at:new Date(timestamp).toISOString(),label:`Observed sampled burn spike · ${text(row.label||row.sessionId,80)} · ${Math.round(measuredRate).toLocaleString()} t/s · ${(measuredRate/baseline).toFixed(1)}× baseline`,measuredRate,baselineRate:baseline,baselineWindows:history.length,windowMs,thresholdRatio:this.ratio,minimumRate:this.minRate,method:'Inclusive input + output; median of preceding non-overlapping observed windows',target:'analytics'});
   }
   history.push({at:timestamp,rate:measuredRate,windowMs});this.history.set(worker,history.slice(-this.maxWindows));
  }
  for(const worker of this.history.keys())if(!present.has(worker))this.history.delete(worker);this.alerts=alerts;return this.current(now);
 }
 current(now=Date.now()){return this.alerts.filter(alert=>now>=at(alert.at)&&now-at(alert.at)<=Math.min(120000,alert.windowMs));}
}

export function renderObservedRatios(ratios,{label='Sampled-window input ratios'}={}){
 if(!ratios||typeof ratios!=='object')return '';
 const rows=[['cacheHit','Cache-hit share','cached input / inclusive input'],['newInputFraction','New-input fraction','(input − cached) / inclusive input']].map(([key,label,formula])=>{
  const ratio=ratios[key]||{},valid=ratio.classification==='derived'&&ratio.method==='ratio-of-sums'&&typeof ratio.value==='number'&&Number.isFinite(ratio.value)&&ratio.value>=0&&ratio.value<=1;
  return fact(label,valid?(ratio.value*100).toFixed(1)+'%':'Unavailable')+fact('Comparable / excluded observations',full(ratio.comparableRows)+' / '+full(ratio.excludedRows))+fact('Comparable numerator / denominator',full(ratio.numerator)+' / '+full(ratio.denominator))+fact('Derived method',formula+' · ratio of sums'+(ratio.reason?' · '+text(ratio.reason):''));
 }).join('');
 return `<details class="usage-history-table"><summary>${esc(label)}</summary><dl class="account-facts">${rows}</dl><p class="note">Derived from comparable input/cache pairs in the sampled burn window. Independent partial totals are not divided; per-row percentages are not averaged. These source-observation ratios can be available when exact native response identities are unavailable.</p></details>`;
}

export function renderQuotaPace(rows,{now=Date.now()}={}){
 if(!Array.isArray(rows))return '';const shown=rows.slice(0,16),hours=value=>rate(value)===null?'Unavailable':value.toLocaleString(undefined,{maximumFractionDigits:2})+' h';
 return `<details class="usage-history-table"><summary>Source-scoped quota pace · conditional estimates (${shown.length}${rows.length>shown.length?' of '+rows.length+' returned':''})</summary><p class="note">Estimated from each source’s separate allowance window. Source continuity is assumed; cross-machine provider-account identity is not established. No pooling, token-to-quota conversion or guaranteed exhaustion time. Reset boundaries remain separate.</p>${shown.length?shown.map(row=>{
  const observed=at(row.observedAt),fresh=observed!==null&&observed<=now&&now-observed<=300000,eligible=row.status==='estimated'&&row.classification==='estimated'&&fresh,range=row.runwayRange&&rate(row.runwayRange.fastHours)!==null&&rate(row.runwayRange.slowHours)!==null?hours(row.runwayRange.fastHours)+' — '+hours(row.runwayRange.slowHours):'Unavailable';
  const reset=typeof row.resetsAt==='number'?row.resetsAt*1000:row.resetsAt;
  return `<h4>${esc(text(row.hostId))} / ${esc(text(row.limitId))} · ${esc(text(row.window))}</h4><dl class="account-facts">${fact('Forecast status',eligible?'Estimated · conditional':!fresh?'Unavailable · stale or missing source':row.reason?'Unavailable · '+text(row.reason).replaceAll('-',' '):'Unavailable')}${fact('Reported used / remaining',rate(row.usedPercent)===null||rate(row.remainingPercent)===null?'Unavailable':row.usedPercent+'% / '+row.remainingPercent+'%')}${fact('Observed quota pace',eligible&&rate(row.percentagePointsPerHour)!==null?row.percentagePointsPerHour.toLocaleString(undefined,{maximumFractionDigits:3})+' percentage points/hour':'Unavailable')}${fact('Runway at unchanged pace',eligible?hours(row.runwayHours):'Unavailable')}${fact('Observed pace range',eligible?range:'Unavailable')}${fact('Distinct readings / observed span',full(row.observations)+' / '+(count(row.spanMs)===null?'Unavailable':(row.spanMs/60000).toLocaleString(undefined,{maximumFractionDigits:1})+' min'))}${fact('Required span / maximum gap',(count(row.minimumSpanMs)===null?'Unavailable':row.minimumSpanMs/60000+' min')+' / '+(count(row.maximumGapMs)===null?'Unavailable':row.maximumGapMs/60000+' min'))}${fact('Source observed / allowance reset',time(observed)+' / '+time(reset))}${fact('Continuity boundary',text(row.boundary)||'None reported')}</dl>`;
 }).join(''):'<p class="note">No source window has comparable quota-pace observations in this view.</p>'}</details>`;
}

export function renderUsageAnalytics(report,{now=Date.now(),events=[],eventReference=now,eventScope='selected retained map scope',state='unavailable',allowQuotaPace=true,sessions=[],hosts=[],lineageScope,sessionRestricted=false}={}){
 if(!report||report.version!==2)return '<section class="account-usage-section" id="usage-analytics" tabindex="-1"><h3>Captured response evidence</h3><p class="note">'+(state==='loading'?'Loading captured response details…':state==='stale'?'Detail read unavailable. Retry while this dialog is open.':'Usage-sample analytics unavailable. Collection and archival remain separate from this view.')+'</p>'+renderCompactionHistory(events,{reference:eventReference,scope:eventScope})+renderCurrentFamilyUsage(report,sessions,{now,lineageScope,sessionRestricted})+renderSourceCaptureDiagnostics(hosts,sessions)+'</section>';
 const coverage=report.coverage||{},responses=report.responses||{},source=at(coverage.latestSourceAt),received=at(coverage.latestReceivedAt),age=source===null?'source time unavailable':source>now?'source clock ahead':Math.floor((now-source)/1000)+'s source age',totals=responses.totals||{};
 const ratios=[['cacheHit','Cache-hit share','cached input / inclusive input'],['reasoningShare','Reasoning share','reasoning / inclusive output'],['newInputFraction','New-input fraction','(input − cached) / inclusive input']].map(([name,label,formula])=>{const ratio=responses.ratios?.[name]||{},valid=typeof ratio.value==='number'&&Number.isFinite(ratio.value)&&ratio.value>=0&&ratio.value<=1;return `${fact(label,valid?(ratio.value*100).toFixed(1)+'%':'Unavailable')}${fact('Comparable / excluded',full(ratio.comparableRows)+' / '+full(ratio.excludedRows))}${fact('Derived method',formula+' · ratio of sums'+(ratio.reason?' · '+text(ratio.reason):''))}`;}).join('');
 const turns=(Array.isArray(responses.turns)?responses.turns:[]).slice(0,24),turnTable=turns.length?`<details class="usage-history-table"><summary>Exact response identities by turn (${turns.length}${Array.isArray(responses.turns)&&responses.turns.length>turns.length?' of '+responses.turns.length+' returned turns':''}${responses.turnsTruncated?' · bounded':''})</summary><div class="usage-table-scroll" tabindex="0" role="region" aria-label="Usage data table; scroll horizontally for more columns"><table><thead><tr><th scope="col">Turn / worker</th><th scope="col">Configured context</th><th scope="col">Responses</th>${fields.map(f=>`<th scope="col">${f[2]}</th>`).join('')}</tr></thead><tbody>${turns.map(turn=>`<tr><th scope="row">${targetButton({hostId:turn.hostId,sessionId:turn.sessionId,turnId:turn.turnId},text(turn.turnId,24)||'Turn')}<small>${esc(text(turn.hostId))} / ${esc(text(turn.sessionId,80))}</small></th><td>${esc(turn.mixedContext?'Mixed configured context':[text(turn.contextModel)||'Unavailable',text(turn.contextEffort),text(turn.contextServiceTier)].filter(Boolean).join(' · '))}<small>Producing model unavailable</small></td><td>${full(turn.responseCount)}</td>${fields.map(f=>`<td class="${f[3]}">${full(turn[f[0]])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`:'<p class="note">No comparable native response identities. Last-response and cumulative snapshots remain retained evidence and are excluded from response sums.</p>';
 const recent=(Array.isArray(report.recent)?report.recent:[]).slice(0,100),raw=`<details class="usage-history-table"><summary>Captured numeric source evidence (${recent.length} rows)</summary><p class="note">Read-only source values, not additive totals. Configured context does not establish the producing model. All counter subsets remain separate.</p><div class="usage-table-scroll" tabindex="0" role="region" aria-label="Usage data table; scroll horizontally for more columns"><table><thead><tr><th scope="col">Source / identity</th>${fields.map(f=>`<th scope="col">${f[2]}</th>`).join('')}<th scope="col">Provenance</th></tr></thead><tbody>${recent.map(row=>`<tr><th scope="row">${targetButton({hostId:row.host_id,sessionId:row.session_id,turnId:row.native_turn_id||null,sampleKey:row.sample_key},text(row.native_response_id||row.sample_key,24)||'Observation')}<small>${esc(text(row.source_kind))} · ${esc(text(row.usage_scope))} · ${esc(text(row.accounting_class))}</small><small>${esc(time(row.source_ms))} source / ${esc(time(row.received_ms))} received</small></th>${fields.map(f=>`<td class="${f[3]}">${full(row[f[1]])}</td>`).join('')}<td>${esc(text(row.context_model)||'Context unavailable')} (configured)<small>Source version ${esc(sourceVersion(row.source_version))}</small><small>reported ${full(row.reported_mask)} · provider ${full(row.provider_reported_mask)} · synthesized ${full(row.synthesized_mask)}</small><small>${esc(text(row.sample_key,64))}</small></td></tr>`).join('')}</tbody></table></div></details>`;
 const tools=buildRecordedToolMetrics(events,{reference:eventReference}),toolRows=tools.rows.slice(0,24),toolDetails=`<details class="usage-history-table"><summary>Recorded tool reliability (${tools.calls} calls · ${tools.matched} matched)</summary><p class="note">${esc(eventScope)} · event clock ${esc(time(eventReference))}. Matched captured start/result clocks measure recorded elapsed time, not native TTFT, provider generation speed or wall time across overlapping calls. Missing and cancelled calls are separate from failures. Matched elapsed statistics include recorded cancellation/unknown outcomes.</p><dl class="account-facts">${fact('Explicit completed / failed',tools.completed+' / '+tools.failed)}${fact('Cancelled / outcome unknown',tools.cancelled+' / '+tools.unknown)}${fact('Missing start / result',tools.missingStart+' / '+tools.missingResult)}${fact('Ambiguous / invalid clock',tools.ambiguous+' / '+tools.invalidClock)}${fact('Missing identity / duplicate conflict',tools.identityMissing+' / '+tools.duplicateConflicts)}${fact('Recorded elapsed p50 / p95',tools.p50Ms===null?'Unavailable':tools.p50Ms+' / '+tools.p95Ms+' ms')}</dl>${toolRows.map(row=>`<p>${targetButton(row,row.label)} · ${esc(row.state)} · ${row.durationMs===null?'elapsed unavailable':row.durationMs+' ms'}</p>`).join('')}${tools.calls>toolRows.length?'<p class="note">Latest '+toolRows.length+' calls shown; totals cover all captured calls in this scope.</p>':''}</details>`;
 return `<section class="account-usage-section" id="usage-analytics" tabindex="-1"><h3>Captured response evidence · ${esc(text(responses.status)||'unavailable')}</h3>${state==='stale'?'<p class="account-status-warning">Detail refresh failed · retained same-scope readings shown.</p>':''}<p class="note">Captured-source scope · ${esc(time(report.scope?.from))} — ${esc(time(report.scope?.to))} · ${esc(age)}. ${coverage.truncated?'PARTIAL · returned rows are bounded; captured data remains stored.':'Coverage describes captured records, not account-wide completeness.'}</p><dl class="account-facts">${fact('Retained / matching / returned rows',full(coverage.retainedRows)+' / '+full(coverage.matchingRows)+' / '+full(coverage.returnedRows))}${fact('Exact native responses',full(responses.responseCount))}${fact('Excluded accounting / missing identity / conflicts',full(coverage.excludedRows)+' / '+full(coverage.identityMissing)+' / '+full(coverage.conflictingResponses))}${fact('Latest source / receipt',time(source)+' / '+time(received))}${fields.map(f=>fact(f[2]+' · reported response sum',full(totals[f[0]]))).join('')}</dl><p class="note">Input includes cached input; output includes reasoning. Subsets are never added twice. Host observations can overlap when copied; no cross-host or account-wide completeness is inferred.</p><details class="usage-history-table"><summary>Comparable weighted ratios</summary><dl class="account-facts">${ratios}</dl><p class="note">Only comparable valid pairs contribute. Unknown and inconsistent counters remain evidence; percentages are not averaged.</p></details>${turnTable}${renderComparableDimensions(responses)}${renderCurrentFamilyUsage(report,sessions,{now,lineageScope,sessionRestricted})}${raw}${renderCompactionHistory(events,{reference:eventReference,scope:eventScope})}${allowQuotaPace?renderQuotaPace(report.quotaPace,{now}):''}${toolDetails}${renderSourceCaptureDiagnostics(hosts,sessions)}</section>`;
}
