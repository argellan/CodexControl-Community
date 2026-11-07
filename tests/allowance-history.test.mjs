// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {installUsageSchema,recordUsage} from '../lib/usage-history.mjs';
import {readAllowanceHistory} from '../lib/allowance-history.mjs';
import {projectAllowanceHistory,projectAllowanceBars,allowancePercent,allowanceChart} from '../public/allowance-history.mjs';
import {buildAccountUsageView,renderAccountStrip} from '../public/account-usage.mjs';
import {normalizePersonalSettings,validatePersonalSettings} from '../public/settings-view-model.mjs';
const now=Date.parse('2026-10-23T20:00:00Z'),key='a'.repeat(64),reset=now+86400000;
const report=(at,used=22.76,accountKey=key)=>({version:1,source:'codex-app-server',status:'available',observedAt:new Date(at).toISOString(),lastAttemptAt:new Date(at).toISOString(),limitsObservedAt:new Date(at).toISOString(),usageObservedAt:new Date(at).toISOString(),accountKey,planType:'pro',limits:[{limitId:'codex',primary:{usedPercent:used,windowDurationMins:10080,resetsAt:reset/1000},secondary:null}],summary:{lifetimeTokens:null,peakDailyTokens:null,longestRunningTurnSec:null,currentStreakDays:null,longestStreakDays:null},dailyUsageBuckets:[],errorCode:null});
test('fractional native readings retain hundredths while whole-point readings do not invent finer precision',()=>{
 assert.equal(allowancePercent(77.24,22.76),'77.24%');assert.equal(allowancePercent(77,23),'77%');
 const view=buildAccountUsageView({accountUsage:{accounts:[report(now)]}},{now});
 assert.match(renderAccountStrip(view),/class="weekly-number is-number">77.24%<\/b>/);
 assert.match(renderAccountStrip(view),/Reported fractional value/);
});
test('history is a bounded projection with preserved extrema, gaps and reset boundaries',()=>{
 const samples=Array.from({length:1441},(_,i)=>({at:now-86400000+i*60000,used:20+i/100,reset,status:'available'}));
 samples[300].used=1;samples[301].used=99;
 const out=projectAllowanceHistory(samples,{now});assert.ok(out.points.length<=480);assert.equal(out.coverage.validReadings,1441);
 assert.ok(out.points.some(p=>p.remaining===99));assert.ok(out.points.some(p=>p.remaining===1));
 const broken=projectAllowanceHistory([{at:now-3600000,used:10,reset,status:'available'},{at:now-60000,used:12,reset,status:'available'},{at:now,used:1,reset:reset+604800000,status:'available'}],{now});
 assert.equal(broken.coverage.gaps,1);assert.equal(broken.coverage.resets,1);assert.ok(broken.points[1].breakBefore&&broken.points[2].breakBefore);
});
test('stale/future/conflicting samples cannot produce trusted historical lines or leak another account series',()=>{
 const out=projectAllowanceHistory([{at:now,used:1,reset,status:'stale'},{at:now+1,used:1,reset,status:'available'},{at:now-1,used:1,reset,status:'available'},{at:now-1,used:2,reset,status:'available'}],{now});
 assert.equal(out.points.length,0);
 const chart=allowanceChart({accountKey:'b'.repeat(64),limitId:'codex',slot:'primary',points:[{at:now,remaining:12,reset}]},{now,account:{accountKey:key,weekly:{limitId:'codex',slot:'primary',state:'stale'}}});
 assert.ok(!chart.includes('class="quota-line"'));
});
test('durable SQLite range read preserves decimal values, partitions account/host/window, and never modifies source rows',()=>{
 const db=new DatabaseSync(':memory:');try{
  installUsageSchema(db);
  const write=(at,used,accountKey=key,hostId='test-source')=>recordUsage(db,{hostId,state:{accountUsage:report(at,used,accountKey)},now:at+10});
  write(now-2*86400000,10);write(now-3600000,20.25);write(now,22.76);write(now,99,'b'.repeat(64));write(now,99,key,'excluded');
  const before=db.prepare('SELECT COUNT(*) n FROM account_usage_observations').get().n;
  const opts={now,accountKey:key,limitId:'codex',slot:'primary',hostIds:['test-source']};
  const day=readAllowanceHistory(db,opts);assert.equal(day.points.length,2);assert.ok(Math.abs(day.points.at(-1).remaining-77.24)<1e-9);
  assert.equal(readAllowanceHistory(db,{...opts,range:'7d'}).points.length,3);
  assert.equal(readAllowanceHistory(db,{...opts,slot:'secondary'}).points.length,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM account_usage_observations').get().n,before);
  assert.throws(()=>readAllowanceHistory(db,{...opts,range:'30d'}));assert.throws(()=>readAllowanceHistory(db,{...opts,accountKey:null}));
 }finally{db.close();}
});
test('range choices migrate and validate through the existing profile schema',()=>{
 assert.equal(normalizePersonalSettings().quotaHistoryRange,'24h');
 assert.equal(validatePersonalSettings({quotaHistoryRange:'48h'}).quotaHistoryRange,'48h');
 assert.equal(validatePersonalSettings({quotaHistoryRange:'7d'}).quotaHistoryRange,'7d');
 assert.throws(()=>validatePersonalSettings({quotaHistoryRange:'1y'}));
});



test('history HTTP boundary enforces account authority, valid ranges and read-only captured source access',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),path=await import('node:path'),{tmpdir}=await import('node:os'),{createHash}=await import('node:crypto');
 const {FleetHub}=await import('../lib/fleet.mjs'),{createServer}=await import('./fixture-server.mjs');
 const directory=await mkdtemp(path.join(tmpdir(),'cc-allowance-TEST_ONLY-')),digest=v=>createHash('sha256').update(v).digest('hex');let server;
 try{
  const hub=await FleetHub.open({directory,hosts:[{id:'test-source',tokenHash:digest('TEST_ONLY_collector')}]});
  const live=Date.now(),value=report(live);value.limits[0].primary.resetsAt=Math.floor(live/1000)+86400;
  await hub.ingest('TEST_ONLY_collector',{hostId:'test-source',batchId:'test-batch',observedAt:new Date(live).toISOString(),sessions:[],events:[],accountUsage:value});
  const count=()=>hub.journal.database(db=>db.prepare('SELECT COUNT(*) n FROM account_usage_observations').get().n),before=count();
  const viewers=[{id:'test-owner',label:'TEST_ONLY owner',role:'admin',hostIds:null,projectIds:null,tokenHash:digest('TEST_ONLY_owner')},{id:'test-viewer',label:'TEST_ONLY viewer',role:'viewer',hostIds:null,projectIds:null,tokenHash:digest('TEST_ONLY_viewer')},{id:'scoped-owner',label:'TEST_ONLY scoped',role:'viewer',hostIds:['test-source'],projectIds:null,tokenHash:digest('TEST_ONLY_scoped')}];
  server=createServer({hub,viewers});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port+'/api/account/allowance-history',get=(query='',token='TEST_ONLY_owner',method='GET')=>fetch(base+query,{method,headers:{authorization:'Bearer '+token}});
  assert.equal((await fetch(base)).status,401);
  assert.equal((await get('','TEST_ONLY_viewer')).status,403);assert.equal((await get('','TEST_ONLY_scoped')).status,403);
  for(const query of ['?range=30d','?range=24h&range=48h','?accountKey=other'])assert.equal((await get(query)).status,400);
  for(const range of ['24h','48h','7d']){const res=await get('?range='+range);assert.equal(res.status,200);const body=await res.json();assert.equal(body.accountKey,key);assert.equal(body.points.length,1);assert.ok(Math.abs(body.points[0].remaining-77.24)<1e-9);}
  assert.equal((await get('','TEST_ONLY_owner','HEAD')).status,200);assert.equal(await (await get('','TEST_ONLY_owner','HEAD')).text(),'');
  assert.equal(count(),before);assert.equal(hub.journal.status().retainedEvents,0);
 }finally{
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(tmpdir()));assert.ok(path.basename(resolved).startsWith('cc-allowance-TEST_ONLY-'));await rm(resolved,{recursive:true,force:true});
 }
});


