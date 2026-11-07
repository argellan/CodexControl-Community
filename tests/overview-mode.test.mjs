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
import {overviewPresentation,overviewFramePlan,normalizePersonalSettings,validatePersonalSettings,captureLayout,applyLayout} from '../public/settings-view-model.mjs';
import {adaptiveOverviewMode} from '../public/mobile-workspace.mjs';
import {TokenMotion} from '../public/token-motion.mjs';
import {EventStore} from '../public/event-model.mjs';
const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
const now=Date.parse('2026-10-20T23:00:00Z');
function overviewContext(bindings){const context=vm.createContext({timelineNativeMotion:{items:new Map(),cancelAll(){}},...bindings,adaptiveOverviewMode,adaptiveViewport:{matches:false}});vm.runInContext(source.match(/^function activeOverview\(\).*$/m)[0],context);return context;}
function extract(start,end){const first=source.indexOf(start),last=source.indexOf(end,first);assert.ok(first>0&&last>first,start);return source.slice(first,last);}

test('overview is a strict persistent personal/named-layout preference with full as the legacy default',()=>{
 assert.equal(normalizePersonalSettings().overviewMode,'full');assert.equal(normalizePersonalSettings({overviewMode:'invalid'}).overviewMode,'full');assert.throws(()=>validatePersonalSettings({overviewMode:'installed-tray'}));
 for(const mode of ['full','compact','mini'])assert.equal(validatePersonalSettings({overviewMode:mode}).overviewMode,mode);
 const original={overviewMode:'mini',waterfallRatio:62.13048491019795,rightWidth:431.60009765625,tokenPalette:'coins'},saved=captureLayout(original,{id:'small',name:'Small monitor',now:new Date(now).toISOString()});assert.equal(saved.layouts[0].preferences.overviewMode,'mini');const restored=applyLayout({...saved,overviewMode:'full'},'small');for(const [key,value] of Object.entries(original))assert.equal(restored[key],value);
});

test('cached overview/frame policies separate visible animation from idle clocks without per-call allocations',()=>{
 const full=overviewPresentation(),compact=overviewPresentation('compact'),mini=overviewPresentation('mini');assert.equal(overviewPresentation('invalid'),full);assert.equal(overviewPresentation('mini'),mini);assert.equal(Object.isFrozen(mini),true);assert.equal(full.workers,true);assert.equal(compact.map,true);assert.equal(compact.timeline,false);assert.equal(mini.map,false);
 assert.equal(overviewFramePlan({mapMoving:true}).kind,'raf');assert.equal(overviewFramePlan({timelineMoving:true}).kind,'raf');assert.equal(overviewFramePlan({replayPlaying:true}).kind,'raf');assert.equal(overviewFramePlan({}).delayMs,50);assert.equal(overviewFramePlan({clockMilliseconds:false}).delayMs,1000);assert.equal(overviewFramePlan({mode:'mini',mapMoving:true,timelineMoving:true,replayPlaying:true}).delayMs,1000);assert.equal(overviewFramePlan({mode:'compact'}).delayMs,1000);assert.equal(overviewFramePlan({hidden:true,mapMoving:true}).kind,'none');assert.equal(overviewFramePlan({reduced:true,mapMoving:true}).kind,'timer');assert.equal(overviewFramePlan({paused:true,mapMoving:true}).kind,'timer');assert.equal(overviewFramePlan({}),overviewFramePlan({}));
});

test('mini frame does no hidden map/timeline work while preserving exact observed event state',()=>{
 const store=new EventStore();store.ingest({observedAt:new Date(now).toISOString(),sessions:[],events:[],hosts:[]});const plans=[],calls=[];
 const context=overviewContext({document:{hidden:false},settingsWorkspace:{isOpen:false},preferences:{overviewMode:'mini',clockMilliseconds:true},overviewPresentation,overviewFramePlan,store,frameHandle:null,frameSampleAt:0,framesInSample:0,canvas:{dataset:{}},lastFrame:0,motionPaused:false,reduced:false,lastClockPaint:0,lastRender:0,lastPaint:0,paintInvalidated:true,timelineInvalidated:true,geometry:{canvasVisible:true,timelineVisible:true},activityMap:{needsAnimation(){throw new Error('hidden map queried');}},timelineRows:new Map(),projectedEvents:[],paintedSpans:[],ref:()=>now,animateTimeline(){throw new Error('hidden timeline painted');},draw(){throw new Error('hidden map painted');},render(){},updateClocks(){calls.push('clock');},tickTicker(){},schedulePresentation(plan){plans.push(plan);}});
 vm.runInContext(extract('function frame(t){','initializeDisplay();'),context);context.frame(1000);assert.equal(plans[0].kind,'timer');assert.equal(plans[0].delayMs,1000);assert.deepEqual(calls,['clock']);assert.equal(store.events.size,0);assert.equal(store.newTotal,0);
 store.ingest({observedAt:new Date(now+1000).toISOString(),sessions:[],events:[{id:'new',hostId:'host',sessionId:'session',turnId:'turn',kind:'message',at:new Date(now+1000).toISOString(),label:'Recorded'}],hosts:[]});assert.equal(store.newTotal,1);context.frame(2000);assert.equal(store.events.size,1);assert.equal(store.newTotal,1);assert.equal(plans.length,2);
});

