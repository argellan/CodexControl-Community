// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';
import {FleetHub} from '../lib/fleet.mjs';import {createServer} from './fixture-server.mjs';
const token='history-viewer',host={id:'fixture-host',tokenHash:crypto.createHash('sha256').update('collector').digest('hex')},e=id=>({id,hostId:host.id,sessionId:'S',sourceId:'source',at:new Date().toISOString(),kind:'operation',label:'Recorded operation',delivery:'live'});
test('history API is authenticated/read-only, recovers committed events and proxies exact cursors',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-history-http-'));let upstream,gateway;
 try{const hub=await FleetHub.open({directory,hosts:[host]});await hub.ingest('collector',{hostId:host.id,batchId:'B',observedAt:new Date().toISOString(),sessions:[{id:'S'}],events:[e('one')]});
 const local=()=>Promise.resolve({host:{id:'fixture-hub',name:'Fixture'},sessions:[],events:[],coverage:{},observedAt:new Date().toISOString()});
 upstream=createServer({hub,viewTokenHash:crypto.createHash('sha256').update(token).digest('hex'),readSnapshot:local});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${upstream.address().port}`,headers={authorization:'Bearer '+token};
 assert.equal((await fetch(url+'/api/events?after=0')).status,401);let response=await fetch(url+'/api/events?after=0',{headers});assert.equal(response.status,200);const page=await response.json();assert.equal(page.events.length,1);
 assert.equal((await fetch(url+'/api/events?after=0',{method:'POST',headers})).status,405);assert.equal((await fetch(url+'/api/events?after=-1',{headers})).status,400);
 const meta=await(await fetch(url+'/api/snapshot?metadata=1',{headers})).json();assert.deepEqual(meta.events,[]);assert.ok(meta.history.epoch);
 gateway=createServer({upstream:{url,token}});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));const localUrl=`http://127.0.0.1:${gateway.address().port}`,root=await fetch(localUrl),cookie=root.headers.get('set-cookie').split(';')[0];
 const recovered=await(await fetch(localUrl+'/api/events?after=0&limit=1',{headers:{cookie}})).json();assert.equal(recovered.events[0].id,page.events[0].id);assert.equal(recovered.epoch,page.epoch);
 const older=await(await fetch(localUrl+'/api/history?before='+encodeURIComponent(new Date(Date.now()+1000).toISOString()),{headers:{cookie}})).json();assert.equal(older.events.length,1);
 }finally{for(const s of [gateway,upstream])if(s)await new Promise(r=>s.close(r));await fs.rm(directory,{recursive:true,force:true});}
});
