// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {normalizeNativeDataset,encodeNativeAnalytics,nativeAnalyticsReference} from '../lib/native-account-analytics.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createServer} from './fixture-server.mjs';
import {FleetHub} from '../lib/fleet.mjs';
import {sanitizeAccountUsage,buildAccountUsageResponse,activeTokenUsage} from '../lib/account-usage.mjs';

const now=Date.parse('2026-01-20T12:00:00Z'),at=new Date(now).toISOString();
const admin={id:'test-owner',label:'TEST_ONLY owner',username:'test-owner',role:'admin',hostIds:null,projectIds:null};
const report=(overrides={})=>({version:1,source:'codex-app-server',status:'available',observedAt:at,lastAttemptAt:at,accountKey:'a'.repeat(64),planType:'pro',limitsObservedAt:at,usageObservedAt:at,limits:[{limitId:'codex',limitName:null,planType:'pro',primary:{usedPercent:17,windowDurationMins:10080,resetsAt:Math.floor(now/1000)+3600},secondary:null}],summary:{lifetimeTokens:10000,peakDailyTokens:300,longestRunningTurnSec:45,currentStreakDays:3,longestStreakDays:5},dailyUsageBuckets:[{startDate:'2026-01-19',tokens:300}],errorCode:null,...overrides});
const source=(hostId,accountUsage)=>({hostId,accountUsage});
test('account observation boundary rejects credentials, invalid dates, excessive arrays and unsafe counters',()=>{
 assert.deepEqual(sanitizeAccountUsage(report()),report());
 for(const value of [report({email:'PRIVATE'}),report({summary:{...report().summary,password:'PRIVATE'}}),report({limits:[{...report().limits[0],token:'PRIVATE'}]}),report({dailyUsageBuckets:[{startDate:'2026-02-30',tokens:1}]}),report({summary:{...report().summary,peakDailyTokens:Number.MAX_SAFE_INTEGER+1}}),report({dailyUsageBuckets:Array.from({length:367},(_,i)=>({startDate:'2026-01-19',tokens:i}))})])assert.throws(()=>sanitizeAccountUsage(value),/Invalid account/);
});
test('account reports deduplicate only explicit identities and do not combine peak days across accounts',()=>{
 let r=buildAccountUsageResponse({viewer:admin,now,sources:[source('first',report()),source('second',report())]});
 assert.equal(r.accountUsage.accountCount,1);assert.equal(r.accountUsage.summary.peakDailyTokens,300);assert.equal(r.accountUsage.accounts[0].hostIds.length,2);
 r=buildAccountUsageResponse({viewer:admin,now,sources:[source('first',report({accountKey:null})),source('second',report({accountKey:null}))]});
 assert.equal(r.accountUsage.accountCount,2);assert.equal(r.accountUsage.summary,null);assert.equal(r.accountUsage.status,'multiple');
});
test('account section freshness never borrows a refreshed token-history date for old weekly limits',()=>{
 const older=new Date(now-180000).toISOString();
 const r=buildAccountUsageResponse({viewer:admin,now,sources:[source('first',report({limitsObservedAt:older}))]});
 assert.equal(r.accountUsage.status,'stale');assert.equal(r.accountUsage.limitsObservedAt,older);
 const future=buildAccountUsageResponse({viewer:admin,now,sources:[source('first',report({limitsObservedAt:new Date(now+1).toISOString()}))]});assert.equal(future.accountUsage.status,'stale');
});
test('account-wide metrics are omitted for both full-fleet and scoped viewers',()=>{
 for(const viewer of [{...admin,role:'viewer'},{...admin,role:'viewer',hostIds:['first'],projectIds:['TEST_ONLY']}]){
  const r=buildAccountUsageResponse({viewer,now,sources:[source('first',report())]});assert.equal(r.accountUsage.status,'restricted');assert.equal(r.accountUsage.accounts.length,0);assert.equal(r.accountUsage.summary,null);assert.ok(!JSON.stringify(r).includes('10000'));
 }
});
test('active tokens exclude completed, disconnected, old activity and inherited fork totals',()=>{
 const session={id:'current',hostId:'first',project:'TEST_ONLY',state:'Turn started',lastEventAt:at,usageObservedAt:at,tokens:{input_tokens:100,cached_input_tokens:40,output_tokens:20,total_tokens:120}};
 const r=activeTokenUsage({hosts:[{id:'first',status:'online'},{id:'offline',status:'disconnected'}],sessions:[session,{...session,id:'done',state:'Turn completed'},{...session,id:'fork',forkedFrom:'parent'},{...session,id:'old',lastEventAt:new Date(now-300001).toISOString()},{...session,id:'offline',hostId:'offline'}]},now);
 assert.equal(r.sessions,1);assert.equal(r.inputTokens,100);assert.equal(r.cachedInputTokens,40);assert.equal(r.totalTokens,120);assert.equal(r.status,'observed');
 const missing=activeTokenUsage({hosts:[{id:'first',status:'online'}],sessions:[{...session,tokens:null}]},now);assert.equal(missing.totalTokens,null);
});
test('bounded tails with no turn-start use fresh token and source evidence without reviving terminal workers',()=>{
 const s={id:'tail',hostId:'first',state:'Unknown',lastEventAt:at,usageObservedAt:at,tokens:{total_tokens:123}},hosts=[{id:'first',status:'online'}];
 const current=activeTokenUsage({hosts,sessions:[s]},now);assert.equal(current.sessions,1);assert.equal(current.totalTokens,123);assert.equal(current.workers[0].activityBasis,'recent-source-activity');
 for(const changed of [{usageObservedAt:new Date(now-120001).toISOString()},{lastEventAt:new Date(now-120001).toISOString()},{state:'Turn completed'},{state:'Final answer recorded'},{state:'Input requested'}])assert.equal(activeTokenUsage({hosts,sessions:[{...s,...changed}]},now).sessions,0);
});
test('partial active totals exclude stale token values while retaining the visible worker count',()=>{
 const s={id:'fresh',hostId:'first',state:'Turn started',lastEventAt:at,usageObservedAt:at,tokens:{input_tokens:100,cached_input_tokens:40,output_tokens:20,total_tokens:120}};
 const r=activeTokenUsage({hosts:[{id:'first',status:'online'}],sessions:[s,{...s,id:'stale',usageObservedAt:new Date(now-120001).toISOString(),tokens:{input_tokens:999000,cached_input_tokens:900000,output_tokens:10000,total_tokens:1009000}}]},now);
 assert.equal(r.status,'partial');assert.equal(r.sessions,2);assert.equal(r.inputTokens,100);assert.equal(r.cachedInputTokens,40);assert.equal(r.outputTokens,20);assert.equal(r.totalTokens,120);
});

