import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ControlError} from '../lib/errors.mjs';
import {strictRecord} from '../lib/privacy.mjs';
const instances=new WeakSet();
const script = "$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd()|ConvertFrom-Json; $s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $a=if($p.file){[System.IO.File]::GetAccessControl($p.file)}else{[System.IO.Directory]::GetAccessControl($p.directory)}; $o=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; $ok=($s -eq $p.account -and $o -eq $s); foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin @($s,'S-1-5-18','S-1-5-32-544')) {$ok=$false} }; @{ok=$ok;account=$s}|ConvertTo-Json -Compress";
export function localDirectory(directory) {
  if (typeof directory!=='string' || !path.isAbsolute(directory) || /^(?:\\\\|\/\/)/.test(directory)) throw new ControlError('INVALID_INPUT');
  const resolved=path.resolve(directory);
  for(let current=resolved;;current=path.dirname(current)) {
    const stat=fs.lstatSync(current);
    if(stat.isSymbolicLink() || !stat.isDirectory()) throw new ControlError('INVALID_INPUT');
    if(path.dirname(current)===current)break;
  }
  const real=fs.realpathSync.native(resolved);
  if(/^(?:\\\\|\/\/)/.test(real) || [0x6969,0x517b,0xff534d42].includes(fs.statfsSync(real).type))throw new ControlError('INVALID_INPUT');
  return real;
}
/** Explicit owner-local entry point; no path/config value alone grants authority. */
export class LocalOwnerBoundary {
  #directory; #account;
  static open(options) { try{return new LocalOwnerBoundary(options);}catch{throw new ControlError('CONTROL_DISABLED');} }
  constructor(options) {
    strictRecord(options,['directory','account']);
    if(typeof options.account!=='string'||options.account.length>128)throw new ControlError('INVALID_INPUT');
    this.#directory=localDirectory(options.directory);this.#account=options.account;
    this.#verify();instances.add(this);Object.freeze(this);
  }
  #verify(file=null) {
    try {
      localDirectory(this.#directory);
      if(process.platform==='win32') {
        const executable=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
        const result=spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{input:JSON.stringify({directory:this.#directory,account:this.#account,file}),encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:4096,shell:false});
        if(result.status!==0||JSON.parse(result.stdout).ok!==true)throw 0;
      }else{
        const stat=fs.statSync(file??this.#directory);
        if(String(process.geteuid())!==this.#account||stat.uid!==process.geteuid()||(stat.mode&0o077)!==0)throw 0;
      }
    }catch{throw new ControlError('CONTROL_DISABLED');}
    return true;
  }
  assertCurrent() { return this.#verify(); }
  readPrivateFile(file){
    if(typeof file!=='string'||!path.isAbsolute(file)||path.dirname(path.resolve(file))!==this.#directory)throw new ControlError('INVALID_INPUT');
    let fd;
    try{
      this.#verify(file);const before=fs.lstatSync(file,{bigint:true});
      if(before.isSymbolicLink()||!before.isFile()||before.nlink!==1n||before.size<1n||before.size>524288n)throw 0;
      fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
      const held=fs.fstatSync(fd,{bigint:true});if(held.ino!==before.ino||held.dev!==before.dev)throw 0;
      const bytes=Buffer.alloc(Number(held.size));if(fs.readSync(fd,bytes,0,bytes.length,0)!==bytes.length)throw 0;
      const after=fs.lstatSync(file,{bigint:true});if(after.ino!==held.ino||after.dev!==held.dev||after.size!==held.size||after.mtimeNs!==held.mtimeNs)throw 0;
      this.#verify(file);return bytes;
    }catch{throw new ControlError('CONTROL_DISABLED');}finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  get directory() { return this.#directory; }
}
export function assertLocalOwner(value,directory) {
  if(!instances.has(value)||value.directory!==localDirectory(directory))throw new ControlError('CONTROL_DISABLED');
  value.assertCurrent();
}
