// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {EventEmitter} from 'node:events';
import {FleetHub} from '../lib/fleet.mjs';
import {createServer} from './fixture-server.mjs';
import {deliverRepresentation} from '../lib/http-representation.mjs';
const NOW=Date.parse('2026-10-20T12:00:00Z'),stamp=n=>new Date(NOW+n).toISOString(),hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const tokens=n=>({input_tokens:n,cached_input_tokens:n/4,output_tokens:n/10,total_tokens:n+n/10});

function raw(server,route,{encoding='gzip',method='GET',token='viewer-key',cookie,origin,body}={}){
 const encoded=body===undefined?null:JSON.stringify(body);
 return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:route,method,headers:{'accept-encoding':encoding,...(token?{authorization:'Bearer '+token}:{}),...(cookie?{cookie}:{}),...(origin?{origin}:{}),...(encoded?{'content-type':'application/json','content-length':Buffer.byteLength(encoded)}:{})}},res=>{const chunks=[];res.on('error',reject);res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',reject);req.end(encoded);});
}
async function fixture(run){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-delivery-')),realNow=Date.now;let server,calls=0;Date.now=()=>NOW;
 try{
  const hosts=['allowed','denied'].map(id=>({id,tokenHash:hash('collector-'+id)})),hub=await FleetHub.open({directory,hosts});
  for(const h of hosts)for(const offset of [-1000,0])await hub.ingest('collector-'+h.id,{hostId:h.id,batchId:h.id+offset,observedAt:stamp(offset),sessions:Array.from({length:12},(_,i)=>({id:'worker-'+i,project:h.id==='allowed'?'Alpha':'Hidden project',provider:'openai',model:'TEST_ONLY_model',usageObservedAt:stamp(offset),tokens:tokens(offset===0?1200:1000)})),events:offset===0?Array.from({length:8},(_,i)=>({id:'event-'+i,sessionId:'worker-0',sourceId:'source-'+i,at:stamp(-500+i),kind:'turn',project:h.id==='allowed'?'Alpha':'Hidden project',projectBasis:'source-context',label:('TEST_ONLY_'+h.id+'_').repeat(10)})):[]});
  const readSnapshot=async()=>{calls++;return {observedAt:stamp(0),mode:'read-only-log-observer',host:{id:'test-hub',name:'TEST_ONLY hub'},coverage:{completeHistory:false},sessions:[],events:[]};};
  server=createServer({hub,readSnapshot,preferencesDirectory:path.join(directory,'profiles'),viewers:[{id:'alice',label:'Alice',tokenHash:hash('viewer-key'),hostIds:['allowed'],projectIds:['Alpha']}]});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await run({server,hub,calls:()=>calls});
 }finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}Date.now=realNow;await fs.rm(directory,{recursive:true,force:true});}
}

test('selected authenticated responses decode byte-identically with current host/project SQL scopes',()=>fixture(async({server})=>{
 for(const route of ['/api/snapshot?metadata=1','/api/snapshot','/api/events?after=0','/api/history?before='+encodeURIComponent(stamp(1))+'&beforeSequence=100000','/api/account/usage','/api/account/usage?details=1']){
  const identity=await raw(server,route,{encoding:'identity'}),gzip=await raw(server,route);assert.equal(identity.status,200,route);assert.equal(gzip.status,200,route);assert.equal(identity.headers['content-encoding'],undefined);assert.equal(gzip.headers['content-encoding'],'gzip',route);assert.deepEqual(gunzipSync(gzip.body),identity.body,route);assert.equal(Number(gzip.headers['content-length']),gzip.body.length);assert.equal(gzip.headers['cache-control'],'no-store');assert.equal(gzip.headers.vary,'Accept-Encoding');assert.equal(identity.body.toString().includes('Hidden project'),false);assert.equal(identity.body.toString().includes('collector-allowed'),false);
 }
 const snapshot=JSON.parse(gunzipSync((await raw(server,'/api/snapshot')).body));assert.deepEqual(snapshot.hosts.map(h=>h.id),['allowed']);assert.equal(snapshot.sessions.every(s=>s.hostId==='allowed'),true);
 for(const route of ['/api/events?after=0&hostId=denied','/api/account/usage?project=Hidden%20project']){const denied=await raw(server,route);assert.equal(denied.status,403);assert.equal(denied.headers['content-encoding'],undefined);}
}));

