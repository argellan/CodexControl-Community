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
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CodexAccountObserver,createCodexAccountObserver,validateAccountObserverConfiguration,normalizeAccountLimits,normalizeAccountTokenUsage} from '../lib/codex-account-observer.mjs';
import {sanitizeAccountUsage} from '../lib/account-usage.mjs';
import {accountUsageForBatch} from '../collector.mjs';

const epoch=Date.parse('2026-10-20T12:00:00Z');
const configuration={enabled:true,executable:process.execPath,accountKey:'a'.repeat(64),intervalMs:60000,timeoutMs:1000};
const limits={rateLimits:{limitId:'legacy',primary:{usedPercent:99}},rateLimitsByLimitId:{codex:{limitId:'codex',limitName:'Codex',planType:'pro',primary:{usedPercent:17,windowDurationMins:10080,resetsAt:1793082757},secondary:null,credits:{balance:'PRIVATE_CREDIT'},accountId:'PRIVATE_ACCOUNT'}}};
const usage={summary:{lifetimeTokens:123456789,peakDailyTokens:567890,longestRunningTurnSec:90,currentStreakDays:5,longestStreakDays:8,secret:'PRIVATE_SUMMARY'},dailyUsageBuckets:[{startDate:'2026-10-19',tokens:567890,private:'PRIVATE_BUCKET'},{startDate:'2026-10-20',tokens:10000}]};
const defaults=message=>message.method==='initialize'?{}:message.method==='account/read'?{account:{type:'chatgpt',email:'PRIVATE_EMAIL@example.test',planType:'pro'},requiresOpenaiAuth:true}:message.method==='account/rateLimits/read'?limits:usage;

test('native account identity automatically supplies a stable opaque history key without exporting identity',async()=>{
 let accountId='TEST_ONLY_provider_account_A',now=epoch;
 const make=()=>{const f=fixture(message=>message.method==='account/rateLimits/read'?{id:message.id,result:{...limits,accountId}}:undefined);return new CodexAccountObserver({...configuration,accountKey:null},{spawnProcess:f.spawnProcess,clock:()=>now});};
 const first=make(),a=await first.poll();assert.match(a.accountKey,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(a).includes(accountId));assert.ok(!JSON.stringify(a).includes('PRIVATE_EMAIL'));first.stop();
 const restarted=make();assert.equal((await restarted.poll()).accountKey,a.accountKey);now+=60000;accountId='TEST_ONLY_provider_account_B';const b=await restarted.poll();assert.notEqual(b.accountKey,a.accountKey);assert.match(b.accountKey,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(b).includes(accountId));restarted.stop();
});

test('automatically linked quota readings reach the durable hourly history projection',async()=>{
 const f=fixture(message=>message.method==='account/rateLimits/read'?{id:message.id,result:{...limits,accountId:'TEST_ONLY_history_account'}}:undefined);
 const observer=new CodexAccountObserver({...configuration,accountKey:null},{spawnProcess:f.spawnProcess,clock:()=>epoch}),directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-auto-quota-'));
 try{const value=await observer.poll();const {FleetHub}=await import('../lib/fleet.mjs');const hub=await FleetHub.open({directory,hosts:[]});await hub.captureLocal({host:{id:'TEST_ONLY-history-source'},observedAt:value.observedAt,sessions:[],events:[],coverage:{},accountUsage:value});
 const history=hub.journal.allowanceHistory({now:epoch,range:'24h',accountKey:value.accountKey,limitId:'codex',slot:'primary',hostIds:['TEST_ONLY-history-source']});assert.equal(history.status,'observed');assert.ok(history.points.length>0);assert.equal(history.points.at(-1).remaining,83);assert.ok(history.bars.some(b=>b.remaining===83));
 }finally{observer.stop();await fs.rm(directory,{recursive:true,force:true});}
});
function fixture(handler=()=>undefined){
 const calls=[],children=[],launches=[];
 const spawnProcess=(executable,args,options)=>{
  const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),killed:0,signals:[]});child.kill=signal=>{child.killed++;child.signals.push(signal);queueMicrotask(()=>child.emit('exit',0));return true;};children.push(child);launches.push({executable,args,options});let pending='';
  child.stdin.on('data',chunk=>{pending+=chunk.toString();let end;while((end=pending.indexOf('\n'))>=0){const message=JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);calls.push(message);if(message.method==='initialized')continue;queueMicrotask(()=>{const custom=handler(message,{child,calls,children});if(custom===false)return;const response=custom??{id:message.id,result:defaults(message)};child.stdout.write(JSON.stringify(response)+'\n');});}});
  return child;
 };
 return {calls,children,launches,spawnProcess};
}

