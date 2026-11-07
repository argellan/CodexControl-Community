// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
const model=await import('../public/timeline-nav.mjs').catch(()=>({}));
const base=Date.parse('2026-10-20T12:00:00Z');
const at=n=>new Date(base+n).toISOString();
const event=(id,n,extra={})=>({id,at:at(n),hostId:'laptop',sourceId:'log',sessionId:'worker',turnId:'turn-1',project:'Codex-Control',kind:'note',category:'agent',...extra});
const nav=(events,options={})=>model.buildTimelineNavigation(events,{reference:base+10000,windowMs:10000,...options});
const densityNav=(events,options={})=>model.buildTimelineDensity(events,{reference:base+10000,windowMs:10000,...options});
const findRow=(result,eventId)=>result.groups.flatMap(g=>g.rows).find(r=>r.records.some(e=>e.eventId===eventId));

test('exports pure full and density-only timeline navigators',()=>{assert.equal(typeof model.buildTimelineNavigation,'function');assert.equal(typeof model.buildTimelineDensity,'function');});

test('density-only projection preserves exact bins, pending/error/request/selection priorities and scoped chronology',()=>{
 const records=[event('old-start',-1000,{kind:'tool.start',callId:'closed'}),event('closed',1000,{kind:'tool.end',callId:'closed'}),event('pending',2000,{kind:'tool.start',callId:'open'}),event('request',2100,{kind:'approval',requestId:'q'}),event('again',2200,{kind:'approval',requestId:'done'}),event('answer',2300,{kind:'resolution',requestId:'done'}),event('error',3000,{kind:'error',outcome:'failed'}),event('remote',4000,{kind:'remote.start',jobId:'j'}),event('report',4500,{kind:'remote.progress',jobId:'j'}),event('same',5000,{sourceId:'second',kind:'tool.end',callId:'open'}),event('future',11000,{kind:'approval',requestId:'future'}),event('duplicate',6000),event('duplicate',6000)];
 for(const scope of [{},{sourceId:'not-an-implicit-filter',selectedEventId:'pending'},{hostId:'other'},{sessionId:'worker',sessionHostId:'laptop',selectedEventId:'request'},{project:'Codex-Control',windowMs:5000}]){const full=nav(records,scope),density=nav(records,{...scope,includeGroups:false});assert.deepEqual(density.bins,full.bins);assert.deepEqual(density.groups,[]);assert.equal(density.counts,null);assert.equal(density.projection,'density-only');assert.deepEqual(nav(records.slice().reverse(),{...scope,includeGroups:false}),density);assert.deepEqual(densityNav(records,scope),density);}
 assert.ok(nav(records).groups.length>0);
});

test('retained-record normalization cache invalidates changed time, correlation, scope and classification without mutating source rows',()=>{
 const records=[event('first',1000,{kind:'tool.start',callId:'a'}),event('last',2000,{kind:'tool.end',callId:'a'})],before=structuredClone(records);nav(records);assert.deepEqual(records,before);
 for(const [field,value] of [['at',at(1500)],['sourceId','second'],['callId','b'],['project','Other'],['category','error'],['outcome','failed'],['startedAt',at(10)],['completedAt',at(20)],['workerHostId','remote'],['workerSessionId','job'],['id','replaced'],['sessionId','new-worker'],['turnId','new-turn'],['requestId','req'],['kind','operation']]){records[1][field]=value;assert.deepEqual(nav(records),nav(structuredClone(records)));}
});

test('source-time window deduplicates only exact host/source/session identities and ignores future/invalid records',()=>{
 const events=[event('shared',2000),event('first',1000),event('shared',2000),event('shared',2000,{hostId:'rack'}),event('shared',2000,{sourceId:'second-log'}),event('future',11000),event('bad',100,{at:'not a date'})];
 const result=nav(events);
 assert.equal(result.counts.events,4);assert.equal(result.bins.reduce((n,b)=>n+b.count,0),4);
 assert.equal(result.groups.length,3);assert.deepEqual(result.groups.find(g=>g.hostId==='laptop'&&g.sourceId==='log').rows.flatMap(r=>r.records.map(e=>e.eventId)),['first','shared']);
 assert.deepEqual(nav(events.slice().reverse()),result);
});

