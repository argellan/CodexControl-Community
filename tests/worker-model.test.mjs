// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
const model=await import('../public/worker-model.mjs').catch(()=>({}));
const epoch=Date.parse('2026-10-20T08:00:00Z');
const at=n=>new Date(epoch+n).toISOString();
const worker=(id,extra={})=>({id,hostId:'lenovo',project:'Codex-Control',state:'Turn started',model:'recorded-model',effort:'max',lastEventAt:at(1000),...extra});
const event=(id,extra={})=>({id,hostId:'lenovo',sourceId:'source',sessionId:'parent',turnId:'turn',callId:id,at:at(1000),kind:'tool.start',label:'exec_command',...extra});
const hosts=[{id:'lenovo',status:'online'},{id:'rack',status:'online'}];
const summary=(sessions,events=[],extra={})=>model.buildWorkerSummary({sessions,events,hosts,sessionId:'parent',hostId:'lenovo',now:epoch+5000,...extra});
const quota=(usedPercent=25,extra={})=>({limitId:'codex',limitName:'Codex',accountKey:null,observedAt:at(1000),primary:{usedPercent,windowDurationMins:300,resetsAt:(epoch+600000)/1000},secondary:null,...extra});

test('worker relationships use explicit parent IDs and host scope, including cross-project children',()=>{
 assert.equal(typeof model.buildWorkerSummary,'function');
 const s=summary([worker('parent'),worker('child',{parentId:'parent',project:'Other'}),worker('outsider',{hostId:'rack',parentId:'parent'}),worker('guess',{agentPath:'/root/parent/guess'})]);
 assert.equal(s.childrenTotal,1);assert.equal(s.children[0].id,'child');assert.equal(s.parent,null);
 const child=summary([worker('parent'),worker('child',{parentId:'parent'})],[],{sessionId:'child'});assert.equal(child.parent.id,'parent');
});

test('tool matching preserves host, source, session, turn and call boundaries',()=>{
 const s=summary([worker('parent')],[event('call'),event('return',{kind:'tool.end',hostId:'rack',callId:'call'}),event('other-turn',{kind:'tool.end',callId:'call',turnId:'other'})]);
 assert.equal(s.openTools.length,1);assert.equal(s.lifecycle.state,'active');assert.equal(s.toolCounts.started,1);assert.equal(s.toolCounts.returned,1);
 const finished=summary([worker('parent')],[event('call'),event('return',{kind:'tool.end',callId:'call',at:at(2000)})]);assert.equal(finished.openTools.length,0);
});

test('quiet, stale, disconnected and incomplete capture never assert a worker is running',()=>{
 const events=[event('call')];
 assert.equal(summary([worker('parent')],events,{now:epoch+30000}).lifecycle.state,'unconfirmed');
 assert.equal(summary([worker('parent')],events,{hosts:[{id:'lenovo',status:'disconnected'}]}).lifecycle.state,'source-unavailable');
 assert.equal(summary([worker('parent',{capture:{tailLimited:true}})],events).captureIncomplete,true);
 assert.equal(summary([worker('parent')],[]).lifecycle.state,'quiet');
});

test('requests resolve only in the selected worker and terminal lifecycle supersedes incomplete tools',()=>{
 const events=[event('request',{kind:'approval',requestId:'R'}),event('other',{kind:'resolution',sessionId:'child',requestId:'R',at:at(2000)})];
 assert.equal(summary([worker('parent')],events).lifecycle.state,'waiting');
 events.push(event('done',{kind:'resolution',requestId:'R',at:at(3000)}));assert.equal(summary([worker('parent')],events).waitingCount,0);
 const complete=summary([worker('parent')],[event('call'),event('done',{kind:'complete',at:at(2000)})]);
 assert.equal(complete.lifecycle.state,'completed');assert.equal(complete.openTools.length,0);assert.equal(complete.unresolvedTools,1);assert.equal(complete.lifecycle.acceptance,'unverified');
});

