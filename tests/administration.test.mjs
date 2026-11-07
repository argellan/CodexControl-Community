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
import crypto from 'node:crypto';
import {HistoryJournal} from '../lib/history.mjs';
import {DEFAULT_CONFIGURATION} from '../public/settings-schema.mjs';
const backend=await import('../lib/administration.mjs').catch(()=>({}));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const owner={id:'owner',label:'Owner',role:'admin',hostIds:null,projectIds:null,tokenHash:hash('fixture-owner-token'),disabled:false,expiresAt:null};
const actor={id:'owner',role:'admin',label:'PRIVATE LABEL',token:'SECRET_ACTOR'};
const initial=extra=>({instanceId:'fixture-instance',viewTokenHash:hash('fixture-legacy'),viewers:[owner],hosts:[],...extra});
const fixture=async fn=>{const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-administration-'));try{return await fn(directory);}finally{await fs.rm(directory,{recursive:true,force:true});}};
const user=(id='reader',extra={})=>({id,label:'Reader',role:'viewer',hostIds:[],projectIds:null,disabled:false,expiresAt:null,...extra});

test('private registry migrates legacy read-only credentials without creating an administrator',()=>fixture(async directory=>{
 assert.equal(typeof backend.Administration,'function');const service=await backend.Administration.open({directory,initial:initial({viewers:[]})});
 const state=await service.state();assert.equal(state.viewTokenHash,hash('fixture-legacy'));assert.equal(state.viewers.length,0);
 const users=await service.publicUsers();assert.equal(users.users[0].id,'legacy');assert.equal(users.users[0].role,'viewer');assert.ok(!JSON.stringify(users).includes(hash('fixture-legacy')));
 await assert.rejects(service.saveUser({revision:state.revision,user:user(),actor:{id:'legacy',role:'admin'}}),e=>e.status===403);
}));

test('new users receive one-time generated keys while public reads and persisted audit exclude secrets',()=>fixture(async directory=>{
 const service=await backend.Administration.open({directory,initial:initial()}),created=await service.saveUser({revision:1,user:user(),actor});
 assert.equal(created.revision,2);assert.equal(created.issuedCredential.id,'reader');assert.equal(created.issuedCredential.kind,'viewer');assert.ok(created.issuedCredential.token.length>=43);
 const state=await service.state();assert.equal(state.viewers.find(v=>v.id==='reader').tokenHash,hash(created.issuedCredential.token));
 const publicData=JSON.stringify([await service.publicUsers(),await service.audit()]);assert.ok(!publicData.includes(created.issuedCredential.token));assert.ok(!publicData.includes(hash(created.issuedCredential.token)));assert.ok(!publicData.includes('SECRET_ACTOR'));assert.ok(!publicData.includes('PRIVATE LABEL'));
 const disk=await fs.readFile(path.join(directory,'administration.json'),'utf8');assert.ok(!disk.includes(created.issuedCredential.token));
 await assert.rejects(service.saveUser({revision:1,user:user('stale'),actor}),e=>e.status===409);
 await assert.rejects(service.saveUser({revision:2,user:{...user('inject'),tokenHash:hash('arbitrary-key')},actor}),e=>e.status===400);
}));

test('only active full-scope administrators can mutate and the last active admin cannot be revoked or scoped',()=>fixture(async directory=>{
 const service=await backend.Administration.open({directory,initial:initial()});
 await assert.rejects(service.revokeUser({revision:1,id:'owner',actor}),e=>e.status===409);
 await assert.rejects(service.saveUser({revision:1,user:{...user('owner'),role:'admin',hostIds:['one']},actor}),e=>e.status===400);
 await assert.rejects(service.saveUser({revision:1,user:user('owner',{role:'viewer'}),actor}),e=>e.status===409);
 const newAdmin=await service.saveUser({revision:1,user:user('second',{role:'admin',hostIds:null}),actor});assert.equal(newAdmin.revision,2);
 const revoked=await service.revokeUser({revision:2,id:'owner',actor});assert.equal(revoked.revision,3);assert.equal((await service.publicUsers()).users.find(u=>u.id==='owner').status,'revoked');
 await assert.rejects(service.saveUser({revision:3,user:user('blocked'),actor}),e=>e.status===403);
}));

test('expiry and forged actor roles do not confer administrative authority',()=>fixture(async directory=>{
 const service=await backend.Administration.open({directory,initial:initial({viewers:[owner,{...user('reader'),tokenHash:hash('reader')},{...owner,id:'expired',expiresAt:'2000-01-01T00:00:00Z',tokenHash:hash('expired')}]})});
 for(const who of [{id:'reader',role:'admin'},{id:'expired',role:'admin'},{id:'missing',role:'admin'}])await assert.rejects(service.saveUser({revision:1,user:user('blocked'),actor:who}),e=>e.status===403);
 assert.equal((await service.publicUsers()).users.find(u=>u.id==='expired').status,'expired');
}));

test('source enrollment preserves stable metadata and generated collector keys stay separate from viewer credentials',()=>fixture(async directory=>{
 const service=await backend.Administration.open({directory,initial:initial()}),enrolled=await service.enrollSource({revision:1,host:{id:'edge-example',label:'Example edge',deviceClass:'raspberry-pi',preferredAddress:'198.51.100.20',alternateAddresses:[]},actor});
 assert.equal(enrolled.issuedCredential.kind,'collector');assert.equal(enrolled.revision,2);
 const source=(await service.publicSources()).sources[0];assert.equal(source.id,'edge-example');assert.equal(source.status,'active');assert.ok(source.credentialFingerprint);assert.ok(!JSON.stringify(source).includes(hash(enrolled.issuedCredential.token)));
 const revoked=await service.revokeSource({revision:2,id:'edge-example',actor});assert.equal(revoked.revision,3);assert.equal((await service.publicSources()).sources[0].status,'revoked');
 await assert.rejects(service.enrollSource({revision:3,host:{id:'unsafe/host',label:'Bad'},actor}),e=>e.status===400);
 await assert.rejects(service.enrollSource({revision:3,host:{id:'bad-host',label:'Bad',preferredAddress:'https://user:SECRET@host/'},actor}),e=>e.status===400);
}));

test('collector-incompatible machine IDs are rejected before any registry revision or credential is persisted',()=>fixture(async directory=>{
 const service=await backend.Administration.open({directory,initial:initial()}),file=path.join(directory,'administration.json'),before=await fs.readFile(file,'utf8');
 for(const id of ['bad_host','Example-host','', 'x'.repeat(65)]){await assert.rejects(service.enrollSource({revision:1,host:{id,label:'Example source'},actor}),e=>e.status===400);assert.equal(await fs.readFile(file,'utf8'),before);assert.equal((await service.state()).revision,1);}
 const enrolled=await service.enrollSource({revision:1,host:{id:'-example-host',label:'Example source'},actor});assert.equal(enrolled.source.id,'-example-host');assert.deepEqual((await service.audit()).at(-1).changedPaths,['sources.-example-host']);
 const profile=await service.saveUser({revision:2,user:user('viewer_with_underscore'),actor});assert.equal(profile.user.id,'viewer_with_underscore');
}));

test('invalid seeded machine IDs never create a private administration registry',()=>fixture(async directory=>{
 await assert.rejects(backend.Administration.open({directory,initial:initial({hosts:[{id:'bad_host',tokenHash:hash('fixture-source')}]})}),e=>e.status===400);await assert.rejects(fs.access(path.join(directory,'administration.json')),e=>e.code==='ENOENT');
}));

test('registry rejects case-insensitive viewer/collector collisions and corrupted state never resets to seed credentials',()=>fixture(async directory=>{
 await assert.rejects(backend.Administration.open({directory,initial:initial({hosts:[{id:'one',label:'One',tokenHash:owner.tokenHash.toUpperCase()}]})}),e=>e.status===400);
 const service=await backend.Administration.open({directory,initial:initial()});await fs.writeFile(path.join(directory,'administration.json'),'corrupt');
 await assert.rejects(backend.Administration.open({directory,initial:initial()}),/registry|administration|recover/i);await assert.rejects(service.state(),/registry|administration|recover/i);
}));

test('user rotation invalidates old credentials and concurrent stale writers cannot overwrite a newer security revision',()=>fixture(async directory=>{
 const service=await backend.Administration.open({directory,initial:initial()}),one=await service.saveUser({revision:1,user:user(),actor}),oldHash=hash(one.issuedCredential.token);
 const rotated=await service.saveUser({revision:2,user:user('reader',{rotateKey:true}),actor});assert.notEqual(hash(rotated.issuedCredential.token),oldHash);
 const results=await Promise.allSettled([service.saveUser({revision:3,user:user('a'),actor}),service.saveUser({revision:3,user:user('b'),actor})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
}));

test('own private backups are consistent, checksummed and exclude security or raw command artifacts',()=>fixture(async directory=>{
 const service=await backend.Administration.open({directory,initial:initial()}),journal=await HistoryJournal.open({directory:path.join(directory,'journal')});
 journal.commit({hostId:'source',state:{id:'source',sessions:[]},events:[{id:'one',hostId:'source',sessionId:'worker',kind:'turn',at:new Date().toISOString(),label:'Turn started'}]});
 assert.equal(typeof service.createBackup,'function');await assert.rejects(service.createBackup({revision:9,journal,configuration:DEFAULT_CONFIGURATION,actor}),e=>e.status===409);
 const created=await service.createBackup({revision:1,journal,configuration:DEFAULT_CONFIGURATION,actor});assert.ok(created.id);assert.equal(created.manifest.files.length,2);assert.deepEqual(created.manifest.files.map(f=>f.name).sort(),['configuration.json','history.sqlite']);
 journal.commit({hostId:'source',state:{id:'source',sessions:[]},events:[{id:'two',hostId:'source',sessionId:'worker',kind:'turn',at:new Date().toISOString()}]});
 const verified=await service.verifyBackup(created.id);assert.equal(verified.valid,true);assert.equal(verified.manifest.journal.retainedEvents,1);
 const listed=await service.listBackups();assert.equal(listed.backups.length,1);assert.ok(!JSON.stringify(listed).includes('fixture-owner-token'));assert.ok(!JSON.stringify(listed).includes(owner.tokenHash));
 await assert.rejects(service.verifyBackup('../../outside'),e=>e.status===400);
 await fs.appendFile(path.join(directory,'backups',created.id,'configuration.json'),'corrupt');const corrupt=await service.verifyBackup(created.id);assert.equal(corrupt.valid,false);
 await assert.rejects(service.stageRestore({id:created.id,actor}),e=>e.status===409);
}));

test('staging copies only a verified own backup without replacing active journal/config/security',()=>fixture(async directory=>{
 const service=await backend.Administration.open({directory,initial:initial()}),journal=await HistoryJournal.open({directory:path.join(directory,'journal')});journal.commit({hostId:'source',state:{},events:[{id:'one',hostId:'source',kind:'turn',at:new Date().toISOString()}]});
 const created=await service.createBackup({journal,configuration:DEFAULT_CONFIGURATION,actor}),stateBefore=await service.state();
 await assert.rejects(service.stageRestore({id:created.id,revision:1,actor}),e=>e.status===409);
 const staged=await service.stageRestore({id:created.id,revision:stateBefore.revision,actor});assert.equal(staged.staged,true);assert.equal(staged.requiresRestart,true);assert.equal(staged.applyMode,'offline-cli-only');assert.equal(staged.stageDirectory,'restore-staging/pending');
 assert.equal(journal.status().retainedEvents,1);assert.deepEqual((await service.state()).viewers,stateBefore.viewers);assert.ok((await fs.stat(path.join(directory,'restore-staging','pending','manifest.json'))).isFile());
 await assert.rejects(service.stageRestore({id:created.id,actor}),e=>e.status===409);
}));

test('support bundles omit identities, source paths, raw events and credentials while retaining useful bounded health evidence',()=>fixture(async directory=>{
 const service=await backend.Administration.open({directory,initial:initial()}),config=structuredClone(DEFAULT_CONFIGURATION);config.general.organization='PRIVATE ORG';
 const support=await service.supportBundle({configuration:config,actor,snapshot:{observedAt:new Date().toISOString(),hosts:[{id:'PRIVATE HOST',status:'online',preferredAddress:'PRIVATE ADDRESS'}],sessions:[{id:'PRIVATE WORKER'}],events:[{command:'SECRET COMMAND'}]},diagnostics:{runtime:{node:process.version,rssBytes:1234,commandLine:'SECRET COMMAND',pid:999},storage:{totalBytes:100}}});
 const serialized=JSON.stringify(support);for(const hidden of ['PRIVATE','SECRET','commandLine','fixture-owner-token',owner.tokenHash])assert.ok(!serialized.includes(hidden));assert.equal(support.observations.hostCount,1);assert.equal(support.runtime.rssBytes,1234);
}));

test('backup privacy verification rejects a journal containing raw command fields',()=>fixture(async directory=>{
 const service=await backend.Administration.open({directory,initial:initial()}),journal=await HistoryJournal.open({directory:path.join(directory,'journal')});journal.commit({hostId:'source',state:{},events:[{id:'one',hostId:'source',kind:'turn',at:new Date().toISOString(),arguments:'SECRET COMMAND'}]});
 await assert.rejects(service.createBackup({journal,configuration:DEFAULT_CONFIGURATION,actor}),/metadata|privacy|sanit/i);assert.equal((await service.listBackups()).backups.length,0);
}));

test('legacy machine aliases survive registry migration without changing source identity',()=>fixture(async directory=>{const hosts=[{id:'test-only-host',label:'Test only',tokenHash:hash('test-only-collector'),aliases:['test-only-host-w','test-only-host-e']}];const service=await backend.Administration.open({directory,initial:initial({hosts})});const state=await service.state();assert.equal(state.hosts[0].id,'test-only-host');assert.deepEqual(state.hosts[0].aliases,hosts[0].aliases);assert.equal(state.hosts[0].tokenHash,hosts[0].tokenHash);assert.equal((await service.publicSources()).sources[0].tokenHash,undefined);}));
