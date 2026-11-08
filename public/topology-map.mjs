// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// A deterministic presentation of captured relationships and directed source legs.
// Coordinates are layout only; they do not claim geographical location or a network hop.
import {eventTime} from './event-model.mjs';
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const isWorker=n=>n?.type==='worker'||n?.type==='subagent';
const byId=(a,b)=>a.id.localeCompare(b.id);
const newest=(a,b)=>(b.latestAt||0)-(a.latestAt||0)||byId(a,b);
const failedJourney=j=>j.status==='failed'||['failed','interrupted'].includes((j.lastEvent||j.records.at(-1))?.outcome)||(j.lastEvent||j.records.at(-1))?.kind==='error';
const allowedColors=new Set(['remote','command','edit','research','agent','tool','turn','complete','message','approval','resolution','error']);
const paletteFor=colors=>Object.fromEntries(Object.entries(colors||{}).filter(([k,v])=>allowedColors.has(k)&&typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v)));
const radiusFor=n=>n.type==='worker'?22:n.type==='subagent'?18:n.type==='service'?20:18;
const directionKinds=new Set(['outbound','return','report']);
const journeyBudget=128,legBudget=256;
// Selection is pinned inside a bounded sample; complete source journeys stay upstream.
export function boundedJourneyMembers(members,selectedJourney){
 const chosen=new Map(),selected=members.find(j=>j.id===selectedJourney),directions=new Set();
 if(selected)chosen.set(selected.id,selected);
 // A result-heavy channel must not erase its older captured outbound direction.
 for(const journey of members)for(const leg of journey.legs){const key=journey.kind+':'+leg.direction;if(directions.has(key))continue;directions.add(key);if(chosen.size<journeyBudget)chosen.set(journey.id,journey);}
 for(const journey of members){if(chosen.size>=journeyBudget)break;chosen.set(journey.id,journey);}
 return [...chosen.values()].sort(newest);
}
const legOrder=(a,b)=>b.leg.at-a.leg.at||a.leg.eventId.localeCompare(b.leg.eventId)||byId(a.journey,b.journey);
function retainLeg(heap,item){
 // A fixed-size heap retains the newest source legs in O(log budget) per input.
 const worse=(a,b)=>legOrder(a,b)>0;
 if(heap.length<legBudget){heap.push(item);let i=heap.length-1;while(i){const p=(i-1)>>1;if(!worse(heap[i],heap[p]))break;[heap[i],heap[p]]=[heap[p],heap[i]];i=p;}return;}
 if(legOrder(item,heap[0])>=0)return;heap[0]=item;let i=0;
 for(;;){const a=i*2+1,b=a+1;if(a>=heap.length)break;const child=b<heap.length&&worse(heap[b],heap[a])?b:a;if(!worse(heap[child],heap[i]))break;[heap[i],heap[child]]=[heap[child],heap[i]];i=child;}
}

export function topologyPoint(curve,t){
 t=clamp(Number.isFinite(t)?t:0,0,1);const u=1-t;
 return [u*u*u*curve[0][0]+3*u*u*t*curve[1][0]+3*u*t*t*curve[2][0]+t*t*t*curve[3][0],u*u*u*curve[0][1]+3*u*u*t*curve[1][1]+3*u*t*t*curve[2][1]+t*t*t*curve[3][1]];
}

export function topologyCurve(a,b,{kind='outbound',side=1,index=0,width,height}={}){
 const dx=b.x-a.x,dy=b.y-a.y,length=Math.max(1,Math.hypot(dx,dy)),ux=dx/length,uy=dy/length,nx=-uy,ny=ux;
 const start=[a.x+ux*(a.radius||0),a.y+uy*(a.radius||0)],end=[b.x-ux*(b.radius||0),b.y-uy*(b.radius||0)];
 // Reversing a source-directed return flips the normal, so results follow a
 // visibly separate arc. No reverse route is created unless a leg exists.
 const bend=(kind==='parent'?clamp(length*.22,24,46):kind==='hosting'?clamp(length*.25,26,58):clamp(length*.25,48,120))*(side<0?-1:1)+(index%3)*(side<0?-9:9);
 const control=t=>[start[0]+(end[0]-start[0])*t+nx*bend,start[1]+(end[1]-start[1])*t+ny*bend];
 const curve=[start,control(.32),control(.68),end];
 if(Number.isFinite(width)&&Number.isFinite(height))for(const p of curve.slice(1,3)){p[0]=clamp(p[0],16,width-16);p[1]=clamp(p[1],32,height-24);}
 return curve;
}

