// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAccountUsageView,renderAccountUsageDetails,normalizeSpendingAdvisory,renderSpendingAdvisory,mountAccountUsage} from '../public/account-usage.mjs';

const now=Date.parse('2026-10-25T16:00:00Z');
const reading=(overrides={})=>({schemaVersion:1,mode:'ADVISORY',familyId:'TEST_ONLY-family',state:'OBSERVING',stopped:false,
 reason:null,nativeDispatchEnforcement:'UNSUPPORTED',providerAccountSpendingGuarantee:false,modelStepInterruption:false,
 evaluatedAt:new Date(now).toISOString(),limitsObservedAt:new Date(now-1000).toISOString(),deadlineMs:now+300000,
 weeklyIncreasePoints:1,weeklyPointBudget:5,tokenBudget:null,spent:null,reserved:0,nativeReserved:null,remaining:null,
 unknown:true,coverage:{complete:false},...overrides});
const slot=(value=reading(),state='available')=>({state,value});
const account=()=>({viewer:{id:'owner',username:'TEST_ONLY-owner',label:'TEST_ONLY Owner',role:'admin'},capabilities:{authenticated:true}});
const usage=()=>({observedAt:new Date(now).toISOString(),accountUsage:{status:'available',accounts:[]},burnUsage:{status:'unavailable'}});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function requester(status,meta=account){
 return async(route,options)=>route==='/api/account'?meta():route==='/api/account/spending-status'?status(options):
  route.startsWith('/api/account/allowance-history')?{status:'unavailable',points:[]}:usage();
}

function fixture(request,options={}){
 const nodes=new Map();let active=null;
 function element(id){return {id,innerHTML:'',textContent:'',disabled:false,hidden:false,isConnected:true,open:false,dataset:{},listeners:new Map(),attributes:{},addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);},removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);},setAttribute(key,value){this.attributes[key]=value;},querySelector(selector){return this.children?.[selector]||null;},querySelectorAll(){return [];},focus(){active=this;},showModal(){this.open=true;},close(){this.open=false;for(const fn of this.listeners.get('close')||[])fn();},emit(type,event={}){return Promise.all([...(this.listeners.get(type)||[])].map(fn=>fn(event)));}};}
 for(const id of ['account-usage-strip','profile-open','profile-dialog','profile-content','account-usage-dialog','account-usage-content','account-refresh-status','usage-open','refresh','account-usage-refresh'])nodes.set(id,element(id));
 nodes.get('profile-open').children={'[data-profile-label]':element('label'),'[data-profile-name]':element('name')};
 for(const id of ['profile-dialog','account-usage-dialog'])nodes.get(id).children={'[data-account-close]':element(id+'-close')};
 const document=element('document');document.hidden=false;document.getElementById=id=>nodes.get(id);Object.defineProperty(document,'activeElement',{get:()=>active});const window=element('window');let destination=null,section=null,retained=0;
 const mounted=mountAccountUsage({document,window,request,now:()=>now,navigate:path=>{destination=path;},openSettings:value=>{section=value;},openRetained:()=>{retained++;},...options});
 return {nodes,document,window,mounted,get destination(){return destination;},get section(){return section;},get retained(){return retained;},action:async(dialog,action)=>{const button=element(action);button.dataset={accountAction:action};await nodes.get(dialog).emit('click',{target:{closest:()=>button}});return button;}};
}

