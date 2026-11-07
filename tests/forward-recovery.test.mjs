// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {Administration} from '../lib/administration.mjs';
import * as format from '../lib/administration-format.mjs';
const probe=await import('../scripts/verify-administration.mjs').catch(()=>({}));
const recovery=await import('../lib/forward-recovery.mjs').catch(()=>({}));
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const initial={instanceId:'TEST_ONLY_FORWARD',viewers:[{id:'owner',label:'TEST_ONLY owner',role:'admin',hostIds:null,projectIds:null,tokenHash:hash('TEST_ONLY_owner')}],hosts:[]};
async function fixture(run){const root=await fs.mkdtemp(path.join(os.tmpdir(),'cc-forward-recovery-TEST_ONLY-'));try{const directory=path.join(root,'data','administration'),administration=await Administration.open({directory,initial});await run({root,directory,administration,file:path.join(directory,'administration.json')});}finally{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('cc-forward-recovery-TEST_ONLY-'));await fs.rm(root,{recursive:true,force:true});}}

test('target compatibility requires explicit known receipt and generation semantics',()=>{
 assert.equal(typeof format.validateAdministrationFormat,'function');
 assert.doesNotThrow(()=>format.validateAdministrationFormat(structuredClone(format.ADMINISTRATION_FORMAT)));
 for(const bad of [null,{readerVersion:1},{...format.ADMINISTRATION_FORMAT,features:['credential-generation']},{...format.ADMINISTRATION_FORMAT,writeVersion:1},{...format.ADMINISTRATION_FORMAT,unknown:true}])assert.throws(()=>format.validateAdministrationFormat(bad));
});
test('target reader verifies the exact current registry without modifying security bytes',()=>fixture(async({directory,file})=>{
 assert.equal(typeof probe.verifyCurrentAdministration,'function');const bytes=await fs.readFile(file);
 const result=await probe.verifyCurrentAdministration({directory,expectedSha256:hash(bytes),expectedInstanceId:'TEST_ONLY_FORWARD'});
 assert.equal(result.status,'COMPATIBLE_CURRENT_AUTHORITY');assert.equal(result.protocolVersion,1);assert.equal(result.sha256,hash(bytes));assert.deepEqual(await fs.readFile(file),bytes);assert.ok(!JSON.stringify(result).includes(hash('TEST_ONLY_owner')));
 await assert.rejects(probe.verifyCurrentAdministration({directory,expectedSha256:'0'.repeat(64),expectedInstanceId:'TEST_ONLY_FORWARD'}),/changed|mismatch/i);
 await assert.rejects(probe.verifyCurrentAdministration({directory,expectedSha256:hash(bytes),expectedInstanceId:'OTHER'}),/instance/i);
}));
test('forward recovery never initializes a missing current authority registry',()=>fixture(async({root,directory})=>{
 assert.equal(typeof recovery.recoverApplication,'function');await fs.rm(directory,{recursive:true});
 await fs.writeFile(path.join(root,'installation.json'),JSON.stringify({schemaVersion:1,hostId:'test-only',appDirectory:root}));await fs.writeFile(path.join(root,'hub.json'),JSON.stringify({instanceId:'TEST_ONLY_FORWARD',dataDirectory:path.join(root,'data')}));
 await assert.rejects(recovery.recoverApplication({instanceDirectory:root,appDirectory:root}));await assert.rejects(fs.stat(directory),e=>e.code==='ENOENT');
}));

import {recoveryPackage,instancePointer,rebindRecoveryPackage} from './helpers/forward-recovery-package.mjs';
const actor={id:'owner',role:'admin'};

