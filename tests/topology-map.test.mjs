// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {projectActivity} from '../public/activity-map-model.mjs';

const topology=await import('../public/topology-map.mjs').catch(()=>({}));
const now=Date.parse('2026-10-20T16:00:00Z');
const hosts=[
 {id:'source-a',name:'Laptop A',role:'codex-source',status:'online',deviceClass:'laptop'},
 {id:'source-b',name:'Workstation B',role:'codex-source',status:'online',deviceClass:'workstation'},
 {id:'target',name:'Execution target',role:'execution-target',status:'online',deviceClass:'raspberry-pi'}
];
const sessions=[{id:'parent',hostId:'source-a',project:'Alpha'},
 {id:'child',hostId:'source-a',project:'Alpha',parentId:'parent',nickname:'Volta'},
 {id:'other',hostId:'source-b',project:'Beta'}];
const event=(id,kind,offset,extra={})=>({id,kind,at:new Date(now+offset).toISOString(),hostId:'source-a',sourceId:'native',sessionId:'parent',turnId:'turn',category:'command',label:'exec',callId:id,...extra});
const project=(events,extra={})=>projectActivity({hosts,sessions,events,reference:now,...extra});
const layout=(graph,extra={})=>{
 assert.equal(typeof topology.projectTopology,'function','Topology projection is implemented');
 return topology.projectTopology(graph,{reference:now,width:900,height:460,...extra});
};
const workerNodes=result=>result.nodes.filter(n=>['worker','subagent'].includes(n.role));

test('bounded deterministic actor geometry cache skips collision solving while rebinding current source nodes and routes',()=>{
 const graph=project([event('cache-call','tool.start',-1000,{callId:'geometry'})]),options={width:937,height:487,grouping:'host'},original=Math.hypot;let solves=0;Math.hypot=(...args)=>{solves++;return original(...args);};
 try{const first=layout(graph,options),firstSolves=solves;assert.ok(firstSolves>0);const current=structuredClone(graph);for(const node of current.nodes){node.taskLabel='CURRENT TEST_ONLY task';node.lastLabel='CURRENT TEST_ONLY action';}current.journeys[0].status='failed';current.journeys[0].lastEvent.outcome='failed';const beforeSecond=solves,second=layout(current,options),secondSolves=solves-beforeSecond;
  assert.deepEqual(second.nodes.map(({node,...actor})=>actor),first.nodes.map(({node,...actor})=>actor));assert.ok(secondSolves<firstSolves,'Repeated projection avoids retained actor collision search');for(const actor of second.nodes){assert.equal(actor.node,current.nodes.find(node=>node.id===actor.node.id));assert.equal(actor.node.taskLabel,'CURRENT TEST_ONLY task');}assert.ok(second.routes.some(route=>route.color==='#ff5a75'||route.color===current.journeys[0].color));
  second.nodes[0].bounds.x=-99999;assert.notEqual(layout(current,options).nodes[0].bounds.x,-99999);
  const changed=layout(current,{...options,width:938});assert.notDeepEqual(changed.nodes.map(actor=>[actor.x,actor.y]),second.nodes.map(actor=>[actor.x,actor.y]));
  for(let i=0;i<17;i++)layout(current,{...options,width:1001+i});const beforeEvicted=solves;assert.deepEqual(layout(graph,options).nodes.map(({node,...actor})=>actor),first.nodes.map(({node,...actor})=>actor));assert.ok(solves-beforeEvicted>=firstSolves,'Old geometry is evicted after the fixed cache budget');
 }finally{Math.hypot=original;}
});

test('one shared interface station receives real fan-out from distinct two-dimensional worker clusters',()=>{
 const graph=project([
  event('a','tool.start',-1000),
  event('b','tool.start',-1100,{sessionId:'child'}),
  event('c','tool.start',-1200,{sessionId:'other',hostId:'source-b'})
 ]),result=layout(graph);
 assert.equal(result.nodes.filter(n=>n.node.id==='service:command').length,1);
 assert.equal(result.routes.filter(r=>r.kind==='outbound'&&r.to==='service:command').length,3);
 assert.equal(new Set(workerNodes(result).map(n=>n.x)).size>1,true);
 assert.equal(new Set(workerNodes(result).map(n=>n.y)).size>1,true);
});

test('observed call and result retain separate directions, record identities, and curved return geometry',()=>{
 const graph=project([event('call','tool.start',-2000,{callId:'paired'}),event('result','tool.end',-1000,{callId:'paired'})]),result=layout(graph);
 const outbound=result.routes.find(r=>r.kind==='outbound'),returning=result.routes.find(r=>r.kind==='return');
 assert.equal(outbound.from,returning.to);assert.equal(outbound.to,returning.from);
 assert.deepEqual(outbound.eventIds,['call']);assert.deepEqual(returning.eventIds,['result']);
 assert.equal(outbound.legs[0].journey,graph.journeys[0]);assert.equal(outbound.legs[0].leg,graph.journeys[0].legs[0]);
 assert.notDeepEqual(topology.topologyPoint(outbound.curve,.5),topology.topologyPoint(returning.curve,.5));
 for(const route of [outbound,returning]){
  const [a,b,c,d]=route.curve,baseline=[(a[0]+d[0])/2,(a[1]+d[1])/2],middle=topology.topologyPoint(route.curve,.5);
  assert.ok(Math.hypot(middle[0]-baseline[0],middle[1]-baseline[1])>15,'Routes visibly arc rather than drawing horizontal row guides');
  assert.ok(Math.abs(b[1]-a[1])+Math.abs(c[1]-d[1])>30,'Control points bend in the vertical axis');
 }
});