test('account polling uses only owned stdio read methods and omits identity, invalid credit payloads and provider output',async()=>{
 const f=fixture(),observer=new CodexAccountObserver(configuration,{spawnProcess:f.spawnProcess,clock:()=>epoch});const value=await observer.poll();
 assert.deepEqual(f.launches[0],{executable:process.execPath,args:['app-server'],options:{stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true}});
 assert.deepEqual(f.calls.map(call=>call.method),['initialize','initialized','account/read','account/rateLimits/read','account/usage/read']);assert.deepEqual(f.calls[2].params,{refreshToken:false});assert.equal(value.status,'available');assert.equal(value.accountKey,'a'.repeat(64));assert.equal(value.planType,'pro');assert.equal(value.summary.peakDailyTokens,567890);assert.equal(value.limits[0].primary.usedPercent,17);assert.equal(value.observedAt,new Date(epoch).toISOString());assert.equal(value.limitsObservedAt,value.observedAt);assert.equal(value.usageObservedAt,value.observedAt);assert.equal(f.children[0].killed,1);assert.ok(!JSON.stringify(value).includes('PRIVATE'));
 const changed=observer.snapshot();changed.summary.peakDailyTokens=0;assert.equal(observer.snapshot().summary.peakDailyTokens,567890);observer.stop();
});

test('qualified native controls survive partial polls with their own timestamp and disappear after an absent-key refresh',async()=>{
 let now=epoch;
 const f=fixture((message,{children})=>{
  if(message.method==='account/rateLimits/read'){
   if(children.length===2)return {id:message.id,error:{code:503,message:'PRIVATE_RATE_ERROR'}};
   return {id:message.id,result:children.length===1?{rateLimitsByLimitId:{codex:{...limits.rateLimitsByLimitId.codex,credits:{hasCredits:true,unlimited:false,balance:'12345.6789000000'},spendControlReached:false,individualLimit:null,normalModelSlug:null,rateLimitReachedType:null}},ordinaryUsageAllowed:false,rateLimitResetCredits:{availableCount:0,credits:[]}}:{rateLimits:{limitId:'codex',primary:{usedPercent:0}}}};
  }
  if(message.method==='account/usage/read')return {id:message.id,result:{...usage,...(children.length===1?{threadUsage:null}:{})}};
 });
 const observer=new CodexAccountObserver(configuration,{spawnProcess:f.spawnProcess,clock:()=>now});
 const first=await observer.poll();assert.equal(first.ordinaryUsageAllowed,false);assert.deepEqual(first.rateLimitResetCredits,{availableCount:0,credits:[]});assert.equal(first.limits[0].credits.balance,'12345.6789000000');assert.equal(first.limits[0].spendControlReached,false);assert.equal(first.threadUsage,null);assert.deepEqual(sanitizeAccountUsage(first),first);
 now+=60000;const partial=await observer.poll();assert.equal(partial.status,'partial');assert.equal(partial.ordinaryUsageAllowed,false);assert.equal(partial.limitsObservedAt,first.limitsObservedAt);assert.notEqual(partial.usageObservedAt,first.usageObservedAt);assert.equal(Object.hasOwn(partial,'threadUsage'),false);
 now+=60000;const latest=await observer.poll();assert.equal(latest.status,'available');assert.equal(Object.hasOwn(latest,'ordinaryUsageAllowed'),false);assert.equal(Object.hasOwn(latest,'rateLimitResetCredits'),false);assert.equal(Object.hasOwn(latest.limits[0],'credits'),false);assert.equal(latest.limits[0].primary.usedPercent,0);assert.doesNotThrow(()=>sanitizeAccountUsage(latest));observer.stop();
});