test('compact advisory text reports observation and unsupported enforcement without a fake token balance',()=>{
 const view=normalizeSpendingAdvisory(slot(),{now}),html=renderSpendingAdvisory(view);
 assert.equal(view.kind,'observing');assert.match(html,/Spending advisory · Observing/);assert.match(html,/Weekly \+1 \/ 5 points/);
 assert.match(html,/Cannot stop Codex or cap spending/);assert.match(html,/token history incomplete/);
 assert.doesNotMatch(html,/0 tokens|100%|safe to|spending enforced|<button/);
 assert.match(html,/role="note"/);assert.doesNotMatch(html,/aria-live/);
});
test('stop and closeout recommendations include the recorded human-readable cause',()=>{
 for(const [state,reason,label] of [['STOP_RECOMMENDED','WEEKLY_LIMIT','Stop recommended'],['CLOSEOUT_RECOMMENDED','CLOSEOUT_WEEKLY_RESERVED','Closeout recommended']]){
  const value=reading({state,stopped:state==='STOP_RECOMMENDED',reason});
  const html=renderSpendingAdvisory(normalizeSpendingAdvisory(slot(value),{now}));
  assert.ok(html.includes(label));assert.match(html,/account-status-warning/);assert.doesNotMatch(html,/WEEKLY_LIMIT|CLOSEOUT_WEEKLY_RESERVED/);
 }
});
test('loading, unavailable and restricted states contain no fabricated readings',()=>{
 for(const state of ['loading','failed','restricted','idle']){
  const html=renderSpendingAdvisory(normalizeSpendingAdvisory({state,value:null},{now}));
  assert.doesNotMatch(html,/Weekly \+0|Deadline|NaN|Invalid Date/);
  assert.match(html,/Cannot stop Codex or cap spending/);
 }
 assert.doesNotMatch(renderSpendingAdvisory(),/NaN|Invalid Date/);
});
test('missing, malformed or stronger enforcement claims cannot become an observing state',()=>{
 for(const patch of [{mode:'ENFORCED'},{nativeDispatchEnforcement:'SUPPORTED'},{providerAccountSpendingGuarantee:true},
  {modelStepInterruption:true},{coverage:{complete:true}},{evaluatedAt:new Date(now+1).toISOString()},
  {weeklyPointBudget:null},{weeklyIncreasePoints:-1},{deadlineMs:null},{stopped:true}]){
  assert.equal(normalizeSpendingAdvisory(slot(reading(patch)),{now}).kind,'unavailable');
 }
});
test('failed and aged reads retain an explicit stale last recommendation',()=>{
 const raw=reading({state:'STOP_RECOMMENDED',stopped:true,reason:'OWNER_STOP'});
 for(const [read,clock] of [[slot(raw,'failed'),now],[slot(raw),now+60001]]){
  const view=normalizeSpendingAdvisory(read,{now:clock}),html=renderSpendingAdvisory(view);
  assert.equal(view.kind,'stale');assert.match(html,/Stale · last reading: Stop recommended/);assert.match(html,/Refresh readings/);
 }
});
test('limits source age is independent of evaluation time and a current stop survives unknown source time',()=>{
 assert.equal(normalizeSpendingAdvisory(slot(reading({limitsObservedAt:new Date(now-120001).toISOString()})),{now}).kind,'stale');
 const view=normalizeSpendingAdvisory(slot(reading({state:'STOP_RECOMMENDED',stopped:true,reason:'TELEMETRY_STALE_OR_UNKNOWN',limitsObservedAt:null})),{now});
 assert.equal(view.kind,'stop');assert.match(renderSpendingAdvisory(view),/Usage source stale or unavailable/);
});
test('elapsed deadline recommends stopping without claiming the server latched it',()=>{
 const view=normalizeSpendingAdvisory(slot(reading({deadlineMs:now-1})),{now});
 assert.equal(view.kind,'stop');assert.match(view.reason,/since the last reading/);
});
test('refreshing preserves a prior stop and provides pending feedback',()=>{
 const view=normalizeSpendingAdvisory(slot(reading({state:'STOP_RECOMMENDED',stopped:true}),'refreshing'),{now});
 assert.equal(view.kind,'stop');assert.match(view.label,/Stop recommended · refreshing/);
});
test('restricted account views discard cached advisory values and untrusted cause strings are never echoed',()=>{
 const raw=reading({weeklyIncreasePoints:4.25,reason:'<img src=x onerror=alert(1)>',familyId:'PRIVATE_FAMILY'});
 const view=buildAccountUsageView({accountUsage:{status:'restricted'},spendingAdvisory:slot(raw)},{now});
 const html=renderAccountUsageDetails(view);
 assert.doesNotMatch(html,/4\.25|PRIVATE_FAMILY|onerror|<img/);assert.match(html,/Administrator access required/);
 const normal=renderSpendingAdvisory(normalizeSpendingAdvisory(slot(raw),{now}));
 assert.doesNotMatch(normal,/onerror|<img/);
});
test('closed dialog makes no advisory request; open reads share existing detail cadence and emit no usage activity',async()=>{
 let clock=now,calls=0,observations=0;
 const f=fixture(requester(async()=>{calls++;return reading();}),{now:()=>clock,onUsage:()=>observations++});
 try{
  await f.mounted.ready;assert.equal(calls,0);const prior=observations;
  f.mounted.openUsage();await flush();assert.equal(calls,1);assert.equal(observations,prior);
  await f.mounted.refreshDetails();assert.equal(calls,1);
  clock+=15000;await f.mounted.refresh();await flush();assert.equal(calls,2);
  f.nodes.get('account-usage-dialog').close();clock+=30000;await f.mounted.refresh();await f.mounted.refreshDetails();assert.equal(calls,2);
 }finally{f.mounted.destroy();}
});
test('scoped viewers, anonymous clients and unknown identity do not request account-wide advisory data',async()=>{
 for(const meta of [{viewer:{id:'viewer',role:'viewer'},capabilities:{authenticated:true}},
  {viewer:{id:'owner',role:'admin'},capabilities:{authenticated:false}},
  {viewer:{role:'admin'},capabilities:{authenticated:true}}]){
  let calls=0;const f=fixture(requester(async()=>{calls++;return reading();},()=>meta));
  try{await f.mounted.ready;f.mounted.openUsage();await flush();assert.equal(calls,0);}finally{f.mounted.destroy();}
 }
});
test('manual refresh forces a same-clock advisory read and failures keep the last state explicitly stale',async()=>{
 let calls=0,fail=false;
 const f=fixture(requester(async()=>{calls++;if(fail)throw Object.assign(new Error('PRIVATE_FAILURE'),{status:503});return reading();}));
 try{
  await f.mounted.ready;f.mounted.openUsage();await flush();assert.equal(calls,1);
  fail=true;await f.nodes.get('account-usage-refresh').emit('click');await flush();assert.equal(calls,2);
  const html=f.nodes.get('account-usage-content').innerHTML;assert.match(html,/Stale · last reading: Observing/);assert.doesNotMatch(html,/PRIVATE_FAILURE/);
 }finally{f.mounted.destroy();}
});
test('not-configured response becomes unavailable without breaking the existing usage details',async()=>{
 const f=fixture(requester(async()=>{throw Object.assign(new Error('PRIVATE_NOT_CONFIGURED'),{status:503});}));
 try{await f.mounted.ready;f.mounted.openUsage();await flush();const html=f.nodes.get('account-usage-content').innerHTML;
  assert.match(html,/Spending advisory · Unavailable/);assert.match(html,/Observed token burn/);assert.doesNotMatch(html,/PRIVATE_NOT_CONFIGURED/);
 }finally{f.mounted.destroy();}
});
test('scope changes abort an old advisory read and refuse a late old-scope response',async()=>{
 let scope='one',calls=0,resolveOld,signal;
 const f=fixture(requester(options=>{calls++;if(calls===1){signal=options.signal;return new Promise(resolve=>{resolveOld=resolve;});}return reading({weeklyIncreasePoints:2});}),{getScope:()=>scope});
 try{
  await f.mounted.ready;f.mounted.openUsage();await flush();scope='two';f.mounted.repaint();assert.equal(signal.aborted,true);
  resolveOld(reading({weeklyIncreasePoints:4.25}));await flush();assert.doesNotMatch(f.nodes.get('account-usage-content').innerHTML,/4\.25/);
  await f.mounted.refresh();await flush();assert.equal(calls,2);assert.match(f.nodes.get('account-usage-content').innerHTML,/Weekly \+2/);
 }finally{f.mounted.destroy();}
});
test('authentication or authorization loss wins over concurrent successful detail data and clears the advisory cache',async()=>{
 for(const code of [401,403]){
  let fail=false;
  const f=fixture(async(route)=>{
   if(route==='/api/account')return account();
   if(route==='/api/account/spending-status'){if(fail)throw Object.assign(new Error('PRIVATE_DENIAL'),{status:code});return reading({weeklyIncreasePoints:4.25});}
   if(route.includes('details=1'))return {sampleAnalytics:{version:2,responses:{status:'available',turns:[{contextModel:'PRIVATE_OLD_MODEL'}]},recent:[]}};
   return usage();
  });
  try{
   await f.mounted.ready;f.mounted.openUsage();await flush();fail=true;
   await f.nodes.get('account-usage-refresh').emit('click');await flush();
   const html=f.nodes.get('account-usage-content').innerHTML;assert.doesNotMatch(html,/4\.25|PRIVATE_OLD_MODEL|PRIVATE_DENIAL/);
   assert.match(html,/Administrator access required/);
  }finally{f.mounted.destroy();}
 }
});
test('close, visibility loss, pagehide and destruction abort pending reads and reject late results',async()=>{
 for(const action of ['close','hidden','pagehide','destroy']){
  let resolveOld,signal;
  const f=fixture(requester(options=>{signal=options.signal;return new Promise(resolve=>{resolveOld=resolve;});}));
  try{
   await f.mounted.ready;f.mounted.openUsage();await flush();
   if(action==='close')f.nodes.get('account-usage-dialog').close();
   if(action==='hidden'){f.document.hidden=true;await f.document.emit('visibilitychange');}
   if(action==='pagehide')await f.window.emit('pagehide');
   if(action==='destroy')f.mounted.destroy();
   assert.equal(signal.aborted,true);
   resolveOld(reading({weeklyIncreasePoints:4.25}));await flush();
   assert.doesNotMatch(f.nodes.get('account-usage-content').innerHTML,/4\.25/);
  }finally{f.mounted.destroy();}
 }
});
test('identity replacement clears a prior reading before another administrator can see it',async()=>{
 let identity='owner',clock=now;
 const f=fixture(requester(async()=>reading({weeklyIncreasePoints:identity==='owner'?4.25:1}),()=>({...account(),viewer:{...account().viewer,id:identity}})),{now:()=>clock});
 try{
  await f.mounted.ready;f.mounted.openUsage();await flush();assert.match(f.nodes.get('account-usage-content').innerHTML,/4\.25/);
  identity='other';clock+=60000;await f.mounted.refresh();await flush();assert.doesNotMatch(f.nodes.get('account-usage-content').innerHTML,/4\.25/);
 }finally{f.mounted.destroy();}
});