test('result-only evidence creates a returning route without manufacturing an outbound call',()=>{
 const result=layout(project([event('orphan','tool.end',-1000)]));
 assert.equal(result.routes.filter(r=>r.kind==='outbound').length,0);
 assert.deepEqual(result.routes.filter(r=>r.kind==='return').map(r=>r.eventIds),[['orphan']]);
});

test('execution telemetry travels only from the explicitly bound target to its worker',()=>{
 const graph=project([event('job','remote.progress',-1000,{hostId:'target',sessionId:'job',workerHostId:'source-a',workerSessionId:'parent',category:'remote',jobId:'job',progress:40})]),result=layout(graph);
 const reports=result.routes.filter(r=>r.kind==='report');
 assert.equal(reports.length,1);assert.equal(reports[0].from,'host:target');assert.equal(reports[0].to,'worker:source-a/parent');
 assert.deepEqual(reports[0].eventIds,['job']);assert.equal(result.routes.filter(r=>['outbound','return'].includes(r.kind)).length,0);
 assert.equal(result.nodes.find(n=>n.node.id==='host:target').role,'host');
});

test('explicit subagents sit near their actual parent and genealogy has no animated event legs',()=>{
 const result=layout(project([event('parent','tool.start',-1000),event('child','tool.start',-1200,{sessionId:'child'})]));
 const parent=result.nodes.find(n=>n.node.id==='worker:source-a/parent'),child=result.nodes.find(n=>n.node.id==='worker:source-a/child');
 assert.ok(Math.hypot(parent.x-child.x,parent.y-child.y)<190);
 const relation=result.routes.find(r=>r.kind==='parent');
 assert.equal(relation.from,parent.node.id);assert.equal(relation.to,child.node.id);assert.deepEqual(relation.legs,[]);assert.deepEqual(relation.eventIds,[]);
 assert.ok(result.routes.filter(r=>r.kind==='hosting').every(r=>r.legs.length===0&&r.eventIds.length===0));
});

test('reversing source arrays leaves actor positions, route identities, and curves unchanged without mutating evidence',()=>{
 const graph=project([event('a','tool.start',-1000),event('b','tool.end',-500,{callId:'a'}),event('c','tool.start',-1200,{sessionId:'other',hostId:'source-b'})]);
 const before=JSON.stringify(graph),a=layout(graph),b=layout({...graph,nodes:[...graph.nodes].reverse(),edges:[...graph.edges].reverse(),journeys:[...graph.journeys].reverse()});
 assert.equal(JSON.stringify(graph),before);
 assert.deepEqual(a.nodes.map(n=>[n.node.id,n.x,n.y]),b.nodes.map(n=>[n.node.id,n.x,n.y]));
 assert.deepEqual(a.routes.map(r=>[r.id,r.from,r.to,r.curve]),b.routes.map(r=>[r.id,r.from,r.to,r.curve]));
});

test('repeated operations share a truthful channel while separate endpoints and categories remain distinct',()=>{
 const events=Array.from({length:50},(_,i)=>event('repeat-'+i,'tool.end',-1000-i,{callId:'repeat-'+i}));
 events.push(event('files','tool.start',-500,{category:'edit',label:'apply_patch'}));
 const graph=project(events),result=layout(graph),returns=result.routes.filter(r=>r.kind==='return');
 assert.equal(returns.length,1);assert.equal(returns[0].related.length,50);assert.equal(returns[0].recordCount,50);
 assert.equal(new Set(returns[0].eventIds).size,50);assert.equal(returns[0].legs.length,50);
 assert.equal(result.routes.filter(r=>r.kind==='outbound'&&r.category==='edit').length,1);
});

test('tool and operation records share the same visual channel without losing source legs or selected membership',()=>{
 const graph=project([
  event('start','tool.start',-4000,{callId:'paired'}),event('end','tool.end',-3000,{callId:'paired'}),
  event('operation','operation',-1000,{startedAt:new Date(now-2000).toISOString(),completedAt:new Date(now-1000).toISOString()})
 ]),selected=graph.journeys.find(j=>j.kind==='tool'),result=layout(graph,{maxPerWorker:1,selectedJourney:selected.id});
 assert.equal(result.channelCount,1);assert.equal(result.hiddenJourneys,0);
 assert.equal(result.routes.filter(r=>r.kind==='outbound').length,1);assert.equal(result.routes.filter(r=>r.kind==='return').length,1);
 assert.deepEqual(new Set(result.routes.find(r=>r.kind==='outbound').eventIds),new Set(['start','operation']));
 assert.deepEqual(new Set(result.routes.find(r=>r.kind==='return').eventIds),new Set(['end','operation']));
 assert.ok(result.routes.filter(r=>!r.metadata).every(r=>r.related.length===2&&r.selected));
 assert.deepEqual(new Set(result.routes.find(r=>r.kind==='return').related.map(j=>j.kind)),new Set(['tool','operation']));
});

test('channel limits preserve a selected source operation and count unshown operations',()=>{
 const graph=project([
  event('command','tool.start',-1000),
  event('files','tool.start',-2000,{category:'edit',label:'apply_patch'}),
  event('research','tool.start',-3000,{category:'research',label:'search'}),
  event('github','tool.start',-4000,{category:'tool',label:'mcp__codex_apps__github__read'})
 ]),selected=graph.journeys.find(j=>j.eventIds.includes('github'));
 const result=layout(graph,{maxPerWorker:1,selectedJourney:selected.id});
 assert.equal(result.routes.filter(r=>r.legs.length).length,1);assert.equal(result.routes.find(r=>r.legs.length).related[0].id,selected.id);
 assert.equal(result.hiddenJourneys,3);
});

