// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Administration} from '../lib/administration.mjs';
import {ViewerAccess} from '../lib/viewer-access.mjs';
import {hashPassword,verifyPassword} from '../lib/password-auth.mjs';
import {provisionDesktopOwnerLogin,protectDesktopCredential} from '../lib/desktop-owner-login.mjs';
import {createServer} from './fixture-server.mjs';
import {ConfigurationStore} from '../lib/configuration.mjs';
import {DEFAULT_CONFIGURATION} from '../public/settings-schema.mjs';
const token='TEST_ONLY_initial_owner_key',temporary='TEST_ONLY temporary password 178',personal='TEST_ONLY my personal password 219';
const owner={id:'owner',label:'Owner',role:'admin',hostIds:null,projectIds:null,tokenHash:crypto.createHash('sha256').update(token).digest('hex')};
const fixture=async run=>{const directory=await fs.mkdtemp(path.join(os.tmpdir(),'TEST_ONLY-cc-first-sign-in-'));try{await run(directory);}finally{await fs.rm(directory,{recursive:true,force:true});}};
const testProtectionKey=crypto.randomBytes(32);
const protect=async(bytes,id,{decrypt=false}={})=>{const iv=crypto.createHash('sha256').update(id).digest().subarray(0,12);if(decrypt){const decipher=crypto.createDecipheriv('aes-256-gcm',testProtectionKey,iv);decipher.setAuthTag(bytes.subarray(0,16));return Buffer.concat([decipher.update(bytes.subarray(16)),decipher.final()]);}const cipher=crypto.createCipheriv('aes-256-gcm',testProtectionKey,iv),result=Buffer.concat([cipher.update(bytes),cipher.final()]);return Buffer.concat([cipher.getAuthTag(),result]);};
test('native Windows protection round trips only with the bound instance identity',{skip:process.platform!=='win32'},async()=>{const encrypted=await protectDesktopCredential(Buffer.from(temporary),'TEST_ONLY-bound-instance');assert.ok(!encrypted.includes(Buffer.from(temporary)));assert.equal((await protectDesktopCredential(encrypted,'TEST_ONLY-bound-instance',{decrypt:true})).toString(),temporary);await assert.rejects(protectDesktopCredential(encrypted,'TEST_ONLY-other-instance',{decrypt:true}));});
test('first install creates admin with a unique protected temporary password and preserves owner key',()=>fixture(async instance=>{
 await fs.writeFile(path.join(instance,'hub.json'),JSON.stringify({instanceId:crypto.randomUUID(),viewers:[owner],hosts:[]}));
 const result=await provisionDesktopOwnerLogin({instance,protect});assert.deepEqual(result,{configured:true,passwordChangeRequired:true,username:'admin'});
 const admin=await Administration.open({directory:path.join(instance,'data','administration')}),before=await admin.state(),entry=before.viewers[0],saved=JSON.parse(await fs.readFile(path.join(instance,'first-sign-in.json'),'utf8'));
 const decoded=JSON.parse((await protect(Buffer.from(saved.protectedCredentials,'base64'),saved.instanceId,{decrypt:true})).toString());
 assert.equal(decoded.username,'admin');assert.ok(decoded.password.length>=24);assert.equal(await verifyPassword(decoded.password,entry.passwordHash),true);assert.equal(entry.tokenHash,owner.tokenHash);
 assert.ok(!(await fs.readFile(path.join(instance,'first-sign-in.json'),'utf8')).includes(decoded.password));assert.ok(!JSON.stringify(before).includes(decoded.password));
 await provisionDesktopOwnerLogin({instance,protect});assert.deepEqual(await admin.state(),before);
 await admin.changePassword({id:'owner',actor:{id:'owner',role:'admin'},currentPassword:decoded.password,newPassword:personal});const configured=await admin.state();await provisionDesktopOwnerLogin({instance,protect});assert.deepEqual(await admin.state(),configured);
}));
test('two installations receive different temporary passwords',()=>fixture(async directory=>{const passwords=[];for(const name of ['a','b']){const instance=path.join(directory,name);await fs.mkdir(instance);await fs.writeFile(path.join(instance,'hub.json'),JSON.stringify({instanceId:crypto.randomUUID(),viewers:[owner],hosts:[]}));await provisionDesktopOwnerLogin({instance,protect});const saved=JSON.parse(await fs.readFile(path.join(instance,'first-sign-in.json'),'utf8'));passwords.push(JSON.parse((await protect(Buffer.from(saved.protectedCredentials,'base64'),saved.instanceId,{decrypt:true})).toString()).password);}assert.notEqual(passwords[0],passwords[1]);}));
test('temporary sign-in is restricted on the server until a different personal password is saved',()=>fixture(async directory=>{
 const passwordHash=await hashPassword(temporary),administration=await Administration.open({directory,initial:{viewers:[{...owner,username:'admin',passwordHash,passwordChangeRequired:true}]}}),securityState=await administration.state();
 let snapshotReads=0;
 const configuration=await ConfigurationStore.open({directory:path.join(directory,'configuration'),initial:structuredClone(DEFAULT_CONFIGURATION)});
 const server=createServer({administration,configuration,securityState,viewers:securityState.viewers,readSnapshot:async()=>{snapshotReads++;return {observedAt:new Date().toISOString(),host:{id:'TEST_ONLY-host'},hosts:[],sessions:[],events:[],coverage:{}};}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const request=async(route,{method='GET',body,cookie,key}={})=>{const response=await fetch(origin+route,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(key?{authorization:'Bearer '+key}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,text:await response.text(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
 try{
  const signed=await request('/api/session',{method:'POST',body:{username:'admin',password:temporary}});assert.equal(signed.status,200);assert.ok(signed.cookie);
  const page=await request('/',{cookie:signed.cookie});assert.match(page.text,/Set your personal password/);
  for(const route of ['/api/snapshot','/api/admin/users','/api/installation','/api/projects','/api/account/usage'])assert.equal((await request(route,{cookie:signed.cookie})).status,403,route);
  assert.equal((await request('/api/snapshot',{key:token})).status,403);assert.equal(snapshotReads,0);
  assert.equal((await request('/api/settings/password',{method:'POST',cookie:signed.cookie,body:{currentPassword:temporary,newPassword:temporary}})).status,400);
  assert.equal((await administration.state()).viewers[0].passwordChangeRequired,true);
  const changed=await request('/api/settings/password',{method:'POST',cookie:signed.cookie,body:{currentPassword:temporary,newPassword:personal}});assert.equal(changed.status,200,changed.text);
  assert.equal((await administration.state()).viewers[0].passwordChangeRequired,undefined);
  assert.equal((await request('/api/session',{method:'POST',body:{username:'admin',password:temporary}})).status,401);
  const normal=await request('/api/session',{method:'POST',body:{username:'admin',password:personal}});assert.equal(normal.status,200);assert.equal((await request('/api/admin/users',{cookie:normal.cookie})).status,200);assert.equal((await request('/api/snapshot',{key:token})).status,200);
  assert.ok(!JSON.stringify(await administration.audit()).includes(personal));
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}));
test('password-change requirement survives a new access service and cannot exist without a password verifier',async()=>{const hash=await hashPassword(temporary),access=new ViewerAccess({viewers:[{...owner,username:'admin',passwordHash:hash,passwordChangeRequired:true}]});assert.equal((await access.authenticatePassword('admin',temporary)).passwordChangeRequired,true);assert.throws(()=>new ViewerAccess({viewers:[{...owner,passwordChangeRequired:true}]}),/Invalid initial password/);});
