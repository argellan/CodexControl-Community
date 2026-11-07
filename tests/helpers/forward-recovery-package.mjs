// Synthetic release-contract fixture only; these are fabricated test metrics, never qualification evidence.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {runtimeDigest,REQUIRED_SCENARIOS,SCENARIO_PROFILES,validatePerformanceEvidence} from '../../scripts/performance-gate.mjs';
import {ADMINISTRATION_FORMAT} from '../../lib/administration-format.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
export async function recoveryPackage(directory){
 const source=JSON.parse(await fs.readFile(path.join(root,'release/runtime-files.json'))),names=[...new Set([...source.runtime,...source.support.filter(n=>['scripts/performance-gate.mjs','scripts/package-release.mjs','scripts/setup-instance.mjs'].includes(n)),'lib/administration-format.mjs','lib/forward-recovery.mjs','scripts/verify-administration.mjs','scripts/archive-usage.mjs','tests/fixture-server.mjs'])];
 const files=[];for(const name of names){const bytes=await fs.readFile(path.join(root,name)),target=path.join(directory,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);files.push({path:name,bytes:bytes.length,sha256:sha(bytes)});}
 const candidateDigest=runtimeDigest(files,names),sample=id=>({durationMs:10000,ingestionTimeBasis:'captured-to-journal-commit/post-warmup-window',measurementStartedAt:1792860000000,ingestionSampleCount:240,productionDurationMs:15000,scheduledRecords:360,streamedRecords:360,streamError:null,visible:true,eventCount:5000,workerCount:128,expectedRecords:100,ingestedRecords:100,retainedRecords:5100,frameP99Ms:16.8,worstFrameMs:33.3,longTaskCount:0,renderStageP95Ms:10,renderStageMaxMs:20,updateLatencyP95Ms:180,ingestionLatencyP95Ms:700,wireBytesPerSecond:10000,heapGrowthBytesPerMinute:1000,apiErrors:0,pollIntervalP95Ms:1000,cpuTimeBasis:'cdp-threadTicks-TaskDuration',mainThreadTaskMs:300,completedUpdates:10,renderCpuMsPerUpdate:30,heapUsedBytes:30000000,configuration:{...SCENARIO_PROFILES[id],uiReady:true,canvasVisible:true,visibleWorkers:8,representedWorkers:128,overflow:false}});
 const report={schemaVersion:1,mode:'measured-browser',candidateDigest,baselineDigest:'b'.repeat(64),workloadDigest:'c'.repeat(64),browser:'TEST_ONLY fabricated contract fixture; NOT MEASURED',cpuThrottling:1,scenarios:REQUIRED_SCENARIOS.map(id=>({id,baseline:Array.from({length:3},()=>sample(id)),candidate:Array.from({length:3},()=>sample(id))}))};
 const gate=validatePerformanceEvidence(report,{candidateDigest}),bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');await fs.writeFile(path.join(directory,'PERFORMANCE_EVIDENCE.json'),bytes);files.push({path:'PERFORMANCE_EVIDENCE.json',bytes:bytes.length,sha256:sha(bytes)});
 const manifest={schemaVersion:1,status:'READY_FOR_REVIEW_NOT_PUBLISHED',finalRuntime:true,runtimePaths:names,files,performanceGate:gate,administrationFormat:ADMINISTRATION_FORMAT,fixtureOnly:true};await fs.writeFile(path.join(directory,'RELEASE_MANIFEST.json'),JSON.stringify(manifest));return {directory,manifest};
}
export async function instancePointer(root,{pid=2147483647}={}){await fs.writeFile(path.join(root,'installation.json'),JSON.stringify({schemaVersion:1,hostId:'test-only',appDirectory:path.join(root,'previous-app'),sessionRoot:null}));await fs.writeFile(path.join(root,'hub.json'),JSON.stringify({instanceId:'TEST_ONLY_FORWARD',dataDirectory:path.join(root,'data'),listen:'127.0.0.1'}));await fs.writeFile(path.join(root,'data','runtime.pid'),JSON.stringify({pid,instanceId:'TEST_ONLY_FORWARD'}));return path.join(root,'installation.json');}

export async function rebindRecoveryPackage(directory){
 const file=path.join(directory,'RELEASE_MANIFEST.json'),manifest=JSON.parse(await fs.readFile(file));
 for(const f of manifest.files)if(f.path!=='PERFORMANCE_EVIDENCE.json'){const bytes=await fs.readFile(path.join(directory,f.path));f.sha256=sha(bytes);f.bytes=bytes.length;}
 const report=JSON.parse(await fs.readFile(path.join(directory,'PERFORMANCE_EVIDENCE.json')));report.candidateDigest=runtimeDigest(manifest.files,manifest.runtimePaths);manifest.performanceGate=validatePerformanceEvidence(report,{candidateDigest:report.candidateDigest});
 const bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');await fs.writeFile(path.join(directory,'PERFORMANCE_EVIDENCE.json'),bytes);Object.assign(manifest.files.find(f=>f.path==='PERFORMANCE_EVIDENCE.json'),{bytes:bytes.length,sha256:sha(bytes)});await fs.writeFile(file,JSON.stringify(manifest));
}
