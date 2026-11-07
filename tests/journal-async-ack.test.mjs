// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {FleetHub} from '../lib/fleet.mjs';
const token='TEST_ONLY_writer_token',hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function fixture(fn){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-async-ack-TEST_ONLY-'));try{const hub=await FleetHub.open({directory,hosts:[{id:'test-source',tokenHash:hash(token)}]});await fn(hub);}finally{await fs.rm(directory,{recursive:true,force:true});}}
const payload=id=>({hostId:'test-source',batchId:id,observedAt:new Date().toISOString(),sessions:[],events:[{id,sessionId:'test-session',at:new Date().toISOString(),kind:'operation'}]});

test('collector publishes state and acknowledges only after its journal commit completes',()=>fixture(async hub=>{
 const entered=deferred(),release=deferred(),realCommit=hub.journal.commit.bind(hub.journal);
 hub.journal.commit=async args=>{entered.resolve();await release.promise;return realCommit(args);};
 let settled=false;const pending=hub.ingest(token,payload('first')).then(v=>{settled=true;return v;});
 try{await entered.promise;await new Promise(r=>setImmediate(r));assert.equal(settled,false,'no ACK before durable commit');assert.equal(hub.states.has('test-source'),false,'no unpublished host state');assert.equal(hub.journal.status().retainedEvents,0);}finally{release.resolve();await pending;}
 assert.equal(hub.journal.status().retainedEvents,1);assert.equal(hub.states.get('test-source').batchId,'first');
}));

test('local capture publishes its observation watermark only after durable completion',()=>fixture(async hub=>{
 const entered=deferred(),release=deferred(),realCommit=hub.journal.commit.bind(hub.journal),observedAt=new Date().toISOString();
 hub.journal.commit=async args=>{entered.resolve();await release.promise;return realCommit(args);};
 const local={host:{id:'test-local'},observedAt,sessions:[],events:[{id:'local-first',at:observedAt,kind:'operation'}]};
 const pending=hub.captureLocal(local);try{await entered.promise;assert.notEqual(hub.localObservedAt,observedAt,'watermark must not advance before commit');}finally{release.resolve();await pending;}
 assert.equal(hub.localObservedAt,observedAt);assert.equal(hub.journal.status().retainedEvents,1);
}));

test('read assembly owns the FIFO until its committed state and history are materialized',()=>fixture(async hub=>{
 const entered=deferred(),release=deferred(),realCommit=hub.journal.commit.bind(hub.journal),order=[];
 hub.journal.commit=async args=>{order.push('commit:'+args.hostId);if(args.hostId==='test-local'){entered.resolve();await release.promise;}return realCommit(args);};
 const local={host:{id:'test-local'},observedAt:new Date().toISOString(),sessions:[],events:[]};
 const read=hub.captureRead(local,()=>{order.push('read');assert.equal(hub.states.has('test-source'),false);return hub.journal.status().retainedEvents;});
 await entered.promise;const write=hub.ingest(token,payload('after-read'));release.resolve();assert.equal(await read,0);await write;assert.deepEqual(order,['commit:test-local','read','commit:test-source']);
}));

test('the parent FIFO refuses excess pending operations before retaining an unbounded backlog',()=>fixture(async hub=>{
 const entered=deferred(),release=deferred(),realCommit=hub.journal.commit.bind(hub.journal);
 hub.journal.commit=async args=>{entered.resolve();await release.promise;return realCommit(args);};
 const pending=Array.from({length:33},(_,i)=>hub.ingest(token,payload('bounded-'+i)));const results=Promise.allSettled(pending);
 await entered.promise;release.resolve();const settled=await results;
 assert.equal(settled[32].status,'rejected');assert.equal(settled[32].reason.code,'JOURNAL_QUEUE_BACKPRESSURE');assert.equal(hub.journal.status().retainedEvents,32);
}));

test('server-owned writer drains accepted work before its final owner releases it',()=>fixture(async hub=>{
 const release=hub.retainJournalWriter();
 try{
  const writes=[hub.ingest(token,payload('owned-first')),hub.ingest(token,payload('owned-second'))];
  await new Promise(r=>setImmediate(r));assert.ok(hub.writer?.pending,'exercise an active worker before shutdown');const closing=release();await Promise.all(writes);await closing;
  assert.equal(hub.journal.status().retainedEvents,2);assert.equal(hub.writer,null);
  await hub.ingest(token,payload('headless-after-close'));assert.equal(hub.journal.status().retainedEvents,3);
 }finally{await release();}
}));

test('read projections charge and own their retained snapshot bytes',()=>fixture(async hub=>{
 const entered=deferred(),release=deferred(),realCommit=hub.journal.commit.bind(hub.journal);
 hub.journal.commit=async args=>{entered.resolve();await release.promise;return realCommit(args);};
 const first=hub.ingest(token,payload('byte-gate'));await entered.promise;
 const value={body:'x'.repeat(6*1048576)},pending=[hub.readProjection(value,owned=>owned.body.length),hub.readProjection(value,owned=>owned.body.length),hub.readProjection(value,owned=>owned.body.length)];
 const results=Promise.allSettled(pending);value.body='changed after admission';release.resolve();await first;const settled=await results;
 assert.equal(settled[0].status,'fulfilled');assert.equal(settled[0].value,6*1048576);assert.equal(settled[1].status,'fulfilled');assert.equal(settled[2].status,'rejected');assert.equal(settled[2].reason.code,'JOURNAL_QUEUE_BACKPRESSURE');assert.equal(hub.pendingBytes,0);assert.equal(hub.pendingJobs,0);
}));

test('uncertain synchronous compatibility writes fence queued jobs and reload committed state',()=>fixture(async hub=>{
 hub.journal.storageAdmission.statfs=()=>({bavail:1000000,bsize:4096,blocks:1000000});const release=hub.retainJournalWriter();
 const realCommit=hub.journal.commit.bind(hub.journal);let first=true;
 hub.journal.commit=args=>{const result=realCommit(args);if(first){first=false;throw new Error('TEST_ONLY commit returned but close failed');}return result;};
 const original=payload('uncertain-sync');
 try{
  const settled=await Promise.allSettled([hub.ingest(token,original),hub.ingest(token,payload('must-retry'))]);
  assert.equal(settled[0].status,'rejected');assert.equal(settled[1].status,'rejected');assert.equal(settled[1].reason.code,'JOURNAL_GENERATION_CHANGED');
  assert.equal(hub.journal.status().retainedEvents,1);assert.equal(hub.states.get('test-source').batchId,'uncertain-sync');assert.equal(hub.fenced,false);
  hub.journal.commit=realCommit;assert.equal((await hub.ingest(token,original)).added,0);
 }finally{await release();}
}));
