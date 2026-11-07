// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {gzipSync,gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {USAGE_SAMPLE_COLUMNS,USAGE_SAMPLE_SOURCE_COLUMNS,normalizeUsageSample,usageSampleKey,validateUsageSampleRow} from '../lib/usage-samples.mjs';

const script=fileURLToPath(new URL('../scripts/archive-receiver.py',import.meta.url));
const PYTHON=process.env.CODEX_TEST_PYTHON||(process.platform==='win32'?'python':'python3');
const receiverId='1c8391d1-13a6-4c56-91bf-d51c47954455',at='2026-10-20T12:00:00.000Z',now=Date.parse(at);
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
// Independent JS fixture intentionally does not import the Python validator or
// hub implementation: it qualifies canonical hashing across both languages.
const columns=`sample_key host_id session_id source_id source_record_key source_offset source_kind source_version
usage_scope source_ms received_ms time_basis project
native_thread_id native_session_id native_turn_id native_root_turn_id native_response_id provider_account_key
context_turn_id context_provider context_model context_effort context_service_tier context_speed
producing_provider producing_model producing_effort producing_service_tier producing_speed
forked_from_id inherited_history source_role accounting_class
input_tokens cached_input_tokens cache_write_input_tokens output_tokens reasoning_output_tokens total_tokens
reported_mask provider_reported_mask synthesized_mask`.split(/\s+/);
const sample=(extra={})=>{
 const value={...Object.fromEntries(columns.map(key=>[key,null])),host_id:'TEST_ONLY_laptop',session_id:'TEST_ONLY_session',source_id:digest('TEST_ONLY_source'),source_record_key:digest('TEST_ONLY_source_record'),source_offset:1024,source_kind:'token_usage_record',source_version:'TEST_ONLY_1',usage_scope:'response',source_ms:now,received_ms:now,time_basis:'source',project:'TEST_ONLY_Argellán 🧭 \u2028',native_thread_id:'TEST_ONLY_thread',native_turn_id:'TEST_ONLY_turn',native_response_id:'TEST_ONLY_response',context_model:'TEST_ONLY_configured_model',context_provider:'openai',context_effort:'high',inherited_history:0,source_role:'codex-source',accounting_class:'candidate',input_tokens:100,cached_input_tokens:20,cache_write_input_tokens:3,output_tokens:10,reasoning_output_tokens:4,total_tokens:110,reported_mask:63,provider_reported_mask:0,synthesized_mask:0,...extra};
 value.sample_key=digest(JSON.stringify(columns.filter(key=>key!=='sample_key'&&key!=='received_ms').map(key=>value[key])));
 return value;
};
const record=(sequence=1,extra={})=>{const row=sample(extra);return {version:2,itemId:digest('TEST_ONLY_v2_'+sequence),sequence,table:'usage_samples_v2',rowKey:{sample_key:row.sample_key},recordedAt:at,row};};
const legacy=(sequence=100)=>({version:1,itemId:digest('TEST_ONLY_v1_'+sequence),sequence,table:'usage_observations',rowKey:{sequence},recordedAt:at,row:{sequence,host_id:'TEST_ONLY_laptop',session_id:'TEST_ONLY_session',project:'TEST_ONLY_project',provider:'openai',model:'gpt-test',source_ms:now,received_ms:now,interval_ms:null,status:'baseline',input_tokens:100,cached_input_tokens:20,output_tokens:10,total_tokens:110,delta_input:null,delta_cached:null,delta_uncached:null,delta_output:null,delta_total:null}});
const encode=records=>Buffer.from(records.map(value=>JSON.stringify(value)).join('\n')+'\n');
const launch=(config,input=Buffer.alloc(0),args=[])=>new Promise((resolve,reject)=>{
 const child=spawn(PYTHON,[script,'--config',config,...args],{stdio:['pipe','pipe','pipe'],windowsHide:true});let stdout='',stderr='';
 child.on('error',reject);child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('close',code=>resolve({code,stdout,stderr,json:()=>JSON.parse(stdout)}));child.stdin.on('error',()=>{});child.stdin.end(input);
});
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'codex-archive-v2-TEST_ONLY-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const archiveDirectory=path.join(directory,'cold'),catalogDirectory=path.join(directory,'catalog'),config=path.join(directory,'receiver.json');
 await fs.writeFile(config,JSON.stringify({archiveDirectory,catalogDirectory,receiverId}),{mode:0o600});
 return {directory,archiveDirectory,catalogDirectory,config,run:(records,args=[])=>launch(config,gzipSync(encode(records)),args)};
}

