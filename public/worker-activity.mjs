// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// Bounded plain-text observations. Assignment titles and observed actions are
// separate fields; neither establishes ongoing execution or accepted results.
const text=(value,max=160)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,max):null;
const stamp=value=>{if(value===null||value===undefined||value==='')return null;const result=typeof value==='number'?value:Date.parse(value);return Number.isFinite(result)?result:null;};
// Retained records keep their identity across updates. Cache only a parsed own
// string clock; source scope, ordering and lifecycle state are always rebuilt.
const recordClocks=new WeakMap();
const recordStamp=record=>{
 const value=record?.at;if(typeof value!=='string'||value==='')return stamp(value);
 // stamp(record.at) reads the source property before Date.parse. Keep that order
 // and directly parse inherited/accessor values instead of caching their reads.
 const owner=Date,parse=owner.parse;let descriptor;
 try{descriptor=Object.getOwnPropertyDescriptor(record,'at');}catch{}
 if(!descriptor||!Object.hasOwn(descriptor,'value')||descriptor.value!==value){const result=parse.call(owner,value);return Number.isFinite(result)?result:null;}
 const cached=recordClocks.get(record);if(cached&&cached.value===value&&cached.parse===parse&&cached.owner===owner)return cached.time;
 const result=parse.call(owner,value),time=Number.isFinite(result)?result:null;recordClocks.set(record,{value,parse,owner,time});return time;
};
const requestKey=record=>JSON.stringify([record.hostId,record.sourceId||'',record.sessionId,record.turnId||'',record.requestId||record.id]);
const cycleKey=record=>JSON.stringify([record.hostId,record.sourceId||'',record.sessionId,record.turnId||'']);
const finalRecord=record=>record.kind==='final'||record.kind==='message'&&/^Final answer recorded(?:\s|·|$)/.test(record.label||'');
const failed=record=>record.kind==='error'||record.outcome==='failed'||record.outcome==='interrupted';
const rank=record=>record.kind==='error'?8:finalRecord(record)?7:record.kind==='complete'?6:record.kind==='approval'?5:record.kind==='resolution'?4:record.kind==='turn'?1:2;

function actionLabel(label){
 const original=text(label)||'Activity recorded',name=original.replace(/ · result recorded$/,'');
 if(/^(?:functions\.)?exec$/.test(name))return 'Tool batch';
 if(/^(?:functions\.)?(?:exec_command|write_stdin)$/.test(name))return 'Command call';
 if(/^(?:functions\.)?(?:apply_patch|patch)$/.test(name))return 'Editing files';
 if(/^(?:functions\.)?(?:read|read_file|read_mcp_resource)$/.test(name))return 'Reading files';
 if(/^(?:functions\.)?(?:search|search_query|web_search)$/.test(name))return 'Searching sources';
 if(/^mcp__cua_repl[._/]js$/.test(name))return 'Browser tools';
 if(/^(?:web[._/]|functions\.web__)run$/.test(name))return 'Web research';
 if(/^collaboration[._/]spawn_agent$/.test(name))return 'Subagent request';
 return name;
}

function scoped(record,node){
 if(!record||typeof record.id!=='string'||!record.id||!node.hostId||!node.sessionId)return false;
 if(String(record.kind||'').startsWith('remote.'))return record.workerHostId===node.hostId&&record.workerSessionId===node.sessionId;
 return record.hostId===node.hostId&&record.sessionId===node.sessionId&&(!node.sourceId||record.sourceId===node.sourceId);
}

function recordsFor(node,graph,reference){
 const candidates=[...(Array.isArray(graph.records)?graph.records:[]),...(Array.isArray(graph.events)?graph.events:[])];
 if(node.lastEvent)candidates.push(node.lastEvent);
 for(const journey of graph.journeys||[])if(journey.from===node.id||journey.to===node.id||(journey.legs||[]).some(leg=>leg.from===node.id||leg.to===node.id))candidates.push(...journey.records||[]);
 const seen=new Map();
 for(const record of candidates){const at=recordStamp(record);if(!scoped(record,node)||at===null||at>reference)continue;const id=JSON.stringify([record.hostId,record.sourceId||'',record.sessionId,record.id]);const previous=seen.get(id);if(!previous||recordStamp(previous)<at)seen.set(id,record);}
 return [...seen.values()].sort((a,b)=>recordStamp(a)-recordStamp(b)||rank(a)-rank(b)||a.id.localeCompare(b.id));
}