test('quiet retained routes remain visible and historical without adding synthetic legs',()=>{
 const graph=project([event('old','tool.end',-300000)]),result=layout(graph);
 const route=result.routes.find(r=>r.legs.length);
 assert.equal(route.historical,true);assert.equal(route.legs.length,1);assert.equal(route.legs[0].leg.at,now-300000);
 assert.equal(result.uniqueWindowRecords,0);assert.equal(workerNodes(result).length,1);
});

test('presentation switches hide actor glyphs or metadata while preserving exact source routes',()=>{
 const graph=project([event('one','tool.start',-1000),event('two','tool.start',-1200,{sessionId:'child'})]);
 const normal=layout(graph),hidden=layout(graph,{showHosts:false,showTools:false,showBranches:false,density:false});
 assert.deepEqual(hidden.routes.filter(r=>r.legs.length).map(r=>[r.from,r.to,r.eventIds]),normal.routes.filter(r=>r.legs.length).map(r=>[r.from,r.to,r.eventIds]));
 assert.ok(hidden.nodes.filter(n=>['host','service'].includes(n.role)).every(n=>n.hidden));
 assert.ok(hidden.routes.filter(r=>['hosting','parent'].includes(r.kind)).every(r=>r.hidden));
 assert.equal(hidden.density,false);
});

test('unique window records are deduplicated by source identity and future legs are not generated',()=>{
 const result=layout(project([event('old','tool.start',-90000,{callId:'pair'}),event('recent','tool.end',-1000,{callId:'pair'}),event('future','tool.start',1000)]));
 assert.equal(result.uniqueWindowRecords,1);
 assert.ok(!result.routes.flatMap(r=>r.eventIds).includes('future'));
 assert.equal(result.routes.find(r=>r.kind==='outbound').historical,true);
 assert.equal(result.routes.find(r=>r.kind==='return').historical,false);
});

function crowdedGraph(){
 const sourceHosts=Array.from({length:6},(_,i)=>({id:'host:'+i,type:'host',column:0,label:'Host '+i,hostId:String(i),icon:'laptop',status:'online',eventIds:[],color:'#32cfff'}));
 const workers=Array.from({length:8},(_,i)=>({id:'worker:'+i+'/s'+i,type:i%3===1?'subagent':'worker',hostId:String(i%6),sessionId:'s'+i,parentId:i%3===1?'s'+(i-1):null,project:i%2?'Alpha':'Beta',label:'Worker '+i,icon:'codex',lastAt:now-i,eventIds:[],color:'#bc9bff'}));
 // Only this pair has matching same-host metadata; other parent-looking fields do not invent edges.
 workers[1].hostId='0';workers[1].id='worker:0/s1';
 const services=Array.from({length:4},(_,i)=>({id:'service:'+i,type:'service',label:'Service '+i,icon:'service',eventIds:[],color:'#20cfff'}));
 const human={id:'person:reviewer',type:'human',label:'Human review',icon:'human',eventIds:[],color:'#ffd955'};
 const journeys=workers.flatMap((worker,i)=>[0,1].map(n=>{const endpoint=services[(i+n)%4],id='journey:'+i+':'+n,record=event(id,'tool.start',-i*100-n,{sessionId:worker.sessionId,hostId:worker.hostId});return {id,kind:'tool',from:worker.id,to:endpoint.id,category:n?'research':'command',color:'#20cfff',latestAt:now-i*100-n,eventIds:[id],records:[record],legs:[{from:worker.id,to:endpoint.id,at:now-i*100-n,eventId:id,direction:'outbound'}]};}));
 journeys.push({id:'review',kind:'review',from:workers[0].id,to:human.id,category:'approval',color:'#ffd955',latestAt:now-10,eventIds:['review'],records:[event('review','approval',-10)],legs:[{from:workers[0].id,to:human.id,at:now-10,eventId:'review',direction:'outbound'}]});
 const edges=[...workers.map(worker=>({id:'hosting:'+worker.id,from:'host:'+worker.hostId,to:worker.id,kind:'hosting',eventIds:[]})),{id:'parent:one',from:workers[0].id,to:workers[1].id,kind:'parent',eventIds:[]}];
 return {nodes:[...sourceHosts,...workers,...services,human],journeys,edges,hiddenWorkers:0};
}

test('bounded crowded layouts keep all selected actor disks apart inside desktop and narrow map bounds',()=>{
 for(const width of [420,667,900,1280]){
  const result=layout(crowdedGraph(),{width,height:460,maxWorkers:8,maxPerWorker:3});
  assert.equal(workerNodes(result).length,8);assert.ok(result.width>=420);assert.ok(result.height>=420&&result.height<=560);
  for(const actor of result.nodes){assert.ok(actor.x>=32&&actor.x<=result.width-32,actor.node.id+' x bounded');assert.ok(actor.y>=32&&actor.y<=result.height-32,actor.node.id+' y bounded');}
  for(let i=0;i<result.nodes.length;i++)for(let j=i+1;j<result.nodes.length;j++){
   const a=result.nodes[i],b=result.nodes[j];assert.ok(Math.hypot(a.x-b.x,a.y-b.y)>=a.radius+b.radius+10,`${width}: ${a.node.id} and ${b.node.id} do not collide`);
  }
 }
});

