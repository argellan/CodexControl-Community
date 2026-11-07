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
import {summarizeRecords} from '../server.mjs';
import {createServer} from './fixture-server.mjs';

test('native token usage records preserve source time without letting older records roll back a counter',()=>{
 const records=[
  {type:'token_usage_record',timestamp:'2026-01-20T12:00:02Z',payload:{thread_token_usage:{input_tokens:100,output_tokens:20,total_tokens:120}}},
  {type:'token_usage_record',timestamp:'2026-01-20T12:00:01Z',payload:{thread_token_usage:{input_tokens:90,output_tokens:10,total_tokens:100}}},
  {type:'token_usage_record',payload:{thread_token_usage:{input_tokens:99999}}}
 ];
 const s=summarizeRecords(records,{id:'TEST_ONLY usage-source'},'2026-01-20T12:00:03Z',100);
 assert.equal(s.usageObservedAt,'2026-01-20T12:00:02.000Z');assert.equal(s.tokens.total_tokens,120);assert.equal(s.events.length,0);
});

test('observer excludes sensitive payloads and preserves unqualified completion',()=>{
 const s=summarizeRecords([{type:'event_msg',timestamp:'2026-10-19T01:00:00Z',payload:{type:'task_started'}},{type:'response_item',payload:{type:'function_call',name:'exec_command',arguments:'SECRET_PAYLOAD'}},{type:'event_msg',payload:{type:'task_complete',last_agent_message:'PRIVATE_CONTENT'}}],{id:'fixture',cwd:'C:\\TEST_ONLY\\Example'},'2026-10-19T01:00:00Z',100);
 assert.equal(s.project,'Example');assert.equal(s.state,'Turn completed');assert.equal(s.tokens,null);assert.equal(s.tools,1);assert.equal(s.events.at(-1).label,'Turn completed · acceptance unverified');assert.ok(!JSON.stringify(s).includes('SECRET_PAYLOAD'));assert.ok(!JSON.stringify(s).includes('PRIVATE_CONTENT'));
});

test('only a native typed completed ContextCompaction item adds the optional compaction discriminator',()=>{
 const at='2026-10-20T12:00:00Z',native={type:'event_msg',timestamp:at,payload:{type:'item_completed',item:{type:'ContextCompaction',id:'TEST_ONLY-compaction',status:'completed',summary:'PRIVATE_COMPACTION_TEXT'},started_at_ms:Date.parse(at)-500,completed_at_ms:Date.parse(at)}};
 const ordinary={type:'event_msg',timestamp:at,payload:{type:'item_completed',operationType:'context-compaction',item:{type:'CommandExecution',id:'TEST_ONLY-command',status:'completed',label:'Context compaction',aggregated_output:'PRIVATE_COMPACTION_TEXT'}}};
 const output={type:'response_item',timestamp:at,payload:{type:'function_call_output',call_id:'TEST_ONLY-output',operationType:'context-compaction',output:'ContextCompaction PRIVATE_COMPACTION_TEXT'}};
 const result=summarizeRecords([native,ordinary,output],{id:'TEST_ONLY-compaction-session',cwd:'C:\\TEST_ONLY\\Example'},at,100);
 assert.equal(result.events.length,3);const typed=result.events[0];assert.equal(typed.kind,'operation');assert.equal(typed.operationType,'context-compaction');assert.equal(typed.label,'Context compaction');assert.equal(typed.startedAt,'2026-10-20T11:59:59.500Z');assert.equal(typed.completedAt,'2026-10-20T12:00:00.000Z');
 assert.ok(result.events.slice(1).every(e=>!Object.hasOwn(e,'operationType')));assert.ok(!JSON.stringify(result).includes('PRIVATE_COMPACTION_TEXT'));assert.deepEqual(summarizeRecords([native,ordinary,output],{id:'TEST_ONLY-compaction-session',cwd:'C:\\TEST_ONLY\\Example'},at,100).events,result.events);
 const withoutTimes=summarizeRecords([{...native,payload:{type:'item_completed',item:{type:'ContextCompaction',id:'TEST_ONLY-no-clock'}}}],{id:'TEST_ONLY-compaction-session'},at,100).events[0];assert.equal(withoutTimes.operationType,'context-compaction');assert.equal(withoutTimes.startedAt,null);assert.equal(withoutTimes.completedAt,null);assert.equal(withoutTimes.outcome,'recorded');
});
test('local server requires a session cookie and refuses mutations, foreign origins and arbitrary files',async()=>{
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${server.address().port}`,headers={};
 try{
  let r=await fetch(origin+'/api/snapshot',{headers});assert.equal(r.status,401);
  r=await fetch(origin+'/',{headers});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie').split(';')[0];
  r=await fetch(origin+'/api/snapshot',{headers:{...headers,cookie}});assert.equal(r.status,200);const snapshot=await r.json();assert.equal(snapshot.mode,'read-only-log-observer');assert.equal(snapshot.coverage.liveRuntimeAttached,false);assert.ok(snapshot.sessions.length<=128);
  r=await fetch(origin+'/api/snapshot',{method:'POST',headers:{...headers,cookie}});assert.equal(r.status,405);
  r=await fetch(origin+'/api/snapshot',{headers:{...headers,cookie,origin:'https://foreign.invalid'}});assert.equal(r.status,403);
  r=await fetch(origin+'/server.mjs',{headers:{...headers,cookie}});assert.equal(r.status,404);
  const status=await new Promise((resolve,reject)=>{http.get(origin+'/',{headers:{Host:'attacker.invalid'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);});assert.equal(status,403);
 }finally{await new Promise(r=>server.close(r));}
});

test('HTTP fixture servers never read default session roots',async t=>{
 let reads=0;t.mock.method(fs,'readdir',async()=>{reads++;return [];});
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 try{
  const page=await fetch(origin+'/'),cookie=page.headers.get('set-cookie').split(';')[0],response=await fetch(origin+'/api/snapshot',{headers:{cookie}});
  assert.equal(response.status,200);const data=await response.json();
  assert.equal(reads,0,'synthetic HTTP fixtures must not discover local session files');
  assert.equal(data.host.id,'test-only-hub');assert.deepEqual(data.sessions,[]);assert.deepEqual(data.events,[]);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
