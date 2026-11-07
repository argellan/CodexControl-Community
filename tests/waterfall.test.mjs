// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import {filterSnapshot} from '../lib/viewer-access.mjs';
import assert from 'node:assert/strict';

test('session project changes preserve original event scope across refresh, append and restart',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cc-project-TEST_ONLY-')),file=path.join(dir,'session.jsonl');
 const line=(type,payload)=>JSON.stringify({type,timestamp:'2026-10-21T12:00:00Z',payload})+'\n';
 try{
  await fs.writeFile(file,line('session_meta',{id:'TEST_ONLY-project-worker',cwd:'C:\\TEST_ONLY\\ProjectA'})+line('event_msg',{type:'task_started'}));
  const reader=new server.SessionReader(),first=await reader.read(file),original=first.events[0];assert.equal(original.project,'ProjectA');
  await fs.appendFile(file,line('turn_context',{cwd:'C:\\TEST_ONLY\\ProjectB'})+line('event_msg',{type:'task_complete'}));
  const changed=await reader.read(file);assert.equal(changed.project,'ProjectB');assert.deepEqual(changed.events.map(e=>e.project),['ProjectA','ProjectB']);assert.deepEqual(changed.events[0],original);
  const cached=await reader.read(file),restarted=await new server.SessionReader().read(file);assert.deepEqual(cached.events,changed.events);const sourceEvidence=e=>({id:e.id,project:e.project,sourceId:e.sourceId,offset:e.offset,at:e.at});assert.deepEqual(restarted.events.map(sourceEvidence),changed.events.map(sourceEvidence));assert.ok(restarted.events.every(e=>e.delivery==='bootstrap'));
  const events=changed.events.map(e=>({...e,hostId:'TEST_ONLY-host'})),snapshot={sessions:[{...changed,hostId:'TEST_ONLY-host'}],events,hosts:[],coverage:{}};
  const viewer=project=>({id:'TEST_ONLY-viewer',role:'viewer',hostIds:null,projectIds:[project]});
  assert.deepEqual(filterSnapshot(snapshot,viewer('ProjectA')).events.map(e=>e.id),[original.id]);
  assert.deepEqual(filterSnapshot(snapshot,viewer('ProjectB')).events.map(e=>e.id),[changed.events[1].id]);
  const legacy={...events[0],project:'ProjectB'};delete legacy.projectBasis;const historical={...snapshot,events:[legacy,...events]};assert.deepEqual(filterSnapshot(historical,viewer('ProjectB')).events.map(e=>e.id),[changed.events[1].id]);assert.equal(filterSnapshot(historical,{...viewer('ProjectB'),projectIds:null}).events.length,3);assert.equal(legacy.project,'ProjectB');assert.ok(filterSnapshot(historical,viewer('ProjectB')).coverage.projectAttribution.includes('legacy'));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as server from '../server.mjs';
const model = await import('../public/event-model.mjs').catch(()=>({}));
const base=Date.parse('2026-10-19T12:00:00Z');
const at=n=>new Date(base+n).toISOString();
const record=(type,payload,t=0)=>({type,timestamp:at(t),payload});
const meta={id:'worker',cwd:'C:\\TEST_ONLY\\Example',timestamp:at(0)};
const start=record('response_item',{type:'function_call',name:'exec_command',call_id:'call-1',arguments:'SECRET'},1000);
const finish=record('response_item',{type:'function_call_output',call_id:'call-1',output:'PRIVATE'},4000);
const summary=records=>server.summarizeRecords(records,meta,at(5000),100);
const event=(id,t,extra={})=>({id,at:at(t),sessionId:'worker',sourceId:'source',turnId:'turn',kind:'tool.start',label:'exec_command',callId:id,...extra});

test('failure category includes failed and interrupted operations across command and remote types',()=>{
 const events=[event('command',1000,{kind:'operation',category:'command',outcome:'failed'}),event('remote',1200,{kind:'remote.end',category:'remote',outcome:'interrupted'}),event('error',1300,{kind:'error',category:'error'}),event('ok',1400,{kind:'operation',category:'command',outcome:'completed'})];
 assert.deepEqual(model.visibleEvents(events,base+2000,2000,{category:'error'}).map(e=>e.id),['command','remote','error']);
});

test('browser canonical events retain only the exact optional operation compaction type and preserve legacy shapes',()=>{
 const legacy=event('legacy',1000,{kind:'operation',category:'tool',label:'Context compaction'}),typed={...legacy,id:'typed',operationType:'context-compaction'};
 const canonical=model.canonicalEvents([legacy])[0];assert.ok(!Object.hasOwn(canonical,'operationType'));assert.equal(model.canonicalEvents([typed])[0].operationType,'context-compaction');
 for(const value of ['ContextCompaction','compaction','context-compaction ',null,1,true,{}]){const result=model.canonicalEvents([{...legacy,operationType:value}])[0];assert.deepEqual(result,canonical);}
 for(const kind of ['tool.start','message','complete']){const result=model.canonicalEvents([{...typed,kind}])[0];assert.equal(result.kind,kind);assert.ok(!Object.hasOwn(result,'operationType'));}
 const store=new model.EventStore();store.ingest({observedAt:at(2000),sessions:[],hosts:[],events:[typed]});store.enterReplay(base+1000);assert.equal(store.viewEvents()[0].operationType,'context-compaction');store.ingest({observedAt:at(4000),sessions:[],hosts:[],events:[{...typed,id:'later',at:at(3000)}]});assert.equal(store.viewEvents().length,1);store.goLive();assert.equal(store.viewEvents().filter(e=>e.operationType==='context-compaction').length,2);
});

test('M01/M02: normalized events have stable distinct identities and safe payloads',()=>{
 const a=summary([start,finish]),b=summary([start,finish]);
 assert.equal(typeof a.events[0].id,'string');assert.notEqual(a.events[0].id,a.events[1].id);
 assert.deepEqual(a.events.map(e=>e.id),b.events.map(e=>e.id));
 assert.equal(a.events[0].callId,'call-1');assert.equal(a.events[1].outcome,'recorded');
 assert.ok(!JSON.stringify(a).includes('SECRET'));assert.ok(!JSON.stringify(a).includes('PRIVATE'));
});
test('M04/M05: scoped tool pairing yields 3s, orphan and invalid timing without fabricated durations',()=>{
 assert.equal(typeof model.buildSpans,'function');
 const e=summary([start,finish]).events;
 let spans=model.buildSpans(e,base+10000);assert.equal(spans.length,1);assert.equal(spans[0].durationMs,3000);
 spans=model.buildSpans([e[1]],base+10000);assert.equal(spans[0].status,'orphan');assert.equal(spans[0].durationMs,null);
 spans=model.buildSpans([e[0],{...e[1],at:at(0)}],base+10000);assert.equal(spans[0].status,'invalid');assert.equal(spans[0].durationMs,null);
 spans=model.buildSpans([e[0],{...e[1],sessionId:'other'}],base+10000);assert.equal(spans.length,2);
});
test('M02/M03: ten repeated snapshots create no emissions, quiet events age out',()=>{
 assert.equal(typeof model.EventStore,'function');const store=new model.EventStore();
 const snap={observedAt:at(2000),sessions:[],events:[event('one',1000)]};
 assert.equal(store.ingest(snap).length,0); // bootstrap is historical
 const next={...snap,observedAt:at(4000),events:[...snap.events,event('two',3000)]};
 assert.equal(store.ingest(next).length,1);
 for(let i=0;i<10;i++)assert.equal(store.ingest(next).length,0);
 assert.equal(store.events.size,2);assert.equal(model.visibleEvents(store.viewEvents(),base+65000,60000).length,0);
});
test('M06/M10: gaps and historical backfill never become fresh traffic; replay stays frozen',()=>{
 assert.equal(typeof model.EventStore,'function');const store=new model.EventStore();
 store.ingest({observedAt:at(5000),sessions:[],events:[event('one',1000)]});store.disconnect(base+6000);
 assert.equal(store.ingest({observedAt:at(9000),sessions:[],events:[event('one',1000),event('backfill',7000)]}).length,0);
 assert.equal(store.gaps.length,1);store.enterReplay(base+8000);
 store.ingest({observedAt:at(12000),sessions:[],events:[event('new',11000)]});
 assert.equal(store.viewEvents().some(e=>e.id==='new'),false);store.seek(base+1000);
 assert.equal(store.referenceTime(base+20000),base+1000);store.goLive();
 assert.equal(store.events.size,3);assert.equal(store.ingest({observedAt:at(12000),sessions:[],events:[event('new',11000)]}).length,0);
});
test('M07/M08/M09: only explicit hierarchy, approval and unqualified completion states',()=>{
 const ordinary=summary([record('event_msg',{type:'task_started',turn_id:'T'})]);assert.equal(ordinary.parentId,null);
 const child=server.summarizeRecords([], {...meta,id:'child',source:{subagent:{thread_spawn:{parent_thread_id:'worker',agent_path:'/root/scan'}}}},at(5000),100);
 assert.equal(child.parentId,'worker');assert.equal(child.agentPath,'/root/scan');
 const s=summary([record('event_msg',{type:'approval_requested',request_id:'R'},1000),record('event_msg',{type:'task_complete'},2000)]);
 assert.equal(s.events[0].kind,'approval');assert.equal(s.events.at(-1).outcome,'unverified');
 assert.ok(!JSON.stringify(s).includes('accepted'));
});
test('inherited fork history is excluded; native item timing exposes only safe metadata',()=>{
 const s=server.summarizeRecords([record('event_msg',{type:'task_started'},-5000),record('event_msg',{type:'item_completed',turn_id:'T',started_at_ms:base+1000,completed_at_ms:base+4000,item:{type:'CommandExecution',id:'I',command:'SECRET',aggregated_output:'PRIVATE',status:'completed',exit_code:2}},4000)],{...meta,forked_from_id:'parent'},at(5000),100);
 assert.equal(s.events.length,1);assert.equal(s.events[0].kind,'operation');assert.equal(s.events[0].outcome,'failed');
 assert.equal(s.events[0].startedAt,at(1000));assert.ok(!JSON.stringify(s).includes('SECRET'));
});
test('M11: aggregation preserves every membership and keeps errors and requests individual',()=>{
 assert.equal(typeof model.aggregateEvents,'function');
 const events=Array.from({length:500},(_,i)=>event('e'+i,1000+i%90));
 events.push(event('error',1050,{kind:'error',outcome:'failed'}),event('approval',1050,{kind:'approval'}));
 const projected=model.aggregateEvents(events,50);
 assert.equal(projected.reduce((n,e)=>n+(e.count||1),0),502);
 assert.ok(projected.some(e=>e.id==='error'));assert.ok(projected.some(e=>e.id==='approval'));
 assert.equal(new Set(projected.flatMap(e=>e.members||[e.id])).size,502);
});
test('M12: time projection, filters and replay seek share exact event IDs and clock',()=>{
 assert.equal(typeof model.visibleEvents,'function');const events=[event('a',1000),event('b',2000,{sessionId:'child'})];
 assert.deepEqual(model.visibleEvents(events,base+2500,1500,{sessionId:'child'}).map(e=>e.id),['b']);
 assert.deepEqual(model.visibleEvents(events,base+1500,1000).map(e=>e.id),['a']);
});
test('incremental reader preserves IDs on refresh/restart, buffers partial lines and detects rewrite',async()=>{
 assert.equal(typeof server.SessionReader,'function');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cc-observer-')),file=path.join(dir,'session.jsonl');
 try{
  await fs.writeFile(file,JSON.stringify(record('session_meta',meta))+'\n'+JSON.stringify(start)+'\n');
  const reader=new server.SessionReader();const first=await reader.read(file);const id=first.events[0].id;
  assert.equal((await reader.read(file)).events.length,1);assert.equal((await new server.SessionReader().read(file)).events[0].id,id);
  const line=JSON.stringify(finish);await fs.appendFile(file,line.slice(0,30));assert.equal((await reader.read(file)).events.length,1);
  await fs.appendFile(file,line.slice(30)+'\n');let next=await reader.read(file);assert.equal(next.events.length,2);assert.equal(next.events[0].id,id);
  await fs.writeFile(file,JSON.stringify(record('session_meta',meta))+'\n'+JSON.stringify({...start,payload:{...start.payload,call_id:'changed'}})+'\n');
  next=await reader.read(file);assert.notEqual(next.events[0].id,id);assert.equal(next.capture.reset,true);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('bounded bootstrap recovers the preceding turn context outside the event tail',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cc-context-')),file=path.join(dir,'session.jsonl');
 try{
  await fs.writeFile(file,[record('session_meta',meta),record('turn_context',{cwd:'C:\\TEST_ONLY\\Codex-Control',model:'recorded-model',turn_id:'T'}),record('response_item',{type:'message',role:'user',content:'PRIVATE'.repeat(90000)}),start,finish].map(r=>JSON.stringify(r)+'\n').join(''));
  const s=await new server.SessionReader().read(file);assert.equal(s.project,'Codex-Control');assert.equal(s.model,'recorded-model');assert.equal(s.events[0].turnId,'T');assert.ok(!JSON.stringify(s).includes('PRIVATE'));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('discovery includes actively modified logs stored in older dated folders',async()=>{
 assert.equal(typeof server.discoverSessions,'function');const root=await fs.mkdtemp(path.join(os.tmpdir(),'cc-discover-'));
 try{
  const folder=path.join(root,'2025','01','01');await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'old-session.jsonl'),JSON.stringify(record('session_meta',meta))+'\n');
  const result=await server.discoverSessions(root);assert.equal(result.files.length,1);assert.equal(result.discovered,1);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('usage metadata is a numeric allowlist rather than an arbitrary source payload',()=>{
 const s=summary([record('event_msg',{type:'token_count',info:{total_token_usage:{total_tokens:12,private_field:'PRIVATE'},model_context_window:'PRIVATE'}})]);
 assert.deepEqual(s.tokens,{total_tokens:12});assert.equal(s.contextWindow,null);assert.ok(!JSON.stringify(s).includes('PRIVATE'));
});
test('high throughput across a long interval coarsens display bins without losing counts or failures',()=>{
 const events=Array.from({length:10000},(_,i)=>event('burst-'+i,i*100));events.push(event('failure',1000,{kind:'error',outcome:'failed'}));
 const projected=model.aggregateEvents(events,200);assert.ok(projected.length<=201);assert.equal(projected.reduce((n,e)=>n+e.count,0),10001);assert.ok(projected.some(e=>e.id==='failure'));
});
test('replay freezes source health and capture gaps along with event history',()=>{
 const store=new model.EventStore();store.ingest({observedAt:at(5000),sessions:[],hosts:[{id:'host',status:'online',gaps:[]}],events:[event('one',1000)]});store.enterReplay(base+1000);
 store.ingest({observedAt:at(6000),sessions:[],hosts:[{id:'host',status:'disconnected',gaps:[{start:base+2000,end:base+6000}]}],events:[]});
 assert.equal(typeof store.viewHosts,'function');assert.equal(store.viewHosts()[0].status,'online');store.goLive();assert.equal(store.viewHosts()[0].status,'disconnected');
});
test('recent replay window remains usable when retained samples span months, without absorbing live arrivals',()=>{
 const store=new model.EventStore();store.ingest({observedAt:at(10000000),sessions:[],events:[event('old',0),event('recent',9999999)]});store.enterReplay(undefined,60000);
 assert.equal(store.bounds[1]-store.bounds[0],60000);store.ingest({observedAt:at(11000000),events:[event('later',10999999)],sessions:[]});store.setReplayWindow(300000);assert.equal(store.bounds[1],base+9999999);assert.equal(store.viewEvents().length,2);store.setReplayWindow(null);assert.equal(store.bounds[0],base);
});
