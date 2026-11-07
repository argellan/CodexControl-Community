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
import {extractUsageSamples,UsageSourceReader,validateUsageCursor} from '../lib/observer.mjs';

const sourceId='a'.repeat(64),at='2026-10-20T12:00:00.000Z';
const metadata={id:'TEST_ONLY-worker',timestamp:'2026-10-20T12:01:00.000Z',cwd:'/TEST_ONLY/project',model_provider:'openai',cli_version:'TEST_ONLY-version'};
const counters={input_tokens:100,cached_input_tokens:80,cache_write_input_tokens:3,output_tokens:20,reasoning_output_tokens:12,total_tokens:120};
const record={type:'token_usage_record',timestamp:at,payload:{thread_id:'TEST_ONLY-thread',session_id:'TEST_ONLY-native-session',turn_id:'TEST_ONLY-turn',root_turn_id:'TEST_ONLY-root',response_id:'TEST_ONLY-response',usage:counters,turn_token_usage:{...counters,input_tokens:200},thread_token_usage:{...counters,input_tokens:400}}};
const options={metadata,context:{turnId:'TEST_ONLY-context',provider:'openai',model:'configured-model',effort:'high'},sourceId,sourceOffset:1024};

test('native numeric source records retain response, turn and thread scopes with explicit identities',()=>{
 const rows=extractUsageSamples(record,options);assert.deepEqual(rows.map(r=>r.usage_scope),['response','turn-total','thread-total']);
 assert.equal(rows[0].session_id,metadata.id);assert.equal(rows[0].native_session_id,'TEST_ONLY-native-session');assert.equal(rows[0].native_thread_id,'TEST_ONLY-thread');assert.equal(rows[0].native_response_id,'TEST_ONLY-response');
 assert.equal(rows[0].native_turn_id,'TEST_ONLY-turn');assert.equal(rows[0].native_root_turn_id,'TEST_ONLY-root');assert.equal(rows[0].context_turn_id,'TEST_ONLY-context');
 assert.equal(rows[0].reported_mask,63);assert.equal(rows[0].provider_reported_mask,0);assert.equal(rows[0].synthesized_mask,0);assert.equal(rows[0].cache_write_input_tokens,3);assert.equal(rows[0].reasoning_output_tokens,12);
 assert.equal(rows[0].context_model,'configured-model');assert.equal(rows[0].context_effort,'high');assert.equal(rows[0].producing_model,null);assert.equal(rows[0].producing_effort,null);assert.equal(rows[0].context_service_tier,null);
 assert.equal(new Set(rows.map(r=>r.source_record_key)).size,1);assert.match(rows[0].source_record_key,/^[a-f0-9]{64}$/);assert.deepEqual(rows,extractUsageSamples(record,options));
});

test('legacy token-count totals and last-response samples remain separate and do not invent native identities',()=>{
 const rows=extractUsageSamples({type:'event_msg',timestamp:at,payload:{type:'token_count',info:{total_token_usage:counters,last_token_usage:{total_tokens:0}}}},options);
 assert.deepEqual(rows.map(r=>r.usage_scope),['thread-total','last-response']);assert.equal(rows[1].total_tokens,0);assert.equal(rows[1].reported_mask,32);assert.equal(rows[1].input_tokens,null);assert.equal(rows[1].cache_write_input_tokens,null);assert.equal(rows[1].native_response_id,null);assert.equal(rows[1].native_turn_id,null);assert.equal(rows[1].context_turn_id,'TEST_ONLY-context');
});

test('presence masks distinguish missing, observed zero and present invalid numeric evidence',()=>{
 const row=extractUsageSamples({...record,payload:{usage:{input_tokens:0,cached_input_tokens:-1,cache_write_input_tokens:0.5,output_tokens:Number.MAX_SAFE_INTEGER+1,reasoning_output_tokens:'PRIVATE',total_tokens:3}}},options)[0];
 assert.equal(row.reported_mask,63);assert.equal(row.input_tokens,0);assert.equal(row.cached_input_tokens,null);assert.equal(row.cache_write_input_tokens,null);assert.equal(row.output_tokens,null);assert.equal(row.reasoning_output_tokens,null);assert.equal(row.total_tokens,3);
 const inconsistent=extractUsageSamples({...record,payload:{usage:{input_tokens:1,cached_input_tokens:9,output_tokens:2,reasoning_output_tokens:12,total_tokens:4}}},options)[0];
 assert.equal(inconsistent.cached_input_tokens,9);assert.equal(inconsistent.reasoning_output_tokens,12);assert.equal(inconsistent.total_tokens,4,'source inconsistencies remain evidence rather than being repaired');
 assert.ok(!JSON.stringify(row).includes('PRIVATE'));
});

