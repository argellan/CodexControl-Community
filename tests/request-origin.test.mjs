// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startRuntime} from '../server.mjs';
import {createServer} from './fixture-server.mjs';
const originModule=await import('../lib/request-origin.mjs').catch(()=>({}));
const direct='https://203.0.113.92:4317',proxy='https://control.example.invalid',other='https://other.example.invalid';
const token='TEST_ONLY_origin_access_key_9d21',hash=crypto.createHash('sha256').update(token).digest('hex');
const request=(host,origin,extra={})=>({headers:{host,...(origin===undefined?{}:{origin}),...extra},socket:{localPort:4317}});
const policy=options=>{assert.equal(typeof originModule.createRequestOriginPolicy,'function','exact request-origin policy is available');return originModule.createRequestOriginPolicy(options);};
const readSnapshot=async()=>({observedAt:new Date().toISOString(),host:{id:'test-only'},hosts:[{id:'test-only',status:'online'}],sessions:[],events:[],coverage:{}});

async function get(server,route='/',{host,origin,method='GET',body,cookie,headers={}}={}){
 const encoded=body===undefined?undefined:JSON.stringify(body);
 return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,headers:{host:host||'127.0.0.1:'+server.address().port,...(origin===undefined?{}:{origin}),...(cookie?{cookie}:{}),...(encoded?{'content-type':'application/json','content-length':Buffer.byteLength(encoded)}:{}),...headers}},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{data=text;}resolve({status:res.statusCode,headers:res.headers,data,cookie:res.headers['set-cookie']?.[0]?.split(';')[0]});});});req.on('error',reject);req.end(encoded);});
}
async function fixture(run,options={}){const server=createServer({viewTokenHash:hash,readSnapshot,publicOrigin:direct,proxyOrigins:[proxy],...options});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{await run(server);}finally{await new Promise(resolve=>server.close(resolve));}}

test('exact direct and loopback origins remain available without proxy options or native Origin headers',()=>{
 const p=policy({publicOrigin:direct});
 for(const r of [request('203.0.113.92:4317'),request('203.0.113.92:4317',direct),request('203.0.113.92:4317','http://203.0.113.92:4317'),request('127.0.0.1:4317','http://127.0.0.1:4317'),request('localhost:4317')])assert.equal(p.accepts(r),true);
 assert.equal(p.accepts(request('control.example.invalid',proxy)),false);
 assert.equal(p.accepts(request('127.0.0.1:4317',direct)),false,'trusted origins do not authorize a different host');
 assert.equal(policy({tls:true}).accepts(request('localhost:4317','https://localhost:4317')),true);
 assert.equal(policy({tls:true}).accepts(request('localhost:4317','http://localhost:4317')),false);
});

test('proxy origins are canonical HTTPS authorities with strict bounds and unambiguous hosts',()=>{
 const invalid=[null,'https://control.example.invalid',{},Array(9).fill(proxy),[proxy,proxy],['http://control.example.invalid'],['https://CONTROL.example.invalid'],['https://control.example.invalid/'],['https://control.example.invalid:443'],['https://user:password@control.example.invalid'],['https://control.example.invalid/path'],['https://control.example.invalid?query'],['https://control.example.invalid#fragment'],['https://*.example.invalid'],['https://'],[' https://control.example.invalid'],['https://control.example.invalid '],['https://control.example.invalid\n'],[undefined],[42]];
 for(const proxyOrigins of invalid)assert.throws(()=>policy({publicOrigin:direct,proxyOrigins}),/proxy origin/i,JSON.stringify(proxyOrigins));
 assert.throws(()=>policy({publicOrigin:'http://control.example.invalid',proxyOrigins:[proxy]}),/proxy origin/i);
 const p=policy({publicOrigin:direct,proxyOrigins:Array.from({length:8},(_,i)=>`https://node${i}.example.invalid`)});assert.equal(p.accepts(request('node7.example.invalid','https://node7.example.invalid')),true);
 const ipv6=policy({proxyOrigins:['https://[2001:db8::1]:8443']});assert.equal(ipv6.accepts(request('[2001:db8::1]:8443','https://[2001:db8::1]:8443')),true);
});

test('trusted proxy origins bind to their actual Host and are immutable after construction',()=>{
 const origins=[proxy],p=policy({publicOrigin:direct,proxyOrigins:origins});origins[0]=other;origins.push('https://unknown.example.invalid');
 assert.equal(Object.isFrozen(p),true);assert.equal(p.accepts(request('control.example.invalid',proxy)),true);assert.equal(p.accepts(request('control.example.invalid')),true);
 for(const r of [request('other.example.invalid',other),request('control.example.invalid',other),request('control.example.invalid','http://control.example.invalid'),request('203.0.113.92:4317',proxy),request('control.example.invalid',direct),request('control.example.invalid:443',proxy),request('CONTROL.example.invalid',proxy),request(undefined,proxy),request('control.example.invalid',[proxy])])assert.equal(p.accepts(r),false);
});