test('forward recovery preserves latest revocation, generation, receipts and audit while publishing only the application pointer',()=>fixture(async({root,administration,file})=>{
 assert.equal(typeof recovery.recoverApplication,'function');const pointer=await instancePointer(root),target=path.join(root,'target');await recoveryPackage(target);
 const requestId=crypto.randomUUID(),host={id:'test-device',label:'TEST_ONLY device'},one=await administration.enrollSource({revision:1,host,actor,requestId,expectedHostname:'TEST-ONLY'}),two=await administration.enrollSource({revision:one.revision,host,actor,requestId:crypto.randomUUID(),replace:true,expectedGeneration:1,expectedHostname:'TEST-ONLY'});await administration.revokeSource({revision:two.revision,id:host.id,actor});
 const before=await fs.readFile(file),result=await recovery.recoverApplication({instanceDirectory:root,appDirectory:target});
 assert.equal(result.status,'FORWARD_RECOVERY_PREPARED_NOT_STARTED');assert.equal(result.serviceStarted,false);assert.equal(result.authority.sha256,hash(before));assert.deepEqual(await fs.readFile(file),before);const after=JSON.parse(await fs.readFile(pointer));assert.equal(after.appDirectory,target);assert.equal(after.applicationChange.mode,'forward-recovery');
 const reopened=await Administration.open({directory:path.dirname(file)}),receipt=await reopened.enrollmentReceipt({requestId,actor});assert.equal(receipt.source.status,'revoked');assert.equal(receipt.source.credentialGeneration,2);assert.equal((await reopened.audit()).at(-2).action,'replace-source');
 const repeat=await recovery.recoverApplication({instanceDirectory:root,appDirectory:target});assert.equal(repeat.operationId,result.operationId);assert.equal(repeat.alreadyPrepared,true);assert.deepEqual(await fs.readFile(file),before);await assert.rejects(fs.stat(path.join(root,'data','restore.lock')),e=>e.code==='ENOENT');
}));
test('live instance and foreign recovery lock are refused without changing pointer or authority',()=>fixture(async({root,file})=>{
 assert.equal(typeof recovery.recoverApplication,'function');const pointer=await instancePointer(root,{pid:process.pid}),before=await fs.readFile(pointer),security=await fs.readFile(file);
 await assert.rejects(recovery.recoverApplication({instanceDirectory:root,appDirectory:root}),/live|offline/i);assert.deepEqual(await fs.readFile(pointer),before);
 await instancePointer(root);const lock=path.join(root,'data','restore.lock');await fs.writeFile(lock,'TEST_ONLY foreign owner');await assert.rejects(recovery.recoverApplication({instanceDirectory:root,appDirectory:root}),/lock|EEXIST/i);assert.equal(await fs.readFile(lock,'utf8'),'TEST_ONLY foreign owner');assert.deepEqual(await fs.readFile(file),security);
}));
test('unsupported target format and unqualified target cannot change the pointer',()=>fixture(async({root,file})=>{
 assert.equal(typeof recovery.recoverApplication,'function');const pointer=await instancePointer(root),target=path.join(root,'target'),{manifest}=await recoveryPackage(target),before=await fs.readFile(pointer),security=await fs.readFile(file);
 delete manifest.administrationFormat;await fs.writeFile(path.join(target,'RELEASE_MANIFEST.json'),JSON.stringify(manifest));await assert.rejects(recovery.recoverApplication({instanceDirectory:root,appDirectory:target}),/administration|compatible/i);assert.deepEqual(await fs.readFile(pointer),before);
 manifest.administrationFormat=format.ADMINISTRATION_FORMAT;manifest.finalRuntime=false;await fs.writeFile(path.join(target,'RELEASE_MANIFEST.json'),JSON.stringify(manifest));await assert.rejects(recovery.recoverApplication({instanceDirectory:root,appDirectory:target}),/qualified|performance|final/i);assert.deepEqual(await fs.readFile(file),security);assert.deepEqual(await fs.readFile(pointer),before);
}));
test('a target declaration without an executable compatible reader probe is refused',()=>fixture(async({root})=>{
 assert.equal(typeof recovery.recoverApplication,'function');const pointer=await instancePointer(root),target=path.join(root,'target');await recoveryPackage(target);const before=await fs.readFile(pointer);
 await fs.writeFile(path.join(target,'scripts','verify-administration.mjs'),'// TEST_ONLY forged reader; no probe implementation');await rebindRecoveryPackage(target);
 await assert.rejects(recovery.recoverApplication({instanceDirectory:root,appDirectory:target}),/changed|qualified|probe|checksum/i);assert.deepEqual(await fs.readFile(pointer),before);
}));
test('failed pointer rename leaves current authority and previous application selected',()=>fixture(async({root,file})=>{
 assert.equal(typeof recovery.recoverApplication,'function');const pointer=await instancePointer(root),target=path.join(root,'target');await recoveryPackage(target);const before=await fs.readFile(pointer),security=await fs.readFile(file),rename=fs.rename;
 fs.rename=async(a,b)=>{if(b===pointer)throw Object.assign(new Error('TEST_ONLY disk full'),{code:'ENOSPC'});return rename(a,b);};try{await assert.rejects(recovery.recoverApplication({instanceDirectory:root,appDirectory:target}),/disk full/i);}finally{fs.rename=rename;}
 assert.deepEqual(await fs.readFile(pointer),before);assert.deepEqual(await fs.readFile(file),security);assert.ok(!(await fs.readdir(root)).some(n=>n.includes('.pending-')));await assert.rejects(fs.stat(path.join(root,'data','restore.lock')),e=>e.code==='ENOENT');
}));

