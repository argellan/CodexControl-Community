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
const model=await import('../public/device-enrollment.mjs').catch(()=>({}));
const actor={id:'owner',role:'admin'},hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const host={id:'test-only-workstation',label:'TEST_ONLY workstation',role:'codex-source'};
async function fixture(run){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-enrollment-TEST_ONLY-'));
 try{const initial={instanceId:'TEST_ONLY',viewers:[{...actor,label:'TEST_ONLY',hostIds:null,projectIds:null,tokenHash:hash('TEST_ONLY_OWNER')}],hosts:[]};
 const service=await Administration.open({directory,initial});await run({service,directory,initial});}
 finally{assert.ok(path.dirname(directory)===os.tmpdir()&&path.basename(directory).startsWith('cc-enrollment-TEST_ONLY-'));await fs.rm(directory,{recursive:true,force:true});}
}
test('Add rejects existing identity without rotating or changing durable state',()=>fixture(async({service,directory})=>{
 await service.enrollSource({revision:1,host,actor});const before=await fs.readFile(path.join(directory,'administration.json'),'utf8');
 await assert.rejects(service.enrollSource({revision:2,host,actor}),e=>e.status===409);assert.equal(await fs.readFile(path.join(directory,'administration.json'),'utf8'),before);
}));
test('stable issuance request reconciles after reopen without issuing another secret',()=>fixture(async({service,directory,initial})=>{
 const requestId=crypto.randomUUID(),args={revision:1,host,actor,requestId,expectedHostname:'TEST-ONLY'};
 const first=await service.enrollSource(args),reopened=await Administration.open({directory,initial}),retry=await reopened.enrollSource(args);
 assert.equal(retry.duplicate,true);assert.equal(retry.revision,first.revision);assert.equal(retry.issuedCredential,undefined);assert.equal(retry.source.credentialGeneration,1);
 const disk=await fs.readFile(path.join(directory,'administration.json'),'utf8');assert.ok(!disk.includes(first.issuedCredential.token));assert.equal(retry.source.expectedHostname,'TEST-ONLY');
 await assert.rejects(reopened.enrollSource({...args,host:{...host,label:'changed'}}),e=>e.status===409);
}));
test('replacement is explicit and fenced by credential generation',()=>fixture(async({service})=>{
 const first=await service.enrollSource({revision:1,host,actor});
 await assert.rejects(service.enrollSource({revision:2,host,actor,replace:true,expectedGeneration:99}),e=>e.status===409);
 const next=await service.enrollSource({revision:2,host,actor,replace:true,expectedGeneration:1});
 assert.equal(next.source.credentialGeneration,2);assert.notEqual(next.issuedCredential.token,first.issuedCredential.token);
}));
test('old request after revocation reports current disabled state without re-enabling',()=>fixture(async({service})=>{
 const requestId=crypto.randomUUID(),args={revision:1,host,actor,requestId};await service.enrollSource(args);await service.revokeSource({revision:2,id:host.id,actor});
 const retry=await service.enrollSource(args);assert.equal(retry.source.status,'revoked');assert.equal(retry.issuedCredential,undefined);assert.equal(retry.revision,3);
}));
test('generation-specific setup never trusts prior credential telemetry or expired access',()=>{
 assert.equal(typeof model.deviceEnrollmentState,'function');
 const source={...host,status:'active',credentialGeneration:2,observed:{status:'online',credentialGeneration:1,receivedAt:new Date().toISOString(),coverage:{identityVerified:true}}};
 assert.equal(model.deviceEnrollmentState(source).reporting,'waiting');
 source.observed.credentialGeneration=2;assert.equal(model.deviceEnrollmentState(source).reporting,'reporting');
 source.status='expired';assert.equal(model.deviceEnrollmentState(source).reporting,'blocked');
});
test('idle reporting distinguishes unknown installation source coverage and execution authority',()=>{
 assert.equal(typeof model.deviceEnrollmentState,'function');
 const state=model.deviceEnrollmentState({...host,status:'active',credentialGeneration:1,observed:{status:'online',credentialGeneration:1,receivedAt:new Date().toISOString(),coverage:{}}});
 assert.equal(state.installation,'not independently verified');assert.equal(state.startup,'not verified');assert.equal(state.control,'unavailable');assert.equal(state.capture,'not verified');
});


