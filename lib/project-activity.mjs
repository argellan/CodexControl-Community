// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const safeSum=values=>{let n=0,known=false;for(const v of values){if(v===null)continue;if(!integer(v)||!Number.isSafeInteger(n+v))return null;n+=v;known=true;}return known?n:null;};
export function unionIntervals(intervals){const sorted=intervals.filter(([a,b])=>integer(a)&&integer(b)&&b>=a).sort((a,b)=>a[0]-b[0]||a[1]-b[1]),out=[];for(const row of sorted){const last=out.at(-1);if(last&&row[0]<=last[1])last[1]=Math.max(last[1],row[1]);else out.push([...row]);}return out;}
const duration=intervals=>intervals.length?safeSum(intervals.map(([a,b])=>b-a)):0;
// Only paired native turn boundaries establish execution intervals. Unresolved
// approvals are excluded through the end of that turn; open turns are not guessed.
export function projectExecution(events,now){
 const turns=new Map();let invalid=0;
 for(const e of events){const at=Date.parse(e.at);if(e.timeOrigin!=='source'||!Number.isSafeInteger(at)||at<0||at>now||!e.turnId||!e.sessionId){invalid++;continue;}
  const key=JSON.stringify([e.hostId,e.sessionId,e.turnId]),t=turns.get(key)||{start:null,end:null,waits:null,resolved:null};turns.set(key,t);
  if(e.kind==='turn')t.start=Math.min(t.start??at,at);if(e.kind==='complete'||e.kind==='error'&&e.outcome==='interrupted')t.end=Math.max(t.end??at,at);
  if(e.kind==='approval'&&e.requestId)(t.waits??=new Map()).set(e.requestId,Math.min(t.waits.get(e.requestId)??at,at));
  if(e.kind==='resolution'&&e.requestId)(t.resolved??=new Map()).set(e.requestId,Math.max(t.resolved.get(e.requestId)??at,at));
 }
 const intervals=[];let completeTurns=0,incompleteTurns=0;
 for(const t of turns.values()){if(t.start===null||t.end===null){incompleteTurns++;continue;}const start=t.start,end=t.end;if(end<start){incompleteTurns++;continue;}completeTurns++;
  const waits=unionIntervals([...(t.waits||[])].map(([id,a])=>[Math.max(start,a),Math.min(end,t.resolved?.get(id)??end)]));let cursor=start;
  for(const [a,b] of waits){if(a>cursor)intervals.push([cursor,a]);cursor=Math.max(cursor,b);}if(cursor<end)intervals.push([cursor,end]);
 }
 return {codeMs:completeTurns?duration(intervals):null,activeWallMs:completeTurns?duration(unionIntervals(intervals)):null,completeTurns,incompleteTurns,unusableEvents:invalid};
}
function scope(hostIds,projectIds,project,alias=''){const conditions=[],args=[],p=alias?alias+'.':'';for(const [key,values] of [['host_id',hostIds],['project',project? [project]:projectIds]]){if(values===null)continue;if(!Array.isArray(values)||values.length>256||values.some(v=>typeof v!=='string'||!v||v.length>256))throw Object.assign(new Error('Invalid project scope'),{status:400});conditions.push(values.length?`${p}${key} IN (${values.map(()=>'?').join(',')})`:'0');args.push(...values);}return {sql:conditions.join(' AND ')||'1',args};}
export function readProjectActivity(db,{hostIds=null,projectIds=null,project=null,now=Date.now(),catalogOnly=false}={}){
 if(!integer(now)||project!==null&&(typeof project!=='string'||!project||project.length>256))throw Object.assign(new Error('Invalid project query'),{status:400});
 if(project&&projectIds!==null&&!projectIds.includes(project))throw Object.assign(new Error('Project not permitted'),{status:403});
 const s=scope(hostIds,projectIds,project),eventProjection="SELECT host_id,occurred_ms,json_extract(payload,'$.project') project,payload FROM events WHERE json_extract(payload,'$.projectBasis')='source-context' AND typeof(json_extract(payload,'$.project'))='text'";
 const rows=db.prepare(`SELECT project,MIN(first_ms) first_ms,MAX(last_ms) last_ms FROM (SELECT project,occurred_ms first_ms,occurred_ms last_ms,host_id FROM (${eventProjection}) UNION ALL SELECT project,first_ms,last_ms,host_id FROM usage_daily UNION ALL SELECT project,source_ms first_ms,source_ms last_ms,host_id FROM usage_observations) WHERE ${s.sql} AND project IS NOT NULL AND project<>'' AND first_ms<=? GROUP BY project ORDER BY last_ms DESC,project LIMIT 257`).all(...s.args,now);
 const response={observedAt:new Date(now).toISOString(),projects:rows.slice(0,256).map(r=>({name:r.project,firstCapturedAt:new Date(r.first_ms).toISOString(),lastCapturedAt:new Date(Math.min(now,r.last_ms)).toISOString()})),projectsTruncated:rows.length>256,selected:null};
 if(!project||catalogOnly)return response;
 const row=rows.find(r=>r.project===project);if(!row)return response;
 // Stream only turn/wait boundaries for full retained-time accounting; bound the
 // browser's recent-record list separately. Never infer total time from a page.
 const boundaryRows=db.prepare(`SELECT payload FROM (${eventProjection}) WHERE ${s.sql} AND occurred_ms<=? AND json_extract(payload,'$.kind') IN ('turn','complete','error','approval','resolution')`).iterate(...s.args,now);
 const execution=projectExecution((function*(){for(const r of boundaryRows)yield JSON.parse(r.payload);})(),now);
 const events=db.prepare(`SELECT payload FROM (${eventProjection}) WHERE ${s.sql} AND occurred_ms<=? ORDER BY occurred_ms DESC LIMIT 100`).all(...s.args,now).map(r=>JSON.parse(r.payload));
 const sum=column=>`CASE WHEN COUNT(${column})=0 THEN NULL ELSE TOTAL(${column}) END`;
 const daily=db.prepare(`SELECT day,${sum('total_tokens')} total,${sum('input_tokens')} input,${sum('cached_input_tokens')} cached,${sum('output_tokens')} output,SUM(partial_observations) partial,MAX(overflow) overflow FROM usage_daily WHERE ${s.sql} AND first_ms<=? GROUP BY day ORDER BY day`).all(...s.args,now);
 const totals={};for(const field of ['total','input','cached','output'])totals[field]=daily.some(r=>r.overflow)?null:safeSum(daily.map(r=>r[field]));
 response.selected={name:project,firstCapturedAt:new Date(row.first_ms).toISOString(),lastCapturedAt:new Date(Math.min(now,row.last_ms)).toISOString(),calendarMs:now-row.first_ms,...execution,tokens:totals,quota:{value:null,unit:null,status:'not_project_attributed'},daily:daily.slice(-366).map(r=>({day:r.day,tokens:integer(r.total)&&!r.overflow?r.total:null})),activity:events.map(e=>({id:e.id,at:e.at,hostId:e.hostId,sessionId:e.sessionId,kind:e.kind,outcome:e.outcome})),coverage:{basis:'captured-local-records',truncated:false,partialTokenObservations:daily.reduce((n,r)=>n+r.partial,0),completeProjectLifetime:false,openTurnsExcluded:true,waitingIntervalsExcluded:true,dailyDisplayTruncated:daily.length>366}};
 return response;
}
