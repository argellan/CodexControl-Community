// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {createServer} from './fixture-server.mjs';
import * as observerServer from '../server.mjs';
const ui=await import('../public/ui-model.mjs').catch(()=>({}));

test('ribbon category lookup cannot resolve inherited properties in the actual app color selector',async()=>{
 const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8'),palette=source.match(/^const palette=.*$/m)?.[0],selector=source.match(/^const color=.*$/m)?.[0];assert.ok(palette&&selector);
 const context=vm.createContext({presentationValue:ui.presentationValue});vm.runInContext(palette+'\n'+selector,context);
 for(const category of ['constructor','toString','__proto__','hasOwnProperty','unknown'])assert.equal(vm.runInContext('color('+JSON.stringify({category})+')',context),'#5cecff');
 assert.equal(vm.runInContext("color({category:'edit'})",context),'#ff9b18');assert.equal(vm.runInContext("color({category:'constructor',outcome:'failed'})",context),'#ff3b64');
 assert.equal(ui.presentationValue({tool:'#123456'},'constructor','#abcdef'),'#abcdef');
});

test('ribbon lane ordering remains stable for survivors and bounded under sustained identity churn',()=>{
 const lanes=new Map();ui.reconcileTrackLanes(lanes,[{id:'keep'},{id:'old'}]);
 for(let i=0;i<6000;i++){const tracks=[{id:'new-'+i},{id:'keep'}];ui.reconcileTrackLanes(lanes,tracks);assert.equal(lanes.size,2);assert.equal(lanes.get('keep'),0);assert.equal(lanes.get('new-'+i),1);}
 ui.reconcileTrackLanes(lanes,[]);assert.equal(lanes.size,0);ui.reconcileTrackLanes(lanes,[{id:'return'}]);assert.equal(lanes.get('return'),0);
});
const now=Date.parse('2026-10-19T16:00:00Z');
const event=(id,seconds,extra={})=>({id,at:new Date(now+seconds*1000).toISOString(),hostId:'H',sourceId:'S',sessionId:id,kind:'operation',category:'command',label:id,...extra});

test('local preview explicitly reports hub unavailability and preserves actual source identities',()=>{
 assert.equal(typeof observerServer.localPreviewSnapshot,'function');
 const source={observedAt:new Date(now).toISOString(),host:{id:'real',name:'Actual machine',cpu:12},sessions:[{id:'worker',hostId:'real'}],events:[event('actual',0)],coverage:{completeHistory:false}};
 const view=observerServer.localPreviewSnapshot(source,{name:'Example laptop',unavailableHub:'203.0.113.92'});
 assert.equal(view.hosts.length,1);assert.equal(view.hosts[0].id,'real');assert.equal(view.hosts[0].telemetry.cpu,12);assert.equal(view.coverage.fleetHubUnavailable,true);assert.equal(view.coverage.unavailableHub,'203.0.113.92');assert.deepEqual(view.events,source.events);
});