test('context occupancy uses last source usage, excludes cumulative totals, and preserves missing/zero distinctions',()=>{
 const s=summary([worker('parent',{tokens:{total_tokens:90000},lastTokens:{total_tokens:4000},contextWindow:10000,usageObservedAt:at(2000)})]);
 assert.equal(s.context.usedPercent,40);assert.equal(s.tokens.total_tokens,90000);
 assert.equal(summary([worker('parent',{tokens:{total_tokens:90000},contextWindow:10000})]).context.usedPercent,null);
 assert.equal(summary([worker('parent',{lastTokens:{total_tokens:0},contextWindow:10000})]).context.usedPercent,0);
});

test('child count is bounded, missing parents are explicit and selection cannot cross host scope',()=>{
 const s=summary([worker('parent'),...Array.from({length:300},(_,i)=>worker('child-'+i,{parentId:'parent'}))],[],{maxChildren:8});
 assert.equal(s.children.length,8);assert.equal(s.childrenTotal,300);assert.equal(s.childrenTruncated,292);
 assert.equal(summary([worker('parent',{parentId:'missing'})]).parentMissing,true);
 assert.equal(summary([worker('parent',{hostId:'rack'})]),null);
});

test('same explicit account and bucket is one quota pool with newest report rather than added percentages',()=>{
 assert.equal(typeof model.buildUsageSummary,'function');
 const result=model.buildUsageSummary({sessions:[worker('one',{usageLimits:[quota(20,{accountKey:'a'.repeat(64)})]}),worker('two',{hostId:'rack',usageLimits:[quota(25,{accountKey:'a'.repeat(64),observedAt:at(2000)})]})],hosts,now:epoch+5000});
 assert.equal(result.quota.pools.length,1);assert.equal(result.quota.pools[0].primary.remainingPercent,75);assert.equal(result.quota.pools[0].sourceCount,2);
 assert.equal(result.quota.unlinked.length,0);assert.equal(result.billing.status,'unavailable');assert.equal(result.billing.subscriptionCost,null);
});

test('unknown accounts stay unlinked; stale or expired quota windows never become refreshed capacity',()=>{
 const result=model.buildUsageSummary({sessions:[worker('one',{usageLimits:[quota(20)]}),worker('two',{hostId:'rack',usageLimits:[quota(25,{primary:{usedPercent:25,resetsAt:(epoch+2000)/1000}})]})],hosts,now:epoch+5000});
 assert.equal(result.quota.pools.length,0);assert.equal(result.quota.unlinked.length,2);assert.equal(result.quota.accountCount,null);
 assert.equal(result.quota.unlinked.find(x=>x.hostId==='rack').primary.state,'expired');
 const stale=model.buildUsageSummary({sessions:[worker('one',{usageLimits:[quota(20)]})],hosts,now:epoch+400000});assert.equal(stale.quota.unlinked[0].primary.state,'stale');
});

test('worker counters preserve separate host sessions and disclose inherited fork totals instead of billing estimates',()=>{
 const result=model.buildUsageSummary({sessions:[worker('one',{tokens:{total_tokens:500}}),worker('one',{hostId:'rack',tokens:{total_tokens:600},lastEventAt:at(2000)}),worker('fork',{forkedFrom:'one',tokens:{total_tokens:700}}),worker('unknown')],hosts,now:epoch+5000});
 assert.equal(result.tokens.observedTotal,1100);assert.equal(result.tokens.sessionsWithReadings,2);assert.equal(result.tokens.excludedForks,1);assert.equal(result.tokens.unknownSessions,1);
 assert.match(result.tokens.label,/observed/i);assert.match(result.tokens.label,/copied sessions may overlap/i);assert.equal(result.models.length,1);assert.equal(result.models[0].totalTokens,1100);
});

