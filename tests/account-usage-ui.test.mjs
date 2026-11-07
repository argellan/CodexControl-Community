// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAccountUsageView,renderAccountStrip,renderAccountUsageDetails,renderProfile,safeSignInUrl,mountAccountUsage} from '../public/account-usage.mjs';
import {getTokenPalette} from '../public/token-palette.mjs';

const now=Date.parse('2026-10-20T19:00:00Z'),at=new Date(now-10000).toISOString();
const account=(overrides={})=>({label:'Owner Codex',status:'available',source:'Codex account service',limitsObservedAt:at,usageObservedAt:at,limits:[{limitId:'codex',primary:{usedPercent:17,windowDurationMins:10080,resetsAt:(now+86400000)/1000}}],summary:{lifetimeTokens:12345678901,peakDailyTokens:987654321},dailyUsageBuckets:[{startDate:'2026-10-19',tokens:30},{startDate:'2026-10-20',tokens:90}],...overrides});
const burn=(extra={})=>({status:'observed',observedAt:at,windowMs:60000,inputTokens:600,cachedInputTokens:300,uncachedInputTokens:300,outputTokens:120,totalTokens:720,inputPerSecond:10,cachedInputPerSecond:5,uncachedInputPerSecond:5,outputPerSecond:2,workerCount:2,workers:[],...extra});
const payload=(extra={})=>({observedAt:at,accountUsage:{status:'available',accounts:[account()]},activeUsage:{status:'available',observedAt:at,sessions:2,inputTokens:100,cachedInputTokens:25,outputTokens:40,totalTokens:140},burnUsage:burn(),...extra});

test('weekly remaining uses the actual seven-day account allowance and does not add model buckets',()=>{
 const data=payload();data.accountUsage.accounts[0].limits.unshift({limitId:'codex-other',primary:{usedPercent:90,windowDurationMins:10080,resetsAt:(now+86400000)/1000}},{limitId:'codex',primary:{usedPercent:80,windowDurationMins:300,resetsAt:(now+3600000)/1000}});
 const view=buildAccountUsageView(data,{now});assert.equal(view.accounts[0].weekly.remaining,83);assert.equal(view.accounts[0].weekly.limitId,'codex');assert.equal(view.accounts[0].weekly.resetsAt,now+86400000);assert.equal(view.accounts[0].summary.peakDailyTokens,987654321);
 const html=renderAccountStrip(view);assert.match(html,/83% remaining/);assert.match(html,/Peak daily/);assert.match(html,/Token burn/);assert.match(html,/Input new/);assert.doesNotMatch(html,/Active observed|100 tokens/);
});

test('active input/cache/output stay separate from account lifetime and retained history',()=>{
 const view=buildAccountUsageView(payload(),{now}),html=renderAccountUsageDetails(view);
 assert.equal(view.active.totalTokens,140);assert.equal(view.active.inputTokens,100);assert.equal(view.active.cachedInputTokens,25);assert.match(html,/cached subset/);assert.match(html,/counters are not tokens per second/);assert.match(html,/Largest reported day/);assert.match(html,/Date \(service day\)/);assert.match(html,/Live account readings stay separate.*replay clock/);
});

test('unknown values remain unavailable and never turn into zero usage or full allowance',()=>{
 const view=buildAccountUsageView({}, {now}),html=renderAccountStrip(view);
 assert.equal(view.active.totalTokens,null);assert.equal(view.accounts[0].summary.peakDailyTokens,null);assert.equal(view.accounts[0].weekly,null);assert.doesNotMatch(html,/100% remaining|0 tokens|0 active sessions/);assert.match(renderAccountUsageDetails(view),/Total tokens<\/dt><dd>Unavailable/);
});

test('idle cumulative sessions do not invent token burn without explicit window readings',()=>{
 const view=buildAccountUsageView(payload({activeUsage:{status:'idle',sessions:0,totalTokens:null},burnUsage:{status:'idle',observedAt:at,windowMs:60000,workerCount:0}}),{now});assert.equal(view.active.state,'idle');assert.equal(view.burn.inputPerSecond,null);const html=renderAccountStrip(view);assert.match(html,/0 workers/);assert.doesNotMatch(html,/0 tokens|0<small> t\/s/);
});

test('mixed fresh and missing active readings are explicitly partial in text and detail',()=>{
 const data=payload();data.activeUsage.status='partial';data.burnUsage.status='partial';const view=buildAccountUsageView(data,{now});assert.equal(view.active.state,'partial');assert.match(renderAccountStrip(view),/PARTIAL/);assert.match(renderAccountUsageDetails(view),/missing or stale token readings/);
});

test('bounded daily history discloses omitted older days and preserves the latest chronological readings',()=>{
 const data=payload();data.accountUsage.accounts[0].dailyUsageBuckets=Array.from({length:150},(_,i)=>({startDate:new Date(now-i*86400000).toISOString().slice(0,10),tokens:i}));const view=buildAccountUsageView(data,{now});assert.equal(view.accounts[0].daily.length,120);assert.equal(view.accounts[0].dailyCount,150);assert.equal(view.accounts[0].daily.at(-1).startDate,'2026-10-20');assert.match(renderAccountUsageDetails(view),/120 days of 150 reported/);
});

