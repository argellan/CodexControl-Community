// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const access=await import('../lib/viewer-access.mjs').catch(()=>({}));
const hash=token=>crypto.createHash('sha256').update(token).digest('hex');
const secret='fixture-only-signing-secret-32-bytes';
const viewers=[{id:'owner',label:'Owner',tokenHash:hash('owner-token'),hostIds:null},{id:'rack',label:'Rack observer',tokenHash:hash('rack-token'),hostIds:['rack-a']},{id:'none',label:'No sources',tokenHash:hash('none-token'),hostIds:[]}];
const make=extra=>new access.ViewerAccess({viewers,secret,...extra});
const snapshot=()=>({observedAt:'2026-10-20T12:00:00Z',mode:'read-only-fleet-observer',host:{id:'hub',name:'PRIVATE HUB',cpu:90,totalMemory:8000,freeMemory:1000,services:[{unit:'PRIVATE-SERVICE'}]},hosts:[{id:'hub',name:'PRIVATE HUB',status:'online',telemetry:{private:'PRIVATE HUB METRICS'}},{id:'rack-a',name:'Rack A',status:'online',telemetry:{cpu:4}},{id:'laptop',name:'PRIVATE LAPTOP',status:'online',telemetry:{cpu:30}}],sessions:[{id:'job',hostId:'rack-a',project:'Allowed',workerHostId:'laptop',workerSessionId:'PRIVATE-WORKER',workerCallId:'PRIVATE-CALL',events:[{id:'nested-allowed',hostId:'rack-a',sessionId:'job',workerHostId:'laptop',workerSessionId:'PRIVATE-WORKER'}]},{id:'PRIVATE-WORKER',hostId:'laptop',project:'PRIVATE PROJECT',tokens:{total_tokens:2000},usageLimits:[{primary:{usedPercent:50}}]}],events:[{id:'allowed',hostId:'rack-a',sessionId:'job',label:'Own target report',workerHostId:'laptop',workerSessionId:'PRIVATE-WORKER',workerCallId:'PRIVATE-CALL'},{id:'PRIVATE-EVENT',hostId:'laptop',sessionId:'PRIVATE-WORKER',workerHostId:'rack-a',label:'PRIVATE CONTENT'}],coverage:{loaded:99,discovered:300,failed:50,enrolledHosts:3,connectedHosts:3,durableJournal:true,completeHistory:false,liveRuntimeAttached:false},history:{schemaVersion:1,epoch:'journal-epoch',latestSequence:99,retentionFloor:5,gapThrough:5,retainedEvents:90,retainedBytes:500000,maxEvents:200000,maxBytes:900000,maxAgeMs:604800000,completeHistory:false},privateFutureField:{secret:'PRIVATE'}});

test('individual and legacy bearer authentication return only safe immutable viewer identities',()=>{
 assert.equal(typeof access.ViewerAccess,'function');
 const service=make({viewTokenHash:hash('shared-token')});
 assert.equal(service.requiredLogin,true);assert.equal(service.authenticateBearer('wrong'),null);assert.equal(service.authenticateBearer(''),null);assert.equal(service.authenticateBearer(null),null);
 const owner=service.authenticateBearer('owner-token');assert.deepEqual(owner.hostIds,null);assert.equal(owner.id,'owner');assert.match(owner.profileKey,/^[a-f0-9]{64}$/);assert.ok(Object.isFrozen(owner));
 const rack=service.authenticateBearer('rack-token');assert.ok(Object.isFrozen(rack.hostIds));assert.deepEqual(rack.hostIds,['rack-a']);
 const legacy=service.authenticateBearer('shared-token');assert.equal(legacy.id,'legacy');assert.equal(legacy.hostIds,null);
 assert.ok(!JSON.stringify(owner).includes('token'));assert.ok(!JSON.stringify(owner).includes('tokenHash'));
});

test('viewer configuration rejects ambiguous credentials, duplicate identities and invalid scopes',()=>{
 const rejected=[{viewers:[viewers[0],viewers[0]]},{viewers:[{...viewers[0],id:'../profile'}]},{viewers:[{...viewers[0],id:'local'}]},{viewers:[{...viewers[0],hostIds:undefined}]},{viewers:[{...viewers[0],hostIds:['rack-a','rack-a']}]},{viewers:[{...viewers[0],hostIds:['bad/path']}]},{viewers:[{...viewers[0],tokenHash:'not-a-hash'}]},{viewers:[{...viewers[0],admin:true}]},{viewers:[viewers[0],{...viewers[1],tokenHash:viewers[0].tokenHash}]},{viewTokenHash:'invalid'},{viewTokenHash:viewers[0].tokenHash},{secret:'short'}];
 for(const options of rejected)assert.throws(()=>make(options),/Invalid|Duplicate|Ambiguous|Unsupported/);
});