test('per-host usage takes one newest reading per host session and reconciles with model and fleet observations',()=>{
 const result=model.buildUsageSummary({sessions:[
  worker('same',{tokens:{total_tokens:200},usageObservedAt:at(1000)}),
  worker('same',{tokens:{total_tokens:300},usageObservedAt:at(2000),model:'new-model'}),
  worker('same',{tokens:{total_tokens:900},usageObservedAt:at(1000)}),
  worker('same',{hostId:'rack',tokens:{total_tokens:700},usageObservedAt:at(1000)}),
 ],hosts:[{id:'lenovo',name:'Portable',status:'online'},{id:'rack',name:'Rack server',status:'disconnected'}],now:epoch+5000});
 assert.equal(result.tokens.observedTotal,1000);assert.equal(result.tokens.sessionsWithReadings,2);
 assert.deepEqual(result.hosts.map(h=>[h.hostId,h.hostName,h.totalTokens,h.sessionsWithReadings,h.sharePercent]),[['rack','Rack server',700,1,70],['lenovo','Portable',300,1,30]]);
 assert.equal(result.hosts[0].sourceStatus,'disconnected');assert.equal(result.hosts[1].lastObservedAt,at(2000));
 assert.equal(result.hosts.reduce((sum,h)=>sum+(h.totalTokens??0),0),1000);
 assert.deepEqual(result.models.map(m=>[m.model,m.totalTokens,m.sessions]),[['recorded-model',700,1],['new-model',300,1]]);
});

test('per-host counters distinguish zero, unavailable, future and excluded fork observations without duplicating snapshots',()=>{
 const zero=worker('zero',{tokens:{total_tokens:0},usageObservedAt:at(1000)}),unknown=worker('unknown'),fork=worker('fork',{forkedFrom:'zero',tokens:{total_tokens:900}});
 const result=model.buildUsageSummary({sessions:[zero,{...zero},unknown,{...unknown},fork,{...fork},worker('future',{hostId:'rack',tokens:{total_tokens:100},usageObservedAt:at(10000)})],hosts:[...hosts,{id:'empty',name:'Empty source',status:'online'}],now:epoch+5000});
 assert.equal(result.tokens.observedTotal,0);assert.equal(result.tokens.sessionsWithReadings,1);assert.equal(result.tokens.excludedForks,1);assert.equal(result.tokens.unknownSessions,2);
 const laptop=result.hosts.find(h=>h.hostId==='lenovo'),rack=result.hosts.find(h=>h.hostId==='rack'),empty=result.hosts.find(h=>h.hostId==='empty');
 assert.equal(laptop.totalTokens,0);assert.equal(laptop.sessionsWithReadings,1);assert.equal(laptop.excludedForks,1);assert.equal(laptop.unknownSessions,1);assert.equal(laptop.sharePercent,null);
 assert.equal(rack.totalTokens,null);assert.equal(rack.unknownSessions,1);assert.equal(rack.lastObservedAt,null);
 assert.equal(empty.totalTokens,null);assert.equal(empty.sessionsWithReadings,0);assert.equal(empty.unknownSessions,0);
});

test('per-host usage is stable under repeated snapshots and never changes explicit account deduplication',()=>{
 const readings=[worker('one',{tokens:{total_tokens:50},usageObservedAt:at(1000),usageLimits:[quota(30,{accountKey:'a'.repeat(64)})]}),worker('two',{hostId:'rack',tokens:{total_tokens:150},usageObservedAt:at(2000),usageLimits:[quota(35,{accountKey:'a'.repeat(64),observedAt:at(2000)})]})];
 const once=model.buildUsageSummary({sessions:readings,hosts,now:epoch+5000}),repeated=model.buildUsageSummary({sessions:[...readings,...readings].reverse(),hosts,now:epoch+5000});
 assert.deepEqual(repeated,once);assert.equal(once.quota.pools.length,1);assert.equal(once.quota.pools[0].sourceCount,2);assert.equal(once.quota.pools[0].primary.usedPercent,35);
});

