// Author: Bishop Crockett
// Owner: Argellan.com
// SPDX-License-Identifier: MIT
// Native, isolated TEST_ONLY preservation checks. Never targets the default installation.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {FleetHub} from '../lib/fleet.mjs';
import {PersonalPreferences} from '../lib/personal-preferences.mjs';
import {hashPassword,verifyPassword} from '../lib/password-auth.mjs';
const execute=promisify(execFile),digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function inventory(root,prefix='') {const out={};for(const e of await fs.readdir(path.join(root,prefix),{withFileTypes:true})){assert.ok(!e.isSymbolicLink());const n=prefix?prefix+'/'+e.name:e.name;if(e.isDirectory())Object.assign(out,await inventory(root,n));else if(e.isFile())out[n]=digest(await fs.readFile(path.join(root,n)));}return out;}
async function freePort(){for(let i=0;i<4;i++){const server=net.createServer();await new Promise((resolve,reject)=>{server.on('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));if(port<65535)return port;}throw Error('No fixture port');}
async function waitFor(fn,timeout=20000){const until=Date.now()+timeout;while(Date.now()<until){if(await fn())return;await sleep(100);}throw Error('Bounded fixture wait expired');}
async function history(instance){
 // The offline baseline is checkpointed. An immutable read avoids creating WAL/
 // shared-memory sidecars in the very directory whose exact bytes we compare.
 const python=path.join(path.dirname(instance),'app-0.1.0','runtimes','python','python.exe');
 const script="import pathlib,sqlite3,json,sys; p=pathlib.Path(sys.argv[1]); db=sqlite3.connect(p.as_uri()+'?mode=ro&immutable=1',uri=True); print(json.dumps({'events':db.execute('SELECT COUNT(*) FROM events').fetchone()[0],'quota':db.execute('SELECT COUNT(*) FROM account_usage_observations').fetchone()[0],'retained':db.execute(\"SELECT event_id,payload FROM events WHERE event_id LIKE 'TEST_ONLY-upgrade-event-%' ORDER BY event_id\").fetchall()})); db.close()";
 return JSON.parse((await execute(python,['-I','-B','-c',script,path.join(instance,'data','history.sqlite')],{windowsHide:true,timeout:10000,maxBuffer:1048576})).stdout);
}
export async function testWindowsUpgrade({installer,previousInstaller,root,evidence,mode='all'}={}) {
 if(process.platform!=='win32')throw Error('Native Windows required');
 for(const p of [installer,previousInstaller,root,evidence])assert.ok(path.isAbsolute(p));
 assert.match(path.basename(root),/^TEST_ONLY-/);assert.ok(!path.resolve(root).toLowerCase().includes('codexcontrol-community'+path.sep+'instance'));await fs.mkdir(root,{recursive:false});await fs.mkdir(evidence,{recursive:true});
 const app=path.join(root,'app-0.1.0'),instance=path.join(root,'instance'),port=await freePort(),args=['--destination='+app,'--instance='+instance,'--test-only','--no-shortcuts','--no-browser'];
 const results=[];const record=async(name,run)=>{const at=new Date().toISOString();try{await run();results.push({name,status:'PASS',at});console.log('PASS',name);}catch(error){results.push({name,status:'FAIL',at,error:error.message,code:error.code??null,signal:error.signal??null,stdout:error.stdout?.slice(-5000),stderr:error.stderr?.slice(-5000)});throw error;}finally{await fs.writeFile(path.join(evidence,'NATIVE_RESULTS.json'),JSON.stringify({root,app,instance,results},null,2)+'\n');}};
 const call=async(extra=[],env={})=>execute(installer,[...args,...extra],{windowsHide:true,timeout:120000,maxBuffer:1048576,env:{...process.env,...env}});
 let fixturePassword=crypto.randomBytes(28).toString('base64url'),oldLauncher;
 try {
  await record('fresh previous-version installation',async()=>{const result=await execute(previousInstaller,['--install',...args,'--port='+port],{windowsHide:true,timeout:90000,maxBuffer:1048576});assert.match(result.stdout,/INSTALLED/);});
  const hubConfig=JSON.parse(await fs.readFile(path.join(instance,'hub.json'),'utf8')),administration=path.join(instance,'data','administration','administration.json');
  const authority=JSON.parse(await fs.readFile(administration,'utf8'));const owner=authority.viewers.find(v=>v.id==='owner');owner.passwordHash=await hashPassword(fixturePassword);delete owner.passwordChangeRequired;await fs.writeFile(administration,JSON.stringify(authority,null,2)+'\n');
  const preferences=new PersonalPreferences(path.join(instance,'data','profiles'),'owner');await preferences.write({fontSize:16,tokenPalette:'coins',quotaHistoryRange:'48h',waterfallRatio:88},{actor:{id:'owner',role:'admin'}});
  await fs.writeFile(path.join(instance,'TEST_ONLY-retained-credential.bin'),crypto.randomBytes(128));
  await fs.mkdir(path.join(app,'app','public','assets','TEST_ONLY-custom-empty'),{recursive:true});await fs.writeFile(path.join(app,'app','public','assets','TEST_ONLY-custom.dat'),'TEST_ONLY unmanaged application addition');
  const hub=await FleetHub.open({directory:path.join(instance,'data')});
  for(let i=0;i<3;i++){const at=new Date(Date.now()-2000+i*500).toISOString();await hub.captureLocal({observedAt:at,host:{id:'community-local',name:'TEST_ONLY source'},sessions:[{id:'TEST_ONLY-session',hostId:'community-local',project:'TEST_ONLY',state:'Turn completed',tokens:{input_tokens:1000+i,output_tokens:100+i,total_tokens:1100+i*2}}],events:[{id:'TEST_ONLY-upgrade-event-'+i,sessionId:'TEST_ONLY-session',hostId:'community-local',project:'TEST_ONLY',kind:'operation',category:'command',label:'TEST_ONLY retained observation',at}],coverage:{},accountUsage:{version:1,source:'codex-app-server',status:'available',observedAt:at,lastAttemptAt:at,limitsObservedAt:at,usageObservedAt:at,accountKey:'a'.repeat(64),planType:'pro',limits:[{limitId:'codex',limitName:'TEST_ONLY quota',primary:{usedPercent:20+i,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+604800},secondary:null}],summary:{lifetimeTokens:10000,peakDailyTokens:2000,longestRunningTurnSec:60,currentStreakDays:1,longestStreakDays:1},dailyUsageBuckets:[],errorCode:null}});}
  await hub.queue;assert.equal(hub.writer,null);
  const recordsBefore=await history(instance),privateBefore=await inventory(instance),initialEnvelope=await fs.readFile(path.join(instance,'first-sign-in.json'));
  assert.equal(recordsBefore.events,3);assert.equal(recordsBefore.quota,3);
  if(mode!=='running'){
  await record('stopped update preserves every private byte and unmanaged application addition',async()=>{const result=await call(['--update']);assert.match(result.stdout,/UPDATED/);assert.deepEqual(await inventory(instance),privateBefore);assert.deepEqual(await history(instance),recordsBefore);assert.equal(await fs.readFile(path.join(app,'app','public','assets','TEST_ONLY-custom.dat'),'utf8'),'TEST_ONLY unmanaged application addition');assert.ok((await fs.stat(path.join(app,'app','public','assets','TEST_ONLY-custom-empty'))).isDirectory());});
  await record('personal password, encrypted initial envelope and presentation choices survive',async()=>{const current=JSON.parse(await fs.readFile(administration,'utf8'));assert.ok(await verifyPassword(fixturePassword,current.viewers.find(v=>v.id==='owner').passwordHash));assert.equal(current.viewers.find(v=>v.id==='owner').passwordChangeRequired,undefined);assert.deepEqual(await fs.readFile(path.join(instance,'first-sign-in.json')),initialEnvelope);const profile=await preferences.read();assert.equal(profile.preferences.tokenPalette,'coins');assert.equal(profile.preferences.fontSize,16);assert.equal(profile.preferences.quotaHistoryRange,'48h');assert.equal(profile.preferences.waterfallRatio,88);});
  const golden=await inventory(app);
  for(const phase of ['prepared','old-moved','promoted','before-commit'])await record('application rollback preserves private data after '+phase,async()=>{await assert.rejects(call(['--update'],{CODEXCONTROL_TEST_UPDATE_FAIL_AT:phase}),/TEST_ONLY injected update failure/);assert.deepEqual(await inventory(app),golden);assert.deepEqual(await inventory(instance),privateBefore);assert.deepEqual(await history(instance),recordsBefore);});
  await record('an interrupted directory swap is recovered without restoring old private data',async()=>{
   const child=spawn(installer,[...args,'--update'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,CODEXCONTROL_TEST_UPDATE_PAUSE_AT:'old-moved'}});let output='';child.stdout.on('data',b=>{if(output.length<1048576)output+=b;});child.stderr.on('data',()=>{});const exited=new Promise(resolve=>child.once('exit',resolve));
   await waitFor(async()=>{try{const state=JSON.parse(await fs.readFile(path.join(root,'.codexcontrol-update.json'),'utf8'));return state.phase==='old-moved'&&await fs.stat(path.join(state.transaction,'TEST_ONLY_PAUSED')).then(()=>true,()=>false);}catch{return false;}},30000);
   await assert.rejects(call(['--update']),/Another installer is already updating/);
   child.kill();await exited;await fs.writeFile(path.join(instance,'TEST_ONLY-record-after-interruption.dat'),'TEST_ONLY later record must remain');const current=await inventory(instance);await call(['--recover-update']);assert.deepEqual(await inventory(app),golden);assert.deepEqual(await inventory(instance),current);assert.deepEqual(await history(instance),recordsBefore);
  });
  await record('foreign process identity is refused without signaling it',async()=>{
   const file=path.join(instance,'data','runtime.pid');let previous;try{previous=await fs.readFile(file);}catch{}
   const foreign=spawn(path.join(app,'runtimes','node','node.exe'),['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
   try{await fs.writeFile(file,JSON.stringify({pid:foreign.pid,instanceId:hubConfig.instanceId,startedAt:new Date().toISOString()}));await assert.rejects(call(['--update']),/Command failed/);assert.equal(foreign.exitCode,null);}finally{foreign.kill();await new Promise(resolve=>foreign.once('exit',resolve));if(previous)await fs.writeFile(file,previous);else await fs.unlink(file);}
  });
  await record('modified installed payload is refused with the original data intact',async()=>{const target=path.join(app,'app','public','token-motion.mjs'),bytes=await fs.readFile(target),before=await inventory(instance);try{await fs.appendFile(target,'\n// TEST_ONLY local modification');await assert.rejects(call(['--update']),/Command failed/);assert.deepEqual(await inventory(instance),before);}finally{await fs.writeFile(target,bytes);}});
  await record('wrong private-instance binding is refused',async()=>{const before=await inventory(instance);await assert.rejects(execute(installer,['--update','--destination='+app,'--instance='+path.join(root,'TEST_ONLY-other-instance'),'--test-only'],{windowsHide:true,timeout:15000}),/Command failed/);assert.deepEqual(await inventory(instance),before);});
  }
  const immutable=Object.fromEntries(Object.entries(await inventory(instance)).filter(([n])=>!n.startsWith('data/history')&&!n.startsWith('archive/')&&!n.startsWith('catalog/')&&!n.startsWith('analytics/')&&n!=='data/runtime.pid'));
  await record('running installation closes cleanly, upgrades and resumes the same instance',async()=>{
   // Match Explorer/Start menu launch. A detached Node child creates a different
   // Windows process group that can ignore CTRL_C and is an invalid normal-launch fixture.
   const script="$ErrorActionPreference='Stop'; $inputData=[Console]::In.ReadToEnd()|ConvertFrom-Json; $p=Start-Process -FilePath $inputData.executable -ArgumentList @('--launch','--no-browser') -WindowStyle Hidden -PassThru; [Console]::Out.Write($p.Id)";
   const launching=execute('C:/Program Files/PowerShell/7/pwsh.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000,maxBuffer:16384});launching.child.stdin.end(JSON.stringify({executable:path.join(app,'CodexControl-Community.exe')}));oldLauncher={pid:Number((await launching).stdout.trim()),unref(){}};
   await waitFor(async()=>{try{return (await (await fetch(hubConfig.publicOrigin+'/api/identity')).json()).deploymentId===hubConfig.instanceId;}catch{return false;}},45000);
   const pidBefore=JSON.parse(await fs.readFile(path.join(instance,'data','runtime.pid'),'utf8'));const result=await call(['--update']);assert.match(result.stdout,/UPDATED/);const pidAfter=JSON.parse(await fs.readFile(path.join(instance,'data','runtime.pid'),'utf8'));assert.notEqual(pidAfter.pid,pidBefore.pid);assert.equal(pidAfter.instanceId,pidBefore.instanceId);assert.equal(pidAfter.stoppedAt,undefined);const current=await inventory(instance);for(const [n,v]of Object.entries(immutable))assert.equal(current[n],v,'Protected state changed: '+n);const retained=await history(instance);assert.ok(retained.events>=recordsBefore.events);assert.ok(retained.quota>=recordsBefore.quota);assert.deepEqual(retained.retained,recordsBefore.retained);
  });
  await record('rollback after a replacement starts retains later records and resumes the previous app',async()=>{const original=await inventory(app),before=history(instance);await assert.rejects(call(['--update'],{CODEXCONTROL_TEST_UPDATE_FAIL_AT:'before-commit'}),/TEST_ONLY injected update failure/);assert.deepEqual(await inventory(app),original);const receipts=[];for(const d of await fs.readdir(path.join(root,'maintenance-backups'))){try{receipts.push(JSON.parse(await fs.readFile(path.join(root,'maintenance-backups',d,'UPDATE_RECEIPT.json'),'utf8')));}catch{}}receipts.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));assert.equal(receipts[0].phase,'rolled-back-private-data-retained');await waitFor(async()=>{try{return (await (await fetch(hubConfig.publicOrigin+'/api/identity')).json()).deploymentId===hubConfig.instanceId;}catch{return false;}},45000);const current=await inventory(instance);for(const [n,v]of Object.entries(immutable))assert.equal(current[n],v,'Protected state changed: '+n);assert.deepEqual((await history(instance)).retained,(await before).retained);});
  await record('native maintenance stop closes only the fixture after verification',async()=>{await call(['--stop']);const pid=JSON.parse(await fs.readFile(path.join(instance,'data','runtime.pid'),'utf8'));assert.ok(pid.stoppedAt);});
  await record('same-version production update is a no-op without credential regeneration',async()=>{const before=await inventory(instance),application=await inventory(app);const result=await execute(installer,['--update','--destination='+app,'--instance='+instance,'--no-browser'],{windowsHide:true,timeout:60000,maxBuffer:1048576});assert.match(result.stdout,/UPDATE_ALREADY_CURRENT/);assert.deepEqual(await inventory(instance),before);assert.deepEqual(await inventory(app),application);});
  return {status:'PASS_NATIVE_UPGRADE_PRESERVATION',cases:results.length,root,evidence,recordsBefore,results};
 }finally{fixturePassword=null;try{const pid=JSON.parse(await fs.readFile(path.join(instance,'data','runtime.pid'),'utf8'));if(!pid.stoppedAt)await call(['--stop']);}catch{}if(oldLauncher)oldLauncher.unref();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{const options={};for(const arg of process.argv.slice(2)){const m=/^--(installer|previous-installer|root|evidence|mode)=(.+)$/.exec(arg);if(!m)throw Error('Explicit native fixture arguments required');options[m[1]==='previous-installer'?'previousInstaller':m[1]]=m[2];}if(options.mode&&!['all','running'].includes(options.mode))throw Error('Known test mode required');console.log(JSON.stringify(await testWindowsUpgrade(options),null,2));}catch(error){console.error(JSON.stringify({status:'FAIL_NATIVE_UPGRADE',error:error.message}));process.exitCode=1;}