test('account switches clear old optional native controls before a failed replacement section',async()=>{
 let now=epoch;
 const f=fixture((message,{children})=>{
  if(message.method==='account/read')return {id:message.id,result:{account:{type:'chatgpt',email:children.length===1?'PRIVATE_FIRST@example.test':'PRIVATE_SECOND@example.test',planType:'pro'}}};
  if(message.method==='account/rateLimits/read')return children.length===1?{id:message.id,result:{...limits,ordinaryUsageAllowed:true,rateLimitResetCredits:{availableCount:0,credits:[]}}}:{id:message.id,error:{code:503,message:'PRIVATE_ERROR'}};
  if(message.method==='account/usage/read')return {id:message.id,result:{...usage,...(children.length===1?{threadUsage:null}:{})}};
 });
 const observer=new CodexAccountObserver(configuration,{spawnProcess:f.spawnProcess,clock:()=>now});assert.equal((await observer.poll()).ordinaryUsageAllowed,true);now+=60000;const changed=await observer.poll();assert.equal(changed.status,'partial');assert.equal(changed.accountKey,null);assert.equal(changed.limitsObservedAt,null);for(const key of ['ordinaryUsageAllowed','rateLimitResetCredits','threadUsage'])assert.equal(Object.hasOwn(changed,key),false);assert.ok(!JSON.stringify(changed).includes('PRIVATE'));observer.stop();
});

test('local explicit enablement and opaque grouping key are required; no shell, remote paths or CLI argument injection',()=>{
 assert.equal(createCodexAccountObserver(undefined),null);assert.equal(createCodexAccountObserver({enabled:false,executable:'invalid'}),null);
 for(const executable of ['codex','https://example.test/codex','\\\\server\\share\\codex.exe','//server/codex','C:\\tools\\codex.cmd','/tmp/codex\n--listen'])assert.throws(()=>validateAccountObserverConfiguration({...configuration,executable}),/absolute local/);
 for(const accountKey of ['owner@example.test','account-name','a'.repeat(63),'A'.repeat(64)])assert.throws(()=>validateAccountObserverConfiguration({...configuration,accountKey}),/opaque/);
 for(const intervalMs of [1,59999,300001])assert.throws(()=>validateAccountObserverConfiguration({...configuration,intervalMs}),/interval/);
 assert.equal(validateAccountObserverConfiguration({...configuration,accountKey:undefined}).accountKey,null);
});

test('missing account stops before metrics requests and never invokes login or token refresh',async()=>{
 const f=fixture(message=>message.method==='account/read'?{id:message.id,result:{account:null,requiresOpenaiAuth:true}}:undefined),observer=new CodexAccountObserver(configuration,{spawnProcess:f.spawnProcess,clock:()=>epoch});const value=await observer.poll();assert.equal(value.status,'unavailable');assert.equal(value.errorCode,'account-unavailable');assert.equal(value.observedAt,null);assert.equal(value.planType,null);assert.deepEqual(f.calls.map(call=>call.method),['initialize','initialized','account/read']);assert.equal(f.children[0].killed,1);observer.stop();
});

test('partial metric refresh retains the failed section timestamp and values without marking them fresh',async()=>{
 let now=epoch;const f=fixture((message,{children})=>children.length===2&&message.method==='account/usage/read'?{id:message.id,error:{code:-32601,message:'PRIVATE_unsupported_provider_detail'}}:undefined),observer=new CodexAccountObserver(configuration,{spawnProcess:f.spawnProcess,clock:()=>now});await observer.poll();now+=60000;const value=await observer.poll();assert.equal(value.status,'partial');assert.equal(value.errorCode,'unsupported-method');assert.equal(value.observedAt,new Date(now).toISOString());assert.equal(value.limitsObservedAt,new Date(now).toISOString());assert.equal(value.usageObservedAt,new Date(epoch).toISOString());assert.equal(value.summary.peakDailyTokens,567890);assert.ok(!JSON.stringify(value).includes('PRIVATE'));observer.stop();
});

test('complete failed refresh preserves the prior observation age and never promotes errors to live metrics',async()=>{
 let now=epoch;const f=fixture((message,{children})=>children.length===2&&message.method!=='initialize'?{id:message.id,error:{code:401,message:'PRIVATE_PROVIDER_ERROR'}}:undefined),observer=new CodexAccountObserver(configuration,{spawnProcess:f.spawnProcess,clock:()=>now});await observer.poll();now+=60000;const value=await observer.poll();assert.equal(value.status,'stale');assert.equal(value.observedAt,new Date(epoch).toISOString());assert.equal(value.lastAttemptAt,new Date(now).toISOString());assert.equal(value.errorCode,'rpc-unavailable');assert.equal(value.summary.lifetimeTokens,123456789);assert.ok(!JSON.stringify(value).includes('PRIVATE'));observer.stop();
});

