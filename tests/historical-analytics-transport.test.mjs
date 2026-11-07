// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {validateHistoricalAnalyticsConfig,checkHistoricalAnalyticsFiles,validateHistoricalQuery,validateHistoricalResponse,parseHistoricalJson,historicalSshArguments,sendHistoricalOverSsh,createHistoricalAnalytics,HISTORICAL_ANALYTICS_LIMITS} from '../lib/historical-analytics.mjs';

const RECEIVER='70105d47-af72-42fb-a835-97e2509d28b8',OTHER='f42a4f46-bcd8-48c0-937f-9b4ad7accc44';
const baseConfig=()=>({version:1,engine:'duckdb',expectedReceiverId:RECEIVER,ssh:{executable:process.execPath,host:'archive.example.test',user:'codex_analytics',identityFile:path.join(os.tmpdir(),'TEST_ONLY_analytics_key'),knownHostsFile:path.join(os.tmpdir(),'TEST_ONLY_analytics_hosts')}});
const request=(extra={})=>({version:1,report:'daily',fromDay:'2026-10-01',toDay:'2026-10-22',allowedHostIds:['source-a'],source:'session-deltas',limit:100,...extra});
function report(extra={}){return {version:1,engine:'duckdb',engineVersion:'1.4.4',receiverId:RECEIVER,report:'daily',generatedAt:'2026-10-22T12:00:00.000Z',coverage:{completeHistory:false,source:'verified-archive-projection',aggregation:'known-subtotals',headReconstruction:'unavailable',projectedSegments:1,pendingSegments:1,projectedItems:2,archiveItems:3,lastProjectedAt:'2026-10-22T11:00:00Z',matchedRows:1,returnedRows:1,truncated:false,conflictRows:0,excludedRows:0},rows:[{day:'2026-10-21',hostId:'source-a',project:'TEST_ONLY project',accountIdentity:null,source:'session-deltas',records:1,values:{input:'900719925474099100',cached:'10',uncached:'900719925474099090',output:null,total:null},known:{input:1,cached:1,uncached:1,output:0,total:0}}],...extra};}
const code=expected=>error=>error.code===expected&&!error.message.includes('PRIVATE');

test('private analytics config allows only bounded fixed transport settings',()=>{
 const config=baseConfig(),parsed=validateHistoricalAnalyticsConfig(config);assert.equal(parsed.timeoutMs,20000);assert.equal(parsed.minIntervalMs,1000);assert.equal(parsed.ssh.port,22);assert.ok(Object.isFrozen(parsed.ssh));
 for(const change of [{version:2},{engine:'timescale'},{expectedReceiverId:'wrong'},{timeoutMs:30001},{timeoutMs:49},{minIntervalMs:0},{minIntervalMs:60001},{sql:'SELECT PRIVATE'},{command:'bash'}])assert.throws(()=>validateHistoricalAnalyticsConfig({...config,...change}),code('ANALYTICS_CONFIG'));
 for(const change of [{host:'-oProxyCommand=PRIVATE'},{host:'example.test;command'},{user:'user\ncommand'},{port:0},{executable:'ssh'},{identityFile:'relative'},{knownHostsFile:String.raw`\\PRIVATE\share\known_hosts`},{password:'PRIVATE'}])assert.throws(()=>validateHistoricalAnalyticsConfig({...config,ssh:{...config.ssh,...change}}),code('ANALYTICS_CONFIG'));
 for(const name of ['identityFile','knownHostsFile'])for(const suffix of ['%h','${PRIVATE}','"alternate'])assert.throws(()=>validateHistoricalAnalyticsConfig({...config,ssh:{...config.ssh,[name]:path.join(os.tmpdir(),suffix)}}),code('ANALYTICS_CONFIG'));
});

