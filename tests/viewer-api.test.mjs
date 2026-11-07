// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';
import {FleetHub} from '../lib/fleet.mjs';import {createServer} from './fixture-server.mjs';
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');

test('project-scoped HTTP snapshot and recovery deny unqualified legacy events without deleting history',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-project-api-TEST_ONLY-'));let server;
 try{
  const hosts=[{id:'test-source',tokenHash:hash('TEST_ONLY_collector')}],hub=await FleetHub.open({directory,hosts}),at=new Date().toISOString();
  const events=[{id:'a',project:'A',projectBasis:'source-context',label:'A evidence'},{id:'b',project:'B',projectBasis:'source-context',label:'B evidence'},{id:'legacy',project:'B',label:'Legacy evidence'}].map(e=>({...e,sessionId:'TEST_ONLY-session',sourceId:'TEST_ONLY-source',at,kind:'turn'}));
  await hub.ingest('TEST_ONLY_collector',{hostId:'test-source',batchId:'TEST_ONLY-project-batch',observedAt:at,sessions:[{id:'TEST_ONLY-session',project:'B'}],events});
  server=createServer({hub,readSnapshot:async()=>({observedAt:at,host:{id:'hub'},coverage:{},sessions:[],events:[]}),viewers:['A','B'].map(project=>({id:'viewer-'+project.toLowerCase(),label:project,tokenHash:hash('TEST_ONLY_'+project),hostIds:null,projectIds:[project]}))});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  for(const project of ['A','B'])for(const endpoint of ['/api/snapshot','/api/events?after=0']){const response=await fetch(origin+endpoint,{headers:{authorization:'Bearer TEST_ONLY_'+project}});assert.equal(response.status,200);const payload=await response.json();assert.deepEqual(payload.events.map(e=>e.label),[project+' evidence']);}
  const reopened=await FleetHub.open({directory,hosts}),retained=reopened.journal.latest({limit:10});assert.equal(retained.length,3);assert.ok(retained.some(e=>e.label==='Legacy evidence'&&!e.projectBasis));
 }finally{if(server)await new Promise(r=>server.close(r));await fs.rm(directory,{recursive:true,force:true});}
});
test('individual viewers are enforced at snapshot/history/document/diagnostic boundaries and keep separate display profiles',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-scoped-api-'));let server;
 try{const hosts=['allowed','denied'].map(id=>({id,tokenHash:hash(id)})),hub=await FleetHub.open({directory,hosts});
 for(const h of hosts)await hub.ingest(h.id,{hostId:h.id,batchId:h.id,observedAt:new Date().toISOString(),sessions:[{id:'session',project:h.id}],events:[{id:'event',sessionId:'session',sourceId:'source',at:new Date().toISOString(),kind:'turn',label:h.id}]});
 const local=async()=>({observedAt:new Date().toISOString(),host:{id:'hub',name:'Private hub'},coverage:{},sessions:[],events:[]});
 server=createServer({hub,readSnapshot:local,preferencesDirectory:path.join(directory,'profiles'),viewers:[{id:'alice',label:'Alice',tokenHash:hash('alice-key'),hostIds:['allowed']},{id:'bob',label:'Bob',tokenHash:hash('bob-key'),hostIds:[]}]});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`,headers={authorization:'Bearer alice-key'};
 assert.equal((await fetch(url+'/api/snapshot')).status,401);const s=await(await fetch(url+'/api/snapshot',{headers})).json();assert.deepEqual(s.hosts.map(h=>h.id),['allowed']);assert.equal(s.host,null);assert.deepEqual(s.events.map(e=>e.hostId),['allowed']);assert.equal(s.history.retainedEvents,1);assert.equal(s.capabilities.controls.execute,false);
 const page=await(await fetch(url+'/api/events?after=0',{headers})).json();assert.equal(page.events.length,1);assert.equal(page.events[0].hostId,'allowed');assert.equal(page.retainedEvents,1);
 assert.equal((await fetch(url+'/api/events?after=0&hostId=denied',{headers})).status,403);for(const endpoint of ['/api/documents/checkpoint','/api/diagnostics'])assert.equal((await fetch(url+endpoint,{headers})).status,403);
 let r=await fetch(url+'/api/preferences',{method:'PUT',headers:{...headers,'content-type':'application/json'},body:'{"fontSize":19}'});assert.equal(r.status,200);
 r=await fetch(url+'/api/preferences',{headers:{authorization:'Bearer bob-key'}});assert.equal((await r.json()).exists,false);
 r=await fetch(url+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'alice-key'})});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie').split(';')[0];assert.ok(cookie.includes('v1.'));assert.equal((await(await fetch(url+'/api/snapshot',{headers:{cookie}})).json()).viewer.id,'alice');
 const empty=await(await fetch(url+'/api/events?after=0',{headers:{authorization:'Bearer bob-key'}})).json();assert.equal(empty.events.length,0);assert.equal(empty.retainedEvents,0);
 }finally{if(server)await new Promise(r=>server.close(r));await fs.rm(directory,{recursive:true,force:true});}
});
test('a viewer credential can never share collector authority and individual proxy configuration is refused',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-scope-conflict-'));try{const hub=await FleetHub.open({directory,hosts:[{id:'source',tokenHash:hash('same-key')}]});for(const digest of [hash('same-key'),hash('same-key').toUpperCase()]){assert.throws(()=>createServer({hub,viewTokenHash:digest}),/separate/);assert.throws(()=>createServer({hub,viewers:[{id:'same',label:'Same',tokenHash:digest,hostIds:null}]}),/separate/);}for(const hostIds of [['source'],null])assert.throws(()=>createServer({upstream:{},viewers:[{id:'scope',label:'Scope',tokenHash:hash('key'),hostIds}]}),/authoritative hub/);}finally{await fs.rm(directory,{recursive:true,force:true});}
});
