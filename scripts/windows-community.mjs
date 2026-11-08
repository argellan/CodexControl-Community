import {provisionDesktopOwnerLogin} from '../lib/desktop-owner-login.mjs';
import {requireCommunityRole} from '../lib/community-platform.mjs';
import {installCrashEvidence} from '../lib/crash-evidence.mjs';
// Author: Bishop Crockett
// Owner: Argellan.com
// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const execute=promisify(execFile),APP=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),BUNDLE=path.dirname(APP);
const python=path.join(BUNDLE,'runtimes','python','python.exe');
const save=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
async function tool(script,config,mode){return execute(python,['-I','-B',path.join(APP,'scripts',script),'--config',config,mode],{timeout:30000,maxBuffer:262144,windowsHide:true,env:{...process.env,PYTHONPATH:undefined,PYTHONHOME:undefined}});}
function parse(args){const result={};for(const a of args){const m=/^--([a-z-]+)(?:=(.+))?$/.exec(a);if(!m||!['initialize','run','instance','port','session-root','role'].includes(m[1])||Object.hasOwn(result,m[1]))throw new Error('Unsupported Windows launcher argument');result[m[1]]=m[2]??true;}if(Boolean(result.initialize)===Boolean(result.run)||typeof result.instance!=='string'||!path.isAbsolute(result.instance)||/^(?:\\\\|\/\/)/.test(result.instance))throw new Error('Choose initialize or run and an absolute local instance');return result;}
export async function initializeWindowsInstance({instance,port=4317,sessionRoot,role='standalone'}={}){
 if(process.platform!=='win32')throw new Error('Native Windows required');
 if(!['hub','node','standalone'].includes(role))throw new Error('Choose Hub, Node or Standalone');requireCommunityRole(role);
 const {createInstance}=await import('./setup-instance.mjs');
 const result=await createInstance({mode:'single-computer',instanceDirectory:instance,hostId:'community-local',instanceName:'CodexControl Community',appDirectory:APP,sessionRoot:sessionRoot||path.join(instance,'empty-source'),port});
 if(!sessionRoot)await fs.mkdir(path.join(instance,'empty-source'),{mode:0o700});
 const receiverId=crypto.randomUUID(),receiverConfig=path.join(instance,'local-receiver.json'),analyticsConfig=path.join(instance,'local-analytics.json');
 for(const name of ['archive','catalog','analytics'])await fs.mkdir(path.join(instance,name),{mode:0o700});
 await save(receiverConfig,{archiveDirectory:path.join(instance,'archive'),catalogDirectory:path.join(instance,'catalog'),receiverId});
 await save(analyticsConfig,{version:1,receiverConfig,databaseDirectory:path.join(instance,'analytics'),memoryLimitMb:128,threads:1,queryTimeoutSeconds:10});
 await tool('archive-receiver.py',receiverConfig,'--status');await tool('archive-analytics.py',analyticsConfig,'--sync');
 const hubFile=path.join(instance,'hub.json'),hub=JSON.parse(await fs.readFile(hubFile,'utf8'));
 hub.installationRole=role;hub.installationNetwork={listen:'0.0.0.0',port:port+1,discovery:false};
 if(sessionRoot){hub.accountObserver={enabled:true,executable:path.join(process.env.LOCALAPPDATA,'OpenAI','Codex','bin','0000000000000000','codex.exe'),followDesktopUpdates:true,intervalMs:60000,timeoutMs:15000,nativeAnalytics:false};hub.desktopCompanion={enabled:true};}
 hub.historicalAnalytics={version:1,engine:'duckdb',expectedReceiverId:receiverId,local:{python,script:path.join(APP,'scripts','archive-analytics.py'),config:analyticsConfig},timeoutMs:20000,minIntervalMs:1000};
 await fs.writeFile(hubFile,JSON.stringify(hub,null,2)+'\n',{mode:0o600});
 await save(path.join(instance,'local-archive-sender.json'),{version:1,database:path.join(instance,'data','history.sqlite'),receiverId,local:{python,script:path.join(APP,'scripts','archive-receiver.py'),config:receiverConfig},maxBatches:4,maxRecords:1000,timeoutMs:20000});
 await provisionDesktopOwnerLogin({instance});
 return {status:'WINDOWS_PRIVATE_INSTANCE_PREPARED',instanceId:result.instanceId,origin:result.origin,version:'0.1.0',role,localArchive:true,localAnalytics:true,telemetryDefault:'off'};
}
export async function shutdownCommunityRuntime(server,{info=console.log,error=console.error,onSuccess=code=>process.exit(code),onFailure=()=>{process.exitCode=1;}}={}){
 try{
  await new Promise((resolve,reject)=>{server.close(failure=>failure?reject(failure):resolve());server.closeAllConnections();});
  info('COMMUNITY_STOPPED_DATA_PRESERVED');onSuccess(0);return true;
 }catch{
  error('COMMUNITY_STOP_FAILED: durable shutdown did not complete; private data remains in place.');
  onFailure();return false;
 }
}
export async function runWindowsInstance(instance,{crashEvidence}={}){
 const install=JSON.parse(await fs.readFile(path.join(instance,'installation.json'),'utf8'));
 if(path.resolve(install.appDirectory)!==APP)throw new Error('Installation pointer differs from selected application; use the qualified update/recovery seam');
 process.env.CODEX_CONTROL_CONFIG=path.join(instance,'hub.json');process.env.CODEX_CONTROL_HOST_ID=install.hostId;process.env.CODEX_CONTROL_SESSION_ROOT=install.sessionRoot;
 const config=JSON.parse(await fs.readFile(process.env.CODEX_CONTROL_CONFIG,'utf8'));
 const {startRuntime}=await import(pathToFileURL(path.join(APP,'server.mjs')).href);
 const {pumpUsageArchive,loadArchiveSenderConfig}=await import('./archive-usage.mjs');
 const runtime=await startRuntime(config);let stopping=false,busy=false,timer;
 const pump=async()=>{if(stopping||busy)return;busy=true;try{const sender=await loadArchiveSenderConfig(path.join(instance,'local-archive-sender.json'));await pumpUsageArchive(sender);await tool('archive-analytics.py',path.join(instance,'local-analytics.json'),'--sync');}catch{console.error('Local archive pending; original rows retained for retry.');}finally{busy=false;}};
 const stop=async()=>{if(stopping)return;stopping=true;clearInterval(timer);for(let i=0;busy&&i<650;i++)await new Promise(r=>setTimeout(r,100));if(busy){console.error("Local archive operation still closing; private rows retained.");process.exitCode=1;return;}await shutdownCommunityRuntime(runtime.server);};
 process.once('SIGINT',()=>{crashEvidence?.signal('SIGINT');void stop();});
 process.once('SIGTERM',()=>{crashEvidence?.signal('SIGTERM');void stop();});
 if(!process.stdin.isTTY){process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',chunk=>{input+=chunk;if(input.length>64)process.stdin.pause();if(input.trim()==='stop')void stop();});}
 await pump();timer=setInterval(pump,60000);timer.unref();
 console.log(JSON.stringify({status:'COMMUNITY_READY',origin:config.publicOrigin,instanceId:runtime.instanceId,version:'0.1.0',loopbackOnly:config.listen==='127.0.0.1'}));
 console.log('Sign in with the private owner access file in your instance directory; credentials are never printed. Ctrl+C stops this instance.');
 return runtime;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let crashEvidence;
 try{
  const args=parse(process.argv.slice(2));
  if(args.run&&process.env.CODEX_CONTROL_CRASH_RUN_ID){
   try{crashEvidence=installCrashEvidence({directory:path.join(args.instance,'data','crash-reports'),correlationId:process.env.CODEX_CONTROL_CRASH_RUN_ID,buildId:process.env.CODEX_CONTROL_CRASH_BUILD_ID});}
   catch{console.error('Local crash evidence unavailable; runtime continues.');}
  }
  if(args.initialize)console.log(JSON.stringify(await initializeWindowsInstance({instance:args.instance,port:Number(args.port||4317),sessionRoot:args['session-root'],role:args.role||'standalone'})));
  else await runWindowsInstance(args.instance,{crashEvidence});
 }catch(error){crashEvidence?.startup(error);console.error('COMMUNITY_STARTUP_FAILED: private setup/runtime evidence retained; no credentials printed.');process.exitCode=1;}
}