test('fork evidence and unavailable timestamps are retained without fabricating observed time or provider identity',()=>{
 const fork={...options,metadata:{...metadata,forked_from_id:'TEST_ONLY-parent'}};
 const rows=extractUsageSamples(record,fork);assert.equal(rows[0].forked_from_id,'TEST_ONLY-parent');assert.equal(rows[0].inherited_history,1);
 const undated=extractUsageSamples({...record,timestamp:undefined},fork)[0];assert.equal(undated.source_ms,null);assert.equal(undated.time_basis,'receipt');assert.equal(undated.inherited_history,null);
 const preEpoch=extractUsageSamples({...record,timestamp:'1960-01-01T00:00:00Z'},fork)[0];assert.equal(preEpoch.source_ms,null);assert.equal(preEpoch.time_basis,'receipt');
 for(const invalid of ['0','2026-02-30T00:00:00Z','2026-10-20T24:00:00Z'])assert.equal(extractUsageSamples({...record,timestamp:invalid},fork)[0].source_ms,null);
 assert.deepEqual(extractUsageSamples(record,{...options,metadata:{cwd:'/TEST_ONLY'}}),[],'an owning session identity must not be manufactured');
});

test('source identity depends on sanitized source evidence and position, never private text or receipt time',()=>{
 const a=extractUsageSamples({...record,payload:{...record.payload,arguments:'PRIVATE-ARGS',reasoning:'PRIVATE-REASONING',usage_metadata:{secret:'PRIVATE-META'}}},options);
 const b=extractUsageSamples({...record,payload:{...record.payload,arguments:'DIFFERENT-PRIVATE'}},options);
 assert.equal(a[0].source_record_key,b[0].source_record_key);assert.ok(!JSON.stringify(a).includes('PRIVATE'));
 assert.notEqual(a[0].source_record_key,extractUsageSamples(record,{...options,sourceOffset:2048})[0].source_record_key);
});