function selectedWorkers(graph,nodeMap,limit,selectedJourney){
 const selected=graph.journeys.find(j=>j.id===selectedJourney),priority=new Set(selected?[selected.from,selected.to]:[]),latest=new Map();
 for(const journey of graph.journeys)for(const id of [journey.from,journey.to])latest.set(id,Math.max(latest.get(id)||0,journey.latestAt||0));
 const all=graph.nodes.filter(isWorker),ranked=[...all].sort((a,b)=>Number(priority.has(b.id))-Number(priority.has(a.id))||(b.lastAt||latest.get(b.id)||0)-(a.lastAt||latest.get(a.id)||0)||byId(a,b));
 let workers=ranked.slice(0,limit);
 // A child's explicit same-host parent remains useful context. Do not infer a
 // parent from a nickname, source path, or matching ID on a different host.
 for(const child of [...workers]){
  if(!child.parentId)continue;const parent=nodeMap.get('worker:'+child.hostId+'/'+child.parentId);
  if(!parent||!isWorker(parent)||workers.includes(parent))continue;
  const removable=[...workers].reverse().find(n=>!priority.has(n.id)&&n!==child&&!workers.some(other=>other.parentId===n.sessionId&&other.hostId===n.hostId));
  if(workers.length>=limit&&removable)workers=workers.filter(n=>n!==removable);
  if(workers.length<limit)workers.push(parent);
 }
 return {workers,all};
}

function chooseChannels(graph,workers,limit,selectedJourney){
 const chosen=new Map(),allChosen=new Map(),workerIds=new Set(workers.map(n=>n.id));
 // Index only this invocation's chosen workers, retaining source encounter
 // order and duplicate entries. A worker-to-worker journey belongs to both
 // endpoints; a self endpoint belongs to its worker only once.
 const byWorker=new Map(workers.map(worker=>[worker.id,[]]));
 for(const journey of graph.journeys){
  const {from,to}=journey;byWorker.get(from)?.push(journey);
  if(to!==from)byWorker.get(to)?.push(journey);
 }
 for(const worker of [...workers].sort(byId)){
  const channels=new Map();
  for(const journey of byWorker.get(worker.id)){
   const endpoint=journey.from===worker.id?journey.to:journey.from,key=JSON.stringify([endpoint,journey.category]);
   if(!channels.has(key))channels.set(key,[]);channels.get(key).push(journey);
  }
  for(const sources of channels.values())sources.sort(newest);
  const ranked=[...channels.values()].sort((a,b)=>newest(a[0],b[0]));
  let visible=ranked.slice(0,limit);const selected=ranked.find(group=>group.some(j=>j.id===selectedJourney));
  if(selected&&!visible.includes(selected))visible=[...visible.slice(0,Math.max(0,limit-1)),selected];
  for(const related of visible){for(const journey of related)allChosen.set(journey.id,journey);for(const journey of boundedJourneyMembers(related,selectedJourney))chosen.set(journey.id,journey);}
 }
 return {journeys:[...chosen.values()].sort(newest),allJourneys:[...allChosen.values()],workerIds};
}