test('query validation keeps UTC inclusive date, source, host and output bounds',()=>{
 assert.deepEqual(validateHistoricalQuery({report:'daily',fromDay:'2026-10-01',toDay:'2026-10-22',source:'account-daily'},{allowedHostIds:[]}).allowedHostIds,[]);
 assert.equal(validateHistoricalQuery({report:'responses',fromDay:'2026-10-01',toDay:'2026-10-22'}).limit,100);
 for(const bad of [{fromDay:'2026-02-30'},{toDay:'2026-09-30'},{fromDay:'2000-01-01'},{report:'sql'},{source:undefined},{limit:0},{limit:1001},{limit:'100'},{project:'bad\nproject'},{allowedHostIds:['source-a','source-a']},{allowedHostIds:Array(65).fill(0).map((_,i)=>'source-'+i)},{sql:'PRIVATE'}])assert.throws(()=>validateHistoricalQuery(request(bad)),code('ANALYTICS_QUERY'));
 assert.throws(()=>validateHistoricalQuery(request({report:'responses'})),code('ANALYTICS_QUERY'));
 assert.throws(()=>validateHistoricalQuery(request({source:'account-daily',project:'TEST_ONLY project'})),code('ANALYTICS_QUERY'));
 const start='2010-01-01',last=new Date(Date.parse(start)+3659*86400000).toISOString().slice(0,10);assert.equal(validateHistoricalQuery(request({fromDay:start,toDay:last})).toDay,last);
 assert.throws(()=>validateHistoricalQuery(request({fromDay:start,toDay:new Date(Date.parse(start)+3660*86400000).toISOString().slice(0,10)})),code('ANALYTICS_QUERY'));
});

test('response schema preserves exact decimal totals and unknown while binding receiver and scope',()=>{
 const value=report();assert.equal(validateHistoricalResponse(value,{request:request(),expectedReceiverId:RECEIVER}).rows[0].values.input,'900719925474099100');
 assert.equal(validateHistoricalResponse(value,{request:request({allowedHostIds:undefined})}).receiverId,RECEIVER);
 const changes=[v=>v.receiverId=OTHER,v=>v.report='responses',v=>v.coverage.completeHistory=true,v=>v.coverage.aggregation='complete',v=>v.coverage.returnedRows=0,v=>v.coverage.truncated=true,v=>v.coverage.projectedItems=Number.MAX_SAFE_INTEGER+1,v=>v.rows[0].hostId='unauthorized',v=>v.rows[0].day='2026-09-30',v=>v.rows[0].values.input=17,v=>v.rows[0].values.input='-1',v=>v.rows[0].values.output='0',v=>v.rows[0].known.input=2,v=>v.rows[0].accountIdentity='PRIVATE label',v=>v.rows[0].prompt='PRIVATE',v=>v.command='PRIVATE'];
 for(const change of changes){const next=structuredClone(value);change(next);assert.throws(()=>validateHistoricalResponse(next,{request:request(),expectedReceiverId:RECEIVER}),code('ANALYTICS_RESPONSE'));}
 assert.throws(()=>validateHistoricalResponse(value,{request:request({allowedHostIds:[]})}),code('ANALYTICS_RESPONSE'));
 assert.throws(()=>validateHistoricalResponse(value,{request:request({project:'different'})}),code('ANALYTICS_RESPONSE'));
 const duplicate=report();duplicate.rows.push(structuredClone(duplicate.rows[0]));duplicate.coverage.matchedRows=2;duplicate.coverage.returnedRows=2;assert.throws(()=>validateHistoricalResponse(duplicate,{request:request()}),code('ANALYTICS_RESPONSE'));
});

test('response ratio and percentile schemas reject unbounded or invented fields',()=>{
 const keys=['input','cached','cacheWrite','output','reasoning','total'],ratios=['cacheHit','reasoningShare','newInputFraction'];
 const value=report({report:'responses',rows:[{hostId:'source-a',project:null,responseCount:1,duplicateRows:0,conflictRows:0,identityMissingRows:0,excludedRows:0,totals:Object.fromEntries(keys.map(k=>[k,'10'])),known:Object.fromEntries(keys.map(k=>[k,1])),ratios:Object.fromEntries(ratios.map(k=>[k,.5])),ratioCoverage:Object.fromEntries(ratios.map(k=>[k,{numerator:'5',denominator:'10',comparableRows:1,excludedRows:0}])),percentiles:{totalP50:10,totalP95:10,outputP50:10,outputP95:10}}]});
 const query=request({report:'responses',source:undefined});assert.equal(validateHistoricalResponse(value,{request:query}).rows[0].ratios.cacheHit,.5);
 for(const change of [v=>v.rows[0].ratios.cacheHit=1.1,v=>v.rows[0].percentiles.totalP95=Infinity,v=>v.rows[0].ratioCoverage.cacheHit.denominator='0',v=>v.rows[0].ratioCoverage.cacheHit.comparableRows=2,v=>v.rows[0].ratioCoverage.cacheHit.secret='PRIVATE',v=>v.rows[0].known.cacheWrite=2]){const next=structuredClone(value);change(next);assert.throws(()=>validateHistoricalResponse(next,{request:query}),code('ANALYTICS_RESPONSE'));}
});

