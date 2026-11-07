// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Administration} from '../lib/administration.mjs';
import {ViewerAccess} from '../lib/viewer-access.mjs';
import {ConfigurationStore} from '../lib/configuration.mjs';
import {HistoryJournal} from '../lib/history.mjs';
import {DEFAULT_CONFIGURATION} from '../public/settings-schema.mjs';
import {createServer} from './fixture-server.mjs';
const password=await import('../lib/password-auth.mjs').catch(()=>({}));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const keys={owner:'TEST_ONLY_owner_access_key',reader:'TEST_ONLY_reader_access_key'};
const original='TEST_ONLY original password 46',replacement='TEST_ONLY replacement password 72';
const owner={id:'owner',label:'Owner',role:'admin',hostIds:null,projectIds:null,tokenHash:hash(keys.owner)};
const actor={id:'owner',role:'admin'};
const fixture=async run=>{const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-password-'));try{await run(directory);}finally{await fs.rm(directory,{recursive:true,force:true});}};
const helper=()=>assert.equal(typeof password.hashPassword,'function','memory bounded password hashing is available');

test('password hashes use random salts, bounded fixed parameters and reject weak or oversized inputs',async()=>{
 helper();const a=await password.hashPassword(original),b=await password.hashPassword(original);assert.notEqual(a,b);assert.ok(!a.includes(original));assert.equal(await password.verifyPassword(original,a),true);assert.equal(await password.verifyPassword(replacement,a),false);
 assert.equal(await password.verifyPassword(original,a.replace('$32768$','$1073741824$')),false);
 for(const input of ['short','x'.repeat(129),{password:original}])await assert.rejects(password.hashPassword(input),error=>error.status===400);
 assert.equal(password.normalizeUsername('  Test.Reader  '),'test.reader');assert.throws(()=>password.normalizeUsername('bad user'),error=>error.status===400);
});

test('attempt limits are source/account bounded, expire predictably and never accumulate unbounded keys',()=>{
 assert.equal(typeof password.PasswordRateLimiter,'function');let now=0;const limiter=new password.PasswordRateLimiter({now:()=>now,maxAttempts:2,windowMs:1000,maxEntries:4});limiter.consume('source-a','account');limiter.consume('source-a','account');assert.throws(()=>limiter.consume('source-a','account'),error=>error.status===429);assert.throws(()=>limiter.consume('source-b','account'),error=>error.status===429);now=1001;assert.doesNotThrow(()=>limiter.consume('source-a','account'));for(let i=0;i<20;i++)try{limiter.consume('other-'+i,'account-'+i);}catch(error){assert.equal(error.status,429);}assert.ok(limiter.size<=4);
});

test('password derivation rejects excess concurrent requests rather than allocating unbounded Pi work',async()=>{
 helper();const results=await Promise.allSettled(Array.from({length:12},()=>password.hashPassword(original)));
 assert.equal(results.filter(result=>result.status==='fulfilled').length,9);assert.ok(results.filter(result=>result.status==='rejected').every(result=>result.reason.status===429));
});

test('account creation persists only password hashes and safe public account metadata',()=>fixture(async directory=>{
 const admin=await Administration.open({directory,initial:{viewers:[owner]}});const created=await admin.saveUser({revision:1,actor,user:{id:'reader',label:'Reader',role:'viewer',hostIds:['allowed'],projectIds:['Allowed'],username:'Test.Reader',password:original}});
 assert.equal(created.user.username,'test.reader');assert.equal(created.user.passwordEnabled,true);assert.ok(!JSON.stringify(created).includes(original));const state=await admin.state(),entry=state.viewers.find(v=>v.id==='reader');assert.equal(await password.verifyPassword(original,entry.passwordHash),true);
 const publicData=JSON.stringify([await admin.publicUsers(),await admin.audit()]);assert.ok(!publicData.includes(original));assert.ok(!publicData.includes(entry.passwordHash));assert.ok(!(await fs.readFile(path.join(directory,'administration.json'),'utf8')).includes(original));
 await assert.rejects(admin.saveUser({revision:2,actor,user:{id:'duplicate',username:'TEST.READER',password:replacement}}),error=>error.status===409);
 await assert.rejects(admin.saveUser({revision:2,actor:{id:'reader',role:'admin'},user:{id:'other',username:'other.reader',password:replacement}}),error=>error.status===403);
}));

test('password sign-in uses canonical source scopes and reset invalidates only the affected sessions',()=>fixture(async directory=>{
 const admin=await Administration.open({directory,initial:{viewers:[owner]}}),created=await admin.saveUser({revision:1,actor,user:{id:'reader',label:'Reader',role:'viewer',hostIds:['allowed'],projectIds:['Allowed'],username:'reader',password:original}}),secret=crypto.randomBytes(32),sessions=new Map();let access=new ViewerAccess({...await admin.state(),secret,sessions});
 const identity=await access.authenticatePassword('READER',original);assert.equal(identity.role,'viewer');assert.deepEqual(identity.hostIds,['allowed']);assert.deepEqual(identity.projectIds,['Allowed']);const cookie=access.issueCookie(identity),profile=identity.profileKey,ownerCookie=access.issueCookie(access.authenticateBearer(keys.owner));
 assert.equal(await access.authenticatePassword('reader','wrong password'),null);assert.equal(await access.authenticatePassword('missing',original),null);
 const reset=await admin.resetPassword({revision:created.revision,id:'reader',password:replacement,actor});assert.equal(reset.user.passwordEnabled,true);access=new ViewerAccess({...await admin.state(),secret,sessions});assert.equal(access.authenticateCookie(cookie),null);assert.ok(access.authenticateCookie(ownerCookie));assert.equal(await access.authenticatePassword('reader',original),null);assert.equal((await access.authenticatePassword('reader',replacement)).profileKey,profile);assert.ok(access.authenticateBearer(created.issuedCredential.token));
 await assert.rejects(admin.resetPassword({revision:reset.revision,id:'owner',password:replacement,actor}),error=>error.status===403);
 await assert.rejects(admin.resetPassword({revision:1,id:'reader',password:replacement,actor}),error=>error.status===409);
}));

test('own password changes require the current password and disabled accounts cannot authenticate',()=>fixture(async directory=>{
 const admin=await Administration.open({directory,initial:{viewers:[owner]}}),created=await admin.saveUser({revision:1,actor,user:{id:'reader',label:'Reader',hostIds:[],username:'reader',password:original}});
 await assert.rejects(admin.changePassword({id:'reader',currentPassword:'wrong password',newPassword:replacement,actor:{id:'reader',role:'viewer'}}),error=>error.status===401);
 const changed=await admin.changePassword({id:'reader',currentPassword:original,newPassword:replacement,actor:{id:'reader',role:'viewer'}});assert.equal(changed.changed,true);let access=new ViewerAccess(await admin.state());assert.ok(await access.authenticatePassword('reader',replacement));
 await admin.revokeUser({revision:(await admin.state()).revision,id:'reader',actor});access=new ViewerAccess(await admin.state());assert.equal(await access.authenticatePassword('reader',replacement),null);assert.equal(access.authenticateBearer(created.issuedCredential.token),null);
 const configured=await admin.saveUser({revision:(await admin.state()).revision,actor,user:{id:'owner',username:'owner',password:original}});await assert.rejects(admin.saveUser({revision:configured.revision,actor,user:{id:'owner',password:replacement}}),error=>error.status===403);
}));

test('expired password accounts fail closed and raw verifier injection never reaches registry state',()=>fixture(async directory=>{
 const admin=await Administration.open({directory,initial:{viewers:[owner]}}),created=await admin.saveUser({revision:1,actor,user:{id:'expired',label:'Expired',hostIds:null,username:'expired',password:original,expiresAt:'2000-01-01T00:00:00Z'}}),access=new ViewerAccess(await admin.state());assert.equal(await access.authenticatePassword('expired',original),null);
 const before=await fs.readFile(path.join(directory,'administration.json'),'utf8');await assert.rejects(admin.saveUser({revision:created.revision,actor,user:{id:'inject',passwordHash:'attacker-verifier',username:'inject'}}),error=>error.status===400);assert.equal(await fs.readFile(path.join(directory,'administration.json'),'utf8'),before);
}));

test('journal backups refuse password verifier fields rather than treating hashes as observation metadata',()=>fixture(async directory=>{
 const admin=await Administration.open({directory:path.join(directory,'admin'),initial:{viewers:[owner]}}),journal=await HistoryJournal.open({directory:path.join(directory,'journal')});journal.commit({hostId:'source',state:{sessions:[{id:'worker',passwordHash:'TEST_ONLY_PRIVATE_VERIFIER'}]},events:[]});
 await assert.rejects(admin.createBackup({journal,configuration:DEFAULT_CONFIGURATION,actor}),/metadata|privacy/i);assert.equal((await admin.listBackups()).backups.length,0);
}));

async function httpFixture(run){return fixture(async directory=>{const administration=await Administration.open({directory:path.join(directory,'admin'),initial:{viewers:[owner]}}),configuration=await ConfigurationStore.open({directory:path.join(directory,'config'),initial:structuredClone(DEFAULT_CONFIGURATION)});await administration.saveUser({revision:1,actor,user:{id:'reader',label:'Reader',hostIds:['allowed'],projectIds:['Allowed'],username:'reader',password:original}});const securityState=await administration.state(),server=createServer({administration,configuration,securityState,preferencesDirectory:path.join(directory,'preferences'),readSnapshot:async()=>({host:{id:'allowed'},hosts:[{id:'allowed',name:'Allowed',status:'online'}],sessions:[{id:'visible',hostId:'allowed',project:'Allowed'},{id:'hidden',hostId:'denied',project:'Denied'}],events:[],coverage:{}})});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;const request=async(route,{method='GET',body,cookie,token}={})=>{const result=await fetch(origin+route,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined}),text=await result.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:result.status,data,cookie:result.headers.get('set-cookie')?.split(';')[0]};};try{await run({request,origin,administration,configuration,securityState,directory});}finally{await new Promise(resolve=>server.close(resolve));}});}