test('an account switch clears cached sections before a partial refresh and revokes grouping for the observer lifetime',async()=>{
 let now=epoch;const f=fixture((message,{children})=>{
  if(message.method==='account/read')return {id:message.id,result:{account:{type:'chatgpt',email:children.length===1?'PRIVATE_FIRST@example.test':'PRIVATE_SECOND@example.test',planType:'pro'}}};
  if(children.length===2&&message.method==='account/rateLimits/read')return {id:message.id,error:{code:401,message:'PRIVATE_RATE_ERROR'}};
  if(message.method==='account/usage/read')return {id:message.id,result:{...usage,summary:{...usage.summary,lifetimeTokens:children.length*100,peakDailyTokens:children.length*10}}};
 });
 const observer=new CodexAccountObserver(configuration,{spawnProcess:f.spawnProcess,clock:()=>now});const first=await observer.poll();assert.equal(first.accountKey,'a'.repeat(64));assert.equal(first.limits[0].primary.usedPercent,17);
 now+=60000;const second=await observer.poll();assert.equal(second.status,'partial');assert.equal(second.accountKey,null);assert.deepEqual(second.limits,[]);assert.equal(second.limitsObservedAt,null);assert.equal(second.summary.lifetimeTokens,200);assert.equal(second.summary.peakDailyTokens,20);assert.equal(second.usageObservedAt,new Date(now).toISOString());
 now+=60000;const third=await observer.poll();assert.equal(third.status,'available');assert.equal(third.accountKey,null);assert.equal(third.limits[0].primary.usedPercent,17);assert.equal(third.summary.lifetimeTokens,300);assert.ok(!JSON.stringify(third).includes('PRIVATE'));assert.ok(!JSON.stringify(observer).includes('@example.test'));observer.stop();
});

test('unavailable local identity cannot inherit earlier sections or claim an enrolled account grouping',async()=>{
 let now=epoch;const f=fixture((message,{children})=>message.method==='account/read'?{id:message.id,result:{account:{type:'chatgpt',email:null,planType:'pro'}}}:children.length===2&&message.method==='account/usage/read'?{id:message.id,error:{code:401,message:'PRIVATE_USAGE_ERROR'}}:undefined),observer=new CodexAccountObserver(configuration,{spawnProcess:f.spawnProcess,clock:()=>now});
 const first=await observer.poll();assert.equal(first.status,'available');assert.equal(first.accountKey,null);assert.equal(first.summary.peakDailyTokens,567890);
 now+=60000;const second=await observer.poll();assert.equal(second.status,'partial');assert.equal(second.accountKey,null);assert.equal(second.summary.peakDailyTokens,null);assert.equal(second.usageObservedAt,null);assert.equal(second.limitsObservedAt,new Date(now).toISOString());assert.doesNotThrow(()=>sanitizeAccountUsage(second));observer.stop();
});

test('sample is nonblocking, shares an in-flight poll, and does not spawn again before the minute cadence',async()=>{
 let now=epoch;const f=fixture(),observer=new CodexAccountObserver(configuration,{spawnProcess:f.spawnProcess,clock:()=>now});const first=observer.sample();assert.equal(first.status,'unavailable');assert.equal(first.lastAttemptAt,new Date(epoch).toISOString());assert.equal(f.calls.length,1);const a=observer.poll(),b=observer.poll();assert.equal(a,b);await a;now+=59999;assert.equal(observer.sample().status,'available');await observer.poll();assert.equal(f.children.length,1);now++;await observer.poll();assert.equal(f.children.length,2);observer.stop();
});

test('timeout, explicit stop and output bounds terminate only the owned process and settle pending reads',async()=>{
 const timeout=fixture(()=>false),observer=new CodexAccountObserver({...configuration,timeoutMs:250},{spawnProcess:timeout.spawnProcess,clock:()=>epoch});const timed=await observer.poll();assert.equal(timed.errorCode,'timeout');assert.equal(timeout.children[0].killed,1);observer.stop();
 const stopped=fixture(()=>false),second=new CodexAccountObserver(configuration,{spawnProcess:stopped.spawnProcess,clock:()=>epoch});const pending=second.poll();second.stop();assert.equal((await pending).errorCode,'stopped');assert.equal(stopped.children[0].killed,1);assert.equal((await second.poll()).status,'unavailable');assert.equal(stopped.children.length,1);
 for(const stream of ['stdout','stderr']){const f=fixture((message,{child})=>{child[stream].write('PRIVATE'.repeat(80000));return false;}),bounded=new CodexAccountObserver(configuration,{spawnProcess:f.spawnProcess,clock:()=>epoch});const value=await bounded.poll();assert.equal(value.errorCode,'output-limit');assert.equal(f.children[0].killed,1);assert.ok(!JSON.stringify(value).includes('PRIVATE'));bounded.stop();}
});