test('cross-site requests and forwarded headers cannot establish origin authority',()=>{
 const p=policy({publicOrigin:direct,proxyOrigins:[proxy]});
 for(const r of [request('control.example.invalid',proxy,{'sec-fetch-site':'cross-site'}),request('203.0.113.92:4317',undefined,{'sec-fetch-site':'cross-site'}),request('attacker.example.invalid',proxy,{'x-forwarded-host':'control.example.invalid','x-forwarded-proto':'https'}),request('control.example.invalid','http://control.example.invalid',{'x-forwarded-proto':'https'}),request('unknown.example.invalid',undefined,{forwarded:'host=control.example.invalid;proto=https'})])assert.equal(p.accepts(r),false);
});

test('HTTP direct native requests and allowed proxy requests retain identity and key session behavior',()=>fixture(async server=>{
 assert.equal((await get(server,'/api/identity',{host:'203.0.113.92:4317'})).status,200);
 const host='control.example.invalid';assert.equal((await get(server,'/api/snapshot',{host,origin:proxy})).status,401);
 const login=await get(server,'/api/session',{host,origin:proxy,method:'POST',body:{token}});assert.equal(login.status,200);assert.match(login.cookie,/^cc_local_control\.example\.invalid=/);assert.match(login.headers['set-cookie'][0],/HttpOnly; SameSite=Strict; Path=\/; Secure/);
 assert.equal((await get(server,'/api/snapshot',{host,origin:proxy,cookie:login.cookie})).status,200);
 assert.equal((await get(server,'/api/snapshot',{host:'203.0.113.92:4317',cookie:login.cookie})).status,401,'alias cookie names stay host specific');
 assert.equal((await get(server,'/api/snapshot',{host:'203.0.113.92:4317',headers:{authorization:'Bearer '+token}})).status,200,'existing native bearer clients need no Origin');
 const logout=await get(server,'/api/session/logout',{host,origin:proxy,method:'POST',cookie:login.cookie});assert.equal(logout.status,200);assert.match(logout.headers['set-cookie'][0],/Max-Age=0/);
 assert.equal(login.headers['access-control-allow-origin'],undefined);
}));

test('HTTP unknown hosts, foreign or mispaired origins and cross-site login are refused before authentication',()=>fixture(async server=>{
 for(const headers of [{host:'unknown.example.invalid',origin:proxy},{host:'control.example.invalid',origin:other},{host:'203.0.113.92:4317',origin:proxy},{host:'control.example.invalid',origin:direct},{host:'control.example.invalid',origin:'http://control.example.invalid'},{host:'control.example.invalid',origin:proxy,'sec-fetch-site':'cross-site'},{host:'unknown.example.invalid','x-forwarded-host':'control.example.invalid','x-forwarded-proto':'https'}]){
  const r=await get(server,'/api/session',{host:headers.host,origin:headers.origin,headers,method:'POST',body:{token}});assert.equal(r.status,403);assert.equal(r.cookie,undefined);assert.equal(r.headers['access-control-allow-origin'],undefined);
 }
}));

test('server construction validates proxy origins rather than deferring invalid trust to requests',()=>{
 assert.throws(()=>createServer({proxyOrigins:['http://control.example.invalid']}),/proxy origin/i);
 assert.throws(()=>createServer({publicOrigin:'http://control.example.invalid',proxyOrigins:[proxy]}),/proxy origin/i);
});

test('runtime forwards immutable proxy options without putting them in saved deployment configuration',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-origin-test-only-')),probe=http.createServer();let runtime;
 await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 try{runtime=await startRuntime({dataDirectory:directory,listen:'127.0.0.1',port,viewTokenHash:hash,upstream:{url:'http://127.0.0.1:1',token},proxyOrigins:[proxy]});assert.equal((await get(runtime.server,'/api/identity',{host:'control.example.invalid',origin:proxy})).status,200);assert.equal(runtime.configuration,undefined);assert.deepEqual((await fs.readdir(directory)).sort(),['diagnostics','gateway-runtime.pid']);assert.deepEqual(await fs.readdir(path.join(directory,'diagnostics')),['run-state']);assert.equal(await fs.readFile(path.join(directory,'diagnostics','run-state'),'utf8'),'running');}
 finally{if(runtime)await new Promise(resolve=>runtime.server.close(resolve));await fs.rm(directory,{recursive:true,force:true});}
});
