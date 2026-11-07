// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import os from 'node:os';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile),hash=s=>crypto.createHash('sha256').update(s).digest('hex').slice(0,28);
const clean=value=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,160).toWellFormed():null;
let previousCpu;
export async function serviceHealth(units=[],{platform=process.platform,execute:run=execute}={}){
 const result=[];
 const pattern=platform==='win32'?/^[a-zA-Z0-9@_.:-]{1,100}$/:/^[a-zA-Z0-9@_.:-]{1,100}\.service$/;
 for(const unit of units.filter(s=>typeof s==='string'&&pattern.test(s)).slice(0,12)){
  if(platform==='win32'){
   // Service names are allowlisted before interpolation; no caller command/SQL,
   // elevation, Start/Stop-Service, state mutation or command arguments collected.
   const script="$ErrorActionPreference='Stop';$s=Get-CimInstance -ClassName Win32_Service -Filter \"Name='"+unit+"'\";if($null -eq $s){exit 2};@{Id=$s.Name;ActiveState=if($s.State -eq 'Running'){'active'}elseif($s.State -eq 'Stopped'){'inactive'}else{'unknown'};SubState=$s.State;MainPID=$s.ProcessId;MemoryCurrent=$null;CPUUsageNSec=$null}|ConvertTo-Json -Compress";
   try{const {stdout}=await run('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:1500,maxBuffer:8192,windowsHide:true,shell:false});
    const value=JSON.parse(stdout);if(value.Id!==unit||!['active','inactive','unknown'].includes(value.ActiveState)||typeof value.SubState!=='string'||!Number.isInteger(value.MainPID)||value.MainPID<0)throw new Error('Invalid native service reading');
    result.push({unit,state:value.ActiveState,subState:clean(value.SubState),pid:value.MainPID||null,memory:null,cpuNanoseconds:null});
   }catch{result.push({unit,state:'unavailable'});}continue;
  }
  try{const {stdout}=await run('systemctl',['show',unit,'--property=Id,ActiveState,SubState,MainPID,MemoryCurrent,CPUUsageNSec'],{timeout:1500,maxBuffer:8192});const values=Object.fromEntries(stdout.trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));result.push({unit,state:clean(values.ActiveState),subState:clean(values.SubState),pid:Number(values.MainPID)||null,memory:Number(values.MemoryCurrent)||null,cpuNanoseconds:Number(values.CPUUsageNSec)||null});}catch{result.push({unit,state:'unavailable'});}
 }
 return result;
}
export async function readJobFeed(file,hostId){
 const allowed=new Set('id type at jobId project label workerHostId workerSessionId workerCallId outcome progress'.split(' ')),events=[],sessions=new Map();let invalid=0;
 const handle=await fs.open(file,'r');try{
  const stat=await handle.stat(),offset=Math.max(0,stat.size-262144),buffer=Buffer.alloc(stat.size-offset);await handle.read(buffer,0,buffer.length,offset);const lines=buffer.toString('utf8').split('\n');if(offset)lines.shift();lines.pop();
  for(const line of lines){if(!line.trim())continue;try{
   const r=JSON.parse(line),types={job_started:'remote.start',job_completed:'remote.end',job_failed:'remote.end',job_progress:'remote.progress'};
   if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!allowed.has(k))||typeof r.type!=='string'||!Object.hasOwn(types,r.type)||typeof r.id!=='string'||!r.id||typeof r.jobId!=='string'||!r.jobId||!Number.isFinite(Date.parse(r.at))){invalid++;continue;}
    const jobId=clean(r.jobId),id='job-'+hash(jobId),label=clean(r.label)||'Remote job',project=clean(r.project),outcome=r.type==='job_failed'?'failed':r.type==='job_completed'?'completed':'observed';
    events.push({id:hash(hostId+'|'+jobId+'|'+r.id),sourceId:'jobs:'+hostId,hostId,sessionId:id,project:project||'Remote work',...(project?{projectBasis:'source-context'}:{}),at:new Date(r.at).toISOString(),timeOrigin:'source',receivedAt:new Date().toISOString(),delivery:'backfill',kind:types[r.type],category:'remote',label:label+' / '+r.type.replace('job_',''),callId:jobId,jobId,workerHostId:clean(r.workerHostId),workerSessionId:clean(r.workerSessionId),workerCallId:clean(r.workerCallId),outcome,progress:typeof r.progress==='number'&&r.progress>=0&&r.progress<=100?r.progress:null});
    sessions.set(id,{id,hostId,project:project||'Remote work',role:'execution-job',nickname:label,parentId:clean(r.workerSessionId),workerHostId:clean(r.workerHostId),workerCallId:clean(r.workerCallId),model:null,state:r.type==='job_failed'?'Job failed':r.type==='job_completed'?'Job completed · acceptance unverified':'Job activity recorded',lastEventAt:r.at,tools:0,changes:0,tokens:null,contextWindow:null});
  }catch{invalid++;}}
  return {events:events.slice(-600),sessions:[...sessions.values()].slice(-128),invalid,tailLimited:offset>0};
 }finally{await handle.close();}
}
export async function sampleTarget(configuration){
 const totals=os.cpus().reduce((sum,cpu)=>{sum.idle+=cpu.times.idle;sum.total+=Object.values(cpu.times).reduce((a,b)=>a+b,0);return sum;},{idle:0,total:0});
 const cpu=previousCpu?Math.max(0,Math.min(100,100*(1-(totals.idle-previousCpu.idle)/Math.max(1,totals.total-previousCpu.total)))):null;previousCpu=totals;
 let jobs={events:[],sessions:[]},feed='not configured';if(configuration.jobFile){try{jobs=await readJobFeed(configuration.jobFile,configuration.hostId);feed='observed';}catch{feed='unavailable';}}
 return {observedAt:new Date().toISOString(),host:{id:configuration.hostId,name:os.hostname(),platform:os.platform(),node:process.version,cpu,cores:os.cpus().length,totalMemory:os.totalmem(),freeMemory:os.freemem(),uptime:os.uptime(),services:await serviceHealth(configuration.services||[])},sessions:jobs.sessions,events:jobs.events,coverage:{role:'execution-target',jobFeed:feed,invalidRecords:jobs.invalid||0,completeHistory:false}};
}
