// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
const model=await import('../public/operational-alerts.mjs').catch(()=>({}));
const now=Date.parse('2026-10-20T12:00:00Z'),at=offset=>new Date(now+offset).toISOString();
const host=(id='example',extra={})=>({id,name:'Example host',status:'online',receivedAt:at(-1000),sourceObservedAt:at(-1000),telemetry:{cpu:95,totalMemory:1000,freeMemory:50},...extra});
const event=(id,extra={})=>({id,hostId:'example',sourceId:'native',sessionId:'worker',turnId:'turn',callId:'call',kind:'tool.start',at:at(-30000),label:'Recorded tool',...extra});
const quota=(usedPercent,extra={})=>({limitId:'codex',observedAt:at(-1000),primary:{usedPercent,windowDurationMins:300,resetsAt:(now+600000)/1000},secondary:null,...extra});
const session=(id,usageLimits,extra={})=>({id,hostId:'example',project:'Example',usageLimits,...extra});
const alerts=(extra={})=>model.operationalAlerts({hosts:[host()],now,...extra});

test('fresh host readings produce stable qualified CPU and RAM alerts without job attribution',()=>{
 assert.equal(typeof model.operationalAlerts,'function');const items=alerts();assert.equal(items.length,2);
 assert.deepEqual(items.map(i=>i.metric).sort(),['cpu','memory']);assert.ok(items.every(i=>i.priority===1&&i.attention&&i.hostId==='example'&&i.sourceAt===at(-1000)&&i.kind!=='approval'));
 assert.ok(items.every(i=>!Object.hasOwn(i,'sessionId')&&!Object.hasOwn(i,'jobId')&&/host/i.test(i.label)));
 assert.deepEqual(alerts({now:now+500}).map(i=>i.id),items.map(i=>i.id));
 assert.equal(alerts({thresholds:{cpuPercent:96,memoryPercent:96}}).length,0);
 assert.equal(alerts({hosts:[host('example',{telemetry:{cpu:90,totalMemory:1000,freeMemory:100}})]}).length,0);
});

test('stale, future, unavailable and invalid host measurements do not manufacture load warnings',()=>{
 for(const extra of [{sourceObservedAt:at(-16000)},{sourceObservedAt:at(1)},{receivedAt:at(1)},{receivedAt:at(-16000)},{status:'stale'},{status:'disconnected'},{sourceObservedAt:'invalid'}])assert.equal(alerts({hosts:[host('example',extra)]}).length,0);
 for(const telemetry of [{cpu:NaN,totalMemory:NaN,freeMemory:0},{cpu:Infinity,totalMemory:0,freeMemory:0},{cpu:101,totalMemory:100,freeMemory:-1},{cpu:'95',totalMemory:100,freeMemory:101}])assert.equal(alerts({hosts:[host('example',{telemetry})]}).length,0);
 assert.equal(alerts({hosts:[host('example',{sourceObservedAt:null})]}).length,2);
});

test('quota sightings use the freshest report per source and window without pooling unlinked accounts',()=>{
 const sessions=Array.from({length:83},(_,i)=>session('worker-'+i,[quota(i===82?95:99,{observedAt:at(-9000+i*50)})]));
 const items=alerts({hosts:[host('example',{telemetry:null}),host('other',{telemetry:null})],sessions:[...sessions,session('remote',[quota(96)],{hostId:'other'})]});
 assert.equal(items.length,2);assert.deepEqual(items.map(i=>i.remainingPercent).sort(),[4,5]);assert.ok(items.every(i=>i.kind==='quota-alert'&&/account-unlinked/i.test(i.label)&&i.accountLinked===false));
 assert.ok(items.every(i=>!Object.hasOwn(i,'accountCount')&&!Object.hasOwn(i,'subscriptionCost')));
 const healthyNewest=alerts({hosts:[host('example',{telemetry:null})],sessions:[session('old',[quota(99,{observedAt:at(-5000)})]),session('new',[quota(50)])]});assert.equal(healthyNewest.length,0);
});

test('quota windows independently reject stale, expired, future and malformed observations',()=>{
 const rows=[quota(99,{observedAt:at(-300001)}),quota(99,{primary:{usedPercent:99,resetsAt:(now-1)/1000}}),quota(99,{observedAt:at(1)}),quota(NaN),quota(101)];
 for(const q of rows)assert.equal(alerts({hosts:[host('example',{telemetry:null})],sessions:[session('worker',[q])]}).length,0);
 const q=quota(99,{primaryObservedAt:at(-300001),secondary:{usedPercent:95,windowDurationMins:10080,resetsAt:(now+600000)/1000},secondaryObservedAt:at(-1000)});
 const items=alerts({hosts:[host('example',{telemetry:null})],sessions:[session('worker',[q])]});assert.equal(items.length,1);assert.equal(items[0].window,'secondary');
 assert.equal(alerts({hosts:[host('example',{status:'stale',telemetry:null})],sessions:[session('worker',[quota(99)])]}).length,0);
});