test('HTTP password and key sign-in preserve read-only scopes, generic failure and explicit own-password sign-out',()=>httpFixture(async({request})=>{
 assert.equal((await request('/api/auth/capabilities')).data.passwordLogin,true);const missing=await request('/api/session',{method:'POST',body:{username:'missing',password:original}}),wrong=await request('/api/session',{method:'POST',body:{username:'reader',password:replacement}});assert.equal(missing.status,401);assert.deepEqual(missing.data,wrong.data);
 const signed=await request('/api/session',{method:'POST',body:{username:'reader',password:original}});assert.equal(signed.status,200);assert.ok(signed.cookie);const settings=await request('/api/settings',{cookie:signed.cookie});assert.equal(settings.data.viewer.username,'reader');assert.equal(settings.data.capabilities.passwordChange,true);assert.equal(settings.data.capabilities.passwordAccounts,false);assert.equal((await request('/api/admin/users',{cookie:signed.cookie})).status,403);
 const snapshot=await request('/api/snapshot',{cookie:signed.cookie});assert.deepEqual(snapshot.data.sessions.map(s=>s.id),['visible']);assert.equal((await request('/api/session',{method:'POST',body:{token:keys.owner,username:'reader',password:original}})).status,400);
 const change=await request('/api/settings/password',{method:'POST',cookie:signed.cookie,body:{currentPassword:original,newPassword:replacement}});assert.equal(change.status,200);assert.equal(change.data.signInRequired,true);assert.equal((await request('/api/settings',{cookie:signed.cookie})).status,401);assert.equal((await request('/api/session',{method:'POST',body:{token:keys.owner}})).status,200);
}));

