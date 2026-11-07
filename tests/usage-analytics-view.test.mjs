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
import {resolveEvidenceTarget,buildRecordedToolMetrics,buildCompactionHistory,renderCompactionHistory,renderComparableDimensions,buildCurrentFamilyUsage,renderCurrentFamilyUsage,renderSourceCaptureDiagnostics,BurnSpikeTracker,renderUsageAnalytics,renderObservedRatios,renderQuotaPace} from '../public/usage-analytics-view.mjs';
import {normalizeUsageSample,summarizeUsageSamples} from '../lib/usage-samples.mjs';
import {EventStore} from '../public/event-model.mjs';
const now=Date.parse('2026-10-20T23:00:00Z'),stamp=offset=>new Date(now+offset).toISOString();
const event=(id,offset=0,extra={})=>({id,hostId:'TEST_ONLY-host',sourceId:'source',sessionId:'session',turnId:'turn',callId:'call',project:'TEST_ONLY-project',at:stamp(offset),kind:'tool.start',label:'Recorded command',...extra});
const session={id:'session',hostId:'TEST_ONLY-host'};
const burn=(offset,input=100,extra={})=>({observedAt:stamp(offset),burnUsage:{status:'observed',epoch:'TEST_ONLY-epoch',lastSequence:offset+100000,observedAt:stamp(offset),windowMs:1000,workers:[{hostId:session.hostId,sessionId:session.id,inputPerSecond:input,outputPerSecond:0,cachedInputPerSecond:input}],...extra}});
const sample=(id,extra={})=>normalizeUsageSample({session_id:'session',source_id:'a'.repeat(64),source_record_key:id.repeat(64),source_kind:'token_usage_record',usage_scope:'response',source_ms:now,source_offset:1,time_basis:'source',native_turn_id:'turn',native_thread_id:'thread',native_response_id:id,context_model:'configured-model',input_tokens:100,cached_input_tokens:50,output_tokens:20,reasoning_output_tokens:10,total_tokens:120,reported_mask:59,provider_reported_mask:0,synthesized_mask:0,...extra},{hostId:session.hostId,receivedMs:now,sourceRole:'codex-source'});

test('evidence targets use exact host/session/source/turn/call identity without substituting another worker',()=>{
 const target=event('end',-10,{kind:'tool.end'}),unrelated=event('other',-1,{hostId:'other'}),wrongTurn=event('wrong-turn',-1,{turnId:'other'}),wrongSource=event('wrong-source',-1,{sourceId:'other'}),future=event('future',1);
 const input=[target,unrelated,wrongTurn,wrongSource,future],before=structuredClone(input);
 assert.equal(resolveEvidenceTarget({...target,eventId:'end'},input,[session],{reference:now}).eventId,'end');
 assert.equal(resolveEvidenceTarget({hostId:session.hostId,sessionId:'session',sourceId:'source',turnId:'turn',callId:'call'},input,[session],{reference:now}).eventId,'end');
 const missing=resolveEvidenceTarget({hostId:session.hostId,sessionId:'session',eventId:'not-retained',turnId:'turn'},input,[session],{reference:now});assert.equal(missing.eventId,'');assert.equal(missing.match,'session-only');assert.equal(missing.missingExact,true);
 const host=resolveEvidenceTarget({hostId:'unknown',sessionId:'not-owned',turnId:'turn'},input,[session],{reference:now});assert.equal(host.match,'host-only');assert.equal(host.sessionId,'');assert.equal(resolveEvidenceTarget({sessionId:'session'},input,[session]),null);assert.deepEqual(input,before);
});

test('recorded call durations remain independent when calls overlap and outcomes stay separate',()=>{
 const events=[event('s1',-1000),event('e1',-500,{kind:'tool.end',outcome:'completed'}),event('s2',-900,{callId:'second'}),event('e2',-200,{kind:'tool.end',callId:'second',outcome:'failed'}),event('s3',-800,{callId:'third'}),event('e3',-100,{kind:'tool.end',callId:'third',outcome:'recorded'}),event('orphan',-50,{kind:'tool.end',callId:'orphan'}),event('open',-20,{callId:'open'})],before=structuredClone(events);
 const value=buildRecordedToolMetrics(events,{reference:now});assert.equal(value.calls,5);assert.equal(value.matched,3);assert.equal(value.completed,1);assert.equal(value.failed,1);assert.equal(value.unknown,1);assert.equal(value.missingStart,1);assert.equal(value.missingResult,1);assert.equal(value.p50Ms,700);assert.equal(value.p95Ms,700);assert.deepEqual(events,before);
 // Concurrent clocks do not become a summed wall-duration or native TTFT.
 assert.equal(Object.hasOwn(value,'wallDurationMs'),false);assert.equal(Object.hasOwn(value,'ttftMs'),false);
});

