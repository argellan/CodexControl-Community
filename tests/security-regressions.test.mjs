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
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {FleetHub} from '../lib/fleet.mjs';
import {ViewerAccess} from '../lib/viewer-access.mjs';
import {PasswordRateLimiter} from '../lib/password-auth.mjs';
import {PersonalPreferences} from '../lib/personal-preferences.mjs';
import {createServer} from '../server.mjs';
import {ActivityMap} from '../public/topology-view.mjs';
import {projectActivity} from '../public/activity-map-model.mjs';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const host={id:'source',tokenHash:hash('collector-fixture')};
const batch=()=>({hostId:'source',batchId:'batch',observedAt:new Date().toISOString(),sessions:[{id:'worker',project:'Example'}],events:[{id:'event',sessionId:'worker',sourceId:'log',at:new Date().toISOString(),kind:'turn'}]});
async function fixture(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cc-correction-'));const hub=await FleetHub.open({directory:dir,hosts:[host]});try{await fn(hub,dir);}finally{await fs.rm(dir,{recursive:true,force:true});}}

test('collector rejects duplicate session snapshots and wrong relationship types without changing good state',()=>fixture(async hub=>{
 await hub.ingest('collector-fixture',batch());const before=JSON.stringify(hub.states.get('source'));
 for(const sessions of [[{id:'same'},{id:'same'}],[{id:'\u0000same'},{id:'same'}],[{id:'\u0000'}],[{id:'worker',parentId:123}],[{id:'worker',agentPath:true}],[{id:'worker',nickname:22}]])await assert.rejects(hub.ingest('collector-fixture',{...batch(),sessions}),e=>e.status===400);
 assert.equal(JSON.stringify(hub.states.get('source')),before);
}));

test('collector progress is numeric and source identity is bounded before persistence',()=>fixture(async hub=>{
 for(const patch of [{progress:'<form>forged</form>'},{progress:101},{progress:-1},{sourceId:'x'.repeat(300)}])await assert.rejects(hub.ingest('collector-fixture',{...batch(),events:[{...batch().events[0],...patch}]}),e=>e.status===400);
 for(const progress of [0,50.5,100,null])await hub.ingest('collector-fixture',{...batch(),events:[{...batch().events[0],id:'progress-'+progress,progress}]});
 assert.equal(hub.journal.latest().length,4);
}));

test('fleet uses the byte-bounded durable journal without a second retained event cache',()=>fixture(async(hub,dir)=>{
 await hub.ingest('collector-fixture',batch());assert.equal(Object.hasOwn(hub.states.get('source'),'events'),false);
 const reopened=await FleetHub.open({directory:dir,hosts:[host]});assert.equal(Object.hasOwn(reopened.states.get('source'),'events'),false);assert.equal(reopened.journal.latest().length,1);assert.equal((await reopened.ingest('collector-fixture',batch())).added,0);
}));

test('malformed retained worker graphs terminate and preserve host-scoped distinct workers',async()=>{
 const moduleURL=new URL('../public/ui-model.mjs',import.meta.url).href,program=`const {workerGroups}=await import(${JSON.stringify(moduleURL)}); const sessions=[]; for(let i=0;i<32;i++)for(let j=0;j<3;j++)sessions.push({id:'n'+i,parentId:i?'n'+(i-1):null,project:'A',hostId:'H',agentPath:4}); sessions.push({id:'n0',hostId:'other',project:'A'},{id:'cycleA',parentId:'cycleB',hostId:'H',project:'A'},{id:'cycleB',parentId:'cycleA',hostId:'H',project:'A'}); const groups=workerGroups(sessions,[],[],Date.now()); if(groups.flatMap(g=>g.rows).length!==35)process.exit(2); console.log('bounded');`;
 const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',program],{cwd:process.cwd(),timeout:3000,maxBuffer:1024});assert.match(result.stdout,/bounded/);
});

test('retained job progress cannot create markup in the evidence inspector',()=>{
 const reference=Date.now(),sessions=[{id:'worker',hostId:'source',project:'Example'}],hosts=[{id:'source',name:'Source',status:'online'}];
 const records=['remote.start','remote.progress','remote.end'].map((kind,i)=>({id:'job-'+i,hostId:'source',sessionId:'job',sourceId:'feed',workerHostId:'source',workerSessionId:'worker',jobId:'job',kind,project:'Example',at:new Date(reference-3000+i*1000).toISOString(),progress:i===1?'<form action="https://example.invalid">forged</form>':i*50,label:'Observed job'}));
 const graph=projectActivity({hosts,sessions,events:records,reference,windowMs:60000});const jobs=graph.journeys.filter(j=>j.kind==='job');assert.ok(jobs.length);
 const output=ActivityMap.prototype.details.call({graph},jobs);assert.doesNotMatch(output,/<form|action=/);assert.match(output,/Observed job/);
});

test('logout revokes only its copied cookie and revocation survives access policy rebuild',()=>{
 const sessions=new Map(),options={secret:'fixture-signing-secret-at-least-32-bytes',sessions,viewers:[{id:'owner',label:'Owner',tokenHash:hash('viewer-fixture'),hostIds:null}]};
 let access=new ViewerAccess(options);const viewer=access.authenticateBearer('viewer-fixture'),first=access.issueCookie(viewer),other=access.issueCookie(viewer);assert.equal(access.revokeCookie(first),true);assert.equal(access.authenticateCookie(first),null);assert.equal(access.authenticateCookie(other).id,'owner');access=new ViewerAccess(options);assert.equal(access.authenticateCookie(first),null);assert.equal(access.authenticateCookie(other).id,'owner');
});

test('shared proxy login source throttle expires quickly without locking unrelated accounts for minutes',()=>{
 let now=0;const limiter=new PasswordRateLimiter({now:()=>now});for(let i=0;i<24;i++)limiter.consume('proxy','bad-'+i);assert.throws(()=>limiter.consume('proxy','legitimate'),e=>e.status===429&&e.retryAfter<=1);now=1001;assert.doesNotThrow(()=>limiter.consume('proxy','legitimate'));
});

test('personal profile admission bounds pending reads and writes and preserves valid saves',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cc-profile-budget-'));try{const p=new PersonalPreferences(dir,'viewer');const writes=await Promise.allSettled(Array.from({length:60},(_,i)=>p.write({fontSize:12+i%9})));assert.ok(writes.filter(r=>r.status==='fulfilled').length<=4);assert.ok(writes.some(r=>r.status==='rejected'&&r.reason.status===429));assert.ok((await p.read()).revision>0);await assert.rejects(p.write({fontSize:'bad'}),e=>e.status===400);}finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('collector HTTP rejects credentials before an unfinished body and caps authorized uploads',()=>fixture(async hub=>{
 for(let i=1;i<=4;i++)hub.hosts.push({id:'source-'+i,tokenHash:hash('collector-fixture-'+i)});
 const server=createServer({hub,readSnapshot:async()=>({host:{},sessions:[],events:[],coverage:{}})});await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port,opened=[];
 const unfinished=(token)=>new Promise((resolve,reject)=>{const request=http.request({hostname:'127.0.0.1',port,path:'/api/collector',method:'POST',headers:{'content-type':'application/json','content-length':2097152,...(token?{authorization:'Bearer '+token}:{})}},response=>{response.resume();resolve({status:response.statusCode,request});});request.on('error',reject);request.flushHeaders();request.write('{');opened.push(request);});
 try{const denied=await Promise.race([unfinished(null),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Authentication waited for body')),700).unref())]);assert.equal(denied.status,401);
  const active=Array.from({length:4},(_,i)=>unfinished(i?'collector-fixture-'+i:'collector-fixture'));await new Promise(r=>setTimeout(r,70));const full=await unfinished('collector-fixture-4');assert.equal(full.status,429);for(const request of opened)request.destroy();await Promise.allSettled(active);await new Promise(r=>setTimeout(r,40));
  const result=await fetch(`http://127.0.0.1:${port}/api/collector`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer collector-fixture'},body:JSON.stringify(batch())});assert.equal(result.status,200);
 }finally{for(const request of opened)request.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));}
}));


