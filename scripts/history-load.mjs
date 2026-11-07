#!/usr/bin/env node
// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// TEST_ONLY: isolated storage benchmark. Never publish these fixtures to a hub,
// collector, dashboard feed or production journal. No files are ever deleted.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';
import {HistoryJournal} from '../lib/history.mjs';

const HOST='test-only-history-load';
const round=value=>Number.isFinite(value)?Math.round(value*1000)/1000:null;
function optionsOf(args){
 const values={duration:30,rate:100,seed:0,directory:null},allowed=new Set(Object.keys(values));
 for(const argument of args){const match=/^--([a-z]+)=(.+)$/.exec(argument);if(!match||!allowed.has(match[1]))throw new Error('Use --duration=1..900 --rate=1..500 --seed=0..100000 [--directory=EMPTY_DIRECTORY]');if(match[1]==='directory')values.directory=match[2];else values[match[1]]=Number(match[2]);}
 for(const [key,min,max] of [['duration',1,900],['rate',1,500],['seed',0,100000]])if(!Number.isSafeInteger(values[key])||values[key]<min||values[key]>max)throw new Error(`Invalid ${key}; expected integer ${min}..${max}`);
 return values;
}
async function emptyDirectory(requested){
 if(!requested)return fs.mkdtemp(path.join(os.tmpdir(),'codex-control-TEST_ONLY-load-'));
 const directory=path.resolve(requested);let stat;
 try{stat=await fs.lstat(directory);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(stat&&(!stat.isDirectory()||stat.isSymbolicLink()))throw new Error('Benchmark directory must be a real directory, not a file or symbolic link');
 if(stat&&(await fs.readdir(directory)).length)throw new Error('Benchmark directory must be empty; existing files will not be changed');
 if(!stat)await fs.mkdir(directory,{recursive:true,mode:0o700});
 return directory;
}
function fixture(index,phase,at){return {id:`TEST_ONLY:${phase}:${String(index).padStart(9,'0')}`,hostId:HOST,sourceId:'TEST_ONLY:deterministic-fixtures',sessionId:'TEST_ONLY:storage-benchmark',project:'TEST_ONLY',turnId:`TEST_ONLY:turn-${Math.floor(index/100)}`,at,kind:'operation',category:['command','research','edit','agent'][index%4],label:'TEST_ONLY isolated journal benchmark',outcome:'recorded',startedAt:at,completedAt:at,delivery:phase==='seed'?'bootstrap':'live'};}
function distribution(samples){const sorted=samples.slice().sort((a,b)=>a-b),quantile=p=>sorted.length?round(sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]):null;return {samples:sorted.length,min:sorted.length?round(sorted[0]):null,p50:quantile(.5),p95:quantile(.95),max:sorted.length?round(sorted.at(-1)):null};}
async function diskSize(directory){const files=[];for(const name of await fs.readdir(directory)){if(!['history.sqlite','history.sqlite-wal','history.sqlite-shm'].includes(name))continue;const stat=await fs.stat(path.join(directory,name));files.push({name,bytes:stat.size});}return {bytes:files.reduce((n,f)=>n+f.bytes,0),files};}