test('explicit account evidence remains qualified and never adds percentages across source machines',()=>{
 const accountKey='a'.repeat(64),items=alerts({hosts:[host('example',{telemetry:null}),host('other',{telemetry:null})],sessions:[session('one',[quota(95,{accountKey})]),session('two',[quota(97,{accountKey})],{hostId:'other'})]});
 assert.ok(items.length>0&&items.length<=2);assert.ok(items.every(i=>[3,5].includes(i.remainingPercent)&&i.accountLinked===true));assert.ok(items.every(i=>!JSON.stringify(i).includes(accountKey)));
});

test('an unanswered tool warns only while its own thread and source continue reporting',()=>{
 const start=event('start'),fresh=event('fresh',{kind:'message',callId:undefined,at:at(-1000)}),items=alerts({hosts:[host('example',{telemetry:null})],events:[start,fresh]});
 assert.equal(items.length,1);assert.equal(items[0].kind,'tool-unanswered');assert.equal(items[0].eventId,'start');assert.equal(items[0].sourceAt,start.at);assert.equal(items[0].sessionId,'worker');assert.match(items[0].label,/captured result/i);
 assert.equal(alerts({hosts:[host('example',{telemetry:null})],events:[start]}).length,0);
 for(const change of [{hostId:'other'},{sourceId:'other'},{sessionId:'other'},{at:at(1)}])assert.equal(alerts({hosts:[host('example',{telemetry:null}),host('other',{telemetry:null})],events:[start,{...fresh,...change}]}).length,0);
 assert.equal(alerts({hosts:[host('example',{telemetry:null})],events:[start,fresh],thresholds:{toolUnansweredSeconds:31}}).length,0);
});

test('tool results close only matching calls while captured terminal records suppress incomplete result warnings',()=>{
 const start=event('start'),fresh=event('fresh',{kind:'message',at:at(-1000)}),end=event('end',{kind:'tool.end',at:at(-2000)});
 assert.equal(alerts({hosts:[host('example',{telemetry:null})],events:[start,end,fresh]}).length,0);
 for(const change of [{hostId:'other'},{sourceId:'other'},{sessionId:'other'},{turnId:'other'},{callId:'other'}])assert.equal(alerts({hosts:[host('example',{telemetry:null})],events:[start,{...end,...change},fresh]}).length,1);
 assert.equal(alerts({hosts:[host('example',{telemetry:null})],events:[start,event('complete',{kind:'complete',at:at(-1000)})]}).length,0);
 assert.equal(alerts({hosts:[host('example',{status:'disconnected',telemetry:null})],events:[start,fresh]}).length,0);
});

test('a captured same-timestamp result closes its call regardless of event ordering or lexical IDs',()=>{
 const start=event('z-start'),end=event('a-end',{kind:'tool.end'}),fresh=event('fresh',{kind:'message',at:at(-1000)});
 for(const events of [[start,end,fresh],[fresh,end,start]])assert.equal(alerts({hosts:[host('example',{telemetry:null})],events}).length,0);
});

test('alerts are bounded, deterministic, metadata-only and leave inputs unchanged',()=>{
 const input={hosts:Array.from({length:100},(_,i)=>host('example-'+i)),sessions:[],events:[],now},before=structuredClone(input);input.hosts[0].private='PRIVATE_SENTINEL';before.hosts[0].private='PRIVATE_SENTINEL';
 const items=model.operationalAlerts(input);assert.equal(items.length,40);assert.deepEqual(input,before);assert.equal(JSON.stringify(items).includes('PRIVATE_SENTINEL'),false);assert.deepEqual(model.operationalAlerts(input),items);
 assert.deepEqual(model.operationalAlerts({now:NaN}),[]);
});

test('archive attention requires a fresh health reading and actionable backlog, failure or storage pressure',()=>{
 const usage=archive=>({observedAt:at(0),usageHistory:{archive}}),run=value=>model.operationalAlerts({now,usage:value});
 assert.equal(run(usage({status:'healthy',pendingRecords:3,oldestPendingAt:at(-5000)})).length,0);
 const old=run(usage({status:'healthy',pendingRecords:3,oldestPendingAt:at(-300001)}));assert.equal(old.length,1);assert.equal(old[0].kind,'archive-alert');assert.equal(old[0].target,'storage');assert.equal(old[0].hostId,null);assert.match(old[0].label,/remain protected on the Pi/);
 assert.equal(run(usage({status:'failed',pendingRecords:0})).length,1);assert.equal(run(usage({status:'healthy',pendingRecords:0,storage:{pressure:true}})).length,1);assert.equal(run(usage({status:'unconfigured',pendingRecords:0})).length,0);
 assert.equal(run({...usage({status:'failed'}),observedAt:at(-30001)}).length,0);assert.equal(run({...usage({status:'failed'}),observedAt:at(1)}).length,0);assert.equal(run(usage({status:'restricted',pendingRecords:100000,storage:{pressure:true}})).length,0);
});