test('tool and remote rows pair out of order with exact scoped call identities and source seek records',()=>{
 const records=[event('end',5000,{kind:'tool.end',callId:'same'}),event('start',1000,{kind:'tool.start',callId:'same'}),event('other-turn',2000,{kind:'tool.start',callId:'same',turnId:'turn-2'}),event('other-source',3000,{kind:'tool.end',callId:'same',sourceId:'second'}),event('report',6000,{kind:'remote.progress',jobId:'job',callId:'job',progress:50}),event('job-end',8000,{kind:'remote.end',jobId:'job',callId:'job',outcome:'completed'})];
 const result=nav(records),paired=findRow(result,'start'),orphan=findRow(result,'other-source');
 assert.equal(paired.type,'tool');assert.equal(paired.durationMs,4000);assert.equal(paired.status,'result-recorded');
 assert.deepEqual(paired.seek,{eventId:'end',hostId:'laptop',sourceId:'log',sessionId:'worker',at:base+5000});
 assert.equal(findRow(result,'other-turn').status,'no-result-observed');assert.equal(orphan.status,'result-without-start');
 assert.equal(findRow(result,'report').type,'remote');assert.equal(findRow(result,'report').count,2);assert.equal(findRow(result,'report').durationMs,null);
 assert.equal(result.counts.tools,3);assert.equal(result.counts.pendingCalls,1);
});

test('a later source result closes an earlier call even when start precedes visible window, without adding hidden records to counts',()=>{
 const result=nav([event('start',500,{kind:'tool.start',callId:'c'}),event('end',9000,{kind:'tool.end',callId:'c'})],{windowMs:5000});
 assert.equal(result.counts.events,1);const row=findRow(result,'end');assert.equal(row.status,'result-recorded');assert.equal(row.durationMs,8500);assert.equal(row.start,base+500);assert.equal(row.count,1);assert.equal(row.records.length,1);
});

test('request state uses host/source/session/request resolution and never assumes completion resolves input',()=>{
 const result=nav([event('request',1000,{kind:'approval',requestId:'q'}),event('wrong-source',2000,{kind:'resolution',requestId:'q',sourceId:'other'}),event('complete',3000,{kind:'complete'}),event('resolved',4000,{kind:'approval',requestId:'done'}),event('answer',5000,{kind:'resolution',requestId:'done'}),event('missing-request',6000,{kind:'approval'})]);
 assert.equal(result.counts.inputRequests,2);assert.equal(findRow(result,'request').status,'waiting-for-input');assert.equal(findRow(result,'resolved').status,'resolution-recorded');assert.equal(findRow(result,'missing-request').status,'waiting-for-input');
 assert.equal(result.groups.find(g=>g.sourceId==='log').status,'waiting-for-input');
});

test('a repeated request identifier remains waiting when a later approval follows its captured resolution',()=>{
 const result=nav([event('request',1000,{kind:'approval',requestId:'q'}),event('answer',2000,{kind:'resolution',requestId:'q'}),event('again',3000,{kind:'approval',requestId:'q'})]);
 assert.equal(result.counts.inputRequests,1);assert.equal(findRow(result,'again').status,'waiting-for-input');assert.equal(result.bins.reduce((n,b)=>n+b.inputRequests,0),1);
});

test('fixed bins preserve zero regions, boundary events, failures and unresolved input counts',()=>{
 const result=nav([event('left',0),event('quarter',2500,{kind:'error'}),event('input',5000,{kind:'approval',requestId:'r'}),event('right',10000,{kind:'operation',outcome:'interrupted'})],{bins:4});
 assert.deepEqual(result.bins.map(b=>b.count),[1,1,1,1]);assert.deepEqual(result.bins.map(b=>b.errors),[0,1,0,1]);assert.deepEqual(result.bins.map(b=>b.inputRequests),[0,0,1,0]);assert.equal(result.bins[3].seek.eventId,'right');
 assert.deepEqual(nav([], {bins:4}).bins.map(b=>b.count),[0,0,0,0]);
});