test('HTTP logout rejects replay of a copied cookie while another session remains authenticated',async()=>{
 const server=createServer({viewTokenHash:hash('viewer-fixture'),readSnapshot:async()=>({observedAt:new Date().toISOString(),host:{id:'local'},sessions:[],events:[],coverage:{}})});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const login=async()=>{const r=await fetch(origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'viewer-fixture'})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
 try{const cookie=await login(),other=await login();const logout=await fetch(origin+'/api/session/logout',{method:'POST',headers:{cookie}});assert.equal(logout.status,200);assert.equal((await fetch(origin+'/api/snapshot',{headers:{cookie}})).status,401);assert.equal((await fetch(origin+'/api/snapshot',{headers:{cookie:other}})).status,200);assert.match(logout.headers.get('content-security-policy'),/form-action 'self'/);}finally{await new Promise(r=>server.close(r));}
});

test('profile limits apply globally across identities and release after both success and failure',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cc-profile-global-'));try{const profiles=Array.from({length:40},(_,i)=>new PersonalPreferences(dir,'viewer-'+i));const results=await Promise.allSettled(profiles.map(p=>p.write({fontSize:18})));assert.equal(results.filter(r=>r.status==='fulfilled').length,32);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===429).length,8);assert.equal((await profiles[39].write({fontSize:16})).preferences.fontSize,16);await assert.rejects(profiles[0].write({fontSize:16},{revision:0}),e=>e.status===409);assert.equal((await profiles[0].read()).preferences.fontSize,18);}finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('collector permit remains reserved while parsed work waits for durable commit',()=>fixture(async hub=>{
 for(let i=1;i<=4;i++)hub.hosts.push({id:'source-'+i,tokenHash:hash('collector-fixture-'+i)});
 let release;const gate=new Promise(r=>release=r),original=hub.ingest.bind(hub);hub.ingest=async(...args)=>{await gate;return original(...args);};const server=createServer({hub,readSnapshot:async()=>({host:{id:"fixture"},observedAt:new Date().toISOString(),sessions:[],events:[],coverage:{}})});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;const send=i=>fetch(origin+'/api/collector',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+(i?'collector-fixture-'+i:'collector-fixture')},body:JSON.stringify({...batch(),hostId:i?'source-'+i:'source',batchId:'batch-'+i})});
 try{const active=Array.from({length:4},(_,i)=>send(i));await new Promise(r=>setTimeout(r,70));assert.equal((await send(4)).status,429);assert.equal((await send(0)).status,429);release();for(const result of await Promise.all(active))assert.equal(result.status,200);assert.equal((await send(4)).status,200);}finally{release();server.closeAllConnections();await new Promise(r=>server.close(r));}
}));

