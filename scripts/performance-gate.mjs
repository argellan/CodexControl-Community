// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
export const REQUIRED_SCENARIOS=Object.freeze(['laptop-1366x620','laptop-1280x600','scaled-1024x480','desktop-1920x1080','phone-390x844','tablet-768x1024','ribbon-1366x620','reduced-1366x620']);
export const SCENARIO_PROFILES=Object.freeze(Object.fromEntries(REQUIRED_SCENARIOS.map(id=>{const [width,height]=id.match(/(\d+)x(\d+)/).slice(1).map(Number);return [id,Object.freeze({width,height,deviceScaleFactor:1,overview:'full',flowView:id.startsWith('ribbon-')?'curtain':'map',planeWorkers:8,reduced:id.startsWith('reduced-'),paused:false,mode:'live',host:'',project:'',category:'',session:'',windowMs:60000,mobileView:width<=1100?'overview':null,mobileMap:width<=1100&&(width<=700||height<=500)?'open':null})];})));
export const PERFORMANCE_BUDGETS=Object.freeze({frameP99Ms:33.4,worstFrameMs:66.8,longTaskCount:0,renderStageP95Ms:25,renderStageMaxMs:49,updateLatencyP95Ms:500,ingestionLatencyP95Ms:2000,wireBytesPerSecond:65536,heapGrowthBytesPerMinute:8388608,apiErrors:0,pollIntervalP95Ms:1500});
// Owner-adopted reference from two completed feature-complete samples, not full qualification.
export const CPU_REFERENCE=Object.freeze({id:'owner-adopted-20261108',scenario:'laptop-1366x620',medianMsPerUpdate:229.7818,sampleCount:2,sourceDigest:'450d925ee311285b68559368e4a8ea77c21e151daac7c952fd832b7a6e924916',workloadDigest:'041c32b1efe8c8c5d0e5f2063ac52a1ad26a5ebf0ed62def039d0fec1dbe1cb2',platform:'darwin',browserVersion:'156.0.8078.47',gpuRenderer:'ANGLE (Intel, ANGLE Metal Renderer: Intel(R) UHD Graphics 630, Version 26.6.2 (Build 25G83))'});
export function cpuComparisonReference(report,scenario,pairedMedian){
 const environment=report?.cpuReferenceEnvironment;
 return scenario===CPU_REFERENCE.scenario&&report.workloadDigest===CPU_REFERENCE.workloadDigest&&environment?.platform===CPU_REFERENCE.platform&&environment.browserVersion===CPU_REFERENCE.browserVersion&&environment.gpuRenderer===CPU_REFERENCE.gpuRenderer?CPU_REFERENCE.medianMsPerUpdate:pairedMedian;
}
export function runtimeDigest(files,runtime){const names=new Set(runtime);return sha(JSON.stringify(files.filter(f=>names.has(f.source??f.path)).map(f=>[f.source??f.path,f.sha256]).sort((a,b)=>a[0].localeCompare(b[0]))));}
export function validatePerformanceEvidence(report,{candidateDigest}={}){
 const problems=[],bad=message=>problems.push(message),hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
 if(report?.schemaVersion!==1||report?.candidateDigest!==candidateDigest||!hash(candidateDigest)||!hash(report?.baselineDigest)||!hash(report?.workloadDigest))bad('Missing or stale source/workload binding');
 if(typeof report?.browser!=='string'||!report.browser||report.cpuThrottling!==1||report?.mode!=='measured-browser')bad('Missing controlled browser environment');
 const cases=Array.isArray(report?.scenarios)?report.scenarios:[],ids=cases.map(c=>c.id);if(new Set(ids).size!==ids.length)bad('Duplicate scenario');
 for(const id of REQUIRED_SCENARIOS){const scenario=cases.find(c=>c.id===id);if(!scenario){bad('Missing scenario '+id);continue;}
  for(const phase of ['baseline','candidate']){const samples=scenario[phase];if(!Array.isArray(samples)||samples.length<3){bad(id+' missing repeated '+phase+' samples');continue;}
   for(const [index,s] of samples.entries()){
    const prefix=id+'/'+phase+'/'+index;
    if(s.ingestionTimeBasis!=='captured-to-journal-commit/post-warmup-window'||!finite(s.measurementStartedAt)||!Number.isSafeInteger(s.ingestionSampleCount)||s.ingestionSampleCount<240)bad(prefix+' missing post-warmup ingestion window');
    const configuration=s.configuration,profile=SCENARIO_PROFILES[id];
    if(profile.flowView==='map'&&!profile.reduced&&(!Number.isSafeInteger(s.tokenCoinFrames)||s.tokenCoinFrames<1||!Number.isSafeInteger(s.maxTokenPackets)||s.maxTokenPackets<1))bad(prefix+' missing rendered spinning token coins');
    if(s.cpuTimeBasis!=='cdp-threadTicks-TaskDuration'||!finite(s.mainThreadTaskMs)||!Number.isSafeInteger(s.completedUpdates)||s.completedUpdates<1||!finite(s.renderCpuMsPerUpdate)||Math.abs(s.renderCpuMsPerUpdate-s.mainThreadTaskMs/s.completedUpdates)>.001)bad(prefix+' missing whole-main-thread CPU accounting');
    if(!finite(s.productionDurationMs)||s.productionDurationMs<10000||s.scheduledRecords!==Math.floor(s.productionDurationMs/1000)*24||s.streamedRecords!==s.scheduledRecords||s.streamError!==null)bad(prefix+' incomplete scheduled ingestion workload');
    if(!configuration||Object.entries(profile).some(([key,value])=>key==='deviceScaleFactor'?!finite(configuration[key])||Math.abs(configuration[key]-value)>1e-6:configuration[key]!==value)||configuration.uiReady!==true||configuration.canvasVisible!==true||(profile.flowView==='map'?configuration.visibleWorkers!==8:!Number.isInteger(configuration.visibleWorkers)||configuration.visibleWorkers<2||configuration.representedWorkers<128)||configuration.overflow!==false)bad(prefix+' invalid rendered scenario configuration');
    if(!finite(s.durationMs)||s.durationMs<10000||s.visible!==true||!Number.isSafeInteger(s.eventCount)||s.eventCount<5000||!Number.isSafeInteger(s.workerCount)||s.workerCount<128||!Number.isSafeInteger(s.retainedRecords)||!Number.isSafeInteger(s.expectedRecords)||s.expectedRecords<100||s.ingestedRecords!==s.expectedRecords||s.retainedRecords<Math.max(s.eventCount,s.expectedRecords))bad(prefix+' invalid workload, visibility or preservation');
    for(const [metric,limit] of Object.entries(PERFORMANCE_BUDGETS)){if(!finite(s[metric]))bad(prefix+' missing '+metric);else if(phase==='candidate'&&s[metric]>limit)bad(prefix+' exceeds '+metric);}
   }
  }
  if(scenario.baseline?.length>=3&&scenario.candidate?.length>=3){const median=(samples,key)=>samples.map(s=>s[key]).sort((a,b)=>a-b)[Math.floor(samples.length/2)];for(const metric of ['wireBytesPerSecond','renderCpuMsPerUpdate','heapUsedBytes','pollIntervalP95Ms']){const paired=median(scenario.baseline,metric),before=metric==='renderCpuMsPerUpdate'?cpuComparisonReference(report,id,paired):paired,after=median(scenario.candidate,metric);if(!finite(paired)||!finite(before)||!finite(after)||after>before*1.05)bad(id+' regresses '+metric);}}
 }
 if(problems.length)throw Object.assign(new Error('Performance gate rejected: '+problems.join('; ')),{problems});
 return {status:'PASS',schemaVersion:1,candidateDigest,baselineDigest:report.baselineDigest,workloadDigest:report.workloadDigest,reportDigest:sha(JSON.stringify(report)),scenarios:REQUIRED_SCENARIOS.length,budgets:PERFORMANCE_BUDGETS,qualification:'Controlled browser workload; physical devices require separate acceptance'};
}