const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
test('authenticated usage survives journal restart, stays out of snapshots, denies viewers and adds no events',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-account-TEST_ONLY-'));let server,hub;
 const host={id:'test-source',label:'TEST_ONLY source',tokenHash:digest('TEST_ONLY_collector')};
 const viewers=[{...admin,tokenHash:digest('TEST_ONLY_owner')},{id:'test-viewer',label:'TEST_ONLY viewer',role:'viewer',hostIds:['test-source'],projectIds:['TEST_ONLY'],tokenHash:digest('TEST_ONLY_viewer')}];
 try{
  const observation=report({ordinaryUsageAllowed:false,rateLimitResetCredits:{availableCount:0,credits:[]},threadUsage:null});Object.assign(observation.limits[0],{credits:{hasCredits:true,unlimited:false,balance:'12345.6789000000'},spendControlReached:false,individualLimit:null,normalModelSlug:null,rateLimitReachedType:null});
  hub=await FleetHub.open({directory,hosts:[host]});const payload={hostId:host.id,batchId:'test-batch',observedAt:at,sessions:[],events:[],accountUsage:observation};
  assert.equal((await hub.ingest('TEST_ONLY_collector',payload)).added,0);assert.equal((await hub.ingest('TEST_ONLY_collector',payload)).added,0);assert.equal(hub.journal.status().retainedEvents,0);
  const capturedAt=Date.now(),sample=(project,index)=>({session_id:'TEST_ONLY_session_'+index,source_id:digest('TEST_ONLY_source'),source_record_key:digest('TEST_ONLY_record_'+index),source_offset:index,source_kind:'token_usage_record',usage_scope:'response',source_ms:capturedAt-1000,time_basis:'source',project,native_thread_id:'TEST_ONLY_thread',native_turn_id:'TEST_ONLY_turn_'+index,native_response_id:'TEST_ONLY_response_'+index,input_tokens:100,cached_input_tokens:50,output_tokens:20,reasoning_output_tokens:10,total_tokens:120,reported_mask:59,provider_reported_mask:59,synthesized_mask:0});
  await hub.ingest('TEST_ONLY_collector',{hostId:host.id,batchId:'test-series',observedAt:new Date(capturedAt).toISOString(),sessions:[],events:[],accountUsage:observation,usageSamples:[sample('TEST_ONLY',1),sample('TEST_ONLY_SECRET',2)]});
  hub=await FleetHub.open({directory,hosts:[host]});assert.deepEqual(hub.states.get(host.id).accountUsage,observation);
  server=createServer({hub,viewers});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/api/account/usage')).status,401);
  const get=async(route,key)=>{const r=await fetch(base+route,{headers:{authorization:'Bearer '+key}});assert.equal(r.status,200);return r.json();};
  const profile=await get('/api/account','TEST_ONLY_owner');assert.equal(profile.viewer.username,'test-owner');assert.equal(profile.viewer.role,'admin');assert.ok(!JSON.stringify(profile).includes('tokenHash'));assert.ok(!JSON.stringify(profile).includes('passwordHash'));
  const owner=await get('/api/account/usage','TEST_ONLY_owner');assert.equal(owner.accountUsage.summary.peakDailyTokens,300);assert.equal(owner.accountUsage.accounts[0].ordinaryUsageAllowed,false);assert.equal(owner.accountUsage.accounts[0].limits[0].credits.balance,'12345.6789000000');assert.deepEqual(owner.accountUsage.accounts[0].rateLimitResetCredits,{availableCount:0,credits:[]});
  const compact=await get('/api/account/usage?summary=1','TEST_ONLY_owner');assert.deepEqual(compact.accountUsage.summary,owner.accountUsage.summary);assert.deepEqual(compact.accountUsage.accounts[0].limits,owner.accountUsage.accounts[0].limits);assert.equal(compact.usageHistory.projection,'live-summary');assert.ok(Array.isArray(compact.usageHistory.observations));assert.ok(compact.usageHistory.observations.length<=200);for(const field of ['daily','accountObservations','accountDaily'])assert.equal(Object.hasOwn(compact.usageHistory,field),false);assert.deepEqual(compact.usageHistory.storage,owner.usageHistory.storage);const details=await get('/api/account/usage?details=1','TEST_ONLY_owner');assert.ok(Array.isArray(details.usageHistory.accountObservations));
  const limited=await get('/api/account/usage','TEST_ONLY_viewer');assert.equal(limited.accountUsage.status,'restricted');assert.equal(limited.accountUsage.accounts.length,0);
  const series=await get('/api/account/usage?details=1&series=1&period=1h','TEST_ONLY_viewer');assert.equal(series.sampleAnalytics.responses.records.length,1);assert.equal(series.sampleAnalytics.responses.records[0].project,'TEST_ONLY');assert.equal(JSON.stringify(series.sampleAnalytics).includes('TEST_ONLY_SECRET'),false);assert.equal(Date.parse(series.sampleAnalytics.scope.to)-Date.parse(series.sampleAnalytics.scope.from),3600000);assert.equal(series.accountUsage.status,'restricted');
  const packed=await get('/api/account/usage?details=1&series=1&seriesFormat=columns-v1&period=1h','TEST_ONLY_viewer');
  const wire=packed.sampleAnalytics.responses.records;
  assert.equal(wire.schema,'usage-response-columns-v1');assert.ok(Array.isArray(wire.columns));assert.equal(wire.rows.length,1);
  const decoded=wire.rows.map(values=>Object.fromEntries(wire.columns.map((column,index)=>[column,values[index]])));
  assert.deepEqual(decoded,series.sampleAnalytics.responses.records);assert.equal(JSON.stringify(wire).includes('TEST_ONLY_SECRET'),false);
  assert.equal((await fetch(base+'/api/account/usage?details=1&series=1&project=TEST_ONLY_SECRET',{headers:{authorization:'Bearer TEST_ONLY_viewer'}})).status,403);
  for(const route of ['/api/account/usage?series=1','/api/account/usage?details=1&period=forever','/api/account/usage?details=1&series=2','/api/account/usage?details=1&seriesFormat=columns-v1','/api/account/usage?details=1&series=1&seriesFormat=columns-v2','/api/account/usage?details=1&series=1&seriesFormat=columns-v1&seriesFormat=columns-v1'])assert.equal((await fetch(base+route,{headers:{authorization:'Bearer TEST_ONLY_owner'}})).status,400);
  const snapshot=await get('/api/snapshot','TEST_ONLY_owner');assert.ok(!JSON.stringify(snapshot).includes('peakDailyTokens'));
  assert.equal((await fetch(base+'/api/account/usage',{headers:{authorization:'Bearer TEST_ONLY_owner',origin:'https://foreign.example'}})).status,403);
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('cc-account-TEST_ONLY-'));await fs.rm(resolved,{recursive:true,force:true});}
});