test('bounds and projection depend only on supplied source records and reference, and never forward raw payloads',()=>{
 const records=[event('one',1000,{label:'PRIVATE PROMPT',arguments:'SECRET',output:'PRIVATE OUTPUT',payload:{private:'SECRET'}}),event('two',2000,{kind:'tool.start',callId:'c'})];
 const before=JSON.stringify(records),result=model.buildTimelineNavigation(records,{windowMs:10000});
 assert.equal(result.reference,base+2000);assert.equal(result.end,base+2000);assert.equal(JSON.stringify(records),before);
 assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.ok(!JSON.stringify(result).includes('SECRET'));
 assert.deepEqual(nav(records,{reference:base+1500}),nav([...records,event('later',3000)],{reference:base+1500}));
});

test('group and row bounds retain selected source identity and expose attention hidden by density',()=>{
 const records=Array.from({length:30},(_,i)=>event('e'+i,i*200,{turnId:'turn-'+i}));
 records.push(event('old-error',100,{kind:'error',turnId:'old'}),event('need-input',200,{kind:'approval',turnId:'input',requestId:'q'}));
 const result=nav(records,{maxGroups:3,maxRowsPerGroup:2,selectedEventId:'e0',selectedHostId:'laptop'});
 assert.equal(result.groups.length,3);assert.ok(result.groups.some(g=>g.selected));assert.ok(findRow(result,'old-error'));assert.ok(findRow(result,'need-input'));assert.equal(result.overflow.groups,29);assert.equal(result.overflow.events,29);assert.equal(result.overflow.errors,0);
 const many=nav(Array.from({length:20},(_,i)=>event('fail-'+i,i*100,{kind:'error'})),{maxRowsPerGroup:3});
 assert.equal(many.groups[0].rows.length,3);assert.equal(many.groups[0].errors,20);assert.equal(many.groups[0].overflow.errors,17);assert.equal(many.bins.reduce((n,b)=>n+b.errors,0),20);
});

test('selection does not collide when event IDs repeat on another host and selected event is retained within row bound',()=>{
 const records=[event('same',100,{hostId:'one'}),event('same',200,{hostId:'two'}),...Array.from({length:20},(_,i)=>event('new-'+i,300+i,{hostId:'one'}))];
 const result=nav(records,{selectedEventId:'same',selectedHostId:'one',maxRowsPerGroup:2});
 assert.equal(result.groups.filter(g=>g.selected).length,1);assert.equal(result.groups.find(g=>g.selected).hostId,'one');assert.ok(result.groups.find(g=>g.selected).rows.some(r=>r.selected));
});

test('host/session/project filters include only explicitly related remote work when requested',()=>{
 const records=[event('worker',100),event('job',200,{hostId:'pi',sessionId:'job',workerHostId:'laptop',workerSessionId:'worker',kind:'remote.start',callId:'j'}),event('unrelated',300,{hostId:'rack'}),event('wrong-project',400,{project:'Other'})];
 const scoped=nav(records,{hostId:'laptop',sessionId:'worker',project:'Codex-Control',includeRelated:true});assert.equal(scoped.counts.events,2);assert.ok(findRow(scoped,'job'));
 assert.equal(nav(records,{hostId:'laptop',sessionId:'worker',project:'Codex-Control',includeRelated:false}).counts.events,1);
});

test('atomic operation and turn state use recorded metadata without claiming running or accepted',()=>{
 const result=nav([event('begin',100,{kind:'turn'}),event('op',3000,{kind:'operation',startedAt:at(1000),completedAt:at(3000),outcome:'recorded',category:'command'}),event('end',4000,{kind:'complete',outcome:'unverified'})]);
 assert.equal(findRow(result,'op').durationMs,2000);assert.equal(result.groups[0].status,'turn-ended');assert.equal(result.counts.openTurns,0);assert.ok(!JSON.stringify(result).includes('accepted'));
 assert.equal(nav([event('begin',100,{kind:'turn'})]).counts.openTurns,1);
});

