// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {boundedJourneyMembers} from './topology-map.mjs';
const point=(c,t)=>{if(Array.isArray(c[0][0])){const i=Math.min(c.length-1,Math.floor(t*c.length));return point(c[i],t*c.length-i);}const u=1-t;return [u*u*u*c[0][0]+3*u*u*t*c[1][0]+3*u*t*t*c[2][0]+t*t*t*c[3][0],u*u*u*c[0][1]+3*u*u*t*c[1][1]+3*u*t*t*c[2][1]+t*t*t*c[3][1]];};
export function routeCurve(a,b,edge,width,height,halfWidth=64){
 // Tool-interface routes bypass the fleet stations. Crossing a server's icon would
 // falsely suggest that the server was a hop in that call.
 if(edge.from.startsWith('service:')||edge.to.startsWith('service:')){const returning=edge.from.startsWith('service:'),worker=returning?b:a,service=returning?a:b,left=worker.x+halfWidth,right=service.x-halfWidth,railLeft=worker.x+halfWidth+21,railRight=(width*.65+halfWidth+right)/2,y=returning?18:height-15;
  if(returning)return [[[right,service.y],[right-10,service.y],[railRight+10,y],[railRight,y]],[[railRight,y],[railRight-35,y],[railLeft+30,y],[railLeft,y]],[[railLeft,y],[railLeft-20,y],[left+25,worker.y],[left,worker.y]]];
  return [[[left,worker.y],[left+25,worker.y],[railLeft-20,y],[railLeft,y]],[[railLeft,y],[railLeft+30,y],[railRight-35,y],[railRight,y]],[[railRight,y],[railRight+10,y],[right-10,service.y],[right,service.y]]];
 }
 const forward=b.x>a.x,sign=forward?1:-1,x1=a.x+sign*halfWidth,x2=b.x-sign*halfWidth,y1=a.y+(edge.kind==='return'?9:edge.kind==='outbound'?-9:0),y2=b.y+(edge.kind==='return'?9:edge.kind==='outbound'?-9:0);
 if(Math.abs(a.x-b.x)<10){const bend=Math.max(a.x,b.x)+92;return [[a.x+halfWidth,a.y],[bend,a.y],[bend,b.y],[b.x+halfWidth,b.y]];}
 const distance=Math.max(30,Math.abs(x2-x1)*.52);return [[x1,y1],[x1+sign*distance,y1],[x2-sign*distance,y2],[x2,y2]];
}

