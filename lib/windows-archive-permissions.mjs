// Author: Bishop Crockett
// Owner: Argellan.com
// SPDX-License-Identifier: MIT
import path from 'node:path';import {spawn} from 'node:child_process';
const refusal=()=>Object.assign(new Error('ARCHIVE_CONFIG_PERMISSIONS'),{code:'ARCHIVE_CONFIG_PERMISSIONS'});
const sid=s=>typeof s==='string'&&/^S-\d+(?:-\d+){1,16}$/.test(s);
export function validateWindowsArchiveDescriptor(info,current,{privateFile=false,ancestor=false,volumeRoot=false}={}){
 if(!info||!sid(current)||info.filesystem!=='NTFS'||info.fixed!==true||info.reparse!==false||info.nullDacl===true||info.unknownAces===true||!Array.isArray(info.allows)||info.allows.length>1024)throw refusal();
 const trusted=new Set([current,'S-1-5-18','S-1-5-32-544']);if(!trusted.has(info.owner)&&!(ancestor&&volumeRoot&&!privateFile&&info.owner==='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'))throw refusal();
 for(const r of info.allows){if(!r||!sid(r.sid)||!Number.isInteger(r.mask)||r.mask<0||r.mask>0xffffffff||typeof r.inheritOnly!=='boolean')throw refusal();if(r.inheritOnly)continue;
  if(!trusted.has(r.sid)&&!(r.sid==='S-1-3-4'&&trusted.has(info.owner))&&(privateFile||(r.mask&(0x500d0040|(ancestor?0:6)))!==0))throw refusal();}
}
const SCRIPT=String.raw`$ErrorActionPreference='Stop'
try {
 $request=[Console]::In.ReadToEnd()|ConvertFrom-Json;$checks=@()
 foreach($entry in $request.paths){
  $selected=[IO.Path]::GetFullPath($entry.path);$walk=$selected;$chain=@()
  while($walk){
   if($chain.Count -ge 32){throw 'Refused'}
   $item=Get-Item -LiteralPath $walk -Force;$acl=Get-Acl -LiteralPath $walk
   $raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
   if($null -eq $raw.DiscretionaryAcl){throw 'Refused'}
   foreach($ace in $raw.DiscretionaryAcl){if([int]$ace.AceType -notin @(0,1)){throw 'Refused'}}
   $allows=@()
   foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq 'Allow'){
    $mask=[BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$rule.FileSystemRights),0)
    $allows+=@{sid=$rule.IdentityReference.Value;mask=[long]$mask;inheritOnly=([int]$rule.PropagationFlags -band 2)-ne 0}
   }}
   $root=[IO.Path]::GetPathRoot($walk);$drive=[IO.DriveInfo]::new($root)
   $chain+=@{path=$walk;owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;filesystem=$drive.DriveFormat;fixed=$drive.DriveType -eq 'Fixed';reparse=([int]$item.Attributes -band 1024)-ne 0;allows=$allows}
   if($walk.TrimEnd('\') -eq $root.TrimEnd('\')){$walk=$null}else{$walk=[IO.Path]::GetDirectoryName($walk)}
  }
  $checks+=@{path=$selected;chain=$chain}
 }
 @{currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;checks=$checks}|ConvertTo-Json -Depth 12 -Compress
} catch {exit 1}`;
async function collect(paths){
 return new Promise((resolve,reject)=>{let child,timer,bytes=0,output='',done=false;
  const finish=value=>{if(done)return;done=true;clearTimeout(timer);value?resolve(value):reject(refusal());};
  try{child=spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(SCRIPT,'utf16le').toString('base64')],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false,env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});}catch{finish();return;}
  timer=setTimeout(()=>{child.kill();finish();},5000);child.on('error',()=>finish());child.stdin.on('error',()=>finish());
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>262144){child.kill();finish();}else output+=chunk.toString('utf8');});
  child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>262144){child.kill();finish();}});
  child.on('close',code=>{if(code!==0){finish();return;}try{finish(JSON.parse(output));}catch{finish();}});child.stdin.end(JSON.stringify({paths}));
 });
}
export async function verifyWindowsArchivePaths(request,{platform=process.platform,collect:read=collect}={}){
 if(platform!=='win32')return;
 try{
  if(!Array.isArray(request)||request.length<1||request.length>8)throw refusal();
  for(const r of request)if(!r||typeof r.path!=='string'||r.path.length>1024||! /^[A-Za-z]:\\/.test(r.path)||/[\x00-\x1f]/.test(r.path)||path.win32.normalize(r.path)!==r.path||typeof r.privateFile!=='boolean')throw refusal();
  const response=await read(request);if(!sid(response?.currentSid)||!Array.isArray(response.checks)||response.checks.length!==request.length)throw refusal();
  for(let i=0;i<request.length;i++){
   const r=request[i],check=response.checks[i];if(check?.path?.toLowerCase()!==r.path.toLowerCase()||!Array.isArray(check.chain))throw refusal();
   const expected=[];let p=r.path;while(p){expected.push(p);const parent=path.win32.dirname(p);if(parent===p)break;p=parent;}
   if(check.chain.length!==expected.length)throw refusal();
   for(let j=0;j<expected.length;j++){const d=check.chain[j];if(d?.path?.toLowerCase()!==expected[j].toLowerCase())throw refusal();validateWindowsArchiveDescriptor(d,response.currentSid,{privateFile:j===0&&r.privateFile,ancestor:j>0,volumeRoot:j===expected.length-1});}
  }
 }catch{throw refusal();}
}
