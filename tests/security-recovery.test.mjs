// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {projectRibbon,EventRibbon} from '../public/event-ribbon.mjs';
import {filterSnapshot} from '../lib/viewer-access.mjs';
import {createServer} from './fixture-server.mjs';
import {createServer as createHttpServer} from 'node:http';

test('recovered Ribbon trigger never reaches density gradients as an inherited palette value',()=>{
 const reference=Date.parse('2026-10-20T12:00:00Z');
 for(const palette of [undefined,{tool:'#abcdef',error:'#ff0000',edit:'#00ff00'}])for(const category of ['constructor','toString','__proto__','hasOwnProperty','edit']){
  const event={id:'TEST_ONLY',sessionId:'worker',hostId:'host',kind:'operation',category,at:new Date(reference-1).toISOString()},input={events:[event],reference,...(palette?{palette}:{})};
  const model=projectRibbon(input);for(const bin of model.lanes[0].bins)assert.equal(typeof bin.color,'string');assert.equal(event.category,category);
  const context=new Proxy({createLinearGradient:()=>({addColorStop:(_offset,color)=>assert.equal(typeof color,'string')})},{get:(target,key)=>target[key]??(()=>{})});
  const ribbon=new EventRibbon({createElement:()=>({getContext:()=>context})});ribbon.update(input);assert.equal(ribbon.prepare(800,300,1,{dark:true},true),true);assert.equal(ribbon.prepare(800,300,1,{dark:true},true),false);ribbon.update(input);assert.equal(ribbon.prepare(800,300,1,{dark:true},true),true);
  const failed=projectRibbon({...input,events:[{...event,outcome:'failed'}]});assert.equal(failed.lanes[0].markers[0].color,palette?.error??'#ff3b64');
 }
});

test('recovered snapshot quota trigger is redacted by role without changing authorized counters or source evidence',()=>{
 const source={sessions:[{id:'worker',hostId:'host',project:'project',tokens:{total_tokens:42},usageLimits:[{limitId:'weekly',accountKey:null,primary:{usedPercent:25},observedAt:'2026-10-20T12:00:00Z'}]}],hosts:[{id:'host'}],events:[],coverage:{}};
 for(const viewer of [{role:'admin',hostIds:null,projectIds:null},{role:'viewer',hostIds:null,projectIds:null},{role:'admin',hostIds:['host'],projectIds:null},{role:'viewer',hostIds:null,projectIds:['project']}]){
  const output=filterSnapshot(source,viewer),allowed=viewer.role==='admin'&&viewer.hostIds===null&&viewer.projectIds===null;
  assert.equal(output.sessions.length,1);assert.equal(output.sessions[0].tokens.total_tokens,42);assert.equal(Object.hasOwn(output.sessions[0],'usageLimits'),allowed);assert.equal(output.capabilities.observed.quotaReadings,allowed);
 }
 assert.equal(source.sessions[0].usageLimits.length,1);assert.equal(filterSnapshot(source,{role:'admin',hostIds:[],projectIds:null}).sessions.length,0);
});