test('mixed V1/V2 batches retain exact bytes, V1 receipt/manifest contracts and all four independent usage scopes',async t=>{
 const f=await fixture(t),scopes=['thread-total','last-response','response','turn-total'];
 const records=[legacy(),...scopes.map((usage_scope,i)=>record(i+1,{usage_scope,source_kind:i===1?'token_count':'token_usage_record'}))];
 assert.equal(columns.length,43);assert.equal(new Set(columns).size,43);
 const raw=encode(records),compressed=gzipSync(raw),result=await launch(f.config,compressed);assert.equal(result.code,0,result.stderr);
 const ack=result.json();assert.equal(ack.version,1);assert.equal(ack.durable,true);assert.equal(ack.receiverId,receiverId);assert.equal(ack.batchId,digest(raw));assert.equal(ack.rawSha256,digest(raw));assert.equal(ack.records,5);assert.deepEqual(ack.itemIds,records.map(r=>r.itemId));
 const stored=await fs.readFile(path.join(f.archiveDirectory,ack.segment));assert.deepEqual(stored,compressed);assert.deepEqual(gunzipSync(stored),raw);
 const manifest=JSON.parse(await fs.readFile(path.join(f.archiveDirectory,ack.segment.replace(/\.gz$/,'.manifest.json')),'utf8'));
 assert.deepEqual(Object.keys(manifest).sort(),['version','rawSha256','compressedSha256','records','rawBytes','compressedBytes','firstRecordedMs','lastRecordedMs','itemIds'].sort());assert.equal(manifest.version,1);assert.equal(manifest.rawSha256,digest(raw));assert.deepEqual(manifest.itemIds,ack.itemIds);
 const exported=await launch(f.config,undefined,['--query']);assert.equal(exported.code,0,exported.stderr);assert.equal(exported.stdout,raw.toString());assert.equal((await launch(f.config,undefined,['--verify'])).json().verified,true);
});

test('V2 preserves partials, reported zeros, excluded lineage and safe inconsistent numbers without fabricating production attribution',async t=>{
 const f=await fixture(t),records=[
  record(1,{input_tokens:null,cached_input_tokens:null,cache_write_input_tokens:null,output_tokens:0,reasoning_output_tokens:null,total_tokens:null,reported_mask:9,provider_reported_mask:8,source_ms:null,time_basis:'receipt',source_id:null,source_offset:null,native_thread_id:null,native_turn_id:null,native_response_id:null}),
  record(2,{accounting_class:'fork-excluded',forked_from_id:'TEST_ONLY_parent',inherited_history:1,cached_input_tokens:200,reasoning_output_tokens:30}),
  record(3,{source_role:'execution-target',accounting_class:'execution-excluded',source_version:null,provider_reported_mask:3,synthesized_mask:4}),
  record(4,{input_tokens:null,cached_input_tokens:null,cache_write_input_tokens:null,output_tokens:null,reasoning_output_tokens:null,total_tokens:null,reported_mask:63})
 ];
 const accepted=await f.run(records);assert.equal(accepted.code,0,accepted.stderr);
 const exported=await launch(f.config,undefined,['--query','--table','usage_samples_v2']);assert.equal(exported.stdout,encode(records).toString());
 for(const r of exported.stdout.trim().split('\n').map(JSON.parse))for(const key of columns.filter(key=>key.startsWith('producing_')))assert.equal(r.row[key],null);
 assert.equal(sample().sample_key,sample({received_ms:now+5000}).sample_key,'receipt time is not part of semantic sample identity');
 assert.notEqual(sample().sample_key,sample({reasoning_output_tokens:5}).sample_key);
});

test('hub normalizer and Python share the exact sample schema/hash and derive exclusion classes identically',async t=>{
 const f=await fixture(t);assert.deepEqual([...USAGE_SAMPLE_COLUMNS],columns);
 const variants=[
  {role:'codex-source',extra:{}},
  {role:'codex-source',extra:{forked_from_id:'TEST_ONLY_parent'}},
  {role:'unknown',extra:{inherited_history:1}},
  {role:'execution-target',extra:{forked_from_id:'TEST_ONLY_parent'}},
  {role:'execution-job',extra:{}},
  {role:'unknown',extra:{}}
 ];
 const records=variants.map(({role,extra},i)=>{
  const source=sample(extra),input=Object.fromEntries(USAGE_SAMPLE_SOURCE_COLUMNS.map(key=>[key,source[key]]));
  const row=normalizeUsageSample(input,{hostId:source.host_id,receivedMs:source.received_ms,sourceRole:role});
  assert.equal(row.sample_key,usageSampleKey(row));assert.equal(validateUsageSampleRow(row),row);
  return {...record(i+1),row,rowKey:{sample_key:row.sample_key}};
 });
 const accepted=await f.run(records);assert.equal(accepted.code,0,accepted.stderr);assert.equal((await launch(f.config,undefined,['--query'])).stdout,encode(records).toString());
 for(const original of records){
  const row={...original.row,accounting_class:original.row.accounting_class==='candidate'?'unknown':'candidate'};row.sample_key=usageSampleKey(row);
  assert.throws(()=>validateUsageSampleRow(row),/Invalid usage sample/);
  const denied=await f.run([{...original,itemId:digest(original.itemId+'invalid-class'),row,rowKey:{sample_key:row.sample_key}}]);assert.notEqual(denied.code,0);assert.equal(denied.stdout,'');
 }
});