test('authentication/origin/errors and profile/login/collector/media responses remain uncompressed',()=>fixture(async({server})=>{
 for(const route of ['/api/snapshot','/api/account/usage','/api/events?after=0']){const unauthorized=await raw(server,route,{token:null});assert.equal(unauthorized.status,401);assert.equal(unauthorized.headers['content-encoding'],undefined);}
 const foreign=await raw(server,'/api/snapshot',{origin:'https://foreign.example.invalid'});assert.equal(foreign.status,403);assert.equal(foreign.headers['content-encoding'],undefined);
 for(const [route,options] of [['/',{token:null}],['/app.css',{token:null}],['/login.js',{}],['/api/account',{}],['/api/preferences',{}],['/api/settings/personal',{}],['/api/identity',{token:null}],['/api/auth/capabilities',{token:null}],['/assets/fonts/JetBrainsMono-Regular.woff2',{}],['/assets/argellan-symbol.svg',{}]]){const result=await raw(server,route,options);assert.equal(result.headers['content-encoding'],undefined,route);assert.equal(result.headers['cache-control'],'no-store');}
 const login=await raw(server,'/api/session',{token:null,method:'POST',body:{token:'viewer-key'}});assert.equal(login.status,200);assert.equal(login.headers['content-encoding'],undefined);assert.match(login.headers['set-cookie'][0],/HttpOnly; SameSite=Strict/);const cookie=login.headers['set-cookie'][0].split(';')[0];
 const authCookie=await raw(server,'/api/snapshot',{token:null,cookie});assert.equal(authCookie.status,200);assert.equal(authCookie.headers['content-encoding'],'gzip');
 const logout=await raw(server,'/api/session/logout',{token:null,cookie,method:'POST'});assert.equal(logout.status,200);assert.equal(logout.headers['content-encoding'],undefined);assert.equal((await raw(server,'/api/snapshot',{token:null,cookie})).status,401);
 const ack=await raw(server,'/api/collector',{method:'POST',token:'collector-allowed',body:{hostId:'allowed',batchId:'TEST_ONLY_ack',observedAt:stamp(0),sessions:[],events:[]}});assert.equal(ack.status,200);assert.equal(ack.headers['content-encoding'],undefined);assert.equal(JSON.parse(ack.body).batchId,'TEST_ONLY_ack');
}));

test('HEAD avoids collection and compression; quality refusals and static byte delivery are explicit',()=>fixture(async({server,calls})=>{
 const before=calls();for(const route of ['/api/snapshot','/api/account/usage','/api/events','/api/history','/app.js']){const head=await raw(server,route,{method:'HEAD',encoding:'gzip,identity;q=0'});assert.equal(head.status,200);assert.equal(head.body.length,0);assert.equal(head.headers['content-encoding'],undefined);assert.equal(head.headers['content-length'],undefined);assert.equal(head.headers.vary,'Accept-Encoding');}assert.equal(calls(),before);
 for(const [encoding,status,encoded] of [['gzip;q=0,*;q=1',200,false],['gzip;q=0.3,identity;q=0.8',200,false],['gzip;q=0.8,identity;q=0.3',200,true],['gzip,identity;q=0',200,true],['br,identity;q=0',406,false],['*;q=0',406,false],['gzip;q=1.123',400,false]]){const result=await raw(server,'/api/snapshot?metadata=1',{encoding});assert.equal(result.status,status,encoding);assert.equal(result.headers['content-encoding']==='gzip',encoded,encoding);}
 for(const route of ['/app.js','/app.css','/assets/fonts/OFL.txt']){const identity=await raw(server,route,{encoding:'identity'}),encoded=await raw(server,route,{encoding:'gzip,identity;q=0'});assert.equal(encoded.status,200);assert.equal(encoded.headers['content-encoding'],'gzip');assert.deepEqual(gunzipSync(encoded.body),identity.body);}
}));