// A genuinely separate Node process reopens the on-disk journal. It does not
// inherit an in-memory journal object or send any HTTP request.
const REOPEN_CHECK=String.raw`
import fs from 'node:fs/promises';
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>1048576)throw new Error('TEST_ONLY verification input exceeds bound');}
const config=JSON.parse(input),{HistoryJournal}=await import(config.moduleUrl),journal=await HistoryJournal.open({directory:config.directory}),before=journal.status();
const duplicate=journal.commit({hostId:config.hostId,state:{classification:'TEST_ONLY',phase:'restart-verification'},events:config.lastBatch});
const after=journal.status(),identities=new Set();let cursor=0,lastSequence=0,scanned=0,pages=0,ordered=true,gaps=0;
while(true){const page=journal.read({after:cursor,epoch:after.epoch,limit:1000});pages++;if(page.gap)gaps++;
 for(const event of page.events){if(event.journalSequence<=lastSequence||event.journalSequence>page.nextCursor)ordered=false;lastSequence=event.journalSequence;if(!event.id.startsWith('TEST_ONLY:')||event.hostId!==config.hostId)throw new Error('Non-test identity in isolated benchmark');identities.add(event.id);scanned++;}
 if(page.nextCursor<cursor)throw new Error('Recovery cursor moved backwards');if(!page.caughtUp&&page.nextCursor===cursor)throw new Error('Recovery cursor stopped making progress');cursor=page.nextCursor;if(page.caughtUp)break;if(pages>1000)throw new Error('Recovery exceeded finite scan bound');
}
const empty=journal.read({after:cursor,epoch:after.epoch});
const uniqueRetained=identities.size;let backwardBefore='9999-12-31T23:59:59.999Z',backwardSequence=0,backwardCount=0,backwardPages=0,backwardOrdered=true,previousTime=Infinity,previousSequence=Infinity;
while(true){const page=journal.read({before:backwardBefore,beforeSequence:backwardSequence,limit:1000});backwardPages++;
 for(const event of page.events){const at=Date.parse(event.at);backwardOrdered&&=at<previousTime||at===previousTime&&event.journalSequence<previousSequence;previousTime=at;previousSequence=event.journalSequence;if(!identities.delete(event.id))throw new Error('Historical replay repeated or introduced a source identity');backwardCount++;}
 if(page.caughtUp)break;if(!page.olderBefore||page.olderBefore===backwardBefore&&page.olderSequence===backwardSequence)throw new Error('Historical replay cursor stopped making progress');backwardBefore=page.olderBefore;backwardSequence=page.olderSequence;if(backwardPages>1000)throw new Error('Historical replay exceeded finite scan bound');
}
process.stdout.write(JSON.stringify({epochStable:before.epoch===config.epoch,highWaterStable:before.latestSequence===config.latestSequence&&after.latestSequence===before.latestSequence,dedupAdded:duplicate.added,retainedCountStable:before.retainedEvents===after.retainedEvents,scannedRetained:scanned,uniqueRetained,ordered,pages,gapPages:gaps,cursorAtHighWater:cursor===after.latestSequence,emptyCatchup:empty.caughtUp&&empty.events.length===0,retainedCountMatchesScan:scanned===after.retainedEvents,sourceIdentityUnique:uniqueRetained===scanned,backwardReplay:{scanned:backwardCount,pages:backwardPages,ordered:backwardOrdered,sourceIdentitiesMatch:identities.size===0&&backwardCount===scanned},rssBytes:process.memoryUsage().rss}));
`;
async function verifyRestart(config){
 return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','--eval',REOPEN_CHECK],{stdio:['pipe','pipe','pipe'],windowsHide:true});let output='',errors='';const timeout=setTimeout(()=>{child.kill();reject(new Error('TEST_ONLY restart verification exceeded 60 seconds'));},60000);
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(output.length>16384){child.kill();reject(new Error('Verification receipt exceeds bound'));}});child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-4096);});child.on('error',error=>{clearTimeout(timeout);reject(error);});child.on('close',code=>{clearTimeout(timeout);if(code!==0){reject(new Error('Separate-process journal verification failed: '+errors));return;}try{resolve(JSON.parse(output));}catch(error){reject(error);}});child.stdin.end(JSON.stringify(config));
 });
}