test('V2 rejects version/table confusion, unknown/private fields, malformed identity, unsupported dimensions and numeric provenance',async t=>{
 const f=await fixture(t),secret='TEST_ONLY_private_must_not_echo';
 const invalid=[
  {...record(),version:1}, {...legacy(),version:2}, {...record(),version:3}, {...record(),version:true}, {...record(),table:'usage_unknown'},
  {...record(),password:secret}, {...record(),row:{...sample(),prompt:secret}}, {...record(),row:{...sample(),reasoning:secret}},
  {...record(),rowKey:{sample_key:'a'.repeat(64)}}, {...record(),rowKey:{sample_key:sample().sample_key,extra:secret}},
  {...record(),row:{...sample(),sample_key:'a'.repeat(64)}}, {...record(),row:Object.fromEntries(Object.entries(sample()).filter(([key])=>key!=='context_effort'))},
  ...[
   {source_kind:'unknown'}, {source_kind:'app-server'}, {source_id:'not-a-digest'}, {source_record_key:'not-a-digest'}, {provider_account_key:'not-a-digest'},
   {source_offset:-1}, {source_offset:9007199254740992}, {source_offset:true}, {source_ms:8640000000000001}, {received_ms:null}, {received_ms:true},
   {time_basis:'received'}, {source_ms:null,time_basis:'source'}, {time_basis:'receipt'}, {source_version:'x'.repeat(129)},
   {usage_scope:'all'}, {source_role:'server'}, {accounting_class:'included'}, {inherited_history:true}, {inherited_history:2},
   {context_model:'x'.repeat(129)}, {context_effort:'x'.repeat(65)}, {context_service_tier:'x'.repeat(65)}, {context_speed:'x'.repeat(65)},
   {native_response_id:'x'.repeat(257)}, {native_turn_id:'bad\u0000id'}, {project:'bad\ud800'},
   {producing_model:'TEST_ONLY_unqualified'}, {producing_effort:'high'}, {producing_provider:'openai'}, {producing_service_tier:'priority'}, {producing_speed:'fast'},
   {input_tokens:-1}, {reasoning_output_tokens:true}, {cache_write_input_tokens:0.5}, {total_tokens:9007199254740992},
   {reported_mask:64}, {reported_mask:true}, {provider_reported_mask:64}, {synthesized_mask:64},
   {reported_mask:1,provider_reported_mask:2,cached_input_tokens:null,cache_write_input_tokens:null,output_tokens:null,reasoning_output_tokens:null,total_tokens:null},
   {provider_reported_mask:1,synthesized_mask:1}, {reported_mask:0}
  ].map(extra=>record(1,extra))
 ];
 for(const [i,value] of invalid.entries()){
  const result=await f.run([value]);assert.notEqual(result.code,0,'accepted invalid case '+i);assert.equal(result.stdout,'');assert.equal(JSON.parse(result.stderr).durable,false);assert.ok(!result.stderr.includes(secret));
 }
 assert.deepEqual(await fs.readdir(f.archiveDirectory),[],'invalid rows must not publish a segment');
 assert.equal(await fs.stat(path.join(f.catalogDirectory,'catalog.sqlite')).then(()=>true,()=>false),false,'invalid rows must not enter the catalog');
});

test('V2 semantic corrections are new evidence while changed bytes under an existing item ID refuse the whole batch',async t=>{
 const f=await fixture(t),first=record(),accepted=await f.run([legacy(),first]);assert.equal(accepted.code,0,accepted.stderr);
 const changed=record(1,{reasoning_output_tokens:5}),denied=await f.run([record(2),changed]);assert.notEqual(denied.code,0);assert.equal(denied.stdout,'');assert.match(denied.stderr,/Conflicting archive item/);
 assert.equal((await launch(f.config,undefined,['--status'])).json().items,2);
 changed.itemId=digest('TEST_ONLY_corrected_source_item');const corrected=await f.run([changed]);assert.equal(corrected.code,0,corrected.stderr);
 const query=await launch(f.config,undefined,['--query','--table','usage_samples_v2']);assert.equal(query.stdout,encode([first,changed]).toString());
});

