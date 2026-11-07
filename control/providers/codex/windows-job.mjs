// Author: Bishop Crockett
// Owner: Argellan.com
import fs from 'node:fs';import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';import {spawnSync} from 'node:child_process';
import {ControlError} from '../../lib/errors.mjs';
import {strictRecord,deepFreeze} from '../../lib/privacy.mjs';
import {assertLocalOwner,localDirectory} from '../../broker/local-owner.mjs';
const instances=new WeakSet(),sourceFile=new URL('./windows-job-host.cs',import.meta.url);
const fail=code=>{throw new ControlError(code);};
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export class WindowsJobHost {
 #directory;#owner;#executable;#stat;#fd;#sourceHash;#binaryHash;#closed=false;
 static create(options){return new WindowsJobHost(options);}
 constructor(options){
  strictRecord(options,['directory','owner']);if(process.platform!=='win32')fail('CONTROL_DISABLED');
  this.#directory=localDirectory(options.directory);assertLocalOwner(options.owner,this.#directory);this.#owner=options.owner;
  const source=fs.readFileSync(sourceFile);this.#sourceHash=createHash('sha256').update(source).digest('hex');
  const sourceCopy=path.join(this.#directory,'owned-job-host.cs');this.#executable=path.join(this.#directory,'owned-job-host.exe');
  if(fs.existsSync(sourceCopy)||fs.existsSync(this.#executable))fail('CONFLICT');fs.writeFileSync(sourceCopy,source,{flag:'wx',mode:0o600});
  const compiler=path.join(process.env.SystemRoot??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const result=spawnSync(compiler,['/nologo','/target:exe','/platform:x64','/optimize+','/out:'+this.#executable,sourceCopy],{windowsHide:true,shell:false,stdio:'ignore',timeout:20000});
  if(result.status!==0)fail('CONTROL_DISABLED');
  this.#stat=fs.lstatSync(this.#executable,{bigint:true});if(!this.#stat.isFile()||this.#stat.isSymbolicLink()||this.#stat.nlink!==1n)fail('CONTROL_DISABLED');
  this.#fd=fs.openSync(this.#executable,fs.constants.O_RDONLY);this.#binaryHash=hash(this.#executable);instances.add(this);
 }
 assertCurrent(){if(this.#closed)fail('CLOSED');this.#owner.assertCurrent();const current=fs.lstatSync(this.#executable,{bigint:true}),held=fs.fstatSync(this.#fd,{bigint:true});if(current.dev!==this.#stat.dev||current.ino!==this.#stat.ino||current.size!==this.#stat.size||current.mtimeNs!==this.#stat.mtimeNs||held.ino!==current.ino||hash(sourceFile)!==this.#sourceHash||hash(this.#executable)!==this.#binaryHash)fail('STALE_CONTEXT');}
 plan(nativePlan){
  this.assertCurrent();if(!nativePlan||typeof nativePlan.executable!=='string'||!path.isAbsolute(nativePlan.executable)||!Array.isArray(nativePlan.args)||nativePlan.args.some(x=>typeof x!=='string'))fail('INVALID_INPUT');
  const nonce=randomUUID(),statusFile=path.join(this.#directory,'job-'+nonce+'.json'),stopFile=path.join(this.#directory,'stop-'+nonce);
  const proof=hostPid=>{try{const stat=fs.lstatSync(statusFile);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)return {processTreeExitConfirmed:false};const value=JSON.parse(fs.readFileSync(statusFile,'utf8'));if(value.version!==1||value.nonce!==nonce||value.hostPid!==hostPid||value.phase!=='EXITED'||value.assignedBeforeResume!==true||value.rootExited!==true||value.activeProcesses!==0||value.breakawayAllowed!==false||!Number.isSafeInteger(value.totalProcesses)||value.totalProcesses<1||!Number.isSafeInteger(value.nativePid)||value.nativePid<1||typeof value.nativeCreationFileTime!=='string'||!/^\d+$/.test(value.nativeCreationFileTime)||value.jobMemoryLimitBytes!==536870912||value.maxProcesses!==16||value.failure!=='')return {processTreeExitConfirmed:false};return deepFreeze({processTreeExitConfirmed:true,assignedBeforeResume:true,activeProcesses:0,totalProcesses:value.totalProcesses,breakawayAllowed:false,nativePid:value.nativePid,nativeCreationFileTime:value.nativeCreationFileTime,nativeExitCode:value.nativeExitCode,jobMemoryLimitBytes:value.jobMemoryLimitBytes,maxProcesses:value.maxProcesses});}catch{return {processTreeExitConfirmed:false};}};
  const control=Object.freeze({statusFile,requestStop(){if(fs.existsSync(stopFile)){if(fs.readFileSync(stopFile,'utf8')!==nonce)fail('STALE_CONTEXT');return;}fs.writeFileSync(stopFile,nonce,{flag:'wx',mode:0o600});},proof});
  return {executable:this.#executable,args:[statusFile,stopFile,nonce,nativePlan.executable,...nativePlan.args],options:nativePlan.options,control};
 }
 close(){if(this.#closed)return;this.#closed=true;fs.closeSync(this.#fd);}
}
export function assertWindowsJobHost(value,nativePlan=undefined){if(!instances.has(value))fail('CONTROL_DISABLED');if(nativePlan!==undefined)return WindowsJobHost.prototype.plan.call(value,nativePlan);value.assertCurrent();}