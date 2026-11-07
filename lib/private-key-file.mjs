// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

const WINDOWS_POWERSHELL='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const ACL_SCRIPT=String.raw`$ErrorActionPreference='Stop'
try {
 $request=[Console]::In.ReadToEnd() | ConvertFrom-Json
 $acl=[IO.File]::GetAccessControl($request.path)
 $current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $trusted=@($current,'S-1-5-18','S-1-5-32-544')
 if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'Refused' }
 foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted) { throw 'Refused' }
 }
 [Console]::Out.Write('PRIVATE_KEY_ACL_OK')
} catch { [Console]::Out.Write('PRIVATE_KEY_ACL_REFUSED'); exit 1 }`;

function refuse(){return new Error('TLS private key must be a bounded owner-private regular file');}
async function checkWindowsAcl(file){
 return new Promise((resolve,reject)=>{
  let child,output='',bytes=0,settled=false,timer;
  const finish=ok=>{if(settled)return;settled=true;clearTimeout(timer);ok?resolve():reject(refuse());};
  try{child=spawn(WINDOWS_POWERSHELL,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ACL_SCRIPT,'utf16le').toString('base64')],{stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});}catch{reject(refuse());return;}
  timer=setTimeout(()=>{child.kill('SIGTERM');finish(false);},5000);
  child.on('error',()=>finish(false));child.stdin.on('error',()=>finish(false));
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024){child.kill('SIGTERM');finish(false);}else output+=chunk.toString('utf8');});
  child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024){child.kill('SIGTERM');finish(false);}});
  child.on('close',code=>finish(code===0&&output==='PRIVATE_KEY_ACL_OK'));
  child.stdin.end(JSON.stringify({path:file}));
 });
}

export async function readPrivateKeyFile(file,{maxBytes=1048576}={}){
 if(typeof file!=='string'||!path.isAbsolute(file)||file.length>1024||/[\x00-\x1f\x7f]/.test(file)||/^(?:\\\\|\/\/)/.test(file))throw refuse();
 const resolved=path.resolve(file),before=await fs.lstat(resolved);
 if(!before.isFile()||before.isSymbolicLink()||before.size<1||before.size>maxBytes)throw refuse();
 const handle=await fs.open(resolved,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const stat=await handle.stat();
  if(!stat.isFile()||stat.size<1||stat.size>maxBytes||stat.ino!==before.ino||stat.dev!==before.dev)throw refuse();
  if(process.platform==='win32')await checkWindowsAcl(resolved);
  else if(stat.uid!==process.getuid()||(stat.mode&0o077)!==0)throw refuse();
  const bytes=await handle.readFile();if(bytes.length<1||bytes.length>maxBytes)throw refuse();return bytes;
 }finally{await handle.close();}
}