import {updateApplication} from '../scripts/setup-instance.mjs';
import {buildCandidate} from '../scripts/package-release.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const execute=promisify(execFile),sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('ordinary managed application update cannot bypass current administration format admission',()=>fixture(async({root,file})=>{
 const pointer=await instancePointer(root),target=path.join(root,'target'),{manifest}=await recoveryPackage(target);delete manifest.administrationFormat;await fs.writeFile(path.join(target,'RELEASE_MANIFEST.json'),JSON.stringify(manifest));const before=await fs.readFile(pointer),security=await fs.readFile(file);
 await assert.rejects(updateApplication({instanceDirectory:root,appDirectory:target}),/administration|compatible/i);assert.deepEqual(await fs.readFile(pointer),before);assert.deepEqual(await fs.readFile(file),security);
}));
test('package producer records compatible reader semantics for its complete administration closure',()=>fixture(async({root})=>{
 const target=path.join(root,'target'),{manifest}=await recoveryPackage(target),result=await buildCandidate({sourceRoot:target,destination:path.join(root,'provisional'),manifest:{schemaVersion:1,runtime:manifest.runtimePaths,support:[],documents:{}}});
 assert.equal(result.finalRuntime,false);assert.deepEqual(result.administrationFormat,format.ADMINISTRATION_FORMAT);
}));
test('documented forward recovery CLI prepares the pointer without starting a service',()=>fixture(async({root,file})=>{
 const pointer=await instancePointer(root),target=path.join(root,'target');await recoveryPackage(target);const before=await fs.readFile(file);
 const {stdout}=await execute(process.execPath,[path.join(sourceRoot,'scripts','setup-instance.mjs'),'--instance-dir='+root,'--recover-app='+target],{timeout:15000,windowsHide:true});const result=JSON.parse(stdout);assert.equal(result.status,'FORWARD_RECOVERY_PREPARED_NOT_STARTED');assert.equal(result.serviceStarted,false);assert.equal(JSON.parse(await fs.readFile(pointer)).appDirectory,target);assert.deepEqual(await fs.readFile(file),before);assert.ok(!stdout.includes(hash('TEST_ONLY_owner')));
}));