test('fixed privileged gateways reject local password identities and cannot proxy viewer password login as owner',()=>httpFixture(async({origin,securityState})=>{
 assert.throws(()=>createServer({upstream:{url:origin,token:keys.owner},securityState}),/authoritative hub/i);
 const gateway=createServer({viewTokenHash:hash('TEST_ONLY_gateway_key'),upstream:{url:origin,token:keys.owner}});await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+gateway.address().port;
 try{const caps=await fetch(url+'/api/auth/capabilities').then(r=>r.json());assert.equal(caps.passwordLogin,false);assert.equal(caps.passwordLoginUrl,origin+'/');const attempted=await fetch(url+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'reader',password:original})});assert.equal(attempted.status,503);assert.equal(attempted.headers.get('set-cookie'),null);for(const route of ['/api/admin/users','/api/admin/config','/api/settings','/api/history'])assert.equal((await fetch(url+route)).status,401,route);}finally{await new Promise(resolve=>gateway.close(resolve));}
}));

test('HTTP password attempts are bounded and malformed identity fields cannot grant privileges',()=>httpFixture(async({request})=>{
 assert.equal((await request('/api/session',{method:'POST',body:{username:'reader',password:original,role:'admin',hostIds:null}})).status,400);
 assert.equal((await request('/api/session',{method:'POST',body:{username:'reader',password:'x'.repeat(5000)}})).status,413);
 for(let i=0;i<8;i++)assert.equal((await request('/api/session',{method:'POST',body:{username:'missing-user',password:original}})).status,401);
 assert.equal((await request('/api/session',{method:'POST',body:{username:'missing-user',password:original}})).status,429);
}));

