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
import {DisplayPreferences} from '../lib/display-preferences.mjs';
import {createServer} from './fixture-server.mjs';

test('display profile survives a new store, merges independent settings and excludes view scope',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-display-'));
 try{let store=new DisplayPreferences(directory,'viewer');assert.equal((await store.read()).exists,false);await store.write({fontSize:18,leftWidth:310});store=new DisplayPreferences(directory,'viewer');assert.equal((await store.read()).preferences.fontSize,18);await Promise.all([store.write({rightWidth:330}),store.write({waterfallRatio:68})]);const saved=await store.read();assert.equal(saved.preferences.leftWidth,310);assert.equal(saved.preferences.rightWidth,330);assert.equal(saved.preferences.waterfallRatio,68);assert.throws(()=>store.write({hostId:'local',window:300000}),/Display settings only/);assert.equal((await new DisplayPreferences(directory,'other-viewer').read()).exists,false);}finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('display API requires viewer authorization and rejects cross-origin, oversized and non-display writes',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-display-http-')),token='fixture-viewer',server=createServer({preferencesDirectory:directory,viewTokenHash:crypto.createHash('sha256').update(token).digest('hex')});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`,headers={'content-type':'application/json',authorization:'Bearer '+token};
 try{assert.equal((await fetch(url+'/api/preferences')).status,401);let r=await fetch(url+'/api/preferences',{method:'PUT',headers,body:JSON.stringify({fontSize:19,fleetHeight:310})});assert.equal(r.status,200);assert.equal((await r.json()).preferences.fontSize,19);r=await fetch(url+'/api/preferences',{headers});assert.equal((await r.json()).preferences.fleetHeight,310);assert.equal((await fetch(url+'/api/preferences',{method:'PUT',headers:{...headers,origin:'https://untrusted.example'},body:'{}'})).status,403);assert.equal((await fetch(url+'/api/preferences',{method:'PUT',headers,body:'{"command":"run"}'})).status,400);assert.equal((await fetch(url+'/api/preferences',{method:'PUT',headers,body:'x'.repeat(5000)})).status,413);assert.equal((await fetch(url+'/api/snapshot',{method:'PUT',headers,body:'{}'})).status,405);}finally{await new Promise(r=>server.close(r));await fs.rm(directory,{recursive:true,force:true});}
});
test('loopback gateway persists display settings on its upstream profile',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-display-proxy-')),token='proxy-viewer',upstream=createServer({preferencesDirectory:directory,viewTokenHash:crypto.createHash('sha256').update(token).digest('hex')});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const gateway=createServer({upstream:{url:`http://127.0.0.1:${upstream.address().port}`,token}});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${gateway.address().port}`;
 try{const root=await fetch(url),cookie=root.headers.get('set-cookie').split(';')[0],r=await fetch(url+'/api/preferences',{method:'PUT',headers:{cookie,'content-type':'application/json'},body:'{"fontSize":17}'});assert.equal(r.status,200);assert.equal((await r.json()).preferences.fontSize,17);const after=await fetch(url+'/api/preferences',{headers:{cookie}});assert.equal((await after.json()).preferences.fontSize,17);}finally{await new Promise(r=>gateway.close(r));await new Promise(r=>upstream.close(r));await fs.rm(directory,{recursive:true,force:true});}
});