test('changed publication lease prevents pointer publication and preserves the foreign lock',()=>fixture(async({root,file})=>{
 const pointer=await instancePointer(root),target=path.join(root,'target');await recoveryPackage(target);const before=await fs.readFile(pointer),security=await fs.readFile(file),read=fs.readFile,lock=path.join(root,'data','restore.lock');let changed=false;
 fs.readFile=async(file,...args)=>{if(file===pointer&&!changed&&(await fs.readdir(root)).some(n=>n.includes('.pending-'))){changed=true;await fs.writeFile(lock,'TEST_ONLY new lock owner');}return read(file,...args);};
 try{await assert.rejects(recovery.recoverApplication({instanceDirectory:root,appDirectory:target}),/ownership|lock/i);}finally{fs.readFile=read;}
 assert.equal(changed,true);assert.deepEqual(await fs.readFile(pointer),before);assert.deepEqual(await fs.readFile(file),security);assert.equal(await fs.readFile(lock,'utf8'),'TEST_ONLY new lock owner');await assert.rejects(fs.stat(path.join(root,'application-change.lock')),e=>e.code==='ENOENT');
}));
test('ambiguous rename outcome is labelled uncertain and repeat reconciles the persisted operation',()=>fixture(async({root,file})=>{
 const pointer=await instancePointer(root),target=path.join(root,'target');await recoveryPackage(target);const bytes=await fs.readFile(file),rename=fs.rename;
 fs.rename=async(a,b)=>{await rename(a,b);if(b===pointer)throw Object.assign(new Error('TEST_ONLY lost rename acknowledgement'),{code:'EIO'});};
 try{await assert.rejects(recovery.recoverApplication({instanceDirectory:root,appDirectory:target}),e=>e.code==='PUBLICATION_UNCERTAIN');}finally{fs.rename=rename;}
 const persisted=JSON.parse(await fs.readFile(pointer));assert.equal(persisted.appDirectory,target);const repeated=await recovery.recoverApplication({instanceDirectory:root,appDirectory:target});assert.equal(repeated.alreadyPrepared,true);assert.equal(repeated.operationId,persisted.applicationChange.operationId);assert.deepEqual(await fs.readFile(file),bytes);
}));
test('disk-full staging leaves the old pointer and current security bytes untouched',()=>fixture(async({root,file})=>{
 const pointer=await instancePointer(root),target=path.join(root,'target');await recoveryPackage(target);const before=await fs.readFile(pointer),security=await fs.readFile(file),open=fs.open;
 fs.open=async(name,...args)=>{const h=await open(name,...args);if(name.startsWith(pointer+'.pending-'))h.writeFile=async()=>{throw Object.assign(new Error('TEST_ONLY staged disk full'),{code:'ENOSPC'});};return h;};
 try{await assert.rejects(recovery.recoverApplication({instanceDirectory:root,appDirectory:target}),/disk full/i);}finally{fs.open=open;}
 assert.deepEqual(await fs.readFile(pointer),before);assert.deepEqual(await fs.readFile(file),security);assert.ok(!(await fs.readdir(root)).some(n=>n.includes('.pending-')));
}));
test('junction targets and corrupted current metadata are refused without touching the pointer',()=>fixture(async({root,file})=>{
 const pointer=await instancePointer(root),real=path.join(root,'real-target'),link=path.join(root,'linked-target'),before=await fs.readFile(pointer);await fs.mkdir(real);await fs.symlink(real,link,process.platform==='win32'?'junction':'dir');
 await assert.rejects(recovery.recoverApplication({instanceDirectory:root,appDirectory:link}),/symbolic|junction/i);assert.deepEqual(await fs.readFile(pointer),before);
 const raw=JSON.parse(await fs.readFile(file));raw.schemaVersion=999;const corrupt=JSON.stringify(raw);await fs.writeFile(file,corrupt);await assert.rejects(recovery.recoverApplication({instanceDirectory:root,appDirectory:real}));assert.equal(await fs.readFile(file,'utf8'),corrupt);assert.deepEqual(await fs.readFile(pointer),before);
}));
import {ViewerAccess} from '../lib/viewer-access.mjs';
test('forward recovery preserves password changes, role reductions, key rotation and old-session rejection',()=>fixture(async({root,administration,file})=>{
 await instancePointer(root);const target=path.join(root,'target');await recoveryPackage(target);
 const created=await administration.saveUser({revision:1,actor,user:{id:'reader',label:'TEST_ONLY reader',role:'admin',hostIds:null,projectIds:null,username:'test-reader',password:'TEST_ONLY_password_before_123'}}),secret='TEST_ONLY_recovery_signing_secret_123456789';
 const oldAccess=new ViewerAccess({...await administration.state(),secret}),oldViewer=oldAccess.authenticateBearer(created.issuedCredential.token),cookie=oldAccess.issueCookie(oldViewer);
 const password=await administration.resetPassword({revision:created.revision,id:'reader',password:'TEST_ONLY_password_after_123',actor});const changed=await administration.saveUser({revision:password.revision,actor,user:{id:'reader',role:'viewer',hostIds:['test-device'],projectIds:[],rotateKey:true}});
 const before=await fs.readFile(file);await recovery.recoverApplication({instanceDirectory:root,appDirectory:target});const reopened=await Administration.open({directory:path.dirname(file)}),access=new ViewerAccess({...await reopened.state(),secret});
 assert.equal(access.authenticateBearer(created.issuedCredential.token),null);assert.equal(access.authenticateCookie(cookie),null);const viewer=access.authenticateBearer(changed.issuedCredential.token);assert.equal(viewer.role,'viewer');assert.deepEqual(viewer.hostIds,['test-device']);assert.deepEqual(viewer.projectIds,[]);assert.equal(await access.authenticatePassword('test-reader','TEST_ONLY_password_before_123'),null);assert.equal((await access.authenticatePassword('test-reader','TEST_ONLY_password_after_123')).id,'reader');assert.deepEqual(await fs.readFile(file),before);
}));