test('HTTP owner reset revokes a viewer cookie while own initial setup explicitly requests sign-in again',()=>httpFixture(async({request})=>{
 const readerLogin=await request('/api/session',{method:'POST',body:{username:'reader',password:original}}),ownerLogin=await request('/api/session',{method:'POST',body:{token:keys.owner}}),inventory=await request('/api/admin/users',{cookie:ownerLogin.cookie});
 assert.equal((await request('/api/admin/users/reader/password',{method:'POST',cookie:readerLogin.cookie,body:{revision:inventory.data.revision,password:replacement}})).status,403);
 const reset=await request('/api/admin/users/reader/password',{method:'POST',cookie:ownerLogin.cookie,body:{revision:inventory.data.revision,password:replacement}});assert.equal(reset.status,200);assert.equal((await request('/api/settings',{cookie:readerLogin.cookie})).status,401);assert.equal((await request('/api/settings',{cookie:ownerLogin.cookie})).status,200);
 const setup=await request('/api/admin/users',{method:'POST',cookie:ownerLogin.cookie,body:{revision:reset.data.revision,user:{id:'owner',username:'owner',password:original}}});assert.equal(setup.status,200);assert.equal(setup.data.signInRequired,true);assert.equal((await request('/api/settings',{cookie:ownerLogin.cookie})).status,401);
}));


test('server login handoff uses only a credential-free secure configured authority',async()=>{
 const {upstreamLoginUrl}=await import('../server.mjs');assert.equal(upstreamLoginUrl({url:'https://observer.example.invalid:4317/api'}),'https://observer.example.invalid:4317/');assert.equal(upstreamLoginUrl({url:'http://127.0.0.1:4317'}),'http://127.0.0.1:4317/');
 for(const url of ['javascript:alert(1)','http://example.invalid/','https://user:secret@example.invalid','https://example.invalid/?token=secret','https://example.invalid/#token'])assert.equal(upstreamLoginUrl({url}),null);
});