test('daily groups containing only excluded conflicts keep explicit unknown counters',()=>{
 const value=report();value.coverage.conflictRows=2;value.coverage.excludedRows=2;value.rows[0].records=0;
 for(const key of Object.keys(value.rows[0].known)){value.rows[0].known[key]=0;value.rows[0].values[key]=null;}
 assert.equal(validateHistoricalResponse(value,{request:request()}).rows[0].records,0);
 value.rows[0].values.input='0';assert.throws(()=>validateHistoricalResponse(value,{request:request()}),code('ANALYTICS_RESPONSE'));
});

test('wire JSON rejects duplicate and escaped duplicate keys, malformed UTF-8 and excess depth/bytes',()=>{
 assert.deepEqual(parseHistoricalJson(' { "x": [true, null, 1.5e1, "escaped\\"quote"] } '),{x:[true,null,15,'escaped"quote']});
 for(const raw of ['{"x":1,"x":2}','{"x":1,"\\u0078":2}','{"nested":{"x":1,"x":2}}','{"x":1,}','[1,]','{"x":01}','{}{}','{PRIVATE',Buffer.from([0xc3,0x28]),'['.repeat(18)+'0'+']'.repeat(18),' '.repeat(HISTORICAL_ANALYTICS_LIMITS.responseBytes+1)])assert.throws(()=>parseHistoricalJson(raw),code('ANALYTICS_RESPONSE'));
});

test('SSH has pinned identities, no forwarding/multiplexing/shell and a constant remote marker',()=>{
 const config=validateHistoricalAnalyticsConfig(baseConfig()),args=historicalSshArguments(config);
 for(const setting of ['BatchMode=yes','StrictHostKeyChecking=yes','IdentitiesOnly=yes','IdentityAgent=none','ForwardAgent=no','ForwardX11=no','ClearAllForwardings=yes','PermitLocalCommand=no','ControlMaster=no','ControlPath=none','ControlPersist=no','ProxyCommand=none','ProxyJump=none','UpdateHostKeys=no','PasswordAuthentication=no','KbdInteractiveAuthentication=no'])assert.ok(args.includes(setting),setting);
 const knownHosts=process.platform==='win32'?config.ssh.knownHostsFile.replaceAll('\\','/'):config.ssh.knownHostsFile;
 assert.equal(args.at(-1),'analytics-query');assert.ok(args.includes('UserKnownHostsFile="'+knownHosts+'"'));assert.equal(args.includes('StrictHostKeyChecking=no'),false);
});

function fakeProcess(run,observed={}){return (executable,args,options)=>{Object.assign(observed,{executable,args,options});const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();observed.kills=[];child.kill=signal=>{observed.kills.push(signal);setImmediate(()=>child.emit('close',1));return true;};let payload='';child.stdin.on('data',chunk=>payload+=chunk);child.stdin.on('finish',()=>{observed.payload=payload;setImmediate(()=>run(child));});return child;};}

test('controlled SSH child transmits only bounded JSON stdin and returns exact bytes',async()=>{
 const config=validateHistoricalAnalyticsConfig(baseConfig()),observed={},raw=JSON.stringify(report());
 const output=await sendHistoricalOverSsh({config,request:request()},{spawn:fakeProcess(child=>{child.stdout.end(raw);child.emit('close',0);},observed)});
 assert.equal(output.toString(),raw);assert.deepEqual(JSON.parse(observed.payload),request());assert.equal(observed.options.shell,false);assert.equal(observed.options.windowsHide,true);assert.equal(observed.args.includes('TEST_ONLY project'),false);
});