test('crowded logical worlds reserve non-overlapping actor and below-label footprints plus bounds for overview fit',()=>{
 for(const width of [420,667,900,1280]){
  const result=layout(crowdedGraph(),{width,height:420,maxWorkers:8});
  assert.ok(result.width>=720);assert.equal(result.height,560);assert.deepEqual(result.viewBounds,{x:0,y:0,width:result.width,height:result.height});
  const bounds=result.nodes.map(n=>{
   assert.deepEqual(n.labelBounds,{x:n.x-64,y:n.y+n.radius+3,width:128,height:44});
   assert.ok(n.y>=85&&n.bounds.x>=0&&n.bounds.y>=48&&n.bounds.x+n.bounds.width<=result.width&&n.bounds.y+n.bounds.height<=result.height-75);
   return {id:n.node.id,...n.bounds};
  });
  for(let i=0;i<bounds.length;i++)for(let j=i+1;j<bounds.length;j++){
   const a=bounds[i],b=bounds[j],overlap=a.x<b.x+b.width+6&&a.x+a.width+6>b.x&&a.y<b.y+b.height+6&&a.y+a.height+6>b.y;
   assert.equal(overlap,false,`${width}: ${a.id} and ${b.id} labels do not overlap`);
  }
  const parent=result.nodes.find(n=>n.node.id==='worker:0/s0'),child=result.nodes.find(n=>n.node.id==='worker:0/s1');
  assert.ok(Math.hypot(parent.x-child.x,parent.y-child.y)<190,'Dense explicit family remains in neighboring slots');
 }
});

test('group labels use explicit host and project metadata and custom colors reject non-hex payloads',()=>{
 const graph=project([event('a','tool.start',-1000),event('b','tool.start',-1200,{hostId:'source-b',sessionId:'other'})]);
 assert.deepEqual(layout(graph,{grouping:'project'}).groups.map(g=>g.label).sort(),['Alpha','Beta']);
 assert.deepEqual(layout(graph,{grouping:'host'}).groups.map(g=>g.label).sort(),['Laptop A','Workstation B']);
 const custom=layout(graph,{colors:{command:'#ff1234',error:'url(bad)'}});
 assert.ok(custom.routes.filter(r=>r.category==='command').every(r=>r.color==='#ff1234'));
});

test('failed returning results retain a failure color instead of implying a successful green return',()=>{
 const graph=project([event('failure','tool.end',-1000,{outcome:'failed'})]);
 const result=layout(graph,{colors:{error:'#ff2345'}}),returning=result.routes.find(r=>r.kind==='return');
 assert.equal(returning.color,'#ff2345');assert.equal(returning.failedCount,1);
 assert.equal(returning.related[0].lastEvent.outcome,'failed');
});

test('cubic points retain directed endpoints and clamp animation progress to the recorded route',()=>{
 assert.equal(typeof topology.topologyCurve,'function');assert.equal(typeof topology.topologyPoint,'function');
 const a={x:100,y:100,radius:22},b={x:600,y:300,radius:20},curve=topology.topologyCurve(a,b,{kind:'outbound',side:1,index:0});
 assert.equal(curve.length,4);assert.deepEqual(topology.topologyPoint(curve,-1),curve[0]);assert.deepEqual(topology.topologyPoint(curve,2),curve[3]);
 assert.ok(topology.topologyPoint(curve,.5).every(Number.isFinite));
});

test('a wide overview keeps worker clusters at three spatial depths rather than collapsing them onto two rails',()=>{
 const result=layout(crowdedGraph(),{width:1900,height:560,maxWorkers:8});
 assert.ok(new Set(workerNodes(result).map(actor=>Math.round(actor.y))).size>=3);
});

test('worker cards reserve their physical footprint at native and fitted scales while retaining emblem route anchors',()=>{
 for(const maxWorkers of [6,8])for(const width of [720,1280])for(const presentationScale of [1,.66]){
  const graph=crowdedGraph(),result=layout(graph,{width,height:420,maxWorkers,workerCardWidth:216,workerCardHeight:88,stationWidth:136,stationHeight:82,presentationScale});
  assert.equal(workerNodes(result).length,maxWorkers);
  for(const actor of workerNodes(result)){
   assert.equal(typeof actor.cardBounds,'object','Readable worker card footprint is projected');
   assert.ok(Math.abs(actor.cardBounds.width*presentationScale-216)<.001);
   assert.ok(Math.abs(actor.cardBounds.height*presentationScale-88)<.001);
   assert.ok(Math.abs(actor.radius*presentationScale-22)<.001);
   assert.deepEqual(actor.bounds,actor.cardBounds);
   assert.equal(actor.cardBounds.x,actor.x-actor.radius);assert.equal(actor.cardBounds.y,actor.y-44/presentationScale);
  }
  for(let i=0;i<result.nodes.length;i++)for(let j=i+1;j<result.nodes.length;j++){
   const a=result.nodes[i].bounds,b=result.nodes[j].bounds;
   const overlap=a.x<b.x+b.width+6&&a.x+a.width+6>b.x&&a.y<b.y+b.height+6&&a.y+a.height+6>b.y;
   assert.equal(overlap,false,`${maxWorkers}/${width}/${presentationScale}: complete actor/card footprints do not overlap`);
  }
  assert.ok(new Set(workerNodes(result).map(actor=>Math.round(actor.x))).size>=2);
  assert.ok(new Set(workerNodes(result).map(actor=>Math.round(actor.y))).size>=3);
  for(const actor of result.nodes){assert.ok(actor.bounds.x>=0&&actor.bounds.y>=32/presentationScale);assert.ok(actor.bounds.x+actor.bounds.width<=result.width&&actor.bounds.y+actor.bounds.height<=result.height-24/presentationScale+.001);}
  const route=result.routes.find(r=>r.kind==='outbound'),from=result.nodes.find(actor=>actor.node.id===route.from);
  assert.ok(Math.abs(Math.hypot(route.curve[0][0]-from.x,route.curve[0][1]-from.y)-from.radius)<.001);
  assert.deepEqual(result.viewBounds,{x:0,y:0,width:result.width,height:result.height});
 }
});