test('cancellations, missing identities, invalid clocks and conflicting records cannot become successful calls',()=>{
 const events=[event('start',-100),event('cancel',-10,{kind:'error',outcome:'interrupted',callId:undefined}),event('other-start',-200,{turnId:'other',callId:'other'}),event('other-end',-250,{turnId:'other',callId:'other',kind:'tool.end'}),event('missing',-20,{turnId:null}),event('dup-start',-100,{callId:'dup'}),event('dup-end',-10,{callId:'dup',kind:'tool.end',outcome:'completed'}),event('dup-end',-5,{callId:'dup',kind:'tool.end',outcome:'completed'}),event('future',10,{kind:'tool.end'})];
 const value=buildRecordedToolMetrics(events,{reference:now});assert.equal(value.cancelled,1);assert.equal(value.invalidClock,1);assert.equal(value.identityMissing,1);assert.equal(value.duplicateConflicts,1);assert.equal(value.ambiguous,1);assert.equal(value.completed,0);assert.equal(value.matched,0);assert.equal(value.p50Ms,null);
 const duplicate=event('same',-10);assert.equal(buildRecordedToolMetrics([duplicate,duplicate],{reference:now}).calls,1);
 const otherTurn=buildRecordedToolMetrics([event('s',-20),event('e',-10,{kind:'tool.end',turnId:'different',outcome:'completed'})],{reference:now});assert.equal(otherTurn.missingStart,1);assert.equal(otherTurn.missingResult,1);assert.equal(otherTurn.matched,0);
});

test('indexed cancellation preserves strict identities, inclusive clocks and turn-wide reuse',()=>{
 const run=(terminal,extra={})=>buildRecordedToolMetrics([event('start',-100,extra),event('end',-20,{...extra,kind:'tool.end',outcome:'completed'}),terminal],{reference:now});
 for(const [offset,cancelled]of [[-101,0],[-100,1],[-20,1],[-19,0]])assert.equal(run(event('terminal',offset,{kind:'error',outcome:'interrupted'})).cancelled,cancelled);
 for(const field of ['hostId','sessionId','sourceId','turnId'])assert.equal(run(event('terminal',-50,{kind:'error',outcome:'cancelled',[field]:'different'})).cancelled,0);
 for(const [sourceId,terminalSource,expected]of [[undefined,null,0],[null,undefined,0],[undefined,undefined,1],[null,null,1],[NaN,NaN,0]])assert.equal(run(event('terminal',-50,{kind:'error',outcome:'canceled',sourceId:terminalSource}),{sourceId}).cancelled,expected);
 const terminal=event('terminal',-50,{kind:'error',outcome:'interrupted',id:undefined,callId:'unrelated'}),records=[terminal,event('first',-100),event('second',-80,{callId:'second'})],before=structuredClone(records);
 assert.equal(buildRecordedToolMetrics(records,{reference:now}).cancelled,2);assert.deepEqual(records,before);
 assert.equal(buildRecordedToolMetrics([event('orphan',-10,{kind:'tool.end',outcome:'cancelled'})],{reference:now}).cancelled,1);
 const reverse=[event('start',-20),event('end',-100,{kind:'tool.end',outcome:'completed'}),event('terminal',-50,{kind:'error',outcome:'interrupted'})];assert.equal(buildRecordedToolMetrics(reverse,{reference:now}).invalidClock,1);
 assert.equal(run(event('terminal',1,{kind:'error',outcome:'interrupted'})).cancelled,0);
});

test('adversarial cancellation buckets at the20Krecord limit require linear timestamp parsing',t=>{
 const parse=Date.parse;let parses=0;t.mock.method(Date,'parse',value=>{parses++;return parse(value);});
 for(const n of [1000,2000,10000]){
  const records=[];for(let i=0;i<n;i++)records.push(event('terminal-'+i,-200-i,{kind:'error',outcome:'interrupted'}));for(let i=0;i<n;i++)records.push(event('start-'+i,-100,{callId:'call-'+i}));
  parses=0;const result=buildRecordedToolMetrics(records,{reference:now});assert.equal(result.missingResult,n);assert.equal(result.cancelled,0);assert.ok(parses<=records.length*2,'No per-call cancellation clock scan');
 }
 // All terminals after closed calls is another worst case for an early-exit scan.
 const records=[];for(let i=0;i<6000;i++)records.push(event('terminal-'+i,-1,{kind:'error',outcome:'cancelled'}),event('start-'+i,-100,{callId:'call-'+i}),event('end-'+i,-20,{kind:'tool.end',callId:'call-'+i,outcome:'completed'}));
 parses=0;assert.equal(buildRecordedToolMetrics(records,{reference:now}).completed,6000);assert.ok(parses<=records.length*2);
});