test('idle full view schedules dual-millisecond clock timers and skips static canvas/timeline repaint',()=>{
 const plans=[];let paints=0;const context=overviewContext({document:{hidden:false},settingsWorkspace:{isOpen:false},preferences:{overviewMode:'full',clockMilliseconds:true,flowView:'map'},overviewPresentation,overviewFramePlan,store:{mode:'live',advance(){}},frameHandle:null,frameSampleAt:0,framesInSample:0,canvas:{dataset:{}},lastFrame:0,motionPaused:false,reduced:false,lastClockPaint:0,lastRender:0,lastPaint:0,paintInvalidated:false,timelineInvalidated:false,geometry:{canvasVisible:true,timelineVisible:true},activityMap:{needsAnimation:()=>false},timelineRows:new Map(),projectedEvents:[],paintedSpans:[],mapFreshIds:new Set(),mapArrivals:new Map(),ref:()=>now,animateTimeline(){paints++;},draw(){paints++;},render(){},updateClocks(){},tickTicker(){},schedulePresentation(plan){plans.push(plan);}});
 vm.runInContext(extract('function frame(t){','initializeDisplay();'),context);context.frame(1000);assert.equal(paints,0);assert.equal(plans[0].delayMs,50);context.activityMap.needsAnimation=()=>true;context.frame(1050);assert.equal(paints,1);assert.equal(plans[1].kind,'raf');
});

test('stopped replay paints only invalidations at its fixed source clock, while play and live retain continuous motion',()=>{
 const plans=[];let mapPaints=0,timelinePaints=0;const context=overviewContext({document:{hidden:false},settingsWorkspace:{isOpen:false},preferences:{overviewMode:'full',clockMilliseconds:true,flowView:'map'},overviewPresentation,overviewFramePlan,store:{mode:'replay',playing:false,advance(){}},frameHandle:null,frameSampleAt:0,framesInSample:0,canvas:{dataset:{}},lastFrame:0,motionPaused:false,reduced:false,lastClockPaint:0,lastRender:0,lastPaint:0,paintInvalidated:true,timelineInvalidated:true,geometry:{canvasVisible:true,timelineVisible:true},activityMap:{needsAnimation:()=>true},timelineRows:new Map([['retained',{}]]),projectedEvents:[],paintedSpans:[],mapFreshIds:new Set(),mapArrivals:new Map(),ref:()=>now,animateTimeline(){timelinePaints++;context.timelineInvalidated=false;},draw(){mapPaints++;context.paintInvalidated=false;},render(){},updateClocks(){},tickTicker(){},schedulePresentation(plan){plans.push(plan);}});
 vm.runInContext(extract('function frame(t){','initializeDisplay();'),context);for(let i=0;i<60;i++)context.frame(1000+i*17);assert.equal(mapPaints,1);assert.equal(timelinePaints,1);assert.ok(plans.every(plan=>plan.kind==='timer'));
 context.paintInvalidated=context.timelineInvalidated=true;context.frame(3000);assert.equal(mapPaints,2);assert.equal(timelinePaints,2);context.store.playing=true;context.frame(3017);assert.equal(plans.at(-1).kind,'raf');assert.equal(mapPaints,3);context.store.mode='live';context.store.playing=false;context.frame(3034);assert.equal(plans.at(-1).kind,'raf');assert.equal(mapPaints,4);
});

