// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildSpans} from '../public/event-model.mjs';
const targets=await import('../lib/targets.mjs').catch(()=>({}));
test('execution-target health does not fabricate Codex sessions or job events',async()=>{
 assert.equal(typeof targets.sampleTarget,'function');const snapshot=await targets.sampleTarget({hostId:'target',services:[]});
 assert.equal(snapshot.sessions.length,0);assert.equal(snapshot.events.length,0);assert.ok(snapshot.host.totalMemory>0);assert.ok(snapshot.host.freeMemory>=0);assert.equal(snapshot.host.id,'target');
});
test('explicit remote job records preserve worker binding, duration, identity and payload boundaries',async()=>{
 assert.equal(typeof targets.readJobFeed,'function');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cc-jobs-')),file=path.join(dir,'jobs.jsonl');
 const common={jobId:'job1',project:'Example project',workerHostId:'test-laptop',workerSessionId:'worker',workerCallId:'call'};
 try{
  await fs.writeFile(file,[{...common,id:'start',type:'job_started',at:'2026-10-19T12:00:00Z',label:'OCR batch'},{...common,id:'end',type:'job_completed',at:'2026-10-19T12:00:03Z'},{...common,id:'bad',type:'job_progress',at:'2026-10-19T12:00:02Z',arguments:'PRIVATE'}].map(r=>JSON.stringify(r)+'\n').join(''));
  const a=await targets.readJobFeed(file,'pi'),b=await targets.readJobFeed(file,'pi');assert.equal(a.events.length,2);assert.equal(a.sessions.length,1);assert.equal(a.sessions[0].role,'execution-job');assert.equal(a.sessions[0].parentId,'worker');assert.equal(a.sessions[0].workerHostId,'test-laptop');assert.equal(a.events[0].workerCallId,'call');assert.equal(a.events[0].projectBasis,'source-context');assert.deepEqual(a.events.map(e=>e.id),b.events.map(e=>e.id));assert.ok(!JSON.stringify(a).includes('PRIVATE'));
  const spans=buildSpans(a.events,Date.parse('2026-10-19T12:00:05Z'));assert.equal(spans.length,1);assert.equal(spans[0].durationMs,3000);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});


test('local job feed rejects inherited and non-string type keys without retaining poisoned events',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cc-job-type-')),file=path.join(dir,'jobs.jsonl'),at=new Date().toISOString();
 try{const rows=['__proto__','constructor','toString',{},null,'job_started'].map((type,i)=>({id:'record-'+i,jobId:'job',type,at}));await fs.writeFile(file,rows.map(r=>JSON.stringify(r)+'\n').join(''));const result=await targets.readJobFeed(file,'fixture');assert.equal(result.invalid,5);assert.equal(result.events.length,1);assert.equal(result.events[0].kind,'remote.start');assert.equal(result.sessions.length,1);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
