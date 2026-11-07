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
import {ViewerAccess,filterSnapshot,projectEvent} from '../lib/viewer-access.mjs';
import {FleetHub} from '../lib/fleet.mjs';
import {createServer} from './fixture-server.mjs';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const configuration=(extra={})=>({id:'example-viewer',label:'Example viewer',tokenHash:hash('fixture-viewer-key'),hostIds:['allowed-host'],projectIds:['Allowed project'],...extra});
const viewer=extra=>new ViewerAccess({viewers:[configuration(extra)]}).authenticateBearer('fixture-viewer-key');
const timestamp=new Date().toISOString();
const sourceEvent=(id,extra={})=>({id,hostId:'allowed-host',sourceId:'native',sessionId:'visible-parent',project:'Allowed project',projectBasis:'source-context',at:timestamp,kind:'turn',label:'Recorded activity',...extra});

test('project restriction intersects host scope and keeps only authorized project workers and events',()=>{
 const snapshot={hosts:[{id:'allowed-host'},{id:'denied-host'}],host:{id:'hub'},coverage:{loaded:999},sessions:[{id:'visible-parent',hostId:'allowed-host',project:'Allowed project'},{id:'hidden-project',hostId:'allowed-host',project:'Denied project'},{id:'hidden-host',hostId:'denied-host',project:'Allowed project'},{id:'unlabelled',hostId:'allowed-host'}],events:[sourceEvent('visible'),sourceEvent('hidden-project',{project:'Denied project'}),sourceEvent('hidden-host',{hostId:'denied-host'}),sourceEvent('unlabelled',{project:undefined})]};
 const before=structuredClone(snapshot),result=filterSnapshot(snapshot,viewer());assert.deepEqual(result.hosts.map(h=>h.id),['allowed-host']);assert.deepEqual(result.sessions.map(s=>s.id),['visible-parent']);assert.deepEqual(result.events.map(e=>e.id),['visible']);assert.equal(result.host,null);assert.equal(result.coverage.loaded,1);assert.deepEqual(snapshot,before);
 const empty=filterSnapshot(snapshot,viewer({projectIds:[]}));assert.deepEqual(empty.sessions,[]);assert.deepEqual(empty.events,[]);
 const projectsOnly=filterSnapshot(snapshot,viewer({hostIds:null}));assert.deepEqual(projectsOnly.sessions.map(s=>s.id),['visible-parent','hidden-host']);
});

test('restricted snapshots retain proven same-project parents and remove hidden genealogy and worker references',()=>{
 const sessions=[{id:'visible-parent',hostId:'allowed-host',project:'Allowed project',parentId:'hidden-parent',forkedFrom:'hidden-fork',workerHostId:'denied-host',workerSessionId:'hidden-worker',workerCallId:'hidden-call'},{id:'visible-child',hostId:'allowed-host',project:'Allowed project',parentId:'visible-parent'},{id:'hidden-parent',hostId:'allowed-host',project:'Denied project'},{id:'hidden-fork',hostId:'allowed-host',project:'Denied project'}];
 const events=[sourceEvent('branch',{childId:'hidden-child',workerHostId:'denied-host',workerSessionId:'hidden-worker',workerCallId:'hidden-call'})];
 const result=filterSnapshot({sessions,events,hosts:[{id:'allowed-host'}]},viewer()),parent=result.sessions.find(s=>s.id==='visible-parent');
 for(const key of ['parentId','forkedFrom','workerHostId','workerSessionId','workerCallId'])assert.equal(Object.hasOwn(parent,key),false,key);
 assert.equal(result.sessions.find(s=>s.id==='visible-child').parentId,'visible-parent');
 for(const key of ['childId','workerHostId','workerSessionId','workerCallId'])assert.equal(Object.hasOwn(result.events[0],key),false,key);
 assert.equal(JSON.stringify(result).includes('hidden-'),false);
 const nested=filterSnapshot({sessions:[{...sessions[0],events:[events[0],sourceEvent('nested-denied',{project:'Denied project'})]}],events:[],hosts:[]},viewer());assert.equal(nested.sessions[0].events.length,1);assert.equal(Object.hasOwn(nested.sessions[0].events[0],'childId'),false);
});

test('event projection fails closed for unlabelled and denied projects and strips unproven historical relationships',()=>{
 const identity=viewer();assert.equal(projectEvent(sourceEvent('denied',{project:'Denied project'}),identity),null);assert.equal(projectEvent(sourceEvent('unlabelled',{project:undefined}),identity),null);
 const projected=projectEvent(sourceEvent('allowed',{childId:'unproven-child',workerHostId:'allowed-host',workerSessionId:'unproven-worker',workerCallId:'unproven-call'}),identity);assert.equal(projected.id,'allowed');for(const field of ['childId','workerHostId','workerSessionId','workerCallId'])assert.equal(Object.hasOwn(projected,field),false);
});

test('individual identity expiry rejects both bearer and previously valid cookies before cookie lifetime ends',t=>{
 let clock=Date.parse('2030-01-01T00:00:00Z');t.mock.method(Date,'now',()=>clock);
 const access=new ViewerAccess({viewers:[configuration({expiresAt:new Date(clock+1000).toISOString()})]}),identity=access.authenticateBearer('fixture-viewer-key'),cookie=access.issueCookie(identity);assert.ok(access.authenticateCookie(cookie));clock+=1001;assert.equal(access.authenticateBearer('fixture-viewer-key'),null);assert.equal(access.authenticateCookie(cookie),null);
 const disabled=new ViewerAccess({viewers:[configuration({disabled:true,expiresAt:null})]});assert.equal(disabled.authenticateBearer('fixture-viewer-key'),null);
});

