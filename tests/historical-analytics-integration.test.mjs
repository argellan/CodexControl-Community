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
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {createServer} from './fixture-server.mjs';
import {normalizeUsageSample} from '../lib/usage-samples.mjs';

const python=process.env.CODEX_ANALYTICS_PYTHON;
const root=fileURLToPath(new URL('../',import.meta.url)),hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const receiverId='11111111-1111-4111-8111-111111111111';
const at='2026-10-22T12:00:00.000Z',now=Date.parse(at);
async function run(script,args,input){
 return new Promise((resolve,reject)=>{
  const child=spawn(python,['-I','-B',path.join(root,'scripts',script),...args],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});let stdout='',stderr='';
  const timer=setTimeout(()=>{child.kill();reject(new Error('TEST_ONLY engine deadline'));},30000);
  child.on('error',reject);child.stdin.on('error',()=>{});child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>262144)child.kill();});child.stderr.on('data',chunk=>{stderr+=chunk;if(Buffer.byteLength(stderr)>16384)child.kill();});
  child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});child.stdin.end(input);
 });
}

test('actual receiver and DuckDB reports cross the authenticated HTTP boundary with source filtering and null/conflict semantics',{skip:!python},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-analytics-integration-TEST_ONLY-'));let server;
 t.after(async()=>{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('cc-analytics-integration-TEST_ONLY-'));await fs.rm(directory,{recursive:true,force:true});});
 const cold=path.join(directory,'cold'),catalog=path.join(directory,'catalog'),receiverConfig=path.join(directory,'receiver.json'),engineConfig=path.join(directory,'analytics.json');
 await fs.writeFile(receiverConfig,JSON.stringify({receiverId,archiveDirectory:cold,catalogDirectory:catalog}),{mode:0o600});
 await fs.writeFile(engineConfig,JSON.stringify({version:1,receiverConfig,databaseDirectory:path.join(directory,'engine'),queryTimeoutSeconds:15}),{mode:0o600});
 let seq=0;const wrap=(table,row,key,version=1)=>({version,itemId:hash('TEST_ONLY'+(++seq)),sequence:seq,table,rowKey:key,recordedAt:at,row});
 const records=['test-source','test-disabled'].map(host=>{const row=normalizeUsageSample({session_id:'TEST_ONLY_session',source_record_key:hash(host),source_kind:'token_usage_record',usage_scope:'response',source_ms:now,time_basis:'source',project:'TEST_ONLY_project',native_thread_id:'TEST_ONLY_thread',native_turn_id:'TEST_ONLY_turn',native_response_id:'TEST_ONLY_response',input_tokens:100,cached_input_tokens:25,output_tokens:20,total_tokens:120,reported_mask:43,provider_reported_mask:43,synthesized_mask:0},{hostId:host,receivedMs:now,sourceRole:'codex-source'});return wrap('usage_samples_v2',row,{sample_key:row.sample_key},2);});
 const row={host_id:'test-source',session_id:'TEST_ONLY_session',segment_key:hash(JSON.stringify(['TEST_ONLY_project','openai',null])),project:'TEST_ONLY_project',provider:'openai',model:null,day:'2026-10-22',input_tokens:100,cached_input_tokens:25,uncached_input_tokens:75,output_tokens:20,total_tokens:120,observations:1,partial_observations:0,overflow:0,first_ms:now,last_ms:now};
 const key=Object.fromEntries(['host_id','session_id','day','segment_key'].map(k=>[k,row[k]]));records.push(wrap('usage_daily',row,key),wrap('usage_daily',{...row,input_tokens:101,uncached_input_tokens:76,total_tokens:121},key));
 const received=await run('archive-receiver.py',['--config',receiverConfig],gzipSync(Buffer.from(records.map(r=>JSON.stringify(r)).join('\n')+'\n')));assert.equal(received.code,0,received.stderr);
 const catalogHash=hash(await fs.readFile(path.join(catalog,'catalog.sqlite')));
 const projected=await run('archive-analytics.py',['--config',engineConfig,'--sync','--limit','2']);assert.equal(projected.code,0,projected.stderr);
 const ownerToken='TEST_ONLY_owner_key',scopedToken='TEST_ONLY_scoped_key',hosts=[{id:'test-source',role:'codex-source',tokenHash:hash('TEST_ONLY_collector')},{id:'test-disabled',role:'codex-source',disabled:true,tokenHash:hash('TEST_ONLY_disabled')}];
 let engineCalls=0;
 server=createServer({hub:{hosts},viewers:[{id:'owner',label:'TEST_ONLY owner',role:'admin',hostIds:null,projectIds:null,tokenHash:hash(ownerToken)},{id:'scoped',label:'TEST_ONLY scoped',role:'viewer',hostIds:['test-source'],projectIds:null,tokenHash:hash(scopedToken)}],historicalAnalytics:{version:1,engine:'duckdb',expectedReceiverId:receiverId,ssh:{executable:process.execPath,identityFile:receiverConfig,knownHostsFile:engineConfig,host:'test-only.invalid',user:'testonly'},minIntervalMs:250},historicalAnalyticsDependencies:{now:()=>performance.now()*1000,checkFiles:async()=>{},transport:async({request})=>{engineCalls++;assert.deepEqual(request.allowedHostIds,['test-source']);const result=await run('archive-analytics.py',['--config',engineConfig,'--query'],JSON.stringify(request));assert.equal(result.code,0,result.stderr);return result.stdout;}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/api/analytics/history?fromDay=2026-10-22&toDay=2026-10-22`;
 assert.equal((await fetch(base+'&report=responses')).status,401);assert.equal((await fetch(base+'&report=responses',{headers:{Authorization:'Bearer '+scopedToken}})).status,403);assert.equal(engineCalls,0);
 const response=await fetch(base+'&report=responses',{headers:{Authorization:'Bearer '+ownerToken}});assert.equal(response.status,200,await response.clone().text());const body=await response.json();assert.equal(body.rows.length,1);assert.equal(body.rows[0].hostId,'test-source');assert.equal(body.rows[0].responseCount,1);assert.equal(body.rows[0].totals.input,'100');assert.equal(body.rows[0].totals.reasoning,null);assert.equal(body.rows[0].ratios.cacheHit,0.25);assert.equal(body.rows[0].ratioCoverage.cacheHit.denominator,'100');assert.equal(body.coverage.completeHistory,false);
 const daily=await fetch(base+'&report=daily&source=session-deltas',{headers:{Authorization:'Bearer '+ownerToken}});assert.equal(daily.status,200,await daily.clone().text());const dailyBody=await daily.json();assert.equal(dailyBody.coverage.conflictRows,1);assert.equal(dailyBody.rows[0].records,0);assert.equal(dailyBody.rows[0].values.total,null);
 assert.equal(hash(await fs.readFile(path.join(catalog,'catalog.sqlite'))),catalogHash);const verified=await run('archive-receiver.py',['--config',receiverConfig,'--verify']);assert.equal(verified.code,0,verified.stderr);assert.equal(JSON.parse(verified.stdout).distinctItems,4);
 // The actual engine/HTTP path is qualified here. The controlled subprocess
 // bridge replaces SSH only; this test does not claim a deployed forced key.
});
