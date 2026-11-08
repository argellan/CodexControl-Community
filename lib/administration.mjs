// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {ADMINISTRATION_FORMAT} from './administration-format.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createReadStream} from 'node:fs';
import {DatabaseSync,backup as sqliteBackup} from 'node:sqlite';
import {USAGE_TABLE_COLUMNS,validateUsageDatabase} from './usage-history.mjs';
import {USAGE_SAMPLE_IMMUTABLE_TRIGGERS} from './usage-samples.mjs';
import {ARCHIVE_TABLE_COLUMNS,ARCHIVE_TRIGGER_NAMES,validateArchiveDatabase} from './usage-archive.mjs';
import {ViewerAccess} from './viewer-access.mjs';
import {hashPassword,verifyPassword,normalizeUsername} from './password-auth.mjs';
import {DEFAULT_CONFIGURATION,validateConfiguration} from '../public/settings-schema.mjs';
import {HistoryJournal} from './history.mjs';
import {ADMISSION_TABLE_COLUMNS,ADMISSION_TRIGGERS,validateStorageAdmission} from './storage-admission.mjs';
import {processBackupObjectNames,validateProcessBackup} from './process-backup.mjs';

const queues=new Map(),MAX_BYTES=1048576;
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const clone=v=>structuredClone(v);
const requestIdValue=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const hostnameValue=v=>typeof v==='string'&&v.length<=253&&/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(v)&&!v.includes('..');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const id=v=>typeof v==='string'&&/^[a-z0-9][-a-z0-9_]{0,63}$/.test(v);
const machineId=v=>typeof v==='string'&&/^[-a-z0-9]{1,64}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/i.test(v);
const text=(v,max=120)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const active=v=>!v.disabled&&(!v.expiresAt||Date.parse(v.expiresAt)>Date.now());
const status=v=>v.disabled?'revoked':v.expiresAt&&Date.parse(v.expiresAt)<=Date.now()?'expired':'active';
const expiry=v=>{if(v===undefined||v===null)return null;if(typeof v!=='string'||!Number.isFinite(Date.parse(v)))fail('Invalid credential expiry');return new Date(v).toISOString();};
const fields=(v,allowed)=>{if(!object(v)||Object.keys(v).some(k=>!allowed.includes(k)))fail('Unsupported administration field');};
const publicUser=v=>({id:v.id,label:v.label,role:v.role,username:v.username??null,passwordEnabled:!!v.passwordHash,passwordChangeRequired:v.passwordChangeRequired===true,hostIds:clone(v.hostIds),projectIds:clone(v.projectIds),expiresAt:v.expiresAt,disabled:v.disabled,status:status(v),credentialFingerprint:'sha256:'+v.tokenHash.slice(0,12)});
const publicHost=h=>{const {tokenHash,...metadata}=h;return {...clone(metadata),status:status(h),credentialFingerprint:'sha256:'+tokenHash.slice(0,12)};};
const activeAdmins=state=>state.viewers.filter(v=>v.role==='admin'&&v.hostIds===null&&v.projectIds===null&&active(v));
const BACKUP_LIMITS=Object.freeze({maxBackups:3,maxBytes:512*1048576,totalBytes:768*1048576});
const backupId=value=>typeof value==='string'&&/^backup-\d{13}-[a-f0-9]{12}$/.test(value);
const configurationValue=value=>validateConfiguration(value?.configuration||value);
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
async function syncDirectory(directory){if(process.platform==='win32')return;const handle=await fs.open(directory,'r');try{await handle.sync();}finally{await handle.close();}}
async function privateJSON(file,value){const handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}}
async function fileHash(file){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>BACKUP_LIMITS.maxBytes)fail('Invalid backup file',409);const digest=crypto.createHash('sha256');for await(const chunk of createReadStream(file,{highWaterMark:262144}))digest.update(chunk);return {sha256:digest.digest('hex'),bytes:stat.size};}
function metadataOnly(value){const stack=[{value,depth:0}];let seen=0;while(stack.length){const {value:v,depth}=stack.pop();if(++seen>250000||depth>32)fail('Journal metadata privacy bound exceeded',409);if(!v||typeof v!=='object')continue;for(const [key,child] of Object.entries(v)){if(/^(?:arguments|output|content|prompt|reasoning|authorization|tokenHash|viewTokenHash|accessToken|refreshToken|password|passwordHash|privateKey|commandLine|command)$/i.test(key))fail('Journal metadata privacy validation failed',409);if(child&&typeof child==='object')stack.push({value:child,depth:depth+1});}}}
export function inspectJournal(file){
 const db=new DatabaseSync(file,{readOnly:true});try{
  const tables=db.prepare("SELECT name,type FROM sqlite_master WHERE type IN ('table','view','trigger')").all();if(tables.some(t=>t.type==='trigger'?![...ARCHIVE_TRIGGER_NAMES,...Object.keys(USAGE_SAMPLE_IMMUTABLE_TRIGGERS),...Object.keys(ADMISSION_TRIGGERS),...processBackupObjectNames('trigger')].includes(t.name):t.type!=='table'||!['metadata','events','host_state',...Object.keys(USAGE_TABLE_COLUMNS),...Object.keys(ARCHIVE_TABLE_COLUMNS),...Object.keys(ADMISSION_TABLE_COLUMNS),...processBackupObjectNames('table')].includes(t.name)&&!t.name.startsWith('sqlite_')))fail('Unexpected journal schema in backup',409);
  for(const [name,columns] of [['metadata',['key','value']],['events',['sequence','event_id','host_id','occurred_ms','received_ms','payload','bytes']],['host_state',['host_id','payload']]])if(JSON.stringify(db.prepare('PRAGMA table_info('+name+')').all().map(c=>c.name))!==JSON.stringify(columns))fail('Unsupported journal schema in backup',409);
  const checks=db.prepare('PRAGMA quick_check').all();if(checks.some(row=>Object.values(row).some(v=>v!=='ok')))fail('Journal integrity verification failed',409);
  const metadata=Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all().map(r=>[r.key,r.value]));if(Object.keys(metadata).some(k=>!['epoch','floor','gapThrough','retainedBytes','retainedEvents'].includes(k))||typeof metadata.epoch!=='string'||!/^[a-f0-9-]{36}$/i.test(metadata.epoch))fail('Unexpected journal metadata in backup',409);
  for(const [table,max] of [['events',32768],['host_state',2097152]])for(const row of db.prepare('SELECT payload FROM '+table).iterate()){if(Buffer.byteLength(row.payload)>max)fail('Journal metadata exceeds its backup bound',409);metadataOnly(JSON.parse(row.payload));}
  const retainedEvents=db.prepare('SELECT COUNT(*) AS count FROM events').get().count;if(retainedEvents!==Number(metadata.retainedEvents))fail('Journal count verification failed',409);
  let usage;if(tables.some(t=>Object.hasOwn(USAGE_TABLE_COLUMNS,t.name))){try{usage=validateUsageDatabase(db);}catch{fail('Usage history validation failed in backup',409);}}
  let archive;try{const result=validateArchiveDatabase(db);if(!result.legacy)archive=result;}catch{fail('Usage archive custody validation failed in backup',409);}
  try{validateStorageAdmission(db);}catch{fail('Storage admission validation failed in backup',409);}
  let processes;try{processes=validateProcessBackup(db);}catch{fail('Process history schema or custody validation failed in backup',409);}
  return {schemaVersion:1,epoch:metadata.epoch,latestSequence:db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get()?.seq||0,retainedEvents,...(usage?{usage}:{}),...(archive?{archive}:{}),...(processes?{processes}:{})};
 }finally{db.close();}
}