test('source age, failed refresh, future clocks and expired resets prevent fresh claims',()=>{
 const data=payload();data.accountUsage.accounts[0].limitsObservedAt=new Date(now-120001).toISOString();const stale=buildAccountUsageView(data,{now});assert.equal(stale.accounts[0].weekly.state,'stale');assert.match(renderAccountStrip(stale),/STALE/);
 const failed=buildAccountUsageView(payload(),{now,failed:true});assert.equal(failed.accounts[0].weekly.state,'stale');assert.equal(failed.active.state,'stale');assert.match(renderAccountUsageDetails(failed),/Refresh failed/);
 const future=buildAccountUsageView(payload({activeUsage:{observedAt:new Date(now+30001).toISOString(),status:'available',totalTokens:99}}),{now});assert.equal(future.active.state,'unavailable');assert.doesNotMatch(renderAccountStrip(future),/99 tokens/);
 const expired=payload();expired.accountUsage.accounts[0].limits[0].primary.resetsAt=(now-1)/1000;const view=buildAccountUsageView(expired,{now});assert.equal(view.accounts[0].weekly.state,'expired');assert.doesNotMatch(renderAccountStrip(view),/83% remaining/);assert.match(renderAccountUsageDetails(view),/reset passed/);
});

test('separate account allowances and peak days are rendered independently, not summed',()=>{
 const data=payload();data.accountUsage.accounts.push(account({label:'Second account',summary:{lifetimeTokens:80,peakDailyTokens:40}}));const view=buildAccountUsageView(data,{now}),strip=renderAccountStrip(view),details=renderAccountUsageDetails(view);
 assert.match(strip,/2 accounts/);assert.doesNotMatch(strip,/166%|2\.9B/);assert.match(details,/Owner Codex/);assert.match(details,/Second account/);assert.match(details,/never added together/);
});

test('restricted account responses cannot expose account summary or daily history in markup',()=>{
 const data=payload();data.accountUsage.status='restricted';const view=buildAccountUsageView(data,{now});assert.equal(view.accounts.length,0);const html=renderAccountUsageDetails(view);assert.doesNotMatch(html,/12,345,678,901|987,654,321|2026-10-19/);assert.match(html,/private to administrators/);assert.match(html,/Total tokens<\/dt><dd>140/);
});

test('untrusted account labels, quota identifiers and profile labels are escaped',()=>{
 const data=payload();data.accountUsage.accounts[0].label='<img src=x onerror=alert(1)>';data.accountUsage.accounts[0].limits[0].limitId='<svg onload=alert(1)>';
 const html=renderAccountUsageDetails(buildAccountUsageView(data,{now}))+renderProfile({viewer:{label:'<script>bad</script>',username:'<img>',role:'<svg>'},capabilities:{authenticated:true,logout:true}});
 assert.doesNotMatch(html,/<img|<script|<svg/);assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;img/);
});

test('primary burn meters use disjoint observed rates rather than cumulative session totals',()=>{
 const data=payload();data.activeUsage.totalTokens=3300000000;const view=buildAccountUsageView(data,{now}),strip=renderAccountStrip(view),details=renderAccountUsageDetails(view);
 assert.equal(view.burn.inputPerSecond,10);assert.equal(view.burn.uncachedInputPerSecond,5);assert.equal(view.burn.cachedInputPerSecond,5);assert.equal(view.burn.outputPerSecond,2);assert.match(strip,/Visible scope · 60s · 2 workers/);assert.match(strip,/New input 5, output 2, cached input 5 tokens per second/);assert.match(strip,/class="burn-meter burn-input"/);assert.match(strip,/class="burn-meter burn-output"/);assert.match(strip,/class="burn-meter burn-cache"/);assert.doesNotMatch(strip,/3\.3B|3,300,000,000/);assert.match(details,/Input including cache is 10 t\/s/);assert.match(details,/Usage arrives in sampled batches, not a provider token stream/);assert.match(details,/I · Gold · new input/);assert.match(details,/O · Coral · output/);assert.match(details,/C · Teal · cached input/);assert.match(details,/3,300,000,000/);
});

test('sampled input ratios remain available independently of exact native response analytics',()=>{
 const data=payload();data.burnUsage.ratios={cacheHit:{value:.5,numerator:300,denominator:600,comparableRows:2,excludedRows:1,classification:'derived',method:'ratio-of-sums'},newInputFraction:{value:.5,numerator:300,denominator:600,comparableRows:2,excludedRows:1,classification:'derived',method:'ratio-of-sums'}};
 const view=buildAccountUsageView(data,{now}),html=renderAccountUsageDetails(view);assert.match(html,/Sampled-window input ratios/);assert.match(html,/50\.0%/);assert.match(html,/300 \/ 600/);assert.match(html,/Usage-sample analytics unavailable/);assert.doesNotMatch(renderAccountStrip(view),/Sampled-window input ratios/);
});

test('account token legends follow the chosen palette with I/O/C and line patterns while preserving exact accounting',()=>{
 const view=buildAccountUsageView(payload(),{now}),semantic=renderAccountUsageDetails(view),coins=renderAccountUsageDetails(view,{palette:getTokenPalette('coins','light')});
 assert.match(semantic,/I · Gold · new input/);assert.match(semantic,/O · Coral · output/);assert.match(semantic,/C · Teal · cached input/);
 assert.match(coins,/I · Gold · new input/);assert.match(coins,/O · Silver · output/);assert.match(coins,/C · Magenta · cached input/);
 for(const html of [semantic,coins]){assert.match(html,/token-line token-output/);assert.match(html,/token-line token-cached/);assert.match(html,/Input including cache is 10 t\/s/);assert.match(html,/cache is its subset/);assert.match(html,/not a monetary balance/);}
});