test('replay paints its final advanced source clock once before sleeping at the end boundary',()=>{
 const store=new EventStore();store.ingest({observedAt:new Date(now+1000).toISOString(),sessions:[],hosts:[],events:[{id:'first',sessionId:'TEST_ONLY-session',kind:'message',at:new Date(now).toISOString()},{id:'last',sessionId:'TEST_ONLY-session',kind:'message',at:new Date(now+1000).toISOString()}]});store.enterReplay(now);assert.equal(store.events.size,2);store.playing=true;
 const plans=[],paints=[],renders=[];const context=overviewContext({document:{hidden:false},settingsWorkspace:{isOpen:false},preferences:{overviewMode:'full',clockMilliseconds:true,flowView:'map'},overviewPresentation,overviewFramePlan,store,frameHandle:null,frameSampleAt:0,framesInSample:0,canvas:{dataset:{}},lastFrame:0,motionPaused:false,reduced:false,lastClockPaint:0,lastRender:0,lastPaint:0,paintInvalidated:false,timelineInvalidated:false,geometry:{canvasVisible:true,timelineVisible:true},activityMap:{needsAnimation:()=>true},timelineRows:new Map([['retained',{}]]),projectedEvents:[],paintedSpans:[],mapFreshIds:new Set(),mapArrivals:new Map(),ref:()=>store.clock,animateTimeline(){context.timelineInvalidated=false;},draw(){paints.push(store.clock);context.paintInvalidated=false;},render(){renders.push(store.clock);},updateClocks(){},tickTicker(){},schedulePresentation(plan){plans.push(plan);}});
 vm.runInContext(extract('function frame(t){','initializeDisplay();'),context);context.frame(1200);assert.equal(store.playing,false);assert.deepEqual(paints,[now+1000]);assert.deepEqual(renders,[now+1000]);assert.equal(plans.at(-1).kind,'timer');context.frame(1250);assert.equal(paints.length,1);
});

test('ticker overflow follows observed intrinsic widths and motion preferences without synchronous layout reads',()=>{
 let callback,scrolling=false;const clip={},label={style:{},parentElement:clip},ticker={classList:{toggle(name,value){assert.equal(name,'scrolling');scrolling=value;}}};for(const node of [label,clip])for(const property of ['scrollWidth','clientWidth'])Object.defineProperty(node,property,{get(){throw new Error('Synchronous layout read');}});
 const nodes={'ticker-label':label,ticker},observed=[],context=overviewContext({$:id=>nodes[id],preferences:{tickerMotion:true},reduced:false,motionPaused:false,ResizeObserver:class{constructor(fn){callback=fn;}observe(node){observed.push(node);}}});vm.runInContext(extract('const tickerGeometry=','function renderTicker('),context);assert.equal(label.style.width,'max-content');assert.deepEqual(observed,[label,clip]);callback([{target:clip,contentRect:{width:200}},{target:label,contentRect:{width:600}}]);assert.equal(scrolling,true);context.reduced=true;context.syncTickerMotion();assert.equal(scrolling,false);context.reduced=false;callback([{target:clip,contentRect:{width:800}}]);assert.equal(scrolling,false);callback([{target:label,contentRect:{width:900}}]);assert.equal(scrolling,true);context.motionPaused=true;context.syncTickerMotion();assert.equal(scrolling,false);
});

test('presentation scheduler coalesces animation wakeups, cancels idle timers and sleeps when the document is hidden',()=>{
 let next=0;const timers=new Map(),raf=new Map(),context=overviewContext({document:{hidden:false},frameHandle:null,idleFrameTimer:null,frame(){},performance:{now:()=>0},setTimeout(fn,delay){timers.set(++next,{fn,delay});return next;},clearTimeout(id){timers.delete(id);},requestAnimationFrame(fn){raf.set(++next,fn);return next;}});
 vm.runInContext(extract('function requestFrame(){',"matchMedia('(prefers-reduced-motion: reduce)')"),context);context.schedulePresentation({kind:'timer',delayMs:50});context.schedulePresentation({kind:'timer',delayMs:50});assert.equal(timers.size,1);context.requestFrame();context.requestFrame();assert.equal(timers.size,0);assert.equal(raf.size,1);context.schedulePresentation({kind:'timer',delayMs:50});assert.equal(timers.size,0);context.document.hidden=true;context.schedulePresentation({kind:'raf'});assert.equal(raf.size,1);
});