test('native account charts resolve durable references only on explicit authorized detail reads',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-native-api-TEST_ONLY-'));let server,hub;
 const host={id:'native-test',label:'TEST_ONLY',tokenHash:digest('TEST_ONLY_collector')},viewers=[{...admin,tokenHash:digest('TEST_ONLY_owner')},{...admin,id:'limited',username:'limited',role:'viewer',tokenHash:digest('TEST_ONLY_viewer')}];
 const data=encodeNativeAnalytics({usage:normalizeNativeDataset('usage',{group_by:'day',units:'percent',collectedAt:at,data:[{date:'2026-01-20',attribution:[{thread_source:'user',turn_trigger:'composer',model:'TEST_ONLY_MODEL',surface:'desktop_app',value:12}],product_surface_usage_values:{desktop_app:12},models:[]}]})},{observedAt:at});
 try{hub=await FleetHub.open({directory,hosts:[host]});await hub.ingest('TEST_ONLY_collector',{hostId:host.id,batchId:'native-full',observedAt:at,sessions:[],events:[],accountUsage:report({nativeAnalytics:data})});await hub.ingest('TEST_ONLY_collector',{hostId:host.id,batchId:'native-ref',observedAt:at,sessions:[],events:[],accountUsage:report({nativeAnalytics:nativeAnalyticsReference(data)})});hub=await FleetHub.open({directory,hosts:[host]});server=createServer({hub,viewers});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`,get=async(route,token='TEST_ONLY_owner')=>{const response=await fetch(base+route,{headers:{authorization:'Bearer '+token}});assert.equal(response.status,200);return response.json();};
 const summary=await get('/api/account/usage?summary=1');assert.equal(summary.accountUsage.accounts[0].nativeAnalytics.data,undefined);assert.equal(summary.accountUsage.accounts[0].nativeAnalyticsData,undefined);
 const ordinary=await get('/api/account/usage?details=1');assert.doesNotMatch(JSON.stringify(ordinary),/TEST_ONLY_MODEL/);
 const detail=await get('/api/account/usage?details=1&native=1');assert.equal(detail.accountUsage.accounts[0].nativeAnalyticsData.datasets.usage.data[0].attribution[0].value,12);
 assert.doesNotMatch(JSON.stringify(await get('/api/account/usage?details=1&native=1','TEST_ONLY_viewer')),/TEST_ONLY_MODEL|nativeAnalyticsData/);
 for(const route of ['/account-history-view.mjs','/native-analytics-view.mjs'])assert.equal((await fetch(base+route,{headers:{authorization:'Bearer TEST_ONLY_owner'}})).status,200);
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('cc-native-api-TEST_ONLY-'));await fs.rm(resolved,{recursive:true,force:true});}
});