import {fork} from 'node:child_process';
import {once} from 'node:events';
test('fresh process selected by the recovered pointer enforces latest authority through the real HTTP runtime',()=>fixture(async({root,administration,file})=>{
 await instancePointer(root);const target=path.join(root,'target');await recoveryPackage(target);
 const reader=await administration.saveUser({revision:1,actor,user:{id:'restricted',label:'TEST_ONLY restricted',role:'viewer',hostIds:[],projectIds:[]}}),expired=await administration.saveUser({revision:reader.revision,actor,user:{id:'expired',label:'TEST_ONLY expired',role:'viewer',hostIds:null,projectIds:null,expiresAt:'2000-01-01T00:00:00Z'}}),host={id:'test-device',label:'TEST_ONLY device'},created=await administration.enrollSource({revision:expired.revision,actor,host,requestId:crypto.randomUUID()});await administration.revokeSource({revision:created.revision,id:host.id,actor});
 const before=await fs.readFile(file);await recovery.recoverApplication({instanceDirectory:root,appDirectory:target});
 const child=fork(path.join(sourceRoot,'tests','helpers','recovered-runtime.mjs'),[root],{execPath:process.execPath,windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,CODEX_HOME:path.join(root,'empty-codex-home'),CODEX_CONTROL_SESSION_ROOT:path.join(root,'empty-source')}});let errors='';child.stderr.on('data',b=>{errors=(errors+b).slice(-8192);});
 try{const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('TEST_ONLY recovered runtime timeout: '+errors)),10000);child.once('message',m=>{clearTimeout(timer);resolve(m);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('TEST_ONLY recovered runtime exited: '+errors));});});assert.equal(ready.schemaVersion,2);const origin='http://127.0.0.1:'+ready.port,request=(route,token)=>fetch(origin+route,{headers:{authorization:'Bearer '+token}});
  const owner=await request('/api/settings','TEST_ONLY_owner');assert.equal(owner.status,200);assert.equal((await owner.json()).role,'admin');assert.equal((await request('/api/admin/sources',reader.issuedCredential.token)).status,403);assert.equal((await request('/api/settings',expired.issuedCredential.token)).status,401);
  const sources=await (await request('/api/admin/sources','TEST_ONLY_owner')).json();assert.equal(sources.sources.find(h=>h.id===host.id).status,'revoked');assert.equal(sources.sources.find(h=>h.id===host.id).setup.reporting,'blocked');const reconciled=await (await request('/api/admin/sources/enrollments/'+created.enrollment.requestId,'TEST_ONLY_owner')).json();assert.equal(reconciled.source.status,'revoked');assert.equal(reconciled.issuedCredential,undefined);assert.deepEqual(await fs.readFile(file),before);
 }finally{if(child.exitCode===null){const ended=once(child,'exit');child.send('close');const timer=setTimeout(()=>child.kill(),5000);await ended;clearTimeout(timer);}assert.equal(child.exitCode,0);}
}));


