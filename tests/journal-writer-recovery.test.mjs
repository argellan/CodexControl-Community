// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
for(const fault of ['slow-commit','write-error','sync-error','native-full','before-commit-exit','after-commit-exit','missing-ack'])test('writer recovery: '+fault,async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-writer-fault-TEST_ONLY-'));
 try{
  const {stdout}=await run(process.execPath,['--max-old-space-size=128','--import',new URL('./fixtures/journal-fault-preload.mjs',import.meta.url).href,fileURLToPath(new URL('./fixtures/journal-fault-runner.mjs',import.meta.url))],{windowsHide:true,timeout:6000,maxBuffer:32768,env:{...process.env,TEST_ONLY_JOURNAL_FAULT:fault,TEST_ONLY_JOURNAL_DIRECTORY:directory,TEST_ONLY_JOURNAL_MARKER:path.join(directory,'TEST_ONLY-commit-marker')}});
  const result=JSON.parse(stdout.trim());assert.equal(result.closed,true);assert.equal(result.fault,fault);if(process.env.TEST_ONLY_JOURNAL_EVIDENCE)await fs.writeFile(path.join(process.env.TEST_ONLY_JOURNAL_EVIDENCE,fault+'.json'),JSON.stringify(result,null,2));
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('application death preserves all independently received ACKs and permits unacknowledged replay',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-parent-crash-TEST_ONLY-'));
 try{
  let failure;try{await run(process.execPath,['--max-old-space-size=128','--import',new URL('./fixtures/journal-fault-preload.mjs',import.meta.url).href,fileURLToPath(new URL('./fixtures/journal-fault-runner.mjs',import.meta.url))],{windowsHide:true,timeout:6000,maxBuffer:32768,env:{...process.env,TEST_ONLY_JOURNAL_FAULT:'parent-exit',TEST_ONLY_JOURNAL_DIRECTORY:directory}});}catch(error){failure=error;}
  assert.ok(failure);assert.equal(failure.killed,false,'must be application crash, not test timeout');const acknowledgment=JSON.parse(failure.stdout.trim());assert.deepEqual(acknowledgment.acknowledged,['test-source:first','test-source:second']);
  const {FleetHub}=await import('../lib/fleet.mjs'),{createHash}=await import('node:crypto'),token='TEST_ONLY-token';
  const recovered=await FleetHub.open({directory,hosts:[{id:'test-source',tokenHash:createHash('sha256').update(token).digest('hex')}]});
  const ids=new Set(recovered.journal.read().events.map(e=>e.id));for(const id of acknowledgment.acknowledged)assert.equal(ids.has(id),true,'acknowledged record must survive parent death');
  await recovered.ingest(token,JSON.parse(await fs.readFile(path.join(directory,'TEST_ONLY-replay.json'),'utf8')));assert.equal(recovered.journal.status().retainedEvents,3);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