const line=value=>JSON.stringify(value)+'\n';
async function sourceFixture(run){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-usage-source-TEST_ONLY-')),file=path.join(directory,'source.jsonl');try{return await run(file,directory);}finally{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('cc-usage-source-TEST_ONLY-'));await fs.rm(directory,{recursive:true,force:true});}}
const header=line({type:'session_meta',payload:metadata});
const context=(model,turn)=>({type:'turn_context',payload:{model,effort:'high',turn_id:turn,cwd:'/TEST_ONLY/caf\u00e9'}});

test('durable source cursors preserve byte positions and configuration as of each record across bounded batches and restart',()=>sourceFixture(async file=>{
 const firstContext=line(context('configured-A','turn-A')),first=line(record),secondContext=line(context('configured-B','turn-B')),second=line({...record,payload:{...record.payload,response_id:'TEST_ONLY-response-B'}});
 await fs.writeFile(file,header+firstContext+first+secondContext+second);
 const reader=new UsageSourceReader(),a=await reader.read([file],null,{maxSamples:3});assert.equal(a.usageSamples.length,3);assert.equal(a.coverage.backlogged,true);assert.equal(a.usageSamples[0].source_offset,Buffer.byteLength(header+firstContext));assert.equal(a.usageSamples[0].context_model,'configured-A');
 assert.deepEqual(a.usageSamples,(await reader.read([file],null,{maxSamples:3})).usageSamples,'uncommitted cursor retry must reproduce exact source identities');
 const b=await new UsageSourceReader().read([file],a.nextCursor,{maxSamples:3});assert.equal(b.usageSamples.length,3);assert.equal(b.usageSamples[0].context_model,'configured-B');assert.equal(b.usageSamples[0].context_turn_id,'turn-B');assert.equal(b.usageSamples[0].source_offset,Buffer.byteLength(header+firstContext+first+secondContext));assert.equal(b.coverage.backlogged,false);
 const c=await new UsageSourceReader().read([file],b.nextCursor);assert.deepEqual(c.usageSamples,[]);assert.equal(c.coverage.readBytes,0);assert.deepEqual(validateUsageCursor(c.nextCursor),c.nextCursor);
 assert.ok(!JSON.stringify(c.nextCursor).includes(file),'private checkpoints need no raw path or source-text carry');
}));

test('numeric capture is independent of presentation tails and drains every bounded source record without cap eviction',()=>sourceFixture(async file=>{
 const records=Array.from({length:710},(_,i)=>({...record,payload:{...record.payload,response_id:'TEST_ONLY-response-'+i}}));await fs.writeFile(file,header+records.map(line).join(''));
 let cursor=null,rows=[],iterations=0,backlogged=true;while(backlogged&&iterations++<30){const result=await new UsageSourceReader().read([file],cursor);assert.ok(result.usageSamples.length<=256);assert.ok(result.coverage.readBytes<=4194304);assert.ok(result.coverage.sampleBytes<=524288);rows.push(...result.usageSamples);cursor=result.nextCursor;backlogged=result.coverage.backlogged;}
 assert.equal(backlogged,false);assert.equal(rows.length,2130);assert.equal(new Set(rows.filter(r=>r.usage_scope==='response').map(r=>r.native_response_id)).size,710);assert.equal(new Set(rows.map(r=>r.source_record_key)).size,710);
}));

test('incomplete and malformed lines hold their byte cursor while exposing the source backlog',()=>sourceFixture(async file=>{
 const first=line(record),second=line({...record,payload:{...record.payload,response_id:'TEST_ONLY-after'}});await fs.writeFile(file,header+first+second.slice(0,-10));
 const a=await new UsageSourceReader().read([file],null);assert.equal(a.usageSamples.length,3);assert.equal(a.coverage.incompleteFiles,1);assert.equal(Object.values(a.nextCursor.files)[0].offset,Buffer.byteLength(header+first));
 await fs.appendFile(file,second.slice(-10));const b=await new UsageSourceReader().read([file],a.nextCursor);assert.equal(b.usageSamples.length,3);assert.equal(b.usageSamples[0].native_response_id,'TEST_ONLY-after');
 await fs.appendFile(file,'{"type":"token_usage_record",malformed}\n'+first);const c=await new UsageSourceReader().read([file],b.nextCursor);assert.deepEqual(c.usageSamples,[]);assert.equal(c.coverage.invalidRecords,1);assert.equal(c.coverage.backlogged,true);assert.equal(c.coverage.errors[0].code,'invalid-json-record');assert.equal(Object.values(c.nextCursor.files)[0].offset,Object.values(b.nextCursor.files)[0].offset);
}));

test('oversize and missing-owner source records refuse advancement rather than discarding evidence',()=>sourceFixture(async file=>{
 await fs.writeFile(file,header+'x'.repeat(2097153)+'\n'+line(record));const a=await new UsageSourceReader().read([file],null);assert.deepEqual(a.usageSamples,[]);assert.equal(a.coverage.errors[0].code,'record-size-refused');assert.equal(Object.values(a.nextCursor.files)[0].offset,Buffer.byteLength(header));
 await fs.writeFile(file,line({type:'session_meta',payload:{cwd:'/TEST_ONLY'}})+line(record));const b=await new UsageSourceReader().read([file],null);assert.equal(b.coverage.errors[0].code,'metadata-identity-unavailable');assert.deepEqual(b.nextCursor.files,{});
}));

test('replacement source generations and inherited fork usage retain raw numeric evidence without classifying it as new activity',()=>sourceFixture(async file=>{
 await fs.writeFile(file,header+line(record));const a=await new UsageSourceReader().read([file],null);const forkHeader=line({type:'session_meta',payload:{...metadata,id:'TEST_ONLY-fork',forked_from_id:'TEST_ONLY-parent'}});await fs.writeFile(file,forkHeader+line(record));
 const b=await new UsageSourceReader().read([file],a.nextCursor);assert.equal(b.coverage.resetFiles,1);assert.equal(b.usageSamples.length,3);assert.equal(b.usageSamples[0].session_id,'TEST_ONLY-fork');assert.equal(b.usageSamples[0].inherited_history,1);assert.equal(b.usageSamples[0].input_tokens,100);assert.notEqual(a.usageSamples[0].source_id,b.usageSamples[0].source_id);
}));

test('a new context does not inherit an unreported model, effort or turn identity from an older context',()=>sourceFixture(async file=>{
 await fs.writeFile(file,header+line(context('configured-A','turn-A'))+line(record)+line({type:'turn_context',payload:{cwd:'/TEST_ONLY/new-project'}})+line({...record,payload:{...record.payload,response_id:'TEST_ONLY-unknown-context'}}));
 const capture=await new UsageSourceReader().read([file],null),row=capture.usageSamples.find(r=>r.native_response_id==='TEST_ONLY-unknown-context');assert.equal(row.context_model,null);assert.equal(row.context_effort,null);assert.equal(row.context_turn_id,null);assert.equal(row.project,'new-project');assert.equal(row.native_turn_id,'TEST_ONLY-turn');
}));
