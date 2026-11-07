// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {createServer} from '../server.mjs';
import {LocalDiagnostics} from '../lib/diagnostics-privacy.mjs';
import {syntheticReport} from '../lib/diagnostics-telemetry.mjs';
import {startLocalSyntheticReceiver} from './diagnostics-receiver.mjs';
import {ExportReview,BrowserDiagnostics,browserDiagnostics,diagnosticsSharingAction} from '../public/diagnostics-workspace.mjs';

const arguments_=process.argv.slice(2);
if(arguments_.length!==1||!arguments_[0].startsWith('--destination='))throw new Error('Use --destination=ABSOLUTE_NEW_DIRECTORY only');
const directory=arguments_[0].slice(14);
if(!path.isAbsolute(directory)||directory.startsWith('\\\\'))throw new Error('Use an absolute new local directory');
await fs.mkdir(directory,{mode:0o700});
const local=await LocalDiagnostics.open({directory:path.join(directory,'local')});
const receiver=await startLocalSyntheticReceiver({directory:path.join(directory,'receiver'),port:0});
const tokens=new Map(['owner','alpha','bravo'].map(id=>[id,'TEST_ONLY_'+crypto.randomBytes(24).toString('hex')]));
const viewers=[...tokens].map(([id,token])=>({id,label:'TEST_ONLY',role:id==='owner'?'admin':'viewer',hostIds:null,projectIds:null,tokenHash:crypto.createHash('sha256').update(token).digest('hex')}));
let failSnapshot=false;
const canary='CANARY_SECRET synthetic.person@example.invalid C:\\Synthetic\\private 192.0.2.17 https://example.invalid/?token=CANARY';
const server=createServer({localDiagnostics:local,configuration:{read:async()=>({})},administration:{},viewers,syntheticDiagnostics:{mode:'synthetic-only',receiverPort:receiver.port},readSnapshot:async()=>{if(failSnapshot)throw new Error(canary);return {host:{id:'synthetic'},sessions:[],events:[]};}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const calls=[],stages=[];
const target=new EventTarget();browserDiagnostics.start(target);
const browserFailure=()=>{const event=new Event('error',{cancelable:true});Object.defineProperty(event,'error',{get(){throw new Error(canary);}});target.dispatchEvent(event);};
const raw=async(id,route,options={})=>{
 const start=performance.now();
 const response=await fetch(origin+route,{method:options.method||'GET',headers:{authorization:'Bearer '+tokens.get(id),...(options.body?{'content-type':'application/json'}:{})},body:options.body?JSON.stringify(options.body):undefined});
 const text=await response.text();
 calls.push({route,method:options.method||'GET',status:response.status,elapsedMs:performance.now()-start,responseBytes:Buffer.byteLength(text)});
 return {status:response.status,data:JSON.parse(text)};
};
const api=id=>async(route,options)=>{const r=await raw(id,route,options);if(r.status>=400)throw Object.assign(new Error('Synthetic application request rejected'),{status:r.status});return r.data;};
const root=()=>{const nodes=new Map();return {querySelector(selector){if(!nodes.has(selector))nodes.set(selector,{checked:false,disabled:true,textContent:'',setAttribute(){}});return nodes.get(selector);},querySelectorAll(){return [];}};};
const owner=root(),alpha=root();
const record=async stage=>{const state=await api('alpha')('/api/settings/diagnostics');stages.push({stage,receiverRequests:receiver.logs().length,queued:state.queued,accepted:receiver.count(),browserConsent:state.browser,realReporting:state.realReporting});};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 failSnapshot=true;assert.equal((await raw('alpha','/api/snapshot')).status,503);failSnapshot=false;await local.flush();
 const exported=(await api('owner')('/api/admin/diagnostics/export-preview')).preview;
 const review=new ExportReview();const preview=review.begin(JSON.parse(exported).events);
 await fs.writeFile(path.join(directory,'preview.json'),preview,{mode:0o600});review.cancel();
 assert.equal(review.confirm(()=>{throw new Error('Cancelled export created a download');}),false);
 assert.equal(await fs.access(path.join(directory,'download.json')).then(()=>true,()=>false),false);
 await record('preview-cancel-default-off');
 const before=await api('alpha')('/api/settings/diagnostics');
 assert.equal((await raw('alpha','/api/settings/diagnostics/synthetic',{method:'POST',body:{schemaVersion:1,recipientRevision:before.recipientRevision,class:'browser'}})).status,403);
 await record('default-off-zero-sends');
 await diagnosticsSharingAction('sharing-refresh',{root:owner,request:api('owner')});
 owner.querySelector('[data-diagnostics-admin-receiver]').checked=true;
 owner.querySelector('[data-diagnostics-admin-backend]').checked=true;
 await diagnosticsSharingAction('recipient-save',{root:owner,request:api('owner')});
 await diagnosticsSharingAction('sharing-refresh',{root:alpha,request:api('alpha')});
 alpha.querySelector('[data-diagnostics-consent]').checked=true;
 await diagnosticsSharingAction('sharing-save',{root:alpha,request:api('alpha')});
 assert.equal((await api('bravo')('/api/settings/diagnostics')).browser,false);
 await wait(350);assert.equal(receiver.count(),0,'no retrospective local upload');
 browserFailure();await record('consented-event-batch-pending');
 for(let i=0;i<30&&receiver.count()<1;i++)await wait(50);
 assert.equal(receiver.count(),1);await record('automatic-browser-delivered');
 failSnapshot=true;assert.equal((await raw('alpha','/api/snapshot')).status,503);failSnapshot=false;
 for(let i=0;i<30&&receiver.count()<2;i++)await wait(50);
 assert.equal(receiver.count(),2);await record('automatic-backend-delivered');
 receiver.unavailable(true);await wait(1000);browserFailure();await wait(450);await record('receiver-unavailable');
 assert.equal((await api('alpha')('/api/settings/diagnostics')).queued,1);
 await diagnosticsSharingAction('off',{root:alpha,request:api('alpha')});
 await diagnosticsSharingAction('sharing-refresh',{root:owner,request:api('owner')});
 owner.querySelector('[data-diagnostics-admin-backend]').checked=false;
 await diagnosticsSharingAction('recipient-save',{root:owner,request:api('owner')});
 await record('opt-out-purged');
 failSnapshot=true;assert.equal((await raw('alpha','/api/snapshot')).status,503);failSnapshot=false;await local.flush();
 assert.equal(JSON.parse(local.preview()).events.length,3);assert.equal((await raw('alpha','/api/snapshot')).status,200);await record('local-diagnostics-dashboard-after-opt-out');
 const browser=new BrowserDiagnostics({now:(()=>{let n=0;return ()=>n+=1000;})()});
 const heap=process.memoryUsage().heapUsed,cpu=process.cpuUsage(),start=performance.now();
 for(let i=0;i<1000;i++)browser.capture({kind:'client-js',category:'request-failed',site:'client:poll',error:new Error(canary)});
 const elapsedMs=performance.now()-start,cpuUsed=process.cpuUsage(cpu);
 const metrics={captureCalls:1000,elapsedMs,cpuMs:(cpuUsed.user+cpuUsed.system)/1000,heapDeltaBytes:Math.max(0,process.memoryUsage().heapUsed-heap),previewBytes:Buffer.byteLength(browser.preview()),syntheticRequestBytes:Buffer.byteLength(JSON.stringify(syntheticReport())),maximumObservedApiMs:Math.max(...calls.map(row=>row.elapsedMs)),processMaxRssKiB:process.resourceUsage().maxRSS};
 assert.ok(metrics.elapsedMs<=100);assert.ok(metrics.cpuMs<=100);assert.ok(metrics.heapDeltaBytes<=8388608);assert.ok(metrics.previewBytes<=65536);assert.ok(metrics.syntheticRequestBytes<=2048);
 for(const file of [path.join(directory,'preview.json'),path.join(directory,'local','diagnostics.json'),path.join(directory,'receiver','reports.json')])assert.doesNotMatch(await fs.readFile(file,'utf8'),/CANARY|example\.invalid|192\.0\.2|Synthetic\\|TEST_ONLY|alpha|bravo/);
 assert.doesNotMatch(JSON.stringify(receiver.logs()),/CANARY|example\.invalid|TEST_ONLY/);
 const receipt={scope:'LOCAL_SYNTHETIC_APPLICATION_ONLY',automaticProducer:true,manualSendActions:0,fixture:{pid:process.pid,applicationPort:server.address().port,receiverPort:receiver.port}, workspaceFixture:'actual exported settings actions with in-memory DOM nodes and actual authenticated HTTP APIs',stages,calls,metrics,productionReporting:false,canariesAbsentFromPersistedPreviewLocalReceiverAndLogs:true,browserQA:'NOT_RUN',framePacingAndIngestionPerformance:'NOT_RUN'};
 await fs.writeFile(path.join(directory,'demo.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(receipt,null,2));
}finally{
 browserDiagnostics.optOut();browserDiagnostics.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await receiver.close();await local.close();
}