const actorLayouts=new Map(),actorLayoutLimit=16;
function layoutActors(nodes,workers,options){
 const {width,height,grouping}=options,key=JSON.stringify([width,height,grouping,nodes.map(node=>[node.id,node.type,node.column,node.parentId,node.hostId,node.project,node.subtitle,node.label]),workers.map(node=>node.id)]);
 let cached=actorLayouts.get(key);
 if(!cached){const layout=computeActorLayout(nodes,workers,options);cached={nodes:layout.nodes.map(({node,...actor})=>({id:node.id,...actor})),groups:layout.groups};if(actorLayouts.size>=actorLayoutLimit)actorLayouts.delete(actorLayouts.keys().next().value);actorLayouts.set(key,cached);}
 // Cache coordinates only. Current statuses, source clocks, task labels and
 // records always come from this projection's nodes, never an older graph.
 const current=new Map(nodes.map(node=>[node.id,node])),positions=cached.nodes.map(({id,...actor})=>({...actor,node:current.get(id),bounds:{...actor.bounds},labelBounds:{...actor.labelBounds}}));
 return {nodes:positions,placed:new Map(positions.map(actor=>[actor.node.id,actor])),groups:cached.groups.map(group=>({...group,nodeIds:[...group.nodeIds]}))};
}
function computeActorLayout(nodes,workers,{width,height,grouping,nodeMap}){
 const positions=[],placed=new Map(),padding=40;
 const desiredPoint=(x,y,radius)=>({x:clamp(x,72,width-72),y:clamp(y,90,height-144),radius});
 const place=(node,x,y,extra={})=>{
  const radius=radiusFor(node),desired=desiredPoint(x,y,radius),gap=12;
  const clears=(px,py)=>positions.every(other=>Math.hypot(other.x-px,other.y-py)>=other.radius+radius+gap);
  let p=desired;
  if(!clears(p.x,p.y)){
   // A fixed lattice solves exceptional crowding without animation, random
   // jitter, or a force simulation that could suggest live movement of actors.
   let score=Infinity,best=null;
   for(let cy=padding;cy<=height-padding;cy+=8)for(let cx=padding;cx<=width-padding;cx+=8){
    if(!clears(cx,cy))continue;const distance=(cx-desired.x)**2+(cy-desired.y)**2;
    if(distance<score){score=distance;best={x:cx,y:cy,radius};}
   }
   if(best)p=best;
  }
  const actor={node,...p,role:node.type,...extra};positions.push(actor);placed.set(node.id,actor);return actor;
 };
 const sourceHosts=nodes.filter(n=>n.type==='host'&&n.column!==2).sort(byId);
 sourceHosts.forEach((node,i)=>{
  const portion=sourceHosts.length===1?.5:i/(sourceHosts.length-1),y=70+(height-140)*portion;
  const x=width*.16+Math.sin(portion*Math.PI)*Math.min(16,width*.02);
  place(node,x,y,{cluster:'sources',labelSide:'right'});
 });
 const groupKey=n=>grouping==='host'?n.hostId||'unknown':grouping==='project'?n.project||n.subtitle?.replace(/^Retained \/ /,'')||'Unassigned':'';
 const workerMap=new Map(workers.map(n=>[n.id,n])),children=new Map();
 for(const n of workers){const id=n.parentId?'worker:'+n.hostId+'/'+n.parentId:null;if(!workerMap.has(id))continue;if(!children.has(id))children.set(id,[]);children.get(id).push(n);}
 const order=[],visited=new Set();
 const visit=n=>{if(visited.has(n.id))return;visited.add(n.id);order.push(n);for(const child of (children.get(n.id)||[]).sort(byId))visit(child);};
 const roots=workers.filter(n=>!workerMap.has(n.parentId?'worker:'+n.hostId+'/'+n.parentId:null));
 roots.sort((a,b)=>groupKey(a).localeCompare(groupKey(b))||byId(a,b)).forEach(visit);
 [...workers].sort(byId).forEach(visit);
 const rows=Math.ceil(Math.max(1,workers.length)/2),rowTop=height*.20,rowBottom=height*.83,delta=Math.min(78,width*.095),center=width*.45;
 order.forEach((node,i)=>{
  const row=Math.floor(i/2),column=i%2,clusterCenter=rows<2?center:width*(row%2?.48:.34),x=clusterCenter+(column?delta:-delta),base=rows===1?height*.49:rowTop+(rowBottom-rowTop)*row/Math.max(1,rows-1),y=base+(column?(row%2?-17:19):0);
  place(node,x,y,{cluster:'workers',groupId:groupKey(node),labelSide:column?'right':'left'});
 });
 const endpointPriority={human:0,service:1,host:2};
 const endpoints=nodes.filter(n=>n.type==='service'||n.type==='human'||n.type==='host'&&n.column===2).sort((a,b)=>(endpointPriority[a.type]||0)-(endpointPriority[b.type]||0)||byId(a,b));
 endpoints.forEach((node,i)=>{
  const t=endpoints.length===1?.5:i/(endpoints.length-1),angle=(-72+t*144)*Math.PI/180;
  const x=width*.70+Math.cos(angle)*width*.13,y=height*.50+Math.sin(angle)*height*.37;
  place(node,x,y,{cluster:node.type==='host'?'targets':node.type==='human'?'review':'interfaces',labelSide:'left'});
 });
 const footprint=actor=>({x:actor.x-64,y:actor.y-actor.radius,width:128,height:actor.radius*2+47});
 const intersects=(a,b)=>a.x<b.x+b.width+6&&a.x+a.width+6>b.x&&a.y<b.y+b.height+6&&a.y+a.height+6>b.y;
 const needsPacking=positions.some((actor,i)=>{
  const bounds=footprint(actor);
  return actor.y<85||bounds.x<0||bounds.y<48||bounds.x+bounds.width>width||bounds.y+bounds.height>height-75||positions.slice(i+1).some(other=>intersects(bounds,footprint(other)));
 });
 if(needsPacking){
  // Reserve the complete button footprint, including its two/three text lines.
  // Crowded maps use fixed, well-spaced slots rather than squeezing labels or
  // moving actors with a force animation. Nearest slots preserve their cluster.
  const columns=Math.max(3,Math.floor((width-144)/144)+1),rows=Math.max(3,Math.ceil(positions.length/columns)),slots=[];
  for(let row=0;row<rows;row++)for(let column=0;column<columns;column++)slots.push({x:72+column*(width-144)/Math.max(1,columns-1),y:rows===1?Math.min(height*.46,height-144):90+row*(height-234)/Math.max(1,rows-1)});
  const fitted=new Map();
  for(const actor of positions){
   const parent=actor.node.parentId?fitted.get('worker:'+actor.node.hostId+'/'+actor.node.parentId):null;
   const near=parent?slots.filter(slot=>Math.hypot(slot.x-parent.x,slot.y-parent.y)<190):[],candidates=near.length?near:slots;
   const best=[...candidates].sort((a,b)=>(a.x-actor.x)**2+(a.y-actor.y)**2-((b.x-actor.x)**2+(b.y-actor.y)**2)||a.y-b.y||a.x-b.x)[0];
   if(!best)continue;actor.x=best.x;actor.y=best.y;slots.splice(slots.indexOf(best),1);fitted.set(actor.node.id,actor);
  }
 }
 for(const actor of positions){actor.bounds=footprint(actor);actor.labelBounds={x:actor.x-64,y:actor.y+actor.radius+3,width:128,height:44};}
 const groups=[];
 if(grouping!=='worker')for(const worker of order){
  const id=groupKey(worker);if(groups.some(g=>g.id===id))continue;
  const members=order.filter(n=>groupKey(n)===id).map(n=>placed.get(n.id)),label=grouping==='host'?(nodeMap.get('host:'+worker.hostId)?.label||worker.hostId||'Unknown source'):id;
  const xs=members.map(n=>n.x),ys=members.map(n=>n.y);
  groups.push({id,label,nodeIds:members.map(n=>n.node.id),x:Math.min(...xs)-34,y:Math.min(...ys)-40,width:Math.max(...xs)-Math.min(...xs)+68,height:Math.max(...ys)-Math.min(...ys)+80});
 }
 return {nodes:positions.sort((a,b)=>byId(a.node,b.node)),placed,groups};
}

