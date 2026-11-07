// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import http from 'node:http';
import https from 'node:https';
import {promises as fs} from 'node:fs';
import {Transform,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGunzip} from 'node:zlib';
import {performance} from 'node:perf_hooks';

const compressedRoutes=new Set(['/api/snapshot','/api/events','/api/history','/api/account/usage','/api/integrations/github']);
const DEADLINE_MS=6000;

// Called only by existing server route handlers. The destination remains the
// configured origin; only selected read-only requests advertise compression.
export async function remoteJSON(configuration,route,method='GET',body,{validate}={}){
 const base=new URL(configuration.url),url=new URL(route,base);
 if(typeof route!=='string'||!route.startsWith('/')||route.startsWith('//')||url.origin!==base.origin)throw new Error('Upstream route must stay on its configured origin');
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw new Error('Encrypted upstream required');
 const started=performance.now(),controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),DEADLINE_MS);deadline.unref();
 let request,response,wire,decoder,sink,completed=false;
 try{
  const ca=configuration.caFile?await fs.readFile(configuration.caFile,{signal:controller.signal}):undefined,encoded=body===undefined?undefined:JSON.stringify(body),headers={authorization:'Bearer '+configuration.token};
  if(method==='GET'&&body===undefined&&compressedRoutes.has(url.pathname))headers['accept-encoding']='gzip';
  if(encoded){headers['content-type']='application/json';headers['content-length']=Buffer.byteLength(encoded);}
  response=await new Promise((resolve,reject)=>{
   validate?.();
   request=(url.protocol==='https:'?https:http).request(url,{ca,rejectUnauthorized:true,method,headers,timeout:DEADLINE_MS,signal:controller.signal},resolve);
   request.once('error',reject);request.once('timeout',()=>controller.abort());request.end(encoded);
  });
  const coding=String(response.headers['content-encoding']||'identity').trim().toLowerCase();
  if(!['identity','gzip'].includes(coding))throw new Error('Unsupported upstream content encoding');
  const limit=url.pathname==='/api/admin/diagnostics/export-preview'?131072:url.pathname==='/api/preferences'?16384:32000000,chunks=[];let wireBytes=0,decodedBytes=0;
  if(response.headers['content-length']!==undefined&&Number(response.headers['content-length'])>limit)throw new Error('Upstream exceeds bound');
  wire=new Transform({transform(chunk,encoding,callback){wireBytes+=chunk.length;if(wireBytes>limit)callback(new Error('Upstream exceeds bound'));else callback(null,chunk);}});
  sink=new Writable({write(chunk,encoding,callback){decodedBytes+=chunk.length;if(decodedBytes>limit)callback(new Error('Upstream exceeds bound'));else{chunks.push(chunk);callback();}}});
  const stages=[response,wire];if(coding==='gzip'){decoder=createGunzip({chunkSize:16384,rejectGarbageAfterEnd:true});stages.push(decoder);}stages.push(sink);
  await pipeline(stages,{signal:controller.signal});
  if(controller.signal.aborted||performance.now()-started>=DEADLINE_MS)throw new Error('Upstream timeout');
  const data=JSON.parse(Buffer.concat(chunks,decodedBytes).toString('utf8'));
  if(performance.now()-started>=DEADLINE_MS)throw new Error('Upstream timeout');
  if(response.statusCode!==200)throw Object.assign(new Error(typeof data.error==='string'?data.error:'Upstream unavailable'),{status:response.statusCode,errors:data.errors});
  completed=true;return data;
 }catch(error){if(controller.signal.aborted)throw new Error('Upstream timeout');throw error;}
 finally{
  clearTimeout(deadline);
  if(!completed){request?.destroy();for(const stream of [response,wire,decoder,sink])stream?.destroy();}
 }
}