export function sanitizedSupportBundle({snapshot={},configuration,diagnostics={},instanceId='unknown'}={}){
 const config=configurationValue(configuration),hosts=Array.isArray(snapshot.hosts)?snapshot.hosts:[],statusCounts={};for(const h of hosts){const key=['online','stale','disconnected','disabled','not connected'].includes(h.status)?h.status:'unknown';statusCounts[key]=(statusCounts[key]||0)+1;}
 const runtime={},storage={};for(const key of ['uptimeSeconds','rssBytes','heapUsedBytes','cpuPercent','eventLoopUtilization'])runtime[key]=number(diagnostics.runtime?.[key]);for(const key of ['node','platform'])if(typeof diagnostics.runtime?.[key]==='string'&&/^[a-zA-Z0-9._-]{1,40}$/.test(diagnostics.runtime[key]))runtime[key]=diagnostics.runtime[key];for(const key of ['databaseBytes','walBytes','sharedMemoryBytes','totalBytes'])storage[key]=number(diagnostics.storage?.[key]);
 return {schemaVersion:1,generatedAt:new Date().toISOString(),instanceId,scope:'Sanitized policy, counts and observer health only',configuration:{schemaVersion:config.schemaVersion,installationRole:config.general.installationRole,timezone:config.general.timezone,timeFormat:config.general.timeFormat,history:clone(config.history),alerts:{minimumSeverity:config.alerts.minimumSeverity,thresholds:clone(config.alerts.thresholds),quietHoursEnabled:config.alerts.quietHours.enabled,presentation:clone(config.alerts.presentation)},networking:{expectedTls:config.networking.expectedTls,remoteListening:!['127.0.0.1','localhost','::1'].includes(config.networking.listen)},inventory:{hosts:config.fleet.hosts.length,sources:config.sources.length}},observations:{hostCount:hosts.length,hostStatusCounts:statusCounts,sessionCount:Array.isArray(snapshot.sessions)?snapshot.sessions.length:0,eventCount:Array.isArray(snapshot.events)?snapshot.events.length:0},runtime,storage,exclusions:['Source paths and addresses','Users and security registry','Credentials and private keys','Raw events, prompts, commands and output']};
}