test('accessible chart description conveys captured values and timestamps as well as coverage',()=>{
 const history={accountKey:key,limitId:'codex',slot:'primary',points:[{at:now-60000,remaining:90,used:10,reset},{at:now,remaining:77.24,used:22.76,reset}],coverage:{validReadings:2,gaps:0,resets:0}};
 const chart=allowanceChart(history,{now,account:{accountKey:key,weekly:{limitId:'codex',slot:'primary',state:'stale'}}});
 assert.equal((chart.match(/data-quota-index=/g)||[]).length,24);assert.match(chart,/role="slider"/);assert.match(chart,/24 hourly bars/);
 assert.match(chart,/77.24% remaining, last captured/);assert.match(chart,/aria-valuenow="24"/);
 assert.match(chart,/fixed|Last captured remaining percentage/);assert.equal(history.points[0].remaining,90);
 assert.ok(!allowanceChart({status:'unavailable',points:[]},{now}).includes('First captured'));
});

test('24/48 hourly and7 daily bars retain the last source reading in each interval without filling gaps',()=>{for(const [range,count]of [['24h',24],['48h',48],['7d',7]]){const duration=range==='7d'?604800000:count*3600000,from=now-duration,step=duration/count,points=[{at:from+10,remaining:99,used:1},{at:from+step-1,remaining:90,used:10},{at:from+2*step+1,remaining:0,used:100},{at:now,remaining:77.24,used:22.76,boundary:'reset'}],copy=structuredClone(points),bars=projectAllowanceBars(points,{from,to:now,range});assert.equal(bars.length,count);assert.equal(bars[0].remaining,90);assert.equal(bars[1].state,'missing');assert.equal(bars[2].state,'observed');assert.equal(bars[2].remaining,0);assert.equal(bars.at(-1).remaining,77.24);assert.equal(bars.at(-1).reset,true);assert.deepEqual(points,copy);}});
test('bar closing readings come from full captured evidence before point decimation',()=>{const samples=Array.from({length:1441},(_,i)=>({at:now-86400000+i*60000,used:20+i/100,reset,status:'available'}));const history=projectAllowanceHistory(samples,{now,maxPoints:8});assert.ok(history.points.length<=8);assert.equal(history.bars.length,24);assert.equal(history.bars[0].at,now-86400000+59*60000);assert.equal(history.bars[0].used,20.59);assert.equal(history.coverage.validReadings,1441);});
