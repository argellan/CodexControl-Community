// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createServer} from './fixture-server.mjs';
import {FleetHub} from '../lib/fleet.mjs';
import {TokenMotion} from '../public/token-motion.mjs';

test('live summary preserves bounded fresh observations that produce spinning coin packets',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-coins-TEST_ONLY-')),hash=s=>crypto.createHash('sha256').update(s).digest('hex');let server;
 try{
  const hub=await FleetHub.open({directory,hosts:[{id:'test-coins',label:'TEST_ONLY coins',tokenHash:hash('TEST_ONLY_collector')}]});
  const ingest=async(index)=>{const at=new Date(Date.now()-1000+index).toISOString();await hub.ingest('TEST_ONLY_collector',{hostId:'test-coins',batchId:'TEST_ONLY_'+index,observedAt:at,events:[],sessions:[{id:'test-worker',project:'TEST_ONLY',provider:'openai',model:'TEST_ONLY_model',state:'Turn started',lastEventAt:at,usageObservedAt:at,tokens:{input_tokens:1000+index*100,cached_input_tokens:400+index*20,output_tokens:100+index*10,total_tokens:1100+index*110}}]});};
  await ingest(0);server=createServer({hub,viewers:[{id:'test-owner',role:'admin',label:'TEST_ONLY',hostIds:null,projectIds:null,tokenHash:hash('TEST_ONLY_owner')}]});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const read=async()=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/account/usage?summary=1',{headers:{authorization:'Bearer TEST_ONLY_owner'}});assert.equal(r.status,200);return r.json();};
  const motion=new TokenMotion();motion.feed(await read(),{now:Date.now()});assert.equal(motion.packets.length,0,'initial history is primed without a false burst');
  for(let i=1;i<=205;i++)await ingest(i);
  const live=await read();assert.ok(Array.isArray(live.usageHistory.observations),'live transport must carry the coin feed');assert.equal(live.usageHistory.observations.length,200,'browser projection is bounded, durable history is retained');assert.ok(live.usageHistory.storage.retainedObservations>=206);
  for(const field of ['daily','accountObservations','accountDaily'])assert.equal(Object.hasOwn(live.usageHistory,field),false);
  motion.feed(live,{now:Date.now()});assert.ok(motion.packets.length>0,'fresh admitted counters create actual coin packets');assert.ok(motion.packets.length<=48);assert.deepEqual(new Set(motion.packets.map(p=>p.kind)),new Set(['input','output','cached']));
  const ids=motion.packets.map(p=>p.id);motion.feed(live,{now:Date.now()});assert.deepEqual(motion.packets.map(p=>p.id),ids,'repeated polls do not duplicate coins');motion.feed(live,{now:Date.now(),reduced:true});assert.equal(motion.packets.length,0,'reduced-motion behavior remains');
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}assert.equal(path.dirname(directory),os.tmpdir());await fs.rm(directory,{recursive:true,force:true});}
});