test('administrators require unrestricted host and project scope and invalid project grants are refused',()=>{
 for(const scopes of [{hostIds:[],projectIds:null},{hostIds:['allowed-host'],projectIds:null},{hostIds:null,projectIds:[]},{hostIds:null,projectIds:['Allowed project']}])assert.throws(()=>new ViewerAccess({viewers:[configuration({...scopes,role:'admin'})]}),/scope/i);
 const admin=new ViewerAccess({viewers:[configuration({hostIds:null,projectIds:null,role:'admin'})]}).authenticateBearer('fixture-viewer-key');assert.equal(admin.role,'admin');assert.equal(admin.hostIds,null);assert.equal(admin.projectIds,null);
 for(const projectIds of [['Allowed project','Allowed project'],[''],['bad\nproject'],[1],{},Array.from({length:65},(_,i)=>'Project '+i)])assert.throws(()=>new ViewerAccess({viewers:[configuration({projectIds})]}),/project scope/i);
});

test('actual snapshot and forward/backward history enforce host/project intersection with scoped counts and denied-project403',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-project-scope-'));let server;
 try{
  const hosts=['allowed-host','denied-host'].map(id=>({id,label:'Example source',tokenHash:hash('fixture-source-'+id)})),hub=await FleetHub.open({directory,hosts});
  const at=new Date(Date.now()-2000).toISOString();
  for(const host of hosts){const sessions=[{id:'visible-parent',project:'Allowed project',parentId:'hidden-parent',forkedFrom:'hidden-fork',workerHostId:'denied-host',workerCallId:'hidden-call'},{id:'visible-child',project:'Allowed project',parentId:'visible-parent'},{id:'hidden-parent',project:'Denied project'},{id:'unlabelled'}];
   const events=[sourceEvent('allowed-parent',{at,childId:'hidden-child',workerHostId:'denied-host',workerSessionId:'hidden-worker',workerCallId:'hidden-call'}),sourceEvent('allowed-child',{at,sessionId:'visible-child'}),sourceEvent('denied-project',{at,project:'Denied project'}),sourceEvent('unlabelled',{at,project:undefined}),sourceEvent('legacy-unqualified',{at,projectBasis:undefined})];
   await hub.ingest('fixture-source-'+host.id,{hostId:host.id,batchId:host.id,observedAt:at,sessions,events});
  }
  const readSnapshot=async()=>({observedAt:new Date().toISOString(),host:{id:'hub',name:'Example hub'},coverage:{},sessions:[],events:[]});
  server=createServer({hub,readSnapshot,preferencesDirectory:path.join(directory,'profiles'),viewers:[configuration(),configuration({id:'empty-viewer',tokenHash:hash('fixture-empty-key'),projectIds:[]})]});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port,headers={authorization:'Bearer fixture-viewer-key'};
  const response=await fetch(origin+'/api/snapshot',{headers});assert.equal(response.status,200);const snapshot=await response.json();assert.deepEqual(snapshot.sessions.map(s=>s.id).sort(),['visible-child','visible-parent']);assert.equal(snapshot.events.length,2);assert.equal(snapshot.history.retainedEvents,2);assert.equal(snapshot.viewer.scope,'authorized-sources');
  const parent=snapshot.sessions.find(s=>s.id==='visible-parent');assert.equal(Object.hasOwn(parent,'parentId'),false);assert.equal(Object.hasOwn(parent,'forkedFrom'),false);assert.equal(snapshot.sessions.find(s=>s.id==='visible-child').parentId,'visible-parent');
  const scopedStatus=hub.journal.status(['allowed-host'],['Allowed project']);assert.equal(scopedStatus.retainedEvents,2);assert.equal(scopedStatus.latestSequence,2);assert.equal(scopedStatus.retentionFloor,0);assert.equal(scopedStatus.gapThrough,0);assert.equal(hub.journal.status().retainedEvents,10);assert.equal(hub.journal.status(['allowed-host']).retainedEvents,5);assert.equal(hub.journal.latest({hostIds:['allowed-host'],projectIds:['Allowed project']}).length,2);
  for(const route of ['/api/events?after=0','/api/history?before='+encodeURIComponent(new Date(Date.now()+1000).toISOString())]){const result=await fetch(origin+route,{headers});assert.equal(result.status,200);const page=await result.json();assert.equal(page.events.length,2);assert.equal(page.retainedEvents,2);assert.ok(page.events.every(e=>e.hostId==='allowed-host'&&e.project==='Allowed project'));for(const e of page.events)for(const field of ['childId','workerHostId','workerSessionId','workerCallId'])assert.equal(Object.hasOwn(e,field),false);}
  for(const endpoint of ['/api/events?after=0&project=Denied%20project','/api/history?project=Denied%20project','/api/events?after=0&hostId=denied-host'])assert.equal((await fetch(origin+endpoint,{headers})).status,403);
  const empty=await(await fetch(origin+'/api/events?after=0',{headers:{authorization:'Bearer fixture-empty-key'}})).json();assert.deepEqual(empty.events,[]);assert.equal(empty.retainedEvents,0);assert.equal(empty.latestSequence,0);assert.equal(empty.nextCursor,0);
  const exact=await(await fetch(origin+'/api/events?after=0&project=Allowed%20project',{headers})).json();assert.equal(exact.events.length,2);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});}
});
