// Author: Bishop Crockett; Owner: Argellan.com; License: MIT; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {FleetHub} from '../lib/fleet.mjs';
import {createServer} from './fixture-server.mjs';
import {sendBatch} from '../collector.mjs';
import http from 'node:http';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
test('Process pipeline: real collector transport, exact ack/retry, HTTP scopes and restart',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'argellan-process-api-')),host={id:'alpha',tokenHash:hash('collector')};let server,hub;
 try{hub=await FleetHub.open({directory:dir,hosts:[host]});server=createServer({hub,viewers:[{id:'owner',label:'Owner',tokenHash:hash('owner'),hostIds:null,projectIds:null},{id:'limited',label:'Limited',tokenHash:hash('limited'),hostIds:['beta'],projectIds:null},{id:'project',label:'Project',tokenHash:hash('project'),hostIds:null,projectIds:['A']}],readSnapshot:async()=>({host:{id:'hub'},sessions:[],events:[],coverage:{},observedAt:new Date().toISOString()})});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
  const headers=token=>({authorization:'Bearer '+token});
  assert.equal((await fetch(url+'/api/collector/process-capabilities',{headers:headers('collector')})).status,200);
  const snap={schemaVersion:1,sourceKind:'local-os',hostId:'alpha',bootId:'boot',sequence:1,observedAt:new Date().toISOString(),collection:{status:'ok',complete:true,scope:'test'},processes:[{pid:42,createdAt:'2026-01-01T00:00:00Z',executable:'node.exe',role:'Node.js runtime',family:'Codex',metricStatus:'ok',privateCommitBytes:100}]};
  const payload={hostId:'alpha',batchId:'process-one',observedAt:new Date().toISOString(),sessions:[],events:[],processSamples:[{epoch:crypto.randomUUID(),snapshot:snap}]};
  // The normal collector pins identity before sending its bearer credential.
  const identity=await(await fetch(url+'/api/identity')).json();const config={url,token:'collector',hostId:'alpha',expectedInstanceId:identity.deploymentId,allowInsecureLoopback:true};
  const ack=await sendBatch(config,payload);assert.equal(ack.processSamplesCount,1);assert.equal((await sendBatch(config,payload)).processSamplesSha256,ack.processSamplesSha256);
  const allowedHosts=await(await fetch(url+'/api/processes/hosts',{headers:headers('owner')})).json();assert.deepEqual(allowedHosts.hosts,[{id:'alpha',label:'alpha'}]);assert.deepEqual((await(await fetch(url+'/api/processes/hosts',{headers:headers('limited')})).json()).hosts,[]);assert.equal((await fetch(url+'/api/processes/hosts',{headers:headers('project')})).status,403);
  let response=await fetch(url+'/api/processes?host=alpha',{headers:headers('owner')});assert.equal(response.status,200);assert.equal((await response.json()).rows[0].pid,42);
  assert.equal((await fetch(url+'/api/processes?host=alpha',{headers:headers('limited')})).status,403);assert.equal((await fetch(url+'/api/processes?host=alpha',{headers:headers('project')})).status,403);assert.equal((await fetch(url+'/api/processes?host=alpha')).status,401);assert.equal((await fetch(url+'/api/processes?host=alpha',{method:'POST',headers:headers('owner')})).status,405);
  response=await fetch(url+'/api/processes/history?host=alpha',{headers:headers('owner')});assert.equal((await response.json()).retained.n,1);
  const restored=await FleetHub.open({directory:dir,hosts:[host]});assert.equal(restored.journal.processRead({hostIds:null,projectIds:null},new URLSearchParams('host=alpha'),['alpha']).total,1);
 }finally{if(server)await new Promise(r=>server.close(r));const root=await fs.realpath(os.tmpdir()),target=await fs.realpath(dir);assert.ok(target.startsWith(root+path.sep));await fs.rm(target,{recursive:true,force:true});}
});

test('gateway requires authentication, rejects local individual accounts and preserves upstream denials',async t=>{
 let calls=0,denied=false;
 const source=http.createServer((req,res)=>{calls++;assert.equal(req.method,'GET');assert.match(req.url,/^\/api\/processes/);res.setHeader('Content-Type','application/json');res.statusCode=denied?403:200;res.end(JSON.stringify(denied?{error:'Denied'}:{rows:[],padding:'fixture '.repeat(2000)}));});
 await new Promise(r=>source.listen(0,'127.0.0.1',r));
 const viewers=[{id:'allowed',label:'Allowed',tokenHash:hash('allowed'),hostIds:['alpha'],projectIds:null},{id:'project',label:'Project',tokenHash:hash('project'),hostIds:null,projectIds:['A']}];
 assert.throws(()=>createServer({viewers,upstream:{url:'http://127.0.0.1:'+source.address().port,token:'TEST_ONLY_upstream'}}),/authoritative hub/);
 const gateway=createServer({viewTokenHash:hash('allowed'),upstream:{url:'http://127.0.0.1:'+source.address().port,token:'TEST_ONLY_upstream'}});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));t.after(async()=>{for(const s of [gateway,source]){s.closeAllConnections();await new Promise(r=>s.close(r));}});
 const url='http://127.0.0.1:'+gateway.address().port,headers={authorization:'Bearer allowed','accept-encoding':'gzip'};
 assert.equal((await fetch(url+'/api/processes?host=alpha')).status,401);assert.equal(calls,0);
 assert.equal((await fetch(url+'/api/processes?host=alpha',{method:'POST',headers})).status,405);assert.equal(calls,0);
 const response=await fetch(url+'/api/processes?host=alpha',{headers});assert.equal(response.status,200);assert.equal(response.headers.get('content-encoding'),'gzip');assert.deepEqual((await response.json()).rows,[]);assert.equal(calls,1);
 denied=true;assert.equal((await fetch(url+'/api/processes?host=alpha',{headers})).status,403);
});

test('source revocation during process representation construction prevents delivery',async t=>{
 const hosts=[{id:'alpha',tokenHash:hash('collector')}] ;const server=createServer({viewTokenHash:hash('viewer'),hub:{hosts,journal:{processRead(){hosts[0].disabled=true;return {private:'MUST_NOT_DELIVER'};}}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/processes?host=alpha',{headers:{authorization:'Bearer viewer','accept-encoding':'gzip'}});assert.equal(response.status,403);assert.ok(!(await response.text()).includes('MUST_NOT_DELIVER'));
});