test('compact stations reserve readable physical labels and icons beside physical worker cards',()=>{
 const presentationScale=.66,result=layout(crowdedGraph(),{width:1280,height:420,maxWorkers:6,workerCardWidth:216,workerCardHeight:88,stationWidth:136,stationHeight:82,presentationScale});
 for(const actor of result.nodes.filter(n=>!['worker','subagent'].includes(n.role))){
  assert.ok(Math.abs(actor.bounds.width*presentationScale-136)<.001);assert.ok(Math.abs(actor.bounds.height*presentationScale-82)<.001);
  assert.ok(Math.abs(actor.radius*presentationScale-18)<.001);assert.deepEqual(actor.bounds,actor.stationBounds);
 }
 assert.ok(Math.max(...workerNodes(result).map(n=>n.y*presentationScale))<=300,'Six worker cards retain readable physical centers in three depths');
 assert.ok(result.height*presentationScale<=370,'Fixed physical card content fits the expanded observation plane height');
 const parent=result.nodes.find(n=>n.node.id==='worker:0/s0'),child=result.nodes.find(n=>n.node.id==='worker:0/s1');
 assert.ok(Math.hypot(parent.x-child.x,parent.y-child.y)*presentationScale<150,'Actual parent and child cards remain nearby');
});

test('card geometry remains deterministic and does not replace captured actions with synthetic activity',()=>{
 const graph=crowdedGraph(),before=JSON.stringify(graph),options={width:720,height:420,maxWorkers:8,workerCardWidth:220,workerCardHeight:88,presentationScale:.66};
 const a=layout(graph,options),b=layout({...graph,nodes:[...graph.nodes].reverse(),edges:[...graph.edges].reverse(),journeys:[...graph.journeys].reverse()},options);
 assert.equal(JSON.stringify(graph),before);
 assert.deepEqual(a.nodes.map(n=>[n.node.id,n.x,n.y,n.bounds]),b.nodes.map(n=>[n.node.id,n.x,n.y,n.bounds]));
 assert.deepEqual(a.routes.map(r=>[r.id,r.eventIds,r.curve]),b.routes.map(r=>[r.id,r.eventIds,r.curve]));
 assert.ok(a.routes.filter(r=>r.metadata).every(r=>r.legs.length===0));
});

test('physical content remains stable across a two-pass scale change instead of chasing a smaller fit',()=>{
 const graph=crowdedGraph(),options={width:720,height:420,maxWorkers:6,workerCardWidth:216,workerCardHeight:88,stationWidth:136,stationHeight:82};
 const a=layout(graph,{...options,presentationScale:1}),b=layout(graph,{...options,presentationScale:.66});
 assert.deepEqual(a.physicalContentSize,b.physicalContentSize);assert.equal(b.presentationScale,.66);assert.equal(b.readableCards,true);
 for(let i=0;i<a.nodes.length;i++){
  const first=a.nodes[i],second=b.nodes[i];assert.equal(first.node.id,second.node.id);
  for(const key of ['x','y','radius'])assert.ok(Math.abs(first[key]-second[key]*.66)<.001);
  for(const key of ['width','height'])assert.ok(Math.abs(first.bounds[key]-second.bounds[key]*.66)<.001);
 }
});


test('large same-channel projections bound route members while preserving selected paired legs and exact totals',()=>{
 const events=Array.from({length:10000},(_,i)=>event('bulk-'+i,'operation',-10000+i,{startedAt:new Date(now-11000+i).toISOString(),completedAt:new Date(now-10000+i).toISOString()}));
 const graph=project(events),selected=graph.journeys.find(j=>j.id==='operation:bulk-0'),before=JSON.stringify(graph);
 const result=layout(graph,{selectedJourney:selected.id,selectedEvent:'bulk-0'});
 assert.equal(result.hiddenJourneys,10000-128);assert.equal(result.uniqueWindowRecords,10000);
 for(const route of result.routes.filter(r=>!r.metadata)){
  assert.ok(route.related.length<=128);assert.ok(route.legs.length<=256);assert.ok(route.related.includes(selected));
  assert.equal(route.channelJourneyCount,10000);assert.equal(route.recordCount,10000);assert.equal(route.windowRecordCount,10000);
  assert.equal(route.hiddenJourneyCount,10000-route.related.length);assert.equal(route.hiddenRecordCount,10000-route.eventIds.length);
  assert.ok(route.eventIds.includes('bulk-0'));assert.ok(route.legs.some(item=>item.journey===selected&&item.leg.eventId==='bulk-0'));
 }
 assert.equal(graph.journeys.length,10000);assert.equal(JSON.stringify(graph),before);
});

