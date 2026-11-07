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
const schema=await import('../public/settings-schema.mjs');
const backend=await import('../lib/configuration.mjs').catch(()=>({}));
const config=()=>structuredClone(schema.DEFAULT_CONFIGURATION);
const actor={id:'owner',label:'PRIVATE LABEL',role:'admin',token:'SECRET_TOKEN'};
const fixture=async fn=>{const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-configuration-'));try{return await fn(directory);}finally{await fs.rm(directory,{recursive:true,force:true});}};

test('temporary-file cleanup preserves the original publication refusal',t=>fixture(async directory=>{
 const store=await backend.ConfigurationStore.open({directory,initial:config()}),next=config();next.general.instanceName='Refused update';
 const refusal=Object.assign(new Error('Authority revoked'),{status:403}),unlink=fs.unlink;let cleanupAttempted=false;
 t.mock.method(fs,'unlink',async file=>{
  if(path.basename(file).startsWith('configuration.json.')){cleanupAttempted=true;throw Object.assign(new Error('Cleanup denied'),{code:'EACCES'});}
  return unlink(file);
 });
 await assert.rejects(store.save({revision:1,configuration:next,actor,verifyAuthority(){throw refusal;}}),error=>error===refusal);
 assert.equal(cleanupAttempted,true);assert.equal((await store.read()).revision,1);
 assert.equal((await store.read()).configuration.general.instanceName,config().general.instanceName);
}));

test('shared schema validates defaults and describes typed allowlisted settings',()=>{
 assert.equal(typeof schema.validateConfiguration,'function');assert.equal(schema.SCHEMA_VERSION,1);assert.deepEqual(schema.validateConfiguration(config()),config());
 assert.ok(schema.SETTINGS_SCHEMA.some(f=>f.path==='history.maxEvents'&&f.restartRequired));assert.ok(!schema.SETTINGS_SCHEMA.some(f=>/password|secret|token|command/.test(f.path)));
});

test('resource alert thresholds are typed bounded percentages and accept the full inclusive range',()=>{
 for(const key of ['cpuPercent','memoryPercent']){assert.equal(config().alerts.thresholds[key],90);for(const value of [0,100]){const c=config();c.alerts.thresholds[key]=value;assert.equal(schema.validateConfiguration(c).alerts.thresholds[key],value);}for(const value of [-1,101,NaN,'90']){const c=config();c.alerts.thresholds[key]=value;assert.throws(()=>schema.validateConfiguration(c),e=>e.status===400);}}
});

test('existing version-one deployments receive resource threshold defaults without losing saved values',()=>{
 const previous=config();delete previous.alerts.thresholds.cpuPercent;delete previous.alerts.thresholds.memoryPercent;previous.alerts.thresholds.quotaRemainingPercent=7;
 const normalized=schema.validateConfiguration(previous);assert.equal(normalized.alerts.thresholds.cpuPercent,90);assert.equal(normalized.alerts.thresholds.memoryPercent,90);assert.equal(normalized.alerts.thresholds.quotaRemainingPercent,7);assert.equal(Object.hasOwn(previous.alerts.thresholds,'cpuPercent'),false);
});

test('validation rejects unknown, secret, malformed and unsafe settings without echoing credentials',()=>{
 const invalid=[];let c=config();c.networking.privateKey='SECRET_TOKEN';invalid.push(c);c=config();c.history.maxEvents=Infinity;invalid.push(c);c=config();c.general.timezone='NOT A TIMEZONE';invalid.push(c);c=config();c.networking.publicOrigin='https://user:SECRET_TOKEN@host/';invalid.push(c);c=config();c.networking.listen='0.0.0.0';invalid.push(c);c=config();c.history.diskBudgetMiB=64;invalid.push(c);c=config();c.alerts.thresholds.sourceOfflineSeconds=5;invalid.push(c);
 for(const value of invalid)assert.throws(()=>schema.validateConfiguration(value),e=>e.status===400&&Array.isArray(e.errors)&&!JSON.stringify(e).includes('SECRET_TOKEN'));
});

test('fleet/source configuration preserves explicit stable IDs and accepts owning-host paths only',()=>{
 const c=config();c.fleet.hosts=[{id:'workstation-example',label:'Example workstation',deviceClass:'workstation',site:'HQ',rack:'',zone:'Office',group:'Development',preferredAddress:'192.0.2.10',alternateAddresses:['workstation.example.test']}];c.sources=[{id:'native',hostId:'workstation-example',kind:'codex-log',path:'C:/TEST_ONLY/.codex/sessions',intervalMs:1000,enabled:true}];
 assert.equal(schema.validateConfiguration(c).sources[0].path,c.sources[0].path);
 for(const mutate of [v=>v.sources[0].hostId='missing',v=>v.sources[0].path='../../auth.json',v=>v.sources[0].path='C:/TEST_ONLY/.codex/auth.json',v=>v.sources[0].path='/TEST_ONLY/.ssh/id_ed25519',v=>v.sources[0].intervalMs=0,v=>v.fleet.hosts.push({...v.fleet.hosts[0]})]){const bad=structuredClone(c);mutate(bad);assert.throws(()=>schema.validateConfiguration(bad),e=>e.status===400);}
});

test('machine IDs match collector enrollment while generic source profile IDs retain underscores',()=>{
 const c=config();c.fleet.hosts=[{id:'example-host',label:'Example host',deviceClass:'unknown',site:'',rack:'',zone:'',group:'',preferredAddress:null,alternateAddresses:[]}];c.sources=[{id:'profile_with_underscore',hostId:'example-host',kind:'codex-log',path:'/TEST_ONLY/.codex/sessions',intervalMs:1000,enabled:true}];
 assert.equal(schema.validateConfiguration(c).sources[0].id,'profile_with_underscore');
 for(const machineId of ['bad_host','Example-host','', 'x'.repeat(65)]){const bad=structuredClone(c);bad.fleet.hosts[0].id=machineId;bad.sources[0].hostId=machineId;const before=structuredClone(bad);assert.throws(()=>schema.validateConfiguration(bad),e=>e.status===400);assert.deepEqual(bad,before);}
 const leadingHyphen=structuredClone(c);leadingHyphen.fleet.hosts[0].id='-example-host';leadingHyphen.sources[0].hostId='-example-host';assert.equal(schema.validateConfiguration(leadingHyphen).fleet.hosts[0].id,'-example-host');
});

test('legacy host rows default to unmanaged sources without changing existing configuration objects',()=>{
 const previous=config();previous.fleet.hosts=[{id:'example-host',label:'Example host',deviceClass:'unknown',site:'',rack:'',zone:'',group:'',preferredAddress:null,alternateAddresses:[]}];const before=structuredClone(previous);
 const normalized=schema.validateConfiguration(previous);assert.equal(normalized.fleet.hosts[0].managedSources,false);assert.deepEqual(previous,before);assert.deepEqual(normalized.sources,[]);
});

test('explicit source management permits an authoritative empty set and requires a real boolean',()=>{
 const c=config();c.fleet.hosts=[{id:'example-host',label:'Example host',deviceClass:'unknown',site:'',rack:'',zone:'',group:'',preferredAddress:null,alternateAddresses:[],managedSources:true}];assert.equal(schema.validateConfiguration(c).fleet.hosts[0].managedSources,true);assert.deepEqual(schema.validateConfiguration(c).sources,[]);
 c.fleet.hosts[0].managedSources=false;assert.equal(schema.validateConfiguration(c).fleet.hosts[0].managedSources,false);
 for(const value of [1,'true',null,{}]){const invalid=structuredClone(c);invalid.fleet.hosts[0].managedSources=value;assert.throws(()=>schema.validateConfiguration(invalid),e=>e.status===400);}
 const field=schema.SETTINGS_SCHEMA.find(f=>f.path==='fleet.hosts').fields.find(f=>f.path==='managedSources');assert.equal(field.type,'boolean');assert.equal(field.default,false);assert.match(field.help,/empty/i);
});

test('store persists revisions atomically and conflicts or invalid saves preserve last accepted state',()=>fixture(async directory=>{
 assert.equal(typeof backend.ConfigurationStore,'function');let store=await backend.ConfigurationStore.open({directory,initial:config()}),first=await store.read();assert.equal(first.revision,1);
 const next=config();next.general.instanceName='Example Lab';const saved=await store.save({revision:first.revision,configuration:next,actor});assert.equal(saved.revision,2);assert.deepEqual(saved.changedPaths,['general.instanceName']);assert.equal(saved.requiresRestart,false);
 await assert.rejects(store.save({revision:1,configuration:config(),actor}),e=>e.status===409);
 const invalid=config();invalid.history.password='SECRET_TOKEN';await assert.rejects(store.save({revision:2,configuration:invalid,actor}),e=>e.status===400);
 store=await backend.ConfigurationStore.open({directory,initial:config()});assert.equal((await store.read()).configuration.general.instanceName,'Example Lab');assert.equal((await store.read()).revision,2);
 const audit=await store.audit();assert.equal(audit.at(-1).actor.id,'owner');assert.equal(audit.at(-1).actor.role,'admin');assert.ok(!JSON.stringify(audit).includes('SECRET_TOKEN'));assert.ok(!JSON.stringify(audit).includes('PRIVATE LABEL'));assert.ok(!JSON.stringify(audit).includes('Example Lab'));
}));

test('deployment changes require restart and rollback is a new audited revision',()=>fixture(async directory=>{
 const store=await backend.ConfigurationStore.open({directory,initial:config()}),next=config();next.history.ageDays=14;
 const saved=await store.save({revision:1,configuration:next,actor});assert.equal(saved.requiresRestart,true);assert.deepEqual(saved.changedPaths,['history.ageDays']);
 const restored=await store.rollback({revision:2,actor});assert.equal(restored.revision,3);assert.equal(restored.configuration.history.ageDays,7);assert.equal(restored.requiresRestart,true);assert.equal((await store.audit()).at(-1).action,'rollback');
 await assert.rejects(store.rollback({revision:2,actor}),e=>e.status===409);
}));

test('serialized concurrent saves permit one expected revision and refuse the stale contender',()=>fixture(async directory=>{
 const store=await backend.ConfigurationStore.open({directory,initial:config()}),a=config(),b=config();a.general.instanceName='A';b.general.instanceName='B';
 const results=await Promise.allSettled([store.save({revision:1,configuration:a,actor}),store.save({revision:1,configuration:b,actor})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);assert.equal((await store.read()).revision,2);
}));

test('corrupt primary recovers last-good with a fresh revision and records recovery without leaking source values',()=>fixture(async directory=>{
 let store=await backend.ConfigurationStore.open({directory,initial:config()}),next=config();next.general.instanceName='After seed';await store.save({revision:1,configuration:next,actor});
 await fs.writeFile(path.join(directory,'configuration.json'),'{ corrupt SECRET_TOKEN');store=await backend.ConfigurationStore.open({directory,initial:config()});const recovered=await store.read();assert.ok(recovered.revision>2);assert.equal(recovered.configuration.general.instanceName,'Codex Control');assert.equal(recovered.recovered,true);assert.equal((await store.audit()).at(-1).action,'recovery');assert.ok(!JSON.stringify(await store.audit()).includes('SECRET_TOKEN'));
}));

test('malformed primary and backup never silently reset an established deployment to defaults',()=>fixture(async directory=>{
 await backend.ConfigurationStore.open({directory,initial:config()});await fs.writeFile(path.join(directory,'configuration.json'),'bad');await fs.writeFile(path.join(directory,'configuration.last-good.json'),'bad');
 await assert.rejects(backend.ConfigurationStore.open({directory,initial:config()}),/recover|configuration/i);
}));

test('a blocked primary replacement preserves accepted state and usable last-good recovery',()=>fixture(async directory=>{
 const store=await backend.ConfigurationStore.open({directory,initial:config()}),primary=path.join(directory,'configuration.json'),held=path.join(directory,'held.json');
 await fs.rename(primary,held);await fs.mkdir(primary);const next=config();next.general.instanceName='Failed save';await assert.rejects(store.save({revision:1,configuration:next,actor}));
 await fs.rmdir(primary);await fs.rename(held,primary);const reopened=await backend.ConfigurationStore.open({directory,initial:config()});assert.equal((await reopened.read()).revision,1);assert.equal((await reopened.read()).configuration.general.instanceName,'Codex Control');assert.ok(!JSON.stringify(await reopened.audit()).includes('Failed save'));
}));

test('a second completed recovery advances beyond its previously acknowledged recovery revision',()=>fixture(async directory=>{
 await backend.ConfigurationStore.open({directory,initial:config()});await fs.writeFile(path.join(directory,'configuration.json'),'bad');let store=await backend.ConfigurationStore.open({directory,initial:config()});const first=await store.read();
 await fs.writeFile(path.join(directory,'configuration.json'),'bad again');store=await backend.ConfigurationStore.open({directory,initial:config()});const second=await store.read();assert.ok(second.revision>first.revision);
}));

test('explicit post-listen activation clears restart at a new revision without losing rollback',()=>fixture(async directory=>{
 const store=await backend.ConfigurationStore.open({directory,initial:config()}),next=config();next.history.ageDays=14;await store.save({revision:1,configuration:next,actor});
 assert.equal(typeof store.activate,'function');await assert.rejects(store.activate({revision:1,actor}),e=>e.status===409);
 const active=await store.activate({revision:2,actor});assert.equal(active.revision,3);assert.equal(active.requiresRestart,false);assert.equal(active.configuration.history.ageDays,14);assert.equal((await store.audit()).at(-1).action,'activate');
 const previous=await store.rollback({revision:3,actor});assert.equal(previous.configuration.history.ageDays,7);assert.equal(previous.requiresRestart,true);assert.equal(previous.revision,4);
}));