test('sampled burn spike needs non-overlapping qualified baselines and never double-adds cached input',()=>{
 const tracker=new BurnSpikeTracker();for(const offset of [-3000,-2000,-1000])assert.deepEqual(tracker.observe(burn(offset,100),{now,scope:'scope'}),[]);
 const current=burn(0,1000);current.sampleAnalytics={responses:{turns:[{hostId:session.hostId,sessionId:session.id,turnId:'turn',sourceAt:stamp(-1)}]}};
 const before=structuredClone(current),alerts=tracker.observe(current,{now,scope:'scope'});assert.equal(alerts.length,1);assert.equal(alerts[0].measuredRate,1000);assert.equal(alerts[0].baselineRate,100);assert.equal(alerts[0].baselineWindows,3);assert.equal(alerts[0].turnId,'turn');assert.deepEqual(current,before);
 assert.deepEqual(tracker.observe(current,{now,scope:'scope'}),alerts);assert.equal(tracker.history.get(JSON.stringify([session.hostId,session.id])).length,4);
 assert.equal(tracker.observe(burn(100,1000),{now:now+100,scope:'scope'})[0].id,alerts[0].id);assert.equal(tracker.history.get(JSON.stringify([session.hostId,session.id])).length,4);
 assert.deepEqual(tracker.current(now+1001),[]);
});

test('warmups, gaps, stale/future data, epoch/scope resets and absent workers clear comparison history',()=>{
 for(const invalid of [burn(0,100,{status:'warming'}),burn(0,100,{status:'partial'}),burn(0,100,{status:'gap'}),burn(0,100,{observedAt:stamp(-120001)}),burn(1),burn(0,100,{workers:[]})]){
  const tracker=new BurnSpikeTracker();for(const offset of [-3000,-2000,-1000])tracker.observe(burn(offset),{now,scope:'scope'});assert.deepEqual(tracker.observe(invalid,{now,scope:'scope'}),[]);assert.equal(tracker.history.size,0);
 }
 for(const [data,scope] of [[burn(0,2000,{epoch:'new'}),'scope'],[burn(0,2000),'new-scope'],[burn(4000,2000),'scope']]){const tracker=new BurnSpikeTracker();for(const offset of [-3000,-2000,-1000])tracker.observe(burn(offset),{now,scope:'scope'});assert.deepEqual(tracker.observe(data,{now:now+4000,scope}),[]);assert.ok([...tracker.history.values()].every(history=>history.length<=1));}
 const overlap=new BurnSpikeTracker();for(let i=0;i<20;i++)overlap.observe(burn(-2000+i*50),{now,scope:'scope'});assert.equal([...overlap.history.values()][0].length,1);
});

test('response UI uses backend weighted comparability and exact captured evidence without turning context into producing model',()=>{
 const a=sample('b'),b=sample('c',{input_tokens:900,cached_input_tokens:90,output_tokens:80,reasoning_output_tokens:8,total_tokens:980}),unknown=sample('d',{usage_scope:'last-response',native_response_id:null}),report=summarizeUsageSamples([a,b,unknown],{now});
 const html=renderUsageAnalytics(report,{now,events:[event('s',-100),event('e',-10,{kind:'tool.end',outcome:'recorded'})]});assert.match(html,/14\.0%/);assert.match(html,/18\.0%/);assert.match(html,/ratio of sums/);assert.match(html,/Comparable \/ excluded<\/dt><dd>2 \/ 0/);assert.match(html,/configured-model/);assert.match(html,/Producing model unavailable/);assert.match(html,/last-response/);assert.match(html,/Reported total/);assert.match(html,/provider 0 · synthesized 0/);assert.match(html,/recorded elapsed time, not native TTFT/);assert.match(html,/outcome-unknown/);assert.match(html,/data-usage-focus/);assert.doesNotMatch(html,/data-event=|data-map-event=/);
 const missing=renderUsageAnalytics(null);assert.match(missing,/analytics unavailable/);
});

