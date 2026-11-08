// Author: Bishop Crockett; Owner: Argellan.com; License: MIT; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {runCollector} from '../collector.mjs';
import {processDigest} from '../lib/process-history.mjs';
test('synthetic process producer retains exact custody through wrong ACK, reinitialization and crash-after-ACK', async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'argellan-process-spool-'));let wrong=true,capabilities=0;const batches=[];
 const server=http.createServer((req,res)=>{
  if(req.url==='/api/identity'){res.end(JSON.stringify({deploymentId:'TEST_ONLY-process',readOnly:true,protocolVersion:1}));return;}
  if(req.url==='/api/collector/process-capabilities'){capabilities++;res.end(JSON.stringify({processTelemetryV1:true}));return;}
  if(req.url!=='/api/collector'){res.writeHead(404);res.end();return;}
  let text='';req.on('data',c=>text+=c);req.on('end',()=>{const body=JSON.parse(text);batches.push(body);res.end(JSON.stringify({hostId:body.hostId,batchId:body.batchId,added:0,processSamplesCount:body.processSamples?.length,processSamplesSha256:wrong?'bad':processDigest(body.processSamples)}));});
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));const base=await fs.realpath(os.tmpdir()),target=await fs.realpath(directory);assert.ok(target.startsWith(base+path.sep+'argellan-process-spool-'));await fs.rm(target,{recursive:true,force:true});});
 const configFile=path.join(directory,'collector.json'),spool=configFile+'.outbox',staging=spool+'.process.json';
 await fs.writeFile(configFile,JSON.stringify({hostId:'fixture',role:'execution-target',token:'TEST_ONLY_process_collector_credential',url:'http://127.0.0.1:'+server.address().port,expectedHostname:os.hostname(),expectedInstanceId:'TEST_ONLY-process',processTelemetry:{enabled:true}}));
 const sample={epoch:'11111111-1111-4111-8111-111111111111',snapshot:{schemaVersion:1,sourceKind:'local-os',hostId:'fixture',bootId:'TEST_ONLY',sequence:1,observedAt:new Date().toISOString(),collection:{status:'ok',complete:true,scope:'TEST_ONLY'},processes:[{pid:42,createdAt:'2026-01-01T00:00:00Z',executable:'node.exe',role:'Node.js runtime',family:'Codex',metricStatus:'ok'}]}};
 const once=()=>runCollector(configFile,{once:true,processObserverFactory:()=>({poll:async()=>[sample]}),targetSnapshotFactory:()=>({observedAt:new Date().toISOString(),host:{id:'fixture',name:'TEST_ONLY'},sessions:[],events:[],coverage:{synthetic:true}})});
 await assert.rejects(once(),/acknowledgement mismatch/);const original=await fs.readFile(spool),staged=await fs.readFile(staging);assert.ok(batches[0].processSamples[0].snapshot.processes.length>0);assert.equal(capabilities,1);
 await assert.rejects(once(),/acknowledgement mismatch/);assert.deepEqual(await fs.readFile(spool),original);assert.deepEqual(await fs.readFile(staging),staged);assert.equal(capabilities,1,'retry does not resample or discard pending capture');assert.deepEqual(batches[0],batches[1]);
 wrong=false;await once();await assert.rejects(fs.access(spool));await assert.rejects(fs.access(staging));assert.deepEqual(batches[2],batches[0]);
 // Replay the acknowledged main spool to simulate a crash between custody unlink operations.
 await fs.writeFile(spool,original);await once();assert.deepEqual(batches[3],batches[0]);await assert.rejects(fs.access(spool));assert.equal(capabilities,1);
 // A captured frame survives even if the rest of a batch was never created.
 await fs.writeFile(staging,staged);await once();assert.deepEqual(batches[4].processSamples,batches[0].processSamples);assert.equal(capabilities,1);await assert.rejects(fs.access(staging));
});