test('local bootstrap exists only without configured viewer credentials',()=>{
 const service=new access.ViewerAccess({secret});assert.equal(service.requiredLogin,false);assert.equal(service.localViewer.id,'local');assert.equal(service.localViewer.hostIds,null);
 const cookie=service.issueCookie(service.localViewer);assert.equal(service.authenticateCookie(cookie).id,'local');
 const configured=make();assert.throws(()=>configured.issueCookie(configured.localViewer),/bootstrap|viewer/i);
 assert.equal(configured.authenticateCookie(cookie),null);
});

test('signed cookies isolate viewers, reject tampering and expire after twelve hours',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-20T12:00:00Z')});
 const service=make(),owner=service.authenticateBearer('owner-token'),rack=service.authenticateBearer('rack-token');
 const first=service.issueCookie(owner),second=service.issueCookie(rack);
 assert.notEqual(first,service.issueCookie(owner));assert.notEqual(first,second);assert.ok(!first.includes('owner'));assert.ok(!first.includes('owner-token'));
 assert.equal(service.authenticateCookie(first).id,'owner');assert.equal(service.authenticateCookie(second).id,'rack');
 const parts=first.split('.');parts[1]=second.split('.')[1];assert.equal(service.authenticateCookie(parts.join('.')),null);
 assert.equal(service.authenticateCookie(first.slice(0,-1)+(first.at(-1)==='a'?'b':'a')),null);assert.equal(service.authenticateCookie('not-a-cookie'),null);assert.equal(service.authenticateCookie(first+'x'.repeat(1000)),null);
 t.mock.timers.tick(12*3600000-1);assert.equal(service.authenticateCookie(first).id,'owner');t.mock.timers.tick(1);assert.equal(service.authenticateCookie(first),null);
});

test('cookie issuance requires a canonical authenticated identity and credential/scope changes invalidate sessions',()=>{
 const service=make(),rack=service.authenticateBearer('rack-token');
 assert.throws(()=>service.issueCookie({...rack,hostIds:null}),/viewer/i);assert.throws(()=>service.issueCookie({id:'unknown',hostIds:null}),/viewer/i);
 const cookie=service.issueCookie(rack);
 assert.equal(make({secret:'different-fixture-secret-of-32-bytes'}).authenticateCookie(cookie),null);
 assert.equal(make({viewers:viewers.filter(v=>v.id!=='rack')}).authenticateCookie(cookie),null);
 assert.equal(make({viewers:viewers.map(v=>v.id==='rack'?{...v,tokenHash:hash('rotated-token')}:v)}).authenticateCookie(cookie),null);
 assert.equal(make({viewers:viewers.map(v=>v.id==='rack'?{...v,hostIds:['rack-b']}:v)}).authenticateCookie(cookie),null);
});

test('profile keys remain opaque and stable across server restart and token rotation, but isolate viewers',()=>{
 const service=make(),profile=service.authenticateBearer('rack-token').profileKey;
 assert.equal(make({secret:'different-fixture-secret-of-32-bytes'}).authenticateBearer('rack-token').profileKey,profile);
 assert.equal(make({viewers:viewers.map(v=>v.id==='rack'?{...v,tokenHash:hash('rotated-token')}:v)}).authenticateBearer('rotated-token').profileKey,profile);
 assert.notEqual(service.authenticateBearer('owner-token').profileKey,profile);assert.ok(!profile.includes('rack'));
});

test('scoped snapshots exclude unauthorized hosts and all their data, and redact cross-host worker references',()=>{
 const original=snapshot(),service=make(),viewer=service.authenticateBearer('rack-token');
 const result=access.filterSnapshot(original,viewer);
 assert.deepEqual(result.hosts.map(h=>h.id),['rack-a']);assert.deepEqual(result.sessions.map(s=>s.id),['job']);assert.deepEqual(result.events.map(e=>e.id),['allowed']);assert.equal(result.host,null);
 assert.equal(result.events[0].workerHostId,undefined);assert.equal(result.sessions[0].workerSessionId,undefined);assert.equal(result.sessions[0].events[0].workerSessionId,undefined);
 assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.equal(original.events[0].workerHostId,'laptop');assert.equal(original.hosts.length,3);
});

