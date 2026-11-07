// Author: Bishop Crockett
// Owner: Argellan.com
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {Installation} from '../lib/installation.mjs';
import {FleetHub} from '../lib/fleet.mjs';
import {protectedRequest} from '../lib/installation-transport.mjs';
import {buildAccountUsageResponse} from '../lib/account-usage.mjs';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const local=()=>({observedAt:new Date().toISOString(),host:{id:'hub-local',name:'TEST_ONLY Hub'},sessions:[],events:[],coverage:{}});
const accountAt=at=>({version:1,source:'codex-app-server',status:'available',observedAt:at,lastAttemptAt:at,accountKey:'a'.repeat(64),planType:'pro',limitsObservedAt:at,usageObservedAt:at,limits:[],summary:{lifetimeTokens:1234,peakDailyTokens:100,longestRunningTurnSec:12,currentStreakDays:2,longestStreakDays:3},dailyUsageBuckets:[],errorCode:null});
const observation=(sequence=1)=>{const at=new Date(Date.now()-60000).toISOString();return {observedAt:at,host:{id:'node-one',name:'TEST_ONLY Node',platform:'win32'},sessions:[{id:'session-one',project:'TEST_ONLY',state:'Turn started',tokens:{total_tokens:1234},lastEventAt:at,usageObservedAt:at}],events:[{id:'event-'+sequence,sessionId:'session-one',sourceId:'TEST_ONLY-log',at,kind:'turn',label:'TEST_ONLY event',delivery:'live'}],coverage:{limit:128,allDatedFolders:true,identityVerified:true,configurationManaged:true,configurationRevision:2},accountUsage:accountAt(at)};};
function publish(fleet,peers){const prior=fleet.hosts.filter(host=>host.installationManaged).map(host=>({...host,disabled:true}));for(const peer of peers){if(peer.role!=='node')continue;const host={id:peer.hostId,label:peer.name,tokenHash:hash(peer.key),role:'codex-source',installationManaged:true,disabled:false},index=prior.findIndex(p=>p.id===host.id);if(index<0)prior.push(host);else prior[index]=host;}if(typeof fleet.setHosts==='function')fleet.setHosts(prior);else fleet.hosts=prior;}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ARGELLAN-TEST_ONLY-hydration-')),apps=[],releases=[];let fleet,clock=Date.now();
 const openFleet=async()=>{fleet=await FleetHub.open({directory:path.join(root,'journal')});releases.push(fleet.journal.retainConnection());return fleet;};
 const create=async role=>{const app=await Installation.open({directory:path.join(root,role),hostId:role==='hub'?'hub-local':'node-one',name:'TEST_ONLY '+role,legacyRole:role,network:{listen:'127.0.0.1',address:'127.0.0.1',discovery:false},now:()=>clock,...(role==='hub'?{onPeersChanged:peers=>publish(fleet,peers),ingest:(peer,payload,sha256)=>fleet.ingest(peer.key,payload,{wireSha256:sha256})}:{})});apps.push(app);return app;};
 t.after(async()=>{await Promise.all(apps.map(app=>app.close()));for(const release of releases)release();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'ARGELLAN-TEST_ONLY-hydration-'));await fs.rm(root,{recursive:true,force:true});});
 await openFleet();const hub=await create('hub'),node=await create('node'),invite=await hub.openPairing({revision:hub.state().revision});await node.joinPairing({revision:node.state().revision,address:invite.address,code:invite.code,expectedId:hub.state().id});await node.confirmPairing({revision:node.state().revision,id:invite.id});await hub.confirmPairing({revision:hub.state().revision,id:invite.id});
 return {hub,node,get fleet(){return fleet;},openFleet,create,tick:ms=>clock+=ms};
}
const accountProjection=(fleet,snapshot,now)=>buildAccountUsageResponse({sources:fleet.hosts.filter(h=>!h.disabled&&(!h.expiresAt||Date.parse(h.expiresAt)>now)).flatMap(h=>{const state=fleet.states.get(h.id);return state?.accountUsage?[{hostId:h.id,accountUsage:state.accountUsage}]:[];}),snapshot,viewer:{role:'admin',hostIds:null,projectIds:null},now});

