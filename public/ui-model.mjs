// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// Presentation-only projections. No source records or worker state are changed here.
export function presentationValue(table,key,fallback){return typeof key==='string'&&Object.hasOwn(table,key)&&typeof table[key]==='string'?table[key]:fallback;}
// Keep first-seen ordering only for the current bounded presentation. Expired
// tracks remain in durable history; their old layout IDs need no lifetime cache.
export function reconcileTrackLanes(lanes,tracks){
 const active=new Set(tracks.map(track=>track.id));for(const id of lanes.keys())if(!active.has(id))lanes.delete(id);
 let next=0;for(const id of lanes.keys())lanes.set(id,next++);for(const track of tracks)if(!lanes.has(track.id))lanes.set(track.id,next++);return lanes;
}
export const DEFAULT_PREFERENCES=Object.freeze({flowView:'map',theme:'system',font:'system',fontSize:14,leftWidth:260,rightWidth:290,waterfallRatio:72,fleetHeight:null,inspectorHeight:null,attentionHeight:null,tickerMotion:true,vivid:true});
export function normalizePreferences(value){
 const v=value&&typeof value==='object'?value:{};
 const bounded=(key,min,max)=>Number.isFinite(Number(v[key]))?Math.max(min,Math.min(max,Number(v[key]))):DEFAULT_PREFERENCES[key];
 return {flowView:v.flowView==='curtain'?'curtain':'map',theme:['system','dark','light'].includes(v.theme)?v.theme:'system',font:['jetbrains','system','consolas'].includes(v.font)?v.font:'system',fontSize:bounded('fontSize',12,20),leftWidth:bounded('leftWidth',200,420),rightWidth:bounded('rightWidth',220,460),waterfallRatio:bounded('waterfallRatio',32,88),...Object.fromEntries(['fleetHeight','inspectorHeight','attentionHeight'].map(k=>[k,v[k]===undefined||v[k]===null?null:bounded(k,110,800)])),tickerMotion:typeof v.tickerMotion==='boolean'?v.tickerMotion:true,vivid:typeof v.vivid==='boolean'?v.vivid:true};
}
const key=s=>(s.hostId||'local')+'/'+(s.id||s.sessionId);
const recordTimes=new WeakMap();
const recordTime=record=>{const cached=recordTimes.get(record);if(cached&&cached.at===record.at)return cached.time;const time=Date.parse(record.at);recordTimes.set(record,{at:record.at,time});return time;};
// Bound legacy/local metadata too; one canonical host/session identity per row.
export function canonicalSessions(input){
 const rows=new Map();for(const value of (Array.isArray(input)?input:[]).slice(0,16384)){
  if(!value||typeof value.id!=='string'||!value.id)continue;
  const row={...value};for(const field of ['hostId','parentId','agentPath','nickname','project'])if(row[field]!==undefined&&row[field]!==null&&typeof row[field]!=='string')row[field]=null;
  const id=key(row);if(!rows.has(id))rows.set(id,row);
 }return [...rows.values()];
}
export function workerGroups(sessions,events,hosts,now){
 const latest=new Map(),ends=new Set(),hostMap=new Map(hosts.map(h=>[h.id,h]));
 const callKey=e=>[e.hostId,e.sourceId,e.sessionId,e.turnId,e.callId].join('|');
 for(const e of events){const at=recordTime(e);if(!Number.isFinite(at)||at>now)continue;const k=(e.hostId||'local')+'/'+e.sessionId;if(at>(latest.has(k)?recordTime(latest.get(k)):0))latest.set(k,e);if(e.kind?.endsWith('.end'))ends.add(callKey(e));}
 const groups=new Map();
 for(const session of canonicalSessions(sessions)){const e=latest.get(key(session)),fallback=Date.parse(session.lastEventAt),lastAt=e?recordTime(e):fallback<=now?fallback:0,recent=lastAt>0&&now-lastAt<60000,host=hostMap.get(session.hostId),open=recent&&(!host||host.status==='online')&&e?.kind?.endsWith('.start')&&!ends.has(callKey(e));
  const row={session,latest:e,lastAt,recent,open,depth:0,score:(open?1e15:0)+(lastAt||0)},id=(session.hostId||'local')+'|'+session.project;
  if(!groups.has(id))groups.set(id,{id,hostId:session.hostId,project:session.project,score:0,rows:[]});groups.get(id).rows.push(row);
 }
 for(const group of groups.values()){
  const rows=group.rows,byId=new Map(rows.map(r=>[r.session.id,r])),children=new Map(),scores=new Map();
  for(const r of rows){const parent=r.session.parentId;if(parent&&parent!==r.session.id&&byId.has(parent)){if(!children.has(parent))children.set(parent,[]);children.get(parent).push(r);}}
  // Iterative postorder evaluates each unique edge once, including cycles.
  const visiting=new Set();for(const root of rows){const stack=[[root,false]];while(stack.length){const [r,exit]=stack.pop(),id=r.session.id;if(scores.has(id))continue;if(exit){let score=r.score;for(const c of children.get(id)||[])score=Math.max(score,scores.get(c.session.id)??c.score);scores.set(id,score);visiting.delete(id);}else if(!visiting.has(id)){visiting.add(id);stack.push([r,true]);for(const c of children.get(id)||[])if(!scores.has(c.session.id)&&!visiting.has(c.session.id))stack.push([c,false]);}}}
  const compare=(a,b)=>scores.get(b.session.id)-scores.get(a.session.id)||a.session.id.localeCompare(b.session.id),visited=new Set(),ordered=[];
  const add=root=>{const stack=[[root,0]];while(stack.length){const [r,depth]=stack.pop();if(visited.has(r.session.id))continue;visited.add(r.session.id);ordered.push({...r,depth});const list=(children.get(r.session.id)||[]).sort(compare);for(let i=list.length-1;i>=0;i--)stack.push([list[i],depth+1]);}};
  rows.filter(r=>!r.session.parentId||!byId.has(r.session.parentId)).sort(compare).forEach(add);rows.sort(compare).forEach(add);
  group.rows=ordered;group.score=Math.max(0,...rows.map(r=>r.score));
 }
 return [...groups.values()].sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
}
export function attentionItems(events,hosts,now){
 const records=events.filter(e=>recordTime(e)<=now),resolved=new Map();
 for(const e of records)if(e.kind==='resolution'&&e.requestId){const k=[e.hostId,e.sessionId,e.requestId].join('|');resolved.set(k,Math.max(resolved.get(k)||0,recordTime(e)));}
 const items=records.filter(e=>e.kind==='approval'&&(!e.requestId||(resolved.get([e.hostId,e.sessionId,e.requestId].join('|'))||0)<recordTime(e))||(e.kind==='error'||['failed','interrupted'].includes(e.outcome))&&now-recordTime(e)<=300000).map(e=>({...e,eventId:e.id,priority:e.kind==='approval'?0:1,attention:true}));
 for(const h of hosts)if(['stale','disconnected'].includes(h.status))items.push({id:'host:'+h.id,hostId:h.id,label:h.name+' · '+h.status,kind:'source-gap',category:'error',priority:2,attention:true,at:h.receivedAt});
 for(const h of hosts)if(h.status==='online')for(const service of h.telemetry?.services||[])if(service.state==='failed'||service.subState==='auto-restart')items.push({id:'service:'+h.id+':'+service.unit,hostId:h.id,label:h.name+' / '+service.unit+' · '+service.state+' / '+service.subState,kind:'service-alert',category:'error',outcome:'failed',priority:1,attention:true,at:h.receivedAt});
 return items.sort((a,b)=>a.priority-b.priority||(recordTime(b)||0)-(recordTime(a)||0));
}
export function activityBins(events,now,windowMs=60000,count=24){
 const bins=Array.from({length:count},()=>({count:0,errors:0,categories:{}}));
 for(const e of events){const at=recordTime(e);if(at>now||at<now-windowMs||!Number.isFinite(at))continue;const b=bins[Math.min(count-1,Math.floor((at-(now-windowMs))/windowMs*count))];b.count++;b.categories[e.category||e.kind]=(b.categories[e.category||e.kind]||0)+1;if(e.kind==='error'||['failed','interrupted'].includes(e.outcome))b.errors++;}
 return bins;
}
// One pass across the source window replaces a full event scan for every worker.
// Keys remain host-qualified, just like worker selection and the event timeline.
export function workerActivitySeries(events,now,windowMs=60000,count=16){
 const series=new Map(),start=now-windowMs;
 for(const event of events){const at=recordTime(event);if(!Number.isFinite(at)||at<start||at>now)continue;
  const id=(event.hostId||'local')+'/'+event.sessionId;let values=series.get(id);if(!values){values=Array(count).fill(0);series.set(id,values);}
  values[Math.min(count-1,Math.floor((at-start)/windowMs*count))]++;
 }
 return series;
}
// Keep only the requested latest references, preserving stable input order for
// equal source times. A ticker does not need to sort or copy the full history.
export function latestActivityEvents(events,now,windowMs=60000,excludedIds=new Set(),limit=8){
 limit=Number.isInteger(limit)&&limit>=1&&limit<=64?limit:8;
 const latest=[],start=now-windowMs;
 for(const event of events){const at=recordTime(event);if(!Number.isFinite(at)||at<start||at>now||excludedIds.has(event.id))continue;
  if(latest.length===limit&&at<=latest.at(-1).at)continue;
  let i=latest.length;while(i>0&&at>latest[i-1].at)i--;latest.splice(i,0,{event,at});if(latest.length>limit)latest.pop();
 }
 return latest.map(item=>item.event);
}
const formats=new Map();
export function clockLabels(at,timeZone){
 const zone=timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone;
 if(!formats.has(zone)){const options={hourCycle:'h23',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3};formats.set(zone,{local:new Intl.DateTimeFormat('en-GB',{...options,timeZone:zone}),utc:new Intl.DateTimeFormat('en-GB',{...options,timeZone:'UTC'}),zone:new Intl.DateTimeFormat('en-US',{timeZone:zone,timeZoneName:'short'}),date:new Intl.DateTimeFormat('en-GB',{timeZone:zone,day:'2-digit',month:'short'})});}
 const f=formats.get(zone),date=new Date(at);return {local:f.local.format(date),utc:f.utc.format(date),zone:f.zone.formatToParts(date).find(p=>p.type==='timeZoneName')?.value||zone,date:f.date.format(date)};
}
// One track per observed source/category. Empty activity is never manufactured.
export function waterfallTracks(events,sessions){
 const sourceKey=e=>(e.hostId||'local')+'/'+(e.sessionId||e.id),sources=new Map(sessions.map(s=>[(s.hostId||'local')+'/'+s.id,s])),tracks=new Map();
 for(const e of events){const source=sourceKey(e),category=e.category||e.kind,id=source+'/'+category;if(!tracks.has(id))tracks.set(id,{id,source,category,session:sources.get(source)||{id:e.sessionId,hostId:e.hostId,project:e.project},events:[]});tracks.get(id).events.push(e);}
 return [...tracks.values()];
}
export function timelinePosition(span,reference,windowMs){
 const start=reference-windowMs,left=(span.start-start)/windowMs*100,right=(span.end-start)/windowMs*100;
 return {left:Math.max(0,Math.min(100,left)),width:Math.max(.15,Math.min(100,right)-Math.max(0,left)),visible:span.end>=start&&span.start<=reference};
}
const DEVICE_VISUALS={
 laptop:{label:'Laptop',color:'#20cfff',path:'M4 4h16v12H4z M2 20h20l-2-4H4z'},
 workstation:{label:'Workstation',color:'#20cfff',path:'M2 3h15v12H2z M5 20h9 M9 15v5 M19 5h3v15h-3z'},
 'rack-server':{label:'Rack server',color:'#ff9b32',path:'M3 2h18v6H3z M3 9h18v6H3z M3 16h18v6H3z M6 5h1 M6 12h1 M6 19h1 M15 5h3 M15 12h3 M15 19h3'},
 'raspberry-pi':{label:'Raspberry Pi',color:'#9bef38',path:'M5 5h14v14H5z M9 9h6v6H9z M8 1v4 M12 1v4 M16 1v4 M8 19v4 M12 19v4 M16 19v4 M1 8h4 M1 12h4 M1 16h4 M19 8h4 M19 12h4 M19 16h4'},
 edge:{label:'Edge node',color:'#00e3bb',path:'M12 2l9 5v10l-9 5-9-5V7z M3 7l9 5 9-5 M12 12v10'},
 cloud:{label:'Codex Cloud',color:'#c675ff',path:'M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5.5 5.5 0 0 1 0 11z M8 12l-2 2 2 2 M16 12l2 2-2 2'},
 unknown:{label:'Unclassified device',color:'#9eafc8',path:'M4 4h16v13H4z M8 21h8 M12 17v4'}
};
export function deviceVisual(host){const kind=Object.hasOwn(DEVICE_VISUALS,host?.deviceClass)?host.deviceClass:'unknown';return {kind,...DEVICE_VISUALS[kind]};}

// Connection notices remain inspectable in Alerts without occupying the ticker.
export const tickerAttentionItems=items=>items.filter(item=>item.kind!=='source-gap');
