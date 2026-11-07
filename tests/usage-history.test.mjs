// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {installUsageSchema,recordUsage,readUsage,validateUsageDatabase,rotateUsageGeneration,USAGE_TABLE_COLUMNS} from '../lib/usage-history.mjs';
import {selectArchiveBatch,acknowledgeArchiveBatch,archiveStatus} from '../lib/usage-archive.mjs';
const NOW=Date.parse('2026-10-20T12:00:00Z'),at=offset=>new Date(NOW+offset).toISOString();
const session=(offset=0,n=1000,extra={})=>({id:'session-a',project:'Alpha',provider:'openai',model:'gpt-test',state:'Turn completed',usageObservedAt:at(offset),tokens:{input_tokens:n,cached_input_tokens:Math.floor(n/4),output_tokens:Math.floor(n/10),total_tokens:n+Math.floor(n/10)},...extra});
const account=(offset=0,extra={})=>({version:1,source:'codex-app-server',status:'available',observedAt:at(offset),lastAttemptAt:at(offset),accountKey:'a'.repeat(64),planType:'pro',limitsObservedAt:at(offset),usageObservedAt:at(offset),limits:[{limitId:'codex',limitName:'Codex',planType:'pro',primary:{usedPercent:18,windowDurationMins:10080,resetsAt:1900000000},secondary:null}],summary:{lifetimeTokens:123000,peakDailyTokens:12000,longestRunningTurnSec:10,currentStreakDays:3,longestStreakDays:5},dailyUsageBuckets:[{startDate:'2026-10-18',tokens:12000},{startDate:'2026-10-19',tokens:11000}],errorCode:null,...extra});
function fixture(fn){const db=new DatabaseSync(':memory:');try{installUsageSchema(db);return fn(db);}finally{db.close();}}
function write(db,s,now=NOW,extra={}){return recordUsage(db,{hostId:'laptop',state:{sessions:Array.isArray(s)?s:[s]},now,...extra});}


const archiveAll=db=>{let batch;while((batch=selectArchiveBatch(db))){acknowledgeArchiveBatch(db,{batch,expectedReceiverId:'TEST_ONLY_archive',receipt:{version:1,batchId:batch.batchId,rawSha256:batch.rawSha256,records:batch.records,itemIds:batch.itemIds,receiverId:'TEST_ONLY_archive',durable:true}});}};

test('first reading is a durable baseline, never a fabricated lifetime-sized burn',()=>fixture(db=>{
 assert.equal(write(db,session()).observations,1);const value=readUsage(db,{now:NOW});assert.equal(value.burn.status,'baseline');assert.equal(value.burn.inputPerSecond,null);assert.equal(value.observations[0].inputTokens,null);assert.equal(value.observations[0].counters.inputTokens,1000);assert.equal(value.storage.retainedObservations,1);assert.equal(value.storage.retainedBaselines,1);assert.equal(validateUsageDatabase(db).observations,1);
}));
test('sampled cache ratios use comparable paired deltas and weighted sums, excluding unknown input',()=>fixture(db=>{
 const s=(id,offset,input,cached)=>session(offset,0,{id,tokens:{...(input===null?{}:{input_tokens:input}),cached_input_tokens:cached,output_tokens:1,total_tokens:input===null?null:input+1}});
 write(db,[s('a',0,0,0),s('b',0,0,0),s('partial',0,null,0)]);
 write(db,[s('a',1000,100,70),s('b',1000,900,90),s('partial',1000,null,900)],NOW+1000);
 const {ratios}=readUsage(db,{now:NOW+1000}).burn;assert.equal(ratios.cacheHit.value,.16);assert.equal(ratios.cacheHit.comparableRows,2);assert.equal(ratios.cacheHit.excludedRows,1);assert.equal(ratios.newInputFraction.value,.84);
}));

test('paired ratios distinguish absent pairs, empty scopes and measured zero denominators',()=>fixture(db=>{
 const ratios=options=>readUsage(db,{now:NOW+1000,...options}).burn.ratios;
 const absent=(value,excluded)=>{assert.equal(value.cacheHit.value,null);assert.equal(value.cacheHit.numerator,null);assert.equal(value.cacheHit.denominator,null);assert.equal(value.cacheHit.comparableRows,0);assert.equal(value.cacheHit.excludedRows,excluded);assert.equal(value.newInputFraction.numerator,null);};
 absent(ratios(),0);
 write(db,session(0,0,{tokens:{input_tokens:100}}));write(db,session(1000,0,{tokens:{input_tokens:110}}),NOW+1000);
 absent(ratios(),1);absent(ratios({hostIds:[]}),0);absent(ratios({projectIds:['Denied']}),0);absent(ratios({sessionId:'missing'}),0);
 write(db,session(0,0,{id:'zero',tokens:{input_tokens:0,cached_input_tokens:0,output_tokens:0,total_tokens:0}}));
 write(db,session(1000,0,{id:'zero',tokens:{input_tokens:0,cached_input_tokens:0,output_tokens:0,total_tokens:0}}),NOW+1000);
 const zero=ratios({sessionId:'zero'});assert.equal(zero.cacheHit.value,null);assert.equal(zero.cacheHit.numerator,0);assert.equal(zero.cacheHit.denominator,0);assert.equal(zero.cacheHit.comparableRows,1);assert.equal(zero.cacheHit.excludedRows,0);assert.equal(zero.newInputFraction.numerator,null);assert.equal(zero.newInputFraction.denominator,0);validateUsageDatabase(db);
}));