test('server-originated requests and malformed JSON cannot trigger authentication, execution or unbounded waits',async()=>{
 for(const injected of [JSON.stringify({id:900,method:'item/commandExecution/requestApproval',params:{secret:'PRIVATE'}})+'\n','PRIVATE invalid JSON\n']){const f=fixture((message,{child})=>{child.stdout.write(injected);return false;}),observer=new CodexAccountObserver(configuration,{spawnProcess:f.spawnProcess,clock:()=>epoch});const value=await observer.poll();assert.ok(['unexpected-request','invalid-response'].includes(value.errorCode));assert.equal(f.children[0].killed,1);assert.equal(f.calls.length,1);assert.ok(!JSON.stringify(value).includes('PRIVATE'));observer.stop();}
});

test('spawn errors and premature child exits are sanitized and settle the observation',async()=>{
 const failed=new CodexAccountObserver(configuration,{spawnProcess:()=>{throw new Error('PRIVATE_EXECUTABLE_PATH');},clock:()=>epoch});assert.equal((await failed.poll()).errorCode,'spawn-failed');failed.stop();
 const f=fixture((message,{child})=>{child.emit('exit',1);return false;}),observer=new CodexAccountObserver(configuration,{spawnProcess:f.spawnProcess,clock:()=>epoch});assert.equal((await observer.poll()).errorCode,'process-exited');observer.stop();
});

test('an owned child that ignores graceful termination is force-stopped without affecting other processes',async()=>{
 const f=fixture((message,{child})=>{child.kill=signal=>{child.killed++;child.signals.push(signal);if(signal==='SIGKILL')queueMicrotask(()=>child.emit('exit',0));return true;};return false;}),observer=new CodexAccountObserver({...configuration,timeoutMs:250},{spawnProcess:f.spawnProcess,clock:()=>epoch});const value=await observer.poll();assert.equal(value.errorCode,'timeout');await new Promise(resolve=>setTimeout(resolve,280));assert.deepEqual(f.children[0].signals,['SIGTERM','SIGKILL']);observer.stop();
});

test('usage normalization preserves null and zero while bounding counters, dates, buckets and quota maps',()=>{
 const value=normalizeAccountTokenUsage({summary:{lifetimeTokens:0,peakDailyTokens:null,currentStreakDays:-1,longestStreakDays:Infinity},dailyUsageBuckets:[{startDate:'2026-02-30',tokens:1},{startDate:'2026-02-28',tokens:0},{startDate:'2026-02-28',tokens:2},{startDate:'2026-10-20',tokens:'1'}]});assert.equal(value.summary.lifetimeTokens,0);assert.equal(value.summary.peakDailyTokens,null);assert.equal(value.summary.currentStreakDays,null);assert.deepEqual(value.dailyUsageBuckets,[{startDate:'2026-02-28',tokens:2}]);assert.equal(normalizeAccountTokenUsage({summary:{},dailyUsageBuckets:null}).dailyUsageBuckets,null);
 const many=normalizeAccountTokenUsage({summary:{},dailyUsageBuckets:Array.from({length:1000},(_,i)=>({startDate:new Date(epoch-i*86400000).toISOString().slice(0,10),tokens:i}))});assert.equal(many.dailyUsageBuckets.length,366);
 const windows=normalizeAccountLimits({rateLimits:{limitId:'codex',primary:{usedPercent:0,windowDurationMins:0,resetsAt:0},secondary:{usedPercent:Infinity,windowDurationMins:-1,resetsAt:'0'}}});assert.deepEqual(windows[0].primary,{usedPercent:0,windowDurationMins:0,resetsAt:0});assert.equal(windows[0].secondary,null);assert.equal(normalizeAccountLimits({rateLimitsByLimitId:Object.fromEntries(Array.from({length:100},(_,i)=>['bucket-'+i,{primary:{usedPercent:1}}]))}).length,8);
});