test('baseline, missing and invalid rate observations never turn into live zero burn',()=>{
 const baseline=buildAccountUsageView(payload({burnUsage:burn({status:'baseline',inputPerSecond:999})}),{now});assert.equal(baseline.burn.state,'warming');assert.equal(baseline.burn.inputPerSecond,null);assert.match(renderAccountStrip(baseline),/Warming up/);assert.doesNotMatch(renderAccountStrip(baseline),/999/);
 const unknown=buildAccountUsageView(payload({burnUsage:undefined}),{now});assert.equal(unknown.burn.state,'unavailable');assert.match(renderAccountStrip(unknown),/Waiting for token observations/);
 const invalid=buildAccountUsageView(payload({burnUsage:burn({uncachedInputPerSecond:-1,cachedInputPerSecond:Infinity,outputPerSecond:'7'})}),{now});assert.equal(invalid.burn.uncachedInputPerSecond,null);assert.equal(invalid.burn.cachedInputPerSecond,null);assert.equal(invalid.burn.outputPerSecond,null);assert.doesNotMatch(renderAccountStrip(invalid),/Infinity|-1<|7<small>/);
});

test('explicit observed zero rates render zero while old rates remain visibly stale',()=>{
 const zero=buildAccountUsageView(payload({burnUsage:burn({status:'idle',inputPerSecond:0,uncachedInputPerSecond:0,cachedInputPerSecond:0,outputPerSecond:0})}),{now});assert.match(renderAccountStrip(zero),/New input 0, output 0, cached input 0 tokens per second/);
 const stale=buildAccountUsageView(payload({burnUsage:burn({observedAt:new Date(now-120001).toISOString()})}),{now});assert.equal(stale.burn.state,'stale');assert.match(renderAccountStrip(stale),/STALE/);
 const future=buildAccountUsageView(payload({burnUsage:burn({observedAt:new Date(now+30001).toISOString()})}),{now});assert.equal(future.burn.state,'unavailable');assert.equal(future.burn.inputPerSecond,null);
});

test('worker rate drilldown is bounded, escaped and preserves source categories',()=>{
 const workers=Array.from({length:15},(_,i)=>({sessionId:'worker-'+i,hostId:'<img>',project:'<script>',totalTokens:i,uncachedInputPerSecond:1,cachedInputPerSecond:2,outputPerSecond:3}));workers.push(null);
 const view=buildAccountUsageView(payload({burnUsage:burn({workers,workerCount:15})}),{now}),html=renderAccountUsageDetails(view);
 assert.match(html,/Burn by worker \(12 of 15 in this response\)/);assert.match(html,/worker-14/);assert.doesNotMatch(html,/worker-0<|<img|<script/);assert.match(html,/&lt;img&gt;/);assert.match(html,/Input new t\/s/);assert.match(html,/Cached t\/s/);
});

test('database metadata reports retained readings without claiming billing completeness',()=>{
 const view=buildAccountUsageView(payload({usageHistory:{storage:{retainedObservations:321,retainedDailyRows:42,retainedBaselines:8,rawRetentionDays:30,dailyRetentionDays:730,maxRawObservations:200000,maxDailyRows:200000,limitsApplyAcrossFleet:true,accountHistoryIncluded:false}}}),{now}),html=renderAccountUsageDetails(view);
 assert.match(html,/Stored worker observations<\/dt><dd>321/);assert.match(html,/Worker daily rows<\/dt><dd>42/);assert.match(html,/Raw hot-cache target<\/dt><dd>30 days \/ 200,000 rows/);assert.match(html,/Daily hot-cache target<\/dt><dd>730 days \/ 200,000 rows/);assert.match(html,/verified durable archive receipt across the fleet/);assert.match(html,/not a reconstructed billing ledger/);assert.match(html,/Account-wide source history is not included/);
});

test('database row arrays are bounded drilldowns, never substituted for retained database counts',()=>{
 const history={observations:[{}],daily:Array.from({length:35},(_,i)=>({day:'2026-10-20',hostId:'<host>',sessionId:'worker-'+i,project:'<project>',uncachedInputTokens:5,cachedInputTokens:3,outputTokens:2,partialObservations:i===0?1:0,lastAt:at})),storage:{retainedObservations:5000,retainedDailyRows:900,retainedBaselines:12,scope:'authorized observations',completeHistory:false,accountHistoryIncluded:true,retainedAccountObservations:30,retainedAccountDailyRows:4}};
 const html=renderAccountUsageDetails(buildAccountUsageView(payload({usageHistory:history}),{now}));assert.match(html,/Stored worker observations<\/dt><dd>5,000/);assert.match(html,/30 of 35 returned rows/);assert.match(html,/daily token totals, not rates/);assert.match(html,/partial/);assert.match(html,/&lt;host&gt;/);assert.doesNotMatch(html,/<host>|<project>/);assert.match(html,/Account source observations<\/dt><dd>30/);
 const missing=renderAccountUsageDetails(buildAccountUsageView(payload({usageHistory:{observations:[{}],daily:[]}}),{now}));assert.match(missing,/Database retention and coverage information is unavailable/);assert.doesNotMatch(missing,/Stored worker observations<\/dt><dd>1/);
});

