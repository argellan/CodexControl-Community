// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {inflateSync} from 'node:zlib';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const MAX_PHOTO=524288,MAX_FILE=720896,queues=new Map();let pending=0;
const signature=Buffer.from('89504e470d0a1a0a','hex');
const crcTable=Array.from({length:256},(_,v)=>{for(let i=0;i<8;i++)v=v&1?0xedb88320^(v>>>1):v>>>1;return v>>>0;});
function crc(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function chunk(kind,bytes){const type=Buffer.from(kind),row=Buffer.alloc(12+bytes.length);row.writeUInt32BE(bytes.length);type.copy(row,4);bytes.copy(row,8);row.writeUInt32BE(crc(Buffer.concat([type,bytes])),8+bytes.length);return row;}
// Accept only bounded static PNGs, validate the entire chunk stream and inflated
// row size, and strip all metadata. No SVG, remote URL, animation or file paths.
export function normalizedPhoto(value,limits){
 const maxPhoto=limits?.maxBytes??MAX_PHOTO,maxFile=limits?.maxEncodedBytes??MAX_FILE;
 if(value===null)return null;
 if(typeof value!=='string'||value.length>maxFile||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))throw fail('Use a PNG photo prepared by the profile editor.');
 const raw=Buffer.from(value.slice(22),'base64');if(raw.length>maxPhoto||!raw.subarray(0,8).equals(signature))throw fail('Invalid or oversized photo.');
 let pos=8,header=null,ended=false,idatEnded=false;const parts=[];
 while(pos<raw.length){if(pos+12>raw.length)throw fail('Invalid photo.');const size=raw.readUInt32BE(pos),end=pos+12+size;if(end>raw.length)throw fail('Invalid photo.');const type=raw.toString('ascii',pos+4,pos+8),bytes=raw.subarray(pos+8,pos+8+size);if(crc(raw.subarray(pos+4,pos+8+size))!==raw.readUInt32BE(pos+8+size))throw fail('Invalid photo checksum.');
  if(!header&&type!=='IHDR')throw fail('Invalid photo header.');
  if(type==='IHDR'){if(header||size!==13)throw fail('Invalid photo header.');header=Buffer.from(bytes);const w=header.readUInt32BE(0),h=header.readUInt32BE(4);if(!w||!h||w>(limits?.width??256)||h>(limits?.height??256)||limits?.width&&w!==limits.width||limits?.height&&h!==limits.height||header[8]!==8||![2,6].includes(header[9])||header[10]||header[11]||header[12])throw fail('Invalid static RGB/RGBA PNG dimensions.');}
  else if(type==='IDAT'){if(idatEnded)throw fail('Invalid photo data.');parts.push(bytes);}
  else if(type==='IEND'){if(size||!parts.length||end!==raw.length)throw fail('Invalid photo ending.');ended=true;break;}
  else {if(parts.length)idatEnded=true;if(!['sRGB','gAMA','cHRM','pHYs'].includes(type))throw fail('Unsupported photo chunk.');}
  pos=end;
 }
 if(!header||!ended)throw fail('Incomplete photo.');
 const width=header.readUInt32BE(0),height=header.readUInt32BE(4),stride=1+width*(header[9]===6?4:3),expected=stride*height;let decoded;
 try{const packed=Buffer.concat(parts),result=inflateSync(packed,{maxOutputLength:expected,info:true});if(result.engine.bytesWritten!==packed.length)throw new Error('Trailing data');decoded=result.buffer;}catch{throw fail('Invalid compressed photo.');}
 if(decoded.length!==expected)throw fail('Invalid photo row data.');for(let y=0;y<height;y++)if(decoded[y*stride]>4)throw fail('Invalid photo filter.');
 return 'data:image/png;base64,'+Buffer.concat([signature,chunk('IHDR',header),chunk('IDAT',Buffer.concat(parts)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
const name=(v,max,label)=>{if(typeof v!=='string'||[...v].length>max||/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(v))throw fail(label+' is invalid.');return v.trim();};
export class UserProfile {
 constructor(directory,identity){this.directory=path.resolve(directory);this.file=path.join(this.directory,crypto.createHash('sha256').update(identity).digest('hex')+'.account.json');}
 async read(){try{const stat=await fs.lstat(this.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_FILE)throw fail('Profile requires recovery.',503);const p=JSON.parse(await fs.readFile(this.file,'utf8'));if(!Number.isSafeInteger(p.revision)||p.revision<0)throw fail('Profile requires recovery.',503);return {revision:p.revision,name:name(p.name,100,'Name'),nickname:name(p.nickname,48,'Nickname'),photo:p.photo===null?null:normalizedPhoto(p.photo),updatedAt:p.updatedAt};}catch(e){if(e.code==='ENOENT')return {revision:0,name:'',nickname:'',photo:null,updatedAt:null};throw e;}}
 write(value,{verifyAuthority}={}){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['revision','name','nickname','photo'].includes(k))||!Number.isSafeInteger(value.revision))return Promise.reject(fail('Invalid profile update.'));
  let checked;try{checked={name:name(value.name,100,'Name'),nickname:name(value.nickname,48,'Nickname'),photo:normalizedPhoto(value.photo)};}catch(e){return Promise.reject(e);}
  const now=Date.now();for(const [key,s] of queues)if(!s.pending&&s.until<=now)queues.delete(key);
  const state=queues.get(this.file)||{tail:Promise.resolve(),pending:0,writes:0,until:now+60000};if(now>=state.until){state.writes=0;state.until=now+60000;}
  if(pending>=8||state.pending>=2||state.writes>=12||!queues.has(this.file)&&queues.size>=256)return Promise.reject(fail('Profile storage busy; try again shortly.',429));
  state.pending++;state.writes++;pending++;queues.set(this.file,state);
  const result=state.tail.then(async()=>{verifyAuthority?.();const previous=await this.read();if(previous.revision!==value.revision)throw fail('Profile changed in another tab. Reload before saving.',409);const next={...checked,revision:previous.revision+1,updatedAt:new Date().toISOString()};await fs.mkdir(this.directory,{recursive:true,mode:0o700});const temp=this.file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';let handle;try{handle=await fs.open(temp,'wx',0o600);await handle.writeFile(JSON.stringify(next));await handle.sync();await handle.close();handle=null;verifyAuthority?.();await fs.rename(temp,this.file);if(process.platform!=='win32'){const dir=await fs.open(this.directory,'r');try{await dir.sync();}finally{await dir.close();}}return next;}finally{if(handle)await handle.close();await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}).finally(()=>{state.pending--;pending--;});state.tail=result.catch(()=>{});return result;
 }
}