const paletteKeys=new Set(['remote','command','edit','research','agent','tool','turn','complete','message','approval','resolution','error']);
const projectedColors=input=>Object.fromEntries(Object.entries(input||{}).filter(([key,value])=>paletteKeys.has(key)&&typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value)));
// Layout is a bounded view of existing evidence. It creates no telemetry or inferred hop.
export function projectFlowPlane(graph,{reference=Date.now(),windowMs=60000,width=900,fontSize=16,selectedJourney=null,maxWorkers=8,maxPerWorker=3,grouping='worker',showHosts=true,showTools=true,showBranches=true,density=true,labels='detailed',colors={}}={}){
 const nodeMap=new Map(graph.nodes.map(n=>[n.id,n]));
 maxWorkers=maxWorkers===8?8:6;maxPerWorker=Number.isInteger(maxPerWorker)&&maxPerWorker>=1&&maxPerWorker<=3?maxPerWorker:3;grouping=['host','project'].includes(grouping)?grouping:'worker';labels=labels==='compact'?'compact':'detailed';const palette=projectedColors(colors),colorFor=j=>j.status==='failed'?(palette.error||j.color):(palette[j.category]||j.color);
 const byWorker=new Map();for(const j of graph.journeys)for(const id of new Set([j.from,j.to])){if(!byWorker.has(id))byWorker.set(id,[]);byWorker.get(id).push(j);}
 for(const linked of byWorker.values())linked.sort((a,b)=>b.latestAt-a.latestAt||a.id.localeCompare(b.id));
 const selected=graph.journeys.find(j=>j.id===selectedJourney),selectedIds=new Set(selected?[selected.from,selected.to]:[]),allWorkers=graph.nodes.filter(n=>n.type==='worker'||n.type==='subagent');
 const workers=allWorkers.sort((a,b)=>Number(selectedIds.has(b.id))-Number(selectedIds.has(a.id))||(b.lastAt||byWorker.get(b.id)?.[0]?.latestAt||0)-(a.lastAt||byWorker.get(a.id)?.[0]?.latestAt||0)||a.id.localeCompare(b.id)).slice(0,maxWorkers);
 const groupKey=n=>grouping==='host'?(n.hostId||'unknown'):grouping==='project'?(n.project||n.subtitle?.replace(/^Retained \/ /,'')||'Unassigned'):'';
 const groupLabel=n=>grouping==='host'?(nodeMap.get('host:'+n.hostId)?.label||n.hostId||'Unknown source'):groupKey(n);
 workers.sort((a,b)=>groupLabel(a).localeCompare(groupLabel(b))||groupKey(a).localeCompare(groupKey(b))||a.id.localeCompare(b.id));
 const laneHeight=Math.max(68,fontSize*4.5),top=Math.max(72,fontSize*4.7)-(showHosts?0:37)-(density?0:30),left=Math.min(fontSize*9,Math.max(108,width*.28)),right=width-(showTools?Math.min(fontSize*8.6,Math.max(90,width*.25)):16),groupHeight=grouping==='worker'?0:Math.max(20,fontSize*1.4);
 const traces=[],lanes=[],groups=[],shown=new Set();let hiddenJourneys=0,cursor=top,lastGroup=null;
 for(const node of workers){
  const linked=byWorker.get(node.id)||[];
  const channels=new Map();for(const j of linked){const endpoint=j.from===node.id?j.to:j.from,key=JSON.stringify([endpoint,j.kind,j.category]);if(!channels.has(key))channels.set(key,[]);channels.get(key).push(j);}
  const channelGroups=[...channels.values()].sort((a,b)=>b[0].latestAt-a[0].latestAt||a[0].id.localeCompare(b[0].id));
  let chosen=channelGroups.slice(0,maxPerWorker);const selectedGroup=channelGroups.find(group=>group.some(j=>j.id===selectedJourney));
  if(selectedGroup&&!chosen.includes(selectedGroup)){chosen=chosen.slice(0,Math.max(0,maxPerWorker-1));chosen.push(selectedGroup);}
  const key=groupKey(node);if(grouping!=='worker'&&key!==lastGroup){groups.push({id:key,label:groupLabel(node),y:cursor+groupHeight*.7});cursor+=groupHeight;lastGroup=key;}
  const y=cursor+laneHeight/2;cursor+=laneHeight;
  const parentId=node.parentId?'worker:'+node.hostId+'/'+node.parentId:null;
  const lane={node,y,top:y-laneHeight/2,height:laneHeight,parentId:nodeMap.has(parentId)&&workers.some(n=>n.id===parentId)?parentId:null,journeyCount:linked.length,channelCount:channelGroups.length,shownCount:chosen.length};lanes.push(lane);
  for(const [i,members] of chosen.entries()){
   const related=boundedJourneyMembers(members,selectedJourney);hiddenJourneys+=members.length-related.length;
   const journey=related.find(j=>j.id===selectedJourney)||related[0];if(shown.has(journey.id))continue;shown.add(journey.id);
   const endpoint=nodeMap.get(journey.from===node.id?journey.to:journey.from);if(!endpoint)continue;
   const recordCount=new Set(members.flatMap(j=>j.records.map(e=>e.id))).size,failedCount=members.filter(j=>j.status==='failed').length;
   traces.push({journey,related,recordCount,failedCount,channelJourneyCount:members.length,hiddenJourneyCount:members.length-related.length,node,endpoint,color:colorFor(journey),returnColor:palette.resolution||palette.complete||'#6ff0be',errorColor:palette.error||'#ff5a75',y:y+(i-(chosen.length-1)/2)*Math.max(18,fontSize*1.15),laneY:y,historical:journey.latestAt<reference-windowMs,index:i,selected:related.some(j=>j.id===selectedJourney)});
  }
  hiddenJourneys+=channelGroups.filter(group=>!chosen.includes(group)).reduce((n,group)=>n+group.length,0);
 }
 const visibleWorkers=new Set(workers.map(w=>w.id));hiddenJourneys+=graph.journeys.filter(j=>!visibleWorkers.has(j.from)&&!visibleWorkers.has(j.to)).length;
 const bins=Array.from({length:48},(_,i)=>({start:reference-windowMs+i*windowMs/48,count:0,colors:new Map()}));
 const recordIds=new Set();for(const j of graph.journeys)for(const e of j.records){const t=Date.parse(e.at);if(!Number.isFinite(t)||t<reference-windowMs||t>reference||recordIds.has(e.id))continue;recordIds.add(e.id);const bin=bins[Math.min(47,Math.floor((t-(reference-windowMs))/windowMs*48))],color=colorFor(j);bin.count++;bin.colors.set(color,(bin.colors.get(color)||0)+1);}
 return {width,left,right,top,laneHeight,lanes,traces,groups,grouping,showHosts,showTools,showBranches,density,labels,hiddenJourneys,height:Math.max(205,cursor+25),bins,uniqueWindowRecords:recordIds.size,hosts:showHosts?graph.nodes.filter(n=>n.type==='host').sort((a,b)=>a.id.localeCompare(b.id)):[]};
}
export function flowRoute(trace,direction,layout){
 const {left,right}=layout,y=trace.y,bend=Math.max(36,(right-left)*.30),spread=direction==='outbound'?-6:6;
 if(direction==='return'||direction==='report')return [[right,y+spread],[right-bend,y+spread+13],[left+bend,y+spread+13],[left,y+spread]];
 return [[left,y+spread],[left+bend,y+spread-13],[right-bend,y+spread-13],[right,y+spread]];
}
export {ActivityMap} from './topology-view.mjs';
export {point as routePoint};