test('mixed lost-ACK/gzip retry and catalog rebuild keep old and new immutable segments and exact query results',async t=>{
 const f=await fixture(t),old=[legacy()],oldAck=(await f.run(old)).json(),oldBytes=await fs.readFile(path.join(f.archiveDirectory,oldAck.segment));
 const label="TEST_ONLY_'; DROP TABLE items; --",records=[record(1,{project:label}),legacy(101),record(2,{host_id:'TEST_ONLY_other'})],raw=encode(records),compressed=gzipSync(raw);
 const first=(await launch(f.config,compressed)).json(),different=Buffer.from(compressed);different[4]=1;
 const retry=await launch(f.config,different);assert.equal(retry.code,0,retry.stderr);assert.equal(retry.json().compressedSha256,first.compressedSha256);assert.equal(retry.json().receivedCompressedSha256,digest(different));assert.deepEqual(retry.json().itemIds,first.itemIds);
 assert.deepEqual(await fs.readFile(path.join(f.archiveDirectory,oldAck.segment)),oldBytes);
 await fs.rm(path.join(f.catalogDirectory,'catalog.sqlite'));
 const rebuilt=await launch(f.config,undefined,['--rebuild']);assert.equal(rebuilt.code,0,rebuilt.stderr);assert.equal(rebuilt.json().distinctItems,4);assert.equal(rebuilt.json().segments,2);assert.equal((await launch(f.config,undefined,['--verify'])).json().verified,true);
 const query=await launch(f.config,undefined,['--query','--table','usage_samples_v2','--host','TEST_ONLY_laptop','--project',label,'--limit','1']);assert.equal(query.code,0,query.stderr);assert.equal(query.stdout,encode([records[0]]).toString());
 const all=await launch(f.config,undefined,['--query']);assert.deepEqual(all.stdout.trim().split('\n').map(JSON.parse).map(r=>r.itemId).sort(),[...old,...records].map(r=>r.itemId).sort());
 const repeated=await launch(f.config,different);assert.equal(repeated.code,0,repeated.stderr);assert.equal(repeated.json().rawSha256,first.rawSha256);assert.equal((await launch(f.config,undefined,['--status'])).json().items,4);
});

test('V2 cold-file publication before manifest/catalog commit recovers without replacing bytes',async t=>{
 const f=await fixture(t),records=[legacy(),record()],first=(await f.run(records)).json(),target=path.join(f.archiveDirectory,first.segment),before=await fs.readFile(target);
 await fs.rm(target.replace(/\.gz$/,'.manifest.json'));await fs.rm(path.join(f.catalogDirectory,'catalog.sqlite'));
 const retry=await f.run(records);assert.equal(retry.code,0,retry.stderr);assert.equal(retry.json().batchId,first.batchId);assert.deepEqual(await fs.readFile(target),before);assert.equal((await launch(f.config,undefined,['--verify'])).json().verified,true);
});

test('Timescale V2 template is additive and typed, preserving the legacy source-table contract and independent scopes',async()=>{
 const sql=await fs.readFile(new URL('../scripts/archive-timescale.sql',import.meta.url),'utf8');
 assert.match(sql,/CREATE TABLE IF NOT EXISTS codexcontrol_archive\.usage_sample_versions_v2/);
 assert.match(sql,/source_table text NOT NULL CHECK\(source_table IN \('usage_baselines','usage_observations','usage_daily','account_usage_observations','account_usage_daily'\)\)/);
 assert.match(sql,/record->>'version'='2' AND record->>'table'='usage_samples_v2'/);
 assert.match(sql,/IF record->>'version'='1' THEN\s+INSERT INTO codexcontrol_archive\.usage_versions/);
 assert.match(sql,/ELSE\s+INSERT INTO codexcontrol_archive\.usage_sample_versions_v2/);
 for(const field of ['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'])assert.match(sql,new RegExp(field+' bigint CHECK\\('+field+' BETWEEN 0 AND 9007199254740991\\)'));
 assert.match(sql,/usage_scope IN \('thread-total','last-response','response','turn-total'\)/);
 assert.match(sql,/sample_key text NOT NULL CHECK/);assert.match(sql,/row_data jsonb NOT NULL/);
 assert.doesNotMatch(sql,/\b(?:add_retention_policy|drop_chunks|DELETE FROM|TRUNCATE)\b/i);
 assert.doesNotMatch(sql,/ALTER TABLE codexcontrol_archive\.usage_versions (?:ADD|DROP|RENAME)/i);
});
