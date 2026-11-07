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
import vm from 'node:vm';
import {createServer} from './fixture-server.mjs';
import {FleetHub} from '../lib/fleet.mjs';
import {extractUsageSamples} from '../lib/observer.mjs';
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');

test('actual app evidence context narrows authorized capture inventory without treating replay metadata as historical lineage',async()=>{
 const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8'),start=source.indexOf('function usageEvidence(){'),end=source.indexOf('\nfunction syncTokenUsage',start);assert.ok(start>0&&end>start);
 const sessions=[{id:'root',hostId:'host-a',project:'A'},{id:'child',parentId:'root',hostId:'host-a',project:'A'},{id:'other',hostId:'host-b',project:'B'}],hosts=[{id:'host-a'},{id:'host-b'}];let f={project:'A'},records=[{id:'visible'}];
 const context=vm.createContext({filters:()=>f,store:{mode:'live',viewSessions:()=>sessions,viewHosts:()=>hosts},visibleEvents:()=>records,viewEventRecords:()=>records,ref:()=>123,windowMs:60000,matchesSession:()=>true});vm.runInContext(source.slice(start,end),context);
 let evidence=context.usageEvidence();assert.deepEqual(Array.from(evidence.hosts,h=>h.id),['host-a']);assert.deepEqual(Array.from(evidence.sessions,s=>s.id),['root','child']);assert.match(evidence.lineageScope,/not historical membership/);
 f={sessionHostId:'host-b',sessionId:'other'};context.store.mode='replay';evidence=context.usageEvidence();assert.deepEqual(Array.from(evidence.hosts,h=>h.id),['host-b']);assert.equal(evidence.sessionRestricted,true);assert.match(evidence.lineageScope,/not historical lineage/);
 // Execute the actual wrapper: capture filtering must survive the scope-caption enrichment.
 const callbackStart=source.indexOf('getEvidence:',source.indexOf('const accountUsageController=')),callbackEnd=source.indexOf(',onFocus:',callbackStart);assert.ok(callbackStart>0&&callbackEnd>callbackStart);context.investigation={scope:()=> 'TEST_ONLY authorized scope'};
 const getEvidence=vm.runInContext('('+source.slice(callbackStart+'getEvidence:'.length,callbackEnd)+')',context);
 assert.deepEqual(JSON.parse(JSON.stringify(getEvidence())),JSON.parse(JSON.stringify({...evidence,scopeLabel:'TEST_ONLY authorized scope'})));
 f={project:'A'};context.store.mode='live';evidence=getEvidence();assert.deepEqual(Array.from(evidence.hosts,h=>h.id),['host-a']);assert.deepEqual(Array.from(evidence.sessions,s=>s.id),['root','child']);assert.equal(evidence.scopeLabel,'TEST_ONLY authorized scope');
});

test('actual app request callback reaches authenticated details API with one query and exact host/project/session scope',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-ui-routing-TEST_ONLY-'));let server;
 try{
  const now=Date.now(),stamp=new Date(now).toISOString(),project='TEST_ONLY Project & Routing',host={id:'test-route-source',label:'TEST_ONLY source',role:'codex-source',tokenHash:digest('TEST_ONLY_collector')},other={...host,id:'test-route-other',tokenHash:digest('TEST_ONLY_other_collector')};
  const hub=await FleetHub.open({directory,hosts:[host,other]});
  const samples=(session,project,input)=>extractUsageSamples({type:'token_usage_record',timestamp:stamp,payload:{thread_id:session,turn_id:'TEST_ONLY-turn',response_id:'TEST_ONLY-response-'+input,usage:{input_tokens:input,cached_input_tokens:0,output_tokens:1,total_tokens:input+1}}},{metadata:{id:session,model_provider:'openai'},context:{project},sourceId:'a'.repeat(64),sourceOffset:input});
  for(const [source,credential,session,selectedProject,input]of [[host,'TEST_ONLY_collector','TEST_ONLY-selected-session',project,10],[host,'TEST_ONLY_collector','TEST_ONLY-other-session','TEST_ONLY_hidden_project',50],[other,'TEST_ONLY_other_collector','TEST_ONLY-selected-session',project,99]])await hub.ingest(credential,{hostId:source.id,batchId:'TEST_ONLY-batch-'+input,observedAt:stamp,sessions:[],events:[],usageSamples:samples(session,selectedProject,input)});
  const admin={id:'test-owner',label:'TEST_ONLY owner',role:'admin',hostIds:null,projectIds:null,tokenHash:digest('TEST_ONLY_viewer')};server=createServer({hub,viewers:[admin]});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(base+'/api/account/usage?details=1')).status,401);
  const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8'),start=source.indexOf('request:async(route,...args)=>{const requestedScope=usageScope();'),end=source.indexOf(',onUsage:payload=>',start);assert.ok(start>0&&end>start);
  let filter={};const routes=[],context=vm.createContext({URLSearchParams,usageScope:()=>JSON.stringify(filter),filters:()=>filter,settingsRequest:async route=>{routes.push(route);const response=await fetch(base+route,{headers:{authorization:'Bearer TEST_ONLY_viewer'}}),data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||'TEST_ONLY request refused'),{status:response.status});return data;}}),request=vm.runInContext('('+source.slice(start+'request:'.length,end)+')',context);
  const ordinary=await request('/api/account/usage');assert.equal(Object.hasOwn(ordinary,'sampleAnalytics'),false);assert.equal(routes[0],'/api/account/usage');
  filter={hostId:host.id,project,sessionId:'TEST_ONLY-selected-session'};const detailed=await request('/api/account/usage?details=1');assert.equal(detailed.sampleAnalytics.version,2);assert.equal(detailed.sampleAnalytics.responses.totals.input,10);assert.equal(detailed.sampleAnalytics.coverage.returnedRows,1);assert.ok(detailed.sampleAnalytics.recent.every(row=>row.host_id===host.id&&row.project===project&&row.session_id===filter.sessionId));assert.ok(!JSON.stringify(detailed.sampleAnalytics).includes('TEST_ONLY_hidden_project'));
  const routed=new URL(routes.at(-1),base);assert.deepEqual(routed.searchParams.getAll('details'),['1']);assert.equal(routed.searchParams.get('project'),project);assert.equal(routed.searchParams.get('hostId'),host.id);assert.equal(routes.at(-1).split('?').length,2);
  filter={hostId:other.id,project,sessionId:'TEST_ONLY-selected-session'};assert.equal((await request('/api/account/usage?details=1')).sampleAnalytics.responses.totals.input,99);
  filter={hostId:host.id,project:'TEST_ONLY-missing-project'};assert.equal((await request('/api/account/usage?details=1')).sampleAnalytics.coverage.returnedRows,0);
 }finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await fs.rm(directory,{recursive:true,force:true});}
});
