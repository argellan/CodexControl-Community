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
import {createServer} from '../server.mjs';
import {FleetHub} from '../lib/fleet.mjs';
import http from 'node:http';
test('handoff authority stamp is authenticated, stable while grants match, and changes on source revocation',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-handoff-authority-TEST_ONLY-')),token='TEST_ONLY_HANDOFF_OWNER',hash=s=>crypto.createHash('sha256').update(s).digest('hex'),hub=await FleetHub.open({directory,hosts:[{id:'test-source',label:'TEST_ONLY source',tokenHash:hash('TEST_ONLY_COLLECTOR')}]});
 const server=createServer({hub,viewers:[{id:'test-owner',label:'TEST_ONLY owner',role:'admin',hostIds:null,projectIds:null,tokenHash:hash(token)}],readSnapshot:async()=>({observedAt:new Date().toISOString(),host:{id:'test-local'},hosts:[],sessions:[],events:[],coverage:{}})});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port+'/api/snapshot?metadata=1';
 try{assert.equal((await fetch(url)).status,401);const read=async()=>{const r=await fetch(url,{headers:{Authorization:'Bearer '+token}});assert.equal(r.status,200);return r.json();};const a=await read(),b=await read();assert.match(a.viewer.permissionStamp,/^[a-f0-9]{64}$/);assert.equal(a.viewer.permissionStamp,b.viewer.permissionStamp);assert.equal(a.events.length,0);hub.hosts[0].disabled=true;const c=await read();assert.notEqual(c.viewer.permissionStamp,a.viewer.permissionStamp);assert.equal(c.viewer.id,a.viewer.id);}
 finally{await new Promise(r=>server.close(r));await fs.rm(directory,{recursive:true,force:true});}
});
test('a local gateway binds handoff authorization to the authoritative upstream permission stamp',async()=>{
 let upstreamStamp='a'.repeat(64);const upstream=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({observedAt:new Date().toISOString(),host:{id:'test-host'},hosts:[],sessions:[],events:[],coverage:{},viewer:{id:'test-owner',permissionStamp:upstreamStamp}}));});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const token='TEST_ONLY_HANDOFF_GATEWAY',server=createServer({upstream:{url:'http://127.0.0.1:'+upstream.address().port,token:'TEST_ONLY_UPSTREAM'},viewTokenHash:crypto.createHash('sha256').update(token).digest('hex')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const read=async()=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/snapshot?metadata=1',{headers:{Authorization:'Bearer '+token}});assert.equal(r.status,200);return r.json();};const a=await read();assert.equal((await read()).viewer.permissionStamp,a.viewer.permissionStamp);upstreamStamp='b'.repeat(64);const b=await read();assert.equal(a.viewer.id,b.viewer.id);assert.notEqual(a.viewer.permissionStamp,b.viewer.permissionStamp);}
 finally{await new Promise(r=>server.close(r));await new Promise(r=>upstream.close(r));}
});
