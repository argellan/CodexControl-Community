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
import crypto from 'node:crypto';
import {SessionReader,summarizeRecords} from '../lib/observer.mjs';
import {FleetHub} from '../lib/fleet.mjs';
import {filterSnapshot,ViewerAccess} from '../lib/viewer-access.mjs';
const labels=await import('../lib/task-labels.mjs').catch(()=>({}));
const timestamp='2026-10-20T12:00:00.000Z';
const row=(id,thread_name,updated_at=timestamp)=>({id,thread_name,updated_at});
const line=value=>JSON.stringify(value)+'\n';
async function fixture(run){const root=await fs.mkdtemp(path.join(os.tmpdir(),'cc-task-label-'));try{await run(root);}finally{await fs.rm(root,{recursive:true,force:true});}}
const reader=options=>{assert.equal(typeof labels.TaskLabelReader,'function');return new labels.TaskLabelReader(options);};
async function source(root,id='worker'){const file=path.join(root,'sessions','2026','10','20','source.jsonl');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,line({type:'session_meta',payload:{id,cwd:'/TEST_ONLY/Example',title:'PRIVATE_META',first_user_message:'PRIVATE_PROMPT'}})+line({type:'event_msg',timestamp,payload:{type:'task_started',message:'PRIVATE_MESSAGE'}}));return file;}

test('index path is derived from the matching sessions root without reaching another Codex home',()=>{
 assert.equal(typeof labels.sessionIndexPath,'function');
 assert.equal(labels.sessionIndexPath('/TEST_ONLY-example/.codex/sessions/2026/10/20/a.jsonl'),'/TEST_ONLY-example/.codex/session_index.jsonl');
 assert.equal(labels.sessionIndexPath('C:\\TEST_ONLY\\.codex\\sessions\\2026\\a.jsonl'),'C:\\TEST_ONLY\\.codex\\session_index.jsonl');
 assert.equal(labels.sessionIndexPath('/tmp/custom-root/a.jsonl'),null);
 assert.equal(labels.sessionIndexPath('/TEST_ONLY-example/.codex/sessions/../outside/a.jsonl'),null);
 assert.equal(labels.sessionIndexPath('/outside/sessions/a.jsonl',{sessionRoot:'/TEST_ONLY-owner/.codex/sessions'}),null);
 assert.equal(labels.sessionIndexPath('/TEST_ONLY-owner/.codex/logs/a.jsonl',{sessionRoot:'/TEST_ONLY-owner/.codex/logs'}),'/TEST_ONLY-owner/.codex/session_index.jsonl');
});

test('only exact observed session IDs receive bounded native title metadata with explicit provenance',()=>fixture(async root=>{
 const file=await source(root),r=reader();await fs.writeFile(path.join(root,'session_index.jsonl'),line(row('worker-extra','Other session'))+line(row('worker','  Update map\nlabels '+ 'x'.repeat(180)+'  ')));
 const value=await r.read(file,'worker');assert.equal(value.taskLabelSource,'codex-session-index');assert.equal(value.taskLabelUpdatedAt,timestamp);assert.equal(value.taskLabel.length,120);assert.ok(value.taskLabel.startsWith('Update maplabels '));
 assert.deepEqual(await r.read(file,'missing'),{taskLabel:null,taskLabelSource:null,taskLabelUpdatedAt:null});
 assert.equal(await r.read(file,'worker-prefix').then(v=>v.taskLabel),null);
}));

test('native metadata cannot fall back to prompt, preview, nested titles or foreign fields',()=>fixture(async root=>{
 const file=await source(root),r=reader();await fs.writeFile(path.join(root,'session_index.jsonl'),line({id:'worker',preview:'PRIVATE_PREVIEW',first_user_message:'PRIVATE_FIRST',title:'PRIVATE_TITLE',updated_at:timestamp})+line({id:'worker',thread_name:{prompt:'PRIVATE_NESTED'},updated_at:timestamp}));
 const value=await r.read(file,'worker');assert.equal(value.taskLabel,null);assert.ok(!JSON.stringify(value).includes('PRIVATE'));
 const summary=await new SessionReader().read(file);assert.equal(summary.taskLabel,null);assert.ok(!JSON.stringify(summary).includes('PRIVATE'));
 const synchronous=summarizeRecords([],{id:'worker',title:'PRIVATE_TITLE',preview:'PRIVATE_PREVIEW'},timestamp,100);assert.equal(synchronous.taskLabel,null);assert.ok(!JSON.stringify(synchronous).includes('PRIVATE'));
}));

test('unchanged native logs receive title refresh through the shared mtime cache without altering events',()=>fixture(async root=>{
 const file=await source(root),index=path.join(root,'session_index.jsonl');let now=0;const taskLabels=reader({now:()=>now,pollMs:1000}),observer=new SessionReader({taskLabels});await fs.writeFile(index,line(row('worker','First assignment')));
 const first=await observer.read(file);assert.equal(first.taskLabel,'First assignment');await fs.writeFile(index,line(row('worker','Second assignment','2026-10-20T12:01:00Z')));
 assert.equal((await observer.read(file)).taskLabel,'First assignment');now=1001;const next=await observer.read(file);assert.equal(next.taskLabel,'Second assignment');assert.deepEqual(next.events,first.events);
}));