test('one unfinished collector cannot reserve another source admission slot',()=>fixture(async hub=>{
 hub.hosts.push({id:'source-other',tokenHash:hash('TEST_ONLY_other_collector')});
 const server=createServer({hub,readSnapshot:async()=>({host:{id:'fixture'},sessions:[],events:[],coverage:{}})});await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port,origin=`http://127.0.0.1:${port}`;
 let admitted;const seen=new Promise(r=>admitted=r);server.on('request',req=>{if(req.headers['x-test-only-partial']==='yes')admitted();});
 const partial=http.request({hostname:'127.0.0.1',port,path:'/api/collector',method:'POST',headers:{authorization:'Bearer collector-fixture','content-type':'application/json','content-length':2097152,'x-test-only-partial':'yes'}},res=>res.resume());partial.on('error',()=>{});partial.write('{');
 try{await seen;const submit=(token,hostId)=>fetch(origin+'/api/collector',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({...batch(),hostId})});assert.equal((await submit('collector-fixture','source')).status,429);assert.equal((await submit('TEST_ONLY_other_collector','source-other')).status,200);assert.equal(hub.journal.latest().filter(e=>e.hostId==='source-other').length,1);}
 finally{partial.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));}
}));


test('bounded preference admission preserves partial selection of an already saved named layout',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cc-layout-partial-'));try{const p=new PersonalPreferences(dir,'viewer'),now=new Date().toISOString();await p.write({fontSize:19,layouts:[{id:'existing',name:'Existing',createdAt:now,updatedAt:now,preferences:{fontSize:19}}]});const selected=await p.write({activeLayoutId:'existing'},{revision:1});assert.equal(selected.preferences.activeLayoutId,'existing');assert.equal(selected.preferences.fontSize,19);await assert.rejects(p.write({activeLayoutId:'missing'},{revision:2}),e=>e.status===400);}finally{await fs.rm(dir,{recursive:true,force:true});}
});