test('worker branches follow their latest child activity and ignore future replay records',()=>{
 assert.equal(typeof ui.workerGroups,'function');
 const sessions=[{id:'old',hostId:'H',project:'A'},{id:'parent',hostId:'H',project:'B'},{id:'child',hostId:'H',project:'B',parentId:'parent'},{id:'future',hostId:'H',project:'Z'}];
 const events=[event('old',-90),event('parent',-100),event('child',-1),event('future',60)];
 const groups=ui.workerGroups(sessions,events,[{id:'H',status:'online'}],now);
 assert.equal(groups[0].project,'B');assert.deepEqual(groups[0].rows.map(r=>[r.session.id,r.depth]),[['parent',0],['child',1]]);
 assert.equal(groups[0].rows[1].recent,true);assert.equal(groups.at(-1).project,'Z');
 assert.equal(ui.workerGroups(sessions,[...events,event('old',0)],[],now)[0].project,'A');
});
test('ranking keeps duplicate session IDs isolated by machine and terminates cyclic metadata',()=>{
 assert.equal(typeof ui.workerGroups,'function');
 const sessions=[{id:'same',hostId:'H',project:'A'},{id:'same',hostId:'B',project:'A'},{id:'cycle',hostId:'B',parentId:'cycle',project:'A'}];
 const groups=ui.workerGroups(sessions,[event('same',-5),event('same',-1,{hostId:'B'})],[],now);
 assert.equal(groups[0].hostId,'B');assert.equal(groups.flatMap(g=>g.rows).length,3);
});
test('display preferences clamp corrupt values and never admit CSS or arbitrary storage fields',()=>{
 assert.equal(typeof ui.normalizePreferences,'function');
 const p=ui.normalizePreferences({fontSize:100,theme:'injected',font:'url(secret)',leftWidth:1,rightWidth:2000,waterfallRatio:100,tickerMotion:false,secret:'NO'});
 assert.equal(p.fontSize,20);assert.equal(p.theme,'system');assert.equal(p.font,'system');assert.equal(p.leftWidth,200);assert.equal(p.rightWidth,460);assert.equal(p.waterfallRatio,88);assert.equal(p.secret,undefined);
 assert.equal(ui.normalizePreferences(null).fontSize,14);
});
test('attention prioritizes unresolved requests, scopes resolutions and excludes future evidence',()=>{
 assert.equal(typeof ui.attentionItems,'function');
 const request=event('R',-120,{kind:'approval',requestId:'Q',sessionId:'worker'}),error=event('E',-2,{kind:'error',outcome:'failed'});
 let items=ui.attentionItems([request,error,event('done',-1,{kind:'resolution',requestId:'Q',hostId:'other',sessionId:'worker'})],[{id:'lost',name:'Lost',status:'disconnected'}],now);
 assert.equal(items[0].id,'R');assert.ok(items.some(i=>i.hostId==='lost'));
 items=ui.attentionItems([request,error,event('done',1,{kind:'resolution',requestId:'Q',sessionId:'worker'})],[],now);assert.equal(items[0].id,'R');
 items=ui.attentionItems([request,error,event('done',0,{kind:'resolution',requestId:'Q',sessionId:'worker'})],[],now);assert.ok(!items.some(i=>i.id==='R'));
});
test('rate bins count only recorded events inside the selected source clock window',()=>{
 assert.equal(typeof ui.activityBins,'function');
 const bins=ui.activityBins([event('a',-30),event('b',-1),event('late',1),event('old',-70)],now,60000,12);
 assert.equal(bins.reduce((n,b)=>n+b.count,0),2);assert.equal(bins.length,12);
});
test('confirmed service restart failures raise attention without inventing job events',()=>{
 const hosts=[{id:'pi',name:'Pi hub',status:'online',receivedAt:new Date(now).toISOString(),telemetry:{services:[{unit:'example-edge.service',state:'activating',subState:'auto-restart'},{unit:'starting.service',state:'activating',subState:'start-pre'},{unit:'healthy.service',state:'active',subState:'running'}]}}];
 const items=ui.attentionItems([],hosts,now);assert.equal(items.length,1);assert.match(items[0].label,/example-edge.service/);assert.equal(items[0].kind,'service-alert');assert.equal(items[0].eventId,undefined);
 assert.equal(ui.attentionItems([],[{...hosts[0],status:'disconnected'}],now).filter(i=>i.kind==='service-alert').length,0);
});
test('clock labels contain an explicit local zone and UTC across a date boundary',()=>{
 assert.equal(typeof ui.clockLabels,'function');
 const c=ui.clockLabels(Date.parse('2026-10-20T00:00:00.123Z'),'America/New_York');
 assert.match(c.utc,/00:00:00\.123/);assert.match(c.local,/20:00:00\.123/);assert.match(c.zone,/EDT|GMT-4/);
});
test('only explicitly allowed brand/font assets are served; the viewer API remains read-only',async()=>{
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const root=`http://127.0.0.1:${server.address().port}`;
 try{
  for(const [file,type] of [['argellan-symbol.svg','image/svg+xml'],['fonts/JetBrainsMono-Regular.woff2','font/woff2']]){const r=await fetch(root+'/assets/'+file);assert.equal(r.status,200);assert.ok(r.headers.get('content-type').startsWith(type));}
  assert.equal((await fetch(root+'/assets/../.local/gateway.json')).status,404);
  assert.equal((await fetch(root+'/api/snapshot',{method:'POST'})).status,405);
 }finally{await new Promise(r=>server.close(r));}
});
test('waterfall tracks retain every real record once with host-qualified source identity',async()=>{
 const {waterfallTracks}=await import('../public/ui-model.mjs');
 const events=[{id:'a',hostId:'A',sessionId:'S',category:'command'},{id:'b',hostId:'A',sessionId:'S',category:'message'},{id:'c',hostId:'B',sessionId:'S',category:'command'}];
 const tracks=waterfallTracks(events,[{hostId:'A',id:'S',project:'Alpha'}]);
 assert.equal(tracks.length,3);assert.deepEqual(tracks.flatMap(t=>t.events.map(e=>e.id)),['a','b','c']);assert.equal(tracks[0].session.project,'Alpha');assert.notEqual(tracks[0].source,tracks[2].source);assert.deepEqual(waterfallTracks([],[]),[]);
});
test('continuous timeline geometry moves between polls without inventing operation duration',async()=>{
 const {timelinePosition}=await import('../public/ui-model.mjs'),span={start:1000,end:2000};
 const a=timelinePosition(span,3000,5000),b=timelinePosition(span,3016,5000);
 assert.ok(b.left<a.left);assert.ok(Math.abs(b.width-a.width)<1e-9);assert.ok(Math.abs((a.left-b.left)-.32)<1e-9);
 const open={...span,status:'open'};assert.deepEqual(timelinePosition(open,3016,5000),b);assert.equal(timelinePosition(span,8000,5000).visible,false);
});
test('indexed worker bars preserve exact host-scoped window counts without changing source events',()=>{
 const events=[event('shared',-60,{hostId:'A'}),event('shared',-59,{hostId:'A'}),event('shared',0,{hostId:'B'}),event('shared',1,{hostId:'A'}),event('shared',-61,{hostId:'A'}),event('local',-10,{hostId:null}),event('bad',0,{at:'not-a-date'})],before=JSON.stringify(events),series=ui.workerActivitySeries(events,now);
 assert.deepEqual([...series.keys()].sort(),['A/shared','B/shared','local/local']);
 for(const [id,values] of series){const matching=events.filter(e=>(e.hostId||'local')+'/'+e.sessionId===id);assert.deepEqual(values,ui.activityBins(matching,now,60000,16).map(bin=>bin.count));}
 assert.equal(series.get('A/shared').reduce((sum,n)=>sum+n,0),2);assert.equal(series.get('B/shared').at(-1),1);assert.equal(JSON.stringify(events),before);
});
test('bounded ticker selection matches stable full sorting, retains ties, and invalidates changed source timestamps',()=>{
 const events=[event('edge',-60),event('old',-61),event('tie-first',-2),event('excluded',-1),event('tie-second',-2),event('newest',0),event('future',1),event('bad',0,{at:'invalid'}),event('undated',0,{at:undefined})],excluded=new Set(['excluded']),before=JSON.stringify(events);
 const expected=events.filter(e=>Number.isFinite(Date.parse(e.at))&&Date.parse(e.at)>=now-60000&&Date.parse(e.at)<=now&&!excluded.has(e.id)).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)).slice(0,3);
 assert.deepEqual(ui.latestActivityEvents(events,now,60000,excluded,3),expected);assert.deepEqual(expected.map(e=>e.id),['newest','tie-first','tie-second']);assert.equal(JSON.stringify(events),before);
 events[2].at=new Date(now+2000).toISOString();assert.deepEqual(ui.latestActivityEvents(events,now,60000,excluded,3).map(e=>e.id),['newest','tie-second','edge']);
 const many=Array.from({length:1000},(_,i)=>event(String(i),-i/100));assert.equal(ui.latestActivityEvents(many,now,60000,new Set(),999).length,8);assert.equal(many.length,1000);
});
test('app source and span reuse invalidates on same-sized source revision and exact replay clock boundaries',async()=>{
 const {readFile}=await import('node:fs/promises'),{createContext,runInContext}=await import('node:vm'),{EventStore,buildSpans,eventTime}=await import('../public/event-model.mjs'),source=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),start=source.indexOf('let sourceEventCache='),end=source.indexOf('\nlet recoveryCursor=',start);
 assert.ok(start>0&&end>start);const store=new EventStore(),first=event('start',-2,{kind:'tool.start',sessionId:'shared',callId:'call',turnId:'turn'}),last=event('end',-1,{kind:'tool.end',sessionId:'shared',callId:'call',turnId:'turn'});
 store.events.set(first.id,first);store.renderRevision=1;const context=createContext({store,buildSpans,eventTime,eventKey:e=>(e.hostId||'local')+'/'+e.sessionId});runInContext(source.slice(start,end),context);
 const original=context.viewEventRecords(),evidence=context.renderEvidence(now);assert.equal(context.viewEventRecords(),original);assert.equal(context.renderEvidence(now+1000),evidence);
 store.events.delete(first.id);store.events.set(last.id,last);store.renderRevision++;assert.notEqual(context.viewEventRecords(),original);assert.equal(context.renderEvidence(now).events[0].id,'end');
 store.mode='replay';store.frozen=[first,last];const early=context.renderEvidence(now-1500);assert.equal(early.events.length,1);assert.equal(early.spans[0].status,'open');assert.equal(context.renderEvidence(now-1200),early);
 const complete=context.renderEvidence(now-1000);assert.equal(complete.events.length,2);assert.equal(complete.spans[0].durationMs,1000);assert.equal(complete.spans[0].status,'closed');assert.equal(context.renderEvidence(now-1500).events.length,1);assert.equal(store.frozen.length,2);
});
test('device icon/color uses explicit inventory class and never guesses from a hostname',async()=>{
 const {deviceVisual}=await import('../public/ui-model.mjs');
 assert.equal(deviceVisual({name:'raspberry-laptop-cloud'}).kind,'unknown');
 assert.equal(deviceVisual({deviceClass:'raspberry-pi'}).label,'Raspberry Pi');
 assert.notEqual(deviceVisual({deviceClass:'laptop'}).color,deviceVisual({deviceClass:'rack-server'}).color);
 assert.notEqual(deviceVisual({deviceClass:'edge'}).path,deviceVisual({deviceClass:'cloud'}).path);
 assert.equal(deviceVisual({deviceClass:'not-a-class'}).kind,'unknown');
});