test('a long remote report history keeps selected and boundary source legs while bounding projected legs',()=>{
 const events=Array.from({length:10000},(_,i)=>event('report-'+i,'remote.progress',-10000+i,{hostId:'target',sessionId:'job',workerHostId:'source-a',workerSessionId:'parent',category:'remote',jobId:'same-job',progress:i%101}));
 const graph=project(events),journey=graph.journeys[0],result=layout(graph,{selectedJourney:journey.id,selectedEvent:'report-250'}),route=result.routes.find(r=>r.kind==='report');
 assert.equal(journey.records.length,10000);assert.equal(journey.legs.length,10000);
 assert.ok(route.legs.length<=256);assert.ok(route.eventIds.includes('report-0'));assert.ok(route.eventIds.includes('report-9999'));assert.ok(route.eventIds.includes('report-250'));
 assert.equal(route.recordCount,10000);assert.equal(route.channelRecordCount,10000);assert.equal(route.windowRecordCount,10000);
 assert.equal(route.hiddenLegCount,10000-route.legs.length);assert.equal(route.hiddenRecordCount,10000-route.eventIds.length);
});


test('channel sampling preserves older captured directions when newest members contain only returns',()=>{
 const events=Array.from({length:1000},(_,i)=>event('return-'+i,'tool.end',-1000+i,{callId:'return-'+i}));
 events.push(event('old-call','tool.start',-5000,{callId:'old-call'}));
 const result=layout(project(events)),outbound=result.routes.find(r=>r.kind==='outbound');
 assert.ok(outbound.journey);assert.equal(outbound.journey.eventIds[0],'old-call');assert.deepEqual(outbound.eventIds,['old-call']);
 assert.equal(result.routes.find(r=>r.kind==='return').recordCount,1000);assert.equal(result.uniqueWindowRecords,1001);
});

// The former view's two fresh calls remain a reference for the Fit helper.
const freshFit=(graph,options,{width=900,height=460,mode='fit'}={})=>{
 let result=topology.projectTopology(graph,options),scale=mode==='fit'?Math.min(1,Math.max(1,width)/result.width,Math.max(1,height)/result.height):1;
 if(mode==='fit'&&scale<1){result=topology.projectTopology(graph,{...options,width:Math.max(720,width/scale),height:result.height});scale=Math.min(1,Math.max(1,width)/result.width,Math.max(1,height)/result.height);}
 return {layout:result,scale};
};

test('Fit preparation matches two fresh projections across geometry scope clocks selection and presentation options',()=>{
 assert.equal(typeof topology.projectTopologyFit,'function');
 for(let i=0;i<48;i++){
  const records=Array.from({length:90},(_,j)=>event('fit-'+j,j%3?'tool.end':'operation',-180000+j*2100,{sessionId:j%2?'parent':'child',category:['command','edit','research'][j%3],label:'TEST_ONLY '+j,startedAt:new Date(now-181000+j*2100).toISOString(),completedAt:new Date(now-180000+j*2100).toISOString()}));
  if(i%2)records.reverse();records.push({...records[0],project:'Outside selected project',label:'Later duplicate outside scope'});
  const graph=project(records,{reference:now+(i%4===0?-60000:0),filter:i%3===0?{project:'Alpha'}:i%3===1?{category:'command'}:{}}),selected=graph.journeys.at(-1),options={width:[360,720,900,1280][i%4],height:[210,420,540][i%3],fontSize:12+i%9,reference:now+[0,-60000,180000][i%3],windowMs:i%2?15000:60000,maxWorkers:i%2?6:8,maxPerWorker:1+i%3,selectedJourney:selected?.id,selectedEvent:selected?.eventIds[0],grouping:['worker','host','project'][i%3],showHosts:i%3!==0,showTools:i%4!==0,showBranches:i%5!==0,density:i%2===0,labels:i%2?'compact':'detailed',colors:{command:'#abcdef',error:'#ff0000'}},viewport={width:[320,640,1400][i%3],height:[210,320,900][i%3],mode:i%7===0?'actual':'fit'};
  if(i%5===0)Object.assign(options,{workerCardWidth:216,workerCardHeight:88,stationWidth:136,stationHeight:82,presentationScale:.66});
  const before=JSON.stringify(graph),preferences=JSON.stringify(options);assert.deepEqual(topology.projectTopologyFit(graph,options,viewport),freshFit(graph,options,viewport));assert.equal(JSON.stringify(graph),before);assert.equal(JSON.stringify(options),preferences);
 }
});

test('each Fit invocation freshly observes mutable graph metadata source legs colors and backseek without mutating previous geometry',()=>{
 const graph=project([event('start','tool.start',-2000,{callId:'pair'}),event('end','tool.end',-1000,{callId:'pair'})]),options={width:720,height:420,reference:now,maxWorkers:6},viewport={width:420,height:210},first=topology.projectTopologyFit(graph,options,viewport),curve=structuredClone(first.layout.routes.find(route=>!route.metadata).curve);
 graph.nodes.find(node=>node.type==='worker').label='CURRENT changed metadata';graph.journeys[0].status='failed';graph.journeys[0].lastEvent.outcome='failed';graph.journeys[0].legs[0].at=now-300000;graph.journeys[0].records[0].at=new Date(now-300000).toISOString();
 const changed={...options,reference:now-1500,selectedJourney:graph.journeys[0].id,selectedEvent:'start',colors:{error:'#123456'},grouping:'host'};
 assert.deepEqual(topology.projectTopologyFit(graph,changed,viewport),freshFit(graph,changed,viewport));assert.deepEqual(first.layout.routes.find(route=>!route.metadata).curve,curve);
 const second=topology.projectTopologyFit(graph,changed,viewport);second.layout.routes.find(route=>!route.metadata).curve[0][0]=-99999;second.layout.bins[0].count=99999;
 assert.deepEqual(topology.projectTopologyFit(graph,changed,viewport),freshFit(graph,changed,viewport));assert.deepEqual(topology.projectTopology(graph,changed),layout(graph,changed));
});