test('models suppress future metadata during historical replay and output excludes arbitrary source fields',()=>{
 const s=summary([worker('parent',{usageObservedAt:at(100000),lastTokens:{total_tokens:100,secret:'PRIVATE'},tokens:{total_tokens:1000,secret:'PRIVATE'},private:'PRIVATE'})],[event('future',{at:at(100000),kind:'complete'})]);
 assert.equal(s.context.usedTokens,null);assert.equal(s.tokens,null);assert.ok(!JSON.stringify(s).includes('PRIVATE'));assert.notEqual(s.lifecycle.state,'completed');
 const q=model.buildUsageSummary({sessions:[worker('parent',{usageLimits:[quota(50,{observedAt:at(100000)})]})],hosts,now:epoch+5000});assert.equal(q.quota.unlinked.length,0);
});

test('unlinked account sightings on the same host remain distinct per worker source',()=>{
 const result=model.buildUsageSummary({sessions:[worker('one',{usageLimits:[quota(20)]}),worker('two',{usageLimits:[quota(90)]})],hosts,now:epoch+5000});
 assert.equal(result.quota.pools.length,0);assert.equal(result.quota.unlinked.length,2);assert.equal(result.quota.accountCount,null);
});

test('sparse same-account quota reports preserve each newest window without inventing fresh ages',()=>{
 const first=quota(10,{accountKey:'a'.repeat(64),primaryObservedAt:at(1000),secondary:{usedPercent:40,resetsAt:(epoch+700000)/1000},secondaryObservedAt:at(1000)});
 const second=quota(15,{accountKey:'a'.repeat(64),observedAt:at(2000),primaryObservedAt:at(2000)});
 const result=model.buildUsageSummary({sessions:[worker('one',{usageLimits:[first]}),worker('two',{usageLimits:[second]})],hosts,now:epoch+5000});
 assert.equal(result.quota.pools[0].primary.usedPercent,15);assert.equal(result.quota.pools[0].secondary.usedPercent,40);assert.equal(result.quota.pools[0].secondary.ageMs,4000);
});

test('an old terminal record cannot complete a later tool cycle and future per-window quota is hidden',()=>{
 const complete=event('complete',{kind:'complete'}),start=event('next',{at:at(2000)}),end=event('next-end',{kind:'tool.end',callId:'next',at:at(3000)});
 assert.notEqual(summary([worker('parent')],[complete,start,end]).lifecycle.state,'completed');
 const result=model.buildUsageSummary({sessions:[worker('one',{usageLimits:[quota(20,{primaryObservedAt:at(100000)})]})],hosts,now:epoch+5000});
 assert.equal(result.quota.unlinked[0].primary,null);
});

test('quota sanitizer rejects nested source payloads and raw identity strings',()=>{
 assert.equal(typeof model.sanitizeUsageLimits,'function');
 const limits=model.sanitizeUsageLimits([quota(10,{accountKey:'raw@email.invalid',secret:'PRIVATE',primary:{usedPercent:10,secret:'PRIVATE'}})]);
 assert.equal(limits[0].accountKey,null);assert.ok(!JSON.stringify(limits).includes('PRIVATE'));assert.equal(model.sanitizeUsageLimits({primary:{usedPercent:10}}),null);
});

test('request resolution and duplicate evidence preserve full source/turn boundaries',()=>{
 const request=event('request',{kind:'approval',requestId:'R'});
 const s=summary([worker('parent')],[request,{...request},event('wrong-source',{kind:'resolution',requestId:'R',sourceId:'other',at:at(2000)}),event('wrong-turn',{kind:'resolution',requestId:'R',turnId:'other',at:at(3000)})]);
 assert.equal(s.waitingCount,1);assert.equal(s.capturedEventCount,3);
 const call=event('call'),calls=summary([worker('parent')],[call,{...call}]);assert.equal(calls.toolCounts.started,1);assert.equal(calls.openTools.length,1);
});
