// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {sendBatch} from '../collector.mjs';

const execute=promisify(execFile),entry=path.resolve('collector.mjs');
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const at='2026-10-20T12:00:00.000Z';
const record=id=>({type:'token_usage_record',timestamp:at,payload:{thread_id:'TEST_ONLY-thread',turn_id:'TEST_ONLY-turn',root_turn_id:'TEST_ONLY-root',session_id:'TEST_ONLY-native-session',response_id:id,usage:{input_tokens:100,cached_input_tokens:80,cache_write_input_tokens:4,output_tokens:20,reasoning_output_tokens:12,total_tokens:120},turn_token_usage:{total_tokens:120},thread_token_usage:{total_tokens:240}}});
async function fixture(run){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-collector-usage-TEST_ONLY-')),root=path.join(directory,'sessions'),file=path.join(root,'source.jsonl'),configFile=path.join(directory,'collector.json'),batches=[];let mode='success';
 await fs.mkdir(root);await fs.writeFile(file,JSON.stringify({type:'session_meta',payload:{id:'TEST_ONLY-worker',timestamp:at,cwd:'/TEST_ONLY/project',model_provider:'openai'}})+'\n'+JSON.stringify({type:'turn_context',payload:{model:'TEST_ONLY-configured',effort:'high',turn_id:'TEST_ONLY-context'}})+'\n'+JSON.stringify(record('TEST_ONLY-response-1'))+'\n');
 const server=http.createServer((req,res)=>{if(req.url==='/api/identity'){req.resume();res.end(JSON.stringify({deploymentId:'TEST_ONLY-instance',readOnly:true,protocolVersion:1}));return;}let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>{if(req.url!=='/api/collector'){res.writeHead(404);res.end();return;}const body=JSON.parse(text);batches.push(body);if(mode==='refuse'){res.writeHead(503);res.end('TEST_ONLY unavailable');return;}const hash=digest(body.usageSamples);res.end(JSON.stringify({hostId:body.hostId,batchId:body.batchId,added:0,usageSamplesCount:body.usageSamples.length,usageSamplesSha256:mode==='wrong-hash'?'f'.repeat(64):hash}));});});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const config={hostId:'test-source',role:'codex-source',url:`http://127.0.0.1:${server.address().port}`,token:'TEST_ONLY-collector-credential-32-characters',expectedInstanceId:'TEST_ONLY-instance',expectedHostname:os.hostname(),sessionRoot:root};await fs.writeFile(configFile,JSON.stringify(config));
 const once=()=>execute(process.execPath,[entry,configFile,'--once'],{timeout:10000,windowsHide:true});
 try{return await run({directory,file,configFile,config,batches,once,setMode:value=>{mode=value;}});}finally{server.closeAllConnections();await new Promise(r=>server.close(r));assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('cc-collector-usage-TEST_ONLY-'));await fs.rm(directory,{recursive:true,force:true});}
}

test('collector retains exact usage and its private cursor across delivery failure, wrong ACK and process restart',()=>fixture(async({file,configFile,batches,once,setMode})=>{
 const spool=configFile+'.outbox',cursorFile=spool+'.usage-cursor.json';setMode('refuse');await assert.rejects(once(),/503/);const pendingBytes=await fs.readFile(spool,'utf8'),pending=JSON.parse(pendingBytes);assert.equal(pending.version,2);assert.equal(pending.payload.usageSamples.length,3);assert.ok(pending.usageCursor.files);await assert.rejects(fs.access(cursorFile));
 await fs.appendFile(file,JSON.stringify(record('TEST_ONLY-response-2'))+'\n');setMode('wrong-hash');await assert.rejects(once(),/acknowledgement mismatch/);assert.equal(await fs.readFile(spool,'utf8'),pendingBytes);await assert.rejects(fs.access(cursorFile));assert.deepEqual(batches[0],batches[1]);
 setMode('success');await once();await assert.rejects(fs.access(spool));const saved=JSON.parse(await fs.readFile(cursorFile,'utf8'));assert.deepEqual(saved.cursor,pending.usageCursor);assert.deepEqual(batches[2],pending.payload);assert.equal(Object.hasOwn(batches[2],'usageCursor'),false);assert.ok(!JSON.stringify(batches[2]).includes('baseGeneration'));
 await once();assert.equal(batches[3].usageSamples.length,3);assert.equal(batches[3].usageSamples[0].native_response_id,'TEST_ONLY-response-2');assert.notEqual(batches[3].batchId,pending.payload.batchId);assert.notDeepEqual(JSON.parse(await fs.readFile(cursorFile,'utf8')).cursor,pending.usageCursor);
 await once();assert.deepEqual(batches[4].usageSamples,[],'acknowledged sources must not replay usage on every refresh');
}));