test('post-publication cleanup failure reports uncertain outcome while preserving foreign ownership',()=>fixture(async({root,file})=>{
 const pointer=await instancePointer(root),target=path.join(root,'target');await recoveryPackage(target);const security=await fs.readFile(file),rename=fs.rename,lock=path.join(root,'data','restore.lock');
 fs.rename=async(a,b)=>{await rename(a,b);if(b===pointer)await fs.writeFile(lock,'TEST_ONLY foreign cleanup owner');};try{await assert.rejects(recovery.recoverApplication({instanceDirectory:root,appDirectory:target}),e=>e.code==='PUBLICATION_UNCERTAIN');}finally{fs.rename=rename;}
 assert.equal(JSON.parse(await fs.readFile(pointer)).appDirectory,target);assert.equal(await fs.readFile(lock,'utf8'),'TEST_ONLY foreign cleanup owner');assert.deepEqual(await fs.readFile(file),security);await assert.rejects(fs.stat(path.join(root,'application-change.lock')),e=>e.code==='ENOENT');
}));
test('ordinary update preserves never-started setup but refuses missing initialized authority',()=>fixture(async({root,directory})=>{
 const pointer=await instancePointer(root),target=path.join(root,'target');await recoveryPackage(target);await fs.rm(directory,{recursive:true});const before=await fs.readFile(pointer);await assert.rejects(updateApplication({instanceDirectory:root,appDirectory:target}));assert.deepEqual(await fs.readFile(pointer),before);
 await fs.rm(path.join(root,'data'),{recursive:true});const result=await updateApplication({instanceDirectory:root,appDirectory:target});assert.equal(result.status,'POINTER_UPDATED_INSTANCE_NOT_STARTED');assert.equal(result.authority,null);await assert.rejects(fs.stat(path.join(root,'data')),e=>e.code==='ENOENT');
}));


test('abrupt process exit before or after pointer publication preserves authority and fails closed on stale owned guards',async()=>{
 for(const phase of ['before','after'])await fixture(async({root,file})=>{
  const pointer=await instancePointer(root),target=path.join(root,'target');await recoveryPackage(target);const before=await fs.readFile(pointer),security=await fs.readFile(file);
  await assert.rejects(execute(process.execPath,[path.join(sourceRoot,'tests','helpers','recovery-crash.mjs'),root,target,phase],{timeout:15000,windowsHide:true}),e=>e.code===(phase==='before'?86:87));
  const selected=JSON.parse(await fs.readFile(pointer));if(phase==='before')assert.deepEqual(await fs.readFile(pointer),before);else{assert.equal(selected.appDirectory,target);assert.ok(selected.applicationChange.operationId);}
  assert.deepEqual(await fs.readFile(file),security);const lock=await fs.readFile(path.join(root,'application-change.lock'),'utf8');await assert.rejects(recovery.recoverApplication({instanceDirectory:root,appDirectory:target}),/EEXIST|lock/i);assert.equal(await fs.readFile(path.join(root,'application-change.lock'),'utf8'),lock);assert.deepEqual(await fs.readFile(file),security);
 });
});

test('recovered target accepts only the current rotated collector and keeps prior-generation telemetry unverified',()=>fixture(async({root,administration})=>{
 await instancePointer(root);const target=path.join(root,'target');await recoveryPackage(target);const host={id:'test-rotated',label:'TEST_ONLY rotated'},first=await administration.enrollSource({revision:1,actor,host,requestId:crypto.randomUUID()}),{FleetHub}=await import('../lib/fleet.mjs'),history=path.join(root,'data','history'),hub=await FleetHub.open({directory:history,hosts:(await administration.state()).hosts}),batch=()=>({hostId:host.id,batchId:crypto.randomUUID(),observedAt:new Date().toISOString(),sessions:[],events:[]});
 await hub.ingest(first.issuedCredential.token,batch());const second=await administration.enrollSource({revision:first.revision,actor,host,requestId:crypto.randomUUID(),replace:true,expectedGeneration:1});await recovery.recoverApplication({instanceDirectory:root,appDirectory:target});
 const {pathToFileURL}=await import('node:url'),[{Administration:TargetAdministration},{FleetHub:TargetFleet},{deviceEnrollmentState}]=await Promise.all([import(pathToFileURL(path.join(target,'lib','administration.mjs'))),import(pathToFileURL(path.join(target,'lib','fleet.mjs'))),import(pathToFileURL(path.join(target,'public','device-enrollment.mjs')))]),current=await TargetAdministration.open({directory:path.join(root,'data','administration')}),recovered=await TargetFleet.open({directory:history,hosts:(await current.state()).hosts});
 assert.equal(recovered.authenticateCollector(first.issuedCredential.token),null);assert.equal(recovered.authenticateCollector(second.issuedCredential.token).id,host.id);const local={host:{id:'test-only-hub'},sessions:[],events:[],coverage:{}},observed=()=>recovered.snapshot(local,Date.now(),{includeEvents:false}).hosts.find(h=>h.id===host.id);assert.equal(deviceEnrollmentState({...second.source,observed:observed()}).reporting,'waiting');await recovered.ingest(second.issuedCredential.token,batch());assert.equal(deviceEnrollmentState({...second.source,observed:observed()}).reporting,'reporting');assert.equal(deviceEnrollmentState({...second.source,observed:observed()}).control,'unavailable');
}));


