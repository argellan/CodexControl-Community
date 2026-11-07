// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {SCHEMA_VERSION,DEFAULT_CONFIGURATION,SETTINGS_SCHEMA,validateConfiguration} from '../public/settings-schema.mjs';
export {validateConfiguration};

const queues=new Map(),MAX_BYTES=2097152,MAX_AUDIT=256;
const allowedPaths=new Set(SETTINGS_SCHEMA.map(f=>f.path));
const copy=value=>structuredClone(value);
const statusError=(message,status)=>Object.assign(new Error(message),{status});
const actorValue=value=>({id:typeof value?.id==='string'&&/^[a-z0-9][-a-z0-9_]{0,63}$/i.test(value.id)?value.id:'unknown',role:['admin','viewer','operator','system','local'].includes(value?.role)?value.role:'unknown'});
const actorSystem={id:'system',role:'system'};
const restart=paths=>paths.some(p=>SETTINGS_SCHEMA.find(f=>f.path===p)?.restartRequired);
function differences(previous,next){return SETTINGS_SCHEMA.filter(f=>JSON.stringify(f.path.split('.').reduce((v,k)=>v?.[k],previous))!==JSON.stringify(f.path.split('.').reduce((v,k)=>v?.[k],next))).map(f=>f.path);}
function auditEntry({revision,action,actor,changedPaths,requiresRestart,at=new Date().toISOString()}){return {revision,at,action,actor:actorValue(actor),changedPaths:changedPaths.filter(p=>allowedPaths.has(p)),requiresRestart:requiresRestart===true};}