test('profile uses supported account controls and offers only safe hub sign-in handoffs',()=>{
 const html=renderProfile({viewer:{label:'Owner',username:'owner',role:'admin'},capabilities:{authenticated:true,passwordChange:true,logout:true}});assert.match(html,/Profile, password &amp; access|Profile, password & access/);assert.match(html,/data-account-action="settings"/);assert.match(html,/Sign out/);assert.doesNotMatch(html,/type="password"|tokenHash|passwordHash/);
 assert.equal(safeSignInUrl('http://hub/'),null);assert.equal(safeSignInUrl('javascript:alert(1)'),null);assert.equal(safeSignInUrl('https://user:secret@hub/'),null);assert.equal(safeSignInUrl('https://hub/#token'),null);assert.equal(safeSignInUrl('https://hub/?token=secret'),null);assert.equal(safeSignInUrl('https://hub/other'),null);assert.equal(safeSignInUrl('https://hub/'),'https://hub/');
 const gateway=renderProfile({capabilities:{authenticated:false,passwordLoginUrl:'https://hub/'}});assert.match(gateway,/href="https:\/\/hub\/"/);assert.match(gateway,/authoritative fleet hub/);
 const anonymous=renderProfile({capabilities:{authenticated:false,logout:true}});assert.doesNotMatch(anonymous,/Sign out/);assert.match(anonymous,/Sign in/);
});

test('archive health distinguishes pending configuration, verified transfer and restricted fleet counts',()=>{
 const storage={retainedObservations:10,archiveRequiredBeforeEviction:true};
 const render=archive=>renderAccountUsageDetails(buildAccountUsageView(payload({usageHistory:{storage,archive}}),{now}));
 const pending=render({status:'unconfigured',pendingRecords:250,bootstrapComplete:true,receipts:0});assert.match(pending,/Archive destination not configured/);assert.match(pending,/250 record versions pending/);assert.match(pending,/Unarchived records stay on the Pi/);assert.match(pending,/no automatic age-based deletion/);
 const healthy=render({status:'healthy',lastSuccessAt:new Date().toISOString(),pendingRecords:0,bootstrapComplete:true,receipts:3});assert.match(healthy,/Latest archive transfer verified/);
 const denied=render({status:'restricted',pendingRecords:99999});assert.match(denied,/unrestricted administrator/);assert.doesNotMatch(denied,/99999|99,999/);
});

function fixture(request,options={}){
 const nodes=new Map();let active=null;
 function element(id){return {id,innerHTML:'',textContent:'',disabled:false,hidden:false,isConnected:true,open:false,dataset:{},listeners:new Map(),attributes:{},addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);},removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);},setAttribute(key,value){this.attributes[key]=value;},querySelector(selector){return this.children?.[selector]||null;},querySelectorAll(){return [];},focus(){active=this;},showModal(){this.open=true;},close(){this.open=false;for(const fn of this.listeners.get('close')||[])fn();},emit(type,event={}){return Promise.all([...(this.listeners.get(type)||[])].map(fn=>fn(event)));}};}
 for(const id of ['account-activity-open','account-usage-strip','profile-open','profile-dialog','profile-content','account-usage-dialog','account-usage-content','account-refresh-status','usage-open','refresh','account-usage-refresh'])nodes.set(id,element(id));
 nodes.get('profile-open').children={'[data-profile-label]':element('label'),'[data-profile-name]':element('name')};
 for(const id of ['profile-dialog','account-usage-dialog'])nodes.get(id).children={'[data-account-close]':element(id+'-close')};
 const document=element('document');document.hidden=false;document.getElementById=id=>nodes.get(id);Object.defineProperty(document,'activeElement',{get:()=>active});const window=element('window');let destination=null,section=null,retained=0;
 const mounted=mountAccountUsage({document,window,request,now:()=>now,navigate:path=>{destination=path;},openSettings:value=>{section=value;},openRetained:()=>{retained++;},...options});
 return {nodes,document,window,mounted,get destination(){return destination;},get section(){return section;},get retained(){return retained;},action:async(dialog,action)=>{const button=element(action);button.dataset={accountAction:action};await nodes.get(dialog).emit('click',{target:{closest:()=>button}});return button;}};
}

test('a newly identified account refreshes quota history immediately instead of retaining the empty cached window',async()=>{
 let linked=false;const calls=[];
 const f=fixture(async path=>{calls.push(path);if(path==='/api/account')return {capabilities:{authenticated:false}};if(path.startsWith('/api/account/allowance-history'))return {status:linked?'observed':'unavailable',points:[]};return payload({accountUsage:{status:'available',accounts:[account({accountKey:linked?'a'.repeat(64):null,hostIds:['TEST_ONLY-source']})]}});});
 try{await f.mounted.ready;assert.equal(calls.filter(p=>p.includes('allowance-history')).length,1);linked=true;await f.mounted.refresh();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.filter(p=>p.includes('allowance-history')).length,2);}finally{f.mounted.destroy();}
});

test('a saved appearance change repaints an open usage dialog without refetching or emitting new usage',async()=>{
 let palette=getTokenPalette(),observations=0;const calls=[],f=fixture(async route=>{calls.push(route);return route==='/api/account'?{}:payload();},{getPalette:()=>palette,onUsage:()=>observations++});
 try{await f.mounted.ready;await f.nodes.get('usage-open').emit('click');assert.match(f.nodes.get('account-usage-content').innerHTML,/I · Gold/);const reads=calls.length;
  palette=getTokenPalette('coins','light');f.mounted.repaint();assert.match(f.nodes.get('account-usage-content').innerHTML,/I · Gold/);assert.equal(calls.length,reads);assert.equal(observations,1);assert.equal(f.nodes.get('account-usage-dialog').open,true);
 }finally{f.mounted.destroy();}
});

