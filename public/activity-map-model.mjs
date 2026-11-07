// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// Read-only projection. A relationship is not a network packet or a dispatch receipt.
import {deviceVisual} from './ui-model.mjs';
// Source records survive many paints. Cache only their parsed source clock,
// never filtered records, graph nodes or time-dependent worker state. A changed
// timestamp (including an invalid one) invalidates the entry immediately.
const sourceClocks=new WeakMap();
const at=e=>{const value=e.at;if(typeof value!=='string')return Date.parse(value);const cached=sourceClocks.get(e);if(cached&&cached.value===value)return cached.time;const time=Date.parse(value);sourceClocks.set(e,{value,time});return time;};
const workerKey=(host,session)=>host+'/'+session;
const callKey=e=>JSON.stringify([e.hostId,e.sourceId,e.sessionId,e.turnId,e.callId||e.id]);
const workerId=(host,session)=>'worker:'+workerKey(host,session);
const failed=e=>e?.outcome==='failed'||e?.outcome==='interrupted'||e?.kind==='error';
const eventLabel=e=>typeof e?.label==='string'?e.label:'Unlabeled operation';
const colors={command:'#20cfff',edit:'#ff9b32',research:'#00e3bb',agent:'#bf83ff',tool:'#79bfff',remote:'#9bef38',approval:'#ffda55',return:'#6ff0be',error:'#ff5a75'};
export function toolDestination(label='',category='tool'){
 // Match a provider identity, never a host, URL or arbitrary command argument.
 const name=(typeof label==='string'?label:'').split(' · ')[0];
 if(/^mcp__codex_apps__github(?:__|[._/])/.test(name))return {id:'github',label:'GitHub',icon:'github',detail:'GitHub connector; individual repository not captured'};
 if(/^mcp__codex_apps__/.test(name)){const provider=name.split('__')[2]||'connector';return {id:'connector:'+provider,label:provider.replaceAll('_',' '),icon:'service',detail:'Named MCP connector; upstream action is recorded separately'};}
 if(/^mcp__cua_repl[._/]/.test(name))return {id:'browser',label:'Browser tools',icon:'browser',detail:'Browser interface; destination website not captured'};
 if(/^(?:functions\.)?(?:exec|exec_command|write_stdin)$/.test(name)||category==='command')return {id:'command',label:'Command tools',icon:'terminal',detail:'Command interface; execution destination not captured'};
 if(category==='edit')return {id:'files',label:'Files & patches',icon:'file',detail:'File tool interface; file contents are excluded'};
 if(category==='research')return {id:'research',label:'Research tools',icon:'search',detail:'Research interface; website destination not inferred'};
 if(category==='agent')return {id:'agents',label:'Agent tools',icon:'agent',detail:'Agent interface; child relationship requires explicit metadata'};
 return {id:'tools',label:'Other tools',icon:'tool',detail:'Tool result identity available; external destination not captured'};
}
export function packetProgress(leg,reference,mode,freshIds,eventId){
 const elapsed=reference-(mode==='live'&&Number.isFinite(leg.observedAt)?leg.observedAt:leg.at);
 if(elapsed<0||elapsed>=2400||mode==='live'&&!freshIds.has(eventId))return null;
 return elapsed/2400;
}
export function projectActivity({events=[],sessions=[],hosts=[],reference=Date.now(),windowMs=60000,filter={},focus='',maxWorkers=6,preferences={},selectedEvent=null}){
 maxWorkers=(preferences?.planeWorkers??maxWorkers)===8?8:6;
 const scope=e=>(!filter.hostId||e.hostId===filter.hostId||e.workerHostId===filter.hostId)&&(!filter.project||e.project===filter.project)&&(!filter.sessionId||workerKey(e.hostId,e.sessionId)===filter.sessionId||workerKey(e.workerHostId,e.workerSessionId)===filter.sessionId)&&(!filter.category||e.category===filter.category||e.kind===filter.category||filter.category==='error'&&failed(e))&&(!filter.search||(e.label+' '+e.project+' '+e.sessionId).toLowerCase().includes(filter.search.toLowerCase()));
 // Match filter's length snapshot and HasProperty behavior, including inherited
 // entries, without allocating the filtered array or one [id, record] per row.
 const indexed=new Map();for(let i=0,length=events.length;i<length;i++){if(!(i in events))continue;const e=events[i];if(Number.isFinite(at(e))&&at(e)<=reference&&scope(e))indexed.set(e.id,e);}
 const records=[...indexed.values()].sort((a,b)=>at(a)-at(b)||a.id.localeCompare(b.id));
 const hostMap=new Map(hosts.map(h=>[h.id,h])),sessionMap=new Map(sessions.map(s=>[workerKey(s.hostId||'local',s.id),s]));
 const latest=new Map();for(const e of records)if(!e.kind.startsWith('remote.'))latest.set(workerKey(e.hostId,e.sessionId),e);
 const candidates=new Map();
 for(const s of sessions){if(s.role==='execution-job'||filter.project&&s.project!==filter.project||filter.hostId&&s.hostId!==filter.hostId)continue;const k=workerKey(s.hostId||'local',s.id),last=latest.get(k);if(!last&&Date.parse(s.lastEventAt)>reference)continue;candidates.set(k,{...s,last,lastAt:last?at(last):Date.parse(s.lastEventAt)||0});}
 for(const e of records){if(e.kind.startsWith('remote.')&&e.workerHostId&&e.workerSessionId){const k=workerKey(e.workerHostId,e.workerSessionId);if(!candidates.has(k)){const s=sessionMap.get(k);candidates.set(k,{...s,id:e.workerSessionId,hostId:e.workerHostId,project:s?.project||e.project,lastAt:at(e),last:latest.get(k)});}else candidates.get(k).lastAt=Math.max(candidates.get(k).lastAt,at(e));}}
 const ranked=[...candidates.values()].sort((a,b)=>Number(workerKey(b.hostId,b.id)===focus)-Number(workerKey(a.hostId,a.id)===focus)||b.lastAt-a.lastAt||workerKey(a.hostId,a.id).localeCompare(workerKey(b.hostId,b.id)));
 // A quiet period is not an empty fleet. Preserve the most recently observed
 // retained workers after recent/focused workers, within the same bounded scope.
 const inSessionScope=s=>!filter.sessionId||workerKey(s.hostId,s.id)===filter.sessionId;
 const recentWorkers=ranked.filter(s=>inSessionScope(s)&&(s.lastAt>=reference-windowMs||workerKey(s.hostId,s.id)===focus));
 const recentKeys=new Set(recentWorkers.map(s=>workerKey(s.hostId,s.id)));
 const retainedWorkers=ranked.filter(s=>inSessionScope(s)&&s.lastAt>0&&!recentKeys.has(workerKey(s.hostId,s.id)));
 let chosen=[...recentWorkers,...retainedWorkers].slice(0,maxWorkers);
 // Keep a selected child's actual parent visible without allowing an unbounded tree.
 for(const s of [...chosen]){if(!s.parentId)continue;const parent=candidates.get(workerKey(s.hostId,s.parentId));if(parent&&!chosen.includes(parent)){if(chosen.length>=maxWorkers)chosen.pop();chosen.push(parent);}}
 chosen=[...new Map(chosen.map(s=>[workerKey(s.hostId,s.id),s])).values()].sort((a,b)=>workerKey(a.hostId,a.id).localeCompare(workerKey(b.hostId,b.id)));
 const shown=new Set(chosen.map(s=>workerKey(s.hostId,s.id))),nodes=[],nodeMap=new Map(),edges=[],journeys=[];
 const addNode=n=>{if(!nodeMap.has(n.id)){nodes.push(n);nodeMap.set(n.id,n);}return nodeMap.get(n.id);};
 for(const h of hosts){const d=deviceVisual(h);addNode({id:'host:'+h.id,type:'host',column:h.role==='codex-source'?0:2,label:h.name,subtitle:d.label,icon:h.deviceClass||'unknown',color:d.color,status:h.status,hostId:h.id,eventIds:[],lastAt:null});}
 for(const s of chosen){const last=s.last,recency=s.lastAt>0?s.lastAt<reference-windowMs?'retained':'recent':'unknown';addNode({id:workerId(s.hostId,s.id),type:s.parentId?'subagent':'worker',column:1,label:s.nickname||'Codex · '+s.id.slice(0,8),subtitle:(recency==='retained'?'Retained / ':'')+(s.project||'Unassigned'),project:s.project||'Unassigned',recency,icon:s.parentId?'agent':'codex',color:s.parentId?colors.agent:'#be9bff',status:last?reference-at(last)<15000?'recent record':'last observed':'no retained activity',lastLabel:last?eventLabel(last):'No retained record',lastEvent:last||null,taskLabel:s.taskLabel||null,taskLabelSource:s.taskLabelSource||null,taskLabelUpdatedAt:s.taskLabelUpdatedAt||null,model:s.model||null,parentId:s.parentId||null,lastAt:last?at(last):s.lastAt||null,eventIds:last?[last.id]:[],sessionId:s.id,hostId:s.hostId});
  if(nodeMap.has('host:'+s.hostId))edges.push({id:'hosting:'+workerKey(s.hostId,s.id),from:'host:'+s.hostId,to:workerId(s.hostId,s.id),kind:'hosting',label:'runs here',color:'#517b9a',eventIds:[],journeyIds:[],count:0});
 }
 for(const s of chosen)if(s.parentId&&shown.has(workerKey(s.hostId,s.parentId)))edges.push({id:'parent:'+workerKey(s.hostId,s.id),from:workerId(s.hostId,s.parentId),to:workerId(s.hostId,s.id),kind:'parent',label:'explicit parent',color:colors.agent,eventIds:[],journeyIds:[],count:0});
 const serviceFor=e=>{let d=toolDestination(e.label,e.category);if(!nodeMap.has('service:'+d.id)&&nodes.filter(n=>n.type==='service').length>=3)d={id:'other-interfaces',label:'Other interfaces',icon:'service',detail:'Counted group of additional tool interfaces; inspect a journey for its original tool identity'};const id='service:'+d.id;addNode({id,type:'service',column:3,label:d.label,subtitle:'tool interface',icon:d.icon,color:colors[e.category]||colors.tool,status:'observed',detail:d.detail,eventIds:[],lastAt:null});return id;};
 const state=(end,last,startLabel)=>end?failed(end)?'failed':'result recorded':hostMap.get(last.hostId)?.status!=='online'&&hostMap.has(last.hostId)?'source unavailable':reference-at(last)>15000?'no result observed':startLabel;
 const addJourney=j=>{j.latestAt=Math.max(...j.records.map(at));j.lastEvent=j.records.at(-1);j.eventIds=j.records.map(e=>e.id);j.color=failed(j.lastEvent)?colors.error:colors[j.category]||colors.tool;journeys.push(j);};
 const calls=new Map(),jobs=new Map(),reviews=new Map();let unmapped=0;
 for(const e of records){
  if(e.kind.startsWith('remote.')){
   if(!e.workerHostId||!e.workerSessionId||!shown.has(workerKey(e.workerHostId,e.workerSessionId))||!nodeMap.has('host:'+e.hostId)){unmapped++;continue;}
   const k=JSON.stringify([e.hostId,e.sourceId,e.jobId||e.callId]);if(!jobs.has(k))jobs.set(k,[]);jobs.get(k).push(e);continue;
  }
  if(!shown.has(workerKey(e.hostId,e.sessionId)))continue;
  if(e.kind==='tool.start'||e.kind==='tool.end'){const k=callKey(e);if(!calls.has(k))calls.set(k,{});calls.get(k)[e.kind==='tool.start'?'start':'end']=e;}
  if(e.kind==='operation'&&e.category!=='agent'){
   const from=workerId(e.hostId,e.sessionId),to=serviceFor(e),start=Date.parse(e.startedAt),end=Date.parse(e.completedAt),valid=Number.isFinite(start)&&Number.isFinite(end)&&end>=start&&end<=reference;
   addJourney({id:'operation:'+e.id,kind:'operation',from,to,label:eventLabel(e),category:e.category,records:[e],status:failed(e)?'failed':'operation recorded',evidence:'Source operation record; tool destination is an interface, not a discovered network hop',durationMs:valid?end-start:null,legs:valid?[{from,to,at:start,eventId:e.id,direction:'outbound'},{from:to,to:from,at:end,eventId:e.id,direction:'return'}]:[{from:to,to:from,at:at(e),eventId:e.id,direction:'return'}]});
  }
  if(e.kind==='approval'||e.kind==='resolution'){const k=JSON.stringify([e.hostId,e.sourceId,e.sessionId,e.requestId||e.id]);if(!reviews.has(k))reviews.set(k,{});reviews.get(k)[e.kind==='approval'?'start':'end']=e;}
 }
 for(const [id,pair] of calls){const e=pair.start||pair.end,last=pair.end||pair.start,from=workerId(e.hostId,e.sessionId),to=serviceFor(e),legs=[];if(pair.start)legs.push({from,to,at:at(pair.start),eventId:pair.start.id,direction:'outbound'});if(pair.end)legs.push({from:to,to:from,at:at(pair.end),eventId:pair.end.id,direction:'return'});
  addJourney({id:'call:'+id,kind:'tool',from,to,label:eventLabel(e),category:e.category,records:[pair.start,pair.end].filter(Boolean),status:pair.start?state(pair.end,last,'start observed'):'result without start',durationMs:pair.start&&pair.end&&at(pair.end)>=at(pair.start)?at(pair.end)-at(pair.start):null,evidence:pair.start&&pair.end?'Paired source, host, session, turn and call ID':'Incomplete call evidence; no missing leg is invented',legs});
 }
 for(const [id,rs] of jobs){const last=rs.at(-1),from='host:'+last.hostId,to=workerId(last.workerHostId,last.workerSessionId);if(rs.some(e=>e.workerHostId!==last.workerHostId||e.workerSessionId!==last.workerSessionId)){unmapped+=rs.length;continue;}
  const end=rs.findLast(e=>e.kind==='remote.end'),start=rs.find(e=>e.kind==='remote.start');addJourney({id:'job:'+id,kind:'job',from,to,label:eventLabel(last),category:'remote',records:rs,status:end?failed(end)?'failed':'completed on target':state(null,last,'progress observed'),progress:last.progress,durationMs:start&&end?at(end)-at(start):null,evidence:'Target job reports with explicit worker binding; dispatch and worker acknowledgement are not captured',legs:rs.map(e=>({from,to,at:at(e),eventId:e.id,direction:'report'}))});
 }
 for(const [id,pair] of reviews){if(!pair.start)continue;const e=pair.start,from=workerId(e.hostId,e.sessionId),to='person:reviewer';addNode({id:to,type:'human',column:0,label:'Human review',subtitle:'recorded input request',icon:'human',color:colors.approval,status:pair.end?'resolution recorded':'waiting for input',eventIds:[e.id],lastAt:at(e)});addJourney({id:'review:'+id,kind:'review',from,to,label:eventLabel(e),category:'approval',records:[e,pair.end].filter(Boolean),status:pair.end?'resolution recorded':'waiting for input',evidence:e.requestId?'Matching scoped request ID':'Resolution cannot be correlated without a request ID',legs:[{from,to,at:at(e),eventId:e.id,direction:'outbound'},...(pair.end?[{from:to,to:from,at:at(pair.end),eventId:pair.end.id,direction:'return'}]:[])]});}
 const routed=new Map(),edgeMembers=new Map();for(const j of journeys)for(const leg of j.legs){const k=JSON.stringify([leg.from,leg.to,leg.direction]);if(!routed.has(k))routed.set(k,{id:k,from:leg.from,to:leg.to,kind:leg.direction,label:leg.direction==='report'?'job reports':leg.direction==='return'?'results':'calls',color:leg.direction==='return'?colors.return:j.color,eventIds:[],journeyIds:[],count:0,latestAt:0});const edge=routed.get(k);edge.count++;edge.eventIds.push(leg.eventId);if(!edgeMembers.has(k))edgeMembers.set(k,new Set());const members=edgeMembers.get(k);if(!members.has(j.id)){members.add(j.id);edge.journeyIds.push(j.id);}edge.latestAt=Math.max(edge.latestAt,leg.at);leg.edgeId=k;for(const id of [leg.from,leg.to]){const n=nodeMap.get(id);if(n&&leg.at>(n.lastAt||0)){n.lastAt=leg.at;n.eventIds=[leg.eventId];if(n.type!=='host')n.status=j.status;}}}
 // Full evidence stays in journeys/records; edge identity arrays are bounded samples.
 const selected=journeys.find(j=>j.eventIds.includes(selectedEvent));
 const sample=(values,limit,pinned)=>{if(values.length<=limit)return values;const keep=new Set(values.slice(-limit));if(pinned&&values.includes(pinned)&&!keep.has(pinned)){keep.delete(keep.values().next().value);keep.add(pinned);}return values.filter(value=>keep.has(value));};
 for(const edge of routed.values()){
  edge.recordCount=new Set(edge.eventIds).size;edge.journeyCount=edgeMembers.get(edge.id).size;
  edge.eventIds=sample(edge.eventIds,512,selectedEvent);edge.journeyIds=sample(edge.journeyIds,128,selected?.id);
  edge.hiddenRecordCount=edge.recordCount-new Set(edge.eventIds).size;edge.hiddenJourneyCount=edge.journeyCount-edge.journeyIds.length;
 }
 edges.push(...routed.values());
 for(const j of journeys.filter(j=>j.kind==='job')){const n=nodeMap.get(j.from);if(n&&(!n.activityAt||j.latestAt>n.activityAt)){n.activityAt=j.latestAt;n.activityStatus=j.status;n.activityLabel=j.label;n.progress=j.progress;}}
 for(let column=0;column<4;column++){const ns=nodes.filter(n=>n.column===column).sort((a,b)=>a.id.localeCompare(b.id));ns.forEach((n,i)=>{n.x=[.105,.365,.65,.90][column];n.y=ns.length===1?.5:.21+i/Math.max(1,ns.length-1)*.57;});}
 nodes.sort((a,b)=>a.column-b.column||a.id.localeCompare(b.id));journeys.sort((a,b)=>b.latestAt-a.latestAt||a.id.localeCompare(b.id));
 const recent=records.filter(e=>at(e)>=reference-windowMs),recentJourneys=journeys.filter(j=>j.latestAt>=reference-windowMs);
 return {nodes,edges,journeys,records,quiet:recent.length===0,recentEventCount:recent.length,lastEventAt:records.at(-1)?at(records.at(-1)):null,workerCount:candidates.size,hiddenWorkers:Math.max(0,candidates.size-chosen.length),unmapped,waiting:journeys.filter(j=>j.status==='waiting for input').length,open:journeys.filter(j=>['start observed','progress observed'].includes(j.status)).length,returns:recentJourneys.filter(j=>j.legs.some(l=>l.direction==='return')).length,reference};
}