test('one synchronous Fit scans density source records once while preserving complete selected retained channel counts',()=>{
 const records=Array.from({length:500},(_,i)=>event('retained-'+i,'operation',-200000+i,{startedAt:new Date(now-201000+i).toISOString(),completedAt:new Date(now-200000+i).toISOString()})),graph=project(records),selected=graph.journeys.at(-1),options={width:720,height:420,reference:now,windowMs:60000,selectedJourney:selected.id,selectedEvent:selected.eventIds[0]},viewport={width:420,height:210};
 let reads=0;for(const journey of graph.journeys)for(const record of journey.records){const value=record.at;Object.defineProperty(record,'at',{get(){reads++;return value;},configurable:true});}
 const result=topology.projectTopologyFit(graph,options,viewport);assert.equal(reads,500);const expected=freshFit(graph,options,viewport);assert.equal(reads,1500,'The reference performs its complete density pass in each geometry projection');assert.deepEqual(result,expected);
 assert.equal(result.layout.uniqueWindowRecords,0);for(const route of result.layout.routes.filter(route=>!route.metadata)){assert.equal(route.recordCount,500);assert.equal(route.channelJourneyCount,500);assert.ok(route.related.includes(selected));assert.ok(route.eventIds.includes(selected.eventIds[0]));assert.ok(route.legs.length<=256);}
});

test('Fit binds a default source clock once but standalone projections retain their fresh default clock',()=>{
 const graph=project([event('record','tool.end',-1000)]);delete graph.reference;const original=Date.now;let clock=now,calls=0;Date.now=()=>{calls++;return clock++;};
 try{
  const result=topology.projectTopologyFit(graph,{width:720,height:420},{width:420,height:210});assert.equal(calls,1);assert.equal(result.layout.reference,now);assert.deepEqual(result,freshFit(graph,{width:720,height:420,reference:now},{width:420,height:210}));
  assert.equal(topology.projectTopology(graph).reference,now+1);assert.equal(topology.projectTopology(graph).reference,now+2);assert.equal(calls,3);
 }finally{Date.now=original;}
});

test('Fit traverses the journey inventory three times independently of the visible worker count',()=>{
 for(const maxWorkers of [6,8]){
  const graph=crowdedGraph(),journeys=graph.journeys;let visits=0;
  Object.defineProperty(journeys,Symbol.iterator,{value:function*(){for(let i=0;i<this.length;i++){visits++;yield this[i];}}});
  const result=topology.projectTopologyFit(graph,{reference:now,width:720,height:420,maxWorkers},{width:420,height:210});
  assert.equal(workerNodes(result.layout).length,maxWorkers);
  assert.equal(visits,journeys.length*3,'Worker selection, channel indexing and density each make one complete pass, shared across Fit geometry');
 }
});

test('channel indexing preserves self endpoints both worker endpoints duplicate encounter order and tied channels',()=>{
 const graph=crowdedGraph(),workers=graph.nodes.filter(node=>node.type==='worker'||node.type==='subagent'),[a,b]=workers;
 const journey=(id,from,to,recordId=id)=>({id,kind:'tool',from,to,category:'command',latestAt:now-1000,records:[event(recordId,'tool.end',-1000)],eventIds:[recordId],legs:[{from,to,at:now-1000,eventId:recordId,direction:'return'}]});
 const self=journey('self',a.id,a.id),bridge=journey('bridge',a.id,b.id),earlier=journey('duplicate',a.id,'service:0','earlier'),later=journey('duplicate',a.id,'service:0','later');
 graph.journeys=[self,bridge,earlier,later];const before=JSON.stringify(graph);
 const result=layout(graph,{maxWorkers:8,maxPerWorker:3,selectedJourney:'duplicate',selectedEvent:'later'});
 assert.equal(result.uniqueWindowRecords,4);assert.equal(result.routes.find(route=>route.from===a.id&&route.to===a.id).channelJourneyCount,1);
 assert.equal(result.routes.find(route=>route.from===a.id&&route.to===b.id&&!route.metadata).recordCount,1);
 const duplicate=result.routes.find(route=>route.to==='service:0'&&!route.metadata);assert.deepEqual(duplicate.eventIds,['later']);assert.equal(duplicate.journey,later);assert.equal(duplicate.selected,true);
 assert.equal(JSON.stringify(graph),before);assert.deepEqual(graph.journeys,[self,bridge,earlier,later]);
 // Equal-time channel ties retain the original encounter order when the cap is one.
 const tied={...graph,journeys:[0,1].map(i=>({...self,id:'tied-head',to:'service:'+i,legs:[{...self.legs[0],to:'service:'+i}]}))};assert.ok(layout(tied,{maxWorkers:1,maxPerWorker:1}).routes.some(route=>route.to==='service:0'&&!route.metadata));
 tied.journeys.reverse();assert.ok(layout(tied,{maxWorkers:1,maxPerWorker:1}).routes.some(route=>route.to==='service:1'&&!route.metadata));
});

