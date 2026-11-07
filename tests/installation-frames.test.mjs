// Author: Bishop Crockett
// Owner: Argellan.com
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {FleetHub} from '../lib/fleet.mjs';
const key='TEST_ONLY-frame-key',host={id:'node-frame',label:'TEST_ONLY framed Node',tokenHash:crypto.createHash('sha256').update(key).digest('hex'),installationManaged:true},frameId='a'.repeat(64);
const session=id=>({id,project:'TEST_ONLY',state:'Turn started'});
const batch=(id,observedAt,sessions,sessionFrame)=>({hostId:host.id,batchId:id,observedAt,sessions,events:[{id:'event-'+id,sessionId:'fixture-session',sourceId:'TEST_ONLY-log',at:observedAt,kind:'turn',label:'TEST_ONLY frame event'}],coverage:{limit:128},...(sessionFrame?{sessionFrame}:{})});
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ARGELLAN-TEST_ONLY-frames-')),releases=[];let hub;const open=async()=>{hub=await FleetHub.open({directory,hosts:[host]});releases.push(hub.journal.retainConnection());return hub;};await open();t.after(async()=>{for(const release of releases)release();assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep+'ARGELLAN-TEST_ONLY-frames-'));await fs.rm(directory,{recursive:true,force:true});});return {get hub(){return hub;},open};}
const at=offset=>new Date(Date.now()+offset).toISOString();
const sessionsOf=hub=>hub.states.get(host.id).sessions;

test('out-of-order bounded session frames keep prior coherent projection until restart-safe completion of 128 logs plus a job',async t=>{
 const f=await fixture(t),baselineAt=at(-2000),observedAt=at(-1000);await f.hub.ingest(key,batch('baseline',baselineAt,[session('baseline')]));const baseline=structuredClone(sessionsOf(f.hub)),rows=Array.from({length:129},(_,i)=>session(i===128?'execution-job':'log-'+i));
 const second=batch('frame-1',observedAt,rows.slice(128),{id:frameId,index:1,count:2});assert.equal((await f.hub.ingest(key,second)).added,1);assert.deepEqual(sessionsOf(f.hub),baseline);assert.deepEqual(f.hub.journal.state(host.id).installationSessionFrames.parts['1'].map(s=>s.id),['execution-job']);
 const saved=f.hub.journal.state(host.id);await f.open();assert.deepEqual(f.hub.states.get(host.id),saved);assert.deepEqual(sessionsOf(f.hub),baseline);
 const first=batch('frame-0',observedAt,rows.slice(0,128),{id:frameId,index:0,count:2});assert.equal((await f.hub.ingest(key,first)).added,1);assert.equal(sessionsOf(f.hub).length,129);assert.deepEqual(sessionsOf(f.hub).map(s=>s.id),rows.map(s=>s.id));assert.equal(f.hub.states.get(host.id).installationSessionObservedAt,observedAt);assert.equal(Object.hasOwn(f.hub.journal.state(host.id),'installationSessionFrames'),false);assert.equal(f.hub.journal.latest().length,3);
 assert.equal((await f.hub.ingest(key,first)).added,0);assert.equal(f.hub.journal.latest().length,3);await f.open();assert.equal(sessionsOf(f.hub).length,129);assert.equal(f.hub.journal.latest().length,3);
});

test('older framed and unframed observations retain events without replacing newer coherent sessions, and newer complete snapshot supersedes fragments',async t=>{
 const f=await fixture(t),times=[at(-5000),at(-4000),at(-3000),at(-2000),at(-1000)];await f.hub.ingest(key,batch('complete-newer',times[2],[session('newer')]));
 await f.hub.ingest(key,batch('old-frame',times[1],[session('older-fragment')],{id:frameId,index:0,count:2}));assert.deepEqual(sessionsOf(f.hub).map(s=>s.id),['newer']);assert.equal(Object.hasOwn(f.hub.states.get(host.id),'installationSessionFrames'),false);
 await f.hub.ingest(key,batch('pending-newer',times[3],[session('pending')],{id:'b'.repeat(64),index:0,count:2}));assert.deepEqual(sessionsOf(f.hub).map(s=>s.id),['newer']);await f.hub.ingest(key,batch('complete-newest',times[4],[session('newest')]));assert.deepEqual(sessionsOf(f.hub).map(s=>s.id),['newest']);assert.equal(Object.hasOwn(f.hub.states.get(host.id),'installationSessionFrames'),false);
 await f.hub.ingest(key,batch('late-pending',times[3],[session('late')],{id:'b'.repeat(64),index:1,count:2}));await f.hub.ingest(key,batch('old-unframed',times[0],[session('oldest')]));assert.deepEqual(sessionsOf(f.hub).map(s=>s.id),['newest']);assert.equal(f.hub.journal.latest().length,6);await f.open();assert.deepEqual(sessionsOf(f.hub).map(s=>s.id),['newest']);
});

