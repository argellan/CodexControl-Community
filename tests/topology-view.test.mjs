// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ActivityMap} from '../public/topology-view.mjs';
import {projectActivity} from '../public/activity-map-model.mjs';
import {topologyPoint} from '../public/topology-map.mjs';
import {workerActivity} from '../public/worker-activity.mjs';
import {getTokenPalette} from '../public/token-palette.mjs';

const reference=Date.parse('2026-10-20T16:00:00Z');
const hosts=[{id:'source',name:'Workstation',role:'codex-source',status:'online',deviceClass:'workstation'}];
const sessions=[{id:'parent',hostId:'source',project:'Alpha'},{id:'child',hostId:'source',project:'Alpha',parentId:'parent',nickname:'Volta'}];
const event=(id,kind,offset,extra={})=>({id,kind,at:new Date(reference+offset).toISOString(),hostId:'source',sourceId:'native',sessionId:'parent',turnId:'turn',category:'command',label:'exec',callId:id,...extra});
const graph=(events,extra={})=>projectActivity({hosts,sessions,events,reference,windowMs:60000,...extra});
const decode=value=>value.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');

// Only DOM operations owned by this renderer are represented. Geometry and
// correlation use the actual production models; the Canvas recorder captures
// their final observable marker coordinates instead of substituting a renderer.
const encode=value=>String(value).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
class TextNode{
 constructor(value){this.value=value;this.parent=null;}
 get textContent(){return this.value;}
 get outerHTML(){return encode(this.value);}
}
class Element{
 constructor(name,parent=null){Object.assign(this,{name,parent,dataset:{},attributes:{},childNodes:[],mutations:0,clientWidth:900,clientHeight:480,scrollLeft:0,scrollTop:0,hidden:false,tagName:name.toUpperCase(),handlers:new Map()});this.style={setProperty:(name,value)=>{this.style[name]=value;}};this.classList={toggle:(key,on)=>{const classes=new Set((this.getAttribute('class')||'').split(' ').filter(Boolean));on??=!classes.has(key);on?classes.add(key):classes.delete(key);this.setAttribute('class',[...classes].join(' '));},contains:key=>(this.getAttribute('class')||'').split(' ').includes(key)};}
 get parentNode(){return this.parent;}
 get children(){return this.childNodes.filter(node=>node instanceof Element);}
 get firstChild(){return this.childNodes[0]||null;}
 get firstElementChild(){return this.children[0]||null;}
 get lastElementChild(){return this.children.at(-1)||null;}
 get previousElementSibling(){const siblings=this.parent?.children||[];return siblings[siblings.indexOf(this)-1]||null;}
 get nextElementSibling(){const siblings=this.parent?.children||[];return siblings[siblings.indexOf(this)+1]||null;}
 get nextSibling(){const siblings=this.parent?.childNodes||[];return siblings[siblings.indexOf(this)+1]||null;}
 set innerHTML(value){
  this.mutations++;if(this.contains(globalThis.document.activeElement))globalThis.document.activeElement=null;for(const node of this.childNodes)node.parent=null;this.childNodes=[];
  const stack=[this];for(const token of String(value).match(/<\/?[\w:-]+\b[^>]*>|[^<]+/g)||[]){
   if(token.startsWith('</')){stack.pop();continue;}
   if(token.startsWith('<')){const tag=token.match(/^<([\w:-]+)/)[1],node=new Element(tag);node.renderedTag=token;for(const match of token.slice(tag.length+1).matchAll(/([^\s=/>]+)(?:="([^"]*)"|='([^']*)')?/g))node.setAttribute(match[1],decode(match[2]??match[3]??''));stack.at(-1).append(node);if(!token.endsWith('/>')&&!['input','img','br','hr','meta','link'].includes(tag))stack.push(node);}
   else{const node=new TextNode(decode(token));node.parent=stack.at(-1);node.parent.childNodes.push(node);}
  }
 }
 get innerHTML(){return this.childNodes.map(node=>node.outerHTML).join('');}
 get outerHTML(){return '<'+this.name+Object.entries(this.attributes).map(([key,value])=>' '+key+'="'+encode(value).replace(/"/g,'&quot;')+'"').join('')+'>'+this.innerHTML+'</'+this.name+'>';}
 get textContent(){return this.childNodes.map(node=>node.textContent).join('');}
 set textContent(value){this.mutations++;for(const node of this.childNodes)node.parent=null;const text=new TextNode(String(value));text.parent=this;this.childNodes=[text];}
 addEventListener(type,listener){this.handlers.set(type,listener);}
 getAttribute(name){return Object.hasOwn(this.attributes,name)?this.attributes[name]:null;}
 setAttribute(name,value){this.mutations++;this.attributes[name]=String(value);if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,char)=>char.toUpperCase())]=String(value);}
 insertBefore(node,before){if(node===before)return node;if(before&&!this.childNodes.includes(before))throw new Error('Reference child is absent');node.parent?.removeChild(node);const index=before?this.childNodes.indexOf(before):this.childNodes.length;this.childNodes.splice(index,0,node);node.parent=this;this.mutations++;return node;}
 append(...nodes){for(const node of nodes)this.insertBefore(node,null);}
 removeChild(node){const index=this.childNodes.indexOf(node);assert.ok(index>=0);if(node instanceof Element&&node.contains(globalThis.document.activeElement))globalThis.document.activeElement=null;this.childNodes.splice(index,1);node.parent=null;this.mutations++;return node;}
 remove(){this.parent?.removeChild(this);}
 contains(other){for(let current=other;current;current=current.parent)if(current===this)return true;return false;}
 focus(){globalThis.document.activeElement=this;}
 descendants(){return this.children.flatMap(child=>[child,...child.descendants()]);}
 get items(){return this.descendants().filter(item=>['BUTTON','G'].includes(item.tagName)&&Object.keys(item.dataset).some(key=>key.startsWith('map')));}
 matches(selector){const attribute=selector.match(/^\[([\w-]+)(?:="([\s\S]*)")?\]$/);return attribute?attribute[2]===undefined?this.getAttribute(attribute[1])!==null:this.getAttribute(attribute[1])===attribute[2]:selector.startsWith('.')?this.classList.contains(selector.slice(1)):this.name===selector;}
 querySelector(selector){return this.descendants().find(item=>item.matches(selector))||null;}
 closest(selector){for(let current=this;current;current=current.parent)if(selector.split(',').some(part=>current.matches(part)))return current;return null;}
}

function fixture(t,{width=900,height=480,observeResize=false}={}){
 const originals={document:globalThis.document,getComputedStyle:globalThis.getComputedStyle,CSS:globalThis.CSS,ResizeObserver:globalThis.ResizeObserver};
 let resizeObserver;if(observeResize)globalThis.ResizeObserver=class{constructor(callback){this.callback=callback;resizeObserver=this;}observe(target){this.target=target;}};
  const journeyStrip=new Element('div');globalThis.document={activeElement:null,createElement:name=>new Element(name),createElementNS:(namespace,name)=>{assert.equal(namespace,'http://www.w3.org/2000/svg');return new Element(name);},getElementById:id=>id==='journey-strip'?journeyStrip:null};globalThis.getComputedStyle=()=>({fontSize:'16px'});globalThis.CSS={escape:value=>String(value)};
 t.after(()=>{for(const [key,value] of Object.entries(originals))if(value===undefined)delete globalThis[key];else globalThis[key]=value;});
 const layer=new Element('layer'),canvas=new Element('canvas');layer.clientWidth=canvas.clientWidth=width;layer.clientHeight=canvas.clientHeight=height;
 const events=[],details=[];const view=new ActivityMap({layer,canvas,onEvent:id=>events.push(id),onDetails:(...args)=>details.push(args),onWorkers:()=>{}});
 const ctx={translations:[],clears:0,clearRect(){this.clears++;this.translations=[];},save(){},restore(){},beginPath(){},arc(){},fill(){},roundRect(){},moveTo(){},lineTo(){},closePath(){},translate(x,y){this.translations.push([x,y]);}};
  return {view,layer,canvas,ctx,events,details,journeyStrip,resize:(width,height)=>resizeObserver?.callback([{target:layer,contentRect:{width,height}}])};
}
const options={reference,windowMs:60000,mode:'live',preferences:{planeWorkers:6,planeChannels:3}};
const drawing=(freshIds=new Set(),arrivalTimes=new Map(),extra={})=>({mode:'live',freshIds,arrivalTimes,reduced:false,paused:false,vivid:true,...extra});
const samePoint=(actual,want)=>{assert.equal(actual.length,want.length);actual.forEach((value,index)=>assert.ok(Math.abs(value-want[index])<.000001,`${value} differs from ${want[index]}`));};
const workerHTML=(view,id='worker:source/parent')=>{
 const start=view.nodes.innerHTML.indexOf('data-map-node="'+id+'"');assert.ok(start>=0,'The expected real worker is rendered');const open=view.nodes.innerHTML.lastIndexOf('<button',start),end=view.nodes.innerHTML.indexOf('</button>',start);return view.nodes.innerHTML.slice(open,end+9);
};

test('unchanged routes retain SVG groups paths labels and focused direction with zero subtree writes',t=>{
 const f=fixture(t),g=graph([event('start','tool.start',-2000),event('end','tool.end',-1000,{callId:'start'})]);f.view.update(g,options);
 const rows=[...f.view.routeNodes.entries()],elements=[...f.view.routeLayer.children,...f.view.routeLayer.descendants()],counts=elements.map(element=>element.mutations);
 const target=f.view.routeLayer.items.find(element=>/^topology-route return/.test(element.getAttribute('class')));assert.ok(target);target.focus();
 f.view.update(g,options);
 for(const [id,row] of rows)assert.equal(f.view.routeNodes.get(id),row);
 assert.deepEqual([...f.view.routeLayer.children,...f.view.routeLayer.descendants()],elements);
 assert.deepEqual(elements.map(element=>element.mutations),counts);assert.equal(globalThis.document.activeElement,target);
});

test('usage-only updates cannot rebuild captured route subtrees and removed routes release their cache entries',t=>{
 const f=fixture(t),g=graph([event('start','tool.start',-2000),event('end','tool.end',-1000,{callId:'start'})]);f.view.update(g,options);
 const rows=[...f.view.routeNodes.values()],elements=f.view.routeLayer.descendants(),counts=elements.map(element=>element.mutations);rows[0].element.focus();
 f.view.setTokenUsage(usagePayload(1),{now:reference});f.view.setTokenUsage(usagePayload(2),{now:reference+100});assert.match(f.view.tokenLayer.innerHTML,/MODEL USAGE/);
 assert.deepEqual(f.view.routeLayer.descendants(),elements);assert.deepEqual(elements.map(element=>element.mutations),counts);assert.equal(globalThis.document.activeElement,rows[0].element);
 f.view.update(graph([]),options);assert.ok(f.view.routeNodes.size<rows.length);assert.equal(f.view.routeNodes.size,f.view.routeLayer.children.length);
 for(const row of rows)if(![...f.view.routeNodes.values()].includes(row))assert.equal(row.element.parentNode,null);
});
const tokenObservation=(sequence,extra={})=>({sequence,id:'u:'+sequence,hostId:'source',sessionId:'parent',project:'Alpha',provider:'openai',model:'test-model',sourceAt:new Date(reference).toISOString(),receivedAt:new Date(reference).toISOString(),intervalMs:2000,status:'delta',inputTokens:125,cachedInputTokens:100,uncachedInputTokens:25,outputTokens:5,...extra});
const usagePayload=(sequence,extra={})=>({burnUsage:{epoch:'usage-epoch',lastSequence:sequence,inputTokens:125,cachedInputTokens:100,uncachedInputTokens:25,outputTokens:5,windowMs:60000},usageHistory:{observations:[tokenObservation(sequence,extra)]}});

test('observed model usage has its own inspectable channel and coins without changing captured event routes or worker layout',t=>{
 const f=fixture(t),g=graph([event('start','tool.start',-1000)]);f.view.update(g,options);const before=f.view.layout.nodes.map(actor=>[actor.node.id,actor.x,actor.y]),eventRoutes=f.view.layout.routes.length;
 f.view.setTokenUsage(usagePayload(1),{now:reference});f.view.setTokenUsage(usagePayload(2),{now:reference+100});assert.match(f.view.svg.innerHTML,/MODEL USAGE/);assert.match(f.view.svg.innerHTML,/data-map-token-usage="true" role="button" tabindex="0"/);assert.match(f.view.svg.innerHTML,/observed output counters/);
 assert.equal(f.view.layout.routes.length,eventRoutes);assert.deepEqual(f.view.layout.nodes.map(actor=>[actor.node.id,actor.x,actor.y]),before);f.view.draw(f.ctx,reference+600,drawing());assert.equal(f.canvas.dataset.packetCount,'0');assert.ok(Number(f.canvas.dataset.tokenPacketCount)>0);
 f.view.selectTokenUsage();assert.equal(f.details.at(-1)[0],'Observed model usage');assert.match(f.details.at(-1)[2],/New input shows input minus cached input/);assert.match(f.details.at(-1)[2],/Command, GitHub and server routes are separate evidence/);assert.match(f.details.at(-1)[2],/Latest 24 or fewer retained usage observations/);assert.match(f.details.at(-1)[2],/<th>Interval \(ms\)<\/th>/);assert.match(f.details.at(-1)[2],/<td>2,000<\/td>/);assert.match(f.details.at(-1)[2],/not the complete database ledger/);
 f.view.setTokenUsage(usagePayload(2),{now:reference+1000});f.view.draw(f.ctx,reference+4000,drawing());assert.equal(f.canvas.dataset.tokenPacketCount,'0');
});

test('model token overlay cannot expose live source usage in replay or animate unknown provider routes',t=>{
 const f=fixture(t),g=graph([event('start','tool.start',-1000)]);f.view.update(g,options);f.view.setTokenUsage(usagePayload(1),{now:reference});f.view.setTokenUsage(usagePayload(2),{now:reference+100});f.view.update(g,{...options,mode:'replay'});assert.doesNotMatch(f.view.svg.innerHTML,/MODEL USAGE/);f.view.draw(f.ctx,reference+600,drawing(new Set(),new Map(),{mode:'replay'}));assert.equal(f.canvas.dataset.tokenPacketCount,'0');
 f.view.update(g,options);f.view.setTokenUsage(usagePayload(3,{provider:'unknown'}),{now:reference+1000});f.view.setTokenUsage(usagePayload(4,{provider:'unknown'}),{now:reference+1200});assert.equal(f.layer.dataset.tokenMappedWorkers,'0');assert.equal(f.layer.dataset.tokenUnmappedBatches,'1');assert.doesNotMatch(f.view.svg.innerHTML,/MODEL USAGE/);f.view.draw(f.ctx,reference+1600,drawing());assert.equal(f.canvas.dataset.tokenPacketCount,'0');
});

test('usage updates escape source identifiers and preserve focus on the model-usage inspector',t=>{
 const f=fixture(t),g=graph([event('start','tool.start',-1000)]);f.view.update(g,options);f.view.setTokenUsage(usagePayload(1),{now:reference});const anchor=f.view.svg.querySelector('[data-map-token-usage="true"]');assert.ok(anchor);anchor.focus();f.view.setTokenUsage(usagePayload(2),{now:reference+100});assert.equal(globalThis.document.activeElement.dataset.mapTokenUsage,'true');
 f.view.setTokenUsage(usagePayload(3,{hostId:'<img src=x onerror=alert(1)>',sourceAt:'<img src=x onerror=alert(2)>'}),{now:reference+200});f.view.selectTokenUsage();assert.doesNotMatch(f.details.at(-1)[2],/<img\b/);assert.match(f.details.at(-1)[2],/&lt;img/);
});

test('model usage inspector discloses its 24-row truncation and exact counter-sampling intervals',t=>{
 const f=fixture(t),g=graph([event('start','tool.start',-1000)]),payload=usagePayload(30);payload.usageHistory.observations=Array.from({length:30},(_,index)=>tokenObservation(index+1,{intervalMs:2000+index}));f.view.update(g,options);f.view.setTokenUsage(payload,{now:reference});f.view.selectTokenUsage();const html=f.details.at(-1)[2];
 assert.match(html,/Showing the latest 24 of 30 loaded delta observations/);assert.match(html,/6 earlier loaded observations are omitted/);assert.match(html,/This map inspector has no pagination/);assert.match(html,/source-counter sampling interval in milliseconds/);assert.equal((html.match(/<tr>/g)||[]).length,25);assert.match(html,/<td>2,029<\/td>/);assert.doesNotMatch(html,/<td>2,000<\/td>/);
});

test('hosting and explicit subagent relationships remain inspectable metadata and never animate',t=>{
 const f=fixture(t),g=graph([event('child-record','turn',-1000,{sessionId:'child',category:'turn'})]);
 f.view.update(g,options);assert.match(f.view.svg.innerHTML,/metadata only/);assert.match(f.view.svg.innerHTML,/data-map-edge=/);assert.equal(f.view.animatedLegs.length,0);
 f.view.draw(f.ctx,reference+300,drawing(new Set(['child-record']),new Map([['child-record',reference]])));assert.equal(f.canvas.dataset.packetCount,'0');assert.deepEqual(f.ctx.translations,[]);
 const edge=g.edges.find(edge=>edge.kind==='parent');f.view.selectEdge(edge.id);assert.match(f.details.at(-1)[1],/Metadata relationship/);assert.equal(f.events.length,0);
});

test('new live evidence advances once across refreshes while bootstrap and expired arrivals remain still',t=>{
 const f=fixture(t),g=graph([event('start','tool.start',-1000)]),fresh=new Set(['start']),arrivals=new Map([['start',reference]]);
 f.view.update(g,options);f.view.draw(f.ctx,reference,drawing());assert.equal(f.canvas.dataset.packetCount,'0');
 f.view.draw(f.ctx,reference+600,drawing(fresh,arrivals));assert.equal(f.canvas.dataset.packetCount,'1');const first=f.ctx.translations[0];
 samePoint(first,topologyPoint(f.view.animatedLegs[0].curve,.25));
 f.view.update(graph([event('start','tool.start',-1000)]),{...options,reference:reference+1000});
 f.view.draw(f.ctx,reference+1800,drawing(fresh,arrivals));assert.equal(f.canvas.dataset.packetCount,'1');samePoint(f.ctx.translations[0],topologyPoint(f.view.animatedLegs[0].curve,.75));assert.notDeepEqual(first,f.ctx.translations[0]);
 f.view.draw(f.ctx,reference+2400,drawing(fresh,arrivals));assert.equal(f.canvas.dataset.packetCount,'0');
 f.view.draw(f.ctx,reference+300,drawing(new Set(),arrivals));assert.equal(f.canvas.dataset.packetCount,'0');
});

test('a shared completed-operation record creates one outbound marker followed by one return marker',t=>{
 const f=fixture(t),g=graph([event('operation','operation',-1000,{startedAt:new Date(reference-8000).toISOString(),completedAt:new Date(reference-1000).toISOString()})]);
 f.view.update(g,options);const arrivals=new Map([['operation',reference]]),fresh=new Set(['operation']);
 const out=f.view.animatedLegs.find(item=>item.leg.direction==='outbound'),back=f.view.animatedLegs.find(item=>item.leg.direction==='return');assert.ok(out);assert.ok(back);
 f.view.draw(f.ctx,reference+600,drawing(fresh,arrivals));assert.equal(f.canvas.dataset.packetCount,'1');samePoint(f.ctx.translations[0],topologyPoint(out.curve,.5));
 f.view.draw(f.ctx,reference+1800,drawing(fresh,arrivals));assert.equal(f.canvas.dataset.packetCount,'1');samePoint(f.ctx.translations[0],topologyPoint(back.curve,.5));
});

test('replay redraws use the frozen source clock and ignore live arrival metadata',t=>{
 const f=fixture(t),g=graph([event('start','tool.start',-2000),event('future-result','tool.end',1000,{callId:'start'})]),frozen=reference-200,replayOptions={...options,mode:'replay',reference:frozen};
 f.view.update(g,replayOptions);f.view.draw(f.ctx,frozen,drawing(new Set(),new Map([['start',reference+60000]]),{mode:'replay'}));const point=f.ctx.translations[0];assert.equal(f.canvas.dataset.packetCount,'1');
 samePoint(point,topologyPoint(f.view.animatedLegs[0].curve,.75));assert.equal(f.view.layout.routes.filter(route=>!route.metadata).length,1);
 f.view.update(g,replayOptions);f.view.draw(f.ctx,frozen,drawing(new Set(['future-result']),new Map([['start',reference+90000]]),{mode:'replay'}));samePoint(f.ctx.translations[0],point);assert.equal(f.view.options.reference,frozen);assert.equal(f.canvas.dataset.paintReference,String(frozen));
});

test('feed loss and source replay cannot retain a live connected label',t=>{
 const f=fixture(t),g=graph([event('result','tool.end',-1000)]);
 f.view.update(g,{...options,observationGap:true});assert.match(f.view.nodes.innerHTML,/Feed unknown/);assert.doesNotMatch(f.view.nodes.innerHTML,/Collector online|state-online/);assert.match(f.view.quiet.innerHTML,/FEED UNKNOWN/);
 f.view.update(g,{...options,mode:'replay'});assert.match(f.view.nodes.innerHTML,/Captured source/);assert.doesNotMatch(f.view.nodes.innerHTML,/Collector online|state-online/);assert.match(f.view.quiet.innerHTML,/SOURCE REPLAY/);
});

test('resize recomputes SVG and Canvas marker geometry in the same scrolled world',t=>{
 const f=fixture(t),g=graph([event('start','tool.start',-1000)]),fresh=new Set(['start']),arrivals=new Map([['start',reference]]);
 f.view.update(g,options);const oldCurve=f.view.animatedLegs[0].curve;
 f.layer.clientWidth=f.canvas.clientWidth=1100;f.layer.clientHeight=f.canvas.clientHeight=540;f.layer.scrollLeft=25;f.layer.scrollTop=12;
 f.view.draw(f.ctx,reference+600,drawing(fresh,arrivals));const {width,height}=f.view.layout;assert.equal(f.view.world.style.width,width+'px');assert.equal(f.view.svg.attributes.viewBox,`0 0 ${width} ${height}`);assert.equal(f.view.svg.style.width,width+'px');assert.equal(f.view.svg.style.height,height+'px');assert.notDeepEqual(f.view.animatedLegs[0].curve,oldCurve);
 const expected=topologyPoint(f.view.animatedLegs[0].curve,.25);samePoint(f.ctx.translations[0],[expected[0]*f.view.scale+f.view.viewGeometry.x-f.layer.scrollLeft,expected[1]*f.view.scale+f.view.viewGeometry.y-f.layer.scrollTop]);assert.equal(f.canvas.dataset.packetCount,'1');
});

test('fit overview scales the visible SVG world and Canvas marker to the same viewport coordinates',t=>{
 const f=fixture(t,{width:420,height:210}),g=graph([event('start','tool.start',-1000)]),fresh=new Set(['start']),arrivals=new Map([['start',reference]]);
 f.view.update(g,options);assert.equal(f.view.scale,.5);assert.equal(f.view.frame.style.width,'420px');assert.equal(f.view.frame.style.height,'210px');assert.equal(f.view.world.style.transform,'scale(0.5)');
 f.view.draw(f.ctx,reference+600,drawing(fresh,arrivals));assert.equal(f.canvas.dataset.packetCount,'1');const p=topologyPoint(f.view.animatedLegs[0].curve,.25);samePoint(f.ctx.translations[0],[p[0]/2,p[1]/2]);
 assert.ok(Number.parseFloat(f.view.frame.style.width)<=f.layer.clientWidth);assert.ok(Number.parseFloat(f.view.frame.style.height)<=f.layer.clientHeight);
});

test('actual-size view remains at100percent across resize and preserves source arrival progress',t=>{
 const f=fixture(t,{width:420,height:210}),g=graph([event('start','tool.start',-1000)]),fresh=new Set(['start']),arrivals=new Map([['start',reference]]);
 f.view.update(g,options);f.view.setZoom('actual');assert.equal(f.view.scale,1);assert.equal(f.view.zoomMode,'actual');assert.equal(Number.parseFloat(f.view.frame.style.width),f.view.layout.width);assert.equal(f.view.world.style.transform,'scale(1)');
 const p=topologyPoint(f.view.animatedLegs[0].curve,.25);f.layer.scrollLeft=Math.max(0,p[0]-200);f.layer.scrollTop=Math.max(0,p[1]-100);f.view.draw(f.ctx,reference+600,drawing(fresh,arrivals));samePoint(f.ctx.translations[0],[p[0]-f.layer.scrollLeft,p[1]-f.layer.scrollTop]);
 f.layer.clientWidth=f.canvas.clientWidth=900;f.layer.clientHeight=f.canvas.clientHeight=480;f.layer.scrollLeft=f.layer.scrollTop=0;
 f.view.draw(f.ctx,reference+1800,drawing(fresh,arrivals));assert.equal(f.view.scale,1);assert.equal(f.view.zoomMode,'actual');assert.equal(f.view.svg.attributes.viewBox,`0 0 ${f.view.layout.width} ${f.view.layout.height}`);samePoint(f.ctx.translations[0],topologyPoint(f.view.animatedLegs[0].curve,.75));
});

test('station names, route records and inspection fields are escaped at rendered boundaries',t=>{
 const f=fixture(t),payload='<img src=x onerror="throw 1">',g=graph([event('unsafe','tool.end',-1000,{label:payload})],{hosts:[{...hosts[0],name:payload}],sessions:[{...sessions[0],nickname:payload,project:payload}]});
 f.view.update(g,options);for(const html of [f.view.nodes.innerHTML,f.view.svg.innerHTML]){assert.doesNotMatch(html,/<img\s/i);assert.match(html,/&lt;img/);}
 f.view.selectJourney(g.journeys[0].id);assert.doesNotMatch(f.details.at(-1)[2],/<img\s/i);assert.match(f.details.at(-1)[2],/&lt;img/);assert.equal(f.events.at(-1),'unsafe');
});

test('route keyboard selection locates the real event, preserves focus on refresh and clears with Escape',t=>{
 const f=fixture(t),g=graph([event('operation','operation',-1000)]);f.view.update(g,options);
 const journey=g.journeys[0],selector=`[data-map-journey="${journey.id}"]`,route=f.view.svg.querySelector(selector);assert.ok(route);assert.match(f.view.svg.innerHTML,/role="button" tabindex="0"/);route.focus();
 let prevented=false;f.layer.handlers.get('keydown')({target:route,key:'Enter',preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(f.view.selection,journey.id);assert.equal(f.events.at(-1),'operation');assert.equal(globalThis.document.activeElement.dataset.mapJourney,journey.id);
 f.view.update(g,{...options,reference:reference+1000});assert.equal(globalThis.document.activeElement.dataset.mapJourney,journey.id);assert.equal(f.view.selection,journey.id);
 f.layer.handlers.get('keydown')({target:globalThis.document.activeElement,key:'Escape',preventDefault(){}});assert.equal(f.view.selection,null);assert.equal(f.events.at(-1),'');
});

test('keyboard selecting a paired call preserves the focused route direction when both legs share a journey',t=>{
 const f=fixture(t),g=graph([event('start','tool.start',-2000),event('end','tool.end',-1000,{callId:'start'})]);f.view.update(g,options);
 const journey=g.journeys[0];f.view.svg.querySelector(`[data-map-journey="${journey.id}"]`);
 const outbound=f.view.svg.items.find(item=>item.dataset.mapJourney===journey.id&&/^topology-route outbound/.test(item.getAttribute('class')));assert.ok(outbound);outbound.focus();
 f.layer.handlers.get('keydown')({target:outbound,key:'Enter',preventDefault(){}});assert.equal(f.events.at(-1),'end');assert.match(globalThis.document.activeElement.getAttribute('class'),/^topology-route outbound/);
});

test('reduced or paused presentation suppresses moving markers without removing captured routes',t=>{
 const f=fixture(t),g=graph([event('start','tool.start',-1000)]);f.view.update(g,options);const routeHTML=f.view.svg.innerHTML;
 for(const extra of [{reduced:true},{paused:true}]){f.view.draw(f.ctx,reference+600,drawing(new Set(['start']),new Map([['start',reference]]),extra));assert.equal(f.canvas.dataset.packetCount,'0');assert.equal(f.view.svg.innerHTML,routeHTML);}
});

test('clearing the inspected event removes stale route emphasis without clearing captured evidence',t=>{
 const f=fixture(t),g=graph([event('selected','operation',-1000)]);f.view.update(g,options);f.view.selectJourney(g.journeys[0].id);
 assert.equal(f.view.selection,g.journeys[0].id);f.view.update(g,{...options,selectedEvent:''});
 assert.equal(f.view.selection,null);assert.doesNotMatch(f.view.svg.innerHTML,/topology-route [^"]* selected/);assert.ok(f.view.layout.routes.length>0);
});

test('a failed source leg keeps its failure color inside a channel whose newer operation succeeded',t=>{
 const f=fixture(t),g=graph([event('failure','operation',-1500,{outcome:'failed',startedAt:new Date(reference-2000).toISOString(),completedAt:new Date(reference-1500).toISOString()}),event('success','operation',-1000)]);
 f.view.update(g,options);const failed=f.view.animatedLegs.filter(item=>item.leg.eventId==='failure');assert.equal(failed.length,2);
 assert.ok(failed.every(item=>item.color==='#ff5a75'));
});

test('compact stations use the pre-update icon layout without boxed worker cards',t=>{
 const f=fixture(t),g=graph([event('record','tool.end',-1000),event('child-record','tool.end',-1000,{sessionId:'child'})]);
 for(const [width,height] of [[900,480],[420,210]]){
  f.layer.clientWidth=f.canvas.clientWidth=width;f.layer.clientHeight=f.canvas.clientHeight=height;f.view.update(g,options);
  assert.equal(f.view.layout.readableCards,false);assert.equal(f.view.world.dataset.presentation,'compact');
  assert.doesNotMatch(f.view.nodes.innerHTML,/worker-card|worker-copy|worker-task|worker-phase|--station-width/);
  assert.match(f.view.nodes.innerHTML,/station-emblem/);assert.match(f.view.nodes.innerHTML,/station-label/);assert.match(f.view.nodes.innerHTML,/station-records/);
  for(const actor of f.view.layout.nodes.filter(actor=>!actor.hidden))assert.equal(actor.cardBounds,undefined);
  assert.ok(Number.parseFloat(f.view.frame.style.width)<=width);assert.ok(Number.parseFloat(f.view.frame.style.height)<=height);
 }
});

test('phone map starts readable and pannable while retaining fit, routes and full names',t=>{
 const previous=globalThis.matchMedia;globalThis.matchMedia=()=>({matches:true});t.after(()=>{if(previous===undefined)delete globalThis.matchMedia;else globalThis.matchMedia=previous;});
 const f=fixture(t,{width:368,height:196}),name='A long worker name that must remain readable';
 const g=graph([event('record','tool.start',-1000)],{sessions:[{...sessions[0],nickname:name}]});
 f.view.update(g,options);
 assert.equal(f.view.layout.readableCards,true);assert.equal(f.view.world.dataset.presentation,'readable');
 assert.ok(f.view.scale>=.85,'the initial map retains a readable scale');
 assert.ok(Number.parseFloat(f.view.frame.style.width)>368,'map can be panned');
 const worker=f.view.stationNodes.get('worker:source/parent');assert.equal(worker.name.textContent,name);assert.match(worker.element.getAttribute('aria-label'),new RegExp(name));
 assert.ok(f.view.layout.routes.length>0,'routes are retained');
 const routeIds=f.view.layout.routes.map(route=>route.id);f.view.setZoom('fit');
 assert.ok(Number.parseFloat(f.view.frame.style.width)<=368);assert.deepEqual(f.view.layout.routes.map(route=>route.id),routeIds);
});

test('busy phone usage renders real coins for displayed workers without truncating labels',t=>{
 const previous=globalThis.matchMedia;globalThis.matchMedia=()=>({matches:true});t.after(()=>{if(previous===undefined)delete globalThis.matchMedia;else globalThis.matchMedia=previous;});
 const f=fixture(t,{width:368,height:196});
 const many=Array.from({length:8},(_,i)=>({id:'w'+i,hostId:'source',project:'Alpha',nickname:'Readable worker '+i}));
 const g=graph(many.map((s,i)=>event('busy'+i,'tool.start',-1000,{sessionId:s.id})),{sessions:many});f.view.update(g,{...options,maxWorkers:8});
 const actor=f.view.layout.nodes.filter(a=>a.role==='worker'||a.role==='subagent').sort((a,b)=>b.x-a.x)[0];assert.ok(actor.x>368);
 const target=actor.node.id.replace('worker:source/','');
 f.view.setTokenUsage(usagePayload(1),{now:reference});
 const payload=usagePayload(18);payload.usageHistory.observations=[tokenObservation(2,{sessionId:target}),...Array.from({length:16},(_,i)=>tokenObservation(i+3,{sessionId:'offscreen'+i}))];
 f.view.setTokenUsage(payload,{now:reference+100});
 assert.ok(f.view.tokenMotion.packets.some(p=>p.workerId===actor.node.id),'fresh real usage for a displayed worker gets a packet');
 let rendered=0;for(let elapsed=300;elapsed<2300;elapsed+=100){f.view.draw(f.ctx,reference+100+elapsed,drawing());rendered+=Number(f.canvas.dataset.tokenPacketCount);}
 assert.ok(rendered>0,'actual spinning coins are painted in the initial phone viewport');
 assert.match(f.view.stationNodes.get(actor.node.id).name.textContent,/Readable worker/);
 assert.ok(f.layer.scrollLeft>0,'initial viewport centers the activity while keeping the world pannable');
});

test('compact stations retain task context action and qualified status in inspection labels',t=>{
 const f=fixture(t),records=[event('result','tool.end',-5000,{label:'exec · result recorded'}),event('done','complete',-1000,{label:'Turn completed · acceptance unverified'})];
 const g=graph(records,{sessions:[{...sessions[0],nickname:'Volta',taskLabel:'Release artifact review',taskLabelSource:'native-thread-name',taskLabelUpdatedAt:new Date(reference-10000).toISOString()}]});
 f.view.update(g,options);const html=workerHTML(f.view);
 assert.doesNotMatch(html,/worker-card|worker-copy|worker-phase/);assert.match(html,/station-symbol/);assert.match(html,/station-label/);
 assert.match(html,/>Volta</);assert.match(html,/Release artifact review/);assert.match(html,/Turn completed/);assert.match(html,/unverified/);assert.match(html,/data-worker-state="recent"/);assert.doesNotMatch(html,/>Running<|>Executing</);
});

test('worker inspector pairs a bound target report with its own label clock and timeline identity',t=>{
 const f=fixture(t),old=event('native-old','tool.end',-600000,{label:'OLD_NATIVE_ACTION'}),g=graph([old]);
 const worker=g.nodes.find(n=>n.type==='worker'),report={...event('target-progress','remote.progress',-1000,{label:'Target progress observed'}),hostId:'target',sessionId:'remote-job',workerHostId:worker.hostId,workerSessionId:worker.sessionId};
 g.records=[old,report];worker.lastAt=reference-1000;worker.eventIds=[report.id,old.id];
 f.view.update(g,options);f.view.selectNode(worker.id);const html=f.details.at(-1)[2];
 assert.match(html,/<dt>Last record<\/dt><dd>Target progress observed · 1s ago/);assert.doesNotMatch(html,/<dd>OLD_NATIVE_ACTION · 1s ago/);assert.match(html,/data-map-event="target-progress"/);
});

test('replay compact stations suppress future native task titles while keeping captured actions and replay qualifiers',t=>{
 const f=fixture(t),records=[event('result','tool.end',-1000,{label:'exec · result recorded'})],session={...sessions[0],taskLabel:'FUTURE_TASK_SENTINEL',taskLabelSource:'native-thread-name',taskLabelUpdatedAt:new Date(reference+1000).toISOString()};
 f.view.update(graph(records,{sessions:[session]}),{...options,mode:'replay'});const html=workerHTML(f.view);assert.doesNotMatch(f.view.nodes.innerHTML,/FUTURE_TASK_SENTINEL/);assert.match(html,/data-worker-state="replay"/);assert.match(html,/Tool batch/);assert.match(html,/Captured/);
 f.view.update(graph(records,{sessions:[{...session,taskLabel:'Captured assignment',taskLabelUpdatedAt:new Date(reference-2000).toISOString()}]}),{...options,mode:'replay'});assert.match(workerHTML(f.view),/Captured assignment/);
});

test('compact worker and route observation labels mark a feed gap unknown while retaining the actual captured action',t=>{
 const f=fixture(t),g=graph([event('result','tool.end',-1000,{label:'exec · result recorded'})]);f.view.update(g,{...options,observationGap:true});
 const html=workerHTML(f.view);assert.match(html,/data-worker-state="unknown"/);assert.match(html,/Feed unknown/);assert.match(html,/Tool batch/);assert.match(f.view.svg.innerHTML,/data-route-state="unknown"/);assert.match(f.view.svg.innerHTML,/state-unknown/);assert.equal(f.layer.dataset.recentRoutes,'0');
});

test('a new result cannot promote its old outbound route into the recent foreground',t=>{
 const f=fixture(t),g=graph([event('old-start','tool.start',-120000,{callId:'C'}),event('new-result','tool.end',-1000,{callId:'C'})]);f.view.update(g,options);
 assert.equal(f.layer.dataset.recentRoutes,'1');assert.equal(f.layer.dataset.retainedRoutes,'1');assert.match(f.view.svg.innerHTML,/outbound[^>]*data-route-state="retained"/);assert.match(f.view.svg.innerHTML,/return[^>]*data-route-state="recent"/);assert.match(f.view.svg.innerHTML,/state-retained/);assert.match(f.view.svg.innerHTML,/state-recent/);
});

test('recent route counters count current-window source records rather than accumulated historical records',t=>{
 const f=fixture(t),events=[...Array.from({length:25},(_,i)=>event('old-'+i,'tool.end',-120000-i*1000)),event('fresh','tool.end',-1000)],g=graph(events);f.view.update(g,options);
 assert.equal(f.layer.dataset.recentRoutes,'1');const recent=f.view.svg.innerHTML.match(/<g class="topology-route return[^>]*data-route-state="recent"[^>]*>[\s\S]*?<text[^>]*>([^<]*)<\/text>/);assert.ok(recent,'The recent return route has a visible record counter');assert.equal(recent[1],'1');
});

test('history emphasis toggles preserve inspectable old curves focus and live arrival progress',t=>{
 const f=fixture(t),g=graph([event('old-start','tool.start',-120000,{callId:'C'}),event('fresh-result','tool.end',-1000,{callId:'C'})]),fresh=new Set(['fresh-result']),arrivals=new Map([['fresh-result',reference]]);
 f.view.update(g,options);assert.equal(typeof f.view.setHistory,'function');assert.equal(f.layer.dataset.showHistory,'false');assert.ok(['quiet','muted'].includes(f.view.world.dataset.history));
 const retained=f.view.layout.routes.find(route=>route.kind==='outbound'),selector=`[data-map-route="${retained.id}"]`;f.view.svg.querySelector(selector).focus();
 f.view.draw(f.ctx,reference+600,drawing(fresh,arrivals));assert.equal(f.canvas.dataset.packetCount,'1');const before=f.ctx.translations[0];
 f.view.setHistory(true);assert.equal(f.layer.dataset.showHistory,'true');assert.equal(f.view.world.dataset.history,'shown');assert.equal(globalThis.document.activeElement.dataset.mapRoute,retained.id);assert.match(f.view.svg.innerHTML,/data-route-state="retained"/);
 f.view.setHistory(false);assert.equal(f.layer.dataset.showHistory,'false');assert.ok(['quiet','muted'].includes(f.view.world.dataset.history));assert.ok(f.view.layout.routes.some(route=>route.id===retained.id));assert.equal(globalThis.document.activeElement.dataset.mapRoute,retained.id);
 f.view.draw(f.ctx,reference+1800,drawing(fresh,arrivals));assert.equal(f.canvas.dataset.packetCount,'1');const back=f.view.animatedLegs.find(item=>item.leg.eventId==='fresh-result'),p=topologyPoint(back.curve,.75);samePoint(f.ctx.translations[0],[p[0]*f.view.scale-f.layer.scrollLeft,p[1]*f.view.scale-f.layer.scrollTop]);assert.notDeepEqual(before,f.ctx.translations[0]);
});

test('cached observed geometry avoids all layout reads during motion while resize and scrolling keep marker alignment',t=>{
 const f=fixture(t,{observeResize:true}),g=graph([event('start','tool.start',-1000)]),fresh=new Set(['start']),arrivals=new Map([['start',reference]]);
 f.view.update(g,{...options,preferences:{...options.preferences,fontSize:16}});const oldCurve=f.view.animatedLegs[0].curve;
 for(const target of [f.layer,f.canvas])for(const key of ['clientWidth','clientHeight'])Object.defineProperty(target,key,{get(){throw new Error('Paint must not read '+key);}});
 globalThis.getComputedStyle=()=>{throw new Error('Paint must not read computed style');};
 f.view.draw(f.ctx,reference+600,drawing(fresh,arrivals,{viewport:{width:900,height:480,dpr:1}}));
 const cached=f.view.activeLegCache.items;f.view.draw(f.ctx,reference+800,drawing(fresh,arrivals,{viewport:{width:900,height:480,dpr:1}}));assert.equal(f.view.activeLegCache.items,cached);
 f.resize(1100,540);f.layer.scrollLeft=25;f.layer.scrollTop=12;f.layer.handlers.get('scroll')();
 f.view.draw(f.ctx,reference+1800,drawing(fresh,arrivals,{viewport:{width:1100,height:540,dpr:2}}));
 assert.notDeepEqual(f.view.animatedLegs[0].curve,oldCurve);assert.equal(f.view.viewportWidth,1100);assert.equal(f.view.viewportHeight,540);
 const p=topologyPoint(f.view.animatedLegs[0].curve,.75);samePoint(f.ctx.translations[0],[p[0]*f.view.scale+f.view.viewGeometry.x-f.layer.scrollLeft,p[1]*f.view.scale+f.view.viewGeometry.y-f.layer.scrollTop]);
 f.view.update(g,{...options,preferences:{...options.preferences,fontSize:20}});assert.equal(f.view.layout.fontSize,20);
});

test('the overlay clears its last moving frame once and then sleeps without removing the retained evidence map',t=>{
 const f=fixture(t),g=graph([event('start','tool.start',-1000)]),fresh=new Set(['start']),arrivals=new Map([['start',reference]]),flags=drawing(fresh,arrivals);
 f.view.update(g,options);const evidence=f.view.svg.innerHTML;
 assert.equal(f.view.draw(f.ctx,reference+600,flags),true);assert.equal(f.ctx.clears,1);assert.equal(f.view.needsAnimation(reference+2400,flags),true,'The last frame still needs clearing');
 assert.equal(f.view.draw(f.ctx,reference+2400,flags),true);assert.equal(f.ctx.clears,2);assert.equal(f.canvas.dataset.packetCount,'0');
 assert.equal(f.view.needsAnimation(reference+2500,flags),false);for(let i=0;i<60;i++)assert.equal(f.view.draw(f.ctx,reference+2500+i*17,flags),false);
 assert.equal(f.ctx.clears,2);assert.equal(f.view.svg.innerHTML,evidence);
 assert.equal(f.view.draw(f.ctx,reference+4000,{...flags,viewport:{width:900,height:480,dpr:2}}),true,'A backing-scale change receives one clear');
 const resized=f.ctx.clears;assert.equal(f.view.draw(f.ctx,reference+4100,{...flags,viewport:{width:900,height:480,dpr:2}}),false);assert.equal(f.ctx.clears,resized);
 f.view.setView(false);f.view.setView(true);assert.equal(f.view.draw(f.ctx,reference+4200,{...flags,viewport:{width:900,height:480,dpr:2}}),true,'Returning from the ribbon clears any old Canvas pixels');assert.equal(f.view.svg.innerHTML,evidence);
});

test('pausing clears existing motion exactly once and suppresses token packets without changing their observed cursor',t=>{
 const f=fixture(t),g=graph([event('start','tool.start',-1000)]),fresh=new Set(['start']),arrivals=new Map([['start',reference]]);
 f.view.update(g,options);f.view.setTokenUsage(usagePayload(1),{now:reference});f.view.setTokenUsage(usagePayload(2),{now:reference+100});
 f.view.draw(f.ctx,reference+600,drawing(fresh,arrivals));assert.ok(Number(f.canvas.dataset.tokenPacketCount)>0);
 assert.equal(f.view.draw(f.ctx,reference+700,drawing(fresh,arrivals,{paused:true})),true);assert.equal(f.view.tokenMotion.cursor,2);assert.equal(f.canvas.dataset.tokenPacketCount,'0');
 const clears=f.ctx.clears;assert.equal(f.view.draw(f.ctx,reference+800,drawing(fresh,arrivals,{paused:true})),false);assert.equal(f.ctx.clears,clears);
});

test('one indexed source pass preserves the complete worker state machine across native and bound target evidence',t=>{
 const f=fixture(t),records=[...Array.from({length:1000},(_,i)=>event('retained-'+i,'tool.end',-120000-i,{sessionId:i%2?'child':'parent'})),
  event('turn','turn',-5000),event('request','approval',-4000,{requestId:'R'}),event('resolution','resolution',-3000,{requestId:'R'}),
  event('done','complete',-2000,{label:'Turn completed · acceptance unverified'}),event('late-tool','tool.end',-1000,{label:'MUST_NOT_REPLACE_COMPLETED_TURN'}),
  event('journey-only-child','tool.end',-1500,{sessionId:'child',label:'Journey-only child result'})];
 const g=graph(records),journeyOnly=g.records.find(record=>record.id==='journey-only-child');g.records=g.records.filter(record=>record!==journeyOnly);
 g.events=[{...event('bound-report','remote.progress',-500,{sessionId:'target-job',label:'Bound target progress',workerHostId:'source',workerSessionId:'child'}),hostId:'target'}];
 g.journeys.push({id:'unlinked-sentinel',from:'service:unrelated',to:'service:other',eventIds:[],legs:[],records:[event('not-linked','message',-1,{sessionId:'child',label:'UNLINKED_RECORD_SENTINEL'})],latestAt:reference-1});
 const workers=g.nodes.filter(node=>node.type==='worker'||node.type==='subagent'),expected=new Map(workers.map(node=>[node.id,workerActivity(node,g,options)]));
 let sourcePasses=0,eventPasses=0;const counted=(records,increment)=>new Proxy(records,{get(target,key,receiver){if(key===Symbol.iterator)return function(){increment();return target[Symbol.iterator]();};return Reflect.get(target,key,receiver);}});
 g.records=counted(g.records,()=>sourcePasses++);g.events=counted(g.events,()=>eventPasses++);f.view.update(g,options);
 assert.equal(sourcePasses,1);assert.equal(eventPasses,1);
 for(const node of workers){const state=expected.get(node.id),html=decode(workerHTML(f.view,node.id));assert.ok(html.includes(state.action),state.action);assert.ok(html.includes(state.label),state.label);assert.ok(html.includes(state.detail),state.detail);assert.match(html,new RegExp('data-worker-state="'+state.kind+'"'));}
 assert.match(workerHTML(f.view),/<em>Turn completed · unverified/);assert.equal(expected.get('worker:source/parent').eventId,'done');
 assert.match(workerHTML(f.view,'worker:source/child'),/Bound target progress/);assert.doesNotMatch(f.view.nodes.innerHTML,/UNLINKED_RECORD_SENTINEL/);
});

test('indexed worker candidates preserve node-last-event precedence over equal-time journey-only variants',t=>{
 const f=fixture(t),g=graph([event('same-identity','tool.end',-1000,{label:'Journey variant'})]),node=g.nodes.find(node=>node.id==='worker:source/parent');
 g.records=[];node.lastEvent={...node.lastEvent,label:'NODE_LAST_EVENT_PRECEDENCE'};
 const expected=workerActivity(node,g,options);assert.equal(expected.action,'NODE_LAST_EVENT_PRECEDENCE');f.view.update(g,options);
 assert.match(workerHTML(f.view),/NODE_LAST_EVENT_PRECEDENCE/);
});

test('palette and theme changes update all token encodings without moving stations or reminting observed packets',t=>{
 const f=fixture(t),g=graph([event('start','tool.start',-1000)]);f.view.update(g,options);f.view.setTokenUsage(usagePayload(1),{now:reference});f.view.setTokenUsage(usagePayload(2),{now:reference+100});
 const coordinates=f.view.layout.nodes.map(actor=>[actor.node.id,actor.x,actor.y]),packetIds=f.view.tokenMotion.packets.map(packet=>packet.id);
 for(const name of ['semantic','coins'])for(const theme of ['dark','light']){
  const palette=getTokenPalette(name,theme);f.view.update(g,{...options,preferences:{...options.preferences,tokenPalette:name,theme},tokenPalette:palette});f.view.setTokenUsage(usagePayload(2),{now:reference+500});
  assert.deepEqual(f.view.layout.nodes.map(actor=>[actor.node.id,actor.x,actor.y]),coordinates);assert.deepEqual(f.view.tokenMotion.packets.map(packet=>packet.id),packetIds);assert.equal(f.view.tokenMotion.cursor,2);
  for(const series of palette.legend){assert.ok(f.view.svg.innerHTML.includes('stroke:'+series.color+';stroke-dasharray:'+(series.dash||'none')));assert.ok(f.view.svg.innerHTML.includes(series.glyph+' / '+series.colorName));}
  assert.match(f.view.svg.innerHTML,/not money, credits or network transfers/);f.view.selectTokenUsage();assert.ok(f.details.at(-1)[2].includes(palette.series.input.colorName+' · new input'));f.view.draw(f.ctx,reference+600,drawing());assert.ok(Number(f.canvas.dataset.tokenPacketCount)>0);
 }
 f.view.draw(f.ctx,reference+4000,drawing());assert.equal(f.canvas.dataset.tokenPacketCount,'0');
 f.view.update(g,{...options,tokenPalette:getTokenPalette('semantic','dark')});f.view.setTokenUsage(usagePayload(2),{now:reference+4100});f.view.draw(f.ctx,reference+4200,drawing());assert.equal(f.canvas.dataset.tokenPacketCount,'0');assert.equal(f.view.tokenMotion.cursor,2);
});

test('keyed stations retain buttons emblem and label children through names status counts selection and geometry changes',t=>{
 const f=fixture(t),records=[event('first','tool.end',-2000)];f.view.update(graph(records),options);
 const id='worker:source/parent',row=f.view.stationNodes.get(id),button=row.element,emblem=row.emblem,copy=row.name.parentNode,children=[...copy.children],icon=row.symbol,badge=row.records,oldStyles=new Map([...f.view.stationNodes].map(([id,row])=>[id,row.element.getAttribute('style')]));button.focus();
 const renamed='Volta "A" <operator> & team',g=graph([...records,event('second','tool.end',-1000)],{sessions:[{...sessions[0],nickname:renamed},sessions[1]]});f.layer.clientWidth=1100;f.layer.clientHeight=540;
 f.view.update(g,{...options,reference:reference+1000,selectedEvent:'second',observationGap:true});
 assert.equal(f.view.stationNodes.get(id),row);assert.equal(row.element,button);assert.equal(row.emblem,emblem);assert.equal(row.name.parentNode,copy);assert.deepEqual(copy.children,children);assert.equal(row.symbol,icon);assert.equal(row.records,badge);assert.equal(globalThis.document.activeElement,button);
 assert.equal(row.name.textContent,renamed);assert.equal(button.dataset.workerState,'unknown');assert.equal(button.classList.contains('selected'),true);assert.match(row.status.textContent,/Feed unknown/);assert.equal(row.records.textContent,'2');assert.equal(row.records.getAttribute('title'),'2 directed source records');assert.match(button.getAttribute('aria-label'),/Volta "A" <operator> & team/);assert.doesNotMatch(button.innerHTML,/<operator>/);assert.match(button.innerHTML,/&lt;operator&gt; &amp; team/);
 const actor=f.view.layout.nodes.find(actor=>actor.node.id===id);assert.ok(button.getAttribute('style').startsWith(`left:${actor.x}px;top:${actor.y}px;`));assert.ok(f.view.layout.width>=1100);assert.ok([...f.view.stationNodes].some(([id,row])=>row.element.getAttribute('style')!==oldStyles.get(id)));
 f.view.update(g,{...options,reference:reference+2000,selectedEvent:'',mode:'replay'});assert.equal(row.element,button);assert.equal(button.classList.contains('selected'),false);assert.equal(button.dataset.workerState,'replay');assert.match(row.status.textContent,/Captured/);assert.equal(globalThis.document.activeElement,button);
});

test('station reconciliation restores deterministic order and retained focus and prunes removed identities',t=>{
 const f=fixture(t),g=graph([event('parent-record','tool.end',-2000),event('child-record','tool.end',-1000,{sessionId:'child'})]);f.view.update(g,options);
 const expected=()=>f.view.layout.nodes.filter(actor=>!actor.hidden).map(actor=>actor.node.id),retained=new Map([...f.view.stationNodes].map(([id,row])=>[id,row.element]));
 const focused=f.view.nodes.lastElementChild;f.view.nodes.insertBefore(focused,f.view.nodes.firstChild);focused.focus();f.view.update(g,options);
 assert.deepEqual(f.view.nodes.children.map(button=>button.dataset.mapNode),expected());assert.equal(globalThis.document.activeElement,focused);for(const [id,button] of retained)assert.equal(f.view.stationNodes.get(id).element,button);
 const removed=f.view.stationNodes.get('worker:source/child').element;removed.focus();f.view.update(graph([],{sessions:[sessions[0]]}),options);
 assert.equal(f.view.stationNodes.has('worker:source/child'),false);assert.equal(f.view.nodes.contains(removed),false);assert.equal(removed.parentNode,null);assert.notEqual(globalThis.document.activeElement,removed);assert.equal(f.view.stationNodes.size,expected().length);assert.deepEqual(f.view.nodes.children.map(button=>button.dataset.mapNode),expected());
 f.view.update(g,options);assert.notEqual(f.view.stationNodes.get('worker:source/child').element,removed);assert.equal(f.view.stationNodes.size,expected().length);
});

test('special station identifiers are exact map keys and native buttons keep delegated inspection behavior',t=>{
 const f=fixture(t),hostId='source"] <host> & \\',sessionId='worker\'s "id" [x] <tag>',label='<img src=x onerror="throw 1">',g=graph([event('special','tool.end',-1000,{hostId,sessionId})],{hosts:[{...hosts[0],id:hostId}],sessions:[{...sessions[0],hostId,id:sessionId,nickname:label}]});f.view.update(g,options);
 const id='worker:'+hostId+'/'+sessionId,row=f.view.stationNodes.get(id);assert.ok(row);assert.equal(row.element.dataset.mapNode,id);assert.equal(row.name.textContent,label);assert.equal(row.element.tagName,'BUTTON');assert.equal(row.element.getAttribute('role'),null);assert.equal(row.element.getAttribute('tabindex'),null);assert.doesNotMatch(f.view.nodes.innerHTML,/<img\b/);assert.match(f.view.nodes.innerHTML,/&lt;img/);
 row.element.focus();let prevented=false;f.layer.handlers.get('keydown')({target:row.element,key:'Enter',preventDefault(){prevented=true;}});assert.equal(prevented,false,'The native station button keeps its default keyboard activation');f.layer.handlers.get('click')({target:row.name});assert.ok(f.details.length);assert.equal(globalThis.document.activeElement,row.element);
 f.view.update(g,{...options,reference:reference+1000});assert.equal(f.view.stationNodes.get(id),row);assert.equal(globalThis.document.activeElement,row.element);
});

test('host progress and optional station badges update without replacing persistent station children',t=>{
 const f=fixture(t),g=graph([event('record','tool.end',-1000)]),host=g.nodes.find(node=>node.type==='host');host.progress=25;f.view.update(g,options);const row=f.view.stationNodes.get(host.id),button=row.element,emblem=row.emblem,copy=row.name.parentNode,progress=row.progress,fill=progress.firstElementChild,text=progress.lastElementChild;
 host.progress=150;f.view.update(g,{...options,reference:reference+1000});assert.equal(row.progress,progress);assert.equal(progress.firstElementChild,fill);assert.equal(progress.lastElementChild,text);assert.equal(fill.getAttribute('style'),'width:100%');assert.equal(text.textContent,'150% reported');assert.equal(row.element,button);assert.equal(row.emblem,emblem);assert.equal(row.name.parentNode,copy);
 delete host.progress;f.view.update(g,options);assert.equal(row.progress,null);assert.equal(progress.parentNode,null);assert.equal(row.element,button);
 const worker=f.view.stationNodes.get('worker:source/parent'),badge=worker.records;assert.ok(badge);const unlinked=graph([event('turn-only','turn',-1000,{category:'turn'})]);f.view.update(unlinked,options);assert.equal(f.view.stationNodes.get(host.id),row);assert.equal(row.element,button);assert.equal(f.view.stationNodes.get('worker:source/parent'),worker);assert.equal(worker.records,null);assert.equal(badge.parentNode,null);
});

test('same-input station updates perform zero subtree writes and retain every element identity',t=>{
 const f=fixture(t),g=graph([event('record','tool.end',-1000),event('child-record','tool.end',-2000,{sessionId:'child'})]);f.view.update(g,options);
 const elements=[f.view.nodes,...f.view.nodes.descendants()],before=new Map(elements.map(element=>[element,element.mutations])),buttons=f.view.nodes.children.slice();
 for(let i=0;i<20;i++)f.view.update(g,options);
 assert.deepEqual(f.view.nodes.children,buttons);assert.deepEqual(f.view.nodes.descendants(),elements.slice(1));for(const element of elements)assert.equal(element.mutations,before.get(element),element.name+' received an unchanged write');
});

test('journey strip skips unchanged replacement and preserves focus when selected content changes',t=>{
 const f=fixture(t),g=graph([event('record','tool.end',-1000)]),selectedEvent='record';f.view.update(g,{...options,selectedEvent});const button=f.journeyStrip.firstElementChild,writes=f.journeyStrip.mutations;button.focus();
 f.view.update(g,{...options,reference:reference+1000,selectedEvent});assert.equal(f.journeyStrip.firstElementChild,button);assert.equal(f.journeyStrip.mutations,writes);assert.equal(globalThis.document.activeElement,button);
 g.journeys[0].label='Changed <label> & detail';f.view.update(g,{...options,selectedEvent});const updated=f.journeyStrip.firstElementChild;assert.notEqual(updated,button);assert.equal(globalThis.document.activeElement,updated);assert.equal(updated.dataset.journey,g.journeys[0].id);assert.match(f.journeyStrip.innerHTML,/Changed &lt;label&gt; &amp; detail/);
 f.view.update(g,{...options,selectedEvent:''});assert.equal(f.journeyStrip.children.length,0);assert.notEqual(globalThis.document.activeElement,updated);
});


test('continuous zoom shares station and animated marker coordinates without rescanning the graph',t=>{
 const f=fixture(t),g=graph([event('zoom-start','tool.start',-1000)]),fresh=new Set(['zoom-start']),arrivals=new Map([['zoom-start',reference]]);
 f.view.update(g,options);const original=f.view.layout,version=f.view.layoutVersion,anchor={x:370,y:210};
 for(const zoom of [.5,1.2,2,3,1]){
  f.view.setZoom(zoom,anchor);assert.equal(f.view.layout,original);assert.equal(f.view.layoutVersion,version);assert.equal(f.view.zoomFactor,zoom);
  const v=f.view.viewGeometry;assert.equal(f.view.world.style.transform,`scale(${v.scale})`);assert.equal(f.view.world.style.left,v.x+'px');
  f.view.draw(f.ctx,reference+600,drawing(fresh,arrivals));
  const p=topologyPoint(f.view.animatedLegs[0].curve,.25),screen=[p[0]*v.scale+v.x-f.layer.scrollLeft,p[1]*v.scale+v.y-f.layer.scrollTop];
  if(screen[0]>=0&&screen[0]<=f.layer.clientWidth&&screen[1]>=0&&screen[1]<=f.layer.clientHeight)samePoint(f.ctx.translations[0],screen);
 }
 f.view.setZoom('fit');assert.equal(f.view.zoomFactor,1);assert.equal(f.layer.scrollLeft,0);assert.equal(f.layer.scrollTop,0);
});


test('unchanged zoom geometry never reads or rewrites scroll during a source update',t=>{
 const f=fixture(t),g=graph([event('zoom-stable','tool.start',-1000)]);f.view.update(g,options);const before=f.view.viewGeometry;
 for(const key of ['scrollLeft','scrollTop'])Object.defineProperty(f.layer,key,{get(){throw new Error('Source update must not read '+key);},set(){throw new Error('Source update must not rewrite '+key);}});
 f.view.update(g,{...options,reference:reference+1000});assert.equal(f.view.viewGeometry,before);assert.equal(f.view.layout.reference,reference+1000);
});

test('map preparation performs no presentation writes and prepared commit matches atomic rendering',t=>{const f=fixture(t),g=graph([event('start','tool.start',-2000),event('end','tool.end',-1000,{callId:'start'})]);const before=f.view.layer.innerHTML,prepared=f.view.prepareUpdate(g,options);assert.equal(f.view.layer.innerHTML,before);assert.equal(f.view.graph,null);f.view.update(g,options,prepared);const expected=f.view.layer.innerHTML,layout=f.view.layout;f.view.update(g,options);assert.equal(f.view.layer.innerHTML,expected);assert.deepEqual(f.view.layout,layout);});
test('a resized viewport invalidates prepared geometry before commit',t=>{const f=fixture(t),g=graph([event('start','tool.start',-1000)]),prepared=f.view.prepareUpdate(g,options);f.view.measuredViewport={width:700,height:350};f.view.update(g,options,prepared);assert.equal(f.view.viewportWidth,700);assert.equal(f.view.viewportHeight,350);const expected=f.view.layer.innerHTML;f.view.update(g,options);assert.equal(f.view.layer.innerHTML,expected);});

test('saved label preference keeps frozen replay identities focus selection and evidence intact',t=>{
 const f=fixture(t),g=graph([event('labels-start','tool.start',-2000),event('labels-end','tool.end',-1000,{callId:'labels-start'})]),records=JSON.stringify(g),initial={...options,mode:'replay',selectedEvent:'labels-end',preferences:{...options.preferences,planeLabels:'detailed'}};f.view.update(g,initial);
 const station=f.view.stationNodes.get('worker:source/parent'),button=station.element;button.focus();const aria=button.getAttribute('aria-label'),detail=station.detail.textContent,status=station.status.textContent,positions=f.view.layout.nodes.map(a=>[a.node.id,a.x,a.y]),routes=f.view.layout.routes.map(r=>[r.id,r.eventIds]);
 for(const labels of ['compact','detailed']){f.view.update(g,{...initial,preferences:{...initial.preferences,planeLabels:labels}});assert.equal(f.view.world.dataset.labels,labels);assert.equal(f.view.stationNodes.get('worker:source/parent'),station);assert.equal(station.element,button);assert.equal(globalThis.document.activeElement,button);assert.equal(button.getAttribute('aria-label'),aria);assert.equal(station.detail.textContent,detail);assert.equal(station.status.textContent,status);assert.equal(f.view.options.reference,reference);assert.equal(f.view.options.selectedEvent,'labels-end');assert.equal(f.view.options.mode,'replay');assert.equal(button.classList.contains('selected'),true);assert.deepEqual(f.view.layout.nodes.map(a=>[a.node.id,a.x,a.y]),positions);assert.deepEqual(f.view.layout.routes.map(r=>[r.id,r.eventIds]),routes);assert.equal(JSON.stringify(g),records);}
});