test('coverage/truncation/unknown and inconsistent ratios stay explicit, and hostile labels are escaped',()=>{
 const row=sample('b',{context_model:'<img src=x onerror=x>',input_tokens:1,cached_input_tokens:3}),report=summarizeUsageSamples([row],{now,matchingRows:3,retainedRows:9});report.coverage.notes=['PRIVATE_NOTE'];report.responses.turns[0].producingModel='PRIVATE_PRODUCING';
 const html=renderUsageAnalytics(report,{now:now+130000});assert.match(html,/PARTIAL/);assert.match(html,/130s source age/);assert.match(html,/9 \/ 3 \/ 1/);assert.match(html,/Comparable \/ excluded<\/dt><dd>0 \/ 1/);assert.match(html,/Unavailable/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img|PRIVATE_NOTE|PRIVATE_PRODUCING/);assert.match(html,/cached input; output includes reasoning/);
});

test('sampled-window ratios expose comparable pairs and never substitute independent partial totals or average percentages',()=>{
 const ratios={cacheHit:{value:.16,numerator:160,denominator:1000,comparableRows:2,excludedRows:1,classification:'derived',method:'ratio-of-sums',reason:null},newInputFraction:{value:.84,numerator:840,denominator:1000,comparableRows:2,excludedRows:1,classification:'derived',method:'ratio-of-sums',reason:null}};
 const html=renderObservedRatios(ratios);assert.match(html,/16\.0%/);assert.match(html,/84\.0%/);assert.match(html,/160 \/ 1,000/);assert.match(html,/2 \/ 1/);assert.match(html,/Independent partial totals are not divided/);assert.match(html,/exact native response identities are unavailable/);
 const invalid=renderObservedRatios({cacheHit:{value:.5,method:'average-percent',classification:'derived'},newInputFraction:{value:NaN,method:'ratio-of-sums',classification:'derived'}});assert.doesNotMatch(invalid,/50\.0%/);assert.match(invalid,/Unavailable/);
});

test('historical dimension table renders real comparable source buckets, unknowns and all six inclusive/subset counters',()=>{
 const report=summarizeUsageSamples([sample('a',{context_provider:'provider-a',context_effort:'high',context_service_tier:'default',cache_write_input_tokens:0,reported_mask:63}),sample('b',{context_provider:null,context_model:null,context_effort:null,context_service_tier:null,input_tokens:null,output_tokens:null,total_tokens:null,reported_mask:18})],{now}),before=structuredClone(report),html=renderComparableDimensions(report.responses);
 assert.match(html,/Comparable historical dimensions \(2\)/);assert.match(html,/Configured provider/);assert.match(html,/Configured model/);assert.match(html,/Configured effort/);assert.match(html,/Configured service tier/);assert.match(html,/provider-a/);assert.match(html,/configured-model/);assert.match(html,/Unknown \(not captured\)/);assert.match(html,/Cache writes/);assert.match(html,/Reasoning \(output subset\)/);assert.match(html,/not account-wide completeness/);assert.match(html,/Producing model unavailable/);assert.deepEqual(report,before);
 report.responses.dimensions[0].producingModel='PRIVATE_PRODUCING';report.responses.dimensions[0].contextModel='<img src=x onerror=bad>';report.responses.dimensions.push(null);const escaped=renderComparableDimensions(report.responses);assert.match(escaped,/&lt;img/);assert.doesNotMatch(escaped,/<img|PRIVATE_PRODUCING/);assert.match(escaped,/Malformed dimension rows/);
 const many={dimensions:Array.from({length:30},(_,i)=>({hostId:'host-'+i,responseCount:i,input:null,cached:0,cacheWrite:null,output:1,reasoning:null,total:1})),dimensionsTruncated:true},bounded=renderComparableDimensions(many);assert.match(bounded,/24 of 30 returned buckets/);assert.match(bounded,/source projection bounded/);assert.doesNotMatch(bounded,/host-24|host-29/);assert.match(bounded,/Omitted buckets are not represented as zero/);assert.match(renderComparableDimensions(null),/buckets are unavailable/);
});