test('native account quota attention keeps independent windows, blocked permission and source age without assigning worker charges',()=>{
 const account={accountKey:'a'.repeat(64),hostIds:['example'],limitsObservedAt:at(-1000),ordinaryUsageAllowed:false,limits:[{limitId:'codex',primary:{usedPercent:98,resetsAt:(now+600000)/1000},secondary:{usedPercent:40,resetsAt:(now+600000)/1000}}]},usage={observedAt:at(0),accountUsage:{accounts:[account]}};
 const items=model.operationalAlerts({now,usage});assert.equal(items.length,2);assert.ok(items.every(item=>item.target==='weekly'));assert.equal(items.find(item=>item.kind==='account-quota-alert').remainingPercent,2);assert.match(items.find(item=>item.kind==='account-quota-alert').label,/not assigned to a worker/);assert.ok(!JSON.stringify(items).includes(account.accountKey));assert.equal(model.attentionCaption(items[0]).startsWith('ACCOUNT'),true);
 for(const observed of [at(-120001),at(1),null]){const value=structuredClone(usage);value.accountUsage.accounts[0].limitsObservedAt=observed;assert.equal(model.operationalAlerts({now,usage:value}).length,0);}
 const denied=structuredClone(usage);denied.accountUsage.status='restricted';assert.equal(model.operationalAlerts({now,usage:denied}).length,0);
 const expired=structuredClone(usage);expired.accountUsage.accounts[0].ordinaryUsageAllowed=true;expired.accountUsage.accounts[0].limits[0].primary.resetsAt=(now-1)/1000;assert.equal(model.operationalAlerts({now,usage:expired}).length,0);
});

test('thread prefix reuse preserves exact URI encoding and distinct delimiter-bearing source tuples',()=>{
 const sourceId='src:one%two',sessionId='worker/one',turnId='turn:1',callId='call/%x',start=event('start:<>&',{sourceId,sessionId,turnId,callId}),fresh=event('fresh',{sourceId,sessionId,turnId,callId,kind:'message',at:at(-1000)}),items=alerts({hosts:[host('example',{telemetry:null})],events:[start,fresh]});
 assert.equal(items.length,1);assert.equal(items[0].id,'tool-unanswered:example:src%3Aone%25two:worker%2Fone:turn%3A1:call%2F%25x');assert.equal(items[0].eventId,'start:<>&');
 const a=event('a',{sourceId:'a:b',sessionId:'c'}),b=event('b',{sourceId:'a',sessionId:'b:c',kind:'message',at:at(-1000)});assert.equal(alerts({hosts:[host('example',{telemetry:null})],events:[a,b]}).length,0);
 const both=alerts({hosts:[host('example',{telemetry:null})],events:[a,b,{...b,id:'a-fresh',sourceId:'a:b',sessionId:'c'}]});assert.equal(both.length,1);assert.equal(both[0].id,'tool-unanswered:example:a%3Ab:c:turn:call');
});

test('null undefined and ill-formed Unicode identities retain first duplicate precedence and exact call closure',()=>{
 const start=event(null,{sourceId:null,label:'FIRST duplicate'}),duplicate=event(undefined,{sourceId:undefined,label:'SECOND duplicate',at:at(-20000)}),fresh=event('fresh',{sourceId:'',kind:'message',at:at(-1000)}),items=alerts({hosts:[host('example',{telemetry:null})],events:[start,duplicate,fresh]});
 assert.equal(items.length,1);assert.equal(items[0].id,'tool-unanswered:example::worker:turn:call');assert.equal(items[0].ageMs,30000);assert.match(items[0].label,/FIRST duplicate/);assert.doesNotMatch(items[0].label,/SECOND/);
 assert.equal(alerts({hosts:[host('example',{telemetry:null})],events:[start,{...fresh,id:undefined}]}).length,0,'An encoded duplicate cannot refresh its thread');
 const surrogate=event('unicode',{sourceId:'bad\ud800',turnId:'t\udc00',callId:'c\ud800'}),unicodeFresh={...fresh,id:'unicode-fresh',sourceId:'bad\ufffd'};
 const warning=alerts({hosts:[host('example',{telemetry:null})],events:[surrogate,unicodeFresh]});assert.equal(warning[0].id,'tool-unanswered:example:bad%EF%BF%BD:worker:t%EF%BF%BD:c%EF%BF%BD');
 assert.equal(alerts({hosts:[host('example',{telemetry:null})],events:[surrogate,event('end',{kind:'tool.end',sourceId:'bad\ufffd',turnId:'t\ufffd',callId:'c\ufffd',at:at(-2000)}),unicodeFresh]}).length,0);
});

