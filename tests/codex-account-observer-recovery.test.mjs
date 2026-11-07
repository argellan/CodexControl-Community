// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import path from 'node:path';
import {CodexAccountObserver} from '../lib/codex-account-observer.mjs';
import {sanitizeAccountUsage} from '../lib/account-usage.mjs';

const epoch=Date.parse('2026-10-23T12:00:00Z');
const executable=path.resolve('TEST_ONLY-removed-version','codex.exe');
const configuration={enabled:true,executable,intervalMs:60000,timeoutMs:250};
const missing=code=>Object.assign(new Error('PRIVATE_PATH PRIVATE_PROVIDER_DETAIL'),{code});
function fixture(){
 let available=false,launches=[],active=0,peakActive=0;
 const spawnProcess=(target,args,options)=>{
  launches.push({target,args,options});active++;peakActive=Math.max(peakActive,active);
  const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
  let killed=false;child.kill=()=>{if(!killed){killed=true;active--;queueMicrotask(()=>child.emit('exit',0));}return true;};
  if(!available){queueMicrotask(()=>child.emit('error',missing('ENOENT')));return child;}
  let buffer='';child.stdin.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const request=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(request.method==='initialized')continue;
   const result=request.method==='initialize'?{}:request.method==='account/read'?{account:{type:'chatgpt',email:'TEST_ONLY@example.test',planType:'pro'}}:request.method==='account/rateLimits/read'?{rateLimits:{primary:{usedPercent:10,windowDurationMins:10080,resetsAt:1793300855}}}:{summary:{lifetimeTokens:100,peakDailyTokens:50},dailyUsageBuckets:[]};
   queueMicrotask(()=>child.stdout.write(JSON.stringify({id:request.id,result})+'\n'));
  }});return child;
 };
 return {spawnProcess,launches,setAvailable(value){available=value;},get active(){return active;},get peakActive(){return peakActive;}};
}

// Catches loss of the missing-file classification, automatic fallback execution,
// accelerated retries, and failure to recover when the same explicit path returns.
test('missing configured executable is diagnosed locally without changing the wire contract or retry cadence',async()=>{
 let now=epoch;const f=fixture(),metadata=[];
 const observer=new CodexAccountObserver(configuration,{clock:()=>now,spawnProcess:f.spawnProcess,statExecutable:async target=>{metadata.push(target);throw missing('ENOENT');}});
 try{
  const a=observer.poll(),b=observer.poll();assert.equal(a,b);const value=await a;
  assert.equal(value.errorCode,'spawn-failed');assert.equal(value.status,'unavailable');assert.equal(value.observedAt,null);assert.doesNotThrow(()=>sanitizeAccountUsage(value));
  assert.deepEqual(observer.diagnostic?.(),{code:'executable-missing',action:'verify-configured-local-executable',nextAttemptAt:'2026-10-23T12:01:00.000Z'});
  assert.deepEqual(metadata,[executable]);assert.equal(f.launches.length,1);assert.deepEqual(f.launches[0],{target:executable,args:['app-server'],options:{stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true}});
  assert.ok(!JSON.stringify([value,observer.diagnostic()]).includes('PRIVATE'));
  now+=59999;await observer.poll();assert.equal(f.launches.length,1);
  now++;f.setAvailable(true);const recovered=await observer.poll();assert.equal(recovered.status,'available');assert.equal(recovered.errorCode,null);assert.equal(observer.diagnostic(),null);assert.equal(f.launches.length,2);assert.equal(f.peakActive,1);
 }finally{observer.stop();}
});