const compaction=(id,offset=-10,extra={})=>event(id,offset,{kind:'operation',operationType:'context-compaction',callId:null,label:'A source label is not the classifier',startedAt:stamp(offset-100),completedAt:stamp(offset),...extra});
test('compactions count only exact typed operations once per source identity and retain exact bounded navigation evidence',()=>{
 const first=compaction('c1',-20),second=compaction('c2',-10,{sourceId:'other'}),records=[second,first,{...first,label:'Different display label'},compaction('same-event-id',-5,{hostId:'other-host'}),compaction('same-event-id',-5),event('label-only',-2,{kind:'operation',label:'context_compaction ContextCompaction context-compaction'}),event('wrong-kind',-1,{operationType:'context-compaction'}),compaction('wrong-type',-1,{operationType:'ContextCompaction'}),compaction('future',1)],before=structuredClone(records),value=buildCompactionHistory(records,{reference:now,maxRows:2});
 assert.equal(value.count,4);assert.equal(value.duplicates,1);assert.equal(value.futureRows,1);assert.equal(value.untypedOperations,1);assert.equal(value.rows.length,2);assert.equal(value.rowsTruncated,true);assert.deepEqual(value.rows.map(row=>row.eventId),['same-event-id','same-event-id']);assert.notEqual(value.rows[0].hostId,value.rows[1].hostId);assert.deepEqual(records,before);
 const html=renderCompactionHistory([first],{reference:now,scope:'TEST_ONLY selected window'});assert.match(html,/1 unambiguous records/);assert.match(html,/100 ms/);assert.match(html,/TEST_ONLY selected window/);assert.match(html,/Legacy records without the discriminator cannot establish zero/);const encoded=html.match(/data-usage-focus="([^"]+)"/)[1],target=JSON.parse(encoded.replace(/&quot;/g,'"').replace(/&amp;/g,'&'));assert.deepEqual(target,{hostId:first.hostId,sessionId:first.sessionId,turnId:first.turnId,sourceId:first.sourceId,eventId:first.id});assert.equal(resolveEvidenceTarget(target,[first],[session],{reference:now}).eventId,first.id);
 const nullable=buildCompactionHistory([compaction('missing-timing',-1,{startedAt:null,completedAt:null})],{reference:now});assert.equal(nullable.count,1);assert.equal(nullable.rows[0].durationMs,null);
});

test('compaction conflicts, missing identity and invalid chronology are excluded, while legacy-only and future-only coverage stay unavailable',()=>{
 const records=[compaction('clock-conflict',-20),compaction('clock-conflict',-10),compaction('kind-conflict',-20),event('kind-conflict',-20,{kind:'operation'}),compaction('reverse',-5,{startedAt:stamp(-1),completedAt:stamp(-5)}),compaction('late-end',-10,{completedAt:stamp(-1)}),compaction('bad-date',-1,{at:'bad'}),compaction('missing-source',-1,{sourceId:null})],value=buildCompactionHistory(records,{reference:now});
 assert.equal(value.count,0);assert.equal(value.conflictingIdentities,2);assert.equal(value.invalidClock,3);assert.equal(value.identityMissing,1);assert.equal(value.rows.length,0);assert.equal(value.complete,false);
 for(const records of [[],[event('legacy',-1,{kind:'operation',label:'ContextCompaction'})],[compaction('future',1)]]){const legacy=buildCompactionHistory(records,{reference:now});assert.equal(legacy.count,null);assert.equal(legacy.status,'unavailable');assert.match(renderCompactionHistory(records,{reference:now}),/does not establish that none occurred/);}
 const first=compaction('good',-10),report=renderUsageAnalytics(null,{now,events:[first],eventReference:now});assert.match(report,/Captured context compactions · 1/);assert.match(report,/analytics unavailable/);assert.deepEqual(buildCompactionHistory([first,{...first,startedAt:new Date(now-110).toISOString().replace('Z','+00:00')}],{reference:now}).count,1);
});

const familyTurn=(sessionId,input,extra={})=>({hostId:session.hostId,sessionId,turnId:'turn-'+sessionId,sourceAt:stamp(-100),responseCount:1,input,cached:Math.floor(input/2),cacheWrite:0,output:10,reasoning:2,total:input+10,sampleKeys:['sample-'+sessionId],...extra});
const familyReport=turns=>({version:2,scope:{from:stamp(-10000),to:stamp(0)},coverage:{truncated:false},responses:{turns}});
test('current same-host family separates root direct, descendants and captured responses without adding cumulative or inherited fork counters',()=>{
 const sessions=[{id:'root',hostId:session.hostId,tokens:{total_tokens:99999999}},{id:'child',hostId:session.hostId,parentId:'root'},{id:'grandchild',hostId:session.hostId,parentId:'child'},{id:'missing-reading',hostId:session.hostId,parentId:'root'},{id:'fork',hostId:session.hostId,parentId:'root',forkedFrom:'older',tokens:{total_tokens:88888888}}],report=familyReport([familyTurn('root',100),familyTurn('child',200),familyTurn('grandchild',300,{cached:null}),familyTurn('fork',9999)]),before=structuredClone({sessions,report}),value=buildCurrentFamilyUsage(report,sessions,{now}),family=value.families[0];
 assert.equal(value.status,'observed');assert.equal(value.qualifiedLinks,3);assert.equal(value.excluded.forks,1);assert.equal(family.direct.input,100);assert.equal(family.descendants.input,500);assert.equal(family.family.input,600);assert.equal(family.family.responseCount,3);assert.equal(family.family.cached,null);assert.equal(family.missingMembers,1);assert.equal(family.members.length,4);assert.deepEqual({sessions,report},before);
 const html=renderCurrentFamilyUsage(report,sessions,{now});assert.match(html,/Root direct/);assert.match(html,/Descendants/);assert.match(html,/Captured family/);assert.match(html,/1 members lack comparable/);assert.match(html,/not historical lineage/);assert.doesNotMatch(html,/99999999|88888888|9,999/);assert.match(html,/data-usage-focus/);
 const missing=buildCurrentFamilyUsage(familyReport([familyTurn('child',100)]),[{id:'child',hostId:session.hostId,parentId:'root'},{id:'root',hostId:'other-host'}],{now});assert.equal(missing.status,'unavailable');assert.equal(missing.excluded.missingParent,1);
});