test('mounted controls fetch bounded live endpoints, preserve profile focus and open direct access settings',async()=>{
 const calls=[],f=fixture(async(path,options)=>{calls.push({path,options});return path==='/api/account'?{viewer:{username:'owner',label:'Owner',role:'admin'},capabilities:{authenticated:true,passwordChange:true,logout:true}}:payload();});
 try{await f.mounted.ready;assert.deepEqual(calls.map(c=>c.path),['/api/account/usage?summary=1','/api/account','/api/account/allowance-history?range=24h']);assert.equal(f.nodes.get('profile-open').children['[data-profile-label]'].textContent,'Profile');assert.equal(f.nodes.get('profile-open').children['[data-profile-name]'].textContent,'owner');
 f.nodes.get('profile-open').focus();await f.nodes.get('profile-open').emit('click');assert.equal(f.nodes.get('profile-dialog').open,true);f.nodes.get('profile-dialog').close();assert.equal(f.document.activeElement,f.nodes.get('profile-open'));
 await f.nodes.get('profile-open').emit('click');await f.action('profile-dialog','settings');assert.equal(f.section,'access');assert.equal(f.nodes.get('profile-dialog').open,false);
 await f.nodes.get('usage-open').emit('click');assert.equal(f.nodes.get('account-usage-dialog').open,true);await f.action('account-usage-dialog','retained');assert.equal(f.retained,1);assert.equal(f.nodes.get('account-usage-dialog').open,false);
 await f.mounted.refresh();assert.equal(calls.filter(c=>c.path==='/api/account').length,1);assert.equal(calls.filter(c=>c.path==='/api/account/usage?summary=1').length,2);
 }finally{f.mounted.destroy();}
});

test('refresh failure keeps readings stale and successful sign-out uses the revoking server route',async()=>{
 let fail=false;const calls=[],f=fixture(async(path,options)=>{calls.push({path,options});if(path==='/api/account')return {viewer:{username:'owner',role:'admin'},capabilities:{authenticated:true,logout:true}};if(fail&&path==='/api/account/usage?summary=1')throw Object.assign(new Error('PRIVATE server data'),{status:503});return payload();});
 try{await f.mounted.ready;fail=true;await f.mounted.refresh();assert.match(f.nodes.get('account-usage-strip').innerHTML,/STALE/);assert.doesNotMatch(f.nodes.get('account-refresh-status').textContent,/PRIVATE/);
 await f.nodes.get('profile-open').emit('click');await f.action('profile-dialog','logout');await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.at(-1).path,'/api/session/logout');assert.equal(calls.at(-1).options.method,'POST');assert.equal(f.destination,'/');
 }finally{f.mounted.destroy();}
});

test('hidden/page-hidden and destroyed controllers do not dispatch further reads',async()=>{
 let calls=0;const f=fixture(async(path)=>{calls++;return path==='/api/account'?{viewer:{username:'owner'},capabilities:{authenticated:true}}:payload();});
 await f.mounted.ready;const baseline=calls;f.document.hidden=true;await f.mounted.refresh();assert.equal(calls,baseline);f.document.hidden=false;await f.window.emit('pagehide');await f.mounted.refresh();assert.equal(calls,baseline);await f.window.emit('pageshow');await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,baseline+1);f.mounted.destroy();await f.mounted.refresh();assert.equal(calls,baseline+1);
});

test('map callback receives successful usage batches only and cannot break the account controls',async()=>{
 let fail=false,callbacks=0;const data=payload(),f=fixture(async(path)=>{if(path==='/api/account')return {capabilities:{authenticated:false}};if(fail)throw new Error('offline');return data;},{onUsage:value=>{assert.equal(value,data);callbacks++;throw new Error('map unavailable');}});
 try{await f.mounted.ready;assert.equal(callbacks,1);assert.match(f.nodes.get('account-usage-strip').innerHTML,/Token burn/);fail=true;await f.mounted.refresh();assert.equal(callbacks,1);assert.match(f.nodes.get('account-usage-strip').innerHTML,/STALE/);fail=false;await f.mounted.refresh();assert.equal(callbacks,2);assert.equal(f.nodes.get('account-usage-refresh').disabled,false);}finally{f.mounted.destroy();}
});

test('visible usage polling is three seconds while profile identity remains sixty seconds',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});const calls=[],f=fixture(async(path)=>{calls.push(path);return path==='/api/account'?{capabilities:{authenticated:false}}:payload();});
 try{await f.mounted.ready;assert.equal(calls.length,3);t.mock.timers.tick(2999);assert.equal(calls.length,3);t.mock.timers.tick(1);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,4);assert.equal(calls.at(-1),'/api/account/usage?summary=1');assert.equal(calls.filter(path=>path.includes('allowance-history')).length,1);f.document.hidden=true;await f.document.emit('visibilitychange');t.mock.timers.tick(3000);assert.equal(calls.length,4);}finally{f.mounted.destroy();t.mock.timers.reset();}
});