test('an already persisted source cursor never suppresses retry of its still-present pending batch after a crash',()=>fixture(async({configFile,batches,once,setMode})=>{
 const spool=configFile+'.outbox';setMode('refuse');await assert.rejects(once());const pending=JSON.parse(await fs.readFile(spool,'utf8'));
 // TEST_ONLY crash point: ACK was accepted and this exact cursor was written,
 // but the process stopped before unlinking the durable pending envelope.
 await fs.writeFile(spool+'.usage-cursor.json',JSON.stringify({version:1,destination:pending.destination,cursor:pending.usageCursor}));setMode('success');await once();assert.deepEqual(batches[1],pending.payload);await assert.rejects(fs.access(spool));
 await once();assert.deepEqual(batches[2].usageSamples,[]);
}));

test('cursor origin or host mismatches refuse use before any credentialed network request and preserve checkpoints',()=>fixture(async({configFile,config,batches,once})=>{
 await once();const cursorFile=configFile+'.outbox.usage-cursor.json',before=await fs.readFile(cursorFile,'utf8'),saved=JSON.parse(before);saved.destination.hostId='different-source';await fs.writeFile(cursorFile,JSON.stringify(saved));const existingCalls=batches.length;await assert.rejects(once(),/destination mismatch/);assert.equal(batches.length,existingCalls);assert.equal(JSON.parse(await fs.readFile(cursorFile,'utf8')).destination.hostId,'different-source');
 await fs.writeFile(cursorFile,before);await fs.writeFile(configFile,JSON.stringify({...config,url:'http://127.0.0.1:1'}));await assert.rejects(once(),/destination mismatch/);assert.equal(await fs.readFile(cursorFile,'utf8'),before);
}));

test('a malformed V2 pending envelope cannot advance a usage cursor without its captured sample array',()=>fixture(async({configFile,batches,once,setMode})=>{
 const spool=configFile+'.outbox';setMode('refuse');await assert.rejects(once());const pending=JSON.parse(await fs.readFile(spool,'utf8'));delete pending.payload.usageSamples;const malformed=JSON.stringify(pending);await fs.writeFile(spool,malformed);const calls=batches.length;setMode('success');await assert.rejects(once(),/usage custody is invalid/);assert.equal(batches.length,calls);assert.equal(await fs.readFile(spool,'utf8'),malformed);await assert.rejects(fs.access(spool+'.usage-cursor.json'));
}));

test('transport requires exact sample count and hash even for an empty array and rejects usage size bounds before HTTP',async()=>{
 const bodies=[],server=http.createServer((req,res)=>{if(req.url==='/api/identity'){req.resume();res.end(JSON.stringify({deploymentId:'TEST_ONLY-instance',readOnly:true,protocolVersion:1}));return;}let text='';req.on('data',c=>text+=c);req.on('end',()=>{const body=JSON.parse(text);bodies.push(body);res.end(JSON.stringify({hostId:body.hostId,batchId:body.batchId,usageSamplesCount:0}));});});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const config={url:`http://127.0.0.1:${server.address().port}`,hostId:'test-source',token:'TEST_ONLY-key',expectedInstanceId:'TEST_ONLY-instance'},body={hostId:'test-source',batchId:'TEST_ONLY-batch',sessions:[],events:[],usageSamples:[]};await assert.rejects(sendBatch(config,body),/acknowledgement mismatch/);assert.equal(bodies.length,1);await assert.rejects(sendBatch(config,{...body,usageSamples:Array.from({length:1001},()=>({}))}),/bound/);assert.equal(bodies.length,1);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