test('device request uses Codex purpose by default and rejects implicit replacement',()=>{
 assert.equal(typeof model.buildDeviceEnrollmentRequest,'function');
 const request=model.buildDeviceEnrollmentRequest({id:host.id,label:host.label,expectedHostname:'TEST-ONLY'},7,crypto.randomUUID());
 assert.equal(request.body.host.role,'codex-source');assert.equal(request.path,'/api/admin/sources/enroll');
 assert.throws(()=>model.buildDeviceEnrollmentRequest({id:host.id,label:host.label,expectedHostname:'TEST-ONLY',replace:true,expectedGeneration:1},7,crypto.randomUUID()),/confirm/i);
});
test('merged metadata cannot override credential authority or source generation',()=>{
 assert.equal(typeof model.mergeDeviceHosts,'function');
 const row=model.mergeDeviceHosts([{...host,tokenHash:'owned',disabled:true,credentialGeneration:2}],[{id:host.id,label:'configured',tokenHash:'foreign',disabled:false,credentialGeneration:99}])[0];
 assert.equal(row.label,'configured');assert.equal(row.tokenHash,'owned');assert.equal(row.disabled,true);assert.equal(row.credentialGeneration,2);
});

import {FleetHub} from '../lib/fleet.mjs';
test('only a batch authenticated by current generation verifies device reporting',()=>fixture(async({service,directory})=>{
 const created=await service.enrollSource({revision:1,host,actor}),hub=await FleetHub.open({directory:path.join(directory,'history'),hosts:(await service.state()).hosts});
 const local={host:{id:'test-only-hub'},sessions:[],events:[],coverage:{}},batch=()=>({hostId:host.id,batchId:crypto.randomUUID(),observedAt:new Date().toISOString(),sessions:[],events:[]});
 await hub.ingest(created.issuedCredential.token,{...batch(),sessions:[{id:'test-only-session'}]});const observed=()=>hub.snapshot(local,Date.now(),{includeEvents:false}).hosts.find(h=>h.id===host.id);
 assert.equal(model.deviceEnrollmentState({...created.source,observed:observed()}).reporting,'reporting');assert.equal(model.deviceEnrollmentState({...created.source,observed:observed()}).capture,'session metadata observed');
 const replaced=await service.enrollSource({revision:2,host,actor,replace:true,expectedGeneration:1});hub.hosts=(await service.state()).hosts;
 assert.equal(model.deviceEnrollmentState({...replaced.source,observed:observed()}).reporting,'waiting');
 await assert.rejects(hub.ingest(created.issuedCredential.token,batch()),e=>e.status===401);
 await hub.ingest(replaced.issuedCredential.token,batch());assert.equal(model.deviceEnrollmentState({...replaced.source,observed:observed()}).reporting,'reporting');assert.equal(observed().reportedSessionCount,0);assert.equal(model.deviceEnrollmentState({...replaced.source,observed:observed()}).capture,'not verified');
}));
test('another current administrator cannot claim or replay the issuers receipt',()=>fixture(async({service})=>{
 const added=await service.saveUser({revision:1,actor,user:{id:'other',label:'TEST_ONLY other',role:'admin',hostIds:null,projectIds:null}}),requestId=crypto.randomUUID();
 await service.enrollSource({revision:added.revision,host,actor,requestId});
 await assert.rejects(service.enrollSource({revision:2,host,actor:{id:'other',role:'admin'},requestId}),e=>e.status===403);
 await assert.rejects(service.enrollmentReceipt({requestId,actor:{id:'other',role:'admin'}}),e=>e.status===404);
}));



test('resume hint is bounded metadata with no credential or device label',()=>{
 const values=new Map(),storage={setItem:(k,v)=>values.set(k,v),getItem:k=>values.get(k),removeItem:k=>values.delete(k)};
 const hint={requestId:crypto.randomUUID(),actorId:'owner',instanceId:crypto.randomUUID(),hostId:'test-only',token:'PRIVATE',label:'PRIVATE'};
 model.savePendingDeviceSetup(hint,storage,1000);const restored=model.readPendingDeviceSetup(storage,1001);
 assert.deepEqual(Object.keys(restored).sort(),['actorId','expiresAt','hostId','instanceId','requestId']);assert.ok(![...values.values()].join('').includes('PRIVATE'));
 assert.equal(model.readPendingDeviceSetup(storage,1001,{actorId:'other',instanceId:hint.instanceId}),null);assert.equal(values.size,0);
 model.savePendingDeviceSetup(hint,storage,1000);assert.equal(model.readPendingDeviceSetup(storage,1000+900001),null);
 assert.doesNotThrow(()=>model.savePendingDeviceSetup(hint,{setItem(){throw Error('blocked');}},1000));
});


test('replacement retains an existing multi-interface address list',()=>{
 const alternateAddresses=['192.0.2.10','2001:db8::10'];
 const r=model.buildDeviceEnrollmentRequest({id:host.id,label:host.label,expectedHostname:'TEST-ONLY',replace:true,confirmReplacement:true,expectedGeneration:1,alternateAddresses},7,crypto.randomUUID());
 assert.deepEqual(r.body.host.alternateAddresses,alternateAddresses);
});