function normalizedUser(value){
 fields(value,['id','label','tokenHash','role','hostIds','projectIds','expiresAt','disabled','username','passwordHash','passwordChangeRequired']);
 if(!id(value.id)||['local','legacy'].includes(value.id)||!text(value.label)||!digest(value.tokenHash))fail('Invalid viewer identity or credential hash');
 const user={id:value.id,label:value.label.trim(),tokenHash:value.tokenHash.toLowerCase(),role:value.role??'viewer',hostIds:value.hostIds,projectIds:value.projectIds??null,expiresAt:expiry(value.expiresAt),disabled:value.disabled??false,username:value.username===undefined||value.username===null?null:normalizeUsername(value.username),passwordHash:value.passwordHash??null,...(value.passwordChangeRequired===undefined?{}:{passwordChangeRequired:value.passwordChangeRequired})};
 try{new ViewerAccess({viewers:[user]});}catch{fail('Invalid viewer role, scope or status');}return user;
}
function normalizedHost(value){
 fields(value,['id','label','tokenHash','deviceClass','role','site','rack','zone','group','preferredAddress','alternateAddresses','aliases','expiresAt','disabled','credentialGeneration','expectedHostname','enrollmentRequestId']);
 if(!machineId(value.id)||!digest(value.tokenHash))fail('Invalid source identity or credential hash');
 if(value.aliases!==undefined&&(!Array.isArray(value.aliases)||value.aliases.length>8||value.aliases.some(v=>!text(v,120))||new Set(value.aliases).size!==value.aliases.length))fail('Invalid source aliases');
 if(value.credentialGeneration!==undefined&&(!Number.isSafeInteger(value.credentialGeneration)||value.credentialGeneration<1))fail('Invalid credential generation');
 if(value.expectedHostname!=null&&!hostnameValue(value.expectedHostname))fail('Invalid expected hostname');
 if(value.enrollmentRequestId!=null&&!requestIdValue(value.enrollmentRequestId))fail('Invalid enrollment request');
 const host={credentialGeneration:value.credentialGeneration??1,expectedHostname:value.expectedHostname??null,enrollmentRequestId:value.enrollmentRequestId??null,...(value.aliases?{aliases:[...value.aliases]}:{}),id:value.id,label:value.label??value.id,tokenHash:value.tokenHash.toLowerCase(),deviceClass:value.deviceClass??'unknown',role:value.role??'codex-source',site:value.site??'',rack:value.rack??'',zone:value.zone??'',group:value.group??'',preferredAddress:value.preferredAddress??null,alternateAddresses:value.alternateAddresses??[],expiresAt:expiry(value.expiresAt),disabled:value.disabled??false};
 if(!['codex-source','execution-target','hub','gateway'].includes(host.role)||typeof host.disabled!=='boolean')fail('Invalid source role or status');
 const cfg=clone(DEFAULT_CONFIGURATION),{id:hostId,label,deviceClass,site,rack,zone,group,preferredAddress,alternateAddresses}=host;cfg.fleet.hosts=[{id:hostId,label,deviceClass,site,rack,zone,group,preferredAddress,alternateAddresses}];validateConfiguration(cfg);return host;
}
function normalizeRegistry(value){
 if(!object(value)||![1,2].includes(value.schemaVersion)||!Number.isSafeInteger(value.revision)||value.revision<1||!text(value.instanceId,128)||!Array.isArray(value.viewers)||value.viewers.length>64||!Array.isArray(value.hosts)||value.hosts.length>64||!Array.isArray(value.audit)||value.audit.length>256)fail('Invalid administration registry');
 fields(value,['schemaVersion','revision','instanceId','viewTokenHash','viewers','hosts','audit','enrollments']);
 const modern=value.schemaVersion===2||Object.hasOwn(value,'enrollments')||value.hosts.some(h=>['credentialGeneration','expectedHostname','enrollmentRequestId'].some(k=>Object.hasOwn(h,k)))||value.audit.some(a=>a?.action==='replace-source');
 if(modern&&(!Array.isArray(value.enrollments)||value.hosts.some(h=>['credentialGeneration','expectedHostname','enrollmentRequestId'].some(k=>!Object.hasOwn(h,k)))))fail('Incomplete administration authority metadata');
 if(value.viewTokenHash!==null&&!digest(value.viewTokenHash))fail('Invalid legacy viewer credential');
 const viewers=value.viewers.map(normalizedUser),hosts=value.hosts.map(normalizedHost),viewTokenHash=value.viewTokenHash?.toLowerCase()||null;
 if(new Set(viewers.map(v=>v.id)).size!==viewers.length||new Set(hosts.map(v=>v.id)).size!==hosts.length)fail('Duplicate administration identity');
 const hashes=[...(viewTokenHash?[viewTokenHash]:[]),...viewers.map(v=>v.tokenHash),...hosts.map(h=>h.tokenHash)];if(new Set(hashes).size!==hashes.length)fail('Viewer and collector credentials must remain distinct');
 try{new ViewerAccess({viewTokenHash,viewers});}catch{fail('Invalid administration authorization configuration');}
 const audit=value.audit.map(a=>{if(!object(a)||!Number.isSafeInteger(a.revision)||a.revision<1||a.revision>value.revision||!Number.isFinite(Date.parse(a.at))||!['seed','save-user','revoke-user','reset-password','change-password','enroll-source','replace-source','revoke-source','create-backup','stage-restore'].includes(a.action)||!Array.isArray(a.changedPaths))fail('Invalid administration audit');return {revision:a.revision,at:new Date(a.at).toISOString(),action:a.action,actor:{id:id(a.actor?.id)?a.actor.id:'unknown',role:['admin','viewer','system'].includes(a.actor?.role)?a.actor.role:'unknown'},changedPaths:a.changedPaths.filter(p=>typeof p==='string'&&(/^(users|backups|restores)\.[a-z0-9][-a-z0-9_]{0,63}$/.test(p)||/^sources\.[-a-z0-9]{1,64}$/.test(p)))};});
 const enrollments=value.enrollments??[];if(!Array.isArray(enrollments)||enrollments.length>256)fail('Invalid enrollment receipts');
 const receipts=enrollments.map(e=>{fields(e,['requestId','hostId','actorId','intent','requestDigest','generation','createdAt']);if(!requestIdValue(e.requestId)||!machineId(e.hostId)||!id(e.actorId)||!['add','replace'].includes(e.intent)||!digest(e.requestDigest)||!Number.isSafeInteger(e.generation)||e.generation<1||!Number.isFinite(Date.parse(e.createdAt)))fail('Invalid enrollment receipt');return {...e};});
 if(new Set(receipts.map(e=>e.requestId)).size!==receipts.length)fail('Duplicate enrollment receipt');
 for(const receipt of receipts){const host=hosts.find(h=>h.id===receipt.hostId);if(!host||receipt.generation>host.credentialGeneration)fail('Enrollment receipt generation mismatch');}
 for(const host of hosts)if(host.enrollmentRequestId!==null&&!receipts.some(e=>e.requestId===host.enrollmentRequestId&&e.hostId===host.id&&e.generation===host.credentialGeneration))fail('Current enrollment receipt unavailable');
 return {schemaVersion:2,revision:value.revision,instanceId:value.instanceId,viewTokenHash,viewers,hosts,audit,enrollments:receipts};
}