test('malformed Unicode labels and duplicate provider aliases normalize into a hub-accepted observation',async()=>{
 const aliases={first:{limitId:'codex',limitName:'TEST_ONLY \ud800',planType:'bad\udfff',primary:{usedPercent:17}},second:{limitId:'codex',primary:{usedPercent:99}},third:{limitId:'\ud800',primary:{usedPercent:22}},fourth:{limitId:'second-valid',limitName:'Valid \ud83d\ude80',primary:{usedPercent:33}}};
 const f=fixture(message=>message.method==='account/read'?{id:message.id,result:{account:{type:'chatgpt',planType:'bad\ud800'}}}:message.method==='account/rateLimits/read'?{id:message.id,result:{rateLimitsByLimitId:aliases}}:undefined),observer=new CodexAccountObserver(configuration,{spawnProcess:f.spawnProcess,clock:()=>epoch});
 const value=await observer.poll();assert.equal(value.planType,null);assert.deepEqual(value.limits.map(q=>q.limitId),['codex','third','second-valid']);assert.equal(value.limits[0].primary.usedPercent,17);assert.equal(value.limits[0].limitName,null);assert.equal(value.limits[0].planType,null);assert.equal(value.limits[2].limitName,'Valid \ud83d\ude80');assert.doesNotThrow(()=>sanitizeAccountUsage(value));assert.deepEqual(accountUsageForBatch(value),value);observer.stop();
});

test('invalid optional account telemetry is omitted before it can poison a primary event batch',()=>{
 assert.equal(accountUsageForBatch({version:1,source:'codex-app-server',private:'PRIVATE_BAD_OPTIONAL'}),null);
 assert.equal(accountUsageForBatch(undefined),null);
 assert.equal(accountUsageForBatch(null),null);
});

test('collector recovers a durable event batch with invalid optional telemetry and preserves all primary records',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-account-observer-TEST_ONLY-'));let server,received;
 try{
  const pending={hostId:'test-account-source',batchId:'TEST_ONLY-original-batch',observedAt:new Date(epoch).toISOString(),sessions:[{id:'TEST_ONLY-session',label:'TEST_ONLY primary session'}],events:[{id:'TEST_ONLY-event',kind:'tool',label:'TEST_ONLY primary event'}],coverage:{retained:'TEST_ONLY'},host:{id:'test-account-source'},accountUsage:{version:1,source:'codex-app-server',status:'available',private:'PRIVATE_BAD_OPTIONAL'}};
  server=http.createServer((req,res)=>{if(req.url==='/api/identity'){res.end(JSON.stringify({deploymentId:'TEST_ONLY-account-instance',readOnly:true,protocolVersion:1}));return;}if(req.url==='/api/collector/config'){res.end(JSON.stringify({revision:0,managed:false,sources:[]}));return;}if(req.url==='/api/collector'){let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{received=JSON.parse(body);try{sanitizeAccountUsage(received.accountUsage);}catch{res.writeHead(400);res.end('invalid optional telemetry');return;}res.end(JSON.stringify({hostId:received.hostId,batchId:received.batchId,added:received.events.length}));});return;}res.writeHead(404);res.end();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const file=path.join(directory,'collector.json'),config={hostId:pending.hostId,role:'execution-target',url:`http://127.0.0.1:${server.address().port}`,token:'TEST_ONLY_collector_credential_32_characters',expectedInstanceId:'TEST_ONLY-account-instance',expectedHostname:os.hostname()};
  await fs.writeFile(file,JSON.stringify(config));await fs.writeFile(file+'.outbox',JSON.stringify(pending));
  await promisify(execFile)(process.execPath,[path.resolve('collector.mjs'),file,'--once'],{timeout:5000,windowsHide:true});
  assert.ok(received);assert.equal(received.batchId,pending.batchId);assert.deepEqual(received.sessions,pending.sessions);assert.deepEqual(received.events,pending.events);assert.deepEqual(received.coverage,pending.coverage);assert.deepEqual(received.host,pending.host);assert.equal(Object.hasOwn(received,'accountUsage'),false);assert.ok(!JSON.stringify(received).includes('PRIVATE_BAD_OPTIONAL'));await assert.rejects(fs.access(file+'.outbox'));
 }finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('cc-account-observer-TEST_ONLY-'));await fs.rm(resolved,{recursive:true,force:true});}
});