async function main(){
 const options=optionsOf(process.argv.slice(2)),directory=await emptyDirectory(options.directory),journal=await HistoryJournal.open({directory});
 const commitMs=[],readMs=[],rssSamples=[],scheduleDelays=[];let peakDiskBytes=0,loadCursor,readEvents=0,pollPages=0,insertedLoadEvents=0,lastSequence,lastBatch=[],interrupted=false,lag,sampler;
 const stop=()=>{interrupted=true;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 let seedAdded=0;const seedStart=performance.now();
 for(let offset=0;offset<options.seed;offset+=500){if(interrupted)break;const at=new Date().toISOString(),batch=Array.from({length:Math.min(500,options.seed-offset)},(_,i)=>fixture(offset+i,'seed',at));seedAdded+=journal.commit({hostId:HOST,state:{classification:'TEST_ONLY',phase:'seed',count:offset+batch.length},events:batch}).added;}
 const seedMs=performance.now()-seedStart,initial=journal.status();loadCursor=initial.latestSequence;lastSequence=loadCursor;
 const cpuBaseline=process.cpuUsage(),rssBaseline=process.memoryUsage().rss,startedAt=new Date().toISOString(),start=performance.now(),deadline=start+options.duration*1000;
 lag=monitorEventLoopDelay({resolution:20});lag.enable();rssSamples.push(rssBaseline);sampler=setInterval(()=>rssSamples.push(process.memoryUsage().rss),100);
 let completedTicks=0,cursorOrdered=true,sourceOrder=true;const seenLoadIndexes=new Set();
 try{
  for(let tick=0;tick<options.duration&&!interrupted;tick++){
   const scheduled=start+tick*1000,wait=scheduled-performance.now();if(wait>0)await sleep(wait);if(interrupted||performance.now()>=deadline)break;
   scheduleDelays.push(Math.max(0,performance.now()-scheduled));const at=new Date().toISOString();lastBatch=Array.from({length:options.rate},(_,i)=>fixture(tick*options.rate+i,'load',at));
   const commitStart=performance.now(),committed=journal.commit({hostId:HOST,state:{classification:'TEST_ONLY',phase:'load',tick,attempted:(tick+1)*options.rate},events:lastBatch});commitMs.push(performance.now()-commitStart);insertedLoadEvents+=committed.added;
   for(let pageCount=0;pageCount<8;pageCount++){
    const readStart=performance.now(),page=journal.read({after:loadCursor,epoch:initial.epoch,limit:500});readMs.push(performance.now()-readStart);pollPages++;
    for(const event of page.events){cursorOrdered&&=event.journalSequence>lastSequence&&event.journalSequence<=page.nextCursor;lastSequence=event.journalSequence;const index=Number(event.id.replace('TEST_ONLY:load:',''));sourceOrder&&=Number.isSafeInteger(index)&&index===readEvents;seenLoadIndexes.add(index);readEvents++;}
    if(page.nextCursor<loadCursor||!page.caughtUp&&page.nextCursor===loadCursor)throw new Error('TEST_ONLY live catch-up cursor failed to make ordered progress');loadCursor=page.nextCursor;if(page.caughtUp)break;
   }
   rssSamples.push(process.memoryUsage().rss);peakDiskBytes=Math.max(peakDiskBytes,(await diskSize(directory)).bytes);completedTicks++;
  }
  if(!interrupted&&performance.now()<deadline)await sleep(deadline-performance.now());
 }finally{clearInterval(sampler);lag.disable();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
 const elapsedMs=performance.now()-start,cpu=process.cpuUsage(cpuBaseline),after=journal.status(),rssFinal=process.memoryUsage().rss;rssSamples.push(rssFinal);
 const restart=interrupted?null:await verifyRestart({moduleUrl:new URL('../lib/history.mjs',import.meta.url).href,directory,hostId:HOST,epoch:after.epoch,latestSequence:after.latestSequence,lastBatch});
 const files=await diskSize(directory),expected=options.duration*options.rate,checks={targetLoadCompleted:insertedLoadEvents===expected&&completedTicks===options.duration,liveReadCountMatches:readEvents===insertedLoadEvents,liveSourceIdentitiesUnique:seenLoadIndexes.size===readEvents,liveSourceOrder:sourceOrder,liveCursorOrder:cursorOrdered,liveCursorAtHighWater:loadCursor===after.latestSequence,restartDeduplication:restart?.dedupAdded===0&&restart?.highWaterStable===true,restartEpochStable:restart?.epochStable===true,replayCursorCorrectness:restart?.ordered===true&&restart?.cursorAtHighWater===true&&restart?.emptyCatchup===true&&restart?.retainedCountMatchesScan===true&&restart?.sourceIdentityUnique===true&&restart?.backwardReplay?.ordered===true&&restart?.backwardReplay?.sourceIdentitiesMatch===true};
 const receipt={classification:'TEST_ONLY',status:interrupted?'INTERRUPTED':Object.values(checks).every(Boolean)?'PASS':'FAIL',benchmark:'isolated HistoryJournal; no collector API, public telemetry or model calls',node:process.version,platform:process.platform,architecture:process.arch,hostname:os.hostname(),directory,startedAt,finishedAt:new Date().toISOString(),requestedDurationSeconds:options.duration,requestedEventsPerSecond:options.rate,batchIntervalMs:1000,requestedLoadEvents:expected,insertedLoadEvents,uniqueLiveEvents:seenLoadIndexes.size,seed:{requested:options.seed,added:seedAdded,elapsedMs:round(seedMs)},elapsedMs:round(elapsedMs),achievedEventsPerSecond:round(insertedLoadEvents/(elapsedMs/1000)),completedTicks,readEvents,pollPages,commitLatencyMs:distribution(commitMs),readLatencyMs:distribution(readMs),scheduleDelayMs:distribution(scheduleDelays),eventLoopLagMs:{mean:round(lag.mean/1e6),p50:round(lag.percentile(50)/1e6),p95:round(lag.percentile(95)/1e6),max:round(lag.max/1e6)},memory:{baselineRssBytes:rssBaseline,finalRssBytes:rssFinal,peakSampledRssBytes:Math.max(...rssSamples),sampleIntervalMs:100,samples:rssSamples.length,note:'Runner RSS only; separate reopen verifier RSS is reported under restart. OS/service-wide peak is not measured.'},cpu:{userMs:round(cpu.user/1000),systemMs:round(cpu.system/1000),oneCorePercent:round((cpu.user+cpu.system)/(elapsedMs*1000)*100)},storage:{...files,peakSampledJournalBytes:Math.max(peakDiskBytes,files.bytes),note:'Logical sizes sampled between closed database operations; not filesystem allocation or transient WAL peak.'},journal:after,totalUniqueRetained:restart?.uniqueRetained??null,restart,checks,limitations:['Paced one-second batches; not a sustained concurrent collector or browser benchmark.','Requested history beyond default retention limits may expire; retained and inserted totals are reported separately.','This isolated test does not establish production load, thermal stability, dashboard frame rate or real-fleet correctness.'],receiptFile:path.join(directory,'receipt.json')};
 await fs.writeFile(receipt.receiptFile,JSON.stringify(receipt,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});process.stdout.write(JSON.stringify(receipt)+'\n');if(receipt.status!=='PASS')process.exitCode=interrupted?130:1;
}
main().catch(error=>{process.stdout.write(JSON.stringify({classification:'TEST_ONLY',status:'ERROR',error:error.message})+'\n');process.exitCode=1;});