for(const [name,run,expected] of [['oversized stdout',child=>child.stdout.write(Buffer.alloc(HISTORICAL_ANALYTICS_LIMITS.responseBytes+1)),'ANALYTICS_RESPONSE'],['oversized stderr',child=>child.stderr.write(Buffer.alloc(HISTORICAL_ANALYTICS_LIMITS.stderrBytes+1)),'ANALYTICS_TRANSPORT'],['nonzero exit',child=>{child.stderr.end('PRIVATE path/key diagnostics');child.emit('close',1);},'ANALYTICS_TRANSPORT'],['timeout',()=>{},'ANALYTICS_TIMEOUT']])test('controlled SSH '+name+' fails closed without exposing diagnostics',async()=>{
 const config=validateHistoricalAnalyticsConfig({...baseConfig(),timeoutMs:50}),observed={};await assert.rejects(sendHistoricalOverSsh({config,request:request()},{spawn:fakeProcess(run,observed)}),code(expected));if(name!=='nonzero exit')assert.ok(observed.kills.includes('SIGTERM'));
});

test('controlled transport is schema checked and rejects receiver mismatch, duplicates and oversized data',async()=>{
 for(const raw of [JSON.stringify(report({receiverId:OTHER})),'{"version":1,"version":1}',JSON.stringify(report({extra:'PRIVATE'})),'x'.repeat(HISTORICAL_ANALYTICS_LIMITS.responseBytes+1)]){
  const service=createHistoricalAnalytics(baseConfig(),{checkFiles:async()=>{},transport:async()=>raw});await assert.rejects(service.query(request()),code('ANALYTICS_RESPONSE'));
 }
});

test('one in-flight slot and monotonic rate guard bound controlled transports',async()=>{
 let release,entered;const arrival=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);let clock=0,calls=0;
 const service=createHistoricalAnalytics(baseConfig(),{checkFiles:async()=>{},now:()=>clock,transport:async()=>{calls++;entered();await hold;return JSON.stringify(report());}}),pending=service.query(request());await arrival;
 clock=2000;await assert.rejects(service.query(request()),code('ANALYTICS_BUSY'));assert.equal(calls,1);release();await pending;
 await service.query(request());await assert.rejects(service.query(request()),code('ANALYTICS_BUSY'));assert.equal(calls,2);
});

test('timeout returns bounded failure while a cancellation-ignoring controlled transport retains its slot',async()=>{
 let release,clock=0,signal;const service=createHistoricalAnalytics({...baseConfig(),timeoutMs:50},{checkFiles:async()=>{},now:()=>clock,transport:args=>{signal=args.signal;return new Promise(resolve=>release=resolve);}});
 await assert.rejects(service.query(request()),code('ANALYTICS_TIMEOUT'));assert.equal(signal.aborted,true);clock=2000;await assert.rejects(service.query(request()),code('ANALYTICS_BUSY'));release(JSON.stringify(report()));await new Promise(resolve=>setImmediate(resolve));
});

test('an owned SSH child with refused termination retains admission until actual close',{timeout:5000},async()=>{
 const children=[];let clock=0;
 const service=createHistoricalAnalytics({...baseConfig(),timeoutMs:50},{checkFiles:async()=>{},now:()=>clock,transport:args=>sendHistoricalOverSsh(args,{spawn:()=>{
  const child=spawn(process.execPath,['-e','process.stdin.resume();setInterval(()=>{},1000)'],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
  const terminate=child.kill.bind(child);children.push({child,terminate});
  // A real owned child remains alive; only the OS termination-error seam is
  // injected. A kill error must never stand in for an observed close event.
  child.kill=()=>{queueMicrotask(()=>child.emit('error',Object.assign(new Error('TEST_ONLY termination refused'),{code:'EPERM'})));return false;};
  return child;
 }})});
 try{
  await assert.rejects(service.query(request()),error=>error.status===503);
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(children.length,1);assert.doesNotThrow(()=>process.kill(children[0].child.pid,0));
  clock=2000;
  await assert.rejects(service.query(request()),code('ANALYTICS_BUSY'));
  assert.equal(children.length,1);
 }finally{
  await Promise.all(children.map(({child,terminate})=>new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null){resolve();return;}child.once('close',resolve);terminate('SIGKILL');})));
 }
});