test('source authorization changes during awaited snapshot construction prevent publication',()=>fixture(async({server,hub})=>{
 const original=hub.captureLocalNow.bind(hub);hub.captureLocalNow=async local=>{const result=await original(local);hub.hosts.find(h=>h.id==='allowed').disabled=true;return result;};
 const result=await raw(server,'/api/snapshot');assert.equal(result.status,403);assert.equal(result.headers['content-encoding'],undefined);assert.equal(result.body.toString().includes('worker-0'),false);
}));

test('public identity and collector ACK do not inspect unrelated source expiries for encoding',()=>fixture(async({server,hub})=>{
 Object.defineProperty(hub.hosts.find(h=>h.id==='denied'),'expiresAt',{configurable:true,get(){throw new Error('TEST_ONLY unrelated source expiry was inspected');}});
 const identity=await raw(server,'/api/identity',{token:null});assert.equal(identity.status,200);assert.equal(identity.headers['content-encoding'],undefined);
 const ack=await raw(server,'/api/collector',{method:'POST',token:'collector-allowed',body:{hostId:'allowed',batchId:'TEST_ONLY_no_delivery_work',observedAt:stamp(0),sessions:[],events:[]}});assert.equal(ack.status,200);assert.equal(ack.headers['content-encoding'],undefined);assert.equal(JSON.parse(ack.body).batchId,'TEST_ONLY_no_delivery_work');
}));

test('same-input synthetic metadata/events/usage CPU and entity-wire measurements remain exact',async t=>{
 const shapes={metadata:{observedAt:stamp(0),hosts:Array.from({length:6},(_,h)=>({id:'host-'+h,status:'online',sessions:Array.from({length:24},(_,i)=>({id:'session-'+h+'-'+i,project:'TEST_ONLY',model:'fixture-model',state:'Turn completed',tokens:tokens(1200),missing:null}))}))},events:{events:Array.from({length:500},(_,i)=>({id:'event-'+i,hostId:'host-'+i%6,sessionId:'session-'+i%24,at:stamp(-i*10),kind:'turn',label:'TEST_ONLY observed event',missing:null}))},usage:{observations:Array.from({length:200},(_,i)=>({sequence:i+1,hostId:'host-'+i%6,sessionId:'session-'+i%24,sourceAt:stamp(-i*10),counters:tokens(i*20),status:i%3?'delta':'partial',missing:null})),daily:Array.from({length:366},(_,i)=>({day:new Date(NOW-i*86400000).toISOString().slice(0,10),tokens:i*100,classification:'observed'}))}};
 class Response extends EventEmitter{constructor(){super();this.statusCode=200;this.headers=new Map();}getHeader(n){return this.headers.get(n);}hasHeader(n){return this.headers.has(n);}setHeader(n,v){this.headers.set(n,v);}end(body){this.body=body;this.writableEnded=true;}}
 const results=[],iterations=64;
 for(const [shape,value] of Object.entries(shapes)){
  const input=Buffer.from(JSON.stringify(value)),observations=[],memoryBefore=process.memoryUsage();
  for(let pair=0;pair<6;pair++)for(const encoding of pair%2?['gzip','identity']:['identity','gzip']){
   let res;const start=performance.now(),cpu=process.cpuUsage();
   for(let i=0;i<iterations;i++){res=new Response();await deliverRepresentation({method:'GET',headers:{'accept-encoding':encoding}},res,input);}
   const elapsedMs=performance.now()-start,cpuUsed=process.cpuUsage(cpu);
   assert.deepEqual(encoding==='gzip'?gunzipSync(res.body):res.body,input);observations.push({pair,encoding,iterations,elapsedMs,perOperationMs:elapsedMs/iterations,cpuMs:(cpuUsed.user+cpuUsed.system)/1000,entityBytes:res.body.length});
  }
  results.push({shape,inputBytes:input.length,memoryBefore,memoryAfter:process.memoryUsage(),observations});
 }
 t.diagnostic(JSON.stringify({classification:'TEST_ONLY synthetic in-process helper CPU/entity-wire sizes; no live payloads, network/TLS, Pi/browser, ingestion or production qualification',cpuCaveat:'Windows process CPU accounting is coarse; zero samples are below resolution and all process/GC work may contribute. Memory endpoints are not peak or leak/soak qualification.',node:process.version,sqlite:process.versions.sqlite,results}));
});
