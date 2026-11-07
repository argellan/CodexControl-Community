// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import path from 'node:path';
import {lstat,realpath,opendir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile),same=(a,b)=>a.toLowerCase()===b.toLowerCase();
const unavailable=()=>Object.assign(new Error('Verified desktop executable unavailable'),{code:'ENOENT'});
export async function verifyOpenAIExecutable(executable,{signal,timeoutMs}={}){
 const systemRoot=process.env.SystemRoot||'C:/Windows',shell=path.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const literal=executable.replaceAll("'","''"),script="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$s=Get-AuthenticodeSignature -LiteralPath '"+literal+"';[pscustomobject]@{valid=($s.Status -eq 'Valid');publisher=if($s.SignerCertificate){$s.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)}else{''}}|ConvertTo-Json -Compress";
 const {stdout}=await execute(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{signal,timeout:Math.max(1,Math.min(5000,timeoutMs)),windowsHide:true,maxBuffer:8192,encoding:'utf8',env:{...process.env,PSModulePath:path.join(systemRoot,'System32','WindowsPowerShell','v1.0','Modules')}});
 const result=JSON.parse(stdout.replace(/^\uFEFF/,''));return result.valid===true&&result.publisher==='OpenAI OpCo, LLC';
}
// Explicit opt-in follows only this install layout. No PATH, process enumeration,
// network share, package manager, account mutation or provider dispatch is used.
export class DesktopExecutableResolver{
 constructor({platform=process.platform,localAppData=process.env.LOCALAPPDATA,verify=verifyOpenAIExecutable,clock=()=>performance.now()}={}){Object.assign(this,{platform,localAppData,verify,clock});this.verified=new Map();}
 async resolve(configured,{timeoutMs=6000,signal}={}){
  if(this.platform!=='win32'||!this.localAppData)throw unavailable();
  const root=path.resolve(this.localAppData,'OpenAI','Codex','bin'),relative=path.relative(root,path.resolve(configured));
  if(!/^[a-f0-9]{16}[\\/]codex\.exe$/i.test(relative))throw unavailable();
  const deadline=this.clock()+Math.min(6000,timeoutMs),check=()=>{if(signal?.aborted||this.clock()>=deadline)throw unavailable();};check();
  if(!same(await realpath(root),root)||(await lstat(root)).isSymbolicLink())throw unavailable();
  const inspect=async name=>{check();const directory=path.join(root,name),exe=path.join(directory,'codex.exe');try{const dir=await lstat(directory);if(!dir.isDirectory()||dir.isSymbolicLink()||!same(await realpath(directory),directory))return null;const file=await lstat(exe);if(!file.isFile()||file.isSymbolicLink()||file.size<=0||!same(await realpath(exe),exe))return null;return {exe,key:[exe.toLowerCase(),file.size,file.mtimeMs,file.ctimeMs,file.ino].join('|'),mtime:file.mtimeMs};}catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))return null;throw error;}};
  const names=[];let entries=0;const directory=await opendir(root);try{for await(const entry of directory){check();if(++entries>64)throw unavailable();if(/^[a-f0-9]{16}$/i.test(entry.name))names.push(entry.name);}}finally{await directory.close().catch(()=>{});}
  const candidates=[];for(const name of names){const item=await inspect(name);if(item)candidates.push(item);}
  candidates.sort((a,b)=>Number(same(b.exe,path.resolve(configured)))-Number(same(a.exe,path.resolve(configured)))||b.mtime-a.mtime||a.exe.localeCompare(b.exe));
  for(const item of candidates){check();let valid=this.verified.has(item.key);if(!valid){try{valid=await this.verify(item.exe,{signal,timeoutMs:Math.max(1,deadline-this.clock())});}catch{valid=false;}check();if(valid){if(this.verified.size>=4)this.verified.delete(this.verified.keys().next().value);this.verified.set(item.key,true);}}
   if(valid&&(await inspect(path.basename(path.dirname(item.exe))))?.key===item.key)return item.exe;
  }
  throw unavailable();
 }
}
