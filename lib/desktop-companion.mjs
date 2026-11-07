// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import https from 'node:https';
import {normalizedPhoto} from './user-profile.mjs';
import {storageAdmissionOptions,requireStorageReserve,StorageBackpressure} from './storage-admission.mjs';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=()=>{throw new Error('Invalid desktop companion observation');};
export const COMPANION_MAX_WIRE=11534336;
const safeName=value=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,64):'Dot';
export function companionSelection(state){
 const atoms=state?.['electron-persisted-atom-state'],cache=atoms?.['cloud-pet-artwork-cache'];
 if(!object(cache)||typeof cache.accountId!=='string'||typeof cache.userId!=='string'||!Array.isArray(cache.pets)||cache.pets.length>256)return null;
 const id=atoms?.['last-observed-cloud-pet-selection-v1']?.[JSON.stringify([cache.accountId,cache.userId])];
 if(typeof id!=='string'||!id.startsWith('pet_'))return null;
 const matches=cache.pets.filter(p=>p?.id===id);if(matches.length!==1)return null;
 const pet=matches[0];if(![1,2].includes(pet.spriteVersionNumber)||typeof pet.spritesheetFingerprint!=='string'||pet.spritesheetFingerprint.length>2048)return null;
 let name='Dot';
 // Read the display name only. Descriptions, previews and messages are excluded.
 for(const [key,profiles]of Object.entries(atoms))if(key==='cloud-aeon-profiles-v1:'+JSON.stringify([cache.accountId,cache.userId])&&object(profiles))for(const entry of Object.values(profiles)){const profile=entry?.profile;if(profile?.avatar_manifest?.pet_id===id)name=safeName(profile.display_name)||'Dot';}
 return {selectionKey:hash(JSON.stringify([cache.accountId,cache.userId,id,pet.spritesheetFingerprint])),name,rows:pet.spriteVersionNumber===2?11:9,url:pet.spritesheetUrl};
}
export function normalizedCompanionArtwork(data,rows){
 if(![9,11].includes(rows))fail();
 return normalizedPhoto(data,{width:1536,height:rows*208,maxBytes:8388608,maxEncodedBytes:11184840});
}
export function sanitizeCompanion(value){
 if(!object(value)||Object.keys(value).some(k=>!['version','source','selectionKey','name','rows','artworkSha256','observedAt','voice'].includes(k))||value.version!==1||value.source!=='codex-desktop-persisted-state'||!hex(value.selectionKey)||!hex(value.artworkSha256)||![9,11].includes(value.rows)||typeof value.name!=='string'||safeName(value.name)!==value.name||!Number.isFinite(Date.parse(value.observedAt))||value.voice!=='unavailable')fail();
 return {version:1,source:value.source,selectionKey:value.selectionKey,name:value.name,rows:value.rows,artworkSha256:value.artworkSha256,observedAt:new Date(value.observedAt).toISOString(),voice:'unavailable'};
}
async function boundedJSON(file,limit=33554432){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)fail();return JSON.parse(await fs.readFile(file,'utf8'));}
async function atomic(file,bytes){await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';let handle;try{handle=await fs.open(temp,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;await fs.rename(temp,file);if(process.platform!=='win32'){const dir=await fs.open(path.dirname(file),'r');try{await dir.sync();}finally{await dir.close();}}}finally{await handle?.close();await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
const companionCharges=new Map();let companionPublication=Promise.resolve();
// The authoritative hub owns these private directories. Reconcile durable files
// once per process; serialize all helper publications, including direct callers.
async function companionCharge(directory,limit){
 if(companionCharges.has(directory))return companionCharges.get(directory);
 let total=0;for await(const entry of await fs.opendir(directory)){
  const stat=await fs.lstat(path.join(directory,entry.name));if(!stat.isFile()||stat.isSymbolicLink())throw new StorageBackpressure();
  total+=4096+stat.size;if(total>limit){total=Infinity;break;}
 }companionCharges.set(directory,total);return total;
}
async function publishCompanion(directory,metadata,artwork,{validate,storageAdmission}={}){
 const checked=sanitizeCompanion(metadata),clean=normalizedCompanionArtwork(artwork,checked.rows),bytes=Buffer.from(clean.slice(22),'base64');if(hash(bytes)!==checked.artworkSha256)fail();
 validate?.();await fs.mkdir(directory,{recursive:true,mode:0o700});const asset=path.join(directory,checked.artworkSha256+'.png'),manifest=path.join(directory,checked.selectionKey+'.json'),text=JSON.stringify(checked);
 let assetExists=false,oldManifest=null;
 try{const old=await fs.lstat(asset);if(!old.isFile()||old.isSymbolicLink()||old.size!==bytes.length||hash(await fs.readFile(asset))!==checked.artworkSha256)fail();assetExists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
 try{const old=await fs.lstat(manifest);if(!old.isFile()||old.isSymbolicLink()||old.size>4096)fail();oldManifest=await fs.readFile(manifest);}catch(e){if(e.code!=='ENOENT')throw e;}
 if(assetExists&&oldManifest?.equals(Buffer.from(text))){validate?.();return checked;}
 const options=storageAdmission?storageAdmissionOptions(storageAdmission):null,newBytes=Buffer.byteLength(text),growth=(assetExists?0:4096+bytes.length)+(oldManifest?newBytes-oldManifest.length:4096+newBytes);
 const charge=options?await companionCharge(directory,options.sourceBytes):0;
 if(options&&growth>0&&charge+growth>options.sourceBytes)throw new StorageBackpressure();
 try{
  validate?.();if(options)requireStorageReserve(asset,options,(assetExists?0:bytes.length+4096)+newBytes+4096,assetExists?1:2);
  if(!assetExists)await atomic(asset,bytes);
  validate?.();if(options)requireStorageReserve(manifest,options,newBytes+4096,1);
  await atomic(manifest,text);if(options)companionCharges.set(directory,charge+growth);return checked;
 }catch(error){companionCharges.delete(directory);throw error;}
}
export function saveCompanion(directory,metadata,artwork,options){
 const job=companionPublication.then(()=>publishCompanion(directory,metadata,artwork,options));companionPublication=job.catch(()=>{});return job;
}
export async function readCompanionArtwork(directory,metadata){const checked=sanitizeCompanion(metadata),file=path.join(directory,checked.artworkSha256+'.png'),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8388608)fail();const bytes=await fs.readFile(file);if(hash(bytes)!==checked.artworkSha256)fail();return 'data:image/png;base64,'+bytes.toString('base64');}
export function downloadCompanionArtwork(value){
 let url;try{url=new URL(value);}catch{return Promise.reject(new Error('Desktop artwork link unavailable'));}
 if(url.protocol!=='https:'||url.port&&url.port!=='443'||url.username||url.password||!url.hostname.endsWith('.oaiusercontent.com'))return Promise.reject(new Error('Desktop artwork origin refused'));
 return new Promise((resolve,reject)=>{let settled=false;const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(deadline);error?reject(new Error('Desktop artwork download unavailable')):resolve(result);};const req=https.get(url,{timeout:10000,rejectUnauthorized:true,headers:{accept:'image/png'}},res=>{if(res.statusCode!==200||Number(res.headers['content-length']||0)>8388608){res.destroy();finish(new Error());return;}let length=0;const chunks=[];res.on('data',c=>{length+=c.length;if(length>8388608){finish(new Error());req.destroy();}else chunks.push(c);});res.on('error',finish);res.on('aborted',()=>finish(new Error()));res.on('end',()=>finish(null,'data:image/png;base64,'+Buffer.concat(chunks).toString('base64')));});const deadline=setTimeout(()=>{finish(new Error());req.destroy();},10000);deadline.unref();req.on('error',finish);req.on('timeout',()=>{finish(new Error());req.destroy();});});
}
// Explicit opt-in. Never reads auth.json, microphone, audio or call transcripts.
// The saved desktop reference is evidence of selection, not evidence of a call.
export function createDesktopCompanionObserver(configuration,{directory,now=Date.now,download=downloadCompanionArtwork}={}){
 if(configuration?.enabled!==true)return null;
 const home=configuration.codexHome??path.join(os.homedir(),'.codex');if(!path.isAbsolute(home)||!directory)throw new Error('Invalid desktop companion configuration');
 let attempted=-Infinity,running=false,uploaded=null,lastSelection=null,current=null,status='waiting',stamp=null,cachedSelection=null;
 const readSelection=async()=>{const file=path.join(home,'.codex-global-state.json'),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>33554432)fail();const next=[stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join('|');if(next===stamp)return cachedSelection;const selection=companionSelection(await boundedJSON(file));stamp=next;cachedSelection=selection;return selection;};
 const poll=async upload=>{if(running||now()-attempted<5000)return;running=true;attempted=now();try{
  const selection=await readSelection();if(!selection){status='selection-unavailable';current=null;return;}
  if(selection.selectionKey===lastSelection&&current&&uploaded===current.selectionKey+'|'+current.artworkSha256+'|'+selection.name&&current.name===selection.name){status='available';return;}
  if(current?.selectionKey!==selection.selectionKey)current=null;
  let metadata,artwork;try{metadata=sanitizeCompanion(await boundedJSON(path.join(directory,selection.selectionKey+'.json'),4096));if(metadata.selectionKey!==selection.selectionKey)fail();artwork=await readCompanionArtwork(directory,metadata);}catch(error){if(error.code!=='ENOENT')throw error;artwork=normalizedCompanionArtwork(await download(selection.url),selection.rows);metadata={version:1,source:'codex-desktop-persisted-state',selectionKey:selection.selectionKey,name:selection.name,rows:selection.rows,artworkSha256:hash(Buffer.from(artwork.slice(22),'base64')),observedAt:new Date(now()).toISOString(),voice:'unavailable'};await saveCompanion(directory,metadata,artwork);}
  if(metadata.name!==selection.name){metadata={...metadata,name:selection.name,observedAt:new Date(now()).toISOString()};await saveCompanion(directory,metadata,artwork);}
  if(uploaded!==metadata.selectionKey+'|'+metadata.artworkSha256+'|'+metadata.name){await upload(metadata,artwork);uploaded=metadata.selectionKey+'|'+metadata.artworkSha256+'|'+metadata.name;}current=metadata;lastSelection=selection.selectionKey;status='available';
 }catch{status='artwork-unavailable';}finally{running=false;}};
 return {poll,sample:()=>current?{...current}:null,status:()=>status};
}