test('daily batch preparation stays bounded as session and account days grow, and duplicates stay lazy',()=>{
 const measure=size=>fixture(db=>{
  const sessions=Array.from({length:size},(_,i)=>session(0,1000,{id:'batch-'+i})),dailyUsageBuckets=Array.from({length:size},(_,i)=>({startDate:new Date(NOW-(i+1)*86400000).toISOString().slice(0,10),tokens:i+1}));
  write(db,sessions);let queries=[];const measured={exec:sql=>db.exec(sql),prepare:sql=>{queries.push(sql);return db.prepare(sql);}};
  const changed=sessions.map(s=>({...s,usageObservedAt:at(1000),tokens:{input_tokens:1100,cached_input_tokens:275,output_tokens:110,total_tokens:1210}})),state={sessions:changed,accountUsage:account(1000,{dailyUsageBuckets})};
  const result=recordUsage(measured,{hostId:'laptop',state,now:NOW+1000}),prepared=queries.length;
  assert.equal(result.daily,size);assert.equal(result.accountDaily,size);assert.equal(readUsage(db,{now:NOW+1000}).burn.inputTokens,size*100);
  queries=[];const duplicate=recordUsage(measured,{hostId:'laptop',state,now:NOW+2000}),duplicatePrepared=queries.length;assert.equal(duplicate.observations,0);assert.equal(duplicate.accounts,0);assert.equal(duplicate.accountDaily,0);
  assert.equal(queries.some(sql=>sql.startsWith('INSERT INTO usage_daily(')||sql.startsWith('INSERT INTO account_usage_daily(')),false);
  queries=[];recordUsage(measured,{hostId:'laptop',state:{sessions:[session(3000,1,{id:'new-baseline'})]},now:NOW+3000});assert.equal(queries.some(sql=>sql.includes('FROM usage_daily WHERE host_id=')||sql.includes('INTO usage_daily(')||sql.includes('FROM account_usage_daily WHERE host_id=')||sql.includes('INTO account_usage_daily(')),false);
  validateUsageDatabase(db);return {prepared,duplicatePrepared};
 });
 assert.deepEqual(measure(64),measure(1));
});
test('monotonic deltas include recently ended workers, cache is a subset and exact observation IDs survive retry',()=>fixture(db=>{
 write(db,session());write(db,session(2000,1600),NOW+2000);const before=readUsage(db,{now:NOW+2000});assert.equal(before.burn.inputTokens,600);assert.equal(before.burn.cachedInputTokens,150);assert.equal(before.burn.uncachedInputTokens,450);assert.equal(before.burn.outputTokens,60);assert.equal(before.burn.inputPerSecond,10);assert.equal(before.burn.outputPerSecond,1);assert.equal(before.burn.workerCount,1);assert.equal(before.observations[1].intervalMs,2000);
 assert.equal(write(db,session(2000,1600),NOW+5000).observations,0);const retry=readUsage(db,{now:NOW+5000});assert.equal(retry.latestSequence,2);assert.equal(retry.observations[1].receivedAt,at(2000));assert.equal(retry.daily[0].inputTokens,600);assert.equal(validateUsageDatabase(db).daily,1);
}));
test('database reopen preserves baselines, exact samples, rollups and cursor dedup',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-usage-'));const file=path.join(dir,'history.sqlite');let db=new DatabaseSync(file);
 try{installUsageSchema(db);write(db,session());write(db,session(1000,1200),NOW+1000);db.close();db=new DatabaseSync(file);installUsageSchema(db);assert.equal(write(db,session(1000,1200),NOW+2000).observations,0);write(db,session(3000,1500),NOW+3000);const rows=readUsage(db,{now:NOW+3000,afterSequence:2});assert.equal(rows.observations.length,1);assert.equal(rows.observations[0].inputTokens,300);assert.equal(rows.burn.inputTokens,500);assert.equal(rows.daily[0].inputTokens,500);validateUsageDatabase(db);}finally{db.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('counter resets establish a new segment and cannot emit negative or replayed burn',()=>fixture(db=>{
 write(db,session());write(db,session(1000,50),NOW+1000);let r=readUsage(db,{now:NOW+1000});assert.equal(r.observations.at(-1).status,'reset');assert.equal(r.observations.at(-1).inputTokens,null);assert.equal(r.burn.status,'baseline');write(db,session(2000,150),NOW+2000);r=readUsage(db,{now:NOW+2000});assert.equal(r.burn.inputTokens,100);assert.equal(r.daily[0].inputTokens,100);validateUsageDatabase(db);
}));
test('source or receipt gaps beyond120s create a new baseline, while raw counters remain saved',()=>fixture(db=>{
 write(db,session());write(db,session(121000,9000000),NOW+121000);let r=readUsage(db,{now:NOW+121000});assert.equal(r.observations.at(-1).status,'gap');assert.equal(r.burn.inputTokens,null);write(db,session(122000,9000100),NOW+122000);r=readUsage(db,{now:NOW+122000});assert.equal(r.burn.inputTokens,100);assert.equal(r.daily[0].inputTokens,100);validateUsageDatabase(db);
}));
test('out-of-order and future source samples persist without moving a current baseline',()=>fixture(db=>{
 write(db,session());write(db,session(-1000,900),NOW+1000);write(db,session(5000,99999),NOW+1000);write(db,session(2000,1200),NOW+2000);const r=readUsage(db,{now:NOW+2000});assert.deepEqual(r.observations.map(v=>v.status),['baseline','out-of-order','future','delta']);assert.equal(r.burn.inputTokens,200);assert.equal(r.burn.observedAt,at(2000));validateUsageDatabase(db);
}));
test('stale source readings cannot be fresh traffic because receipt time advanced',()=>fixture(db=>{
 write(db,session(-300000,1000));let r=readUsage(db,{now:NOW});assert.equal(r.observations[0].status,'stale');assert.equal(r.burn.status,'unavailable');write(db,session(1000,5000000),NOW+1000);r=readUsage(db,{now:NOW+1000});assert.equal(r.observations.at(-1).status,'baseline');assert.equal(r.burn.inputTokens,null);validateUsageDatabase(db);
}));
test('repeated stale and out-of-order readings preserve sequence and exact original archive evidence',()=>fixture(db=>{
 write(db,session(-300000,1000));
 const original=db.prepare('SELECT * FROM usage_observations').all(),beforeSequence=db.prepare("SELECT seq FROM sqlite_sequence WHERE name='usage_observations'").get().seq;
 for(let i=1;i<=12;i++)assert.equal(write(db,session(-300000,1000),NOW+i).observations,0);
 assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='usage_observations'").get().seq,beforeSequence);
 assert.deepEqual(db.prepare('SELECT * FROM usage_observations').all(),original);
 write(db,session(0,2000));write(db,session(-1000,1500),NOW+1000);
 const afterOrder=db.prepare("SELECT seq FROM sqlite_sequence WHERE name='usage_observations'").get().seq;
 for(let i=0;i<12;i++)write(db,session(-1000,1500),NOW+1001+i);
 assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='usage_observations'").get().seq,afterOrder);
 const beforeCorrection=db.prepare('SELECT COUNT(*) n FROM usage_archive_outbox').get().n;
 const correction=write(db,session(-1000,1600),NOW+1100);
 assert.equal(correction.sourceRevisions,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_archive_outbox').get().n,beforeCorrection+1);
 assert.equal(write(db,session(-1000,1600),NOW+1101).sourceRevisions,0);
 assert.equal(db.prepare('SELECT input_tokens FROM usage_observations WHERE source_ms=?').get(NOW-1000).input_tokens,1500);
 validateUsageDatabase(db);
}));
test('missing fields retain known partial deltas and do not turn missing counts into zero',()=>fixture(db=>{
 write(db,session(0,1000,{tokens:{input_tokens:1000,output_tokens:100}}));write(db,session(1000,0,{tokens:{input_tokens:1300,output_tokens:130}}),NOW+1000);const r=readUsage(db,{now:NOW+1000});assert.equal(r.burn.status,'partial');assert.equal(r.burn.inputTokens,300);assert.equal(r.burn.outputTokens,30);assert.equal(r.burn.cachedInputTokens,null);assert.equal(r.burn.uncachedInputTokens,null);validateUsageDatabase(db);
}));
test('invalid and inconsistent counters remain unknown, including a cache delta larger than input',()=>fixture(db=>{
 write(db,session(0,0,{tokens:{input_tokens:1000,cached_input_tokens:100,output_tokens:100,total_tokens:1100}}));write(db,session(1000,0,{tokens:{input_tokens:1010,cached_input_tokens:200,output_tokens:105,total_tokens:1115}}),NOW+1000);const r=readUsage(db,{now:NOW+1000});assert.equal(r.burn.inputTokens,10);assert.equal(r.burn.cachedInputTokens,null);assert.equal(r.burn.outputTokens,5);assert.equal(r.burn.status,'partial');assert.equal(write(db,session(2000,0,{tokens:{input_tokens:-1,cached_input_tokens:NaN,output_tokens:Number.MAX_SAFE_INTEGER+1,total_tokens:'5'}}),NOW+2000).invalid,1);validateUsageDatabase(db);
}));
test('metadata changes create a new baseline rather than assigning work across project/model/provider boundaries',()=>fixture(db=>{
 write(db,session());write(db,session(1000,3000,{project:'Beta'}),NOW+1000);write(db,session(2000,3100,{project:'Beta'}),NOW+2000);write(db,session(3000,5000,{project:'Beta',model:'other-model'}),NOW+3000);const r=readUsage(db,{now:NOW+3000});assert.deepEqual(r.observations.map(v=>v.status),['baseline','baseline','delta','baseline']);assert.equal(readUsage(db,{now:NOW+3000,projectIds:['Alpha']}).burn.inputTokens,null);assert.equal(readUsage(db,{now:NOW+3000,projectIds:['Beta']}).burn.inputTokens,100);validateUsageDatabase(db);
}));
test('forks, execution targets and inherited execution jobs cannot inflate observed Codex usage',()=>fixture(db=>{
 const result=write(db,[session(0,1,{forkedFrom:'parent'}),session(0,1,{role:'execution-target'}),session(0,1,{role:'execution-job'})]);assert.equal(result.excluded,3);assert.equal(result.observations,0);recordUsage(db,{hostId:'edge',state:{coverage:{role:'execution-target'},sessions:[session()],accountUsage:account()},now:NOW});assert.equal(readUsage(db,{now:NOW,includeAccount:true}).storage.retainedAccountObservations,0);
}));
test('host/project/session authorization is applied in SQL to raw observations, daily rows, rates and counts',()=>fixture(db=>{
 for(const hostId of ['one','two']){write(db,session(),NOW,{hostId});write(db,session(1000,1200),NOW+1000,{hostId});}
 const allowed=readUsage(db,{now:NOW+1000,hostIds:['one'],projectIds:['Alpha'],sessionId:'session-a',includeAccount:true});assert.equal(allowed.burn.inputTokens,200);assert.equal(allowed.storage.retainedObservations,2);assert.equal(allowed.latestSequence,2);assert.equal(allowed.observations.every(v=>v.hostId==='one'),true);assert.equal(allowed.accountObservations,undefined);assert.equal(allowed.storage.trimmedRaw,undefined);
 const denied=readUsage(db,{now:NOW+1000,hostIds:[]});assert.equal(denied.latestSequence,0);assert.equal(denied.observations.length,0);assert.equal(denied.daily.length,0);assert.equal(denied.storage.retainedObservations,0);assert.equal(denied.burn.inputPerSecond,null);
}));
test('200-row response budgets never truncate aggregate burn; bootstrap pages return newest evidence',()=>fixture(db=>{
 const sessions=Array.from({length:250},(_,i)=>session(0,1000,{id:'session-'+i}));write(db,sessions);write(db,sessions.map(s=>({...s,usageObservedAt:at(1000),tokens:{input_tokens:1600,cached_input_tokens:400,output_tokens:160,total_tokens:1760}})),NOW+1000);
 const r=readUsage(db,{now:NOW+1000,limit:20});assert.equal(r.observations.length,20);assert.equal(r.observations[0].sequence,481);assert.equal(r.observations.at(-1).sequence,500);assert.equal(r.observationsTruncated,true);assert.equal(r.burn.inputTokens,150000);assert.equal(r.burn.inputPerSecond,2500);assert.equal(r.burn.workerCount,250);assert.equal(r.burn.workers.length,200);assert.equal(r.burn.coverage.workersTruncated,true);assert.equal(r.burn.coverage.windowObservationCount,250);assert.equal(r.nextCursor,500);validateUsageDatabase(db);
}));
test('explicit cursor paging is stable and bounded',()=>fixture(db=>{
 write(db,session());for(let i=1;i<=5;i++)write(db,session(i*1000,1000+i*100),NOW+i*1000);const r=readUsage(db,{now:NOW+5000,afterSequence:2,limit:2});assert.deepEqual(r.observations.map(v=>v.sequence),[3,4]);assert.equal(r.caughtUp,false);assert.equal(r.nextCursor,4);const next=readUsage(db,{now:NOW+5000,afterSequence:4,limit:2});assert.deepEqual(next.observations.map(v=>v.sequence),[5,6]);assert.equal(next.caughtUp,true);assert.throws(()=>readUsage(db,{limit:201}),/limit/);assert.throws(()=>readUsage(db,{afterSequence:-1}),/cursor/);
}));
test('a warmed idle window is zero, but a stale source or first reading remains unknown',()=>fixture(db=>{
 write(db,session());write(db,session(1000,1100),NOW+1000);let r=readUsage(db,{now:NOW+61001});assert.equal(r.burn.status,'idle');assert.equal(r.burn.inputPerSecond,0);r=readUsage(db,{now:NOW+121001});assert.equal(r.burn.status,'stale');assert.equal(r.burn.inputPerSecond,null);
}));
test('accepted90s samples expose batch interval without pretending provider streaming timing',()=>fixture(db=>{
 write(db,session());write(db,session(90000,10000),NOW+90000);const r=readUsage(db,{now:NOW+90000});assert.equal(r.observations.at(-1).intervalMs,90000);assert.equal(r.burn.inputPerSecond,150);assert.match(r.burn.coverage.rateBasis,/batches are not provider streaming/);
}));
test('account snapshots deduplicate source samples, preserve original historical buckets and reject credentials',()=>fixture(db=>{
 const a=account();recordUsage(db,{hostId:'one',state:{sessions:[],accountUsage:a},now:NOW});recordUsage(db,{hostId:'one',state:{sessions:[],accountUsage:a},now:NOW+2000});const r=readUsage(db,{now:NOW+2000,hostIds:['one'],includeAccount:true});assert.equal(r.storage.retainedAccountObservations,1);assert.equal(r.storage.retainedAccountDailyRows,2);assert.equal(r.accountDaily.length,2);assert.equal(Object.hasOwn(r.accountObservations[0].accountUsage,'accountKey'),false);
 const result=recordUsage(db,{hostId:'one',state:{sessions:[],accountUsage:{...a,password:'secret'}},now:NOW+3000});assert.equal(result.invalid,1);assert.equal(validateUsageDatabase(db).accounts,1);
}));
test('account history follows enabled source scope and is omitted from project/session-scoped reads',()=>fixture(db=>{
 for(const hostId of ['one','two'])recordUsage(db,{hostId,state:{sessions:[],accountUsage:account()},now:NOW});let r=readUsage(db,{now:NOW,hostIds:['one'],includeAccount:true});assert.equal(r.accountObservations.length,1);assert.equal(r.accountObservations[0].hostId,'one');assert.equal(r.storage.retainedAccountDailyRows,2);r=readUsage(db,{now:NOW,hostIds:['one'],projectIds:['Alpha'],includeAccount:true});assert.equal(r.accountObservations,undefined);assert.equal(r.accountDaily,undefined);assert.equal(Object.hasOwn(r.storage,'retainedAccountObservations'),false);
}));
test('older/future account samples never overwrite a newer account-day value',()=>fixture(db=>{
 recordUsage(db,{hostId:'one',state:{accountUsage:account(1000,{dailyUsageBuckets:[{startDate:'2026-10-19',tokens:200}]})},now:NOW+1000});recordUsage(db,{hostId:'one',state:{accountUsage:account(0,{dailyUsageBuckets:[{startDate:'2026-10-19',tokens:100}]})},now:NOW+2000});recordUsage(db,{hostId:'one',state:{accountUsage:account(10000,{dailyUsageBuckets:[{startDate:'2026-10-19',tokens:900}]})},now:NOW+2000});assert.equal(readUsage(db,{now:NOW+2000,includeAccount:true}).accountDaily[0].tokens,200);validateUsageDatabase(db);
}));
test('retention caps raw observations and baselines while preserving independently durable daily sums',()=>fixture(db=>{
 const retention={maxRawObservations:3,maxBaselines:2,maxDailyRows:3,trimIntervalMs:1};write(db,session(),NOW,{retention});for(let i=1;i<=5;i++){archiveAll(db);write(db,session(i*1000,1000+i*100),NOW+i*1000,{retention});}let r=readUsage(db,{now:NOW+5000,retention});assert.equal(r.storage.retainedObservations,3);assert.equal(r.storage.retainedDailyRows,1);assert.equal(r.daily[0].inputTokens,500);assert.equal(r.storage.trimmedRaw,3);assert.equal(r.observations[0].sequence,4);assert.equal(r.gap,null);assert.equal(readUsage(db,{now:NOW+5000,afterSequence:1,retention}).gap,'retention');archiveAll(db);write(db,session(6000,1,{id:'two'}),NOW+6000,{retention});archiveAll(db);write(db,session(7000,1,{id:'three'}),NOW+7000,{retention});r=readUsage(db,{now:NOW+7000,retention});assert.equal(r.storage.retainedBaselines,2);assert.equal(r.storage.trimmedBaselines,1);validateUsageDatabase(db);
}));
test('only remotely receipted raw age expiry leaves independently durable daily rollups',()=>fixture(db=>{
 const retention={rawAgeMs:10000,dailyAgeMs:86400000,trimIntervalMs:1};write(db,session(),NOW,{retention});write(db,session(1000,1200),NOW+1000,{retention});archiveAll(db);recordUsage(db,{hostId:'one',state:{sessions:[]},now:NOW+12000,retention});const r=readUsage(db,{now:NOW+12000,retention});assert.equal(r.storage.retainedObservations,0);assert.equal(r.storage.retainedBaselines,0);assert.equal(r.daily[0].inputTokens,200);validateUsageDatabase(db);
}));
test('unavailable archive preserves all unacknowledged usage beyond age and capacity targets',()=>fixture(db=>{
 const retention={maxRawObservations:1,maxDailyRows:1,maxBaselines:1,rawAgeMs:1000,dailyAgeMs:1,trimIntervalMs:1};
 for(let i=0;i<5;i++)write(db,session(i*1000,1000+i*100),NOW+i*1000,{retention});
 recordUsage(db,{hostId:'one',state:{},now:NOW+100000,retention});
 const r=readUsage(db,{now:NOW+100000,retention});assert.equal(r.storage.retainedObservations,5);assert.equal(r.storage.retainedDailyRows,1);assert.equal(r.storage.trimmedRaw,0);assert.equal(r.storage.trimmedDaily,0);assert.equal(r.storage.archiveRequiredBeforeEviction,true);assert.ok(archiveStatus(db).pendingRecords>0);assert.equal(archiveStatus(db).status,'unconfigured');validateUsageDatabase(db);
}));
test('session/account daily rows and account raw history have independent hard capacity bounds',()=>fixture(db=>{
 const retention={maxRawObservations:4,maxAccountObservations:2,maxDailyRows:2,trimIntervalMs:1};for(let i=0;i<4;i++){archiveAll(db);recordUsage(db,{hostId:'one',state:{accountUsage:account(i*1000,{dailyUsageBuckets:[{startDate:'2026-10-17',tokens:10},{startDate:'2026-10-18',tokens:20},{startDate:'2026-10-19',tokens:30}]})},now:NOW+i*1000,retention});}archiveAll(db);recordUsage(db,{hostId:'one',state:{},now:NOW+4000,retention});const r=readUsage(db,{now:NOW+4000,includeAccount:true,retention});assert.equal(r.storage.retainedAccountObservations,2);assert.equal(r.storage.retainedAccountDailyRows,2);assert.deepEqual(r.accountDaily.map(v=>v.day),['2026-10-19','2026-10-18']);validateUsageDatabase(db);
}));
test('unsafe fleet aggregate overflow is unknown rather than imprecise or wrapped',()=>fixture(db=>{
 const huge=Number.MAX_SAFE_INTEGER;for(const hostId of ['one','two']){write(db,session(0,0,{tokens:{input_tokens:0,cached_input_tokens:0,output_tokens:0,total_tokens:0}}),NOW,{hostId});write(db,session(1000,0,{tokens:{input_tokens:huge,cached_input_tokens:0,output_tokens:0,total_tokens:huge}}),NOW+1000,{hostId});}const r=readUsage(db,{now:NOW+1000});assert.equal(r.burn.status,'partial');assert.equal(r.burn.inputTokens,null);assert.equal(r.burn.inputPerSecond,null);assert.equal(r.burn.cachedInputTokens,0);validateUsageDatabase(db);
}));
test('backup validator refuses schema, metadata, baseline/daily and account-payload contamination',()=>{
 for(const mutate of [db=>db.exec('ALTER TABLE usage_baselines ADD COLUMN password TEXT'),db=>db.exec("INSERT INTO usage_meta VALUES('password','1')"),db=>db.exec("UPDATE usage_meta SET value='999' WHERE key='observations'"),db=>db.exec('UPDATE usage_baselines SET input_tokens=-1'),db=>db.exec('UPDATE usage_daily SET observations=-1'),db=>db.exec("UPDATE account_usage_daily SET day='2026-02-31' WHERE day='2026-10-19'"),db=>db.exec("UPDATE account_usage_observations SET payload='{}'")])fixture(db=>{write(db,session());write(db,session(1000,1100),NOW+1000);recordUsage(db,{hostId:'one',state:{accountUsage:account()},now:NOW});validateUsageDatabase(db);mutate(db);assert.throws(()=>validateUsageDatabase(db));});assert.ok(USAGE_TABLE_COLUMNS.usage_daily.includes('overflow'));
});
test('caller transaction rollback leaves observations, baselines, daily and account rows together unchanged',()=>fixture(db=>{
 db.exec('BEGIN IMMEDIATE');write(db,session());recordUsage(db,{hostId:'one',state:{accountUsage:account()},now:NOW});db.exec('ROLLBACK');const r=readUsage(db,{now:NOW,includeAccount:true});assert.equal(r.storage.retainedObservations,0);assert.equal(r.storage.retainedBaselines,0);assert.equal(r.storage.retainedAccountObservations,0);validateUsageDatabase(db);
}));
test('daily rollups never move prior Secret project usage into a Visible project on a shared session',()=>fixture(db=>{
 write(db,session(0,100,{project:'Secret'}));write(db,session(1000,200,{project:'Secret'}),NOW+1000);write(db,session(2000,300,{project:'Visible'}),NOW+2000);write(db,session(3000,310,{project:'Visible'}),NOW+3000);
 const secret=readUsage(db,{now:NOW+3000,projectIds:['Secret']}),visible=readUsage(db,{now:NOW+3000,projectIds:['Visible']});assert.equal(secret.daily.length,1);assert.equal(secret.daily[0].inputTokens,100);assert.equal(visible.daily.length,1);assert.equal(visible.daily[0].inputTokens,10);assert.equal(visible.burn.inputTokens,10);assert.equal(JSON.stringify(visible).includes('Secret'),false);validateUsageDatabase(db);
}));
test('same-day provider/model partitions retain separate observed rollups, including null dimensions',()=>fixture(db=>{
 const variants=[{provider:null,model:null},{provider:'openai',model:'one'},{provider:'openai',model:'two'}];let step=0;
 for(const extra of variants){write(db,session(step*1000,step*100+100,extra),NOW+step*1000);step++;write(db,session(step*1000,step*100+100,extra),NOW+step*1000);step++;}
 const r=readUsage(db,{now:NOW+6000});assert.equal(r.daily.length,3);assert.deepEqual(r.daily.map(row=>row.inputTokens),[100,100,100]);validateUsageDatabase(db);
}));
test('quiet partial counters preserve per-field unknowns instead of making unreported cache/output zero',()=>fixture(db=>{
 write(db,session(0,0,{tokens:{input_tokens:100}}));write(db,session(1000,0,{tokens:{input_tokens:110}}),NOW+1000);const r=readUsage(db,{now:NOW+61001});assert.equal(r.burn.status,'partial');assert.equal(r.burn.inputPerSecond,0);assert.equal(r.burn.outputPerSecond,null);assert.equal(r.burn.cachedInputPerSecond,null);assert.equal(r.burn.uncachedInputPerSecond,null);validateUsageDatabase(db);
}));
test('output-only and mixed partial sessions do not become fabricated idle input/cache readings',()=>fixture(db=>{
 write(db,session(0,0,{tokens:{output_tokens:100}}));write(db,session(1000,0,{tokens:{output_tokens:110}}),NOW+1000);let r=readUsage(db,{now:NOW+61001});assert.equal(r.burn.outputPerSecond,0);assert.equal(r.burn.inputPerSecond,null);assert.equal(r.burn.status,'partial');
 write(db,session(62000,0,{id:'input-only',tokens:{input_tokens:500}}),NOW+62000);write(db,session(63000,0,{id:'input-only',tokens:{input_tokens:600}}),NOW+63000);r=readUsage(db,{now:NOW+123001});assert.equal(r.burn.inputPerSecond,0);assert.equal(r.burn.outputPerSecond,null);assert.equal(r.burn.cachedInputPerSecond,null);validateUsageDatabase(db);
}));
test('raw capacity loss in the current burn window is explicitly partial',()=>fixture(db=>{
 const retention={maxRawObservations:2,trimIntervalMs:1};write(db,session(),NOW,{retention});for(let i=1;i<=4;i++){archiveAll(db);write(db,session(i*1000,1000+i*100),NOW+i*1000,{retention});}const r=readUsage(db,{now:NOW+4000,retention});assert.equal(r.burn.inputTokens,200);assert.equal(r.burn.status,'partial');assert.equal(r.burn.coverage.retentionWindowIncomplete,true);assert.equal(readUsage(db,{now:NOW+65000,retention}).burn.coverage.retentionWindowIncomplete,false);validateUsageDatabase(db);
}));
test('account raw snapshots stay compact while all366 source days persist separately',()=>fixture(db=>{
 const dailyUsageBuckets=Array.from({length:366},(_,i)=>({startDate:new Date(NOW-(i+1)*86400000).toISOString().slice(0,10),tokens:i+1}));const a=account(0,{dailyUsageBuckets});recordUsage(db,{hostId:'one',state:{accountUsage:a},now:NOW});recordUsage(db,{hostId:'one',state:{accountUsage:a},now:NOW+2000});const rows=db.prepare('SELECT payload FROM account_usage_observations').all();assert.equal(rows.length,1);assert.ok(Buffer.byteLength(rows[0].payload)<8192);assert.equal(JSON.parse(rows[0].payload).dailyUsageBuckets,null);assert.equal(db.prepare('SELECT COUNT(*) n FROM account_usage_daily').get().n,366);validateUsageDatabase(db);
}));

test('old account days and same-timestamp membership/corrections reach custody before hot-cache projection',()=>fixture(db=>{
 const initial=account(0,{dailyUsageBuckets:[{startDate:'2020-01-01',tokens:100}]});
 recordUsage(db,{hostId:'one',state:{accountUsage:initial},now:NOW});
 recordUsage(db,{hostId:'one',state:{accountUsage:{...initial,dailyUsageBuckets:[{startDate:'2020-01-01',tokens:150},{startDate:'2020-01-02',tokens:20}]}} ,now:NOW+1000});
 assert.equal(db.prepare('SELECT COUNT(*) n FROM account_usage_observations').get().n,1);
 assert.deepEqual(db.prepare('SELECT day,tokens FROM account_usage_daily ORDER BY day').all().map(row=>({...row})),[{day:'2020-01-01',tokens:150},{day:'2020-01-02',tokens:20}]);
 const versions=db.prepare("SELECT payload FROM usage_archive_outbox WHERE source_table='account_usage_daily'").all().map(row=>JSON.parse(row.payload));
 assert.ok(versions.some(row=>row.day==='2020-01-01'&&row.tokens===100));assert.ok(versions.some(row=>row.day==='2020-01-01'&&row.tokens===150));validateUsageDatabase(db);
}));

test('older and future account day versions survive without replacing the qualified latest projection',()=>fixture(db=>{
 recordUsage(db,{hostId:'one',state:{accountUsage:account(1000,{dailyUsageBuckets:[{startDate:'2026-10-19',tokens:200}]})},now:NOW+1000});
 for(const offset of [0,10000])recordUsage(db,{hostId:'one',state:{accountUsage:account(offset,{dailyUsageBuckets:[{startDate:'2026-10-19',tokens:offset?900:100}]})},now:NOW+2000});
 assert.equal(db.prepare('SELECT tokens FROM account_usage_daily').get().tokens,200);
 const versions=db.prepare("SELECT payload FROM usage_archive_outbox WHERE source_table='account_usage_daily' AND head_follow=0").all().map(row=>JSON.parse(row.payload));assert.deepEqual(versions.map(row=>row.tokens).sort((a,b)=>a-b),[100,900]);validateUsageDatabase(db);
}));

test('undated source daily buckets remain in their full sanitized report without invented source time',()=>fixture(db=>{
 const source=account(0,{usageObservedAt:null,dailyUsageBuckets:[{startDate:'2020-01-01',tokens:100}]});
 recordUsage(db,{hostId:'one',state:{accountUsage:source},now:NOW});
 const row=db.prepare('SELECT payload,usage_ms FROM account_usage_observations').get();assert.equal(row.usage_ms,null);assert.deepEqual(JSON.parse(row.payload).dailyUsageBuckets,source.dailyUsageBuckets);assert.equal(db.prepare('SELECT COUNT(*) n FROM account_usage_daily').get().n,0);validateUsageDatabase(db);
}));

test('same-source session counter corrections are archived once and establish a non-burn baseline',()=>fixture(db=>{
 write(db,session(),NOW);write(db,session(0,1500),NOW+1000);
 const revisions=db.prepare("SELECT payload FROM usage_archive_outbox WHERE source_table='usage_observations' AND head_follow=0").all().map(row=>JSON.parse(row.payload));
 assert.equal(revisions.length,1);assert.equal(revisions[0].sequence,1);assert.equal(revisions[0].input_tokens,1500);assert.equal(revisions[0].status,'out-of-order');assert.equal(revisions[0].delta_input,null);
 write(db,session(0,1500),NOW+2000);assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_archive_outbox WHERE head_follow=0').get().n,1);
 write(db,session(3000,1600),NOW+3000);assert.equal(readUsage(db,{now:NOW+3000}).burn.inputTokens,100);validateUsageDatabase(db);
}));
test('restore generation rotation changes replay identity without changing durable source evidence',()=>fixture(db=>{
 write(db,session());const before=readUsage(db,{now:NOW});const generation=rotateUsageGeneration(db),after=readUsage(db,{now:NOW});assert.notEqual(generation,before.streamGeneration);assert.equal(after.streamGeneration,generation);assert.equal(after.burn.streamGeneration,generation);assert.deepEqual(after.observations,before.observations);assert.equal(after.latestSequence,before.latestSequence);validateUsageDatabase(db);const legacy=new DatabaseSync(':memory:');try{assert.equal(rotateUsageGeneration(legacy),null);}finally{legacy.close();}
}));
test('combined worker windows mark mixed project/model metadata without attributing the combined subtotal to one dimension',()=>{
 for(const [before,after] of [[{project:'Secret',provider:'openai',model:'one'},{project:'Visible',provider:'openai',model:'two'}],[{project:null,provider:null,model:null},{project:'Visible',provider:'openai',model:'two'}]])fixture(db=>{
  write(db,session(0,100,before));write(db,session(1000,200,before),NOW+1000);write(db,session(2000,300,after),NOW+2000);write(db,session(3000,310,after),NOW+3000);const r=readUsage(db,{now:NOW+3000});assert.equal(r.burn.workerCount,1);assert.equal(r.burn.workers.length,1);const worker=r.burn.workers[0];assert.equal(worker.inputTokens,110);assert.equal(worker.project,null);assert.equal(worker.model,null);assert.equal(worker.provider,before.provider===after.provider?'openai':null);assert.equal(worker.mixedDimensions,true);assert.equal(worker.observations,2);const selected=readUsage(db,{now:NOW+3000,projectIds:['Visible']});assert.equal(selected.burn.workers[0].mixedDimensions,false);assert.equal(selected.burn.workers[0].inputTokens,10);assert.equal(selected.burn.workers[0].project,'Visible');validateUsageDatabase(db);
 });
});
