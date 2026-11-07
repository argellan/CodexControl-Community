// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as collector from '../collector.mjs';
import {RetryPolicy,retryAfterDelay} from '../public/retry-policy.mjs';
import {RenderScheduler} from '../public/render-scheduler.mjs';
import {EventStore,eventTime} from '../public/event-model.mjs';
import {bootstrapCursor,recoverPage} from '../public/recovery-model.mjs';
import {authorityChanged} from '../public/investigation-workspace.mjs';
import {BrowserDiagnostics} from '../public/diagnostics-workspace.mjs';

async function httpFixture(handler,run){const server=http.createServer((req,res)=>{if(req.url==='/api/identity'){req.resume();res.end(JSON.stringify({deploymentId:'TEST_ONLY-instance',readOnly:true,protocolVersion:1}));return;}if(req.url==='/api/collector/config'){req.resume();res.writeHead(404);res.end();return;}handler(req,res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));try{return await run(`http://127.0.0.1:${server.address().port}`);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}}

test('collector transport preserves only bounded retry guidance on refused delivery',()=>httpFixture((req,res)=>{req.resume();res.writeHead(429,{'retry-after':'12'});res.end('TEST_ONLY refusal');},async url=>{
 await assert.rejects(collector.sendBatch({url,hostId:'test-source',token:'TEST_ONLY_collector_credential_32_characters',expectedInstanceId:'TEST_ONLY-instance'},{hostId:'test-source',batchId:'TEST_ONLY-batch',sessions:[],events:[]}),error=>error.status===429&&error.retryAfter==='12'&&!error.message.includes('TEST_ONLY refusal'));
}));

test('collector delivery backoff retains the exact outbox until a matching ACK, then returns to its normal interval',async t=>{
 assert.equal(typeof collector.runCollectorLoop,'function');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-retry-TEST_ONLY-')),file=path.join(directory,'collector.json'),abort=new AbortController(),batches=[],delays=[];let clock=0;
 t.mock.method(console,'error',()=>{});
 try{await httpFixture((req,res)=>{let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{const payload=JSON.parse(raw);batches.push(payload);if(batches.length===1){res.writeHead(503,{'retry-after':'5'});res.end('TEST_ONLY unavailable');}else res.end(JSON.stringify({hostId:payload.hostId,batchId:batches.length===2?'TEST_ONLY-wrong-ACK':payload.batchId,added:0}));});},async url=>{
  await fs.writeFile(file,JSON.stringify({url,hostId:'test-source',token:'TEST_ONLY_collector_credential_32_characters',expectedInstanceId:'TEST_ONLY-instance',role:'execution-target'}));
  await collector.runCollectorLoop(()=>collector.runCollector(file,{once:true}),{intervalMs:1000,signal:abort.signal,clock:()=>clock,random:()=>1,wait:async delay=>{
   delays.push(delay);clock+=delay;
   if(delays.length<3){const pending=JSON.parse(await fs.readFile(file+'.outbox','utf8'));assert.equal(pending.batchId,batches[0].batchId);assert.deepEqual(pending,batches[0]);}
   else{await assert.rejects(fs.access(file+'.outbox'));abort.abort();}
  }});
  assert.deepEqual(delays,[5000,4000,1000]);assert.equal(batches.length,3);assert.deepEqual(batches[1],batches[0]);assert.deepEqual(batches[2],batches[0]);
 });}finally{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('cc-retry-TEST_ONLY-'));await fs.rm(directory,{recursive:true,force:true});}
});