test('global inventory/history storage counts are removed from scoped views while recovery cursors remain qualified',()=>{
 const service=make(),result=access.filterSnapshot(snapshot(),service.authenticateBearer('rack-token'));
 assert.equal(result.coverage.enrolledHosts,1);assert.equal(result.coverage.connectedHosts,1);assert.equal(result.coverage.loaded,1);assert.equal(result.coverage.discovered,undefined);assert.equal(result.coverage.failed,undefined);
 assert.equal(result.history.retainedEvents,undefined);assert.equal(result.history.retainedBytes,undefined);assert.equal(result.history.maxEvents,undefined);assert.equal(result.history.latestSequence,99);assert.equal(result.history.epoch,'journal-epoch');assert.equal(result.history.scope,'authorized-hosts');
});

test('event projection authorizes the recording host alone and retains relationships only when both hosts are visible',()=>{
 const service=make(),viewer=service.authenticateBearer('rack-token'),data=snapshot();
 assert.equal(access.projectEvent(data.events[1],viewer),null);assert.equal(access.projectEvent({id:'missing-host'},viewer),null);
 assert.equal(access.projectEvent(data.events[0],viewer).workerHostId,undefined);
 assert.equal(access.projectEvent(data.events[0],service.authenticateBearer('owner-token')).workerSessionId,'PRIVATE-WORKER');
 const both=new access.ViewerAccess({viewers:[{id:'two',label:'Two hosts',tokenHash:hash('two'),hostIds:['rack-a','laptop']}],secret}).authenticateBearer('two');
 assert.equal(access.projectEvent(data.events[0],both).workerSessionId,'PRIVATE-WORKER');
});

test('empty or absent viewer scope fails closed, including legacy local snapshots without host inventory',()=>{
 const service=make();for(const viewer of [null,service.authenticateBearer('none-token')]){const filtered=access.filterSnapshot(snapshot(),viewer);assert.equal(filtered.hosts.length,0);assert.equal(filtered.sessions.length,0);assert.equal(filtered.events.length,0);assert.equal(filtered.host,null);}
 const data={host:{id:'rack-a',name:'Rack A',cpu:1},sessions:[{id:'one',hostId:'rack-a'}],events:[{id:'e',hostId:'rack-a',sessionId:'one'}],coverage:{loaded:1}};
 const visible=access.filterSnapshot(data,service.authenticateBearer('rack-token'));assert.equal(visible.host.id,'rack-a');assert.equal(visible.sessions.length,1);
});

test('read-only capabilities reflect authorized observations and expose no execution or account-management authority',()=>{
 const service=make(),viewer=service.authenticateBearer('rack-token'),capabilities=access.readOnlyCapabilities(viewer,snapshot());
 assert.equal(capabilities.readOnly,true);assert.equal(capabilities.observed.hostHealth,true);assert.equal(capabilities.observed.tokenCounters,false);assert.equal(capabilities.observed.quotaReadings,false);assert.equal(capabilities.observed.durableHistory,true);assert.equal(capabilities.observed.nativeRuntimeAttached,false);
 for(const value of Object.values(capabilities.controls))assert.equal(value,false);
 assert.equal(access.filterSnapshot(snapshot(),viewer).capabilities.readOnly,true);
});

test('unproven worker scopes and empty capability objects cannot expose identities or imply attached sources',()=>{
 const service=make(),viewer=service.authenticateBearer('rack-token');
 const projected=access.projectEvent({id:'e',hostId:'rack-a',workerSessionId:'PRIVATE-WORKER',workerCallId:'PRIVATE-CALL'},viewer);
 assert.equal(projected.workerSessionId,undefined);assert.equal(projected.workerCallId,undefined);
 const data=snapshot();data.coverage.liveRuntimeAttached=true;data.hosts[1].telemetry={};data.sessions[0].tokens={total_tokens:-1};data.sessions[0].usageLimits=[{}];
 const capabilities=access.readOnlyCapabilities(viewer,data);
 assert.equal(capabilities.observed.hostHealth,false);assert.equal(capabilities.observed.tokenCounters,false);assert.equal(capabilities.observed.quotaReadings,false);assert.equal(capabilities.observed.nativeRuntimeAttached,false);
});

test('noncanonical base64 cookie signatures are refused even when they decode to identical bytes',()=>{
 const service=make(),cookie=service.issueCookie(service.authenticateBearer('rack-token')),parts=cookie.split('.');
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',last=alphabet.indexOf(parts[4].at(-1)),alias=alphabet[last+1];
 parts[4]=parts[4].slice(0,-1)+alias;assert.equal(Buffer.from(parts[4],'base64url').toString('hex'),Buffer.from(cookie.split('.')[4],'base64url').toString('hex'));
 assert.equal(service.authenticateCookie(parts.join('.')),null);
});
