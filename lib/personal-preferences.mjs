// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {normalizePersonalSettings,validatePersonalSettings} from '../public/settings-view-model.mjs';
const queues=new Map();let pending=0;const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const failure=(message,status)=>Object.assign(new Error(message),{status});
export class PersonalPreferences {
 constructor(directory,profile='local-viewer'){this.directory=path.resolve(directory);this.file=path.join(this.directory,hash(profile)+'.json');this.backup=this.file+'.last-good';}
 #serial(fn,{write=false}={}){
  const now=Date.now();for(const [file,state] of queues)if(!state.pending&&now>=state.until)queues.delete(file);
  const state=queues.get(this.file)||{tail:Promise.resolve(),pending:0,writes:0,until:now+10000};
  if(now>=state.until){state.writes=0;state.until=now+10000;}
  if(state.pending>=4||pending>=32||write&&state.writes>=12||!queues.has(this.file)&&queues.size>=512)return Promise.reject(Object.assign(failure('Presentation storage busy; try again shortly',429),{retryAfter:1}));
  state.pending++;pending++;if(write)state.writes++;queues.set(this.file,state);
  const next=state.tail.then(fn).finally(()=>{state.pending--;pending--;});state.tail=next.catch(()=>{});return next;
 }
 async #decode(file){const stat=await fs.stat(file);if(!stat.isFile()||stat.size>65536)throw new Error('Invalid profile');const value=JSON.parse(await fs.readFile(file,'utf8'));if(!Number.isSafeInteger(value.revision)||value.revision<0||!value.preferences||typeof value.preferences!=='object')throw new Error('Invalid profile');return {...value,exists:true,preferences:validatePersonalSettings(value.preferences),audit:Array.isArray(value.audit)?value.audit.slice(-64):[]};}
 async #atomic(file,value,verifyAuthority){await fs.mkdir(this.directory,{recursive:true,mode:0o700});const bytes=JSON.stringify(value);if(Buffer.byteLength(bytes)>65536)throw failure('Profile exceeds budget',413);const temporary=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';let handle;try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;verifyAuthority?.();await fs.rename(temporary,file);if(process.platform!=='win32'){const dir=await fs.open(this.directory,'r');try{await dir.sync();}finally{await dir.close();}}}finally{if(handle)await handle.close();await fs.unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
 async #load(verifyAuthority){try{return await this.#decode(this.file);}catch(error){let backup;try{backup=await this.#decode(this.backup);}catch(backupError){if(error.code==='ENOENT'&&backupError.code==='ENOENT')return {exists:false,revision:0,preferences:normalizePersonalSettings(),audit:[]};throw failure('Presentation profile requires recovery; saved data was not overwritten',503);}const recovered={...backup,revision:backup.revision+1,recovered:true,updatedAt:new Date().toISOString()};await this.#atomic(this.file,recovered,verifyAuthority);await this.#atomic(this.backup,recovered);return recovered;}}
 read({verifyAuthority}={}){return this.#serial(()=>{verifyAuthority?.();return this.#load(verifyAuthority);});}
 write(value,{revision,actor={id:'legacy',role:'viewer'},verifyAuthority}={}){
  let patch;try{if(Buffer.byteLength(JSON.stringify(value)||'')>65536)throw failure('Profile exceeds budget',413);const active=Object.hasOwn(value??{},'activeLayoutId');if(active&&value.activeLayoutId!==null&&(typeof value.activeLayoutId!=='string'||!/^[a-z0-9_-]{1,100}$/i.test(value.activeLayoutId)))throw failure('Invalid named layout identity',400);const checked=validatePersonalSettings(active?{...value,activeLayoutId:null}:value);patch=Object.fromEntries(Object.keys(value).map(k=>[k,k==='activeLayoutId'?value[k]:checked[k]]));}catch(error){return Promise.reject(error);}
  const auditActor={id:String(actor.id||'unknown').slice(0,64),role:actor.role==='admin'?'admin':'viewer'};
  return this.#serial(async()=>{verifyAuthority?.();const previous=await this.#load(verifyAuthority);if(revision!==undefined&&(!Number.isSafeInteger(revision)||revision!==previous.revision))throw failure('Presentation profile changed in another tab; reload or merge before saving',409);const preferences=validatePersonalSettings({...previous.preferences,...patch}),changedPaths=Object.keys(preferences).filter(k=>JSON.stringify(preferences[k])!==JSON.stringify(previous.preferences[k]));const result={exists:true,revision:previous.revision+1,preferences,updatedAt:new Date().toISOString(),audit:[...(previous.audit||[]),{at:new Date().toISOString(),actor:auditActor,changedPaths}].slice(-64)};if(previous.exists)await this.#atomic(this.backup,previous);await this.#atomic(this.file,result,verifyAuthority);await this.#atomic(this.backup,result);return result;},{write:true});}
}
