// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import http from 'node:http';
import {createServer} from './fixture-server.mjs';
import * as collector from '../collector.mjs';
import {extractUsageSamples,UsageSourceReader,summarizeRecords} from '../lib/observer.mjs';
import {canonicalEvents,EventStore,visibleEvents} from '../public/event-model.mjs';
const {sendBatch}=collector;
const fleet=await import('../lib/fleet.mjs').catch(()=>({}));
const host={id:'fixture-host',label:'Fixture host',tokenHash:crypto.createHash('sha256').update('fixture-key').digest('hex')};
const payload={hostId:host.id,batchId:'batch-1',observedAt:new Date().toISOString(),sessions:[{id:'session',project:'Example',state:'Turn started'}],events:[{id:'event',sessionId:'session',sourceId:'source',at:new Date().toISOString(),kind:'tool.start',category:'command',label:'exec_command',callId:'C',delivery:'live'}]};
test('fleet authenticates hosts, rejects secret-bearing payloads, deduplicates retry and survives hub restart',async()=>{
 assert.equal(typeof fleet.FleetHub,'function');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cc-fleet-'));
 try{
  let hub=await fleet.FleetHub.open({directory:dir,hosts:[host]});
  await assert.rejects(hub.ingest('wrong',payload),/Unauthorized/);
  await assert.rejects(hub.ingest('fixture-key',{...payload,events:[{...payload.events[0],arguments:'SECRET'}]}),/Unsupported/);
  const ack=await hub.ingest('fixture-key',payload);assert.equal(ack.added,1);
  assert.equal((await hub.ingest('fixture-key',payload)).added,0);
  hub=await fleet.FleetHub.open({directory:dir,hosts:[host]});let snap=hub.snapshot({sessions:[],events:[],host:{},coverage:{}});
  assert.equal(snap.events.length,1);assert.equal(snap.events[0].hostId,host.id);assert.equal(snap.sessions[0].hostId,host.id);
  assert.equal((await hub.ingest('fixture-key',payload)).added,0);
  snap=hub.snapshot({sessions:[],events:[],host:{},coverage:{}},Date.now()+40000);assert.equal(snap.hosts[0].status,'disconnected');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('fleet HTTP ingestion accepts only bounded authenticated collector POST; UI remains read-only',async()=>{
 assert.equal(typeof fleet.FleetHub,'function');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cc-http-'));let server;
 try{
  const hub=await fleet.FleetHub.open({directory:dir,hosts:[host]});server=createServer({hub});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  let r=await fetch(origin+'/api/collector',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});assert.equal(r.status,401);
  r=await fetch(origin+'/api/collector',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture-key'},body:JSON.stringify(payload)});assert.equal(r.status,200);assert.equal((await r.json()).added,1);
  r=await fetch(origin+'/api/snapshot',{method:'POST'});assert.equal(r.status,405);
  r=await fetch(origin+'/api/collector',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture-key'},body:'x'.repeat(2100000)});assert.equal(r.status,413);
 }finally{if(server)await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
});

test('native typed compaction survives authenticated transport, exact retry, durable restart and scoped browser replay while forged types are refused',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-compaction-TEST_ONLY-')),otherKey=crypto.randomBytes(32).toString('base64url'),other={id:'other-host',tokenHash:crypto.createHash('sha256').update(otherKey).digest('hex')},now=Date.now(),at=new Date(now-1000).toISOString();let server;
 try{
  const native={type:'event_msg',timestamp:at,payload:{type:'item_completed',item:{type:'ContextCompaction',id:'TEST_ONLY-compact',status:'completed',text:'PRIVATE_COMPACTION_TEXT'},started_at_ms:now-1500,completed_at_ms:now-1000}},ordinary={type:'event_msg',timestamp:at,payload:{type:'item_completed',item:{type:'CommandExecution',id:'TEST_ONLY-command',status:'completed',label:'Context compaction',aggregated_output:'PRIVATE_COMPACTION_TEXT'}}};
  const parsed=summarizeRecords([native,ordinary],{id:'TEST_ONLY-session',cwd:'C:\\TEST_ONLY\\Example'},new Date(now).toISOString(),100),body={hostId:host.id,batchId:'TEST_ONLY-compaction',observedAt:new Date(now).toISOString(),sessions:[{id:parsed.id,project:parsed.project}],events:parsed.events};
  let hub=await fleet.FleetHub.open({directory,hosts:[host,other]});server=createServer({hub});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,post=(value,token='fixture-key')=>fetch(origin+'/api/collector',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(value)});
  assert.equal((await post(body,null)).status,401);assert.equal(hub.journal.latest().length,0);
  let response=await post(body);assert.equal(response.status,200);assert.equal((await response.json()).added,2);response=await post(body);assert.equal((await response.json()).added,0);
  const retained=hub.journal.latest();assert.equal(retained.filter(e=>e.operationType==='context-compaction').length,1);assert.ok(!JSON.stringify(retained).includes('PRIVATE_COMPACTION_TEXT'));assert.ok(!Object.hasOwn(retained.find(e=>e.callId==='TEST_ONLY-command'),'operationType'));
  for(const operationType of ['ContextCompaction','compaction','context-compaction ','context-compaction\u0000',null,1,true,{}]){response=await post({...body,events:[{...parsed.events[0],id:'TEST_ONLY-forged',operationType}]});assert.equal(response.status,400);}
  for(const kind of ['tool.start','message','complete']){response=await post({...body,events:[{...parsed.events[0],id:'TEST_ONLY-wrong-kind',kind}]});assert.equal(response.status,400);}
  assert.deepEqual(hub.journal.latest(),retained);
  response=await post({...body,hostId:other.id,batchId:'TEST_ONLY-other',sessions:[{id:parsed.id,project:'Other'}],events:[{...parsed.events[0],project:'Other'}]},otherKey);assert.equal(response.status,200);assert.equal((await response.json()).added,1);
  server.closeAllConnections();await new Promise(r=>server.close(r));server=null;hub=await fleet.FleetHub.open({directory,hosts:[host,other]});assert.equal((await hub.ingest('fixture-key',body)).added,0);
  const all=canonicalEvents(hub.journal.latest()),scoped=canonicalEvents(hub.journal.latest({hostIds:[host.id],projectIds:['Example']}));assert.equal(all.length,3);assert.equal(scoped.length,2);assert.equal(scoped.filter(e=>e.operationType==='context-compaction').length,1);assert.ok(scoped.every(e=>e.hostId===host.id&&e.project==='Example'));
  const store=new EventStore();store.ingest({observedAt:new Date(now).toISOString(),sessions:[],hosts:[],events:all});store.enterReplay(now-1000);const selected=visibleEvents(store.viewEvents(),store.clock,60000,{hostId:host.id,project:'Example'});assert.equal(selected.filter(e=>e.operationType==='context-compaction').length,1);assert.equal(selected.filter(e=>e.operationType==='context-compaction')[0].id,scoped.find(e=>e.operationType==='context-compaction').id);
  store.ingest({observedAt:new Date(now+1000).toISOString(),sessions:[],hosts:[],events:[{...all.find(e=>e.operationType==='context-compaction'),id:'TEST_ONLY-new-live',at:new Date(now+500).toISOString()}]});assert.equal(store.viewEvents().length,3);store.goLive();assert.equal(store.viewEvents().length,4);
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('cc-compaction-TEST_ONLY-'));await fs.rm(directory,{recursive:true,force:true});}
});
test('real collector transport accepts normalized host metadata and retries a batch without duplication',async()=>{
 assert.equal(typeof fleet.FleetHub,'function');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cc-wire-'));let server;
 try{
  const hub=await fleet.FleetHub.open({directory:dir,hosts:[host]});server=createServer({hub});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const configuration={url:`http://127.0.0.1:${server.address().port}`,hostId:host.id,token:'fixture-key',expectedInstanceId:'unconfigured'};
  const body={...payload,events:[{...payload.events[0],hostId:host.id,hostName:'Actual host'}]};
  assert.equal((await sendBatch(configuration,body)).added,1);assert.equal((await sendBatch(configuration,body)).added,0);
  await assert.rejects(sendBatch({...configuration,url:'http://203.0.113.92:4317'},body),/HTTPS or a loopback/);
 }finally{if(server)await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
});
test('network dashboard requires a separate viewer credential; viewer cannot ingest',async()=>{
 const viewKey='test-viewer-secret',server=createServer({viewTokenHash:crypto.createHash('sha256').update(viewKey).digest('hex')});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 try{
  let r=await fetch(origin+'/');assert.equal(r.headers.get('set-cookie'),null);assert.match(await r.text(),/Sign in/);
  r=await fetch(origin+'/api/snapshot');assert.equal(r.status,401);
  r=await fetch(origin+'/api/snapshot',{headers:{authorization:'Bearer '+viewKey}});assert.equal(r.status,200);
  r=await fetch(origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'wrong'})});assert.equal(r.status,401);
  r=await fetch(origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:viewKey})});assert.equal(r.status,200);assert.ok(r.headers.get('set-cookie'));
  r=await fetch(origin+'/api/collector',{method:'POST',headers:{authorization:'Bearer '+viewKey}});assert.equal(r.status,405);
 }finally{await new Promise(r=>server.close(r));}
});
test('collector retains an unacknowledged batch on disk and reuses its exact identity after restart',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cc-outbox-')),root=path.join(dir,'sessions','2026','10','19');let listener;
 const token='fixture-collector-key-'.repeat(3),enrollment={...host,tokenHash:crypto.createHash('sha256').update(token).digest('hex')};
 try{
  await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'fixture.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'fixture',cwd:'C:\\Example'}})+'\n'+JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'task_started'}})+'\n');
  listener=http.createServer((req,res)=>{req.resume();if(req.url==='/api/identity'){res.end(JSON.stringify({deploymentId:'unconfigured',readOnly:true,protocolVersion:1}));return;}res.writeHead(503);res.end('Unavailable');});await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;
  const config=path.join(dir,'collector.json');await fs.writeFile(config,JSON.stringify({hostId:host.id,url:`http://127.0.0.1:${port}`,token,expectedInstanceId:'unconfigured',sessionRoot:path.join(dir,'sessions')}));
  const execute=promisify(execFile),entry=path.resolve('collector.mjs');await assert.rejects(execute(process.execPath,[entry,config,'--once'],{timeout:5000}));
  const stored=JSON.parse(await fs.readFile(config+'.outbox','utf8')),pending=stored.payload??stored;assert.equal(pending.events.length,1);
  await new Promise(r=>listener.close(r));const hub=await fleet.FleetHub.open({directory:path.join(dir,'hub'),hosts:[enrollment]});listener=createServer({hub});await new Promise(r=>listener.listen(port,'127.0.0.1',r));
  await execute(process.execPath,[entry,config,'--once'],{timeout:5000});await assert.rejects(fs.access(config+'.outbox'));
  const restarted=await fleet.FleetHub.open({directory:path.join(dir,'hub'),hosts:[enrollment]}),saved=restarted.states.get(host.id);assert.equal(saved.batchId,pending.batchId);assert.equal(restarted.journal.latest().length,1);
 }finally{if(listener)await new Promise(r=>listener.close(r));await fs.rm(dir,{recursive:true,force:true});}
});
test('portable laptop prefers Wi-Fi, falls back to Ethernet, and ignores addresses not on the machine',()=>{
 assert.equal(typeof collector.sourceAddresses,'function');const config={localAddresses:['198.51.100.91','198.51.100.90']},interfaces={Ethernet:[{address:'198.51.100.90'}],WiFi:[{address:'198.51.100.91'}]};
 assert.deepEqual(collector.sourceAddresses(config,interfaces),['198.51.100.91','198.51.100.90']);assert.deepEqual(collector.sourceAddresses(config,{Ethernet:interfaces.Ethernet}),['198.51.100.90']);assert.deepEqual(collector.sourceAddresses(config,{}),[undefined]);
});
test('transport timeout retains a network error code so another adapter can be tried',async()=>{
 const listener=http.createServer((req,res)=>{req.resume();if(req.url==='/api/identity')res.end(JSON.stringify({deploymentId:'TEST_ONLY-instance',readOnly:true,protocolVersion:1}));});await new Promise(r=>listener.listen(0,'127.0.0.1',r));
 try{await assert.rejects(sendBatch({url:`http://127.0.0.1:${listener.address().port}`,token:'fixture',expectedInstanceId:'TEST_ONLY-instance',timeoutMs:30},payload),e=>e.code==='ETIMEDOUT');}finally{listener.closeAllConnections();await new Promise(r=>listener.close(r));}
});