function layoutReadableActors(nodes,workers,{width,height,grouping,nodeMap,presentationScale,workerCardWidth,workerCardHeight,stationWidth,stationHeight,topPadding,bottomPadding}){
 const scale=presentationScale,positions=[],placed=new Map(),workerMap=new Map(workers.map(n=>[n.id,n])),children=new Map();
 const groupKey=n=>grouping==='host'?n.hostId||'unknown':grouping==='project'?n.project||n.subtitle?.replace(/^Retained \/ /,'')||'Unassigned':'';
 for(const worker of workers){const parent=worker.parentId?'worker:'+worker.hostId+'/'+worker.parentId:null;if(!workerMap.has(parent))continue;if(!children.has(parent))children.set(parent,[]);children.get(parent).push(worker);}
 const ordered=[],visited=new Set(),visit=worker=>{if(visited.has(worker.id))return;visited.add(worker.id);ordered.push(worker);for(const child of (children.get(worker.id)||[]).sort(byId))visit(child);};
 workers.filter(n=>!workerMap.has(n.parentId?'worker:'+n.hostId+'/'+n.parentId:null)).sort((a,b)=>groupKey(a).localeCompare(groupKey(b))||byId(a,b)).forEach(visit);
 [...workers].sort(byId).forEach(visit);
 const hosts=nodes.filter(n=>n.type==='host'&&n.column!==2).sort(byId),priority={human:0,service:1,host:2};
 const endpoints=nodes.filter(n=>n.type==='service'||n.type==='human'||n.type==='host'&&n.column===2).sort((a,b)=>priority[a.type]-priority[b.type]||byId(a,b));
 // All dimensions in this block are physical CSS pixels. Dividing coordinates
 // by the actual presentation scale preserves legible cards and recognizable
 // icons when the surrounding map is fitted. Tight viewports deliberately pan.
 const band=(actors,card)=>{
  const columns=Math.ceil(actors.length/3),rows=columns?Math.ceil(actors.length/columns):0,w=card?workerCardWidth:stationWidth,h=card?workerCardHeight:stationHeight,gapX=card?24:12,gapY=12,pitch=h+gapY;
  const phase=column=>[0,.16,.08][column%3]*pitch;
  return {actors,card,columns,rows,w,h,gapX,gapY,pitch,phase,width:columns?columns*w+(columns-1)*gapX:0,height:rows?rows*h+(rows-1)*gapY+Math.max(...Array.from({length:columns},(_,i)=>phase(i))):0};
 };
 const bands=[band(hosts,false),band(ordered,true),band(endpoints,false)].filter(b=>b.actors.length),physicalWidth=24+bands.reduce((n,b)=>n+b.width,0)+Math.max(0,bands.length-1)*24,physicalHeight=topPadding+Math.max(0,...bands.map(b=>b.height))+bottomPadding;
 width=Math.max(width,physicalWidth/scale);height=Math.max(height,physicalHeight/scale);
 let left=12+(width*scale-physicalWidth)/2;
 for(const b of bands){
  b.actors.forEach((node,i)=>{
   const column=Math.floor(i/b.rows),row=i%b.rows,bx=left+column*(b.w+b.gapX),by=topPadding+row*b.pitch+b.phase(column),radius=(b.card?22:18)/scale,x=(bx+(b.card?22:b.w/2))/scale,y=(by+(b.card?b.h/2:18))/scale;
   const bounds={x:b.card?x-radius:x-b.w/2/scale,y:b.card?y-b.h/2/scale:y-radius,width:b.w/scale,height:b.h/scale},labelBounds=b.card?{x:x+radius+8/scale,y:bounds.y,width:bounds.width-radius*2-8/scale,height:bounds.height}:{x:bounds.x,y:y+radius+3/scale,width:bounds.width,height:(b.h-39)/scale};
   const actor={node,x,y,radius,role:node.type,presentationScale:scale,bounds,labelBounds,labelSide:b.card?'right':'below',cluster:b.card?'workers':node.type==='host'&&node.column!==2?'sources':node.type==='host'?'targets':node.type==='human'?'review':'interfaces',groupId:b.card?groupKey(node):undefined};
   if(b.card)actor.cardBounds=bounds;else actor.stationBounds=bounds;
   positions.push(actor);placed.set(node.id,actor);
  });
  left+=b.width+24;
 }
 const groups=[];
 if(grouping!=='worker')for(const worker of ordered){
  const id=groupKey(worker);if(groups.some(g=>g.id===id))continue;
  const members=ordered.filter(n=>groupKey(n)===id).map(n=>placed.get(n.id)),left=Math.min(...members.map(n=>n.bounds.x)),right=Math.max(...members.map(n=>n.bounds.x+n.bounds.width)),top=Math.min(...members.map(n=>n.bounds.y)),bottom=Math.max(...members.map(n=>n.bounds.y+n.bounds.height));
  groups.push({id,label:grouping==='host'?(nodeMap.get('host:'+worker.hostId)?.label||worker.hostId||'Unknown source'):id,nodeIds:members.map(n=>n.node.id),x:left-10/scale,y:top-10/scale,width:right-left+20/scale,height:bottom-top+20/scale});
 }
 return {width,height,nodes:positions.sort((a,b)=>byId(a.node,b.node)),placed,groups,physicalContentSize:{width:physicalWidth,height:physicalHeight}};
}

