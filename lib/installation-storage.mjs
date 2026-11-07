// Author: Bishop Crockett
// Owner: Argellan.com
// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
const protectedDirectories=new Set();
export const digest=value=>crypto.createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
export function failure(message,status=400){return Object.assign(new Error(message),{status});}
export async function privateDirectory(directory){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||/^(?:\\\\|\/\/)/.test(directory))throw failure('Installation state requires an absolute local directory');
 await fs.mkdir(directory,{recursive:true,mode:0o700});const st=await fs.lstat(directory);if(!st.isDirectory()||st.isSymbolicLink())throw failure('Installation directory must be local and owned',503);
 if(protectedDirectories.has(directory))return;
 if(process.platform==='win32'){
  const script=String.raw`$ErrorActionPreference='Stop'; try {$p=([Console]::In.ReadToEnd()|ConvertFrom-Json).path; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); foreach($identity in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {$principal=New-Object Security.Principal.SecurityIdentifier($identity);$rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)}; [IO.Directory]::SetAccessControl($p,$acl);[Console]::Out.Write('PRIVATE_OK')}catch{exit 1}`;
  await new Promise((resolve,reject)=>{const child=spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});let out='';const timer=setTimeout(()=>{child.kill();reject(failure('Private installation ACL unavailable',503));},5000);child.stdout.on('data',b=>{out+=String(b);if(out.length>1024)child.kill();});child.stderr.resume();child.stdin.on('error',()=>{});child.once('error',()=>{clearTimeout(timer);reject(failure('Private installation ACL unavailable',503));});child.once('close',code=>{clearTimeout(timer);code===0&&out==='PRIVATE_OK'?resolve():reject(failure('Private installation ACL unavailable',503));});child.stdin.end(JSON.stringify({path:directory}));});
 }else await fs.chmod(directory,0o700);
 protectedDirectories.add(directory);
}
export async function readJSONFile(file,maxBytes=4194304){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maxBytes)throw failure('Installation state exceeds bound or is unsafe',503);return JSON.parse(await fs.readFile(file,'utf8'));}
export async function atomicJSON(file,value,verify=()=>{},maxBytes=4194304){if(!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>33554432)throw failure('Invalid private record bound');const bytes=JSON.stringify(value);if(Buffer.byteLength(bytes)>maxBytes)throw failure('Installation record exceeds bound',413);const temp=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';let handle;try{handle=await fs.open(temp,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;verify();await fs.rename(temp,file);if(process.platform!=='win32'){const dir=await fs.open(path.dirname(file),'r');try{await dir.sync();}finally{await dir.close();}}}finally{await handle?.close().catch(()=>{});await fs.unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}}
export async function appendAudit(file,record){const handle=await fs.open(file,'a',0o600);try{await handle.writeFile(JSON.stringify(record)+'\n');await handle.sync();}finally{await handle.close();}}