test('family invalid lineage, repeated or conflicting response identities, sample overlap, scope clocks and bounds remain explicit',()=>{
 const sessions=[{id:'root',hostId:session.hostId},{id:'child',hostId:session.hostId,parentId:'root'},{id:'conflict',hostId:session.hostId,parentId:'root'},{id:'conflict',hostId:session.hostId,parentId:'child'},{id:'a',hostId:session.hostId,parentId:'b'},{id:'b',hostId:session.hostId,parentId:'a'},{id:'orphan',hostId:session.hostId,parentId:'absent'}],root=familyTurn('root',100),child=familyTurn('child',200),turns=[root,{...root},child,{...child,input:201},familyTurn('root',99,{turnId:'future',sourceAt:stamp(1)}),familyTurn('child',1,{turnId:'old',sourceAt:stamp(-20000)})],value=buildCurrentFamilyUsage(familyReport(turns),sessions,{now});
 assert.equal(value.excluded.duplicateLineage,1);assert.equal(value.excluded.cycles,2);assert.equal(value.excluded.missingParent,1);assert.equal(value.excluded.conflictingTurns,1);assert.equal(value.excluded.invalidTurns,2);assert.equal(value.families[0].family.input,100);assert.equal(value.families[0].descendants.input,null);assert.equal(value.families[0].descendants.responseCount,null);
 const overlap=buildCurrentFamilyUsage(familyReport([root,{...child,sampleKeys:root.sampleKeys}]),sessions,{now});assert.equal(overlap.excluded.conflictingTurns,2);assert.equal(overlap.excluded.overlappingSamples,1);assert.equal(overlap.status,'unavailable');
 const manySessions=[],manyTurns=[];for(let i=0;i<15;i++){manySessions.push({id:'r'+i,hostId:session.hostId},{id:'c'+i,hostId:session.hostId,parentId:'r'+i});manyTurns.push(familyTurn('r'+i,i));}const bounded=buildCurrentFamilyUsage(familyReport(manyTurns),manySessions,{now});assert.equal(bounded.familyCount,15);assert.equal(bounded.families.length,12);assert.equal(bounded.truncated,true);assert.equal(buildCurrentFamilyUsage(familyReport([root]),[{id:'root',hostId:session.hostId}],{now}).status,'unavailable');
});

test('family consumes actual backend comparable turn summaries and preserves zero, missing and unsafe aggregate fields',()=>{
 const report=summarizeUsageSamples([sample('a'),sample('b',{session_id:'child',native_thread_id:'child-thread',native_turn_id:'child-turn'})],{now}),sessions=[session,{id:'child',hostId:session.hostId,parentId:session.id}],family=buildCurrentFamilyUsage(report,sessions,{now}).families[0];assert.equal(family.direct.input,100);assert.equal(family.descendants.input,100);assert.equal(family.family.input,200);assert.equal(family.family.cached,100);assert.equal(family.family.output,40);assert.equal(family.family.cacheWrite,null);assert.equal(family.family.responseCount,2);
 const lineage=[{id:'root',hostId:session.hostId},{id:'child',hostId:session.hostId,parentId:'root'}],unsafe=buildCurrentFamilyUsage(familyReport([familyTurn('root',Number.MAX_SAFE_INTEGER,{responseCount:Number.MAX_SAFE_INTEGER,output:0,total:null,cacheWrite:0}),familyTurn('child',1,{output:0,cacheWrite:0})]),lineage,{now}).families[0];assert.equal(unsafe.family.input,null);assert.equal(unsafe.family.responseCount,null);assert.equal(unsafe.family.output,0);assert.equal(unsafe.family.cacheWrite,0);assert.equal(unsafe.family.total,null);
 const repeated=familyTurn('root',10),conflict=buildCurrentFamilyUsage(familyReport([repeated,{...repeated,sampleKeys:['different-native-evidence']}]),lineage,{now});assert.equal(conflict.excluded.conflictingTurns,1);assert.equal(conflict.status,'unavailable');
 const hostile=renderCurrentFamilyUsage(familyReport([familyTurn('root',1,{hostId:'<img src=x>'})]),[{id:'root',hostId:'<img src=x>'},{id:'child',hostId:'<img src=x>',parentId:'root'}],{now});assert.match(hostile,/&lt;img/);assert.doesNotMatch(hostile,/<img/);
});