export function workerActivity(node={},graph={}, {reference=Date.now(),mode='live',observationGap=false,windowMs=60000}={}){
 const titleAt=stamp(node.taskLabelUpdatedAt),titleAllowed=mode!=='replay'||titleAt!==null&&titleAt<=reference;
 const taskLabel=titleAllowed?text(node.taskLabel):null,taskLabelSource=taskLabel?text(node.taskLabelSource,80):null,taskLabelUpdatedAt=taskLabel&&titleAt!==null&&Math.abs(titleAt)<=8640000000000000?new Date(titleAt).toISOString():null;
 const base={action:'No captured activity',actionAt:null,eventId:null,status:'unknown',label:'Activity unavailable',kind:'unknown',detail:'No scoped source record establishes an observed action at this clock.',isRecent:false,source:'unavailable',project:text(node.project),taskLabel,taskLabelSource,taskLabelUpdatedAt};
 if(!Number.isFinite(reference)||!node.hostId||!node.sessionId)return base;
 const records=recordsFor(node,graph,reference),pending=new Map();let phase=null,terminal=null;
 const set=(record,status,label)=>phase={record,status,label};
 for(const record of records){
  const kind=record.kind;
  if(kind==='resolution'){
   if(!record.requestId)continue;const key=requestKey(record),matched=pending.get(key);pending.delete(key);
   if(matched&&phase?.status==='waiting'&&requestKey(phase.record)===key){const remaining=[...pending.values()].at(-1);if(remaining)set(remaining,'waiting','Input requested');else set(record,'observed','Resolution recorded');}
   continue;
  }
  if(kind==='turn'||kind==='tool.start'){terminal=null;if(kind==='turn')pending.clear();set(record,'observed',kind==='turn'?'Turn start recorded':'Call start observed');continue;}
  if(failed(record)){terminal=record;pending.clear();set(record,'failed',record.outcome==='interrupted'?'Interruption recorded':'Failure recorded');continue;}
  if(kind==='complete'||finalRecord(record)){terminal=record;pending.clear();set(record,'completed',finalRecord(record)?'Final answer recorded · unverified':'Turn completed · unverified');continue;}
  if(kind==='approval'){pending.set(requestKey(record),record);set(record,'waiting','Input requested');continue;}
  if(String(kind||'').startsWith('remote.')){set(record,'reported',kind==='remote.end'?'Target completion reported':kind==='remote.start'?'Target start reported':'Target progress reported');continue;}
  if(terminal&&cycleKey(terminal)===cycleKey(record)&&['tool.end','operation','message'].includes(kind))continue;
  if(kind==='tool.end')set(record,'observed','Result recorded');
  else if(kind==='operation')set(record,'observed','Operation recorded');
  else if(kind==='message')set(record,'observed','Message recorded');
 }
 if(!phase){
  const at=stamp(node.lastAt),label=text(node.lastLabel);
  if(at===null||at>reference||!label)return base;
  phase={record:{at,id:null,label,project:node.project},status:'observed',label:'Last observed'};
 }
 if(pending.size&&!['completed','failed'].includes(phase.status))phase={...phase,status:'waiting',label:'Input requested'};
 const record=phase.record,at=recordStamp(record),age=reference-at,window=Number.isFinite(windowMs)&&windowMs>0?windowMs:60000;
 const isRecent=age>=0&&age<=window;
 let status=phase.status,label=phase.label,kind=isRecent?(status==='waiting'||status==='failed'?'attention':'recent'):'retained';
 let detail='Captured source activity; this does not establish a current running task or accepted result.';
 if(record.kind==='tool.start'&&age>15000&&status!=='waiting'){status='unconfirmed';label='No captured result';kind='unknown';detail='A call start was captured without a later matching source state; ongoing execution is unknown.';}
 const source=graph.nodes?.find(n=>n.type==='host'&&(n.id==='host:'+node.hostId||n.hostId===node.hostId))||graph.hosts?.find(h=>h.id===node.hostId);
 const sourceUnavailable=source&&source.status!=='online'||node.status==='source unavailable';
 if(mode==='replay'){kind='replay';label='Captured · '+label;detail='State and action are reconstructed at the replay clock; current execution and current source health are not established.';}
 else if(observationGap||sourceUnavailable){status='unknown';kind='unknown';label=observationGap?'Feed unknown · last observed':'Source unavailable · last observed';detail='Retained source activity remains inspectable; the unavailable feed does not establish current work.';}
 else if(!isRecent){label='Retained · '+label;detail='This action precedes the selected recent window; it does not establish current work.';}
 const matchingNode=at===stamp(node.lastAt)&&record.id&&(node.eventIds||[]).includes(record.id);
 const enriched=text(record.activityLabel)||matchingNode&&at===stamp(node.activityAt)&&text(node.activityLabel);
 return {...base,action:enriched||actionLabel(record.label),actionAt:at,eventId:text(record.id,240),status,label,kind,detail,isRecent,source:'observed',project:text(record.project)||base.project};
}

export function routeObservation(route={}, {reference=Date.now(),mode='live',windowMs=60000,observationGap=false}={}){
 if(route.metadata||['hosting','parent'].includes(route.kind))return {state:'relationship',label:'RELATIONSHIP',detail:'Captured hosting or explicit parent metadata; no traffic or current execution is implied.'};
 if(mode==='replay')return {state:'replay',label:'REPLAY',detail:'Captured route evidence at the replay clock; this is not current traffic.'};
 if(observationGap)return {state:'unknown',label:'FEED UNKNOWN',detail:'The live feed is unavailable; retained route evidence does not establish current traffic.'};
 const times=[];let hasLegTimestamps=false;for(const item of route.legs||[]){const at=stamp((item.leg||item).at);if(at!==null){hasLegTimestamps=true;if(at<=reference)times.push(at);}}
 const recordIds=new Set(route.eventIds||[]),records=[...route.records||[],...(route.related||[]).flatMap(j=>(j.records||[]).filter(record=>recordIds.has(record.id)))];
 if(!hasLegTimestamps)for(const record of records){const at=stamp(record.at);if(at!==null&&at<=reference)times.push(at);}
 if(!Number.isFinite(reference)||!times.length)return {state:'unknown',label:'UNKNOWN',detail:'No valid captured route record establishes activity at this clock.'};
 const latest=Math.max(...times),window=Number.isFinite(windowMs)&&windowMs>0?windowMs:60000;
 return reference-latest<=window?{state:'recent',label:'RECENT',detail:'Source route records were captured inside the selected recent window; ongoing execution and network throughput are not established.'}:{state:'retained',label:'RETAINED',detail:'The route is retained from earlier captured records; no recent activity or new traversal is implied.'};
}