test('a cache is isolated to its Codex home and unavailable or removed indexes fail to explicit unknown',()=>fixture(async root=>{
 let now=0;const r=reader({now:()=>now,pollMs:1000}),a=path.join(root,'a'),b=path.join(root,'b'),fileA=await source(a),fileB=await source(b);
 await fs.writeFile(path.join(a,'session_index.jsonl'),line(row('worker','Assignment A')));await fs.writeFile(path.join(b,'session_index.jsonl'),line(row('worker','Assignment B')));
 assert.equal((await r.read(fileA,'worker')).taskLabel,'Assignment A');assert.equal((await r.read(fileB,'worker')).taskLabel,'Assignment B');
 await fs.unlink(path.join(a,'session_index.jsonl'));now=1001;assert.equal((await r.read(fileA,'worker')).taskLabel,null);assert.equal((await r.read(fileB,'worker')).taskLabel,'Assignment B');
}));

test('large indexes use a bounded tail and malformed, oversized or partial records cannot pollute titles',()=>fixture(async root=>{
 const file=await source(root),r=reader({maxBytes:65536});await fs.writeFile(path.join(root,'session_index.jsonl'),line(row('early','Unretained early title'))+' '.repeat(90000)+'\n'+line(row('oversized','x'.repeat(20000)))+'not json\n'+line(row('worker','Bounded final assignment'))+'{"id":"partial","thread_name":"unfinished');
 assert.equal((await r.read(file,'worker')).taskLabel,'Bounded final assignment');assert.equal((await r.read(file,'early')).taskLabel,null);assert.equal((await r.read(file,'oversized')).taskLabel,null);assert.equal((await r.read(file,'partial')).taskLabel,null);
}));

test('newer duplicate index metadata wins and historical lookup excludes later or unknown rename provenance',()=>fixture(async root=>{
 const file=await source(root),r=reader();await fs.writeFile(path.join(root,'session_index.jsonl'),line(row('worker','Later assignment','2026-10-20T12:10:00Z'))+line(row('worker','Older duplicate',timestamp))+line(row('unknown-time','Current label','invalid')));
 assert.equal((await r.read(file,'worker')).taskLabel,'Later assignment');assert.equal((await r.read(file,'worker',{reference:Date.parse('2026-10-20T12:05:00Z')})).taskLabel,null);
 assert.equal((await r.read(file,'worker',{reference:Date.parse('2026-10-20T12:10:00Z')})).taskLabel,'Later assignment');
 const current=await r.read(file,'unknown-time');assert.equal(current.taskLabel,'Current label');assert.equal(current.taskLabelUpdatedAt,null);assert.equal((await r.read(file,'unknown-time',{reference:Date.parse(timestamp)})).taskLabel,null);
}));

test('a newer explicitly cleared title cannot resurrect an older assignment from the index tail',()=>fixture(async root=>{
 const file=await source(root),r=reader();await fs.writeFile(path.join(root,'session_index.jsonl'),line(row('worker','Old assignment',timestamp))+line(row('worker','  ','2026-10-20T12:10:00Z')));
 assert.deepEqual(await r.read(file,'worker'),{taskLabel:null,taskLabelSource:null,taskLabelUpdatedAt:null});
}));

test('fleet transport preserves capped title provenance across persistence and authorized viewer scopes',()=>fixture(async root=>{
 const token='TEST_ONLY_task_label_collector_key',host={id:'source-a',label:'Source A',tokenHash:crypto.createHash('sha256').update(token).digest('hex')};let hub=await FleetHub.open({directory:path.join(root,'hub'),hosts:[host]});
 const sessions=[{id:'visible',project:'Allowed',taskLabel:'x'.repeat(200),taskLabelSource:'codex-session-index',taskLabelUpdatedAt:timestamp},{id:'hidden',project:'Denied',taskLabel:'Hidden assignment',taskLabelSource:'codex-session-index',taskLabelUpdatedAt:timestamp}];
 await hub.ingest(token,{hostId:host.id,batchId:'task-label-batch',observedAt:timestamp,sessions,events:[]});hub=await FleetHub.open({directory:path.join(root,'hub'),hosts:[host]});
 const access=new ViewerAccess({viewers:[{id:'viewer',label:'Viewer',tokenHash:crypto.createHash('sha256').update('TEST_ONLY_viewer').digest('hex'),hostIds:['source-a'],projectIds:['Allowed']}]});
 const snapshot=filterSnapshot(hub.snapshot({sessions:[],events:[],host:{},coverage:{}}),access.authenticateBearer('TEST_ONLY_viewer'));
 assert.equal(snapshot.sessions.length,1);assert.equal(snapshot.sessions[0].taskLabel.length,120);assert.equal(snapshot.sessions[0].taskLabelSource,'codex-session-index');assert.equal(snapshot.sessions[0].taskLabelUpdatedAt,timestamp);assert.ok(!JSON.stringify(snapshot).includes('Hidden assignment'));
 await assert.rejects(hub.ingest(token,{hostId:host.id,batchId:'forged-provenance',observedAt:timestamp,sessions:[{...sessions[0],taskLabelSource:'raw-prompt'}],events:[]}),/task|provenance/i);
}));
