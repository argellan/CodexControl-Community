import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ControlError} from '../../lib/errors.mjs';
import {strictRecord,integer,deepFreeze} from '../../lib/privacy.mjs';
import {ProjectRoot} from '../../host/project-root.mjs';
import {assertCodexProfile,codexSpawnSnapshot} from './compatibility.mjs';
import {CodexStdioTransport} from './transport.mjs';
import {assertWindowsJobHost} from './windows-job.mjs';
const fail=code=>{throw new ControlError(code??'CONTROL_DISABLED');};
const instances=new WeakSet();
export function codexSpawnPlan(profile,root){
  const selected=codexSpawnSnapshot(profile);if(!(root instanceof ProjectRoot))fail('INVALID_INPUT');root.assertCurrent();if(fs.existsSync(path.join(root.directory,'.codex','config.toml')))fail('CONTROL_DISABLED');
  const env=Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'].filter(k=>typeof process.env[k]==='string').map(k=>[k,process.env[k]]));
  // No inherited provider keys, proxies, NODE_OPTIONS, shell PATH or worker tier.
  env.CODEX_HOME=selected.codexHome;
  const args=['app-server','--listen','stdio://','-c','model="gpt-6.1-sol"','-c','model_reasoning_effort='+JSON.stringify(selected.effort),'-c','service_tier="default"','-c','approval_policy="never"','-c','approvals_reviewer="user"','-c','sandbox_mode="read-only"','-c','shell_environment_policy.inherit="none"','-c','features.multi_agent=false','-c','features.fast_mode=false','-c','analytics.enabled=false','--disable','hooks','--disable','plugins','--disable','apps','--disable','skill_mcp_dependency_install','--disable','code_mode_host','--disable','multi_agent','--disable','in_app_browser','--disable','computer_use','--disable','shell_tool','--disable','unified_exec','--disable','unified_exec_tty','-c','developer_instructions=""','-c','instructions=""','-c','project_doc_max_bytes=0','-c','web_search="disabled"'];
  for(const name of selected.disabledMcpServers)args.push('-c','mcp_servers.'+name+'.enabled=false');
  return {executable:selected.executable,args,options:{cwd:root.directory,env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']}};
}
export class OwnedCodexRuntime {
  #child;#transport;#profile;#root;#exit;#resolve;#binding=randomUUID();#closed=false;#exited=false;#exitMetadata=null;#stderrBytes=0;#tree=null;
  static launch(options){return new OwnedCodexRuntime(options);}
  constructor(options){
    strictRecord(options,['profile','root','beforeSpawn','onNotification','onServerRequest','onClose','processTreeHost'],['profile','root','beforeSpawn']);
    const {profile,root,beforeSpawn,onNotification=()=>{},onServerRequest=()=>{},onClose=()=>{}}=options;
    if(typeof beforeSpawn!=='function')fail('INVALID_INPUT');const nativePlan=codexSpawnPlan(profile,root);let plan=nativePlan;if(options.processTreeHost!==undefined){plan=assertWindowsJobHost(options.processTreeHost,nativePlan);this.#tree=plan.control;}this.#profile=profile;this.#root=root;
    this.#exit=new Promise(resolve=>{this.#resolve=resolve;});
    const guarded=beforeSpawn();if(guarded&&typeof guarded.then==='function')fail('INVALID_INPUT');
    // Final gate and spawn share this synchronous call stack, without shell/wrapper.
    this.#child=spawn(plan.executable,plan.args,plan.options);
    this.#child.once('error',()=>{this.#closed=true;this.#transport?.close();if(!this.#child.pid){this.#exitMetadata=deepFreeze({exited:true,exitCode:null,signal:null,processTreeExitConfirmed:false});this.#exited=true;this.#resolve(this.#exitMetadata);}});
    this.#child.once('close',(code,signal)=>{this.#closed=true;this.#transport?.close();this.#exited=true;this.#exitMetadata=deepFreeze({exited:true,exitCode:code,signal,processTreeExitConfirmed:false,...(this.#tree?.proof(this.#child.pid)??{})});this.#resolve(this.#exitMetadata);});
    // Count and discard diagnostics; do not retain, hash or expose raw stderr.
    this.#child.stderr.on('data',chunk=>{this.#stderrBytes+=chunk.length;if(this.#stderrBytes>262144)this.#transport?.close();});
    this.#transport=new CodexStdioTransport({readable:this.#child.stdout,writable:this.#child.stdin,onNotification,onServerRequest,onClose});
    instances.add(this);
  }
  assertCurrent(){if(this.#closed||this.#exited||!this.#child.pid)fail('CLOSED');assertCodexProfile(this.#profile);this.#root.assertCurrent();return this.metadata;}
  get metadata(){return deepFreeze({processBinding:this.#binding,pid:this.#child.pid??null,exited:this.#exited,stderrBytes:this.#stderrBytes});}
  request(method,params,options){this.assertCurrent();return this.#transport.request(method,params,options);}
  initialized(options){this.assertCurrent();return this.#transport.initialized(options);}
  async stop({beforeStop,timeoutMs=5000}){
    if(typeof beforeStop!=='function')fail('INVALID_INPUT');integer(timeoutMs,1,10000);
    if(this.#exited)return this.#exitMetadata;
    const result=beforeStop();if(result&&typeof result.then==='function')fail('INVALID_INPUT');
    // Only this retained ChildProcess object. No durable PID lookup/adoption.
    if(this.#tree)this.#tree.requestStop();else this.#child.kill();this.#transport.close();
    let timer;try{return await Promise.race([this.#exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new ControlError('EXPIRED')),timeoutMs);})]);}finally{clearTimeout(timer);}
  }
  waitForExit(){return this.#exit;}
  get exited(){return this.#exited;}
  get closed(){return this.#closed||this.#transport.closed;}
}
export function assertOwnedCodexRuntime(runtime){if(!instances.has(runtime))fail('CONTROL_DISABLED');return runtime.assertCurrent();}