test('paired Hub startup restores exact offline session, coverage, receipt and account projection after trust loads; rename and revoke preserve history',async t=>{
 const f=await fixture(t);await f.node.capture(observation());assert.equal((await f.node.flush()).sent,1);
 const original=structuredClone(f.fleet.states.get('node-one')),events=f.fleet.journal.latest(),now=original.receivedAt+180000;
 const before=accountProjection(f.fleet,f.fleet.snapshot(local(),now),now);await f.node.close();await f.hub.close();f.tick(180000);
 const restarted=await f.openFleet();assert.equal(restarted.hosts.length,0);assert.equal(restarted.states.size,0);assert.deepEqual(restarted.journal.state('node-one'),original);
 const hub=await f.create('hub');assert.ok(restarted.states.has('node-one'),'persisted verified Node projection must load before any new Node traffic');assert.deepEqual(restarted.states.get('node-one'),original);
 const snapshot=restarted.snapshot(local(),now),remote=snapshot.hosts.find(h=>h.id==='node-one');assert.equal(remote.receivedAt,new Date(original.receivedAt).toISOString());assert.equal(remote.sourceObservedAt,original.observedAt);assert.equal(remote.status,'disconnected');assert.equal(hub.state().peers[0].status,'offline');assert.deepEqual(remote.coverage,original.coverage);assert.deepEqual(snapshot.sessions,original.sessions);assert.deepEqual(snapshot.events,events);
 const restored=accountProjection(restarted,snapshot,now);assert.deepEqual(restored,before);assert.equal(restored.accountUsage.status,'stale');assert.equal(restored.activeUsage.sessions,0);assert.equal(restored.activeUsage.status,'idle');
 await hub.rename({revision:hub.state().revision,peerId:hub.state().peers[0].id,name:'TEST_ONLY renamed Ω Node'});const renamed=restarted.snapshot(local(),now);assert.equal(renamed.hosts.find(h=>h.id==='node-one').name,'TEST_ONLY renamed Ω Node');assert.equal(renamed.sessions[0].hostName,'TEST_ONLY renamed Ω Node');assert.equal(renamed.sessions[0].hostId,'node-one');assert.deepEqual(restarted.journal.state('node-one'),original);assert.deepEqual(restarted.journal.latest(),events);
 await hub.revoke({revision:hub.state().revision,peerId:hub.state().peers[0].id});assert.equal(restarted.snapshot(local(),now).sessions.length,0);assert.equal(restarted.snapshot(local(),now).hosts.find(h=>h.id==='node-one').status,'disabled');assert.equal(accountProjection(restarted,restarted.snapshot(local(),now),now).accountUsage.accountCount,0);assert.deepEqual(restarted.journal.state('node-one'),original);assert.deepEqual(restarted.journal.latest(),events);
});

test('offline paired restart then exact pending replay does not duplicate history or refresh original receipt; fresh reconnect records remain distinct',async t=>{
 const f=await fixture(t);await f.node.capture(observation());assert.equal((await f.node.flush({request:async(address,options)=>{await protectedRequest(address,options);throw Error('TEST_ONLY lost ACK');}})).sent,0);assert.equal(f.node.state().queue.pendingRecords,1);
 const original=structuredClone(f.fleet.states.get('node-one')),events=f.fleet.journal.latest();await f.node.close();await f.hub.close();const restarted=await f.openFleet(),hub=await f.create('hub');assert.deepEqual(restarted.states.get('node-one'),original);
 f.tick(65000);const node=await f.create('node');await node.updateAddress({revision:node.state().revision,peerId:hub.state().id,address:hub.address});assert.equal((await node.flush()).sent,1);assert.equal(node.state().queue.pendingRecords,0);assert.deepEqual(restarted.journal.latest(),events);assert.equal(restarted.states.get('node-one').receivedAt,original.receivedAt);
 await node.capture(observation(2));assert.equal((await node.flush()).sent,1);assert.equal(restarted.journal.latest().length,2);assert.equal(new Set(restarted.journal.latest().map(e=>e.id)).size,2);assert.equal(restarted.snapshot(local()).sessions.length,1);
});

test('host replacement validates atomically, reads only active managed additions and keeps retained journal state on disabled/expired removal',async t=>{
 const f=await fixture(t);await f.node.capture(observation());assert.equal((await f.node.flush()).sent,1);const fleet=f.fleet,hosts=fleet.hosts,states=fleet.states,original=structuredClone(states.get('node-one')),events=fleet.journal.latest(),read=fleet.journal.state.bind(fleet.journal),reads=[];fleet.journal.state=id=>{reads.push(id);return read(id);};
 const host=hosts[0];for(const invalid of [[{...host,id:'../escape'}],[{...host,tokenHash:'wrong'}],[host,host],Array.from({length:65},(_,i)=>({...host,id:'host-'+i})),null]){assert.throws(()=>fleet.setHosts(invalid),/Invalid enrollment|Duplicate host/);assert.strictEqual(fleet.hosts,hosts);assert.strictEqual(fleet.states,states);assert.equal(reads.length,0);}
 fleet.setHosts([...hosts,{...host,id:'legacy-addition',installationManaged:false},{...host,id:'disabled-addition',disabled:true}]);assert.deepEqual(reads,[]);
 const publishedHosts=fleet.hosts,publishedStates=fleet.states;fleet.journal.state=id=>{if(id==='unreadable')throw Error('TEST_ONLY unavailable journal');return read(id);};assert.throws(()=>fleet.setHosts([...publishedHosts,{...host,id:'unreadable'}]),/unavailable journal/);assert.strictEqual(fleet.hosts,publishedHosts);assert.strictEqual(fleet.states,publishedStates);fleet.journal.state=read;
 fleet.setHosts([{...host,disabled:true}]);assert.equal(fleet.states.has(host.id),false);assert.equal(fleet.snapshot(local()).sessions.length,0);fleet.setHosts([host]);assert.deepEqual(fleet.states.get(host.id),original);
 fleet.setHosts([{...host,expiresAt:new Date(Date.now()-1000).toISOString()}]);assert.equal(fleet.states.has(host.id),false);assert.equal(fleet.snapshot(local()).sessions.length,0);fleet.setHosts([host]);assert.deepEqual(fleet.states.get(host.id),original);
 fleet.setHosts([]);assert.equal(fleet.states.size,0);assert.equal(fleet.snapshot(local()).sessions.length,0);assert.deepEqual(read(host.id),original);assert.deepEqual(fleet.journal.latest(),events);
});