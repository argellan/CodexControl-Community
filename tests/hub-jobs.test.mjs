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
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
test('hub reads its own real job feed with explicit worker binding and bootstrap delivery',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-hub-jobs-'));
 try{const file=path.join(directory,'jobs.jsonl');await fs.writeFile(file,JSON.stringify({id:'start',jobId:'diagnostic',type:'job_started',at:new Date().toISOString(),project:'Codex-Control',label:'Real diagnostic',workerHostId:'laptop',workerSessionId:'source-session'})+'\n');
 const code="const {snapshot}=await import("+JSON.stringify(new URL('../server.mjs',import.meta.url).href)+");const s=await snapshot();console.log(JSON.stringify({sessions:s.sessions,events:s.events}));";
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,CODEX_CONTROL_HOST_ID:'fixture-hub',CODEX_CONTROL_SESSION_ROOT:path.join(directory,'empty-sessions'),CODEX_CONTROL_JOB_FILE:file},timeout:5000});
 const result=JSON.parse(stdout);assert.equal(result.sessions.length,1);assert.equal(result.sessions[0].role,'execution-job');assert.equal(result.sessions[0].parentId,'source-session');assert.equal(result.events[0].hostId,'fixture-hub');assert.equal(result.events[0].workerHostId,'laptop');assert.equal(result.events[0].delivery,'bootstrap');assert.equal(result.events[0].kind,'remote.start');
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
