// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {clampZoom,zoomGeometry,anchoredScroll} from './view-zoom.mjs';
import {projectTopologyFit,topologyPoint} from './topology-map.mjs';
import {topologyLegProgress,topologyObservationState} from './topology-motion.mjs';
import {stationSymbol,stationIdentity} from './map-symbols.mjs';
import {workerActivity,routeObservation} from './worker-activity.mjs';
import {TokenMotion,projectTokenChannels,drawTokenCoin} from './token-motion.mjs';
import {DEFAULT_TOKEN_PALETTE,getTokenPalette} from './token-palette.mjs';

const escape=value=>String(value??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const patchAttribute=(element,name,value)=>{value=String(value);if(element.getAttribute(name)!==value)element.setAttribute(name,value);};
const patchText=(element,value)=>{value=String(value??'');if(element.textContent!==value)element.textContent=value;};
const path=c=>`M${c[0].join(',')} C${c[1].join(',')} ${c[2].join(',')} ${c[3].join(',')}`;
const age=(value,reference)=>{if(!Number.isFinite(value))return 'no record';const s=Math.max(0,(reference-value)/1000);return s<60?Math.floor(s)+'s ago':s<3600?Math.floor(s/60)+'m ago':Math.floor(s/3600)+'h ago';};
const timeFormatter=new Intl.DateTimeFormat([],{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
const time=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?timeFormatter.format(date):'Invalid Date';};
const direction={outbound:'Call →',return:'↩ Result',report:'Report →',hosting:'Collector relationship',parent:'Explicit parent'};
const safeColor=value=>/^#[0-9a-f]{6}$/i.test(value||'')?value:'#79bfff';
const trailSprites=new Map();
// workerActivity owns correlation and status semantics. Give that unchanged
// state machine exactly the candidates it previously scoped from the full graph,
// instead of reparsing every retained source timestamp once per visible worker.
function workerRecordViews(graph,nodes){
 const byHost=new Map(),buckets=new Map();
 for(const node of nodes){if(!byHost.has(node.hostId))byHost.set(node.hostId,new Map());const bucket={node,records:[],seen:new Set()};byHost.get(node.hostId).set(node.sessionId,bucket);buckets.set(node.id,bucket);}
 const add=(record,journey)=>{
  if(!record||typeof record!=='object')return;const remote=String(record.kind||'').startsWith('remote.');
  const bucket=byHost.get(remote?record.workerHostId:record.hostId)?.get(remote?record.workerSessionId:record.sessionId);if(!bucket||bucket.seen.has(record))return;
  if(journey&&journey.from!==bucket.node.id&&journey.to!==bucket.node.id&&!(journey.legs||[]).some(leg=>leg.from===bucket.node.id||leg.to===bucket.node.id))return;
  bucket.seen.add(record);bucket.records.push(record);
 };
 for(const record of Array.isArray(graph.records)?graph.records:[])add(record);
 for(const record of Array.isArray(graph.events)?graph.events:[])add(record);
 // Preserve recordsFor's original tie precedence: source arrays, this node's
 // lastEvent, then linked journeys. Equal identity/time variants keep the first.
 for(const node of nodes){const record=node.lastEvent,bucket=buckets.get(node.id);if(record&&!bucket.seen.has(record)){bucket.seen.add(record);bucket.records.push(record);}}
 for(const journey of graph.journeys||[])for(const record of journey.records||[])add(record,journey);
 return new Map([...buckets].map(([id,bucket])=>[id,{...graph,records:bucket.records,events:[],journeys:[]}]));
}
function trailSprite(color){
 if(trailSprites.has(color))return trailSprites.get(color);let canvas;
 if(typeof globalThis.OffscreenCanvas==='function')canvas=new OffscreenCanvas(80,80);
 else if(typeof globalThis.document?.createElement==='function'){canvas=document.createElement('canvas');canvas.width=canvas.height=80;}
 const painter=canvas?.getContext?.('2d');if(!painter)return null;
 painter.scale(2,2);const glow=painter.createRadialGradient(20,20,0,20,20,20);glow.addColorStop(0,color);glow.addColorStop(.15,color);glow.addColorStop(.35,color+'99');glow.addColorStop(1,color+'00');painter.fillStyle=glow;painter.fillRect(0,0,40,40);
 if(trailSprites.size>=32)trailSprites.delete(trailSprites.keys().next().value);trailSprites.set(color,canvas);return canvas;
}

// SVG holds durable, inspectable evidence; Canvas paints only newly observed legs.
// Both use the same deterministic world coordinates, including during resize.
export class ActivityMap{
 constructor({layer,canvas,onEvent,onDetails,onWorkers,tokenStorage=null,onViewChange=()=>{}}){
  Object.assign(this,{layer,canvas,onEvent,onDetails,onWorkers,selection:null,graph:null,curves:new Map(),traceGroups:new Map(),zoomMode:'fit',zoomFactor:1,onViewChange,showHistory:false});
  this.tokenMotion=new TokenMotion({storage:tokenStorage});this.tokenChannels={anchor:null,channels:[],mapped:0,unmapped:0};this.tokenPalette=DEFAULT_TOKEN_PALETTE;
  this.tokenChannelLookup=new Map();this.stationNodes=new Map();this.routeNodes=new Map();this.layoutVersion=0;this.activeLegCache=null;this.overlayVisible=false;this.overlayInvalid=true;this.scrollX=0;this.scrollY=0;
  layer.innerHTML='<div class="topology-frame"><div class="map-world topology-world"><div class="topology-regions" aria-hidden="true"></div><svg class="map-routes topology-routes" aria-label="Captured calls, results, target reports and explicit relationships"><g class="topology-evidence-routes"></g><g class="topology-usage-routes"></g></svg><div class="topology-stations"></div><div class="topology-hud"></div><div class="topology-density" aria-label="Unique linked source records in the selected window"></div><div class="map-quiet topology-quiet" role="status"></div></div></div>';
  this.frame=layer.querySelector('.topology-frame');this.world=layer.querySelector('.map-world');this.svg=layer.querySelector('.map-routes');this.nodes=layer.querySelector('.topology-stations');this.regions=layer.querySelector('.topology-regions');this.hud=layer.querySelector('.topology-hud');this.density=layer.querySelector('.topology-density');this.quiet=layer.querySelector('.map-quiet');
  this.routeLayer=this.svg.querySelector('.topology-evidence-routes');this.tokenLayer=this.svg.querySelector('.topology-usage-routes');
  // Geometry is observed independently of the paint loop. Reading layout after
  // timeline writes would otherwise force a document layout on every frame.
  if(typeof globalThis.ResizeObserver==='function'){
   this.resizeObserver=new ResizeObserver(entries=>{for(const entry of entries)if(entry.target===layer){const {width,height}=entry.contentRect;this.measuredViewport={width,height};}});this.resizeObserver.observe(layer);
  }
  layer.addEventListener('scroll',()=>{this.scrollX=layer.scrollLeft;this.scrollY=layer.scrollTop;this.overlayInvalid=true;this.onViewChange();},{passive:true});
  layer.addEventListener('click',e=>{if(e.target.closest('[data-map-token-usage]')){this.selectTokenUsage();return;}const history=e.target.closest('[data-map-history]');if(history){this.setHistory(!this.showHistory);return;}const n=e.target.closest('[data-map-node]'),r=e.target.closest('[data-map-journey]'),m=e.target.closest('[data-map-edge]');if(n)this.selectNode(n.dataset.mapNode);else if(r)this.selectJourney(r.dataset.mapJourney,this.traceGroups.get(r.dataset.mapJourney));else if(m)this.selectEdge(m.dataset.mapEdge);});
  layer.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.closest('[data-map-token-usage]')){e.preventDefault();this.selectTokenUsage();return;}const target=e.target.closest('[data-map-journey],[data-map-edge]');if((e.key==='Enter'||e.key===' ')&&target&&target.tagName.toLowerCase()!=='button'){e.preventDefault();if(target.dataset.mapJourney)this.selectJourney(target.dataset.mapJourney,this.traceGroups.get(target.dataset.mapJourney));else this.selectEdge(target.dataset.mapEdge);}if(e.key==='Escape'){this.selection=null;this.onEvent('');if(this.graph)this.update(this.graph,{...this.options,selectedEvent:''});}});
 }
 setTokenStorage(storage){this.tokenMotion.setStorage(storage);}
 setTokenUsage(payload,options={}){this.tokenMotion.feed(payload,options);this.renderTokenUsage();}
 setZoom(value,anchor){
  this.zoomFactor=value==='fit'?1:value==='actual'?clampZoom(1/(this.baseScale||1)):clampZoom(value);this.zoomMode=value==='actual'?'actual':this.zoomFactor===1?'fit':'custom';
  if(this.layout)this.applyZoom(anchor,value==='fit');
 }
 applyZoom(anchor,reset=false){
  const before=this.viewGeometry,width=this.viewportWidth,height=this.viewportHeight;
  if(this.zoomMode==='actual')this.zoomFactor=clampZoom(1/(this.baseScale||1));
  const after=zoomGeometry({width,height,worldWidth:this.layout.width,worldHeight:this.layout.height,baseScale:this.baseScale,zoom:this.zoomFactor});
  // Routine source updates must not flush the preceding timeline writes.
  if(!anchor&&!reset&&before&&['scale','width','height','worldWidth','worldHeight','x','y'].every(k=>before[k]===after[k]))return;
  const scroll=reset?{x:0,y:0}:anchoredScroll(before,after,anchor||{x:width/2,y:height/2},{x:this.scrollX,y:this.scrollY});
  this.viewGeometry=after;this.scale=after.scale;this.frame.style.width=after.extentWidth+'px';this.frame.style.height=after.extentHeight+'px';
  this.world.style.left=after.x+'px';this.world.style.top=after.y+'px';this.world.style.transform=`scale(${after.scale})`;this.world.style.setProperty('--map-scale',after.scale);this.world.dataset.overview=String(after.scale<.85);
  this.layer.scrollLeft=this.scrollX=scroll.x;this.layer.scrollTop=this.scrollY=scroll.y;this.overlayInvalid=true;
  Object.assign(this.layer.dataset,{scale:String(after.scale),zoom:this.zoomMode,zoomFactor:String(this.zoomFactor)});this.onViewChange();
 }
 setHistory(shown){this.showHistory=Boolean(shown);if(this.graph)this.update(this.graph,this.options);}
 setView(active){if(this.activeView!==active){this.overlayInvalid=true;this.activeView=active;}this.layer.hidden=!active;this.canvas.classList.toggle('map-canvas',active);}
 ensureLayout(viewport){
  if(!this.graph)return;
  // The layer's observed content box can be smaller than the Canvas when it has
  // scrollbars. Keep that exact SVG layout extent; Canvas dimensions only seed
  // the observer's initial measurement or the compatibility fallback.
  if(viewport&&Number.isFinite(viewport.width)&&Number.isFinite(viewport.height)&&(!this.resizeObserver||!this.measuredViewport?.width||!this.measuredViewport?.height)&&
   (viewport.width!==this.measuredViewport?.width||viewport.height!==this.measuredViewport?.height))this.measuredViewport={width:viewport.width,height:viewport.height};
  // Old browsers without ResizeObserver keep a bounded compatibility fallback.
  if(!this.resizeObserver&&!viewport)this.measuredViewport={width:this.layer.clientWidth,height:this.layer.clientHeight};
  const measured=this.measuredViewport;if(measured&&(measured.width!==this.viewportWidth||measured.height!==this.viewportHeight))this.update(this.graph,this.options);
 }
 prepareUpdate(graph,options={}){
  const selected=graph.journeys.find(j=>j.eventIds.includes(options.selectedEvent)),selection=selected?selected.id:options.selectedEvent===''?null:this.selection,reference=options.reference??Date.now(),prefs=options.preferences||{},measured=this.measuredViewport;
  const viewportWidth=measured?.width??this.layer.clientWidth,viewportHeight=measured?.height??this.layer.clientHeight,fontSize=Number.isFinite(prefs.fontSize)?prefs.fontSize:parseFloat(getComputedStyle(this.layer).fontSize)||16;
  const projection={width:Math.max(720,viewportWidth),height:Math.max(420,viewportHeight),fontSize:fontSize,reference,windowMs:options.windowMs,selectedJourney:selection,selectedEvent:options.selectedEvent,maxWorkers:options.maxWorkers??prefs.planeWorkers??6,maxPerWorker:prefs.planeChannels??3,grouping:prefs.planeGrouping,showHosts:prefs.planeHosts,showTools:prefs.planeTools,showBranches:prefs.planeBranches,density:prefs.planeDensity,labels:prefs.planeLabels,colors:prefs.planeColors};
  const {layout,scale}=projectTopologyFit(graph,projection,{width:viewportWidth,height:viewportHeight,mode:'fit'}),workers=layout.nodes.filter(a=>!a.hidden&&(a.node.type==='worker'||a.node.type==='subagent')).map(a=>a.node),views=workerRecordViews(graph,workers),activities=new Map(workers.map(n=>[n.id,workerActivity(n,views.get(n.id),{...options,reference})]));
  return {graph,options,previousSelection:this.selection,selection,reference,measured,viewportWidth,viewportHeight,fontSize,layout,scale,activities};
 }
 update(graph,options={},prepared){
  if(!prepared||prepared.graph!==graph||prepared.options!==options||prepared.previousSelection!==this.selection||prepared.measured!==this.measuredViewport||!this.measuredViewport&&(prepared.viewportWidth!==this.layer.clientWidth||prepared.viewportHeight!==this.layer.clientHeight))prepared=this.prepareUpdate(graph,options);
  this.tokenMotion.setMode(options.mode);this.graph=graph;this.options=options;this.selection=prepared.selection;
  const {reference,layout,scale,activities}=prepared,prefs=options.preferences||{};
  this.tokenPalette=options.tokenPalette||getTokenPalette(prefs.tokenPalette,prefs.theme);
  this.viewportWidth=prepared.viewportWidth;this.viewportHeight=prepared.viewportHeight;this.fontSize=prepared.fontSize;this.layoutVersion++;this.activeLegCache=null;
  this.baseScale=scale;this.world.dataset.presentation='compact';
  this.layout=layout;this.world.style.width=layout.width+'px';this.world.style.height=layout.height+'px';this.world.style.minHeight=layout.height+'px';this.world.dataset.labels=layout.labels;this.applyZoom();
  this.svg.setAttribute('viewBox',`0 0 ${layout.width} ${layout.height}`);this.svg.style.width=layout.width+'px';this.svg.style.height=layout.height+'px';this.curves.clear();this.traceGroups.clear();this.animatedLegs=[];
  const selectedJourney=graph.journeys.find(j=>j.id===this.selection),selectedNodes=new Set(selectedJourney?.legs.flatMap(l=>[l.from,l.to])||[]),nodeMap=new Map(graph.nodes.map(n=>[n.id,n]));
  this.replaceHTML(this.regions,`<span class="topology-region sources">SOURCE MACHINES</span><span class="topology-region workers">WORKERS / SUBAGENTS</span><span class="topology-region endpoints">INTERFACES / TARGETS</span>${layout.groups.map(g=>`<div class="topology-group" style="left:${g.x}px;top:${g.y}px;width:${g.width}px;height:${g.height}px"><span>${escape(g.label)}</span></div>`).join('')}`,'regionsHTML');
  this.routeStates=new Map(layout.routes.map(route=>{
   // routeObservation falls back to related records only when leg clocks are
   // absent, but otherwise still eagerly constructs that fallback array. A
   // timestamped route can omit the unused array without changing its result.
   const timed=route.legs.some(item=>Number.isFinite(typeof (item.leg||item).at==='number'?(item.leg||item).at:Date.parse((item.leg||item).at)));
   return [route.id,routeObservation(timed?{...route,related:[],records:[]}:route,{...options,reference})];
  }));
  const recentRoutes=layout.routes.filter(route=>!route.hidden&&this.routeStates.get(route.id).state==='recent').length,retainedRoutes=layout.routes.filter(route=>!route.hidden&&this.routeStates.get(route.id).state==='retained').length;
  this.world.dataset.history=this.showHistory?'shown':recentRoutes===0?'quiet':'muted';
  const keepRoutes=new Set(),routeOccurrences=new Map(),focusedRoute=this.svg.contains(document.activeElement)?document.activeElement:null;let previousRoute=null;
  for(const route of layout.routes){
   if(route.hidden)continue;const observation=this.routeStates.get(route.id),recentCount=route.windowRecordCount??new Set(route.legs.filter(item=>item.leg.at>=reference-(options.windowMs||60000)&&item.leg.at<=reference).map(item=>item.leg.eventId)).size,color=safeColor(route.color),dimmed=selectedJourney&&!route.selected&&!route.metadata?' dimmed':'',historic=observation.state==='retained'?' historical':'';
   if(!route.metadata){this.traceGroups.set(route.journey.id,{journeys:route.related,total:route.channelJourneyCount});for(const item of route.legs){const last=item.journey.lastEvent||item.journey.records.at(-1),failed=item.journey.status==='failed'||last?.outcome==='failed'||last?.outcome==='interrupted'||last?.kind==='error';this.animatedLegs.push({...item,curve:route.curve,color:failed?safeColor(prefs.planeColors?.error||'#ff5a75'):color});this.curves.set(item.leg.edgeId,route.curve);}}
   const a=topologyPoint(route.curve,.79),b=topologyPoint(route.curve,.76),angle=Math.atan2(a[1]-b[1],a[0]-b[0])*180/Math.PI;
   const label=observation.label+' / '+(route.metadata?direction[route.kind]+', metadata only':`${direction[route.kind]} ${stationIdentity(nodeMap.get(route.from)).label} to ${stationIdentity(nodeMap.get(route.to)).label}; ${route.recordCount} source records, ${route.channelJourneyCount??route.related.length} source groups;${route.hiddenJourneyCount||route.hiddenLegCount?' bounded route samples;':''} ${route.journey.label}; ${route.journey.status}${observation.state==='retained'?'; retained before current window':''}`);
   const identity=JSON.stringify([route.id,!!route.metadata]),occurrence=routeOccurrences.get(identity)||0,rowKey=identity+':'+occurrence;routeOccurrences.set(identity,occurrence+1);keepRoutes.add(rowKey);
   const element=this.patchRoute(rowKey,route,{observation,recentCount,color,dimmed,historic,label,a,angle});
   if(element.parentNode!==this.routeLayer||element.previousElementSibling!==previousRoute)this.routeLayer.insertBefore(element,previousRoute?previousRoute.nextSibling:this.routeLayer.firstChild);previousRoute=element;
  }
  for(const [id,row] of this.routeNodes)if(!keepRoutes.has(id)){row.element.remove();this.routeNodes.delete(id);}
  if(focusedRoute&&this.svg.contains(focusedRoute)&&document.activeElement!==focusedRoute)focusedRoute.focus({preventScroll:true});
  this.animatedLegs.sort((a,b)=>b.leg.at-a.leg.at);this.animatedLegs=this.animatedLegs.slice(0,512);this.renderTokenUsage();
  const visibleActors=layout.nodes.filter(a=>!a.hidden);
  const focusedStation=this.nodes.contains(document.activeElement)?document.activeElement:null,keepStations=new Set();let previousStation=null;
  for(const actor of visibleActors){
   const n=actor.node,identity=stationIdentity(n),worker=n.type==='worker'||n.type==='subagent',activity=worker?activities.get(n.id):null,state=worker?{kind:activity.kind,label:activity.label,detail:activity.detail}:topologyObservationState(n,options),records=layout.nodeRecordCounts?layout.nodeRecordCounts.get(n.id)||0:new Set(layout.routes.filter(r=>!r.metadata&&(r.from===n.id||r.to===n.id)).flatMap(r=>r.eventIds)).size,color=safeColor(identity.color),host=nodeMap.get('host:'+n.hostId);
   const label=n.type==='host'?identity.label.replace(' / execution target',''):identity.label==='Codex · '+identity.shortId?identity.shortId.toUpperCase():identity.label,detail=n.type==='worker'||n.type==='subagent'?(n.project||n.subtitle?.replace(/^Retained \/ /,'')||identity.roleLabel):n.type==='host'?n.subtitle:identity.roleLabel;
   const title=[label,identity.roleLabel,detail,activity?.taskLabel,activity?.action,state.label,state.detail,n.lastLabel||n.activityLabel,host?.label].filter(Boolean).join(' / ');
   let row=this.stationNodes.get(n.id);if(!row){const element=document.createElement('button');element.innerHTML='<span class="station-emblem"><i class="station-state" aria-hidden="true"></i></span><span class="station-label"><b></b><small></small><em></em></span>';const emblem=element.firstElementChild,copy=emblem.nextElementSibling;row={element,emblem,name:copy.children[0],detail:copy.children[1],status:copy.children[2]};this.stationNodes.set(n.id,row);}
   keepStations.add(n.id);const {element}=row,symbolHTML=stationSymbol(n,{size:n.type==='worker'?30:26});
   patchAttribute(element,'class',`topology-station ${n.type} state-${state.kind}${selectedNodes.has(n.id)?' selected':''}`);patchAttribute(element,'data-map-node',n.id);patchAttribute(element,'data-worker-state',activity?.kind||state.kind);patchAttribute(element,'style',`left:${actor.x}px;top:${actor.y}px;--identity:${color};--station-radius:${actor.radius}px`);patchAttribute(element,'aria-label',title);
   if(row.symbolHTML!==symbolHTML){const holder=document.createElement('span');holder.innerHTML=symbolHTML;const symbol=holder.firstElementChild;row.emblem.insertBefore(symbol,row.symbol||row.emblem.firstChild);row.symbol?.remove();row.symbol=symbol;row.symbolHTML=symbolHTML;}
   patchText(row.name,label);patchText(row.detail,detail);patchText(row.status,state.label+(n.type==='host'?'':' · '+age(worker?activity.actionAt:n.lastAt,reference)));
   if(records){if(!row.records){row.records=document.createElement('b');row.records.setAttribute('class','station-records');row.emblem.append(row.records);}patchAttribute(row.records,'title',records+' directed source records');patchText(row.records,records>99?'99+':records);}else if(row.records){row.records.remove();row.records=null;}
   if(n.type==='host'&&Number.isFinite(n.progress)){if(!row.progress){row.progress=document.createElement('span');row.progress.setAttribute('class','station-progress');row.progress.innerHTML='<i></i><span></span>';element.append(row.progress);}patchAttribute(row.progress,'title','Last reported job progress, '+age(worker?activity.actionAt:n.lastAt,reference));patchAttribute(row.progress.firstElementChild,'style',`width:${Math.max(0,Math.min(100,n.progress))}%`);patchText(row.progress.lastElementChild,n.progress+'% reported');}else if(row.progress){row.progress.remove();row.progress=null;}
   if(element.parentNode!==this.nodes||element.previousElementSibling!==previousStation)this.nodes.insertBefore(element,previousStation?previousStation.nextSibling:this.nodes.firstChild);previousStation=element;
  }
  for(const [id,row] of this.stationNodes)if(!keepStations.has(id)){row.element.remove();this.stationNodes.delete(id);}
  if(focusedStation&&this.nodes.contains(focusedStation)&&document.activeElement!==focusedStation)focusedStation.focus({preventScroll:true});
  const liveLabel=options.observationGap?'Feed unknown':options.mode==='replay'?'Replay':'Recent';
  this.replaceHTML(this.hud,`<span class="topology-live-key"><i></i><b>${recentRoutes}</b> ${liveLabel} routes</span><button class="topology-history-toggle" data-map-history="true" aria-pressed="${this.showHistory}" title="${this.showHistory?'Dim retained history':'Emphasize retained history'}"><span aria-hidden="true">┄</span> ${retainedRoutes} History</button>${graph.waiting?`<span class="attention"><b>${graph.waiting}</b> input</span>`:''}<span class="topology-capacity">${layout.workerCount} workers${layout.physicalContentSize?.width>this.viewportWidth||layout.physicalContentSize?.height>this.viewportHeight?' · scroll / expand':''}</span>`,'hudHTML');
  this.density.hidden=!layout.density;const max=Math.max(1,...layout.bins.map(b=>b.count));this.replaceHTML(this.density,`<span><b>${layout.uniqueWindowRecords}</b> linked records / window</span><div>${layout.bins.map(b=>`<i style="--height:${b.count/max};--bar:${safeColor([...b.colors.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0])}" title="${escape(time(b.start)+' / '+b.count+' unique records')}"></i>`).join('')}</div>`,'densityHTML');
  const state=options.observationGap?'FEED UNKNOWN':options.mode==='replay'?'SOURCE REPLAY':graph.quiet?'QUIET / RETAINED':'LIVE OBSERVATION';
  this.replaceHTML(this.quiet,`<span class="quiet-led ${!graph.quiet&&!options.observationGap?'active':''}"></span><b>${state}</b><span>${graph.quiet?'Last linked record '+escape(age(graph.lastEventAt,reference)):'New record → one traversal'}${layout.hiddenJourneys?' · +'+layout.hiddenJourneys+' operations in inspector':''}</span>`,'quietHTML');
  Object.assign(this.layer.dataset,{recentRoutes:String(recentRoutes),retainedRoutes:String(retainedRoutes),showHistory:String(this.showHistory),scale:String(this.scale),zoom:this.zoomMode,nodeCount:String(layout.nodes.filter(a=>!a.hidden).length),routeCount:String(layout.routes.filter(r=>!r.hidden&&!r.metadata).length),relationshipCount:String(layout.routes.filter(r=>!r.hidden&&r.metadata).length),quiet:String(graph.quiet),selection:this.selection||'',traceCount:String(layout.channelCount),hiddenJourneys:String(layout.hiddenJourneys),layout:'topology'});
  Object.assign(this.canvas.dataset,{markerCount:String(graph.recentEventCount),labelCount:String(layout.nodes.filter(a=>!a.hidden).length)});
  const overflow=document.getElementById('map-overflow');if(overflow){overflow.textContent=layout.hiddenWorkers?'+'+layout.hiddenWorkers:'';overflow.title=layout.hiddenWorkers+' more workers in the inspector';overflow.hidden=!layout.hiddenWorkers;}
  const strip=document.getElementById('journey-strip');if(strip)this.replaceHTML(strip,selectedJourney?`<button data-journey="${escape(selectedJourney.id)}" class="selected"><i style="background:${safeColor(selectedJourney.color)}"></i><span>${escape(selectedJourney.label)}</span><b>${escape(selectedJourney.status)}</b></button>`:'','journeyHTML');
 }
 // Exact route identities own stable SVG groups. Only presentation fields are
 // retained here; source records and animated-leg admission remain independent.
 patchRoute(key,route,{observation,recentCount,color,dimmed,historic,label,a,angle}){
  let row=this.routeNodes.get(key);
  if(!row){
   const holder=document.createElementNS('http://www.w3.org/2000/svg','svg');
   holder.innerHTML='<g><title></title><path class="topology-route-hit"/>'+(route.metadata?'':'<path class="topology-route-glow"/>')+'<path class="topology-route-line"/>'+(route.metadata?'':'<path class="topology-arrow" d="M-5,-3.5 L2,0 -5,3.5"/><g class="topology-route-count"><rect x="-10" y="-8" width="20" height="16" rx="8"/><text text-anchor="middle" y="3.5"></text></g>')+'</g>';
   const element=holder.firstElementChild;row={element,title:element.firstElementChild,hit:element.querySelector('.topology-route-hit'),glow:element.querySelector('.topology-route-glow'),line:element.querySelector('.topology-route-line'),arrow:element.querySelector('.topology-arrow'),count:element.querySelector('.topology-route-count')};row.countText=row.count?.lastElementChild;
   this.routeNodes.set(key,row);
  }
  const element=row.element,curve=path(route.curve);
  patchAttribute(element,'class',`topology-route ${route.kind} state-${observation.state}${historic}${dimmed}${route.selected?' selected':''}`);patchAttribute(element,'style',`--route:${color};--route-weight:${Math.min(3.5,1.4+Math.log1p(recentCount)*.4)}px`);patchAttribute(element,'data-route-state',observation.state);patchAttribute(element,'data-recent-count',recentCount);patchAttribute(element,'data-map-route',route.id);patchAttribute(element,route.metadata?'data-map-edge':'data-map-journey',route.metadata?route.id:route.journey.id);patchAttribute(element,'role','button');patchAttribute(element,'tabindex','0');patchAttribute(element,'aria-label',label);patchText(row.title,label);
  patchAttribute(row.hit,'d',curve);patchAttribute(row.line,'d',curve);if(row.glow)patchAttribute(row.glow,'d',curve);
  if(row.arrow){patchAttribute(row.arrow,'transform',`translate(${a.join(',')}) rotate(${angle})`);patchAttribute(row.count,'transform',`translate(${route.labelPoint.join(',')})`);patchText(row.countText,observation.state==='retained'?'H':recentCount>99?'99+':recentCount||'·');}
  return element;
 }
 renderTokenUsage(){
  if(!this.layout)return;const replay=this.options?.mode==='replay';this.tokenChannels=projectTokenChannels(this.layout,replay?[]:this.tokenMotion.rows);const {anchor,channels,mapped,unmapped}=this.tokenChannels;this.tokenChannelLookup=new Map(channels.map(channel=>[channel.workerId,channel]));
  let html='';if(anchor){const title='Observed model usage: '+this.tokenPalette.description+'. Cached input is included in total input. Batched counter observations, not money, credits or network transfers.';
   html=`<g class="topology-token-channels" aria-label="Observed model-usage channels">${channels.map(channel=>this.tokenPalette.legend.map(series=>`<path class="topology-token-channel ${series.kind}" data-token-kind="${series.kind}" style="stroke:${series.color};stroke-dasharray:${series.dash||'none'};stroke-width:${series.kind==='cached'?'2.1':'1.1'};stroke-linecap:round;opacity:1" d="${path(series.kind==='output'?channel.output:channel.input)}"><title>${escape(series.glyph+' / '+series.colorName+' · '+series.pattern+' · '+(series.kind==='output'?'Codex → '+channel.row.hostId+' / '+channel.row.sessionId:channel.row.hostId+' / '+channel.row.sessionId+' → Codex')+': observed '+series.label.toLowerCase()+' counters')}</title></path>`).join('')).join('')}<g class="topology-token-anchor" data-map-token-usage="true" role="button" tabindex="0" transform="translate(${anchor.x},${anchor.y})" aria-label="${escape(title)}"><title>${escape(title)}</title><circle r="17"/><path d="M-7,-9 H7 L12,0 7,9 H-7 L-12,0Z M-5,-3 -8,0 -5,3 M5,-3 8,0 5,3 M2,-5 -2,5"/><text text-anchor="middle" y="32">MODEL USAGE</text><text class="topology-token-anchor-note" text-anchor="middle" y="44">counter batches · ${mapped} worker${mapped===1?'':'s'}</text></g></g>`;
  }
  this.replaceHTML(this.tokenLayer,html,'tokenHTML');Object.assign(this.layer.dataset,{tokenMappedWorkers:String(mapped),tokenUnmappedBatches:String(unmapped),tokenCursor:String(this.tokenMotion.cursor)});
 }
 selectTokenUsage(){
  const burn=this.tokenMotion.burn||{},format=value=>Number.isSafeInteger(value)&&value>=0?new Intl.NumberFormat().format(value):'Unavailable',loaded=this.tokenMotion.rows.filter(row=>['delta','partial'].includes(row.status)),rows=loaded.slice(-24).reverse();
  const legend=`<p class="burn-legend">${this.tokenPalette.legend.map(series=>`<span class="${series.className}"><i class="token-line token-${series.kind}" aria-hidden="true"></i> ${series.glyph} · ${series.colorName} · ${series.label.toLowerCase()}</span>`).join('')}</p>`;
  const fields=`<dl class="map-station-details">${this.tokenPalette.legend.map(series=>`<dt class="${series.className}">${series.label} / ${series.glyph}</dt><dd>${format(burn[series.field])} tokens / observed window</dd>`).join('')}<dt>Mapped</dt><dd>${this.tokenChannels.mapped} visible workers · ${this.tokenChannels.unmapped} unmapped observation batches</dd></dl>`;
  this.onDetails('Observed model usage','Durable counter changes · observed batches',fields+legend+'<p class="note">New input shows input minus cached input; C shows the cached subset. O shows output. Each marker is a weighted sample of a newly committed usage batch, not money or credits; at most 48 markers are painted. Travel takes about 3 seconds for readability and does not measure request duration, token streaming or network speed. Only an explicitly reported OpenAI/Codex provider and a visible matching worker create a channel. Command, GitHub and server routes are separate evidence. Live usage markers are hidden in source replay.</p>'+ (rows.length?`<p class="note">Showing the latest ${rows.length} of ${loaded.length} loaded delta observations. ${loaded.length>rows.length?`${loaded.length-rows.length} earlier loaded observations are omitted. `:''}The loaded response and this inspector are bounded samples, not the complete database ledger. This map inspector has no pagination; database retention is independent of this table. Interval is the source-counter sampling interval in milliseconds, not the marker travel time.</p><table><caption>Latest 24 or fewer retained usage observations in this scope</caption><thead><tr><th>Source time</th><th>Worker</th><th>Interval (ms)</th><th>I · New input</th><th>O · Output</th><th>C · Cached</th></tr></thead><tbody>`+rows.map(row=>`<tr><td>${escape(row.sourceAt)}</td><td>${escape(row.hostId+' / '+row.sessionId.slice(0,8))}</td><td>${format(row.intervalMs)}</td><td class="burn-input">${format(row.uncachedInputTokens)}</td><td class="burn-output">${format(row.outputTokens)}</td><td class="burn-cache">${format(row.cachedInputTokens)}</td></tr>`).join('')+'</tbody></table>':'<p>No attributable token changes in the retained usage window.</p>'));
 }
 replaceHTML(target,html,key){if(html===this[key])return;const active=document.activeElement,id=active?.dataset?.mapTokenUsage||active?.dataset?.mapRoute||active?.dataset?.mapNode||active?.dataset?.mapJourney||active?.dataset?.mapEdge||active?.dataset?.journey,attr=active?.dataset?.mapTokenUsage?'data-map-token-usage':active?.dataset?.mapRoute?'data-map-route':active?.dataset?.mapNode?'data-map-node':active?.dataset?.mapJourney?'data-map-journey':active?.dataset?.mapEdge?'data-map-edge':'data-journey',inside=target.contains(active);this[key]=html;target.innerHTML=html;if(inside&&id)target.querySelector(`[${attr}="${CSS.escape(id)}"]`)?.focus?.({preventScroll:true});}
 selectNode(id){
  const n=this.graph.nodes.find(n=>n.id===id);if(!n)return;
  const js=this.graph.journeys.filter(j=>j.legs.some(l=>l.from===id||l.to===id)),state=topologyObservationState(n,this.options),activity=workerActivity(n,this.graph,this.options),worker=n.type==='worker'||n.type==='subagent';
  const lastLabel=worker?activity.action:n.lastLabel||n.activityLabel||'No linked record',lastAt=worker?activity.actionAt:n.lastAt,latestId=worker?activity.eventId:n.eventIds?.[0];
  const fields=`<dl class="map-station-details"><dt>Station</dt><dd>${escape(n.type)}</dd>${activity.taskLabel?`<dt>Task / chat title</dt><dd>${escape(activity.taskLabel)}</dd><dt>Title source</dt><dd>${escape(activity.taskLabelSource)} · ${escape(activity.taskLabelUpdatedAt||'time unavailable')}</dd>`:''}${worker?`<dt>Observed action</dt><dd>${escape(activity.action)} · ${escape(activity.label)}</dd>`:''}<dt>Host</dt><dd>${escape(n.hostId||'Interface group')}</dd><dt>Evidence</dt><dd>${escape(worker?activity.detail:state.detail)}</dd><dt>Last record</dt><dd>${escape(lastLabel)} · ${escape(age(lastAt,this.options.reference))}</dd>${n.model?`<dt>Model</dt><dd>${escape(n.model)}</dd>`:''}${n.parentId?`<dt>Parent</dt><dd>${escape(n.parentId)}</dd>`:''}</dl>`;
  this.onDetails(stationIdentity(n).label,`${n.subtitle||n.type} · ${worker?activity.label:state.label}`,fields+(latestId?`<button data-map-event="${escape(latestId)}">Locate latest record on timeline ↗</button>`:'')+this.details(js,n));
 }
 selectEdge(id){const edge=this.graph.edges.find(e=>e.id===id);if(!edge)return;this.onDetails(edge.label||direction[edge.kind],'Metadata relationship',`<p>${edge.kind==='hosting'?'This Codex session was recorded by this machine’s collector.':'This subagent has an explicit parent session in the source metadata.'}</p><p class="note">This connection does not establish a message, network transfer or current running state.</p>`);}
 selectJourney(id,group){const related=group?.journeys||group,total=group?.total??related?.length;const j=this.graph.journeys.find(j=>j.id===id);if(!j)return;this.selection=id;this.update(this.graph,{...this.options,selectedEvent:j.lastEvent.id});this.onEvent(j.lastEvent.id);this.onDetails(j.label,total>1?total+' captured operation groups':j.status,(total>1?'<p class="note">This channel groups distinct operations with the same worker, endpoint and category. Each keeps its own status, call identity and source timestamps. Arrows show captured directions; crossings are not network junctions.</p>':'')+(total>related?.length?'<p class="note">'+related.length+' route samples shown from '+total+' captured groups. All retained source evidence remains available from the worker inspector and timeline.</p>':'')+this.details(related||[j]));}
 details(journeys,node){const labels=new Map(this.graph.nodes.map(n=>[n.id,stationIdentity(n).label]));return (node?`<p>${escape(node.detail||'Status is based on the last captured record or collector heartbeat. No task controls are exposed.')}</p>`:'')+(journeys.slice(0,100).map(j=>`<article class="journey-detail"><h3>${escape(j.label)}</h3><div class="journey-status" style="color:${safeColor(j.color)}">${escape(j.status)}${Number.isFinite(j.progress)?' · '+j.progress+'% reported':''}${Number.isFinite(j.durationMs)?' · '+(j.durationMs/1000).toFixed(2)+'s recorded':''}</div><p class="note">${escape(j.evidence)}</p><ol class="journey-steps">${(j.kind==='job'&&j.legs.length>2?[j.legs[0],j.legs.at(-1)]:j.legs.slice(-40)).map(l=>`<li><time>${escape(time(l.at))}</time><b>${escape(labels.get(l.from))} ${l.direction==='return'?'↩':'→'} ${escape(labels.get(l.to))}</b><span>${escape(l.direction)} · ${escape(l.eventId.slice(-12))}</span></li>`).join('')}</ol>${j.kind==='job'&&j.records.length>2?`<details class="job-progress-records"><summary>${j.records.length-2} progress reports · expand source evidence</summary>${j.records.slice(1,-1).map(e=>`<div><time>${escape(time(Date.parse(e.at)))}</time> ${escape(e.label)} · ${Number.isFinite(e.progress)&&e.progress>=0&&e.progress<=100?escape(e.progress):'—'}%</div>`).join('')}</details>`:''}<button data-map-event="${escape(j.lastEvent.id)}">Locate on timeline ↗</button><small>${j.legs.length>40?j.legs.length+' recorded legs; latest 40 shown. ':''}${escape(j.lastEvent.hostId)} / ${escape(j.lastEvent.sessionId)} / ${escape(j.lastEvent.callId||j.lastEvent.requestId||j.lastEvent.id)}</small></article>`).join('')||'<p>No linked operations in retained scope.</p>')+(journeys.length>100?'<p>Latest 100 journeys shown. Narrow the scope for more detail.</p>':'');}
 activeLegs(reference,{mode,freshIds,arrivalTimes}){
  const cache=this.activeLegCache;
  if(cache&&cache.version===this.layoutVersion&&cache.mode===mode&&cache.freshIds===freshIds&&cache.arrivalTimes===arrivalTimes)return cache.items;
  const items=(this.animatedLegs||[]).filter(item=>{
   const at=mode==='replay'?item.leg.at:freshIds instanceof Set&&arrivalTimes instanceof Map&&freshIds.has(item.leg.eventId)?arrivalTimes.get(item.leg.eventId):null;
   return Number.isFinite(at)&&reference-at>=0&&reference-at<2400;
  });this.activeLegCache={version:this.layoutVersion,mode,freshIds,arrivalTimes,items};return items;
 }
 needsAnimation(reference,options={}){
  if(!this.graph)return false;
  const {mode,reduced,paused}=options,flags={mode,reduced,paused:paused||this.options.observationGap};
  return this.overlayInvalid||this.overlayVisible||this.tokenMotion.hasPending(reference,flags)||!reduced&&!paused&&(mode==='replay'||!this.options.observationGap)&&this.activeLegs(reference,options).some(item=>topologyLegProgress(item,reference,options)!==null);
 }
 draw(ctx,reference,{mode,freshIds,arrivalTimes,reduced,paused,vivid,viewport}={}){
  if(!this.graph)return false;this.ensureLayout(viewport);
  const motion={mode,freshIds,arrivalTimes,reduced,paused},tokenFlags={mode,reduced,paused:paused||this.options.observationGap};
  const candidates=!reduced&&!paused&&(mode==='replay'||!this.options.observationGap)?this.activeLegs(reference,motion):[];
  const active=candidates.some(item=>topologyLegProgress(item,reference,motion)!==null),tokensPending=this.tokenMotion.hasPending(reference,tokenFlags);
  const width=viewport?.width??this.viewportWidth,height=viewport?.height??this.viewportHeight;
  const dpr=viewport?.dpr??1,viewportChanged=width!==this.overlayWidth||height!==this.overlayHeight||dpr!==this.overlayDpr;
  // The SVG evidence stays visible. Only the transparent moving overlay sleeps;
  // its final frame is cleared once, never repainted continuously while idle.
  if(!active&&!tokensPending&&!this.overlayVisible&&!this.overlayInvalid&&!viewportChanged){this.canvas.dataset.packetCount='0';this.canvas.dataset.tokenPacketCount='0';return false;}
  ctx.clearRect(0,0,width,height);this.overlayInvalid=false;this.overlayWidth=width;this.overlayHeight=height;this.overlayDpr=dpr;let packets=0;
  const offsetX=(this.resizeObserver?this.scrollX:this.layer.scrollLeft)-(this.viewGeometry?.x||0),offsetY=(this.resizeObserver?this.scrollY:this.layer.scrollTop)-(this.viewGeometry?.y||0),scale=this.scale||1;
  for(const item of candidates){
   const t=topologyLegProgress(item,reference,motion);if(t===null)continue;const p=topologyPoint(item.curve,t),x=p[0]*scale-offsetX,y=p[1]*scale-offsetY;if(x<0||x>width||y<0||y>height)continue;const color=item.color,sprite=vivid&&typeof ctx.drawImage==='function'?trailSprite(color):null;
   ctx.save();ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=2;
   for(let i=9;i>=1;i--){const q=topologyPoint(item.curve,Math.max(0,t-i*.016)),radius=Math.max(.8,4-i*.32),qx=q[0]*scale-offsetX,qy=q[1]*scale-offsetY;ctx.globalAlpha=(1-i/10)*.6;
    if(sprite){const size=18+radius*4;ctx.drawImage(sprite,qx-size/2,qy-size/2,size,size);}else{ctx.beginPath();ctx.arc(qx,qy,radius,0,Math.PI*2);ctx.fill();}
   }
   ctx.globalAlpha=1;if(sprite)ctx.drawImage(sprite,x-16,y-16,32,32);ctx.translate(x,y);ctx.beginPath();if(item.journey.kind==='job'){ctx.roundRect(-4,-4,8,8,1);ctx.fill();}else if(item.journey.kind==='review'){ctx.moveTo(0,-5);ctx.lineTo(5,4);ctx.lineTo(-5,4);ctx.closePath();ctx.fill();}else if(item.leg.direction==='return'){ctx.arc(0,0,4,0,Math.PI*2);ctx.fill();}else{ctx.moveTo(0,-5);ctx.lineTo(5,0);ctx.lineTo(0,5);ctx.lineTo(-5,0);ctx.closePath();ctx.fill();}ctx.restore();packets++;if(packets>=64)break;
  }
  let tokenPackets=0;this.tokenMotion.visitFrame(reference,tokenFlags,(packet,progress)=>{
   const channel=this.tokenChannelLookup.get(packet.workerId);if(!channel)return;const p=topologyPoint(packet.kind==='output'?channel.output:channel.input,progress),x=p[0]*scale-offsetX,y=p[1]*scale-offsetY;if(x<0||x>width||y<0||y>height)return;drawTokenCoin(ctx,x,y,packet.kind,progress,{vivid,palette:this.tokenPalette});tokenPackets++;
  });
  this.overlayVisible=packets+tokenPackets>0;
  Object.assign(this.canvas.dataset,{packetCount:String(packets),tokenPacketCount:String(tokenPackets),markerCount:String(this.graph.recentEventCount),labelCount:String(this.layout.nodes.filter(n=>!n.hidden).length),paintReference:String(reference)});return true;
 }
}
