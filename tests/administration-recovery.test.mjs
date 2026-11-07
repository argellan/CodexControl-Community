// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Administration} from '../lib/administration.mjs';
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const initial={instanceId:'TEST_ONLY_recovery',viewers:[{id:'owner',label:'TEST_ONLY owner',role:'admin',hostIds:null,projectIds:null,tokenHash:hash('TEST_ONLY_owner')}],hosts:[{id:'test-device',label:'TEST_ONLY device',tokenHash:hash('TEST_ONLY_collector')}]};
async function fixture(run){const root=await fs.mkdtemp(path.join(os.tmpdir(),'cc-recovery-format-TEST_ONLY-'));try{const service=await Administration.open({directory:root,initial});await run({root,service,file:path.join(root,'administration.json')});}finally{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('cc-recovery-format-TEST_ONLY-'));await fs.rm(root,{recursive:true,force:true});}}

test('new publication declares the versioned format required for generation and receipt preservation',()=>fixture(async({file})=>{
 const raw=JSON.parse(await fs.readFile(file));assert.equal(raw.schemaVersion,2);assert.equal(raw.hosts[0].credentialGeneration,1);assert.deepEqual(raw.enrollments,[]);
}));
test('legacy read preserves bytes and current authority until a versioned mutation is published',()=>fixture(async({root,file})=>{
 const legacy=JSON.parse(await fs.readFile(file));legacy.schemaVersion=1;delete legacy.enrollments;for(const h of legacy.hosts){delete h.credentialGeneration;delete h.expectedHostname;delete h.enrollmentRequestId;}
 const bytes=JSON.stringify(legacy);await fs.writeFile(file,bytes);const reopened=await Administration.open({directory:root});const state=await reopened.state();assert.equal(state.hosts[0].tokenHash,hash('TEST_ONLY_collector'));assert.equal(await fs.readFile(file,'utf8'),bytes);
 await reopened.revokeSource({revision:state.revision,id:'test-device',actor:{id:'owner',role:'admin'}});const updated=JSON.parse(await fs.readFile(file));assert.equal(updated.schemaVersion,2);assert.equal(updated.hosts[0].disabled,true);assert.equal(updated.hosts[0].tokenHash,legacy.hosts[0].tokenHash);
}));
test('missing modern metadata is refused instead of resetting generation or dropping receipts',()=>fixture(async({root,file})=>{
 const valid=JSON.parse(await fs.readFile(file));
 for(const missing of ['enrollments','credentialGeneration','expectedHostname','enrollmentRequestId']){
  const raw=structuredClone(valid);if(missing==='enrollments')delete raw.enrollments;else delete raw.hosts[0][missing];const bytes=JSON.stringify(raw);await fs.writeFile(file,bytes);
  await assert.rejects(Administration.open({directory:root}),e=>e.status===503);assert.equal(await fs.readFile(file,'utf8'),bytes);
 }
}));
test('read-only recovery inspection validates current state without seeding missing data',()=>fixture(async({root,file})=>{
 assert.equal(typeof Administration.inspect,'function');const before=await fs.readFile(file);const result=await Administration.inspect({directory:root});assert.equal(result.schemaVersion,2);assert.equal(result.revision,1);assert.equal(result.sha256,hash(before));assert.equal(result.instanceId,'TEST_ONLY_recovery');assert.ok(!JSON.stringify(result).includes(hash('TEST_ONLY_collector')));assert.deepEqual(await fs.readFile(file),before);
 const absent=path.join(root,'absent');await assert.rejects(Administration.inspect({directory:absent}));await assert.rejects(fs.stat(absent),e=>e.code==='ENOENT');
}));


test('recovery inspection rejects malformed private state with a sanitized error',()=>fixture(async({root,file})=>{
 await fs.writeFile(file,'PRIVATE_TEST_ONLY_TOKEN_NOT_JSON');await assert.rejects(Administration.inspect({directory:root}),e=>e.status===503&&!e.message.includes('PRIVATE_TEST_ONLY'));
}));
test('current receipt and generation must agree before recovery can admit state',()=>fixture(async({root,service,file})=>{
 const host={id:'another-device',label:'TEST_ONLY'},actor={id:'owner',role:'admin'},first=await service.enrollSource({revision:1,host,actor,requestId:crypto.randomUUID()}),second=await service.enrollSource({revision:first.revision,host,actor,requestId:crypto.randomUUID(),replace:true,expectedGeneration:1}),valid=JSON.parse(await fs.readFile(file));
 for(const mutate of [v=>{v.enrollments=v.enrollments.filter(e=>e.requestId!==second.enrollment.requestId);},v=>{v.hosts.find(h=>h.id==='another-device').credentialGeneration=1;},v=>{v.enrollments[0].hostId='missing-device';}]){
  const v=structuredClone(valid);mutate(v);const bytes=JSON.stringify(v);await fs.writeFile(file,bytes);await assert.rejects(Administration.inspect({directory:root}));assert.equal(await fs.readFile(file,'utf8'),bytes);
 }
}));