export async function verifyPackagedPerformance(directory){
 const root=path.resolve(directory),read=async(relative,maxBytes=8388608)=>{if(typeof relative!=='string'||relative.includes('\\')||relative.split('/').some(p=>!p||p==='.'||p==='..')||path.isAbsolute(relative)||relative.includes(':'))throw new Error('Invalid performance package path');let file=root;for(const part of relative.split('/')){file=path.join(file,part);if((await fs.lstat(file)).isSymbolicLink())throw new Error('Performance package symlink');}const stat=await fs.stat(file);if(!stat.isFile()||stat.size>maxBytes)throw new Error('Unbounded performance package file');return fs.readFile(file);};
 const manifest=JSON.parse(await read('RELEASE_MANIFEST.json',1048576));
 if(manifest.finalRuntime!==true||manifest.status!=='READY_FOR_REVIEW_NOT_PUBLISHED'||manifest.performanceGate?.status!=='PASS'||!Array.isArray(manifest.runtimePaths)||manifest.runtimePaths.length>1024||!Array.isArray(manifest.files)||manifest.files.length>2048)throw new Error('Update requires a final performance-qualified package');
 for(const required of ['server.mjs','collector.mjs','public/app.js'])if(!manifest.runtimePaths.includes(required))throw new Error('Incomplete performance-qualified application');
 const required=new Set([...manifest.runtimePaths,'PERFORMANCE_EVIDENCE.json']);const files=[];
 for(const name of required){const expected=manifest.files.filter(f=>f.path===name);if(expected.length!==1)throw new Error('Missing or duplicate performance package file');const bytes=await read(name);if(sha(bytes)!==expected[0].sha256||bytes.length!==expected[0].bytes)throw new Error('Performance-qualified package changed');files.push({path:name,sha256:sha(bytes)});}
 const evidence=JSON.parse(await read('PERFORMANCE_EVIDENCE.json',1048576)),result=validatePerformanceEvidence(evidence,{candidateDigest:runtimeDigest(files,manifest.runtimePaths)});
 if(result.reportDigest!==manifest.performanceGate.reportDigest)throw new Error('Performance report binding changed');return result;
}