export function projectTopology(graph,options={}){return topologyProjection(graph,options);}

// Fit can solve geometry twice, but its source clock, scope, selection and
// preferences stay bound to one synchronous invocation. This context never
// escapes the call and cannot retain a stale graph across later updates.
export function projectTopologyFit(graph,options={},{width=900,height=460,mode='fit'}={}){
 const prepared={},bound={...options,reference:options.reference===undefined?graph.reference||Date.now():options.reference};
 let layout=topologyProjection(graph,bound,prepared),scale=mode==='fit'?Math.min(1,Math.max(1,width)/layout.width,Math.max(1,height)/layout.height):1;
 if(mode==='fit'&&scale<1){layout=topologyProjection(graph,{...bound,width:Math.max(720,width/scale),height:layout.height},prepared);scale=Math.min(1,Math.max(1,width)/layout.width,Math.max(1,height)/layout.height);}
 return {layout,scale};
}
const prepare=(context,key,create)=>context?(context[key]??=create()):create();

function topologyProjection(graph,{width=900,height=460,fontSize=16,reference=graph.reference||Date.now(),windowMs=60000,selectedJourney=null,selectedEvent=null,maxWorkers=6,maxPerWorker=3,grouping='worker',showHosts=true,showTools=true,showBranches=true,density=true,labels='detailed',colors={},workerCardWidth,workerCardHeight,stationWidth,stationHeight,presentationScale=1,topPadding=40,bottomPadding=24}={},prepared){
 const requestedHeight=Number.isFinite(height)?Math.max(1,height):460,readableCards=[workerCardWidth,workerCardHeight,stationWidth,stationHeight].some(Number.isFinite);
 presentationScale=clamp(Number.isFinite(presentationScale)?presentationScale:1,.35,1.5);
 workerCardWidth=clamp(Number.isFinite(workerCardWidth)?workerCardWidth:216,160,320);workerCardHeight=clamp(Number.isFinite(workerCardHeight)?workerCardHeight:88,64,2048);
 stationWidth=clamp(Number.isFinite(stationWidth)?stationWidth:136,96,220);stationHeight=clamp(Number.isFinite(stationHeight)?stationHeight:82,72,2048);
 topPadding=clamp(Number.isFinite(topPadding)?topPadding:40,0,160);bottomPadding=clamp(Number.isFinite(bottomPadding)?bottomPadding:24,0,160);
 width=Math.max(720,Number.isFinite(width)?width:900);fontSize=clamp(Number.isFinite(fontSize)?fontSize:16,12,26);
 maxWorkers=clamp(Number.isInteger(maxWorkers)?maxWorkers:6,1,8);maxPerWorker=clamp(Number.isInteger(maxPerWorker)?maxPerWorker:3,1,3);
 grouping=['host','project'].includes(grouping)?grouping:'worker';labels=labels==='compact'?'compact':'detailed';
 const {nodeMap,selection,workers}=prepare(prepared,'selection',()=>{
  const nodeMap=new Map(graph.nodes.map(n=>[n.id,n])),selection=selectedWorkers(graph,nodeMap,maxWorkers,selectedJourney);
  return {nodeMap,selection,workers:selection.workers};
 });
 height=clamp(Math.max(Number.isFinite(height)?height:460,workers.length>6?500:420,fontSize*26),420,560);
 const {palette,selected,actors}=prepare(prepared,'channels',()=>{
  const palette=paletteFor(colors),selected=chooseChannels(graph,workers,maxPerWorker,selectedJourney),included=new Set(workers.map(n=>n.id));
  for(const n of graph.nodes)if(n.type==='host')included.add(n.id);
  for(const j of selected.journeys)for(const leg of j.legs)for(const id of [leg.from,leg.to])if(nodeMap.has(id))included.add(id);
  return {palette,selected,actors:graph.nodes.filter(n=>included.has(n.id))};
 });
 const columns=Math.max(3,Math.floor((width-144)/144)+1);
 height=clamp(Math.max(height,234+(Math.ceil(actors.length/columns)-1)*104,actors.length>=14?560:420),420,560);
 const layout=readableCards?layoutReadableActors(actors,workers,{width,height:requestedHeight,grouping,nodeMap,presentationScale,workerCardWidth,workerCardHeight,stationWidth,stationHeight,topPadding,bottomPadding}):layoutActors(actors,workers,{width,height,grouping,nodeMap}),routes=[];
 if(readableCards){width=layout.width;height=layout.height;}
 for(const actor of layout.nodes)actor.hidden=actor.role==='host'?!showHosts:actor.role==='service'?!showTools:false;
 const colorFor=j=>failedJourney(j)?(palette.error||j.color||'#ff5a75'):(palette[j.category]||j.color||'#79bfff');
 let nodeRecords;const cached=prepared?.evidence,placedIds=prepared?new Set(layout.placed.keys()):null;
 if(cached&&placedIds.size===cached.placedIds.size&&[...placedIds].every(id=>cached.placedIds.has(id))){
  nodeRecords=cached.nodeRecords;
  // Curves belong to each geometry pass. Never attach them to cached routes or
  // mutate the first pass's returned route objects during the second pass.
  routes.push(...cached.routes.map(route=>({...route})));
 }else{
 const routeMap=new Map(),routeEvidence=new Map(),sampleIds=new Set(selected.journeys.map(j=>j.id));nodeRecords=new Map();
 // One linear count/index pass covers complete chosen channels. Only sampled
 // members and fixed-size leg heaps reach the route/layout presentation graph.
 for(const journey of selected.allJourneys){
  for(const leg of journey.legs){
   if(!directionKinds.has(leg.direction)||!layout.placed.has(leg.from)||!layout.placed.has(leg.to)||!Number.isFinite(leg.at)||leg.at>reference)continue;
   const key=JSON.stringify([leg.from,leg.to,leg.direction,journey.category]);
   if(!routeMap.has(key)){
    routeMap.set(key,{id:'route:'+key,from:leg.from,to:leg.to,kind:leg.direction,category:journey.category,color:leg.direction==='return'&&!failedJourney(journey)?(palette.resolution||palette.complete||'#6ff0be'):colorFor(journey),related:[],legs:[],eventIds:[],recordCount:0,latestAt:0,selected:false,hidden:false,metadata:false});
    routeEvidence.set(key,{members:new Set(),shown:new Set(),records:new Set(),window:new Set(),channelRecords:new Set(),legCount:0,heap:[],boundaries:new Map(),pinned:[]});
   }
   const route=routeMap.get(key),evidence=routeEvidence.get(key),item={journey,leg};evidence.legCount++;
   evidence.records.add(leg.eventId);if(leg.at>=reference-windowMs)evidence.window.add(leg.eventId);
   if(!evidence.members.has(journey.id)){evidence.members.add(journey.id);for(const record of journey.records)evidence.channelRecords.add(record.id);route.failedCount=(route.failedCount||0)+Number(failedJourney(journey));}
   for(const id of [leg.from,leg.to]){if(!nodeRecords.has(id))nodeRecords.set(id,new Set());nodeRecords.get(id).add(leg.eventId);}
   route.latestAt=Math.max(route.latestAt,leg.at);route.selected||=journey.id===selectedJourney;
   if(!sampleIds.has(journey.id))continue;
   if(!evidence.shown.has(journey.id)){evidence.shown.add(journey.id);route.related.push(journey);}
   retainLeg(evidence.heap,item);
   const boundary=evidence.boundaries.get(journey.id);if(!boundary)evidence.boundaries.set(journey.id,{first:item,last:item});else {if(legOrder(item,boundary.first)>0)boundary.first=item;if(legOrder(item,boundary.last)<0)boundary.last=item;}
   if(leg.eventId===selectedEvent)evidence.pinned.push(item);
  }
 }
 for(const [key,route] of routeMap){
  const evidence=routeEvidence.get(key),boundary=[...evidence.boundaries.values()].flatMap(value=>[value.first,value.last]),required=new Set(boundary),pinned=new Set(evidence.pinned),items=[...new Set([...evidence.pinned,...boundary,...evidence.heap])];
  items.sort((a,b)=>Number(pinned.has(b))-Number(pinned.has(a))||Number(b.journey.id===selectedJourney&&required.has(b))-Number(a.journey.id===selectedJourney&&required.has(a))||Number(required.has(b))-Number(required.has(a))||legOrder(a,b));
  route.legs=items.slice(0,legBudget).sort(legOrder);route.related.sort(newest);
  route.eventIds=[...new Set(route.legs.map(item=>item.leg.eventId))];route.recordCount=evidence.records.size;route.windowRecordCount=evidence.window.size;
  route.channelRecordCount=evidence.channelRecords.size;route.channelJourneyCount=evidence.members.size;
  route.hiddenJourneyCount=route.channelJourneyCount-route.related.length;route.hiddenRecordCount=route.recordCount-route.eventIds.length;route.hiddenLegCount=evidence.legCount-route.legs.length;
  route.historical=route.latestAt<reference-windowMs;route.journey=route.related.find(j=>j.id===selectedJourney)||route.related[0];routes.push(route);
 }
 if(prepared)prepared.evidence={placedIds,nodeRecords,routes:routes.map(route=>({...route}))};
 }
 for(const edge of [...graph.edges].sort(byId)){
  if(!['hosting','parent'].includes(edge.kind)||!layout.placed.has(edge.from)||!layout.placed.has(edge.to))continue;
  if(edge.kind==='parent'){
   const parent=nodeMap.get(edge.from),child=nodeMap.get(edge.to);
   if(!parent||!child||parent.hostId!==child.hostId||child.parentId!==parent.sessionId)continue;
  }
  routes.push({id:edge.id,from:edge.from,to:edge.to,kind:edge.kind,category:edge.kind==='parent'?'agent':'hosting',color:edge.color||(edge.kind==='parent'?(palette.agent||'#bf83ff'):'#517b9a'),related:[],legs:[],eventIds:[],recordCount:0,latestAt:0,historical:true,metadata:true,edge,selected:false,hidden:edge.kind==='hosting'?!showHosts:!showBranches});
 }
 routes.sort(byId);
 const routeIndex=new Map();
 for(const route of routes){
  const pair=[route.from,route.to].sort().join('\0'),index=routeIndex.get(pair)||0;routeIndex.set(pair,index+1);
  // Outbound and return keep the same local side. Direction reverses their
  // perpendicular, separating the two physical paths around a shared station.
  route.curve=topologyCurve(layout.placed.get(route.from),layout.placed.get(route.to),{kind:route.kind,side:1,index,width,height});
  route.labelPoint=topologyPoint(route.curve,.52);route.arrowPoint=topologyPoint(route.curve,.78);
 }
 const {bins,windowIds}=prepare(prepared,'density',()=>{
  const bins=Array.from({length:48},(_,i)=>({start:reference-windowMs+i*windowMs/48,count:0,colors:new Map()})),windowIds=new Set();
  for(const journey of graph.journeys)for(const record of journey.records){
    const at=eventTime(record);if(!Number.isFinite(at)||at<reference-windowMs||at>reference||windowIds.has(record.id))continue;
   windowIds.add(record.id);const bin=bins[Math.min(47,Math.floor((at-reference+windowMs)/windowMs*48))],color=colorFor(journey);bin.count++;bin.colors.set(color,(bin.colors.get(color)||0)+1);
  }
  return {bins,windowIds};
 });
 const shownJourneyIds=new Set(routes.flatMap(r=>r.related.map(j=>j.id)));
 return {width,height,fontSize,nodes:layout.nodes,nodeRecordCounts:new Map([...nodeRecords].map(([id,records])=>[id,records.size])),routes,groups:layout.groups,viewBounds:{x:0,y:0,width,height},readableCards,presentationScale,physicalContentSize:layout.physicalContentSize||null,grouping,showHosts,showTools,showBranches,density,labels,bins,uniqueWindowRecords:windowIds.size,hiddenJourneys:graph.journeys.filter(j=>!shownJourneyIds.has(j.id)).length,hiddenWorkers:(graph.hiddenWorkers||0)+selection.all.length-workers.length,workerCount:workers.length,channelCount:new Set(routes.filter(r=>!r.metadata).map(r=>JSON.stringify([[r.from,r.to].sort(),r.category]))).size,reference,windowMs};
}
