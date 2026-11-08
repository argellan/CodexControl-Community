// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {createServer} from './fixture-server.mjs';
import {FleetHub} from '../lib/fleet.mjs';
import {decodeUsageRecords} from '../public/usage-workspace-model.mjs';
import {REPRESENTATION_LIMITS} from '../lib/http-representation.mjs';

const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function get(port,route){return new Promise((resolve,reject)=>{
 const request=http.get({host:'127.0.0.1',port,path:route,headers:{authorization:'Bearer TEST_ONLY_owner','accept-encoding':'gzip'}},response=>{
  const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));response.on('error',reject);
 });request.on('error',reject);
});}

test('5,000 exact responses use bounded gzip and decode to the unchanged authorized evidence',async(t)=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-usage-series-TEST_ONLY-'));let hub,server;
 const host={id:'test-only-host',label:'TEST_ONLY',tokenHash:digest('TEST_ONLY_collector')};
 const viewers=[{id:'owner',username:'owner',label:'TEST_ONLY owner',role:'admin',hostIds:null,projectIds:null,tokenHash:digest('TEST_ONLY_owner')}];
 try{
  hub=await FleetHub.open({directory,hosts:[host]});const now=Date.now(),at=new Date(now).toISOString();
  const samples=Array.from({length:5000},(_,i)=>{const input=1000+i*20,output=200+i*3;return {session_id:'TEST_ONLY_worker_'+i%12,source_id:digest('TEST_ONLY_source'),source_record_key:digest('TEST_ONLY_record_'+i),source_offset:i,source_kind:'token_usage_record',source_version:'TEST_ONLY',usage_scope:'response',source_ms:now-i*1000,time_basis:'source',project:'TEST_ONLY_Project_'+i%3,native_thread_id:'TEST_ONLY_thread_'+i%12,native_turn_id:'TEST_ONLY_turn_'+i,native_response_id:'TEST_ONLY_response_'+i,context_model:'TEST_ONLY_configured_model',context_effort:'high',input_tokens:input,cached_input_tokens:400+i*5,cache_write_input_tokens:0,output_tokens:output,reasoning_output_tokens:Math.floor(output/3),total_tokens:input+output,reported_mask:63,provider_reported_mask:63,synthesized_mask:0};});
  for(let i=0;i<samples.length;i+=1000)await hub.ingest('TEST_ONLY_collector',{hostId:host.id,batchId:'test-batch-'+i,observedAt:at,sessions:[],events:[],usageSamples:samples.slice(i,i+1000)});
  server=createServer({hub,viewers});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
  const beforeMemory=process.memoryUsage(),legacyStart=performance.now();const legacy=await get(port,'/api/account/usage?details=1&series=1&period=24h');const legacyElapsed=performance.now()-legacyStart;assert.equal(legacy.status,200);assert.equal(legacy.headers['content-encoding'],undefined);assert.ok(legacy.body.length>REPRESENTATION_LIMITS.maxInputBytes);
  const compactStart=performance.now();const compact=await get(port,'/api/account/usage?details=1&series=1&seriesFormat=columns-v1&period=24h');const compactElapsed=performance.now()-compactStart;assert.equal(compact.status,200);assert.equal(compact.headers['content-encoding'],'gzip');assert.ok(compact.body.length<legacy.body.length*.4);
  const uncompressed=gunzipSync(compact.body);t.diagnostic(JSON.stringify({synthetic:true,rows:5000,legacyWireBytes:legacy.body.length,compactWireBytes:compact.body.length,compactJsonBytes:uncompressed.length,legacyElapsedMs:legacyElapsed,compactElapsedMs:compactElapsed,rssBefore:beforeMemory.rss,rssAfter:process.memoryUsage().rss}));const before=JSON.parse(legacy.body),after=JSON.parse(uncompressed);assert.equal(before.sampleAnalytics.responses.records.length,5000);assert.equal(after.sampleAnalytics.coverage.returnedRows,5000);
  assert.deepEqual(decodeUsageRecords(after.sampleAnalytics.responses.records),before.sampleAnalytics.responses.records);
 }finally{
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(hub){await hub.queue;await hub.writerClosing;}
  const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('cc-usage-series-TEST_ONLY-'));await fs.rm(resolved,{recursive:true,force:true});
 }
});

test('compact transport rejects malformed column order, value and excessive row count',()=>{
 const columns=['sampleKey','hostId','sessionId','project','sourceId','sourceRecordKey','sourceOffset','sourceKind','sourceVersion','turnId','responseId','sourceAt','receivedAt','timeBasis','accountAttribution','configuredModel','configuredEffort','input','cached','cacheWrite','output','reasoning','total','reportedMask','providerReportedMask','synthesizedMask'];
 const row=['sample','host','worker','Project λ','source','record',0,'token_usage_record',null,'turn','response',null,'2026-11-07T00:00:00.000Z','receipt','unknown',null,null,0,0,null,0,null,0,35,35,0];
 const wire={schema:'usage-response-columns-v1',columns,rows:[row]};const decoded=decodeUsageRecords(wire);assert.equal(decoded[0].project,'Project λ');assert.equal(decoded[0].sourceAt,null);assert.equal(decoded[0].sourceOffset,0);
 assert.throws(()=>decodeUsageRecords({...wire,columns:[...columns].reverse()}));assert.throws(()=>decodeUsageRecords({...wire,rows:[row.slice(1)]}));assert.throws(()=>decodeUsageRecords({...wire,rows:[row.map((v,i)=>i===17?Number.MAX_SAFE_INTEGER+1:v)]}));assert.throws(()=>decodeUsageRecords({...wire,rows:Array(5001).fill(row)}));
});