test('an actual spawn failure without an owned PID reports a bounded transport error',{timeout:5000},async()=>{
 const config=validateHistoricalAnalyticsConfig(baseConfig());
 await assert.rejects(sendHistoricalOverSsh({config,request:request()},{spawn:()=>spawn(path.join(os.tmpdir(),'cc-analytics-absent-TEST_ONLY-'+crypto.randomUUID()),[],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false})}),code('ANALYTICS_TRANSPORT'));
});

async function makePrivate(file,{untrustedRead=false}={}){
 if(process.platform!=='win32'){await fs.chmod(file,untrustedRead?0o644:0o600);return;}
 const script="$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); $u=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object Security.AccessControl.FileSecurity; $a.SetOwner($u); $a.SetAccessRuleProtection($true,$false); $r=New-Object Security.AccessControl.FileSystemAccessRule($u,'FullControl','Allow'); $a.AddAccessRule($r); "+(untrustedRead?"$e=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $b=New-Object Security.AccessControl.FileSystemAccessRule($e,'Read','Allow'); $a.AddAccessRule($b); ":'')+"[IO.File]::SetAccessControl($p,$a)";
 await new Promise((resolve,reject)=>{const child=spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdio:['pipe','ignore','pipe'],windowsHide:true,shell:false});child.on('error',reject);child.on('close',exit=>exit===0?resolve():reject(new Error('TEST_ONLY private fixture ACL setup failed')));child.stdin.end(file);});
}

test('real local file preflight checks private key/pin files and rejects absent or oversized inputs',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-historical-files-TEST_ONLY-')),config=validateHistoricalAnalyticsConfig({...baseConfig(),ssh:{...baseConfig().ssh,identityFile:path.join(directory,'identity'),knownHostsFile:path.join(directory,'known_hosts')}});
 try{
  for(const file of [config.ssh.identityFile,config.ssh.knownHostsFile]){await fs.writeFile(file,'TEST_ONLY fixture; not a key or remote pin',{mode:0o600});await makePrivate(file);}
  await checkHistoricalAnalyticsFiles(config);
  await makePrivate(config.ssh.knownHostsFile,{untrustedRead:true});await assert.rejects(checkHistoricalAnalyticsFiles(config),code('ANALYTICS_CONFIG'));await makePrivate(config.ssh.knownHostsFile);
  await fs.writeFile(config.ssh.identityFile,Buffer.alloc(65537));await assert.rejects(checkHistoricalAnalyticsFiles(config),code('ANALYTICS_CONFIG'));
  await fs.unlink(config.ssh.identityFile);await assert.rejects(checkHistoricalAnalyticsFiles(config),code('ANALYTICS_CONFIG'));
 }finally{const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('cc-historical-files-TEST_ONLY-'));await fs.rm(resolved,{recursive:true,force:true});}
});

test('POSIX analytics key or pin readable by another user is refused',{skip:process.platform==='win32'?'POSIX mode check; Windows owner-private ACL is tested above':false},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-historical-posix-TEST_ONLY-')),config=validateHistoricalAnalyticsConfig({...baseConfig(),ssh:{...baseConfig().ssh,identityFile:path.join(directory,'key'),knownHostsFile:path.join(directory,'pins')}});
 try{await fs.writeFile(config.ssh.identityFile,'TEST_ONLY',{mode:0o600});await fs.writeFile(config.ssh.knownHostsFile,'TEST_ONLY',{mode:0o644});await fs.chmod(config.ssh.knownHostsFile,0o644);await assert.rejects(checkHistoricalAnalyticsFiles(config),code('ANALYTICS_CONFIG'));}
 finally{const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('cc-historical-posix-TEST_ONLY-'));await fs.rm(resolved,{recursive:true,force:true});}
});