test('large supplied history keeps navigation and row size bounded while accounting for every record',()=>{
 const records=Array.from({length:10000},(_,i)=>event('e'+i,i,{turnId:'t'+Math.floor(i/5)}));
 const result=nav(records,{maxGroups:16,maxRowsPerGroup:3,bins:24});
 assert.equal(result.counts.events,10000);assert.equal(result.bins.length,24);assert.equal(result.groups.length,16);assert.ok(result.groups.every(g=>g.rows.length<=3));assert.equal(result.groups.reduce((n,g)=>n+g.count,0)+result.overflow.events,10000);
});

test('a remote progress burst has bounded record previews while retaining exact selected record and counts',()=>{
 const records=Array.from({length:1000},(_,i)=>event('progress-'+i,i,{kind:'remote.progress',jobId:'j',callId:'j'}));
 const result=nav(records,{selectedEventId:'progress-0',selectedHostId:'laptop',maxRecordsPerRow:8}),row=findRow(result,'progress-0');
 assert.equal(row.status,'progress-observed');assert.equal(row.count,1000);assert.equal(row.records.length,8);assert.equal(row.overflow.records,992);assert.equal(row.seek.eventId,'progress-0');assert.ok(row.records.some(e=>e.eventId==='progress-999'));
});

test('a bin containing later ordinary activity still seeks its failure or selected source record',()=>{
 const records=[event('failure',1000,{kind:'error'}),event('ordinary',2000)];
 assert.equal(nav(records,{bins:1}).bins[0].seek.eventId,'failure');assert.equal(nav(records,{bins:1,selectedEventId:'ordinary'}).bins[0].seek.eventId,'ordinary');
});

test('density navigation correlates pending state without allocating full row record arrays',async()=>{
 const {readFile}=await import('node:fs/promises'),{runInNewContext}=await import('node:vm');
 const source=await readFile(new URL('../public/timeline-nav.mjs',import.meta.url),'utf8'),allocations={records:0};
 const instrumented=runInNewContext(source.replaceAll('export function ','function ').replaceAll('records:[]','records:(allocations.records++,[])')+'\n({buildTimelineNavigation,buildTimelineDensity});',{allocations});
 const records=Array.from({length:40},(_,i)=>[
  event('start-'+i,i*100,{hostId:'scope-host',kind:'tool.start',callId:'call-'+i,turnId:'turn-'+i}),
  event('end-'+i,i*100+50,{hostId:'scope-host',kind:'tool.end',callId:'call-'+i,turnId:'turn-'+i})
 ]).flat();
 const options={reference:base+10000,windowMs:10000,includeGroups:false},result=instrumented.buildTimelineDensity(records,options);
 assert.equal(result.bins.reduce((n,b)=>n+b.count,0),records.length);assert.equal(allocations.records,0);
 instrumented.buildTimelineNavigation(records,{...options,includeGroups:true});assert.equal(allocations.records,40);
});

test('correlation encoding preserves escaped scope components and keeps tool remote turn and request identities distinct',()=>{
 const escaped={hostId:'host,"[\\\n',sourceId:'source\u0000',sessionId:'session\ud800',turnId:'turn,"',callId:'call,"',requestId:'request,"'},records=[
  event('tool-start',1000,{...escaped,kind:'tool.start'}),event('tool-end',2000,{...escaped,kind:'tool.end'}),
  event('remote-start',3000,{...escaped,kind:'remote.start',jobId:escaped.callId}),
  event('other-turn',4000,{...escaped,kind:'tool.start',turnId:escaped.turnId+'other'}),
  event('request',5000,{...escaped,kind:'approval'}),event('resolution',6000,{...escaped,kind:'resolution'}),
  event('other-session',7000,{...escaped,kind:'tool.end',sessionId:escaped.sessionId+'other'})
 ];
 const result=nav(records),scope=JSON.stringify([escaped.hostId,escaped.sourceId,escaped.sessionId]);
 assert.equal(findRow(result,'tool-start').id,JSON.stringify(['tool',escaped.hostId,escaped.sourceId,escaped.sessionId,escaped.turnId,escaped.callId]));
 assert.equal(findRow(result,'request').id,JSON.stringify(['request',scope,escaped.requestId]));
 assert.equal(findRow(result,'remote-start').status,'no-result-observed');assert.equal(findRow(result,'other-turn').status,'no-result-observed');assert.equal(findRow(result,'other-session').status,'result-without-start');
 assert.equal(findRow(result,'tool-start').durationMs,1000);assert.equal(findRow(result,'request').status,'resolution-recorded');
 assert.deepEqual(densityNav(records).bins,result.bins);
});