test('sample analytics is lazy, bounded to fifteen seconds while open, and never emits usage activity',async()=>{
 let clock=now,observations=0,detailReads=0;const calls=[],analytics={version:2,coverage:{retainedRows:12},responses:{status:'unavailable'},recent:[]};
 const f=fixture(async route=>{calls.push(route);if(route.includes('details=1')){detailReads++;return {sampleAnalytics:analytics};}return route==='/api/account'?{}:payload();},{now:()=>clock,onUsage:()=>observations++});
 try{await f.mounted.ready;assert.equal(detailReads,0);await f.mounted.refresh();assert.equal(detailReads,0);const before=observations;
  await f.nodes.get('usage-open').emit('click');await new Promise(resolve=>setImmediate(resolve));assert.equal(detailReads,1);assert.equal(observations,before);assert.match(f.nodes.get('account-usage-content').innerHTML,/12 \/ Unavailable/);
  clock+=14999;await f.mounted.refresh();assert.equal(detailReads,1);clock++;await f.mounted.refresh();await new Promise(resolve=>setImmediate(resolve));assert.equal(detailReads,2);
  f.nodes.get('account-usage-dialog').close();clock+=30000;await f.mounted.refresh();await f.mounted.refreshDetails();assert.equal(detailReads,2);assert.ok(calls.filter(route=>route.includes('details=1')).every(route=>route==='/api/account/usage?details=1'));
 }finally{f.mounted.destroy();}
});

test('detail cache is scope-bound, rejects late old-scope reads and clears on authentication loss',async()=>{
 let scope='first',resolveOld,detailReads=0,denied=false,invalidations=0;
 const detail=label=>({sampleAnalytics:{version:2,coverage:{retainedRows:1},responses:{status:'available',turns:[{hostId:'host',sessionId:'session',turnId:label,contextModel:label}]},recent:[]}});
 const f=fixture(async route=>{if(route.includes('details=1')){detailReads++;if(denied)throw Object.assign(new Error('PRIVATE'),{status:401});if(detailReads===1)return new Promise(resolve=>{resolveOld=resolve;});return detail('NEW_SCOPE');}return route==='/api/account'?{}:payload();},{getScope:()=>scope,onInvalidate:()=>invalidations++});
 try{await f.mounted.ready;await f.nodes.get('usage-open').emit('click');assert.equal(detailReads,1);assert.match(f.nodes.get('account-usage-content').innerHTML,/Loading captured response details/);
  scope='second';f.mounted.repaint();resolveOld(detail('OLD_SCOPE'));await new Promise(resolve=>setImmediate(resolve));assert.doesNotMatch(f.nodes.get('account-usage-content').innerHTML,/OLD_SCOPE/);await f.mounted.refreshDetails();assert.match(f.nodes.get('account-usage-content').innerHTML,/NEW_SCOPE/);
  scope='third';denied=true;f.mounted.repaint();await f.mounted.refreshDetails();assert.doesNotMatch(f.nodes.get('account-usage-content').innerHTML,/NEW_SCOPE|OLD_SCOPE|PRIVATE/);assert.equal(invalidations,1);assert.equal(f.nodes.get('profile-open').children['[data-profile-label]'].textContent,'Sign in');
 }finally{f.mounted.destroy();}
});

test('explicit usage-evidence click closes details and preserves keyboard focus at the requested destination',async()=>{
 let focused=null;const f=fixture(async route=>route==='/api/account'?{}:payload(),{onFocus:value=>{focused=value;f.nodes.get('refresh').focus();}});
 try{await f.mounted.ready;f.nodes.get('usage-open').focus();await f.nodes.get('usage-open').emit('click');const target={hostId:'host',sessionId:'session',turnId:'turn'},button={dataset:{usageFocus:JSON.stringify(target)}};let stopped=false;
  await f.nodes.get('account-usage-dialog').emit('click',{target:{closest:()=>button},stopPropagation(){stopped=true;}});assert.deepEqual(focused,target);assert.equal(stopped,true);assert.equal(f.nodes.get('account-usage-dialog').open,false);assert.equal(f.document.activeElement,f.nodes.get('refresh'));
 }finally{f.mounted.destroy();}
});

test('export action receives same-scope cached details only after an explicit preview click',async()=>{
 const selected={version:2,coverage:{returnedRows:0},responses:{status:'unavailable'},recent:[]};let previews=0,value;
 const f=fixture(async route=>route.includes('details=1')?{sampleAnalytics:selected}:route==='/api/account'?{}:payload(),{onExport:payload=>{previews++;value=payload;}});
 try{await f.mounted.ready;assert.equal(previews,0);await f.nodes.get('usage-open').emit('click');await new Promise(resolve=>setImmediate(resolve));assert.equal(previews,0);await f.action('account-usage-dialog','export');assert.equal(previews,1);assert.deepEqual(value.sampleAnalytics,selected);await f.mounted.refresh();assert.equal(previews,1);}finally{f.mounted.destroy();}
});

test('known authentication loss wins over a concurrently successful stale profile response',async()=>{
 let invalidated=0;const f=fixture(async route=>{if(route==='/api/account')return {viewer:{username:'TEST_ONLY_stale_owner',role:'admin'},capabilities:{authenticated:true}};throw Object.assign(new Error('TEST_ONLY authentication lost'),{status:401});},{onInvalidate:()=>invalidated++});
 try{await f.mounted.ready;assert.equal(f.nodes.get('profile-open').children['[data-profile-label]'].textContent,'Sign in');assert.equal(f.nodes.get('profile-open').children['[data-profile-name]'].textContent,'');await f.nodes.get('profile-open').emit('click');assert.doesNotMatch(f.nodes.get('profile-content').innerHTML,/TEST_ONLY_stale_owner/);assert.ok(invalidated>0);}finally{f.mounted.destroy();}
});