async function readRegistryFile(file){
 const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>MAX_BYTES)fail('Administration registry exceeds its bound or is not a regular file',503);
 const bytes=await fs.readFile(file);if(bytes.length>MAX_BYTES)fail('Administration registry exceeds its bound',503);const raw=JSON.parse(bytes.toString('utf8'));return {bytes,raw,state:normalizeRegistry(raw)};
}
export class Administration {
 static async inspect({directory}={}){
  try{
   if(typeof directory!=='string'||!path.isAbsolute(directory))fail('Absolute administration directory required');
   const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())fail('Real administration directory required');
   const {bytes,raw,state}=await readRegistryFile(path.join(directory,'administration.json'));
   return {schemaVersion:raw.schemaVersion,revision:state.revision,instanceId:state.instanceId,sha256:hash(bytes),bytes:bytes.length,format:ADMINISTRATION_FORMAT};
  }catch(error){if(error.code==='ENOENT')throw error;throw Object.assign(new Error('Current administration is invalid or incompatible; no state was initialized or repaired'),{status:503});}
 }
 static async open({directory,initial={}}={}){
  if(typeof directory!=='string'||!directory)fail('Administration directory required');
  const service=new Administration();service.directory=path.resolve(directory);service.file=path.join(service.directory,'administration.json');await fs.mkdir(service.directory,{recursive:true,mode:0o700});
  await service.#serial(async()=>{try{await service.#read();}catch(error){if(error.code!=='ENOENT')throw error;fields(initial,['viewTokenHash','viewers','hosts','instanceId']);const state=normalizeRegistry({schemaVersion:1,revision:1,instanceId:initial.instanceId||crypto.randomUUID(),viewTokenHash:initial.viewTokenHash??null,viewers:initial.viewers??[],hosts:initial.hosts??[],audit:[{revision:1,at:new Date().toISOString(),action:'seed',actor:{id:'system',role:'system'},changedPaths:[]}]});await service.#atomic(state);}});return service;
 }
 #serial(fn){const job=(queues.get(this.directory)||Promise.resolve()).then(fn);queues.set(this.directory,job.catch(()=>{}));return job;}
 async #read(){
  try{return (await readRegistryFile(this.file)).state;}
  catch(error){if(error.code==='ENOENT')throw error;throw Object.assign(new Error('Administration registry unavailable; offline repair required'),{status:503});}
 }
 async #atomic(state,authorize){
  const data=JSON.stringify(state);if(Buffer.byteLength(data)>MAX_BYTES)fail('Administration registry exceeds its bound',413);
  const file=this.file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';let handle,failure;
  // The publication guard is synchronous; never yield between it and rename dispatch.
  try{handle=await fs.open(file,'wx',0o600);await handle.writeFile(data);await handle.sync();await handle.close();handle=null;authorize?.();await fs.rename(file,this.file);if(process.platform!=='win32'){const directory=await fs.open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}}}catch(error){failure=error;}
  try{if(handle)await handle.close();}catch(error){failure??=error;}
  try{await fs.unlink(file);}catch(error){if(error.code!=='ENOENT')failure??=error;}
  if(failure)throw failure;
 }
 #administrator(state,actor){const admin=activeAdmins(state).find(v=>v.id===actor?.id);if(!admin)fail('Active full-scope administrator required',403);return {id:admin.id,role:'admin'};}
  withAdministratorAuthority({actor,verifyAuthority=()=>{}}={},operation){return this.#serial(async()=>{
   // Lock order is Administration, then Configuration. The callback reads this
   // registry directly, never re-enters its queue while that queue is held.
   const authorize=async()=>{verifyAuthority();const identity=this.#administrator(await this.#read(),actor);verifyAuthority();return identity;};
   await authorize();return operation(authorize);
  });}
 #mutate({revision,actor,verifyAuthority,replay},action,mutator){return this.#serial(async()=>{
  verifyAuthority?.();const state=await this.#read(),identity=this.#administrator(state,actor);verifyAuthority?.();const repeated=replay?.(state);if(repeated)return repeated;if(revision!==state.revision)fail('Administration revision conflict',409);if(state.revision>=Number.MAX_SAFE_INTEGER)fail('Administration revision exhausted',503);
  const candidate=clone(state),result=await mutator(candidate)||{};candidate.revision++;
  if(activeAdmins(state).length&&!activeAdmins(candidate).length)fail('The last active administrator cannot be removed, expired or revoked',409);
  candidate.audit=[...state.audit,{revision:candidate.revision,at:new Date().toISOString(),action,actor:identity,changedPaths:result.changedPaths||[]}].slice(-256);
  const next=normalizeRegistry(candidate);await this.#atomic(next,()=>{verifyAuthority?.();this.#administrator(state,actor);});
  return {revision:next.revision,...(result.enrollment?{enrollment:result.enrollment}:{}),...(result.userId?{user:publicUser(next.viewers.find(v=>v.id===result.userId))}:{}),...(result.sourceId?{source:publicHost(next.hosts.find(h=>h.id===result.sourceId))}:{}),...(result.issuedCredential?{issuedCredential:result.issuedCredential}:{}),...(result.signInRequired?{signInRequired:true}:{}),changedPaths:result.changedPaths||[]};
 });}
 state(){return this.#serial(async()=>{const {audit,...state}=await this.#read();return clone(state);});}
 publicUsers(){return this.#serial(async()=>{const state=await this.#read(),users=state.viewers.map(publicUser);if(state.viewTokenHash)users.unshift({id:'legacy',label:'Shared viewer',role:'viewer',hostIds:null,projectIds:null,expiresAt:null,disabled:false,status:'active',credentialFingerprint:'sha256:'+state.viewTokenHash.slice(0,12)});return {revision:state.revision,users};});}
 publicSources(){return this.#serial(async()=>{const state=await this.#read();return {revision:state.revision,sources:state.hosts.map(publicHost)};});}
 audit(){return this.#serial(async()=>clone((await this.#read()).audit));}
 saveUser({revision,user,actor,verifyAuthority}={}){
  return this.#mutate({revision,actor,verifyAuthority},'save-user',async state=>{
   fields(user,['id','label','role','hostIds','projectIds','expiresAt','disabled','rotateKey','username','password','passwordChangeRequired']);if(!id(user.id))fail('Invalid viewer identity');if(user.rotateKey!==undefined&&typeof user.rotateKey!=='boolean')fail('Invalid credential rotation option');
    if(user.id===actor.id&&user.rotateKey===true)fail('Ask another administrator to rotate your access key. Use your current password to change your own password.',409);
   const previous=state.viewers.find(v=>v.id===user.id);if(!previous&&state.viewers.length>=64)fail('Viewer identity limit reached',413);
   const hasPassword=Object.hasOwn(user,'password');if(previous?.passwordHash&&actor.id===user.id&&(hasPassword||user.username===null))fail('Use your current password to change your own password',403);
   if(Object.hasOwn(user,'passwordChangeRequired')&&(user.passwordChangeRequired!==true||!hasPassword))fail('A temporary password must be supplied when requiring a password change');
   const username=Object.hasOwn(user,'username')?user.username===null?null:normalizeUsername(user.username):previous?.username??null;
   if(username&&state.viewers.some(v=>v.id!==user.id&&v.username===username))fail('Username already in use',409);
   if(hasPassword&&!username)fail('A username is required for password sign-in');
   const passwordHash=hasPassword?await hashPassword(user.password):username?previous?.passwordHash??null:null;
   const rotate=!previous||user.rotateKey===true||previous.disabled&&user.disabled===false,token=rotate?'ccv_'+crypto.randomBytes(32).toString('base64url'):null;
   const role=user.role??previous?.role??'viewer',next=normalizedUser({id:user.id,label:user.label??previous?.label??user.id,role,hostIds:Object.hasOwn(user,'hostIds')?user.hostIds:previous?.hostIds??(role==='admin'?null:[]),projectIds:Object.hasOwn(user,'projectIds')?user.projectIds:previous?.projectIds??null,expiresAt:Object.hasOwn(user,'expiresAt')?user.expiresAt:previous?.expiresAt??null,disabled:user.disabled??previous?.disabled??false,username,passwordHash,...(previous?.passwordChangeRequired||user.passwordChangeRequired===true?{passwordChangeRequired:true}:{}),tokenHash:token?hash(token):previous.tokenHash});
   state.viewers=state.viewers.filter(v=>v.id!==next.id).concat(next);return {userId:next.id,changedPaths:['users.'+next.id],...(actor.id===next.id&&(hasPassword||next.username!==previous?.username)?{signInRequired:true}:{}),...(token?{issuedCredential:{kind:'viewer',id:next.id,token}}:{})};
  });
 }
 resetPassword({revision,id:viewerId,password,actor,verifyAuthority}={}){return this.#mutate({revision,actor,verifyAuthority},'reset-password',async state=>{if(viewerId===actor.id)fail('Use your current password to change your own password',403);const user=state.viewers.find(v=>v.id===viewerId);if(!user)fail('Viewer identity unavailable',404);if(!user.username)fail('A username is required for password sign-in');user.passwordHash=await hashPassword(password);return {userId:viewerId,changedPaths:['users.'+viewerId]};});}
 changePassword({id:viewerId,currentPassword,newPassword,actor,verifyAuthority}={}){return this.#serial(async()=>{
  verifyAuthority?.();const state=await this.#read(),user=state.viewers.find(v=>v.id===viewerId);verifyAuthority?.();if(!user||!active(user)||actor?.id!==viewerId||!user.username||!user.passwordHash)fail('Password change unavailable for this account',403);
  if(!await verifyPassword(currentPassword,user.passwordHash))fail('Current password not accepted',401);if(user.passwordChangeRequired&&await verifyPassword(newPassword,user.passwordHash))fail('Choose a personal password different from the temporary password');const passwordHash=await hashPassword(newPassword);
  if(state.revision>=Number.MAX_SAFE_INTEGER)fail('Administration revision exhausted',503);user.passwordHash=passwordHash;delete user.passwordChangeRequired;state.revision++;
  state.audit=[...state.audit,{revision:state.revision,at:new Date().toISOString(),action:'change-password',actor:{id:user.id,role:user.role},changedPaths:['users.'+user.id]}].slice(-256);await this.#atomic(normalizeRegistry(state),()=>{verifyAuthority?.();if(!active(user))fail('Password change unavailable for this account',403);});return {changed:true,signInRequired:true};
 });}
 revokeUser({revision,id:viewerId,actor,verifyAuthority}={}){return this.#mutate({revision,actor,verifyAuthority},'revoke-user',state=>{if(viewerId==='legacy'){if(!state.viewTokenHash)fail('Viewer identity unavailable',404);state.viewTokenHash=null;return {changedPaths:['users.legacy']};}const user=state.viewers.find(v=>v.id===viewerId);if(!user)fail('Viewer identity unavailable',404);user.disabled=true;return {userId:viewerId,changedPaths:['users.'+viewerId]};});}
 enrollSource({revision,host,actor,verifyAuthority,requestId=crypto.randomUUID(),expectedHostname=null,replace=false,expectedGeneration}={}){
  if(!requestIdValue(requestId)||typeof replace!=='boolean'||expectedHostname!==null&&!hostnameValue(expectedHostname))fail('Invalid enrollment request');
  fields(host,['id','label','deviceClass','role','site','rack','zone','group','preferredAddress','alternateAddresses','expiresAt']);
  const intent=replace?'replace':'add',requestDigest=hash(JSON.stringify([intent,Object.fromEntries(Object.keys(host).sort().map(k=>[k,host[k]])),expectedHostname,expectedGeneration??null]));
  const replay=state=>{const receipt=state.enrollments.find(e=>e.requestId===requestId);if(!receipt)return null;if(receipt.actorId!==actor?.id)fail('Enrollment receipt unavailable',403);if(receipt.requestDigest!==requestDigest)fail('Enrollment request already used for different details',409);const source=state.hosts.find(h=>h.id===receipt.hostId);return {revision:state.revision,source:source?publicHost(source):null,enrollment:{...receipt},duplicate:true,changedPaths:[]};};
  return this.#mutate({revision,actor,verifyAuthority,replay},replace?'replace-source':'enroll-source',state=>{
   if(!machineId(host.id))fail('Invalid source identity');const previous=state.hosts.find(h=>h.id===host.id);
   if(!replace&&previous)fail('Device already exists. Use explicit collector credential replacement.',409);
   if(replace&&(!previous||expectedGeneration!==previous.credentialGeneration))fail('Device access changed. Refresh before replacing its credential.',409);
   if(!previous&&state.hosts.length>=64)fail('Source identity limit reached',413);
   if(state.enrollments.length>=256)fail('Enrollment receipt capacity reached; offline maintenance required',503);
   const generation=(previous?.credentialGeneration??0)+1;if(!Number.isSafeInteger(generation))fail('Credential generation exhausted',503);
   const token='ccc_'+crypto.randomBytes(32).toString('base64url'),next=normalizedHost({...previous,...host,expectedHostname,credentialGeneration:generation,enrollmentRequestId:requestId,disabled:false,tokenHash:hash(token)});
   const enrollment={requestId,hostId:host.id,actorId:actor.id,intent,requestDigest,generation,createdAt:new Date().toISOString()};
   state.hosts=state.hosts.filter(h=>h.id!==next.id).concat(next);state.enrollments.push(enrollment);
   return {sourceId:next.id,enrollment,changedPaths:['sources.'+next.id],issuedCredential:{kind:'collector',id:next.id,token}};
  });
 }
 enrollmentReceipt({requestId,actor,verifyAuthority}={}){return this.#serial(async()=>{verifyAuthority?.();const state=await this.#read();this.#administrator(state,actor);verifyAuthority?.();const enrollment=state.enrollments.find(e=>e.requestId===requestId&&e.actorId===actor.id);if(!enrollment)fail('Enrollment receipt unavailable',404);const source=state.hosts.find(h=>h.id===enrollment.hostId);return {revision:state.revision,enrollment:{...enrollment},source:source?publicHost(source):null};});}
 revokeSource({revision,id:hostId,actor,verifyAuthority}={}){return this.#mutate({revision,actor,verifyAuthority},'revoke-source',state=>{const host=state.hosts.find(h=>h.id===hostId);if(!host)fail('Source identity unavailable',404);host.disabled=true;return {sourceId:hostId,changedPaths:['sources.'+hostId]};});}
 async #privateDirectory(name){const directory=path.join(this.directory,name);await fs.mkdir(directory,{recursive:true,mode:0o700});const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())fail('Invalid private backup directory',409);return directory;}
 async #manifest(directory,expectedId,instanceId){
  const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())fail('Invalid backup directory',409);
  const file=path.join(directory,'manifest.json'),manifestStat=await fs.lstat(file);if(!manifestStat.isFile()||manifestStat.isSymbolicLink()||manifestStat.size>65536)fail('Invalid backup manifest',409);
  const value=JSON.parse(await fs.readFile(file,'utf8'));if(value.schemaVersion!==1||value.id!==expectedId||value.instanceId!==instanceId||!Number.isFinite(Date.parse(value.createdAt))||!Array.isArray(value.files)||value.files.length!==2||JSON.stringify(value.files.map(f=>f.name).sort())!==JSON.stringify(['configuration.json','history.sqlite']))fail('Invalid own backup manifest',409);
  for(const f of value.files)if(!digest(f.sha256)||!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>BACKUP_LIMITS.maxBytes)fail('Invalid backup file inventory',409);
  return {schemaVersion:1,id:value.id,instanceId:value.instanceId,createdAt:new Date(value.createdAt).toISOString(),files:value.files.map(f=>({name:f.name,sha256:f.sha256.toLowerCase(),bytes:f.bytes})),journal:value.journal,requiresRestart:true,applyMode:'offline-cli-only'};
 }
 async #list(state){const root=await this.#privateDirectory('backups'),backups=[];for(const entry of await fs.readdir(root,{withFileTypes:true})){if(!entry.isDirectory()||!backupId(entry.name))continue;try{const manifest=await this.#manifest(path.join(root,entry.name),entry.name,state.instanceId);backups.push({id:manifest.id,createdAt:manifest.createdAt,bytes:manifest.files.reduce((n,f)=>n+f.bytes,0),status:'unverified',requiresRestart:true});}catch{backups.push({id:entry.name,status:'invalid',bytes:0,requiresRestart:true});}}return {backups:backups.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))),limits:BACKUP_LIMITS};}
 async #verify(idValue,state){
  if(!backupId(idValue))fail('Invalid backup identity',400);const root=await this.#privateDirectory('backups'),directory=path.join(root,idValue);
  try{const manifest=await this.#manifest(directory,idValue,state.instanceId);for(const f of manifest.files){const observed=await fileHash(path.join(directory,f.name));if(observed.sha256!==f.sha256||observed.bytes!==f.bytes)return {id:idValue,valid:false,reason:'checksum-mismatch'};}const config=JSON.parse(await fs.readFile(path.join(directory,'configuration.json'),'utf8'));validateConfiguration(config);const journal=inspectJournal(path.join(directory,'history.sqlite'));if(JSON.stringify(journal)!==JSON.stringify(manifest.journal))return {id:idValue,valid:false,reason:'journal-mismatch'};return {id:idValue,valid:true,verifiedAt:new Date().toISOString(),manifest};}
  catch(error){if(error.code==='ENOENT')fail('Backup identity unavailable',404);return {id:idValue,valid:false,reason:'verification-failed'};}
 }
 // Complete the audit of an already authorized directory publication. A later
 // logout or expiry must not turn that committed side effect into a missing audit.
 async #auxiliaryAudit(state,identity,action,changedPath){const next=normalizeRegistry({...state,revision:state.revision+1,audit:[...state.audit,{revision:state.revision+1,at:new Date().toISOString(),action,actor:identity,changedPaths:[changedPath]}].slice(-256)});await this.#atomic(next);return next.revision;}
 listBackups(){return this.#serial(async()=>this.#list(await this.#read()));}
 verifyBackup(idValue){return this.#serial(async()=>this.#verify(idValue,await this.#read()));}
 supportBundle({snapshot,configuration,diagnostics,actor}={}){return this.#serial(async()=>{const state=await this.#read();this.#administrator(state,actor);return sanitizedSupportBundle({snapshot,configuration,diagnostics,instanceId:state.instanceId});});}
 createBackup({journal,configuration,actor,revision,verifyAuthority}={}){return this.#serial(async()=>{
  verifyAuthority?.();const state=await this.#read();this.#administrator(state,actor);verifyAuthority?.();if(revision!==undefined&&revision!==state.revision)fail('Administration revision conflict',409);if(state.revision>=Number.MAX_SAFE_INTEGER)fail('Administration revision exhausted',503);if(!(journal instanceof HistoryJournal))fail('An existing observer journal is required',400);
  const config=configurationValue(configuration),root=await this.#privateDirectory('backups'),listed=await this.#list(state);if(listed.backups.length>=BACKUP_LIMITS.maxBackups)fail('Private backup count limit reached; offline cleanup required',409);
  const source=new DatabaseSync(journal.file,{readOnly:true});let pending,final,idValue;
  try{
   source.exec('BEGIN');const pageCount=source.prepare('PRAGMA page_count').get().page_count,pageSize=source.prepare('PRAGMA page_size').get().page_size,estimated=pageCount*pageSize;
   if(estimated>BACKUP_LIMITS.maxBytes||listed.backups.reduce((n,b)=>n+b.bytes,0)+estimated>BACKUP_LIMITS.totalBytes)fail('Private backup disk budget exceeded',413);
   const space=await fs.statfs(root);if(space.bavail*space.bsize<estimated+4194304)fail('Insufficient private backup storage',507);
   idValue='backup-'+Date.now()+'-'+crypto.randomBytes(6).toString('hex');pending=path.join(root,'.pending-'+idValue);final=path.join(root,idValue);await fs.mkdir(pending,{mode:0o700});
   const dbFile=path.join(pending,'history.sqlite');await sqliteBackup(source,dbFile,{rate:128});await fs.chmod(dbFile,0o600);const standalone=new DatabaseSync(dbFile);try{standalone.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');}finally{standalone.close();}const journalMetadata=inspectJournal(dbFile);
   await privateJSON(path.join(pending,'configuration.json'),config);const files=[];for(const name of ['history.sqlite','configuration.json'])files.push({name,...await fileHash(path.join(pending,name))});
   if(files.reduce((n,f)=>n+f.bytes,0)>BACKUP_LIMITS.maxBytes)fail('Private backup file budget exceeded',413);
   const manifest={schemaVersion:1,id:idValue,instanceId:state.instanceId,createdAt:new Date().toISOString(),files,journal:journalMetadata,requiresRestart:true,applyMode:'offline-cli-only'};await privateJSON(path.join(pending,'manifest.json'),manifest);await syncDirectory(pending);
   const identity=this.#administrator(state,actor);verifyAuthority?.();await fs.rename(pending,final);pending=null;await syncDirectory(root);const nextRevision=await this.#auxiliaryAudit(state,identity,'create-backup','backups.'+idValue);return {id:idValue,revision:nextRevision,manifest,verified:true};
  }finally{source.close();if(pending){const resolved=path.resolve(pending);if(!resolved.startsWith(path.resolve(root)+path.sep)||resolved===path.resolve(root))fail('Backup cleanup target refused',503);await fs.rm(resolved,{recursive:true,force:true});}}
 });}
 stageRestore({id:idValue,actor,revision,verifyAuthority}={}){return this.#serial(async()=>{
  verifyAuthority?.();const state=await this.#read();this.#administrator(state,actor);verifyAuthority?.();if(revision!==undefined&&revision!==state.revision)fail('Administration revision conflict',409);if(state.revision>=Number.MAX_SAFE_INTEGER)fail('Administration revision exhausted',503);const verified=await this.#verify(idValue,state);if(!verified.valid)fail('Backup verification failed; restore not staged',409);
  const root=await this.#privateDirectory('restore-staging'),final=path.join(root,'pending');try{await fs.lstat(final);fail('An offline restore is already staged',409);}catch(error){if(error.code!=='ENOENT')throw error;}
  const temporary=path.join(root,'.pending-'+crypto.randomBytes(8).toString('hex'));await fs.mkdir(temporary,{mode:0o700});let cleanup=true;
  try{for(const f of verified.manifest.files){const destination=path.join(temporary,f.name);await fs.copyFile(path.join(this.directory,'backups',idValue,f.name),destination);await fs.chmod(destination,0o600);const observed=await fileHash(destination);if(observed.sha256!==f.sha256||observed.bytes!==f.bytes)fail('Staged backup checksum mismatch',409);}inspectJournal(path.join(temporary,'history.sqlite'));validateConfiguration(JSON.parse(await fs.readFile(path.join(temporary,'configuration.json'),'utf8')));
   await privateJSON(path.join(temporary,'manifest.json'),{...verified.manifest,stagedAt:new Date().toISOString()});await syncDirectory(temporary);const identity=this.#administrator(state,actor);verifyAuthority?.();await fs.rename(temporary,final);cleanup=false;await syncDirectory(root);const nextRevision=await this.#auxiliaryAudit(state,identity,'stage-restore','restores.'+idValue);return {id:idValue,revision:nextRevision,staged:true,requiresRestart:true,applyMode:'offline-cli-only',stageDirectory:'restore-staging/pending'};
  }finally{if(cleanup){const resolved=path.resolve(temporary);if(!resolved.startsWith(path.resolve(root)+path.sep)||resolved===path.resolve(root))fail('Restore cleanup target refused',503);await fs.rm(resolved,{recursive:true,force:true});}}
 });}
}
