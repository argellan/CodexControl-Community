// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';

test('Community runtime stages a synthetic process sample without blocking other collection',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ARGELLAN-TEST_ONLY-process-runtime-'));
 t.after(async()=>{const base=await fs.realpath(os.tmpdir()),target=await fs.realpath(root);assert.ok(target.startsWith(base+path.sep+'ARGELLAN-TEST_ONLY-process-runtime-'));await fs.rm(target,{recursive:true,force:true});});
 const module=pathToFileURL(path.resolve(import.meta.dirname,'../server.mjs')).href;
 const script=`
  import assert from 'node:assert/strict';
  import http from 'node:http';
  import {startRuntime} from ${JSON.stringify(module)};
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  let finishPoll,calls=0;const pending=new Promise(r=>{finishPoll=r;});
  const runtime=await Promise.race([startRuntime({dataDirectory:process.env.TEST_DIRECTORY,listen:'127.0.0.1',port,instanceId:'TEST_ONLY',processTelemetry:{enabled:true},installationNetwork:{listen:'127.0.0.1',port:0,discovery:false}},{processObserverFactory:()=>({poll(){calls++;return pending;}})}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Observer blocked initial collection')),6000))]);
  try{
   assert.equal(calls,1);const initial=runtime.hub.localObservedAt;
   const deadline=Date.now()+6000;while(runtime.hub.localObservedAt===initial&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
   assert.notEqual(runtime.hub.localObservedAt,initial,'other collection continues during pending sample');
   finishPoll([{epoch:'11111111-1111-4111-8111-111111111111',snapshot:{schemaVersion:1,sourceKind:'local-os',hostId:'test-only-process',bootId:'test-boot',sequence:1,observedAt:new Date().toISOString(),collection:{status:'ok',complete:true,scope:'TEST_ONLY'},processes:[{pid:42,createdAt:'2026-01-01T00:00:00Z',executable:'node.exe',role:'Node.js runtime',family:'Codex',metricStatus:'ok',privateCommitBytes:12345}]}}]);
   const read=()=>runtime.hub.journal.processRead({hostIds:null,projectIds:null},new URLSearchParams('host=test-only-process&mode=history'),['test-only-process']).retained.n;
   const capturedBy=Date.now()+8000;while(!read()&&Date.now()<capturedBy)await new Promise(r=>setTimeout(r,50));assert.equal(read(),1);
  }finally{await new Promise(r=>runtime.server.close(r));await runtime.server.runtimeCloseWork;}
 `;
 const fixture=path.join(root,'runtime-child.mjs');await fs.writeFile(fixture,script);
 const {stdout,stderr}=await promisify(execFile)(process.execPath,[fixture],{env:{...process.env,TEST_DIRECTORY:root,CODEX_CONTROL_HOST_ID:'test-only-process',CODEX_CONTROL_SESSION_ROOT:path.join(root,'empty')},timeout:20000,windowsHide:true,maxBuffer:16384});
 assert.doesNotMatch(stdout+stderr,/Local journal observation failed|Process observation unavailable/);
});