async function browserPollingContext(origin){
 const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8'),start=source.indexOf('async function readObservation('),end=source.indexOf('\nfunction replay(',start),timers=new Map();let sequence=0,clock=Date.parse('2026-10-20T00:00:00Z');
 assert.ok(start>0&&end>start);const at=new Date(clock).toISOString(),event={id:'TEST_ONLY-five',journalSequence:5,at,delivery:'live',sessionId:'TEST_ONLY-session',hostId:'TEST_ONLY-host',kind:'turn',label:'TEST_ONLY event'},initial={observedAt:at,events:[event],sessions:[],hosts:[],history:{epoch:'TEST_ONLY-epoch',latestSequence:5}};
 const store=new EventStore();store.ingest(initial);const connection={textContent:'Connected',classList:{add(){}}};
 const context=vm.createContext({authorityChanged,browserDiagnostics:new BrowserDiagnostics({now:()=>clock}),snapshotAuthorized:true,mapFreshIds:new Set(),RetryPolicy,retryAfterDelay,observationRetry:new RetryPolicy({intervalMs:1000,maxMs:30000,clock:()=>clock,random:()=>1}),pollTimer:null,polling:false,document:{hidden:false},fetch:(url,options)=>fetch(origin+url,options),AbortSignal,Date:{now:()=>clock},console:{error(){}},store,snapshot:initial,recoveryCursor:bootstrapCursor(initial.history),historyGap:null,newest:[],pulseEligible:new Set(),mapArrivals:new Map(),eventTime,lastPoll:clock,renderScheduler:new RenderScheduler({yieldTask:()=>Promise.resolve()}),renderStages:function*(){yield;},render(){},renderHistoryStatus(){},bootstrapCursor,recoverPage,$:()=>connection,setTimeout:(fn,delay)=>{const id=++sequence;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(source.slice(start,end),context);return {context,timers,advance:ms=>{clock+=ms;},store,connection};
}

test('browser recovery waits for both requests, keeps its cursor after failure and catches up without replaying live arrivals',async()=>{
 let metadata=0,pages=0,heldPage,heldResolve,released=false;const held=new Promise(r=>heldResolve=r),calls=[];
 await httpFixture((req,res)=>{calls.push(req.url);if(req.url.startsWith('/api/snapshot')){metadata++;if(metadata===1){res.writeHead(503,{'retry-after':'3'});res.end('{}');return;}res.end(JSON.stringify({observedAt:'2026-10-20T00:00:03Z',sessions:[],hosts:[],history:{epoch:'TEST_ONLY-epoch',latestSequence:6}}));return;}
  pages++;const page={epoch:'TEST_ONLY-epoch',nextCursor:6,latestSequence:6,caughtUp:true,gap:null,events:[{id:'TEST_ONLY-six',journalSequence:6,at:'2026-10-20T00:00:02Z',delivery:'live',sessionId:'TEST_ONLY-session',hostId:'TEST_ONLY-host',kind:'turn',label:'TEST_ONLY recovered'}]};if(pages===1){heldPage=()=>{if(!released){released=true;res.end(JSON.stringify(page));}};heldResolve();}else res.end(JSON.stringify(page));
 },async origin=>{
  const {context,timers,advance,store,connection}=await browserPollingContext(origin),first=context.poll();
  try{await held;await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));assert.equal(context.polling,true,'a failed metadata request must not release the owner while its companion is pending');await context.poll();assert.equal(calls.length,2);heldPage();await first;
   assert.deepEqual(JSON.parse(context.browserDiagnostics.preview()).events.map(({kind,category,stack})=>({kind,category,stack})),[{kind:'client-js',category:'request-failed',stack:['client:poll']}]);
   assert.equal(context.recoveryCursor.after,5);assert.deepEqual([...store.events.keys()],['TEST_ONLY-five']);assert.equal(connection.textContent,'Disconnected / unknown');assert.equal(timers.size,1);assert.equal([...timers.values()][0].delay,3000);
   await context.poll();assert.equal(calls.length,2);assert.equal(timers.size,1);context.document.hidden=true;context.stopObservationPolling();assert.equal(timers.size,0);await context.poll();assert.equal(calls.length,2);advance(1000);context.document.hidden=false;await context.poll();assert.equal(calls.length,2);assert.equal([...timers.values()][0].delay,2000);advance(1999);await context.poll();assert.equal(calls.length,2);assert.equal([...timers.values()][0].delay,1);advance(1);const [timerId,timer]=timers.entries().next().value;timers.delete(timerId);await timer.fn();
   assert.equal(calls.length,4);assert.equal(context.recoveryCursor.after,6);assert.equal(context.recoveryCursor.recovering,false);assert.deepEqual([...store.events.keys()],['TEST_ONLY-five','TEST_ONLY-six']);assert.equal(store.events.get('TEST_ONLY-six').delivery,'backfill');assert.equal(context.mapArrivals.size,0);assert.equal(context.pulseEligible.size,0);assert.equal(context.observationRetry.failures,0);assert.equal(timers.size,1);assert.equal([...timers.values()][0].delay,1000);
   context.document.hidden=true;context.stopObservationPolling();assert.equal(timers.size,0);await context.poll();assert.equal(calls.length,4);
  }finally{heldPage?.();await first;}
 });
});
