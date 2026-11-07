// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {FleetHub} from '../lib/fleet.mjs';
import {StorageBackpressure} from '../lib/storage-admission.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createServer} from './fixture-server.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(){const hub=new FleetHub();hub.queue=Promise.resolve();hub.localCaptureHostId='test-local';let committed=null;hub.journal={state:()=>structuredClone(committed)};return {hub,get committed(){return committed;},set committed(value){committed=structuredClone(value);}};}
const snapshot=(events=[])=>({observedAt:'2026-11-02T12:00:00.000Z',host:{id:'test-local',name:'TEST_ONLY'},sessions:[{id:'test-session',events}],events,coverage:{}});

test('native collection retains every event while parallel dashboard reads fit the unchanged queue',async()=>{
 const f=fixture(),barrier=deferred(),events=Array.from({length:8400},(_,i)=>({id:'TEST_ONLY-'+i,sessionId:'test-session',at:'2026-11-02T12:00:00.000Z',kind:'operation',label:'x'.repeat(500)})),local=snapshot(events),writes=[];
 assert.ok(Buffer.byteLength(JSON.stringify({local}))*4+65536>32*1048576);
 f.hub.captureLocalNow=async owned=>{await barrier.promise;writes.push(owned.events.map(e=>e.id));const {events,...state}=owned;state.sessions=state.sessions.map(({events,...s})=>s);f.committed=state;};
 const collection=f.hub.captureLocal(local),reads=[f.hub.captureRead(local,owned=>owned.observedAt),f.hub.captureRead(local,owned=>owned.sessions.length)];
 const results=Promise.allSettled([collection,...reads]);barrier.resolve();const settled=await results;
 assert.deepEqual(settled.map(r=>r.status),['fulfilled','fulfilled','fulfilled']);assert.equal(settled[1].value,local.observedAt);assert.equal(settled[2].value,1);
 assert.equal(writes.length,1,'a dashboard read must not recapture the source');assert.deepEqual(writes[0],events.map(e=>e.id));assert.equal(f.hub.pendingJobs,0);assert.equal(f.hub.pendingBytes,0);
});

test('a deferred capture leaves readers on the exact committed observation without inventing fresh state',async()=>{
 const f=fixture();f.committed={...snapshot(),observedAt:'2026-11-02T11:00:00.000Z'};f.hub.captureLocalNow=async()=>{throw new StorageBackpressure();};
 const local=snapshot(),results=await Promise.allSettled([f.hub.captureLocal(local),f.hub.captureRead(local,owned=>{owned.sessions[0].id='changed';return owned.observedAt;})]);
 assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');assert.equal(results[1].value,'2026-11-02T11:00:00.000Z');assert.equal(f.committed.sessions[0].id,'test-session');
});

test('a native source without a durable observation reports deferred capture, with no fresh activity',async()=>{
 const {hub}=fixture();hub.captureLocalNow=()=>{throw Error('must not capture on read');};
 const read=await hub.captureRead(snapshot([{id:'not-committed'}]),owned=>owned);
 assert.equal(read.observedAt,null);assert.equal(read.coverage.captureDeferred,true);assert.deepEqual(read.events,[]);assert.deepEqual(read.sessions,[]);assert.equal(read.host.id,'test-local');
});

test('an independently supplied source retains the existing capture-before-read contract',async()=>{
 const {hub}=fixture(),local={...snapshot(),host:{id:'other-source'}};let captures=0;hub.captureLocalNow=async owned=>{captures++;assert.equal(owned.host.id,'other-source');};
 assert.equal(await hub.captureRead(local,owned=>owned.observedAt),local.observedAt);assert.equal(captures,1);
});

test('the live read path waits for durable native capture and preserves exact records in snapshot and history',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-native-read-TEST_ONLY-'));let server,releaseWriter;
 try{
  const hub=await FleetHub.open({directory,hosts:[]});hub.localCaptureHostId='test-local';releaseWriter=hub.retainJournalWriter();
  const now=new Date().toISOString(),events=Array.from({length:128},(_,i)=>({id:'TEST_ONLY-durable-'+i,sessionId:'test-session',hostId:'test-local',at:now,kind:'operation',label:'TEST_ONLY operation '+i})),local={...snapshot(events),observedAt:now};
  await hub.captureLocal(local);
  const token='TEST_ONLY-native-read-key';server=createServer({hub,viewTokenHash:crypto.createHash('sha256').update(token).digest('hex'),readSnapshot:async()=>local});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const responses=await Promise.all(['/api/snapshot?metadata=1','/api/events?after=0&limit=1000','/api/snapshot'].map(route=>fetch(origin+route,{headers:{authorization:'Bearer '+token}})));assert.deepEqual(responses.map(r=>r.status),[200,200,200]);
  const [metadata,history,full]=await Promise.all(responses.map(r=>r.json()));assert.equal(metadata.history.latestSequence,128);assert.deepEqual(history.events.map(e=>e.id),events.map(e=>e.id));assert.deepEqual(new Set(full.events.map(e=>e.id)),new Set(events.map(e=>e.id)));
  assert.equal(hub.journal.state('test-local').observedAt,now);assert.equal(hub.journal.status().retainedEvents,128);assert.equal(hub.pendingJobs,0);
 }finally{if(server)await new Promise(r=>server.close(r));await releaseWriter?.();await fs.rm(directory,{recursive:true,force:true});}
});