test('collector event text and identity types are checked before committing',()=>fixture(async hub=>{
 await hub.ingest('collector-fixture',batch());const before=hub.journal.status().latestSequence;
 for(const patch of [{label:123},{label:false},{label:{}},{callId:42},{category:true},{sourceId:'bad\ud800'},{sessionId:'bad\udfff'},{offset:'10'},{exitCode:'0'}])await assert.rejects(hub.ingest('collector-fixture',{...batch(),events:[{...batch().events[0],...patch}]}),e=>e.status===400);
 assert.equal(hub.journal.status().latestSequence,before);
 for(const label of [null,undefined,'Observed activity'])await hub.ingest('collector-fixture',{...batch(),events:[{...batch().events[0],id:'nullable-'+String(label),label}]});
 assert.ok(hub.journal.latest().every(e=>typeof e.label==='string'));
}));

test('retained malformed event text cannot interrupt map, ribbon or alert projections',async()=>{
 const {EventStore}=await import('../public/event-model.mjs'),{operationalAlerts}=await import('../public/operational-alerts.mjs'),now=Date.now(),at=new Date(now).toISOString(),store=new EventStore();
 const events=[{id:'legacy-number',sessionId:'worker',hostId:'source',sourceId:'bad\ud800',at,kind:'tool.start',label:17,callId:9},{id:'legacy-null',sessionId:'worker',hostId:'source',at,kind:'operation',label:null},{id:'legacy-proto',sessionId:'worker',hostId:'source',at,kind:{}}];
 const hosts=[{id:'source',status:'online',receivedAt:at,sourceObservedAt:at}],sessions=[{id:'worker',hostId:'source',project:'Example'}];store.ingest({observedAt:at,events,hosts,sessions});
 assert.equal(store.viewEvents().length,2);assert.ok(store.viewEvents().every(e=>typeof e.label==='string'&&typeof e.kind==='string'&&(!e.callId||typeof e.callId==='string')));
 assert.doesNotThrow(()=>projectActivity({events:store.viewEvents(),hosts,sessions,reference:now}));assert.doesNotThrow(()=>operationalAlerts({events:store.viewEvents(),hosts,sessions,now}));
 // Historical page replay must apply the same legacy-data boundary.
 store.enterHistoryReplay(events);assert.equal(store.viewEvents().length,2);assert.doesNotThrow(()=>operationalAlerts({events:store.viewEvents(),hosts,sessions,now}));
 assert.doesNotThrow(()=>operationalAlerts({events:[{...events[0],callId:'call'}],hosts,sessions,now}));
});


test('legacy projection preserves a valid source instant and meaningful labels after normalization',async()=>{
 const {EventStore,eventTime}=await import('../public/event-model.mjs'),store=new EventStore(),at=' '.repeat(600)+'2026-10-20',instant=Date.parse(at),events=[{id:'old-time',hostId:'source',sessionId:'not-in-inventory',kind:'turn',at,label:'\u0000'},{id:'empty-label',hostId:'source',sessionId:'not-in-inventory',kind:'message',at:new Date(instant).toISOString(),label:''}];
 store.ingest({observedAt:new Date(instant).toISOString(),sessions:[],hosts:[],events});assert.equal(store.viewEvents().length,2);assert.ok(store.viewEvents().every(e=>eventTime(e)===instant&&e.label.length>0));store.enterHistoryReplay(events);assert.ok(store.bounds.every(Number.isFinite));assert.equal(store.clock,instant);
});