test('hidden overview consumes token watermarks without rebuilding SVG, and return never remints retained batches',()=>{
 const motion=new TokenMotion(),context=overviewContext({preferences:{overviewMode:'full'},overviewPresentation,activityMap:{tokenMotion:motion,setTokenUsage(payload,options){motion.feed(payload,options);}},tokenUsagePayload:null,tokenUsageScope:'scope',usageScope:()=>'scope',Date:class extends Date{static now(){return now;}},store:{mode:'live',disconnectedAt:null},reduced:false,motionPaused:false});
 vm.runInContext(extract('function syncTokenUsage(){','\nfunction windowGaps('),context);
 const payload=sequence=>({burnUsage:{epoch:'TEST_ONLY',lastSequence:sequence},usageHistory:{observations:[{id:'observation-'+sequence,sequence,status:'delta',hostId:'host',sessionId:'session',provider:'openai',receivedAt:new Date(now).toISOString(),sourceAt:new Date(now).toISOString(),uncachedInputTokens:20,outputTokens:10,cachedInputTokens:10}]}});
 context.tokenUsagePayload=payload(1);context.syncTokenUsage();assert.equal(motion.cursor,1);context.preferences.overviewMode='mini';context.activityMap.setTokenUsage=()=>{throw new Error('hidden SVG rebuilt');};context.tokenUsagePayload=payload(2);context.syncTokenUsage();assert.equal(motion.cursor,2);assert.equal(motion.packets.length,0);
 context.preferences.overviewMode='full';context.activityMap.setTokenUsage=(value,options)=>motion.feed(value,options);context.syncTokenUsage();assert.equal(motion.cursor,2);assert.equal(motion.packets.length,0);context.tokenUsagePayload=payload(3);context.syncTokenUsage();assert.ok(motion.packets.length>0);assert.ok(motion.packets.every(packet=>packet.sequence===3));
});

test('settings defers covered presentation only, retains new source events, and catches up elapsed replay on return',()=>{
 const store=new EventStore(),event=(id,offset)=>({id,hostId:'TEST_ONLY-host',sessionId:'TEST_ONLY-session',kind:'message',at:new Date(now+offset).toISOString()});
 store.ingest({observedAt:new Date(now).toISOString(),hosts:[],sessions:[],events:[event('first',0),event('last',10000)]});store.enterReplay(now);store.playing=true;
 const plans=[],paints=[],context=overviewContext({document:{hidden:false},settingsWorkspace:{isOpen:false},preferences:{overviewMode:'full',clockMilliseconds:true,flowView:'map'},overviewPresentation,overviewFramePlan,store,frameHandle:null,frameSampleAt:0,framesInSample:0,canvas:{dataset:{}},lastFrame:0,motionPaused:false,reduced:false,lastClockPaint:0,lastRender:0,lastPaint:0,paintInvalidated:true,timelineInvalidated:true,geometry:{canvasVisible:true,timelineVisible:true},activityMap:{needsAnimation:()=>true},timelineRows:new Map(),projectedEvents:[],paintedSpans:[],mapFreshIds:new Set(),mapArrivals:new Map(),ref:()=>store.clock,animateTimeline(){context.timelineInvalidated=false;},draw(){paints.push(store.clock);context.paintInvalidated=false;},render(){},updateClocks(){},tickTicker(){},schedulePresentation(plan){plans.push(plan);}});
 vm.runInContext(extract('function frame(t){','initializeDisplay();'),context);context.frame(1000);assert.equal(store.clock,now+1000);const beforePaints=paints.length,beforePlans=plans.length;
 context.settingsWorkspace.isOpen=true;store.ingest({observedAt:new Date(now+6000).toISOString(),hosts:[],sessions:[],events:[event('arrived-behind-settings',6000)]});context.frame(6000);assert.equal(paints.length,beforePaints);assert.equal(plans.length,beforePlans);assert.equal(store.events.size,3);assert.deepEqual(store.viewEvents().map(e=>e.id),['first','last']);assert.equal(store.clock,now+1000);
 context.settingsWorkspace.isOpen=false;context.frame(7000);assert.equal(store.clock,now+7000);assert.equal(store.events.size,3);assert.equal(store.events.get('arrived-behind-settings').at,new Date(now+6000).toISOString());assert.ok(paints.length>beforePaints);assert.equal(plans.at(-1).kind,'raf');
});

