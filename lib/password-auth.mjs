// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import crypto from 'node:crypto';

// OWASP's 32 MiB scrypt profile; one in-flight derivation bounds Pi memory/CPU.
const OPTIONS=Object.freeze({N:32768,r:8,p:3,maxmem:48*1048576}),SALT_BYTES=16,KEY_BYTES=32;
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const queue=[];let running=false;
function drain(){if(running||!queue.length)return;running=true;const job=queue.shift();crypto.scrypt(job.password,job.salt,KEY_BYTES,OPTIONS,(error,key)=>{running=false;if(error)job.reject(Object.assign(new Error('Password authentication unavailable'),{status:503}));else job.resolve(key);drain();});}
function derive(password,salt){if(queue.length>=8)fail('Authentication busy; try again shortly',429);return new Promise((resolve,reject)=>{queue.push({password,salt,resolve,reject});drain();});}
const boundedPassword=value=>typeof value==='string'&&[...value].length<=128&&Buffer.byteLength(value)<=512;
export function normalizeUsername(value){if(typeof value!=='string')fail('Username must use 3–64 letters, numbers, dots, underscores or hyphens');const normalized=value.trim().toLowerCase();if(!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized))fail('Username must use 3–64 letters, numbers, dots, underscores or hyphens');return normalized;}
export function validateNewPassword(value){if(!boundedPassword(value)||[...value].length<12)fail('Password must contain 12–128 characters and at most 512 UTF-8 bytes');return value;}
function parse(value){
 if(typeof value!=='string'||value.length>180)return null;const pieces=value.split('$');
 if(pieces.length!==7||pieces[0]!=='scrypt'||pieces[1]!=='v1'||pieces[2]!=='32768'||pieces[3]!=='8'||pieces[4]!=='3'||!/^[a-zA-Z0-9_-]{22}$/.test(pieces[5])||!/^[a-zA-Z0-9_-]{43}$/.test(pieces[6]))return null;
 const salt=Buffer.from(pieces[5],'base64url'),key=Buffer.from(pieces[6],'base64url');if(salt.length!==SALT_BYTES||key.length!==KEY_BYTES||salt.toString('base64url')!==pieces[5]||key.toString('base64url')!==pieces[6])return null;return {salt,key};
}
export const validPasswordHash=value=>!!parse(value);
export async function hashPassword(value){validateNewPassword(value);const salt=crypto.randomBytes(SALT_BYTES),key=await derive(value,salt);try{return ['scrypt','v1',OPTIONS.N,OPTIONS.r,OPTIONS.p,salt.toString('base64url'),key.toString('base64url')].join('$');}finally{key.fill(0);}}
export async function verifyPassword(value,record){
 if(!boundedPassword(value))return false;const parsed=parse(record),salt=parsed?.salt||Buffer.alloc(SALT_BYTES,91),expected=parsed?.key||Buffer.alloc(KEY_BYTES),key=await derive(value,salt);
 try{return crypto.timingSafeEqual(key,expected)&&!!parsed;}finally{key.fill(0);}
}

export class PasswordRateLimiter {
 constructor({now=Date.now,maxAttempts=8,windowMs=900000,maxEntries=512}={}){this.now=now;this.maxAttempts=Math.max(1,Math.min(32,maxAttempts));this.windowMs=Math.max(1000,Math.min(3600000,windowMs));this.maxEntries=Math.max(4,Math.min(2048,maxEntries));this.entries=new Map();}
 get size(){return this.entries.size;}
 consume(address,account){
  const now=this.now();for(const [key,value] of this.entries)if(now>=value.until)this.entries.delete(key);
  const digest=value=>crypto.createHash('sha256').update(String(value??'').slice(0,256)).digest('hex');
  const keys=[['source:'+digest(address),this.maxAttempts*3,1000],['account:'+digest(account),this.maxAttempts,this.windowMs]];
  for(const [key,limit] of keys){const value=this.entries.get(key);if(value&&value.count>=limit)throw Object.assign(new Error('Too many sign-in attempts; try again later'),{status:429,retryAfter:Math.max(1,Math.ceil((value.until-now)/1000))});}
  const needed=keys.filter(([key])=>!this.entries.has(key)).length;if(this.entries.size+needed>this.maxEntries)throw Object.assign(new Error('Too many sign-in attempts; try again later'),{status:429,retryAfter:60});
  for(const [key,,duration] of keys){const value=this.entries.get(key)||{count:0,until:now+duration};value.count++;this.entries.set(key,value);}
 }
}