const usageRecord={type:'token_usage_record',timestamp:'2026-10-20T12:00:00Z',payload:{thread_id:'TEST_ONLY-thread',session_id:'TEST_ONLY-session',turn_id:'TEST_ONLY-turn',root_turn_id:'TEST_ONLY-root',response_id:'TEST_ONLY-response',usage:{input_tokens:10,cached_input_tokens:8,cache_write_input_tokens:4,output_tokens:5,reasoning_output_tokens:3,total_tokens:15},turn_token_usage:{total_tokens:15},thread_token_usage:{total_tokens:30}}};
const sourceSamples=()=>extractUsageSamples(usageRecord,{metadata:{id:'TEST_ONLY-owner',model_provider:'openai'},sourceId:'a'.repeat(64),sourceOffset:200});

test('durable numeric samples are authenticated to their origin host, ACKed exactly, retained outside state and idempotent after restart',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-fleet-usage-TEST_ONLY-'));
 try{
  let hub=await fleet.FleetHub.open({directory,hosts:[host]});const samples=sourceSamples(),body={...payload,usageSamples:samples,sessions:[]};
  const ack=await hub.ingest('fixture-key',body);assert.equal(ack.usageSamplesCount,3);assert.equal(ack.usageSamplesSha256,crypto.createHash('sha256').update(JSON.stringify(samples)).digest('hex'));
  let rows=hub.journal.database(db=>db.prepare('SELECT * FROM usage_samples_v2 ORDER BY usage_scope').all());assert.equal(rows.length,3);assert.ok(rows.every(row=>row.host_id===host.id&&row.session_id==='TEST_ONLY-owner'&&row.source_role==='codex-source'&&row.accounting_class==='candidate'));assert.equal(rows.find(r=>r.usage_scope==='response').cache_write_input_tokens,4);assert.equal(rows.find(r=>r.usage_scope==='response').reasoning_output_tokens,3);
  assert.equal(Object.hasOwn(hub.states.get(host.id),'usageSamples'),false);assert.ok(!JSON.stringify(hub.snapshot({host:{},sessions:[],events:[],coverage:{}})).includes('source_record_key'));
  hub=await fleet.FleetHub.open({directory,hosts:[host]});assert.equal((await hub.ingest('fixture-key',body)).usageSamplesCount,3);rows=hub.journal.database(db=>db.prepare('SELECT * FROM usage_samples_v2').all());assert.equal(rows.length,3);
  await assert.rejects(hub.ingest('fixture-key',{...body,hostId:'other'}),/identity/);
  for(const injected of [{host_id:'other'},{provider_account_key:'b'.repeat(64)},{source_role:'codex-source'},{arguments:'PRIVATE'},{producing_model:'invented'}])await assert.rejects(hub.ingest('fixture-key',{...body,usageSamples:[{...samples[0],...injected}]}),/usage sample/i);
  assert.equal(hub.journal.database(db=>db.prepare('SELECT COUNT(*) n FROM usage_samples_v2').get().n),3);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('fork and execution-source numeric observations survive capture while remaining excluded from new consumption',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-fleet-excluded-TEST_ONLY-'));
 try{
  const target={...host,role:'execution-target'},hub=await fleet.FleetHub.open({directory,hosts:[target]}),samples=sourceSamples();await hub.ingest('fixture-key',{...payload,usageSamples:samples});
  assert.ok(hub.journal.database(db=>db.prepare('SELECT accounting_class FROM usage_samples_v2').all()).every(r=>r.accounting_class==='execution-excluded'));
  const fork=extractUsageSamples(usageRecord,{metadata:{id:'TEST_ONLY-fork',forked_from_id:'TEST_ONLY-parent',timestamp:'2026-10-20T13:00:00Z'},sourceId:'c'.repeat(64),sourceOffset:201});
  const otherDirectory=path.join(directory,'fork'),source=await fleet.FleetHub.open({directory:otherDirectory,hosts:[host]});await source.ingest('fixture-key',{...payload,usageSamples:fork});const row=source.journal.database(db=>db.prepare('SELECT * FROM usage_samples_v2 WHERE usage_scope=?').get('response'));assert.equal(row.accounting_class,'fork-excluded');assert.equal(row.inherited_history,1);assert.equal(row.input_tokens,10);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('enrolled hub and gateway roles map explicitly to safe numeric-source roles',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-fleet-role-TEST_ONLY-'));
 try{for(const [role,sourceRole,accountingClass]of [['hub','codex-source','candidate'],['gateway','unknown','unknown']]){
  const hub=await fleet.FleetHub.open({directory:path.join(directory,role),hosts:[{...host,role}]});await hub.ingest('fixture-key',{...payload,usageSamples:sourceSamples()});const rows=hub.journal.database(db=>db.prepare('SELECT source_role,accounting_class FROM usage_samples_v2').all());assert.equal(rows.length,3);assert.ok(rows.every(r=>r.source_role===sourceRole&&r.accounting_class===accountingClass));
 }}finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('local numeric sample and private cursor commit atomically even when the display snapshot timestamp is unchanged',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-local-usage-TEST_ONLY-')),file=path.join(directory,'source.jsonl');
 try{
  await fs.writeFile(file,JSON.stringify({type:'session_meta',payload:{id:'TEST_ONLY-owner'}})+'\n'+JSON.stringify(usageRecord)+'\n');const capture=await new UsageSourceReader().read([file],null),hub=await fleet.FleetHub.open({directory:path.join(directory,'hub')});
  const local={observedAt:new Date().toISOString(),host:{id:'TEST_ONLY-local'},sessions:[],events:[],coverage:{}};await hub.captureLocal(local);await hub.captureLocal(local,{usageCapture:capture});assert.deepEqual(hub.journal.usageCursor(local.host.id),capture.nextCursor);assert.equal(hub.journal.database(db=>db.prepare('SELECT COUNT(*) n FROM usage_samples_v2').get().n),3);
  assert.equal(Object.hasOwn(hub.journal.state(local.host.id),'usageCursor'),false);assert.equal(hub.journal.state(local.host.id).coverage.numericUsage.sampleCount,3);
  const changed=structuredClone(capture.nextCursor);changed.lastFileKey=null;await assert.rejects(hub.captureLocal(local,{usageCapture:{...capture,nextCursor:changed,usageSamples:[{...capture.usageSamples[0],arguments:'PRIVATE'}]}}),/usage sample/i);assert.deepEqual(hub.journal.usageCursor(local.host.id),capture.nextCursor);assert.equal(hub.journal.database(db=>db.prepare('SELECT COUNT(*) n FROM usage_samples_v2').get().n),3);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
