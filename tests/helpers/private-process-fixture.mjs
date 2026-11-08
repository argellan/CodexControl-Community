// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';

export async function processFixture(prefix) {
  const base = await fs.realpath(process.platform==='win32' ? path.join(os.homedir(),'ARGELLAN') : os.tmpdir());
  const root = await fs.mkdtemp(path.join(base,prefix));
  if (process.platform==='win32') {
    const script=String.raw`
$ErrorActionPreference='Stop'
try {
 $p=[Console]::In.ReadToEnd()
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 $acl=New-Object Security.AccessControl.DirectorySecurity
 $acl.SetAccessRuleProtection($true,$false)
 foreach($id in @($sid.Value,'S-1-5-18','S-1-5-32-544')){
  $principal=New-Object Security.Principal.SecurityIdentifier($id)
  $rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
 }
 [IO.Directory]::SetAccessControl($p,$acl)
}catch{exit 1}
`;
    await new Promise((resolve,reject)=>{
      const child=spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
        {stdio:['pipe','ignore','pipe'],windowsHide:true,shell:false});
      child.stderr.resume();child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('Fixture private ACL failed')));
      child.stdin.end(root);
    });
  } else await fs.chmod(root,0o700);
  return {root,async cleanup(){const target=await fs.realpath(root);assert.ok(target.startsWith(base+path.sep));await fs.rm(target,{recursive:true,force:true});}};
}