export class ConfigurationStore {
 static async open({directory,initial=DEFAULT_CONFIGURATION}={}){
  if(typeof directory!=='string'||!directory)throw statusError('Configuration directory required',400);
  const store=new ConfigurationStore();store.directory=path.resolve(directory);store.file=path.join(store.directory,'configuration.json');store.backup=path.join(store.directory,'configuration.last-good.json');store.initial=validateConfiguration(initial);
  await fs.mkdir(store.directory,{recursive:true,mode:0o700});await store.#serial(()=>store.#load(true));return store;
 }
 #serial(fn){const previous=queues.get(this.directory)||Promise.resolve(),next=previous.then(fn);queues.set(this.directory,next.catch(()=>{}));return next;}
  async #atomic(file,value,authorize,verifyAuthority){
  const bytes=JSON.stringify(value);if(Buffer.byteLength(bytes)>MAX_BYTES)throw statusError('Configuration exceeds storage budget',413);
  const temporary=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';let handle,failure;
  // Recheck the request synchronously after registry I/O, immediately before rename dispatch.
   try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;await authorize?.();verifyAuthority?.();await fs.rename(temporary,file);if(process.platform!=='win32'){const directory=await fs.open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}}}
  catch(error){failure=error;}
  // Attempt both cleanup steps without replacing the original write/refusal error.
  try{if(handle)await handle.close();}catch(error){failure??=error;}
  try{await fs.unlink(temporary);}catch(error){if(error.code!=='ENOENT')failure??=error;}
  if(failure)throw failure;
 }
 async #decode(file){
  const stat=await fs.stat(file);if(!stat.isFile()||stat.size>MAX_BYTES)throw new Error('Invalid configuration state file');
  const raw=await fs.readFile(file,'utf8');if(Buffer.byteLength(raw)>MAX_BYTES)throw new Error('Configuration state exceeds budget');const state=JSON.parse(raw);
  if(!state||state.schemaVersion!==SCHEMA_VERSION||!Number.isSafeInteger(state.revision)||state.revision<1||typeof state.requiresRestart!=='boolean'||!Array.isArray(state.audit)||state.audit.length>MAX_AUDIT)throw new Error('Invalid configuration state');
  const configuration=validateConfiguration(state.configuration),previousConfiguration=state.previousConfiguration===null?null:validateConfiguration(state.previousConfiguration);
  const audit=state.audit.map(a=>{if(!a||!Number.isSafeInteger(a.revision)||a.revision<1||a.revision>state.revision||!['seed','save','rollback','recovery','activate'].includes(a.action)||!Number.isFinite(Date.parse(a.at))||!Array.isArray(a.changedPaths))throw new Error('Invalid configuration audit');return auditEntry({...a,at:new Date(a.at).toISOString()});});
  return {schemaVersion:SCHEMA_VERSION,revision:state.revision,configuration,previousConfiguration,requiresRestart:state.requiresRestart,changedPaths:Array.isArray(state.changedPaths)?state.changedPaths.filter(p=>allowedPaths.has(p)):[],audit,recovered:state.recovered===true};
 }
 async #load(initialize=false){
  try{return await this.#decode(this.file);}catch(primaryError){
   let backup;try{backup=await this.#decode(this.backup);}catch(backupError){
    if(initialize&&primaryError.code==='ENOENT'&&backupError.code==='ENOENT'){
     const state={schemaVersion:SCHEMA_VERSION,revision:1,configuration:copy(this.initial),previousConfiguration:null,requiresRestart:false,changedPaths:[],recovered:false,audit:[auditEntry({revision:1,action:'seed',actor:actorSystem,changedPaths:[],requiresRestart:false})]};
     await this.#atomic(this.backup,state);await this.#atomic(this.file,state);return state;
    }
    throw statusError('Configuration recovery unavailable; preserve the existing files for repair',503);
   }
   if(backup.revision>Number.MAX_SAFE_INTEGER-2)throw statusError('Configuration recovery revision exhausted',503);
   const revision=backup.revision+2,recovered={...backup,revision,recovered:true,requiresRestart:true,changedPaths:[],audit:[...backup.audit,auditEntry({revision,action:'recovery',actor:actorSystem,changedPaths:[],requiresRestart:true})].slice(-MAX_AUDIT)};
   await this.#atomic(this.file,recovered);await this.#atomic(this.backup,recovered);return recovered;
  }
 }
 #public(state){return {configuration:copy(state.configuration),revision:state.revision,requiresRestart:state.requiresRestart,changedPaths:[...state.changedPaths],recovered:state.recovered===true};}
 read(){return this.#serial(async()=>this.#public(await this.#load()));}
 validate(configuration){return validateConfiguration(configuration);}
  save({revision,configuration,actor,authorize,verifyAuthority}={}){return this.#serial(async()=>{await authorize?.();const state=await this.#load();if(revision!==state.revision)throw statusError('Configuration revision conflict; reload before saving',409);return this.#commit(state,validateConfiguration(configuration),actor,'save',authorize,verifyAuthority);});}
  rollback({revision,actor,authorize,verifyAuthority,preserveGeneral}={}){return this.#serial(async()=>{await authorize?.();const state=await this.#load();if(revision!==state.revision)throw statusError('Configuration revision conflict; reload before rollback',409);if(!state.previousConfiguration)throw statusError('No previous configuration is available',409);const previous=copy(state.previousConfiguration);if(preserveGeneral)previous.general={...previous.general,...preserveGeneral};return this.#commit(state,validateConfiguration(previous),actor,'rollback',authorize,verifyAuthority);});}
 applyInstallationName(name){return this.#serial(async()=>{const state=await this.#load();if(state.configuration.general.instanceName===name)return this.#public(state);const next=copy(state.configuration);next.general.instanceName=name;return this.#commit(state,validateConfiguration(next),actorSystem,'save',undefined,undefined,true);});}
 applyInstallationRole(role){return this.#serial(async()=>{const state=await this.#load();if(!['standalone','hub','node'].includes(role))throw statusError('Unsupported installation role',400);if(state.configuration.general.installationRole===role)return this.#public(state);const next=copy(state.configuration);next.general.installationRole=role;return this.#commit(state,next,actorSystem,'save',undefined,undefined,true);});}
 activate({revision,actor}={}){return this.#serial(async()=>{const state=await this.#load();if(revision!==state.revision)throw statusError('Configuration revision conflict; reload before activation',409);if(!state.requiresRestart)return this.#public(state);if(state.revision>=Number.MAX_SAFE_INTEGER)throw statusError('Configuration revision exhausted',503);const next={...state,revision:state.revision+1,requiresRestart:false,changedPaths:[],recovered:false};next.audit=[...state.audit,auditEntry({revision:next.revision,action:'activate',actor,changedPaths:[],requiresRestart:false})].slice(-MAX_AUDIT);await this.#atomic(this.backup,state);await this.#atomic(this.file,next);return this.#public(next);});}
  async #commit(state,configuration,actor,action,authorize,verifyAuthority,preservePrevious=false){
  const changedPaths=differences(state.configuration,configuration);if(!changedPaths.length)return this.#public(state);
  if(state.revision>=Number.MAX_SAFE_INTEGER)throw statusError('Configuration revision exhausted',503);
  const revision=state.revision+1,requiresRestart=state.requiresRestart||restart(changedPaths);
  const next={schemaVersion:SCHEMA_VERSION,revision,configuration:copy(configuration),previousConfiguration:copy(preservePrevious?state.previousConfiguration:state.configuration),requiresRestart,changedPaths,recovered:false,audit:[...state.audit,auditEntry({revision,action,actor,changedPaths,requiresRestart})].slice(-MAX_AUDIT)};
  // Previous document, audit and rollback target are one atomic envelope. A
  // failed primary replacement therefore cannot publish a partial revision.
   await this.#atomic(this.backup,state);await this.#atomic(this.file,next,authorize,verifyAuthority);return this.#public(next);
 }
 audit(){return this.#serial(async()=>copy((await this.#load()).audit));}
}