test('failed own lock acquisition cleans a verified empty or complete marker without leaving the instance blocked',async()=>{
 for(const [which,method] of [['application-change.lock','writeFile'],['restore.lock','writeFile'],['restore.lock','sync']])await fixture(async({root,file})=>{
  const pointer=await instancePointer(root),before=await fs.readFile(pointer),security=await fs.readFile(file),open=fs.open;
  fs.open=async(name,...args)=>{const h=await open(name,...args);if(path.basename(name)===which)h[method]=async()=>{throw Object.assign(new Error('TEST_ONLY lock storage full'),{code:'ENOSPC'});};return h;};
  try{await assert.rejects(recovery.recoverApplication({instanceDirectory:root,appDirectory:root}),/storage full/i);}finally{fs.open=open;}
  assert.deepEqual(await fs.readFile(pointer),before);assert.deepEqual(await fs.readFile(file),security);await assert.rejects(fs.stat(path.join(root,'application-change.lock')),e=>e.code==='ENOENT');await assert.rejects(fs.stat(path.join(root,'data','restore.lock')),e=>e.code==='ENOENT');
 });
});


test('CLI exposes uncertain publication instead of implying that a failed command kept the old pointer',()=>fixture(async({root,file})=>{
 const pointer=await instancePointer(root),target=path.join(root,'target');await recoveryPackage(target);const security=await fs.readFile(file),error=await execute(process.execPath,[path.join(sourceRoot,'tests','helpers','recovery-cli-fault.mjs'),root,target],{timeout:15000,windowsHide:true}).catch(e=>e);assert.equal(error.code,1);
 const output=JSON.parse(error.stderr.split(/\r?\n/).filter(l=>l.startsWith('{')).at(-1));assert.equal(output.code,'PUBLICATION_UNCERTAIN');assert.equal(output.pointerMayHaveChanged,true);assert.equal(JSON.parse(await fs.readFile(pointer)).appDirectory,target);assert.deepEqual(await fs.readFile(file),security);
}));


test('never-started update rechecks that authority was not initialized while its pointer was staged',()=>fixture(async({root})=>{
 const pointer=await instancePointer(root),target=path.join(root,'target');await recoveryPackage(target);await fs.rm(path.join(root,'data'),{recursive:true});const before=await fs.readFile(pointer),read=fs.readFile;let initialized=false;
 fs.readFile=async(file,...args)=>{if(file===pointer&&!initialized&&(await fs.readdir(root)).some(n=>n.includes('.pending-'))){initialized=true;await fs.mkdir(path.join(root,'data'));await fs.writeFile(path.join(root,'data','runtime.pid'),JSON.stringify({pid:process.pid,instanceId:'TEST_ONLY_FORWARD'}));}return read(file,...args);};
 try{await assert.rejects(updateApplication({instanceDirectory:root,appDirectory:target}),/initialized|authority/i);}finally{fs.readFile=read;}
 assert.equal(initialized,true);assert.deepEqual(await fs.readFile(pointer),before);
}));
