// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {Administration} from './administration.mjs';
import {verifyPassword} from './password-auth.mjs';
import {atomicJSON,readJSONFile} from './installation-storage.mjs';
const purpose='ARGELLAN/CodexControl/first-sign-in/v1/';
export async function protectDesktopCredential(value,instanceId,{decrypt=false}={}){
 if(process.platform!=='win32')throw new Error('Windows credential protection required');
 const action=decrypt?'Unprotect':'Protect';
 const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$inputValue=[Console]::In.ReadToEnd();$envelope=$inputValue|ConvertFrom-Json;$entropy=[Text.Encoding]::UTF8.GetBytes('${purpose}'+$envelope.instanceId);$bytes=[Convert]::FromBase64String($envelope.value);$result=[Security.Cryptography.ProtectedData]::${action}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($result))`;
 const input=JSON.stringify({instanceId,value:Buffer.from(value).toString('base64')});
 return new Promise((resolve,reject)=>{
  const child=spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdio:['pipe','pipe','pipe'],windowsHide:true});let output='',settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
  const timer=setTimeout(()=>{child.kill();finish(new Error('Windows credential protection timed out'));},10000);
  child.stdout.on('data',b=>{output+=String(b);if(output.length>32768){child.kill();finish(new Error('Credential protection result exceeded bound'));}});child.stderr.resume();child.stdin.on('error',()=>{});
  child.once('error',()=>finish(new Error('Windows credential protection unavailable')));child.once('close',code=>{if(code!==0||!/^[A-Za-z0-9+/=]+$/.test(output))finish(new Error('Windows credential protection unavailable'));else finish(null,Buffer.from(output,'base64'));});child.stdin.end(input);
 });
}
export async function provisionDesktopOwnerLogin({instance,protect=protectDesktopCredential,random=()=>crypto.randomBytes(18).toString('base64url')}={}){
 if(!path.isAbsolute(instance||'')||/^(?:\\\\|\/\/)/.test(instance))throw new Error('A local installation directory is required');
 const hub=await readJSONFile(path.join(instance,'hub.json')),directory=path.join(instance,'data','administration');
 const administration=await Administration.open({directory,initial:{instanceId:hub.instanceId,viewers:hub.viewers,hosts:hub.hosts||[],viewTokenHash:hub.viewTokenHash??null}});
 const state=await administration.state(),owner=state.viewers.find(v=>v.id==='owner');
 if(!owner||owner.role!=='admin'||owner.disabled||owner.hostIds!==null||owner.projectIds!==null)throw new Error('The installation owner is unavailable');
 if(owner.passwordHash)return {configured:true,passwordChangeRequired:owner.passwordChangeRequired===true,username:owner.username};
 if(state.viewers.some(v=>v.passwordHash))throw new Error('Existing password accounts are preserved; use account settings');
 const file=path.join(instance,'first-sign-in.json');let credential;
 try{
  const saved=await readJSONFile(file,32768);if(saved.schemaVersion!==1||saved.instanceId!==hub.instanceId)throw new Error('Initial account identity mismatch');
  credential=JSON.parse((await protect(Buffer.from(saved.protectedCredentials,'base64'),hub.instanceId,{decrypt:true})).toString('utf8'));
 }catch(error){if(error.code!=='ENOENT')throw error;credential={username:'admin',password:'Cc!'+random()};const bytes=await protect(Buffer.from(JSON.stringify(credential)),hub.instanceId);await atomicJSON(file,{schemaVersion:1,instanceId:hub.instanceId,protectedCredentials:bytes.toString('base64')});}
 if(credential.username!=='admin'||typeof credential.password!=='string')throw new Error('Initial account credential is invalid');
 await administration.saveUser({revision:state.revision,actor:{id:'owner',role:'admin'},user:{id:'owner',username:credential.username,password:credential.password,passwordChangeRequired:true}});
 const current=(await administration.state()).viewers.find(v=>v.id==='owner');if(!current.passwordChangeRequired||!await verifyPassword(credential.password,current.passwordHash))throw new Error('Initial account verification failed');
 return {configured:true,passwordChangeRequired:true,username:'admin'};
}