test('explicit detail authorization refusal clears cached evidence and export while transient failure may retain stale same-scope data',async()=>{
 for(const code of [403,503]){let clock=now,failed=false,exports=0,invalidated=0;const selected={version:2,coverage:{returnedRows:1},responses:{status:'available',turns:[{hostId:'host',sessionId:'session',turnId:'turn',contextModel:'TEST_ONLY_OLD_DETAIL'}]},recent:[]};
  const f=fixture(async route=>{if(route.includes('details=1')){if(failed)throw Object.assign(new Error('TEST_ONLY refused'),{status:code});return {sampleAnalytics:selected};}return route==='/api/account'?{viewer:{username:'owner',role:'admin'},capabilities:{authenticated:true}}:payload();},{now:()=>clock,onExport:()=>exports++,onInvalidate:()=>invalidated++});
  try{await f.mounted.ready;await f.nodes.get('usage-open').emit('click');await new Promise(resolve=>setImmediate(resolve));assert.match(f.nodes.get('account-usage-content').innerHTML,/TEST_ONLY_OLD_DETAIL/);failed=true;clock+=15000;await f.mounted.refreshDetails();
   if(code===403){assert.doesNotMatch(f.nodes.get('account-usage-content').innerHTML,/TEST_ONLY_OLD_DETAIL/);assert.match(f.nodes.get('account-usage-content').innerHTML,/data-account-action="export" disabled/);await f.action('account-usage-dialog','export');assert.equal(exports,0);assert.ok(invalidated>0);}
   else{assert.match(f.nodes.get('account-usage-content').innerHTML,/TEST_ONLY_OLD_DETAIL/);assert.match(f.nodes.get('account-usage-content').innerHTML,/Detail refresh failed/);await f.action('account-usage-dialog','export');assert.equal(exports,1);}
  }finally{f.mounted.destroy();}
 }
});

test('ordinary usage403 invalidates previously cached details and cannot reopen an export from that selection',async()=>{
 let forbidden=false,exports=0,invalidated=0;const selected={version:2,coverage:{returnedRows:1},responses:{status:'available',turns:[{hostId:'host',sessionId:'session',turnId:'turn',contextModel:'TEST_ONLY_OLD_DETAIL'}]},recent:[]};
 const f=fixture(async route=>{if(route.includes('details=1'))return {sampleAnalytics:selected};if(route==='/api/account')return {};if(forbidden)throw Object.assign(new Error('TEST_ONLY forbidden'),{status:403});return payload();},{onExport:()=>exports++,onInvalidate:()=>invalidated++});
 try{await f.mounted.ready;await f.nodes.get('usage-open').emit('click');await new Promise(resolve=>setImmediate(resolve));assert.match(f.nodes.get('account-usage-content').innerHTML,/TEST_ONLY_OLD_DETAIL/);forbidden=true;await f.mounted.refresh();assert.doesNotMatch(f.nodes.get('account-usage-content').innerHTML,/TEST_ONLY_OLD_DETAIL/);await f.action('account-usage-dialog','export');assert.equal(exports,0);assert.ok(invalidated>0);}finally{f.mounted.destroy();}
});

test('a denied concurrent account read cannot publish fulfilled usage or late old-generation detail evidence',async()=>{
 for(const code of [401,403]){let denied=false,resolveDetail,emitted=0,exports=0;
  const f=fixture(async route=>{if(route.includes('details=1'))return new Promise(resolve=>{resolveDetail=resolve;});if(route==='/api/account'){if(denied)throw Object.assign(new Error('TEST_ONLY account refused'),{status:code});return {viewer:{username:'owner'},capabilities:{authenticated:true}};}return payload();},{onUsage:()=>emitted++,onExport:()=>exports++});
  try{await f.mounted.ready;await f.nodes.get('usage-open').emit('click');const before=emitted;denied=true;await f.mounted.refresh({forceAccount:true});assert.equal(emitted,before);resolveDetail({sampleAnalytics:{version:2,coverage:{},responses:{status:'available',turns:[{contextModel:'TEST_ONLY_LATE_DENIED_DETAIL'}]}}});await new Promise(resolve=>setImmediate(resolve));assert.doesNotMatch(f.nodes.get('account-usage-content').innerHTML,/TEST_ONLY_LATE_DENIED_DETAIL/);await f.action('account-usage-dialog','export');assert.equal(exports,0);if(code===401)assert.equal(f.nodes.get('profile-open').children['[data-profile-label]'].textContent,'Sign in');}
  finally{f.mounted.destroy();}
 }
});

test('mounted burn and account-history destinations stay distinct across refresh and controls',async()=>{
 const f=fixture(async path=>path==='/api/account'?{capabilities:{authenticated:true},viewer:{id:'viewer'}}:payload());
 try{await f.mounted.ready;f.mounted.openUsage('active');assert.match(f.nodes.get('account-usage-content').innerHTML,/Observed token burn/);assert.doesNotMatch(f.nodes.get('account-usage-content').innerHTML,/native-heatmap/);f.nodes.get('account-usage-dialog').close();f.mounted.openUsage('lifetime');assert.match(f.nodes.get('account-usage-content').innerHTML,/native-heatmap/);assert.doesNotMatch(f.nodes.get('account-usage-content').innerHTML,/Observed token burn/);await f.nodes.get('account-usage-dialog').emit('click',{target:{closest:()=>({dataset:{accountDays:'7'}})}});assert.match(f.nodes.get('account-usage-content').innerHTML,/last 7 days/);await f.nodes.get('account-usage-dialog').emit('click',{target:{closest:()=>({dataset:{accountHeat:'cumulative'}})}});assert.match(f.nodes.get('account-usage-content').innerHTML,/Captured cumulative tokens/);await f.mounted.refresh();assert.match(f.nodes.get('account-usage-content').innerHTML,/last 7 days/);assert.doesNotMatch(f.nodes.get('account-usage-content').innerHTML,/Observed token burn/);}finally{f.mounted.destroy();}
});