test('density summaries preserve correlation insertion order first starts last approvals and old finishes',()=>{
 const records=[event('old-finish',-2000,{kind:'remote.end',jobId:'old'}),event('old-request-answer',-1500,{kind:'resolution',requestId:'before'}),
  event('old-start',-1000,{kind:'tool.start',callId:'old'}),event('old-request',-500,{kind:'approval',requestId:'before'}),
  event('first-start',100,{kind:'remote.unusual.start',jobId:'x'}),event('second-start',200,{kind:'remote.start',jobId:'x'}),
  event('old-finish-start',300,{kind:'remote.start',jobId:'old'}),event('visible-finish',400,{kind:'tool.end',callId:'old'}),
  event('approval',500,{kind:'approval',requestId:'q'}),event('resolution',600,{kind:'resolution',requestId:'q'}),event('again',700,{kind:'approval',requestId:'q'}),
  event('remote-unusual-end',800,{kind:'remote.unusual.end',jobId:'done'}),event('remote-done-start',900,{kind:'remote.start',jobId:'done'}),event('ordinary',1000)];
 for(const events of [records,records.slice().reverse()])for(const selectedEventId of ['', 'again','first-start'])for(const windowMs of [10000,9900]){
  const full=nav(events,{bins:1,windowMs,selectedEventId}),shown=densityNav(events,{bins:1,windowMs,selectedEventId});assert.deepEqual(shown.bins,full.bins);assert.equal(shown.bins[0].pendingCalls,1);assert.equal(shown.bins[0].inputRequests,1);
 }
});

test('density option accessors retain legacy getter reads and a failed descriptor observation falls back safely',()=>{
 const records=[event('start',100,{kind:'tool.start',callId:'c'}),event('end',200,{kind:'tool.end',callId:'c'}),event('request',300,{kind:'approval',requestId:'r'}),event('ordinary',400)],options={reference:base+10000,windowMs:10000},reads=[];
 Object.defineProperty(options,'includeGroups',{get(){reads.push('includeGroups');return false;}});const result=model.buildTimelineNavigation(records,options);
 assert.deepEqual(reads,['includeGroups','includeGroups']);assert.deepEqual(result,nav(records,{includeGroups:false}));
 const proxy=new Proxy({reference:base+10000,windowMs:10000,includeGroups:false},{getOwnPropertyDescriptor(){throw new Error('TEST_ONLY reflection unavailable');}});
 assert.deepEqual(model.buildTimelineNavigation(records,proxy),result);
});

test('malformed kind accessors retain legacy method evaluation order in density navigation',()=>{
 const fixture=()=>{const log=[],records=['remote.start','remote.end'].map((kind,i)=>{let reads=0;const methods={startsWith(value){log.push(i+' starts '+value);return kind.startsWith(value);},endsWith(value){log.push(i+' ends '+value);return kind.endsWith(value);}},record=event('accessor-'+i,100+i*100,{jobId:'job'});Object.defineProperty(record,'kind',{enumerable:true,get(){return ++reads===2?methods:kind;}});return record;});return {log,records};};
 const actual=fixture(),legacy=fixture(),options={reference:base+10000,windowMs:10000};
 const result=model.buildTimelineNavigation(actual.records,{...options,includeGroups:false}),fallback=model.buildTimelineNavigation(legacy.records,{...options,get includeGroups(){return false;}});
 assert.deepEqual(result,fallback);assert.deepEqual(actual.log,legacy.log);
});
