// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Installation} from '../lib/installation.mjs';
import {FleetHub} from '../lib/fleet.mjs';
import {normalizeProcessSamples} from '../lib/process-history.mjs';

const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const local=hostId=>({observedAt:new Date().toISOString(),host:{id:hostId,name:'TEST_ONLY',platform:'win32'},sessions:[],events:[],coverage:{synthetic:true}});
const sample=hostId=>({epoch:'11111111-1111-4111-8111-111111111111',snapshot:{schemaVersion:1,sourceKind:'local-os',hostId,bootId:'TEST_ONLY_boot',sequence:1,observedAt:new Date().toISOString(),collection:{status:'ok',complete:true,scope:'TEST_ONLY'},processes:[{pid:42,createdAt:'2026-01-01T00:00:00Z',executable:'node.exe',role:'Node.js runtime',family:'Codex',metricStatus:'ok',privateCommitBytes:12345}]}});
const count=(fleet,host)=>fleet.journal.processRead({hostIds:null,projectIds:null},new URLSearchParams('host='+host+'&mode=history'),[host]).retained.n;

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ARGELLAN-TEST_ONLY-process-installation-'));
 const apps=[],fleets=[];let clock=Date.now();
 const create=async(role,hostId,extra={})=>{const app=await Installation.open({directory:path.join(root,hostId),hostId,name:'TEST_ONLY '+hostId,legacyRole:role,network:{listen:'127.0.0.1',discovery:false},now:()=>clock,...extra});apps.push(app);return app;};
 const fleet=async(name)=>{const f=await FleetHub.open({directory:path.join(root,name)});fleets.push({f,release:f.journal.retainConnection()});return f;};
 t.after(async()=>{for(const a of apps)await a.close();for(const {release} of fleets)release();const base=await fs.realpath(os.tmpdir()),target=await fs.realpath(root);assert.ok(target.startsWith(base+path.sep+'ARGELLAN-TEST_ONLY-process-installation-'));await fs.rm(target,{recursive:true,force:true});});
 return {root,create,fleet,tick:ms=>{clock+=ms;}};
}

test('standalone process custody recovers staged frames after restart and commits exactly once',async t=>{
 const {root,create,fleet}=await fixture(t),journal=await fleet('local-journal');let app=await create('standalone','local-host');
 const observation=local('local-host'),samples=[sample('local-host')],ticket=await app.stageCapture(observation,{processSamples:samples});
 assert.ok(ticket?.id);assert.equal(count(journal,'local-host'),0);
 const intent=path.join(root,'local-host','captures',ticket.id+'.json');assert.deepEqual(JSON.parse(await fs.readFile(intent,'utf8')).data.processSamples,normalizeProcessSamples(samples,'local-host'));
 await app.close();app=await create('standalone','local-host');
 await app.recoverCaptures((snapshot,options)=>journal.captureLocal(snapshot,options));
 assert.equal(count(journal,'local-host'),1);assert.equal(app.state().queue.capturePendingBatches,0);
 await assert.rejects(fs.access(intent),{code:'ENOENT'});
 await journal.captureLocal(observation,{processSamples:samples});assert.equal(count(journal,'local-host'),1);
});

test('process custody rejects private fields and preserves a staged frame without a journal receipt',async t=>{
 const {root,create,fleet}=await fixture(t),journal=await fleet('refusal-journal'),app=await create('standalone','refusal-host');
 const observation=local('refusal-host'),frame=sample('refusal-host'),unsafe=structuredClone(frame);unsafe.snapshot.processes[0].commandLine='TEST_ONLY private';
 await assert.rejects(app.stageCapture(observation,{processSamples:[unsafe]}),/Unsupported process field/);
 const ticket=await app.stageCapture(observation,{processSamples:[frame]}),intent=path.join(root,'refusal-host','captures',ticket.id+'.json');
 await assert.rejects(app.commitCapture(ticket.id),/receipt unavailable/);assert.equal(count(journal,'refusal-host'),0);assert.equal(app.state().queue.capturePendingBatches,1);await fs.access(intent);
 await assert.rejects(app.recoverCaptures(async()=>{throw Error('TEST_ONLY journal failure');}),/TEST_ONLY journal failure/);await fs.access(intent);
 await app.recoverCaptures((snapshot,options)=>journal.captureLocal(snapshot,options));assert.equal(count(journal,'refusal-host'),1);await assert.rejects(fs.access(intent),{code:'ENOENT'});
});

test('paired node retains process frame across restart and rejects a false durable receiver receipt',async t=>{
 const {root,create,fleet,tick}=await fixture(t),nodeJournal=await fleet('node-journal'),hubJournal=await fleet('hub-journal');let badReceipt=true;
 const hub=await create('hub','hub-host',{onPeersChanged:peers=>hubJournal.setHosts(peers.filter(p=>p.role==='node').map(p=>({id:p.hostId,label:p.name,tokenHash:hash(p.key),installationManaged:true}))),ingest:async(peer,payload,wireSha256,options)=>{const receipt=await hubJournal.ingest(peer.key,payload,{wireSha256,...options});return badReceipt&&payload.processSamples?.length?{...receipt,processSamplesSha256:'wrong'}:receipt;}});
 let node=await create('node','node-host');const invite=await hub.openPairing({revision:hub.state().revision});await node.joinPairing({revision:node.state().revision,address:invite.address,code:invite.code,expectedId:hub.state().id});await node.confirmPairing({revision:node.state().revision,id:invite.id});await hub.confirmPairing({revision:hub.state().revision,id:invite.id});
 const observation=local('node-host'),samples=[sample('node-host')],ticket=await node.stageCapture(observation,{processSamples:samples});
 await node.close();node=await create('node','node-host');await node.recoverCaptures((snapshot,options)=>nodeJournal.captureLocal(snapshot,options));
 assert.equal(count(nodeJournal,'node-host'),1);const outbox=path.join(root,'node-host','outbox'),files=await fs.readdir(outbox),records=await Promise.all(files.map(f=>fs.readFile(path.join(outbox,f),'utf8').then(JSON.parse)));
 assert.equal(records.length,1);assert.deepEqual(records[0].payload.processSamples,normalizeProcessSamples(samples,'node-host'));assert.equal(records[0].recordCount,1);
 assert.equal((await node.flush()).sent,0);assert.equal(node.state().queue.pendingBatches,1);assert.equal(count(hubJournal,'node-host'),1);
 badReceipt=false;tick(2001);assert.equal((await node.flush()).sent,1);assert.equal(node.state().queue.pendingBatches,0);assert.equal(count(hubJournal,'node-host'),1);
 assert.equal(JSON.parse(await fs.readFile(path.join(root,'node-host','captures',ticket.id+'.json'),'utf8')).status,'framed');
});