test('native chart bodies load once per digest and disappear after authorization loss',async()=>{
 let nativeReads=0,denied=false,tick=now;const digest='a'.repeat(64),native={version:1,source:'codex-native-analytics',observedAt:new Date(now).toISOString(),datasets:{usage:{kind:'usage',units:'percent',collectedAt:new Date(now).toISOString(),data:[{date:new Date(now).toISOString().slice(0,10),attribution:[{thread_source:'user',turn_trigger:'composer',model:'TEST_ONLY_NATIVE_MODEL',surface:'desktop_app',value:7}]}]}}};
 const f=fixture(async route=>{if(denied)throw Object.assign(new Error('TEST_ONLY denied'),{status:403});if(route==='/api/account')return {viewer:{id:'owner'},capabilities:{authenticated:true}};const p=payload();for(const a of p.accountUsage.accounts)a.nativeAnalytics={digest};if(route.includes('native=1')){nativeReads++;for(const a of p.accountUsage.accounts)a.nativeAnalyticsData=native;}return p;},{now:()=>tick});
 try{await f.mounted.ready;f.mounted.openUsage('lifetime');await new Promise(r=>setImmediate(r));assert.equal(nativeReads,1);assert.match(f.nodes.get('account-usage-content').innerHTML,/Usage history/);tick+=16000;await f.mounted.refresh();await new Promise(r=>setImmediate(r));assert.equal(nativeReads,1);assert.match(f.nodes.get('account-usage-content').innerHTML,/Usage history/);denied=true;await f.mounted.refresh();assert.doesNotMatch(f.nodes.get('account-usage-content').innerHTML,/native-analytics-cards/);}finally{f.mounted.destroy();}
});

test('unchanged account history refresh does not replace chart DOM',async()=>{
 const f=fixture(async route=>route==='/api/account'?{}:payload());try{await f.mounted.ready;f.mounted.openUsage('lifetime');await new Promise(r=>setImmediate(r));const body=f.nodes.get('account-usage-content');let value=body.innerHTML,writes=0;Object.defineProperty(body,'innerHTML',{get:()=>value,set:v=>{value=v;writes++;},configurable:true});f.mounted.repaint();f.mounted.repaint();assert.equal(writes,0);await f.nodes.get('account-usage-dialog').emit('click',{target:{closest:()=>({dataset:{accountDays:'7'}})}});assert.equal(writes,1);}finally{f.mounted.destroy();}
});

test('mobile Account activity opens complete history and returns focus without changing burn navigation',async()=>{
 const f=fixture(async route=>route==='/api/account'?{}:payload());
 try{await f.mounted.ready;const trigger=f.nodes.get('account-activity-open');trigger.focus();await trigger.emit('click');assert.equal(f.nodes.get('account-usage-dialog').open,true);assert.match(f.nodes.get('account-usage-content').innerHTML,/Token activity/);assert.match(f.nodes.get('account-usage-content').innerHTML,/Lifetime tokens/);assert.match(f.nodes.get('account-usage-content').innerHTML,/Peak daily/);assert.match(f.nodes.get('account-usage-content').innerHTML,/Longest task/);assert.match(f.nodes.get('account-usage-content').innerHTML,/Current streak/);assert.match(f.nodes.get('account-usage-content').innerHTML,/Longest streak/);f.nodes.get('account-usage-dialog').close();assert.equal(f.document.activeElement,trigger);}finally{f.mounted.destroy();}
 assert.equal(f.nodes.get('account-activity-open').listeners.get('click')?.size||0,0);
});

test('ordinary usage filters invalidate only scope data, preserving investigation authority',async()=>{
 let scope='host=alpha',scopeChanges=0,authorityLoss=0;const f=fixture(async route=>route==='/api/account'?{viewer:{id:'owner',role:'admin'},capabilities:{authenticated:true}}:payload(),{getScope:()=>scope,onScopeChange:()=>scopeChanges++,onInvalidate:()=>authorityLoss++});
 try{await f.mounted.ready;scope='host=beta';f.mounted.repaint();assert.equal(scopeChanges,1);assert.equal(authorityLoss,0);await f.mounted.refresh();scope='host=alpha';f.mounted.repaint();assert.equal(scopeChanges,2);assert.equal(authorityLoss,0);}finally{f.mounted.destroy();}
});

test('changed account identity discards concurrent usage before publishing it to the previous investigation',async()=>{
 let identity='owner',published=0,authorityLoss=0;const f=fixture(async route=>route==='/api/account'?{viewer:{id:identity,role:'admin'},capabilities:{authenticated:true}}:payload(),{onUsage:()=>published++,onInvalidate:()=>authorityLoss++});
 try{await f.mounted.ready;const before=published;identity='other';await f.mounted.refresh({forceAccount:true});assert.equal(authorityLoss,1);assert.equal(published,before);}finally{f.mounted.destroy();}
});
