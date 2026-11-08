// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';

test('a sample completing during graceful shutdown is committed before close',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ARGELLAN-TEST_ONLY-process-shutdown-'));
 t.after(async()=>{const base=await fs.realpath(os.tmpdir()),target=await fs.realpath(root);assert.ok(target.startsWith(base+path.sep+'ARGELLAN-TEST_ONLY-process-shutdown-'));await fs.rm(target,{recursive:true,force:true});});
 const server=pathToFileURL(path.resolve(import.meta.dirname,'../server.mjs')).href,history=pathToFileURL(path.resolve(import.meta.dirname,'../lib/history.mjs')).href;
 const script=`
  import assert from 'node:assert/strict';import http from 'node:http';
  import {startRuntime} from ${JSON.stringify(server)};import {HistoryJournal} from ${JSON.stringify(history)};
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  let finishPoll;const pending=new Promise(r=>{finishPoll=r;});
  const runtime=await startRuntime({dataDirectory:process.env.TEST_DIRECTORY,listen:'127.0.0.1',port,instanceId:'TEST_ONLY',processTelemetry:{enabled:true},installationNetwork:{listen:'127.0.0.1',port:0,discovery:false}},{processObserverFactory:()=>({poll:()=>pending})});
  const closing=new Promise((resolve,reject)=>runtime.server.close(error=>error?reject(error):resolve()));
  finishPoll([{epoch:'11111111-1111-4111-8111-111111111111',snapshot:{schemaVersion:1,sourceKind:'local-os',hostId:'test-only-process',bootId:'test-boot',sequence:1,observedAt:new Date().toISOString(),collection:{status:'ok',complete:true,scope:'TEST_ONLY'},processes:[{pid:42,createdAt:'2026-01-01T00:00:00Z',executable:'node.exe',role:'Node.js runtime',family:'Codex',metricStatus:'ok'}]}}]);
  await closing;const journal=await HistoryJournal.open({directory:process.env.TEST_DIRECTORY});
  assert.equal(journal.processRead({hostIds:null,projectIds:null},new URLSearchParams('host=test-only-process&mode=history'),['test-only-process']).retained.n,1);
 `;
 const fixture=path.join(root,'runtime-child.mjs');await fs.writeFile(fixture,script);
 await promisify(execFile)(process.execPath,[fixture],{env:{...process.env,TEST_DIRECTORY:root,CODEX_CONTROL_HOST_ID:'test-only-process',CODEX_CONTROL_SESSION_ROOT:path.join(root,'empty')},timeout:20000,windowsHide:true,maxBuffer:16384});
});

test('a shutdown cannot report success when its pending process sample cannot be staged',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ARGELLAN-TEST_ONLY-process-shutdown-failure-'));
 t.after(async()=>{const base=await fs.realpath(os.tmpdir()),target=await fs.realpath(root);assert.ok(target.startsWith(base+path.sep+'ARGELLAN-TEST_ONLY-process-shutdown-failure-'));await fs.rm(target,{recursive:true,force:true});});
 const server=pathToFileURL(path.resolve(import.meta.dirname,'../server.mjs')).href;
 const script=`
  import assert from 'node:assert/strict';import http from 'node:http';import {startRuntime} from ${JSON.stringify(server)};
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  let finishPoll;const pending=new Promise(r=>{finishPoll=r;});
  const runtime=await startRuntime({dataDirectory:process.env.TEST_DIRECTORY,listen:'127.0.0.1',port,instanceId:'TEST_ONLY',processTelemetry:{enabled:true},installationNetwork:{listen:'127.0.0.1',port:0,discovery:false}},{processObserverFactory:()=>({poll:()=>pending})});
  const original=runtime.installation.stageCapture.bind(runtime.installation);runtime.installation.stageCapture=(local,options)=>options?.processSamples?.length?Promise.reject(Error('TEST_ONLY stage unavailable')):original(local,options);
  const closing=new Promise((resolve,reject)=>runtime.server.close(error=>error?reject(error):resolve()));
  finishPoll([{epoch:'11111111-1111-4111-8111-111111111111',snapshot:{schemaVersion:1,sourceKind:'local-os',hostId:'test-only-process',bootId:'test-boot',sequence:1,observedAt:new Date().toISOString(),collection:{status:'ok',complete:true,scope:'TEST_ONLY'},processes:[]}}]);
  await assert.rejects(closing,/TEST_ONLY stage unavailable/);await runtime.installation.close();
 `;
 const fixture=path.join(root,'runtime-child.mjs');await fs.writeFile(fixture,script);
 await promisify(execFile)(process.execPath,[fixture],{env:{...process.env,TEST_DIRECTORY:root,CODEX_CONTROL_HOST_ID:'test-only-process',CODEX_CONTROL_SESSION_ROOT:path.join(root,'empty')},timeout:20000,windowsHide:true,maxBuffer:16384});
});
