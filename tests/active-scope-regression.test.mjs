// SPDX-License-Identifier: MIT
// Author: Bishop Crockett; Owner: Argellan.com
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createServer} from './fixture-server.mjs';
import {FleetHub} from '../lib/fleet.mjs';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
test('selected cumulative counters match independent host/project vectors and preserve authority and history',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'TEST_ONLY-scope-counters-'));
 const hosts=['alpha','beta'].map(id=>({id,label:id,tokenHash:sha('TEST_ONLY_'+id)}));
 const hub=await FleetHub.open({directory:dir,hosts});
 const viewers=[{id:'owner',label:'TEST_ONLY owner',role:'admin',hostIds:null,projectIds:null,tokenHash:sha('TEST_ONLY_owner')},{id:'viewer',label:'TEST_ONLY viewer',role:'viewer',hostIds:['alpha'],projectIds:['Alpha'],tokenHash:sha('TEST_ONLY_viewer')}];
 const server=createServer({hub,securityState:{viewers,hosts},readSnapshot:async()=>({host:{id:'hub'},sessions:[],events:[],observedAt:new Date().toISOString()})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 const vectors=[[1000,200,300],[2000,500,400],[3000,600,700],[4000,800,900]];
 async function seed(round){
  const at=new Date().toISOString();
  for(const [h,host] of hosts.entries())await hub.ingest('TEST_ONLY_'+host.id,{hostId:host.id,batchId:'TEST_ONLY_'+round+'_'+h,observedAt:at,sessions:['Alpha','Beta'].map((project,i)=>{const [input,cached,output]=vectors[h*2+i];return {id:i?'side':'root',project,state:'Turn started',lastEventAt:at,usageObservedAt:at,tokens:{input_tokens:input,cached_input_tokens:cached,output_tokens:output,total_tokens:input+output}};}),events:round?[]:[{id:'TEST_ONLY_'+host.id,sessionId:'root',project:'Alpha',projectBasis:'source-context',at,kind:'tool.end',category:'command',label:'retained'}]});
 }
 const get=async(q='',viewer='owner')=>{const r=await fetch(url+'/api/account/usage'+q,{headers:{authorization:'Bearer TEST_ONLY_'+viewer}});return {status:r.status,value:await r.json()};};
 try{
  await seed(0);
  const expected=[
   ['',4,10000,2100,2300,12300],
   ['?hostId=alpha',2,3000,700,700,3700],
   ['?hostId=beta',2,7000,1400,1600,8600],
   ['?project=Alpha',2,4000,800,1000,5000],
   ['?project=Beta',2,6000,1300,1300,7300],
   ['?hostId=beta&project=Alpha',1,3000,600,700,3700],
   ['?hostId=alpha&project=Beta',1,2000,500,400,2400],
   ['?hostId=hub',0,null,null,null,null],
   ['?project=empty',0,null,null,null,null],
   ['?sessionId=root',2,4000,800,1000,5000],
  ];
  const retained=hub.journal.status();
  for(const [q,...want] of expected){const {status,value}=await get(q);assert.equal(status,200,q);const a=value.activeUsage;assert.deepEqual([a.sessions,a.inputTokens,a.cachedInputTokens,a.outputTokens,a.totalTokens],want,q);assert.equal(a.activityWindowMs,300000);assert.match(a.label,/cumulative/);assert.ok(value.burnUsage.inputTokens===0||value.burnUsage.inputTokens===null,'first readings are baselines, never traffic');}
  const restricted=await get('','viewer');assert.deepEqual(restricted.value.activeUsage.workers.map(w=>[w.hostId,w.sessionId]),[['alpha','root']]);assert.equal(restricted.value.activeUsage.inputTokens,1000);
  for(const q of ['?hostId=beta','?project=Beta','?hostId=beta&project=Alpha'])assert.equal((await get(q,'viewer')).status,403,q);
  // Capture a request, change source counters, then request a different scope.
  // Each result is checked against its own literal fixture expectation.
  const alpha=get('?hostId=alpha');await seed(1);const beta=get('?hostId=beta');const [a,b]=await Promise.all([alpha,beta]);assert.equal(a.value.activeUsage.inputTokens,3000);assert.equal(b.value.activeUsage.inputTokens,7000);
  assert.deepEqual(hub.journal.status(),retained,'read scopes do not alter retained event custody');
  assert.equal((await get('?hostId=alpha&hostId=beta')).status,400);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await hub.close?.();await fs.rm(dir,{recursive:true,force:true});}
});
