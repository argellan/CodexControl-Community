// Author: Bishop Crockett; Owner: Argellan.com; License: MIT; SPDX-License-Identifier: MIT
import crypto from 'node:crypto';

export const LIMITS=Object.freeze({maxProcesses:10000,maxInstances:20000,historyPoints:120,pageSize:50,maxPageSize:100,staleMs:30000});
export const keyOf=(hostId,bootId,p)=>[hostId,bootId,p.pid,p.createdAt].join('|');
const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
const text=v=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,120):null;
const roles=new Set(['Desktop application','Codex app-server','Node.js runtime','MCP tool server candidate','Browser helper','Development server candidate','Test runner candidate','Collector / observer','Shell / launcher','Other executable']);
const families=new Set(['Codex','ChatGPT','Node.js / unattributed','Browser','Prototype','Other']);
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};

export function validateSnapshot(input){
 if(!input||input.schemaVersion!==1||!['synthetic','local-os'].includes(input.sourceKind)||!text(input.hostId)||!text(input.bootId)||!Number.isSafeInteger(input.sequence)||input.sequence<1||!iso(input.observedAt)||!Array.isArray(input.processes)||input.processes.length>LIMITS.maxProcesses)fail('Invalid process observation');
 const collection=input.collection;
 if(!collection||!['ok','partial','denied','offline','unsupported'].includes(collection.status)||typeof collection.complete!=='boolean')fail('Missing collection coverage');
 const keys=new Set();
 const processes=input.processes.map(p=>{
  if(!Number.isSafeInteger(p.pid)||p.pid<1||!iso(p.createdAt))fail('Stable process identity unavailable');
  const key=keyOf(input.hostId,input.bootId,p);if(keys.has(key))fail('Duplicate process identity');keys.add(key);
  // Explicit projection: no raw command line, path, environment, output or document text crosses this boundary.
  return {key,pid:p.pid,createdAt:p.createdAt,parentPid:Number.isSafeInteger(p.parentPid)?p.parentPid:null,
   executable:/^[a-zA-Z0-9_.-]{1,64}$/.test(p.executable??'')?p.executable:'[name unavailable]',
   role:roles.has(p.role)?p.role:'Other executable',family:families.has(p.family)?p.family:'Other',
   roleBasis:['name','local-allowlist','self'].includes(p.roleBasis)?p.roleBasis:'name',
   privateCommitBytes:number(p.privateCommitBytes),workingSetBytes:number(p.workingSetBytes),cpuTimeMs:number(p.cpuTimeMs),ioBytes:number(p.ioBytes),
   metricStatus:['ok','denied','vanished','partial'].includes(p.metricStatus)?p.metricStatus:'partial',sessionId:number(p.sessionId)};
 });
 return {schemaVersion:1,sourceKind:input.sourceKind,hostId:text(input.hostId),bootId:text(input.bootId),sequence:input.sequence,observedAt:input.observedAt,
  receivedAt:iso(input.receivedAt)?input.receivedAt:new Date().toISOString(),cores:number(input.cores),availableRamBytes:number(input.availableRamBytes),
  collection:{status:collection.status,complete:collection.complete,scope:text(collection.scope)||'unknown',denied:number(collection.denied),enumerated:number(collection.enumerated)},processes};
}