// ENOENT can also mean a missing loader: an existing file or inconclusive metadata
// must not be labeled a removed executable. Other OS errors stay generic.
test('missing classification requires both launch ENOENT and filesystem confirmation',async()=>{
 for(const [launchCode,statResult,want] of [['ENOENT','present','spawn-failed'],['ENOENT','EACCES','spawn-failed'],['ENOENT','ENOTDIR','executable-missing'],['EACCES','ENOENT','spawn-failed'],['ENOEXEC','ENOENT','spawn-failed']]){
  let stats=0;const observer=new CodexAccountObserver(configuration,{clock:()=>epoch,spawnProcess:()=>{throw missing(launchCode);},statExecutable:async()=>{stats++;if(statResult!=='present')throw missing(statResult);return {isFile:()=>true};}});
  try{const value=await observer.poll();assert.equal(value.errorCode,'spawn-failed');assert.deepEqual(observer.diagnostic?.(),{code:want,action:'verify-configured-local-executable',nextAttemptAt:'2026-10-23T12:01:00.000Z'});assert.equal(stats,launchCode==='ENOENT'?1:0);assert.ok(!JSON.stringify([value,observer.diagnostic()]).includes('PRIVATE'));}finally{observer.stop();}
 }
});

test('default filesystem diagnosis confirms a synthetic absent path without executing a process',async()=>{
 const observer=new CodexAccountObserver(configuration,{clock:()=>epoch,spawnProcess:()=>{throw missing('ENOENT');}});
 try{await observer.poll();assert.equal(observer.diagnostic?.()?.code,'executable-missing');}finally{observer.stop();}
});

test('disappearing executable preserves earlier metric values and timestamps as stale',async()=>{
 let now=epoch;const f=fixture();f.setAvailable(true);const observer=new CodexAccountObserver(configuration,{clock:()=>now,spawnProcess:f.spawnProcess,statExecutable:async()=>{throw missing('ENOENT');}});
 try{const first=await observer.poll();now+=60000;f.setAvailable(false);const stale=await observer.poll();assert.equal(stale.status,'stale');assert.equal(stale.observedAt,first.observedAt);assert.equal(stale.limitsObservedAt,first.limitsObservedAt);assert.deepEqual(stale.summary,first.summary);assert.equal(stale.lastAttemptAt,'2026-10-23T12:01:00.000Z');assert.equal(observer.diagnostic?.()?.code,'executable-missing');assert.doesNotThrow(()=>sanitizeAccountUsage(stale));}finally{observer.stop();}
});

test('filesystem diagnosis shares the existing deadline and cannot keep a stopped observer retrying',async()=>{
 let statsStarted;const started=new Promise(resolve=>{statsStarted=resolve;});
 const observer=new CodexAccountObserver(configuration,{clock:()=>epoch,spawnProcess:()=>{throw missing('ENOENT');},statExecutable:()=>{statsStarted();return new Promise(()=>{});}});
 try{const start=performance.now();const pending=observer.poll();await Promise.race([started,new Promise(resolve=>setTimeout(resolve,500))]);observer.stop();const value=await pending;assert.ok(performance.now()-start<1000);assert.equal(value.errorCode,'spawn-failed');assert.equal(observer.diagnostic?.()?.code,'spawn-failed');assert.equal(observer.diagnostic().nextAttemptAt,null);await observer.poll();}finally{observer.stop();}
});
// A slow metadata completion must not overwrite a completed bounded observation.
test('late filesystem failure cannot upgrade a timed-out diagnosis or cause extra launches',async()=>{
 let rejectStat,stats=0,launches=0;let ready;const started=new Promise(resolve=>{ready=resolve;});
 const observer=new CodexAccountObserver(configuration,{clock:()=>epoch,spawnProcess:()=>{launches++;throw missing('ENOENT');},statExecutable:()=>{stats++;ready();return new Promise((resolve,reject)=>{rejectStat=reject;});}});
 try{const pending=observer.poll();await started;const value=await pending;assert.equal(value.errorCode,'spawn-failed');assert.equal(observer.diagnostic().code,'spawn-failed');rejectStat(missing('ENOENT'));await new Promise(resolve=>setImmediate(resolve));assert.equal(observer.diagnostic().code,'spawn-failed');await observer.poll();assert.equal(stats,1);assert.equal(launches,1);}finally{observer.stop();}
});