test('a keyboard refresh restores focus after native disabling moves it to the document body',async()=>{
 const f=fixture(requester(async()=>reading()));
 try{
  await f.mounted.ready;f.mounted.openUsage();await flush();
  const button=f.nodes.get('account-usage-refresh');f.document.body=f.document;
  let disabled=false;
  Object.defineProperty(button,'disabled',{get:()=>disabled,set:value=>{disabled=value;if(value)f.document.body.focus();},configurable:true});
  button.focus();await f.mounted.refresh({forceAccount:true});await flush();
  assert.equal(f.document.activeElement,button);
 }finally{f.mounted.destroy();}
});
test('completion of a keyboard refresh does not steal focus that the user moved elsewhere',async()=>{
 let pending=false,resolveUsage;
 const base=requester(async()=>reading());
 const f=fixture(async(route,options)=>pending&&route==='/api/account/usage'?new Promise(resolve=>{resolveUsage=resolve;}):base(route,options));
 try{
  await f.mounted.ready;f.mounted.openUsage();await flush();
  const button=f.nodes.get('account-usage-refresh');f.document.body=f.document;
  let disabled=false;
  Object.defineProperty(button,'disabled',{get:()=>disabled,set:value=>{disabled=value;if(value)f.document.body.focus();},configurable:true});
  button.focus();pending=true;const refresh=f.mounted.refresh();await flush();
  f.nodes.get('profile-open').focus();resolveUsage(usage());await refresh;await flush();
  assert.equal(f.document.activeElement,f.nodes.get('profile-open'));
 }finally{f.mounted.destroy();}
});