test('analytics forwards frozen/current lineage and session-only response scope without implying a full family total',()=>{
 const report=familyReport([familyTurn('child',10)]),sessions=[{id:'root',hostId:session.hostId},{id:'child',hostId:session.hostId,parentId:'root'}],lineageScope='Captured inventory frozen at replay entry; not historical lineage at selected source clock',html=renderUsageAnalytics(report,{now,sessions,lineageScope,sessionRestricted:true});assert.match(html,/Captured inventory frozen at replay entry; not historical lineage at selected source clock/);assert.match(html,/selected-session partial/);assert.match(html,/Selected-session contribution/);assert.match(html,/cannot establish the full family total/);assert.doesNotMatch(html,/<th scope="row">Captured family/);
 const fallback=renderUsageAnalytics(null,{now,sessions,lineageScope,sessionRestricted:true});assert.match(fallback,/not historical lineage at selected source clock/);assert.match(fallback,/Selected-session response samples only/);
});

test('capture diagnostics exposes only selected allowlisted counters, flags, reason codes and bounded source-version aggregates',()=>{
 const hosts=[{id:session.hostId,name:'TEST_ONLY laptop',status:'online',address:'203.0.113.7',coverage:{numericUsage:{version:1,source:'codex-rollout-numeric',heldFiles:2,invalidRecords:3,unscannedFiles:4,backlogged:true,inventoryLimited:false,scannedFiles:0,PRIVATE_FIELD:'PRIVATE_VALUE',errors:[{code:'invalid-json-record',sourceId:'PRIVATE_PATH'},{code:'PRIVATE_RAW_ERROR',sourceId:'PRIVATE_FILE'}]}}},{id:'missing',name:'203.0.113.7',coverage:{}}],sessions=[{hostId:session.hostId,version:'0.123.0'},{hostId:session.hostId,version:'0.123.0'},{hostId:session.hostId,version:null},{hostId:'outside-scope',version:'PRIVATE_OTHER_VERSION'}],before=structuredClone({hosts,sessions}),html=renderSourceCaptureDiagnostics(hosts,sessions);
 assert.match(html,/Held files<\/dt><dd>2/);assert.match(html,/Invalid records<\/dt><dd>3/);assert.match(html,/Unscanned files<\/dt><dd>4/);assert.match(html,/Scanned files<\/dt><dd>0/);assert.match(html,/Backlog<\/dt><dd>Yes/);assert.match(html,/Inventory limited<\/dt><dd>No/);assert.match(html,/invalid-json-record \(1\)/);assert.match(html,/0.123.0 \(2 sessions\)/);assert.match(html,/Unknown \(not captured\) \(1 sessions\)/);assert.match(html,/Numeric capture coverage<\/dt><dd>Unavailable/);assert.match(html,/Authorized source 2/);assert.doesNotMatch(html,/203\.0\.113\.7|PRIVATE_VALUE|PRIVATE_PATH|PRIVATE_RAW_ERROR|PRIVATE_FILE|PRIVATE_OTHER_VERSION/);assert.deepEqual({hosts,sessions},before);
 const missing=renderSourceCaptureDiagnostics([{id:'h',coverage:{numericUsage:{heldFiles:-1,invalidRecords:NaN,unscannedFiles:'5'}}}],[]);assert.match(missing,/Held files<\/dt><dd>Unavailable/);assert.match(missing,/Invalid records<\/dt><dd>Unavailable/);assert.doesNotMatch(missing,/<dd>-1|<dd>NaN|<dd>5/);
 const raw=sample('a',{source_version:'0.123.0'}),report=summarizeUsageSamples([raw],{now});assert.match(renderUsageAnalytics(report,{now,hosts,sessions}),/Source version 0.123.0/);report.recent[0].source_version='C:\\PRIVATE_PATH\\source';assert.doesNotMatch(renderUsageAnalytics(report,{now}),/PRIVATE_PATH/);
 const bounded=renderSourceCaptureDiagnostics(Array.from({length:20},(_,i)=>({id:'host-'+i})),[]);assert.match(bounded,/16 of 20 sources/);assert.doesNotMatch(bounded,/host-16|host-19/);
});

