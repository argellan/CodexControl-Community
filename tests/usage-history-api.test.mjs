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
import {FleetHub} from '../lib/fleet.mjs';
import {inspectJournal} from '../lib/administration.mjs';
import {createServer} from './fixture-server.mjs';
import {captureUsageSamples} from '../lib/usage-samples.mjs';

const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
test('durable burn API scopes before aggregation, survives reopen and never adds waterfall events',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-burn-TEST_ONLY-'));let server;
 const now=Date.now(),hosts=['first','second','disabled'].map(id=>({id,tokenHash:hash('TEST_ONLY_'+id)}));
 const session=(id,project,at,input,output)=>({id,project,provider:'openai',state:'Turn completed',usageObservedAt:new Date(at).toISOString(),tokens:{input_tokens:input,cached_input_tokens:Math.floor(input/2),output_tokens:output,total_tokens:input+output}});
 const ingest=(hub,id,batch,sessions)=>hub.ingest('TEST_ONLY_'+id,{hostId:id,batchId:batch,observedAt:new Date().toISOString(),sessions,events:[]});
 try{
  let hub=await FleetHub.open({directory,hosts});
  await ingest(hub,'first','baseline',[session('one','Allowed',now-10000,100,20),session('two','Denied',now-10000,1000,200)]);
  await ingest(hub,'first','next',[session('one','Allowed',now-1000,160,50),session('two','Denied',now-1000,1600,500)]);
  await ingest(hub,'second','baseline',[session('one','Allowed',now-10000,9000,10)]);
  await ingest(hub,'second','next',[session('one','Allowed',now-1000,9600,40)]);
  await ingest(hub,'disabled','baseline',[session('one','Allowed',now-10000,2000,10)]);
  await ingest(hub,'disabled','next',[session('one','Allowed',now-1000,3000,40)]);
  hosts[2].disabled=true;
  hub=await FleetHub.open({directory,hosts});
  assert.equal(hub.journal.status().retainedEvents,0);
  assert.equal(inspectJournal(hub.journal.file).retainedEvents,0);
  const owner={id:'owner',label:'TEST_ONLY owner',role:'admin',hostIds:null,projectIds:null,tokenHash:hash('TEST_ONLY_owner')};
  const viewer={id:'scoped',label:'TEST_ONLY scoped',role:'viewer',hostIds:['first'],projectIds:['Allowed'],tokenHash:hash('TEST_ONLY_scoped')};
  server=createServer({hub,viewers:[owner,viewer]});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const get=async(query='',key='TEST_ONLY_owner')=>{const r=await fetch(base+'/api/account/usage'+query,{headers:{Authorization:'Bearer '+key}});return {status:r.status,data:await r.json().catch(()=>null)};};
  const sample=project=>({session_id:'one',source_record_key:hash(project),source_kind:'token_usage_record',usage_scope:'response',source_ms:now-1000,time_basis:'source',project,native_turn_id:'turn',native_response_id:'response-'+project,input_tokens:100,output_tokens:20,total_tokens:120,reported_mask:41,provider_reported_mask:0,synthesized_mask:0});
  hub.journal.database(db=>{captureUsageSamples(db,[sample('Allowed'),sample('Denied')],{hostId:'first',receivedMs:now,sourceRole:'codex-source'});captureUsageSamples(db,[sample('Allowed')],{hostId:'second',receivedMs:now,sourceRole:'codex-source'});});
  const analytics=hub.journal.sampleAnalytics.bind(hub.journal);let analyticsCalls=0;hub.journal.sampleAnalytics=options=>{analyticsCalls++;return analytics(options);};
  assert.equal((await fetch(base+'/api/account/usage')).status,401);
  const all=await get();assert.equal(all.status,200);assert.equal(all.data.burnUsage.inputTokens,1260);assert.equal(all.data.burnUsage.inputPerSecond,21);
  assert.equal(analyticsCalls,0);assert.equal(all.data.sampleAnalytics,undefined);
  const detailed=await get('?details=1','TEST_ONLY_scoped');assert.equal(analyticsCalls,1);assert.equal(detailed.data.sampleAnalytics.coverage.retainedRows,1);assert.equal(detailed.data.sampleAnalytics.responses.totals.input,100);assert.equal(JSON.stringify(detailed.data.sampleAnalytics).includes('Denied'),false);assert.equal((await get('?details=0')).status,400);assert.equal((await get('?details=1&details=1')).status,400);
  assert.equal(all.data.usageHistory.archive.status,'unconfigured');assert.ok(all.data.usageHistory.archive.pendingRecords>0);assert.ok(all.data.usageHistory.archive.storage.databaseBytes>0);
  assert.ok(all.data.burnUsage.epoch.startsWith(hub.journal.status().epoch+':'));
  const limited=await get('','TEST_ONLY_scoped');assert.equal(limited.status,200);assert.equal(limited.data.burnUsage.inputTokens,60);assert.equal(limited.data.burnUsage.outputTokens,30);
  assert.equal(limited.data.accountUsage.status,'restricted');assert.ok(!JSON.stringify(limited.data.usageHistory).includes('Denied'));
  assert.equal(limited.data.usageHistory.archive.status,'restricted');assert.equal(limited.data.usageHistory.archive.pendingRecords,undefined);assert.equal(limited.data.usageHistory.archive.storage,undefined);
  const narrowed=await get('?hostId=first&project=Allowed&sessionId=one');assert.equal(narrowed.data.burnUsage.inputTokens,60);
  assert.equal((await get('?hostId=second','TEST_ONLY_scoped')).status,403);
  assert.equal((await get('?project=Denied','TEST_ONLY_scoped')).status,403);
  assert.equal((await get('?hostId=first&hostId=second')).status,400);
  assert.equal((await get('?limit=9000')).status,400);
  assert.equal((await get('?hostId=disabled')).data.burnUsage.inputTokens??0,0);
  const repeat=await get();assert.equal(repeat.data.burnUsage.lastSequence,all.data.burnUsage.lastSequence);assert.equal(hub.journal.status().retainedEvents,0);
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('cc-burn-TEST_ONLY-'));await fs.rm(directory,{recursive:true,force:true});}
});