test('coercible accessor and inherited fields keep the original conversion and property-read behavior',()=>{
 let conversions=0;const source={toString(){conversions++;return 'coercible source';}},start=event('start',{sourceId:source}),fresh=event('fresh',{sourceId:source,kind:'message',at:at(-1000)});assert.equal(alerts({hosts:[host('example',{telemetry:null})],events:[start,fresh]}).length,1);assert.equal(conversions,6);
 let turns=0;const turn={toString(){turns++;return 'coercible turn';}};alerts({hosts:[host('example',{telemetry:null})],events:[event('message',{kind:'message',at:at(-1000),turnId:turn})]});assert.equal(turns,1,'Non-tool coercible call fields still follow the legacy path');
 let sourceReads=0,kindReads=0;const accessed=event('accessed',{kind:'message',at:at(-1000)});Object.defineProperty(accessed,'sourceId',{get(){sourceReads++;return 'native';}});Object.defineProperty(accessed,'kind',{get(){kindReads++;return 'message';}});alerts({hosts:[host('example',{telemetry:null})],events:[accessed]});assert.equal(sourceReads,3);assert.equal(kindReads,3);
 const inherited=Object.assign(Object.create({sourceId:'inherited',turnId:'turn',callId:'call'}),{id:'inherited-start',hostId:'example',sessionId:'worker',kind:'tool.start',at:at(-30000),label:'Inherited source'});const result=alerts({hosts:[host('example',{telemetry:null})],events:[inherited,{...fresh,sourceId:'inherited'}]});assert.equal(result[0].id,'tool-unanswered:example:inherited:worker:turn:call');
});

test('per-call prefix state expires on metadata corrections backseek and source freshness changes',()=>{
 const start=event('start'),fresh=event('fresh',{kind:'message',at:at(-1000)}),input={hosts:[host('example',{telemetry:null})],events:[start,fresh],now};assert.equal(model.operationalAlerts(input).length,1);
 fresh.sourceId='different source';assert.equal(model.operationalAlerts(input).length,0);fresh.sourceId='native';start.callId='new call';const before=structuredClone(input),updated=model.operationalAlerts(input);assert.equal(updated[0].id,'tool-unanswered:example:native:worker:turn:new%20call');assert.deepEqual(input,before);
 input.now=now-2000;assert.equal(model.operationalAlerts(input).length,0);input.now=now;input.hosts[0].status='stale';assert.equal(model.operationalAlerts(input).length,0);input.hosts[0].status='online';assert.equal(model.operationalAlerts(input)[0].callId,'new call');
});

test('more than 1024 distinct threads preserve later source liveness and bounded alert ordering',()=>{
 const events=[];for(let i=0;i<1200;i++){const sourceId='source-'+i;events.push(event('start-'+i,{sourceId,at:at(i===1199?-16000:-30000)}),event('fresh-'+i,{sourceId,kind:'message',at:at(-1000)}));}
 const before=structuredClone(events),items=alerts({hosts:[host('example',{telemetry:null})],events});assert.equal(items.length,40);assert.equal(items[0].sourceId,'source-1199');assert.deepEqual(events,before);assert.deepEqual(alerts({hosts:[host('example',{telemetry:null})],events}),items);
});

test('reflection-refusing proxies retain the original ordinary-field admission path',()=>{
 const start=new Proxy(event('proxy-start'),{getOwnPropertyDescriptor(){throw new Error('Reflection unavailable');}}),fresh=event('fresh',{kind:'message',at:at(-1000)}),items=alerts({hosts:[host('example',{telemetry:null})],events:[start,fresh]});assert.equal(items.length,1);assert.equal(items[0].eventId,'proxy-start');
 const missing=event('missing-source');delete missing.sourceId;const hasRefusal=new Proxy(missing,{has(){throw new Error('Membership reflection unavailable');}});const other=alerts({hosts:[host('example',{telemetry:null})],events:[hasRefusal,{...fresh,sourceId:undefined}]});assert.equal(other.length,1);assert.equal(other[0].id,'tool-unanswered:example::worker:turn:call');
});

test('staged alerts preserve exact complete output and yield across all source chunks',()=>{const events=Array.from({length:5000},(_,i)=>event('event-'+i,{kind:i%2?'tool.end':'tool.start',callId:'call-'+Math.floor(i/2),at:at(-10000+i)}));const input={hosts:[host()],events,now},expected=model.operationalAlerts(input),stages=model.operationalAlertStages(input);let step,yields=0;do{step=stages.next();if(!step.done)yields++;}while(!step.done);assert.equal(yields,9);assert.deepEqual(step.value,expected);assert.equal(events.length,5000);});