test('quota pace remains conditional, per-source, bounded and unavailable after source freshness expires',()=>{
 const estimate={hostId:'TEST_ONLY-host',limitId:'codex',window:'primary',status:'estimated',classification:'estimated',observedAt:stamp(-1000),resetsAt:(now+3600000)/1000,usedPercent:20,remainingPercent:80,observations:3,spanMs:1800000,percentagePointsPerHour:4,runwayHours:20,runwayRange:{fastHours:10,slowHours:30},minimumSpanMs:1800000,maximumGapMs:900000,boundary:'same-source-window'};
 const html=renderQuotaPace([estimate],{now});assert.match(html,/Estimated · conditional/);assert.match(html,/4 percentage points\/hour/);assert.match(html,/20 h/);assert.match(html,/10 h — 30 h/);assert.match(html,/3 \/ 30 min/);assert.match(html,/Source continuity is assumed/);assert.match(html,/No pooling, token-to-quota conversion/);
 const stale=renderQuotaPace([{...estimate,observedAt:stamp(-300001)}],{now});assert.match(stale,/Unavailable · stale/);assert.doesNotMatch(stale,/20 h|percentage points\/hour/);
 const missing=renderQuotaPace([{...estimate,status:'unavailable',reason:'insufficient-distinct-readings',runwayHours:null}],{now});assert.match(missing,/insufficient distinct readings/);assert.doesNotMatch(missing,/20 h/);
 const report=summarizeUsageSamples([sample('b')],{now});report.quotaPace=[estimate];assert.doesNotMatch(renderUsageAnalytics(report,{now,allowQuotaPace:false}),/Source-scoped quota pace/);assert.match(renderUsageAnalytics(report,{now}),/Source-scoped quota pace/);
});

test('explicit app evidence navigation selects the exact event and frozen replay without modifying event/motion watermarks',async()=>{
 const {ContextTrail}=await import('../public/investigation-workspace.mjs');const trail=new ContextTrail();
 const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8'),start=source.indexOf('function focusUsageEvidence('),end=source.indexOf('\nfunction renderAlertsPanel(',start);assert.ok(start>0&&end>start);
 const store=new EventStore();store.ingest({observedAt:stamp(0),events:[event('historical',-120000,{kind:'tool.end'}),event('now',0)],sessions:[session],hosts:[]});const nodes=new Map(),focuses=[];
 const node=id=>({value:'',textContent:'',close(){},querySelectorAll(){return [];},focus(){focuses.push(id);},scrollIntoView(){}});for(const id of ['detail-dialog','host-filter','project-filter','category-filter','search','replay-range','event-feed','worker-tree','clear-selection','announcer'])nodes.set(id,node(id));
 const context=vm.createContext({store,resolveEvidenceTarget,preferences:{overviewMode:'full'},applyPreferences(){},Date:class extends Date{static now(){return now;}},$:id=>nodes.get(id),structuredClone,hostHistory:new Map(),frozenHostHistory:new Map(),setMapExpansion(){},mapInspection:null,activityMap:{selection:null},selectedAggregate:null,selectedSession:'',selectedEvent:'',windowMs:60000,motionPaused:false,pausedAt:0,ref:()=>store.referenceTime(now),render(){},timelineRows:new Map(),accountUsageController:{refresh(){}},setTab(name){context.selectedTab=name;}});context.investigation={remember(){trail.push({host:nodes.get('host-filter').value,project:nodes.get('project-filter').value,category:nodes.get('category-filter').value,search:nodes.get('search').value,session:context.selectedSession,event:context.selectedEvent,mode:store.mode,at:context.ref(),windowMs:context.windowMs});}};vm.runInContext(source.slice(start,end),context);
 const before={newTotal:store.newTotal,events:JSON.stringify([...store.events.values()])};context.focusUsageEvidence({hostId:session.hostId,sessionId:session.id,eventId:'historical',turnId:'turn'});assert.equal(context.selectedEvent,'historical');assert.equal(context.selectedSession,session.hostId+'/session');assert.equal(store.mode,'replay');assert.equal(store.clock,now-120000+1);assert.equal(store.newTotal,before.newTotal);assert.equal(JSON.stringify([...store.events.values()]),before.events);assert.equal(nodes.get('host-filter').value,session.hostId);assert.match(nodes.get('announcer').textContent,/Focused event evidence/);
 const selection=context.selectedEvent;store.ingest({observedAt:stamp(1000),events:[event('new',1000)],sessions:[session],hosts:[]});assert.equal(context.selectedEvent,selection);assert.equal(store.mode,'replay');assert.ok(focuses.length>0);
});