export class ProcessStore{
 constructor(){this.hosts=new Map();this.processes=new Map();this.retiredBoots=new Map();this.outOfOrder=0;}
 ingest(input){
  const s=validateSnapshot(input),previous=this.hosts.get(s.hostId);
  if(this.retiredBoots.get(s.hostId)?.has(s.bootId)){this.outOfOrder++;return {accepted:false,reason:'RETIRED_BOOT',snapshot:s};}
  if(previous&&s.bootId===previous.bootId&&(s.sequence<=previous.sequence||Date.parse(s.observedAt)<Date.parse(previous.observedAt))){this.outOfOrder++;return {accepted:false,reason:'OUT_OF_ORDER',snapshot:s};}
  if(previous&&s.bootId!==previous.bootId&&Date.parse(s.observedAt)<=Date.parse(previous.observedAt)){this.outOfOrder++;return {accepted:false,reason:'OLD_BOOT_OBSERVATION',snapshot:s};}
  if(this.processes.size+s.processes.filter(p=>!this.processes.has(p.key)).length>LIMITS.maxInstances)fail('Projection capacity reached; preserve durable observations and pause intake',507);
  if(previous&&s.bootId!==previous.bootId){const retired=this.retiredBoots.get(s.hostId)||new Set();retired.add(previous.bootId);this.retiredBoots.set(s.hostId,retired);}
  const visible=new Set();
  for(const p of s.processes){
   visible.add(p.key);const old=this.processes.get(p.key),points=old?.points??[];
   points.push({at:s.observedAt,privateCommitBytes:p.privateCommitBytes,cpuTimeMs:p.cpuTimeMs,ioBytes:p.ioBytes});
   const node={...p,hostId:s.hostId,bootId:s.bootId,sourceKind:s.sourceKind,observedAt:s.observedAt,points:points.slice(-LIMITS.historyPoints),misses:0,present:true,links:old?.links??[],signals:old?.signals??[],timeline:old?.timeline??[{at:s.observedAt,type:'Process first observed'}]};
   if(old&&!old.present)node.timeline=[...node.timeline,{at:s.observedAt,type:'Process observed again'}];
   this.processes.set(p.key,node);
  }
  for(const p of this.processes.values())if(p.hostId===s.hostId&&!visible.has(p.key)){
   if(p.bootId!==s.bootId){p.present=null;p.reason='HOST_BOOT_CHANGED';continue;}
   if(s.collection.status==='ok'&&s.collection.complete&&(!previous||previous.collection.scope===s.collection.scope)){
    p.present=false;p.misses++;if(p.misses===2)p.timeline.push({at:s.observedAt,type:'Absent in two complete scoped inventories'});
   }else{p.present=null;p.misses=0;p.reason='INCOMPLETE_INVENTORY';}
  }
  this.hosts.set(s.hostId,s);return {accepted:true,snapshot:s};
 }
 link(key,link){
  const p=this.processes.get(key);if(!p)fail('Process identity not observed');
  if(!link||!['launch-receipt','app-server-mapping','owner-registration'].includes(link.basis)||!text(link.taskId)||!text(link.projectId)||!iso(link.observedAt))fail('Unsupported ownership evidence');
  const safe={taskId:text(link.taskId),projectId:text(link.projectId),state:['running','waiting','completed','unknown'].includes(link.state)?link.state:'unknown',basis:link.basis,observedAt:link.observedAt,lifetime:link.lifetime==='task-bound'?'task-bound':'unspecified'};
  const old=p.links.find(l=>l.taskId===safe.taskId);if(old&&Date.parse(old.observedAt)>Date.parse(safe.observedAt))return;
  p.links=p.links.filter(l=>l.taskId!==safe.taskId);p.links.push(safe);p.timeline.push({at:safe.observedAt,type:'Task '+safe.taskId+' '+safe.state+' · '+safe.basis});
 }
 signal(key,signal){
  const p=this.processes.get(key);if(!p||!['waiting','reusable','exited'].includes(signal.kind)||!iso(signal.at)||!iso(signal.expiresAt))fail('Invalid lifecycle signal');
  if(!['launch-receipt','owner-registration','os-exit-event'].includes(signal.basis))fail('Unsupported lifecycle signal');
  p.signals.push({kind:signal.kind,at:signal.at,expiresAt:signal.expiresAt,basis:signal.basis});
  p.timeline.push({at:signal.at,type:'Explicit '+signal.kind+' evidence · '+signal.basis});
 }
 explain(p,now=Date.now()){
  const host=this.hosts.get(p.hostId),age=now-Date.parse(p.observedAt),last=p.points.at(-1),before=p.points.at(-2),elapsed=before?Date.parse(last.at)-Date.parse(before.at):0;
  const cpu=elapsed>0&&number(last.cpuTimeMs)!==null&&number(before.cpuTimeMs)!==null&&last.cpuTimeMs>=before.cpuTimeMs?100*(last.cpuTimeMs-before.cpuTimeMs)/elapsed:null;
  const io=elapsed>0&&number(last.ioBytes)!==null&&number(before.ioBytes)!==null&&last.ioBytes>=before.ioBytes?last.ioBytes-before.ioBytes:null;
  const freshSignals=p.signals.filter(s=>Date.parse(s.at)<=now&&Date.parse(s.expiresAt)>now),allCompleted=p.links.length>0&&p.links.every(l=>l.state==='completed');
  const reasons=[],contradictions=[];
  let status='Unknown',confidence='unknown';
  if(!host||host.bootId!==p.bootId)reasons.push('HOST_BOOT_CHANGED');
  else if(now-Date.parse(host.observedAt)>LIMITS.staleMs||age>LIMITS.staleMs||age<0)reasons.push('STALE_OBSERVATION');
  else if(!['ok','partial'].includes(host.collection.status)||p.metricStatus!=='ok')reasons.push('TELEMETRY_'+(['ok','partial'].includes(host.collection.status)?p.metricStatus:host.collection.status).toUpperCase());
  else if(freshSignals.some(s=>s.kind==='exited')){status='Exited';confidence='high';reasons.push('EXPLICIT_EXIT_EVENT');}
  else if(p.present===false&&p.misses>=2){status='Exited';confidence='medium';reasons.push('ABSENT_TWO_COMPLETE_SCOPED_INVENTORIES');}
  else if(p.present!==true)reasons.push(p.reason||'ABSENCE_NOT_CONFIRMED');
  else if(cpu!==null&&cpu>0.5||io!==null&&io>0){status='Active';confidence='high';reasons.push(cpu>0.5?'CPU_COUNTER_INCREASE':'IO_COUNTER_INCREASE');if(allCompleted)contradictions.push('TASK_COMPLETED_PROCESS_STILL_ACTIVE');if(freshSignals.some(s=>s.kind==='waiting'))contradictions.push('WAIT_LEASE_WITH_OBSERVED_ACTIVITY');}
  else if(freshSignals.some(s=>s.kind==='waiting')){status='Waiting';confidence='high';reasons.push('EXPLICIT_WAIT_LEASE');}
  else if(freshSignals.some(s=>s.kind==='reusable')){status='Reusable idle';confidence='high';reasons.push('EXPLICIT_REUSE_LEASE');}
  else if(allCompleted){
   status='Task completed/process retained';confidence='high';reasons.push('COMPLETED_OWNERS_PROCESS_PRESENT');
   const quiet=p.points.slice(-4),quietStart=quiet.at(0),quietSpan=quietStart?Date.parse(last.at)-Date.parse(quietStart.at):0;
   if(p.links.every(l=>l.lifetime==='task-bound'&&now-Date.parse(l.observedAt)>=30000)&&quiet.length===4&&quietSpan>=30000&&quiet.every(x=>x.cpuTimeMs!==null&&x.ioBytes!==null&&x.cpuTimeMs===last.cpuTimeMs&&x.ioBytes===last.ioBytes)){
    status='Suspected leftover';confidence='medium';reasons.push('DECLARED_TASK_BOUND_LIFETIME_EXCEEDED','FOUR_QUIET_SAMPLES');
   }
  }else reasons.push(cpu===null?'COUNTER_BASELINE_UNAVAILABLE':'QUIET_WITHOUT_SEMANTIC_EVIDENCE');
  if(freshSignals.some(s=>s.kind==='exited')&&p.present===true){status='Unknown';confidence='unknown';contradictions.push('EXIT_SIGNAL_CONTRADICTS_LIVE_INVENTORY');}
  if(host?.collection.status==='partial')reasons.push('PARTIAL_HOST_COVERAGE');
  const valid=p.points.filter(x=>x.privateCommitBytes!==null),first=valid.at(0),growth=last.privateCommitBytes!==null&&valid.length>=3&&Date.parse(last.at)-Date.parse(first.at)>=20000?(last.privateCommitBytes-first.privateCommitBytes)*60000/(Date.parse(last.at)-Date.parse(first.at)):null;
  return {status,confidence,reasons,contradictions,observedAt:p.observedAt,ageMs:Math.max(0,age),cpuOneCorePercent:cpu,cpuHostPercent:cpu!==null&&host?.cores?cpu/host.cores:null,privateGrowthBytesPerMinute:growth,
   ownershipConfidence:p.links.length?'high':'unassigned',taskState:p.links.length?[...new Set(p.links.map(l=>l.state))].join(', '):'unlinked',safeToTerminate:'NOT_DETERMINABLE',
   explanation:status==='Unknown'?'The observations do not establish a semantic activity state. Quiet CPU is not proof of waiting or abandonment.':status==='Suspected leftover'?'Declared task-bound owners completed and four observations remained quiet after the review interval. Investigate; this is not permission or proof that termination is safe.':status==='Active'?'CPU or I/O counters increased over the observed interval; the task or purpose may still be unknown.':status==='Exited'?'An explicit exit event or repeated complete scoped absence supports exit; PID alone is never used.':status==='Waiting'?'A fresh explicit owner wait lease supports waiting; process age and listening ports are not used.':status==='Reusable idle'?'A fresh explicit reuse lease explains why this process remains available.':'All linked task owners completed while this exact process instance remains observed.'};
 }
 query(viewer,filter={},now=Date.now()){
  if(!viewer||!Array.isArray(viewer.hostIds)&&viewer.hostIds!==null||!Array.isArray(viewer.projectIds)&&viewer.projectIds!==null)fail('Authentication required',401);
  if(filter.host&&viewer.hostIds!==null&&!viewer.hostIds.includes(filter.host)||filter.project&&viewer.projectIds!==null&&!viewer.projectIds.includes(filter.project))fail('Scope not permitted',403);
  let rows=[...this.processes.values()].filter(p=>viewer.hostIds===null||viewer.hostIds.includes(p.hostId));
  // Mixed-owner process totals are not allocated to one project and are not exposed to a restricted viewer.
  if(viewer.projectIds!==null)rows=rows.filter(p=>p.links.length&&p.links.every(l=>viewer.projectIds.includes(l.projectId)));
  rows=rows.filter(p=>(!filter.host||p.hostId===filter.host)&&(!filter.project||p.links.some(l=>l.projectId===filter.project))&&(!filter.task||p.links.some(l=>l.taskId===filter.task)));
  rows=rows.map(p=>({...p,...this.explain(p,now)})).filter(p=>(!filter.q||[p.executable,p.role,p.family,p.pid,...p.links.flatMap(l=>[l.taskId,l.projectId])].join(' ').toLowerCase().includes(String(filter.q).toLowerCase()))&&(!filter.status||p.status===filter.status)&&(!filter.role||p.role===filter.role)&&(!filter.uncertain||p.ownershipConfidence==='unassigned')&&(!filter.stale||p.ageMs>LIMITS.staleMs)&&(!filter.minMemory||p.privateCommitBytes!==null&&p.privateCommitBytes>=Number(filter.minMemory))&&(!filter.minAge||now-Date.parse(p.createdAt)>=Number(filter.minAge)));
  const keys=new Set(rows.map(p=>p.key)),byPid=new Map(rows.filter(p=>p.present===true).map(p=>[p.hostId+'|'+p.bootId+'|'+p.pid,p]));
  for(const p of rows){const parent=byPid.get(p.hostId+'|'+p.bootId+'|'+p.parentPid);p.parentKey=parent&&parent.key!==p.key&&Date.parse(parent.createdAt)<=Date.parse(p.createdAt)?parent.key:null;p.parentPid=p.parentKey?p.parentPid:null;}
  const childCounts=new Map();for(const p of rows)if(p.parentKey)childCounts.set(p.parentKey,(childCounts.get(p.parentKey)||0)+1);for(const p of rows)p.childCount=childCounts.get(p.key)||0;
  let ordered;
  if(filter.view==='tree'){
   const children=new Map(),roots=[];for(const p of rows){if(p.parentKey&&keys.has(p.parentKey)){const c=children.get(p.parentKey)||[];c.push(p);children.set(p.parentKey,c);}else roots.push(p);}
   ordered=[];const seen=new Set(),hidden=new Set();const walk=start=>{const stack=[{p:start,depth:0}];while(stack.length){const {p,depth}=stack.pop();if(seen.has(p.key))continue;seen.add(p.key);ordered.push({...p,depth,childCount:children.get(p.key)?.length||0});const kids=children.get(p.key)||[];if(filter.collapsed?.includes(p.key)){const descendants=[...kids];while(descendants.length){const c=descendants.pop();if(hidden.has(c.key)||seen.has(c.key))continue;hidden.add(c.key);descendants.push(...(children.get(c.key)||[]));}}else for(let i=kids.length-1;i>=0;i--)stack.push({p:kids[i],depth:depth+1});}};
   for(const p of roots)walk(p);for(const p of rows)if(!seen.has(p.key)&&!hidden.has(p.key))walk(p);
  }else ordered=rows.sort((a,b)=>(b.privateCommitBytes??-1)-(a.privateCommitBytes??-1));
  const measurable=rows.filter(p=>p.present===true&&p.metricStatus==='ok'&&p.ageMs<=LIMITS.staleMs&&['ok','partial'].includes(this.hosts.get(p.hostId)?.collection.status));
  const known=measurable.filter(p=>p.privateCommitBytes!==null),growth=measurable.filter(p=>p.privateGrowthBytesPerMinute!==null);
  const summary={processes:rows.length,liveObserved:measurable.length,privateCommitBytes:known.length?known.reduce((n,p)=>n+p.privateCommitBytes,0):null,privateCommitCoverage:known.length,privateGrowthBytesPerMinute:growth.length?growth.reduce((n,p)=>n+p.privateGrowthBytesPerMinute,0):null,growthCoverage:growth.length,retained:rows.filter(p=>['Task completed/process retained','Suspected leftover'].includes(p.status)).length,unknown:rows.filter(p=>p.status==='Unknown').length,uniqueProcesses:true};
  const offset=Math.max(0,Math.min(10000,Number(filter.offset)||0)),limit=Math.max(1,Math.min(LIMITS.maxPageSize,Number(filter.limit)||LIMITS.pageSize));
  const hosts=[...new Set(rows.map(p=>p.hostId))],groups=[...new Set(rows.map(p=>p.family))].map(f=>{const measured=measurable.filter(p=>p.family===f&&p.privateCommitBytes!==null);return {family:f,count:rows.filter(p=>p.family===f).length,privateCommitBytes:measured.length?measured.reduce((n,p)=>n+p.privateCommitBytes,0):null};});
  const coverageHosts=filter.host&&this.hosts.has(filter.host)?[filter.host]:hosts;
  return {schemaVersion:1,readOnly:true,summary,groups,hosts,hostCoverage:coverageHosts.map(id=>({hostId:id,observedAt:this.hosts.get(id)?.observedAt,...this.hosts.get(id)?.collection})),total:rows.length,visibleTreeCount:ordered.length,offset,limit,hasMore:offset+limit<ordered.length,rows:ordered.slice(offset,offset+limit).map(p=>({...p,points:p.points.slice(-30),timeline:p.timeline.slice(-12)}))};
 }
}
export const observationHash=s=>crypto.createHash('sha256').update(JSON.stringify(s)).digest('hex');