for(const cookie of [false,true])test('recovered diagnostics delivery refuses '+(cookie?'cookie':'bearer')+' authority lost during filesystem await',{timeout:10000},async t=>{
 const token='TEST_ONLY_recovery',expires=Date.now()+60000,entered=Promise.withResolvers(),release=Promise.withResolvers(),file=path.join(os.tmpdir(),'TEST_ONLY_'+crypto.randomUUID()+'.sqlite');
 const server=createServer({hub:{hosts:[],journal:{file,status:()=>({retainedEvents:7})}},viewers:[{id:'recovery-viewer',label:'TEST_ONLY',role:'viewer',hostIds:null,projectIds:null,expiresAt:new Date(expires).toISOString(),tokenHash:crypto.createHash('sha256').update(token).digest('hex')}]});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const origin='http://127.0.0.1:'+server.address().port;
 let headers={authorization:'Bearer '+token};if(cookie){const login=await fetch(origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});assert.equal(login.status,200);headers={cookie:login.headers.get('set-cookie').split(';')[0]};}
 const stat=fs.stat;t.mock.method(fs,'stat',async(p,...args)=>{if(String(p).startsWith(file)){entered.resolve();await release.promise;return {size:1};}return stat(p,...args);});
 const pending=fetch(origin+'/api/diagnostics',{headers});await entered.promise;const clock=t.mock.method(Date,'now',()=>expires+1);release.resolve();let response;
 try{response=await pending;}finally{clock.mock.restore();}assert.equal(response.status,401);assert.ok(!(await response.text()).includes('retainedEvents'));
 const legitimate=await fetch(origin+'/api/diagnostics',{headers});assert.equal(legitimate.status,200);assert.equal((await legitimate.json()).journal.retainedEvents,7);
});
test('diagnostics authority is rechecked before upstream dispatch after CA I/O',{timeout:10000},async t=>{
 const token='TEST_ONLY_dispatch',expires=Date.now()+13*60*60*1000,entered=Promise.withResolvers(),release=Promise.withResolvers(),file=path.join(os.tmpdir(),'TEST_ONLY_'+crypto.randomUUID()+'.pem');let requests=0;
 const upstream=createHttpServer((_req,res)=>{requests++;res.setHeader('content-type','application/json');res.end('{}');});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>upstream.close(r)));
 const server=createServer({upstream:{url:'http://127.0.0.1:'+upstream.address().port,token:'TEST_ONLY_upstream',caFile:file},viewTokenHash:crypto.createHash('sha256').update(token).digest('hex')});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const read=fs.readFile;t.mock.method(fs,'readFile',async(p,...args)=>{if(p===file){entered.resolve();await release.promise;return Buffer.from('TEST_ONLY_CA');}return read(p,...args);});
 const origin='http://127.0.0.1:'+server.address().port,login=await fetch(origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});assert.equal(login.status,200);const headers={cookie:login.headers.get('set-cookie').split(';')[0]},pending=fetch(origin+'/api/diagnostics',{headers});await entered.promise;const clock=t.mock.method(Date,'now',()=>expires+1);release.resolve();let response;try{response=await pending;}finally{clock.mock.restore();}
 assert.equal(response.status,401);await response.text();assert.equal(requests,0);const valid=await fetch(origin+'/api/diagnostics',{headers:{authorization:'Bearer '+token}});assert.equal(valid.status,200);await valid.text();assert.equal(requests,1);
});

test('HTTP snapshot enforces quota field policy while keeping legitimate worker counters',async t=>{
 const source={observedAt:new Date().toISOString(),mode:'read-only-log-observer',host:{id:'host'},hosts:[{id:'host'}],sessions:[{id:'worker',hostId:'host',project:'project',tokens:{total_tokens:42},usageLimits:[{limitId:'weekly',primary:{usedPercent:25},observedAt:new Date().toISOString()}]}],events:[],coverage:{}},viewers=[{id:'admin',role:'admin',hostIds:null},{id:'viewer',role:'viewer',hostIds:null},{id:'scoped',role:'viewer',hostIds:['host']}].map(v=>({...v,label:'TEST_ONLY',projectIds:null,tokenHash:crypto.createHash('sha256').update('TEST_ONLY_'+v.id).digest('hex')}));
 const server=createServer({readSnapshot:async()=>source,viewers});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const origin='http://127.0.0.1:'+server.address().port;
 for(const viewer of viewers){const response=await fetch(origin+'/api/snapshot',{headers:{authorization:'Bearer TEST_ONLY_'+viewer.id}});assert.equal(response.status,200);const result=await response.json();assert.equal(result.sessions[0].tokens.total_tokens,42);assert.equal(Object.hasOwn(result.sessions[0],'usageLimits'),viewer.id==='admin');assert.equal(result.capabilities.observed.quotaReadings,viewer.id==='admin');}assert.equal(source.sessions[0].usageLimits.length,1);
});