test('a later Fit rebuilds indexed endpoints and source state without changing earlier geometry',()=>{
 const graph=crowdedGraph(),[a,b]=graph.nodes.filter(node=>node.type==='worker'||node.type==='subagent'),record=event('moving','tool.end',-1000);
 const journey={id:'moving',kind:'tool',from:a.id,to:'service:0',category:'command',latestAt:now-1000,status:'result recorded',records:[record],eventIds:[record.id],legs:[{from:a.id,to:'service:0',at:now-1000,eventId:record.id,direction:'return'}]};graph.journeys=[journey];
 const options={reference:now,width:720,height:420,maxWorkers:8,selectedJourney:journey.id,selectedEvent:record.id},viewport={width:420,height:210};
 const first=topology.projectTopologyFit(graph,options,viewport),oldCurve=structuredClone(first.layout.routes.find(route=>!route.metadata).curve);
 journey.from=b.id;journey.to=a.id;journey.status='failed';journey.category='research';journey.legs[0]={...journey.legs[0],from:b.id,to:a.id};b.label='CURRENT endpoint';
 const second=topology.projectTopologyFit(graph,options,viewport),route=second.layout.routes.find(route=>!route.metadata);
 assert.equal(route.from,b.id);assert.equal(route.to,a.id);assert.equal(route.category,'research');assert.equal(route.journey,journey);assert.equal(second.layout.nodes.find(actor=>actor.node.id===b.id).node.label,'CURRENT endpoint');
 assert.deepEqual(first.layout.routes.find(route=>!route.metadata).curve,oldCurve);
 const backseek=topology.projectTopologyFit(graph,{...options,reference:now-2000},viewport);assert.equal(backseek.layout.routes.filter(route=>!route.metadata).length,0);assert.equal(backseek.layout.uniqueWindowRecords,0);
 record.at=new Date(now-300000).toISOString();journey.latestAt=now-300000;journey.legs[0].at=now-300000;
 const retained=topology.projectTopologyFit(graph,options,viewport).layout;assert.equal(retained.uniqueWindowRecords,0);assert.equal(retained.routes.find(route=>!route.metadata).historical,true);assert.equal(retained.routes.find(route=>!route.metadata).recordCount,1);
 const scoped={...graph,journeys:[],nodes:graph.nodes.filter(node=>node.id!==a.id)};assert.equal(topology.projectTopologyFit(scoped,options,viewport).layout.routes.filter(route=>!route.metadata).length,0);
});

test('density reuses retained source clocks while observing timestamp mutation replay bounds scope and parser changes',()=>{
 const record=event('density-clock','tool.end',-1000),graph=project([record]),source=graph.records[0],parse=Date.parse;let calls=0;
 Date.parse=function(value){if(value===source.at)calls++;assert.equal(this,Date);return parse.call(this,value);};
 try{
  assert.equal(layout(graph).uniqueWindowRecords,1);assert.equal(calls,1);calls=0;
  assert.equal(layout(graph).uniqueWindowRecords,1);assert.equal(calls,0);
  assert.equal(layout(graph,{reference:now-2000}).uniqueWindowRecords,0);
  assert.equal(layout(graph,{reference:now+60000}).uniqueWindowRecords,0);
  assert.equal(layout({...graph,journeys:[]}).uniqueWindowRecords,0);assert.equal(calls,0);
  source.at='invalid';assert.equal(layout(graph).uniqueWindowRecords,0);assert.equal(calls,1);calls=0;
  source.at=new Date(now+1).toISOString();assert.equal(layout(graph).uniqueWindowRecords,0);assert.equal(calls,1);calls=0;
  source.at=new Date(now-60000).toISOString();assert.equal(layout(graph).uniqueWindowRecords,1);assert.equal(calls,1);calls=0;
  assert.equal(layout(graph,{reference:now+1}).uniqueWindowRecords,0);assert.equal(calls,0);
  Date.parse=function(value){if(value===source.at)calls++;return parse.call(this,value)-1;};
  assert.equal(layout(graph).uniqueWindowRecords,0);assert.equal(calls,1);
  assert.equal(graph.records[0],source);assert.equal(graph.journeys[0].records[0],source);
 }finally{Date.parse=parse;}
});

test('density reads the parser before accessor clocks and keeps non-string Date.parse coercion',()=>{
 const graph=project([event('density-accessor','tool.end',-1000)]),record=graph.records[0],at=record.at,parseDescriptor=Object.getOwnPropertyDescriptor(Date,'parse'),parse=Date.parse,log=[];
 Object.defineProperty(record,'at',{get(){log.push('at');return at;},configurable:true});
 Object.defineProperty(Date,'parse',{configurable:true,get(){log.push('parse');return function(value){log.push('call');assert.equal(this,Date);return parse.call(this,value);};}});
 try{assert.equal(layout(graph).uniqueWindowRecords,1);assert.deepEqual(log,['parse','at','call']);log.length=0;assert.equal(layout(graph).uniqueWindowRecords,1);assert.deepEqual(log,['parse','at','call']);}
 finally{Object.defineProperty(Date,'parse',parseDescriptor);}
 let coercions=0;Object.defineProperty(record,'at',{value:{toString(){coercions++;return at;}},writable:true,configurable:true});
 assert.equal(layout(graph).uniqueWindowRecords,1);assert.equal(layout(graph).uniqueWindowRecords,1);assert.equal(coercions,2,'Coercible source values remain direct Date.parse inputs');
});