test('session frame metadata, repeat-slot conflicts and cross-frame duplicate identities reject atomically without widening the payload allowlist',async t=>{
 const f=await fixture(t),observedAt=at(-1000);await f.hub.ingest(key,batch('baseline',at(-2000),[session('baseline')]));
 const invalid=[{},null,{id:'wrong',index:0,count:2},{id:frameId,index:-1,count:2},{id:frameId,index:2,count:2},{id:frameId,index:0,count:4097},{id:frameId,index:0,count:1.5},{id:frameId,index:0,count:2,secret:'TEST_ONLY forbidden'}];
 for(let i=0;i<invalid.length;i++){const saved=f.hub.journal.state(host.id),events=f.hub.journal.latest(),payload={...batch('invalid-'+i,observedAt,[session('part')]),sessionFrame:invalid[i]};await assert.rejects(f.hub.ingest(key,payload),/Invalid session frame|Unsupported payload field/);assert.deepEqual(f.hub.journal.state(host.id),saved);assert.deepEqual(f.hub.journal.latest(),events);}
 await f.hub.ingest(key,batch('first',observedAt,[session('part')],{id:frameId,index:0,count:2}));
 for(const payload of [batch('bad-count',observedAt,[session('other')],{id:frameId,index:1,count:3}),batch('bad-time',at(0),[session('other')],{id:frameId,index:1,count:2}),batch('bad-slot',observedAt,[session('different')],{id:frameId,index:0,count:2}),batch('duplicate-id',observedAt,[session('part')],{id:frameId,index:1,count:2}),{...batch('bad-allowlist',observedAt,[]),rawOutput:'TEST_ONLY forbidden'}]){const saved=f.hub.journal.state(host.id),events=f.hub.journal.latest();await assert.rejects(f.hub.ingest(key,payload),/session frame|session identity|Unsupported payload field/i);assert.deepEqual(f.hub.journal.state(host.id),saved);assert.deepEqual(f.hub.journal.latest(),events);}
 await assert.rejects(f.hub.ingest(key,batch('oversized',observedAt,Array.from({length:129},(_,i)=>session('too-many-'+i)),{id:frameId,index:1,count:2})),/Batch exceeds limit/);
});

test('framed projection admission respects the existing 2MiB journal state bound and preserves last durable fragment on pressure',async t=>{
 const f=await fixture(t),observedAt=at(-1000);await f.hub.ingest(key,batch('baseline',at(-2000),[session('baseline')]));const fields='project cwd origin provider version parentId agentPath nickname forkedFrom taskLabel taskLabelUpdatedAt state model effort lastEventAt modifiedAt hostName role workerHostId workerCallId'.split(' ').filter(k=>!['taskLabel','taskLabelUpdatedAt'].includes(k));let rejected=false;
 for(let index=0;index<8;index++){const saved=f.hub.journal.state(host.id),events=f.hub.journal.latest(),rows=Array.from({length:128},(_,i)=>({...Object.fromEntries(fields.map(k=>[k,'x'.repeat(k==='cwd'?600:240)])),id:'large-'+index+'-'+i}));try{await f.hub.ingest(key,batch('large-'+index,observedAt,rows,{id:frameId,index,count:8}));}catch(error){assert.match(error.message,/session projection exceeds journal state bound/i);assert.equal(error.status,413);assert.deepEqual(f.hub.journal.state(host.id),saved);assert.deepEqual(f.hub.journal.latest(),events);assert.deepEqual(sessionsOf(f.hub).map(s=>s.id),['baseline']);rejected=true;break;}}
 assert.equal(rejected,true,'large frames must remain pending rather than exceed the unchanged durable journal bound');
});