// This fixture models the renderer's native child/text operations, moves and
// focus loss. The frozen R18 renderer below is a markup oracle, not an alternate
// production path. Actual grouping, filters, series and formatters are shared.
const workerEncode=value=>String(value).replace(/[&<>]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[char]));
const workerDecode=value=>value.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
class WorkerTextNode{
 constructor(value,document){this.value=value;this.ownerDocument=document;this.parentNode=null;this.mutations=0;}
 get nodeValue(){return this.value;}
 set nodeValue(value){this.value=String(value);this.mutations++;}
 get textContent(){return this.value;}
 get outerHTML(){return workerEncode(this.value);}
}
class WorkerElement{
 constructor(tag,document){this.tagName=tag.toUpperCase();this.ownerDocument=document;this.parentNode=null;this.childNodes=[];this.attributes={};this.dataset={};this.mutations=0;this.value='';}
 get children(){return this.childNodes.filter(node=>node instanceof WorkerElement);}
 get firstChild(){return this.childNodes[0]||null;}
 get firstElementChild(){return this.children[0]||null;}
 get lastElementChild(){return this.children.at(-1)||null;}
 get previousElementSibling(){const siblings=this.parentNode?.children||[];return siblings[siblings.indexOf(this)-1]||null;}
 get nextSibling(){const siblings=this.parentNode?.childNodes||[];return siblings[siblings.indexOf(this)+1]||null;}
 get isConnected(){return this.root===true||this.parentNode?.isConnected===true;}
 contains(other){for(let node=other;node;node=node.parentNode)if(node===this)return true;return false;}
 getAttribute(name){return Object.hasOwn(this.attributes,name)?this.attributes[name]:null;}
 setAttribute(name,value){value=String(value);this.attributes[name]=value;this.mutations++;if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,char)=>char.toUpperCase())]=value;}
 insertBefore(node,before){if(node===before)return node;if(before&&!this.childNodes.includes(before))throw new Error('Missing reference child');node.parentNode?.removeChild(node);this.childNodes.splice(before?this.childNodes.indexOf(before):this.childNodes.length,0,node);node.parentNode=this;this.mutations++;return node;}
 append(...nodes){for(const node of nodes)this.insertBefore(node,null);}
 removeChild(node){const index=this.childNodes.indexOf(node);assert.ok(index>=0);if(node instanceof WorkerElement&&node.contains(this.ownerDocument.activeElement))this.ownerDocument.activeElement=null;this.childNodes.splice(index,1);node.parentNode=null;this.mutations++;return node;}
 remove(){this.parentNode?.removeChild(this);}
 focus(){if(this.isConnected)this.ownerDocument.activeElement=this;}
 getClientRects(){this.ownerDocument.layoutReads++;throw new Error('Retained focus must not need a layout read');}
 get textContent(){return this.childNodes.map(node=>node.textContent).join('');}
 set textContent(value){for(const node of [...this.childNodes])this.removeChild(node);value=String(value);if(value)this.append(new WorkerTextNode(value,this.ownerDocument));this.mutations++;}
 get innerHTML(){return this.childNodes.map(node=>node.outerHTML).join('');}
 set innerHTML(value){
  for(const node of [...this.childNodes])this.removeChild(node);this.mutations++;const stack=[this];
  for(const token of String(value).match(/<\/?[\w:-]+\b[^>]*>|[^<]+/g)||[]){if(token.startsWith('</')){stack.pop();continue;}if(token.startsWith('<')){const tag=token.match(/^<([\w:-]+)/)[1],element=new WorkerElement(tag,this.ownerDocument);for(const match of token.slice(tag.length+1).matchAll(/([^\s=/>]+)(?:="([^"]*)"|='([^']*)')?/g))element.setAttribute(match[1],workerDecode(match[2]??match[3]??''));stack.at(-1).append(element);if(!token.endsWith('/>')&&!['br','img','input'].includes(tag))stack.push(element);}else stack.at(-1).append(new WorkerTextNode(workerDecode(token),this.ownerDocument));}
 }
 get outerHTML(){const tag=this.tagName.toLowerCase();return '<'+tag+Object.entries(this.attributes).map(([name,value])=>' '+name+'="'+workerEncode(value).replace(/"/g,'&quot;')+'"').join('')+'>'+this.innerHTML+'</'+tag+'>';}
 descendants(){return this.childNodes.flatMap(node=>node instanceof WorkerElement?[node,...node.descendants()]:[node]);}
 matches(selector){const attribute=selector.match(/^\[([\w-]+)="([\s\S]*)"\]$/);return attribute?this.getAttribute(attribute[1])===attribute[2]:selector.startsWith('.')?(this.getAttribute('class')||'').split(' ').includes(selector.slice(1)):this.tagName.toLowerCase()===selector;}
 querySelector(selector){return this.descendants().find(node=>node instanceof WorkerElement&&node.matches(selector))||null;}
}
const workerShape=node=>node instanceof WorkerTextNode?node.textContent:{tag:node.tagName,attributes:Object.fromEntries(Object.entries(node.attributes).map(([name,value])=>[name,name==='class'?value.trim().split(/\s+/).filter(Boolean).join(' '):value]).sort(([a],[b])=>a.localeCompare(b))),children:node.childNodes.map(workerShape)};
const legacyWorkerRendererSource="function renderWorkers(){\r\n if(!overviewPresentation(preferences.overviewMode).workers)return;const all=store.viewSessions(),now=ref(),events=renderEvidence(now).events,seriesByWorker=workerActivitySeries(events,now),hosts=store.viewHosts(),hostById=new Map(hosts.map(h=>[h.id,h]));\r\n const groups=workerGroups(relevantSessions(),events,hosts,now),query=$('search').value.toLowerCase();let html='',count=0,previousHost=null;\r\n $('fleet-source').textContent=store.mode==='replay'?'CAPTURE ORDER':'LATEST FIRST';\r\n for(const group of groups){const rows=group.rows.filter(r=>!query||(r.session.project+' '+r.session.id+' '+r.session.nickname+' '+r.session.agentPath+' '+r.latest?.label).toLowerCase().includes(query));if(!rows.length)continue;count+=rows.length;\r\n  const first=rows[0].session,host=hostById.get(group.hostId),status=host?.status||'local';\r\n  const device=deviceVisual(host);if(previousHost!==group.hostId){html+=`<div class=\"host-heading\" style=\"--device-color:${device.color}\" title=\"${device.label}\"><span class=\"device-badge\">${deviceIcon(host)}</span><span class=\"device-heading-name\">${esc(first.hostName||group.hostId||'Local')}<small>${device.label}</small></span><span class=\"device-heading-status\">${esc(store.mode==='replay'?'CAPTURE':status.toUpperCase())}</span></div>`;previousHost=group.hostId;}html+=`<div class=\"project-heading\"><span>${esc(group.project)}</span><span>${rows.length} / ${rows.filter(r=>r.recent).length} recent</span></div>`;\r\n  for(const {session:s,latest:e,depth,recent,open} of rows){const c=e?color(e):palette.tool,relation=s.parentId?`<div class=\"relation\">↳ ${esc(s.parentId.slice(0,8))} · explicit parent</div>`:'';\r\n   const series=seriesByWorker.get(key(s))||Array(16).fill(0),seriesMax=Math.max(1,...series);\r\n   html+=`<button class=\"worker ${depth?'child':''} ${recent?'recent':''} ${selectedSession===key(s)?'selected':''}\" data-session=\"${esc(key(s))}\" aria-pressed=\"${selectedSession===key(s)}\" style=\"--lane-color:${c}\" title=\"${esc(s.id)}\"><div class=\"worker-line\"><span class=\"worker-name\"><i class=\"led ${recent&&status==='online'?'on':status!=='online'?'offline':''}\"></i>${s.parentId?'↳ ':''}${esc(s.nickname||s.agentPath?.split('/').at(-1)||s.id.slice(0,8))}</span><span class=\"worker-time\">${e?age(e.at,now):'unknown'}</span></div><div class=\"worker-operation\">${e?symbol(e)+' '+esc(e.label):'Activity outside retained tail'}</div><div class=\"worker-meta\"><span>${esc(s.role==='execution-job'?'REMOTE JOB':s.model||'Model unavailable')}</span><span>${host&&status!=='online'?'UNKNOWN':store.mode==='replay'?'RECORDED':open?'OPEN RECORD':recent?'RECENT':'LAST OBSERVED'}</span></div><div class=\"worker-activity\" aria-label=\"Recorded events in the last minute\">${series.map(n=>`<i style=\"height:${n/seriesMax*12}px\"></i>`).join('')}</div>${relation}</button>`;\r\n  }\r\n }\r\n $('fleet-count').textContent=count;replaceHTML($('worker-tree'),html||'<p class=\"empty\">No sessions match this filter.</p>');\r\n const scope=selectedSession?all.find(s=>key(s)===selectedSession):null;$('fleet-foot').textContent=scope?'Focused: '+scope.project+' / '+scope.id.slice(0,8):'Latest activity first · bars = last 60s';\r\n}\r\n";

async function workerFixture(legacy=false){
 const {temporalLabel}=await import('../public/investigation-workspace.mjs');
 const {sourceConnection}=await import('../public/source-connection.mjs');
 const {readFile}=await import('node:fs/promises'),{createContext,runInContext}=await import('node:vm'),{overviewPresentation}=await import('../public/settings-view-model.mjs'),source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const document={activeElement:null,layoutReads:0,createElement:tag=>new WorkerElement(tag,document),createTextNode:value=>new WorkerTextNode(String(value),document)},elements=new Map(['worker-tree','fleet-source','fleet-count','fleet-foot','search'].map(id=>{const element=document.createElement('div');element.root=true;return [id,element];}));document.getElementById=id=>elements.get(id);document.querySelectorAll=selector=>[...elements.values()].flatMap(element=>element.descendants()).filter(node=>node instanceof WorkerElement&&node.matches(selector));
 const state={clock:now,sessions:[],hosts:[],events:[],hostFilter:'',projectFilter:''},context=createContext({adaptiveViewport:{matches:false},selectedEvent:'',eventKey:e=>(e.hostId||'local')+'/'+e.sessionId,temporalLabel,sourceConnection,activeOverview:()=>overviewPresentation(context.preferences.overviewMode),collapsedHosts:new Set(),document,CSS:{escape:value=>String(value)},$:id=>elements.get(id),overviewPresentation,preferences:{overviewMode:'full'},store:{mode:'live',viewSessions:()=>state.sessions,viewHosts:()=>state.hosts},presentationValue:ui.presentationValue,workerGroups:ui.workerGroups,workerActivitySeries:ui.workerActivitySeries,deviceVisual:ui.deviceVisual,ref:()=>state.clock,renderEvidence:()=>({events:state.events}),filters:()=>({hostId:state.hostFilter,project:state.projectFilter}),selectedSession:'',key:s=>(s.hostId||'local')+'/'+s.id,esc:value=>String(value??'—').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),replaceHTML:(element,html)=>{if(element.cachedHTML!==html){element.innerHTML=html;element.cachedHTML=html;}}});
 const extract=(start,end)=>{const at=source.indexOf(start),last=source.indexOf(end,at);assert.ok(at>=0&&last>at,start);return source.slice(at,last);};
 runInContext(extract('const age=','const key=')+extract('const deviceIcon=','const ref=')+extract('function relevantSessions(){','function selectSession(')+(legacy?legacyWorkerRendererSource:extract('const workerTreeNodes=','function renderHosts(')),context);
 if(!legacy)runInContext('globalThis.retainedWorkerNodes=workerTreeNodes;',context);
 return {state,context,elements,document,render:()=>context.focusRestore(()=>context.renderWorkers()),shape:()=>Object.fromEntries(['worker-tree','fleet-source','fleet-count','fleet-foot'].map(id=>[id,id==='worker-tree'?elements.get(id).children.filter(n=>n.matches('.worker')).map(n=>{const shape=workerShape(n);delete shape.attributes.title;delete shape.attributes['aria-label'];return shape;}).sort((a,b)=>a.attributes['data-session'].localeCompare(b.attributes['data-session'])):workerShape(elements.get(id))])),setColors:colors=>runInContext('Object.assign(palette,'+JSON.stringify(colors)+');',context)};
}
function workerInput(){return {clock:now,hostFilter:'',projectFilter:'',hosts:[{id:'H',name:'Host H',status:'online',deviceClass:'laptop'},{id:'B',name:'Host B',status:'offline',deviceClass:'rack-server'}],sessions:[{id:'parent',hostId:'H',hostName:'Host H',project:'Alpha',nickname:'Parent',model:'model-A'},{id:'child',hostId:'H',hostName:'Host H',project:'Alpha',parentId:'parent',nickname:'Child',agentPath:'/root/child'},{id:'other',hostId:'B',hostName:'Host B',project:'Beta',role:'execution-job',model:'model-B'}],events:[event('start',-10,{kind:'tool.start',sessionId:'parent',turnId:'T',callId:'pair'}),event('child-action',-5,{sessionId:'child'}),event('target-action',-20,{hostId:'B',sessionId:'other'})]};}

test('keyed worker evidence preserves frozen worker markup across scopes, clocks, devices and search; host navigation is separate',async()=>{
 const actual=await workerFixture(),oracle=await workerFixture(true);
 for(let i=0;i<36;i++){
  const input=workerInput();input.clock=now+[0,1000,-7000,70000][i%4];input.hostFilter=i%8===0?'B':'';input.projectFilter=i%7===0?'Alpha':'';input.hosts[0].status=['online','stale','disconnected'][i%3];input.hosts[0].deviceClass=['laptop','raspberry-pi','cloud'][i%3];input.sessions[0].nickname=i%2?'Renamed <worker> & "operator"':'Parent';input.sessions[0].model=i%3?'changed-model':null;input.sessions[1].parentId=i%5?'parent':null;input.sessions[1].project=i%6?'Alpha':'Other project';input.sessions[1].agentPath='/changed/agent';input.events[1].label=i%2?'Changed <action> & result':undefined;input.events[0].outcome=i%5?'recorded':'failed';input.sessions.push({...input.sessions[0],nickname:'Duplicate must not replace first identity'});
  if(i%6===0)input.events.push(event('result',-1,{kind:'tool.end',sessionId:'parent',turnId:'T',callId:'pair'}));if(i%9===0)input.events.reverse();if(i%11===0){input.sessions=[];input.events=[];}
  const before=JSON.stringify(input);Object.assign(actual.state,structuredClone(input));Object.assign(oracle.state,structuredClone(input));const actualBefore=JSON.stringify(actual.state),oracleBefore=JSON.stringify(oracle.state);actual.context.store.mode=oracle.context.store.mode=i%3?'live':'replay';actual.context.selectedSession=oracle.context.selectedSession=i%2?'H/parent':'';actual.elements.get('search').value=oracle.elements.get('search').value=i%5===0?'child':'';actual.setColors({command:i%2?'#123456':'#20cfff'});oracle.setColors({command:i%2?'#123456':'#20cfff'});actual.render();oracle.render();assert.deepEqual(actual.shape(),oracle.shape(),'Frozen markup mismatch in case '+i);assert.equal(JSON.stringify(input),before);assert.equal(JSON.stringify(actual.state),actualBefore);assert.equal(JSON.stringify(oracle.state),oracleBefore);assert.deepEqual(actual.state,oracle.state);
 }
});

test('worker buttons headers sparkline nodes and native focus survive unchanged and age-only refreshes',async()=>{
 const fixture=await workerFixture();Object.assign(fixture.state,workerInput());fixture.render();const tree=fixture.elements.get('worker-tree'),button=tree.querySelector('[data-session="H/parent"]'),nodes=[tree,...tree.descendants()],writes=new Map(nodes.map(node=>[node,node.mutations]));button.focus();
 fixture.render();assert.equal(fixture.document.activeElement,button);assert.equal(tree.descendants().length+1,nodes.length,'Unchanged refresh retains node count');for(const [i,node] of [tree,...tree.descendants()].entries())assert.ok(node===nodes[i],'Unchanged refresh replaced node '+i);for(const node of nodes)assert.equal(node.mutations,writes.get(node),'Unchanged '+(node.tagName||'text')+' was written');assert.equal(fixture.document.layoutReads,0);
 fixture.state.clock+=1000;fixture.render();assert.equal(fixture.document.activeElement,button);assert.equal(tree.querySelector('[data-session="H/parent"]'),button);const elementsAfter=[tree,...tree.descendants()].filter(node=>node instanceof WorkerElement),elementsBefore=nodes.filter(node=>node instanceof WorkerElement);assert.equal(elementsAfter.length,elementsBefore.length);for(const [i,node] of elementsAfter.entries())assert.ok(node===elementsBefore[i],'Age-only refresh replaced element '+i);assert.equal(fixture.document.layoutReads,0);assert.equal(button.querySelector('.worker-time').textContent,'11s');assert.equal(tree.descendants().filter(node=>node instanceof WorkerElement&&node.tagName==='I'&&node.parentNode.matches('.worker-activity')).length,48);
 const changed=nodes.filter(node=>node.mutations!==writes.get(node));assert.ok(changed.length>0);assert.ok(changed.every(node=>node instanceof WorkerTextNode||node.matches('.worker-time')),'An age-only refresh changes only age text');assert.equal(button.tagName,'BUTTON');assert.equal(button.getAttribute('role'),null);assert.equal(button.getAttribute('tabindex'),null);
});

test('worker order changes retain exact focused identity while filter removal prunes all stale rows',async()=>{
 const actual=await workerFixture(),oracle=await workerFixture(true);Object.assign(actual.state,workerInput());Object.assign(oracle.state,workerInput());actual.render();oracle.render();const tree=actual.elements.get('worker-tree'),button=tree.querySelector('[data-session="H/child"]');button.focus();
 for(const fixture of [actual,oracle])fixture.state.events.push(event('new-top',0,{hostId:'B',sessionId:'other'}));actual.render();oracle.render();assert.deepEqual(actual.shape(),oracle.shape());assert.equal(tree.querySelector('[data-session="H/child"]'),button);assert.equal(actual.document.activeElement,button);assert.equal(actual.document.layoutReads,0);
 actual.state.hostFilter=oracle.state.hostFilter='B';actual.render();oracle.render();assert.deepEqual(actual.shape(),oracle.shape());assert.equal(tree.contains(button),false);assert.equal(button.isConnected,false);assert.notEqual(actual.document.activeElement,button);assert.equal(actual.context.retainedWorkerNodes.size,tree.children.length);assert.ok([...actual.context.retainedWorkerNodes.values()].every(row=>row.element.isConnected));
 actual.state.hostFilter=oracle.state.hostFilter='';actual.render();oracle.render();assert.deepEqual(actual.shape(),oracle.shape());assert.notEqual(tree.querySelector('[data-session="H/child"]'),button);
});

test('worker identifiers and metadata remain literal safe text and identity is host qualified',async()=>{
 const actual=await workerFixture(),oracle=await workerFixture(true),host='H"] <host> & \\',session='same "id" [x]',payload='<img src=x onerror="throw 1">',input=workerInput();input.hosts=[{id:host,name:payload,status:'online',deviceClass:'cloud'},{id:'B',name:'Other',status:'online',deviceClass:'laptop'}];input.sessions=[{id:session,hostId:host,hostName:payload,project:payload,nickname:payload,parentId:'missing <parent>'},{id:session,hostId:'B',hostName:'Other',project:'Beta'}];input.events=[event('special',-1,{hostId:host,sessionId:session,label:payload}),event('other',-2,{hostId:'B',sessionId:session})];
 Object.assign(actual.state,structuredClone(input));Object.assign(oracle.state,structuredClone(input));actual.render();oracle.render();assert.deepEqual(actual.shape(),oracle.shape());const buttons=actual.elements.get('worker-tree').children.filter(node=>node.tagName==='BUTTON');assert.deepEqual(new Set(buttons.map(button=>button.dataset.session)),new Set([host+'/'+session,'B/'+session]));assert.doesNotMatch(actual.elements.get('worker-tree').innerHTML,/<img\b/);assert.ok(buttons.some(button=>button.querySelector('.worker-name').textContent==='↳ '+payload));
 const before=actual.shape();actual.context.preferences.overviewMode='mini';actual.state.events=[];actual.render();assert.deepEqual(actual.shape(),before,'Hidden overview keeps the previously rendered presentation without collecting or mutating source records');
});

 test('unified host cards collapse workers without filtering source records and remain one per host',async()=>{const f=await workerFixture();Object.assign(f.state,workerInput());f.render();const tree=f.elements.get('worker-tree'),before=JSON.stringify(f.state),hostCards=tree.children.filter(n=>n.matches('.fleet-host'));assert.equal(hostCards.length,2);f.context.collapsedHosts.add('H');f.render();assert.equal(tree.querySelector('[data-session="H/parent"]'),null);assert.ok(tree.querySelector('[data-session="B/other"]'));assert.equal(tree.children.filter(n=>n.matches('.fleet-host')).length,2);assert.equal(JSON.stringify(f.state),before);f.context.collapsedHosts.delete('H');f.render();assert.ok(tree.querySelector('[data-session="H/parent"]'));});


test('larger observation share defaults to 72, preserves saved shares and supports the extended divider range',async()=>{
 const {DEFAULT_PREFERENCES,normalizePreferences}=await import('../public/ui-model.mjs');const {DEFAULT_PERSONAL_SETTINGS,normalizePersonalSettings,PERSONAL_FIELDS}=await import('../public/settings-view-model.mjs');
 assert.equal(DEFAULT_PREFERENCES.waterfallRatio,72);assert.equal(DEFAULT_PERSONAL_SETTINGS.waterfallRatio,72);const field=PERSONAL_FIELDS.find(f=>f.key==='waterfallRatio');assert.equal(field.max,88);
 for(const share of [32,55,68,72,80,88]){assert.equal(normalizePreferences({waterfallRatio:share}).waterfallRatio,share);assert.equal(normalizePersonalSettings({waterfallRatio:share}).waterfallRatio,share);}assert.equal(normalizePreferences({waterfallRatio:1000}).waterfallRatio,88);
});
test('source connectivity alerts remain captured and inspectable while the activity ticker keeps action and event alerts',async()=>{
 const {attentionItems,tickerAttentionItems}=await import('../public/ui-model.mjs');const now=Date.now(),events=[{id:'failure',hostId:'test',sessionId:'worker',at:new Date(now-1000).toISOString(),kind:'error',label:'TEST_ONLY failure'}],hosts=[{id:'test',name:'TEST_ONLY source',status:'disconnected',receivedAt:new Date(now-30000).toISOString()}],before=JSON.stringify({events,hosts}),items=attentionItems(events,hosts,now),visible=tickerAttentionItems(items);
 assert.equal(items.some(e=>e.kind==='source-gap'),true);assert.equal(visible.some(e=>e.kind==='source-gap'),false);assert.equal(visible.some(e=>e.id==='failure'),true);assert.equal(items.length,2);assert.equal(JSON.stringify({events,hosts}),before);
});
