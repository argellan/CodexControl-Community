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
import {createServer} from '../server.mjs';
import {LocalDiagnostics} from '../lib/diagnostics-privacy.mjs';
import {openSyntheticReceiver} from '../lib/diagnostics-telemetry.mjs';
import {browserDiagnostics,diagnosticsSharingAction} from '../public/diagnostics-workspace.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const canary='CANARY_R3 person@example.invalid C:\\Synthetic\\private 192.0.2.44';
async function fixture(run){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-r3-producer-'));
 const local=await LocalDiagnostics.open({directory:path.join(directory,'local')});
 const receiver=await openSyntheticReceiver({directory:path.join(directory,'receiver')});
 let broken=false;
 const viewers=['owner','alpha','bravo'].map(id=>({id,label:'TEST_ONLY',role:id==='owner'?'admin':'viewer',hostIds:null,projectIds:null,tokenHash:crypto.createHash('sha256').update('TEST_ONLY_'+id).digest('hex')}));
 const app=createServer({localDiagnostics:local,configuration:{read:async()=>({})},administration:{},viewers,syntheticDiagnostics:{mode:'synthetic-only',receiverPort:receiver.port},readSnapshot:async()=>{if(broken)throw new Error(canary);return {host:{id:'synthetic'},events:[],sessions:[]};}});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));
 const request=async(id,route,options={})=>{const response=await fetch('http://127.0.0.1:'+app.address().port+route,{method:options.method||'GET',signal:options.signal,headers:{authorization:'Bearer TEST_ONLY_'+id,...(options.body?{'content-type':'application/json'}:{})},body:options.body?JSON.stringify(options.body):undefined});return {status:response.status,data:await response.json()};};
 const state=async(id='alpha')=>(await request(id,'/api/settings/diagnostics')).data;
 const approve=async(backend=false)=>{const s=await state('owner');assert.equal((await request('owner','/api/admin/diagnostics/sharing',{method:'PUT',body:{revision:s.adminRevision,schemaVersion:1,receiver:true,backend}})).status,200);};
 const failure=async()=>{broken=true;assert.equal((await request('alpha','/api/snapshot')).status,503);broken=false;};
 console.log(JSON.stringify({fixture:'R3_AUTHOR',pid:process.pid,appPort:app.address().port,receiverPort:receiver.port,directory}));
 try{await run({directory,local,receiver,request,state,approve,failure});}
 finally{browserDiagnostics.optOut();browserDiagnostics.stop();app.closeAllConnections();await new Promise(r=>app.close(r));await receiver.close();await local.close();const maxRssKiB=process.resourceUsage().maxRSS;console.log(JSON.stringify({maxRssKiB,limitKiB:524288}));assert.ok(maxRssKiB<=524288);}
}
test('automatic backend producer stays off, never replays history, requires separate admin consent and cancels outage work',()=>fixture(async f=>{
 await f.failure();await wait(400);assert.equal(f.receiver.count(),0);assert.equal((await f.state('owner')).queued,0);
 await f.approve(false);await f.failure();await wait(350);assert.equal(f.receiver.count(),0);
 await f.approve(true);await wait(350);assert.equal(f.receiver.count(),0,'enabling never replays local history');
 await f.failure();for(let i=0;i<30&&f.receiver.count()<1;i++)await wait(25);assert.equal(f.receiver.count(),1);
 let reports=JSON.parse(await fs.readFile(path.join(f.directory,'receiver','reports.json'),'utf8'));assert.equal(reports[0].report.class,'backend');assert.equal(reports[0].report.category,'request-failed');
 f.receiver.unavailable(true);await f.failure();await wait(200);assert.equal((await f.state('owner')).queued,1);
 await f.approve(false);assert.equal((await f.state('owner')).queued,0);f.receiver.unavailable(false);await wait(1100);assert.equal(f.receiver.count(),1);
 assert.equal((await f.request('alpha','/api/snapshot')).status,200);assert.equal(JSON.parse(f.local.preview()).events.length,4);
 assert.doesNotMatch(JSON.stringify(reports),/CANARY|example.invalid|Synthetic|192\.0\.2|alpha|owner/);
}));
test('actual JS error capture batches only fixed counts through authenticated application grants; off, ownership, bounds, outage recovery and stale grants hold',()=>fixture(async f=>{
 const nodes=new Map(),root={querySelector(selector){if(!nodes.has(selector))nodes.set(selector,{checked:false,disabled:true,textContent:''});return nodes.get(selector);}};
 const api=async(route,options)=>{const r=await f.request('alpha',route,options);if(r.status>=400)throw Object.assign(new Error('Fixed failure'),{status:r.status});return r.data;};
 const action=action=>diagnosticsSharingAction(action,{root,request:api});
 const target=new EventTarget();browserDiagnostics.start(target);
 const error=()=>{const e=new Event('error',{cancelable:true});Object.defineProperty(e,'error',{get(){throw new Error(canary)}});target.dispatchEvent(e);};
 error();await wait(400);assert.equal(f.receiver.count(),0);
 await f.approve(false);await action('sharing-refresh');root.querySelector('[data-diagnostics-consent]').checked=true;await action('sharing-save');
 await wait(350);assert.equal(f.receiver.count(),0,'local history is not replayed');
 // Wait across local admission window, then actual event dispatch produces a single bounded aggregate.
 await wait(1000);for(let i=0;i<1000;i++)error();
 for(let i=0;i<60&&f.receiver.count()<1;i++)await wait(25);assert.equal(f.receiver.count(),1);
 const saved=await fs.readFile(path.join(f.directory,'receiver','reports.json'),'utf8'),report=JSON.parse(saved)[0].report;
 assert.equal(report.class,'browser');assert.equal(report.category,'unexpected');assert.ok(report.count>=1&&report.count<=20);assert.doesNotMatch(saved,/CANARY|example.invalid|Synthetic|192\.0\.2|alpha|owner/);
 let s=await f.state(),b=await f.state('bravo');const body={schemaVersion:1,recipientRevision:s.recipientRevision,revision:s.revision,class:'browser',category:'unexpected',count:1};
 assert.equal((await f.request('bravo','/api/settings/diagnostics/synthetic',{method:'POST',body})).status,409);
 for(const extra of [{count:101},{category:canary},{error:canary},{class:'backend'}])assert.equal((await f.request('alpha','/api/settings/diagnostics/synthetic',{method:'POST',body:{...body,...extra}})).status,400);
 f.receiver.unavailable(true);await wait(1000);error();await wait(450);assert.equal((await f.state()).queued,1);
 f.receiver.unavailable(false);for(let i=0;i<100&&f.receiver.count()<2;i++)await wait(25);assert.equal(f.receiver.count(),2,'bounded sender recovers without browser retry loop');
 await wait(1000);error();await action('off');await wait(450);assert.equal((await f.state()).queued,0);assert.equal(f.receiver.count(),2,'off cancels unsent browser batch');
 error();await f.failure();await wait(400);assert.equal(f.receiver.count(),2);assert.equal((await f.request('alpha','/api/snapshot')).status,200);
 const off=await f.state();await f.request('alpha','/api/settings/diagnostics',{method:'PUT',body:{revision:off.revision,schemaVersion:1,recipientRevision:off.recipientRevision,browser:true}});
 assert.equal((await f.request('alpha','/api/settings/diagnostics/synthetic',{method:'POST',body})).status,409,'stale pre-opt-out grant cannot submit after re-enable');
 assert.ok(JSON.parse(browserDiagnostics.preview()).events.length>0);assert.equal(b.browser,false);
}));
