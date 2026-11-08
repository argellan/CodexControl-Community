// Author: Bishop Crockett; Owner: Argellan.com; License: MIT; SPDX-License-Identifier: MIT
import process from 'node:process';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {normalizeProcessSamples} from './process-history.mjs';
const execute=promisify(execFile);
export function createProcessObserver(configuration){
 const epoch=crypto.randomUUID();let sequence=0,last=0,inflight=null;
 return {async poll(){
  if(configuration.processTelemetry?.enabled!==true||process.platform!=='win32'||Date.now()-last<30000)return [];
  if(inflight)return inflight;
  inflight=(async()=>{const {stdout}=await execute('C:\\Program Files\\PowerShell\\7\\pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('../scripts/process-sample.ps1',import.meta.url)),'-Sequence',String(++sequence)],{windowsHide:true,timeout:25000,maxBuffer:4000000});
   const raw=JSON.parse(stdout.replace(/^\uFEFF/,''));delete raw.overhead;raw.hostId=configuration.hostId;const frames=normalizeProcessSamples([{epoch,snapshot:raw}],configuration.hostId);last=Date.now();return frames;
  })().finally(()=>{inflight=null;});return inflight;
 }};
}