test('covered Settings mode and named-layout changes preserve elapsed replay and motion pause boundaries',()=>{
 const event=offset=>({id:'TEST_ONLY-'+offset,sessionId:'TEST_ONLY-session',kind:'message',at:new Date(now+offset).toISOString()});
 function scenario({paused=false,changePause=false,mode='compact'}={}){
  const store=new EventStore();store.ingest({observedAt:new Date(now+60000).toISOString(),hosts:[],sessions:[],events:[event(0),event(60000)]});store.enterReplay(now);store.playing=true;
  let time=0;const context=overviewContext({store,document:{hidden:false,documentElement:{dataset:{}}},settingsWorkspace:{isOpen:false},preferences:{overviewMode:'full',clockMilliseconds:true,flowView:'map',theme:'dark',motionMode:paused?'paused':'full'},normalizePreferences:p=>p,overviewPresentation,overviewFramePlan,presentationMotion:p=>({paused:p.motionMode==='paused',reduced:false}),performance:{now:()=>time},matchMedia:()=>({matches:false}),appliedOverview:'full',root:{dataset:{}},frameHandle:null,frameSampleAt:0,framesInSample:0,canvas:{dataset:{}},lastFrame:0,motionPaused:paused,reduced:false,pausedAt:0,lastClockPaint:0,lastRender:0,lastPaint:0,paintInvalidated:false,timelineInvalidated:false,geometry:{canvasVisible:true,timelineVisible:true},activityMap:{needsAnimation:()=>false,tokenMotion:{clear(){}}},timelineRows:new Map(),projectedEvents:[],paintedSpans:[],mapFreshIds:new Set(),mapArrivals:new Map(),pulseEligible:new Set(),ref:()=>store.clock,animateTimeline(){},draw(){},render(){},updateClocks(){},tickTicker(){},schedulePresentation(){},requestFrame(){}});
  vm.runInContext(extract('function frame(t){','initializeDisplay();'),context);
  const apply=extract('function applyPreferences(persist=true){',"$('motion').textContent=");vm.runInContext(apply+'}',context);
  time=1000;context.frame(time);context.settingsWorkspace.isOpen=true;time=10000;context.frame(time);
  context.preferences={...context.preferences,overviewMode:mode,motionMode:changePause?(paused?'full':'paused'):context.preferences.motionMode};context.applyPreferences(false);
  time=20000;context.settingsWorkspace.isOpen=false;context.frame(time);
  assert.equal(store.events.size,2);assert.equal(store.events.get('TEST_ONLY-60000').at,new Date(now+60000).toISOString());return store.clock-now;
 }
 assert.equal(scenario(),20000);assert.equal(scenario({mode:'mini'}),20000);assert.equal(scenario({mode:'full'}),20000);
 assert.equal(scenario({changePause:true}),10000);assert.equal(scenario({paused:true}),0);assert.equal(scenario({paused:true,changePause:true}),10000);
});

test('mini transitions clear transient arrivals only and lazy evidence skips span construction until a visible consumer needs it',()=>{
 const block=extract('const overview=activeOverview();root.dataset.overview=',"const motion=presentationMotion(preferences,matchMedia('(prefers-reduced-motion: reduce)')");let cleared=0,woken=0;const events=new Map([['retained',{id:'retained'}]]),context=overviewContext({overviewPresentation,preferences:{overviewMode:'mini'},root:{dataset:{}},appliedOverview:'full',mapFreshIds:new Set(['arrival']),mapArrivals:new Map([['arrival',now]]),pulseEligible:new Set(['arrival']),activityMap:{tokenMotion:{clear(){cleared++;}}},performance:{now:()=>123},lastFrame:0,paintInvalidated:false,timelineInvalidated:false,requestFrame(){woken++;},events});vm.runInContext('(()=>{'+block+'})()',context);assert.equal(context.mapFreshIds.size,0);assert.equal(context.mapArrivals.size,0);assert.equal(context.pulseEligible.size,0);assert.equal(events.size,1);assert.equal(cleared,1);assert.equal(woken,1);
 let spans=0;const store=new EventStore();store.events.set('event',{id:'event',hostId:'host',sessionId:'session',at:new Date(now).toISOString()});const cache=overviewContext({store,eventTime:e=>Date.parse(e.at),eventKey:e=>e.hostId+'/'+e.sessionId,buildSpans(){spans++;return [];}});vm.runInContext(extract('let sourceEventCache=','\nlet recoveryCursor='),cache);cache.renderEvidence(now,false);assert.equal(spans,0);cache.renderEvidence(now);assert.equal(spans,1);cache.renderEvidence(now+1);assert.equal(spans,1);
});
