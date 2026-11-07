// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {gzip} from 'node:zlib';

export const REPRESENTATION_LIMITS=Object.freeze({maxTasks:2,maxInputBytes:4*1024*1024,maxOutputBytes:4*1024*1024+65536,minInputBytes:1024,maxQueuedTasks:4,maxQueuedBytes:8*1024*1024,maxWaitMs:100});
let activeTasks=0,queuedBytes=0;const waiting=[];
function nextCompression(){while(activeTasks<REPRESENTATION_LIMITS.maxTasks&&waiting.length)waiting[0].finish(true);}
function waitForCompression(res,bytes,maxWaitMs){
 if(maxWaitMs<=0||waiting.length>=REPRESENTATION_LIMITS.maxQueuedTasks||queuedBytes+bytes>REPRESENTATION_LIMITS.maxQueuedBytes)return Promise.resolve(false);
 return new Promise(resolve=>{let done=false,timer;const entry={finish(admit){if(done)return;done=true;clearTimeout(timer);res.off('close',closed);const index=waiting.indexOf(entry);if(index>=0)waiting.splice(index,1);queuedBytes-=bytes;const accepted=admit&&!res.destroyed&&!res.writableEnded;if(accepted)activeTasks++;resolve(accepted);}};const closed=()=>entry.finish(false);queuedBytes+=bytes;waiting.push(entry);res.once('close',closed);timer=setTimeout(()=>entry.finish(false),Math.min(REPRESENTATION_LIMITS.maxWaitMs,maxWaitMs));});
}
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};

// RFC 9110 section 12.5.3. Explicit exclusions override wildcard acceptance.
export function encodingQualities(header){
 if(header===undefined||header==='')return {gzip:0,identity:1};
 if(typeof header!=='string'||header.length>8192)fail(400,'Invalid Accept-Encoding');
 const values=new Map(),members=header.split(',');if(members.length>128)fail(400,'Invalid Accept-Encoding');
 for(const member of members){
  if(!member.trim())continue;
  const match=/^\s*([!#$%&'*+.^_`|~0-9a-z-]+)\s*(?:;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*)?$/i.exec(member);
  if(!match)fail(400,'Invalid Accept-Encoding');
  const name=match[1].toLowerCase(),quality=match[2]===undefined?1:Number(match[2]);
  values.set(name,Math.min(values.get(name)??quality,quality));
 }
 return {gzip:values.get('gzip')??values.get('*')??0,identity:values.get('identity')??(values.get('*')===0?0:1)};
}

function varyEncoding(res){
 const prior=String(res.getHeader('Vary')||'').split(',').map(v=>v.trim()).filter(Boolean);
 if(!prior.some(v=>v==='*'||v.toLowerCase()==='accept-encoding'))prior.push('Accept-Encoding');
 res.setHeader('Vary',prior.join(', '));
}

// Process-wide bounded admission, including all server instances. A brief bounded
// queue avoids sending large identity responses when live endpoints arrive together.
// No private response cache; disconnected active tasks hold slots until zlib ends.
export function createRepresentationDelivery({compress=gzip,maxWaitMs=REPRESENTATION_LIMITS.maxWaitMs}={}){
 return async function deliver(req,res,body,{validate}={}){
  if(res.destroyed||res.writableEnded)return;
  if(res.statusCode===204||res.statusCode===205||res.statusCode===304){res.end();return;}
  varyEncoding(res);const qualities=encodingQualities(req.headers['accept-encoding']);
  if(!qualities.gzip&&!qualities.identity)fail(406,'No acceptable response encoding');
  validate?.();
  const preferGzip=qualities.gzip>0&&qualities.gzip>=qualities.identity&&!res.hasHeader('Set-Cookie');
  if(req.method==='HEAD'){
   // Selection also depends on body size/admission. HEAD omits fields requiring
   // that work, as permitted by RFC 9110 section 9.3.2, and performs no gzip.
   if(!preferGzip&&!qualities.identity)fail(406,'No acceptable response encoding');
   res.end();return;
  }
  const bytes=Buffer.isBuffer(body)?body.length:Buffer.byteLength(body,'utf8');let output=body,encoded=false;
  if(preferGzip&&(bytes>=REPRESENTATION_LIMITS.minInputBytes||!qualities.identity)){
   let admitted=false;if(bytes<=REPRESENTATION_LIMITS.maxInputBytes){if(activeTasks<REPRESENTATION_LIMITS.maxTasks){activeTasks++;admitted=true;}else admitted=await waitForCompression(res,bytes,maxWaitMs);}
   if(admitted){
    let closed=false;const onClose=()=>{closed=true;};res.once('close',onClose);
    try{
     const input=Buffer.isBuffer(body)?body:Buffer.from(body,'utf8');
     const compressed=await new Promise((resolve,reject)=>{
      let completed=false;const complete=(error,value)=>{if(completed)return;completed=true;error?reject(error):resolve(value);};
      try{compress(input,{level:3,maxOutputLength:REPRESENTATION_LIMITS.maxOutputBytes},complete);}catch(error){complete(error);}
     });
     if(!Buffer.isBuffer(compressed)||compressed.length>REPRESENTATION_LIMITS.maxOutputBytes)throw new Error('Compression output bound exceeded');
     if(closed||res.destroyed||res.writableEnded)return;
     if(compressed.length<bytes||!qualities.identity){output=compressed;encoded=true;}
    }catch{
     if(closed||res.destroyed||res.writableEnded)return;
     if(!qualities.identity)fail(503,'Response encoding temporarily unavailable');
    }finally{activeTasks--;res.off('close',onClose);nextCompression();}
   }else if(!qualities.identity)fail(503,'Response encoding temporarily unavailable');
  }else if(!qualities.identity)fail(406,'No acceptable response encoding');
  if(res.destroyed||res.writableEnded)return;
  validate?.();
  if(encoded)res.setHeader('Content-Encoding','gzip');
  res.setHeader('Content-Length',encoded?output.length:bytes);res.end(output);
 };
}

export const deliverRepresentation=createRepresentationDelivery();
