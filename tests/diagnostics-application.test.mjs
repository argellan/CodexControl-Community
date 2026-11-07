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
import vm from 'node:vm';
import {createServer} from '../server.mjs';
import {LocalDiagnostics} from '../lib/diagnostics-privacy.mjs';
import {openSyntheticReceiver} from '../lib/diagnostics-telemetry.mjs';
import {BrowserDiagnostics} from '../public/diagnostics-workspace.mjs';
const canary='CANARY_P1D_SECRET person@example.invalid C:\\Synthetic\\private 192.0.2.33';
const close=server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
const identity=(id,role='viewer')=>({id,label:'TEST_ONLY',role,hostIds:null,projectIds:null,tokenHash:crypto.createHash('sha256').update('TEST_ONLY_'+id).digest('hex')});
async function fixture(run,{synthetic=true}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-p1d-application-'));
 const diagnostics=await LocalDiagnostics.open({directory:path.join(directory,'local')});
 const receiver=await openSyntheticReceiver({directory:path.join(directory,'receiver')});let server;
 try{
  server=createServer({localDiagnostics:diagnostics,configuration:{read:async()=>({})},administration:{},viewers:[identity('owner','admin'),identity('alpha'),identity('bravo')],syntheticDiagnostics:synthetic?{mode:'synthetic-only',receiverPort:receiver.port}:undefined,readSnapshot:async()=>({host:{id:'synthetic'},events:[],sessions:[]})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  const request=async(route,{id='owner',method='GET',body,headers={}}={})=>{
   const response=await fetch(origin+route,{method,headers:{...(id?{authorization:'Bearer TEST_ONLY_'+id}:{}),...(body?{'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});const text=await response.text();let data;try{data=JSON.parse(text);}catch{data={text};}return {status:response.status,data};
  };
  await run({server,receiver,diagnostics,directory,request,origin});
 }finally{if(server)await close(server);await receiver.close();await diagnostics.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^cc-p1d-application-/);await fs.rm(directory,{recursive:true,force:true});}
}
const state=async(request,id='alpha')=>{const r=await request('/api/settings/diagnostics',{id});assert.equal(r.status,200,'actual application diagnostic consent state is available');return r.data;};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('actual app requires admin receiver approval and separate authenticated operator consent; sends only owned synthetic reports',()=>fixture(async({request,receiver,directory})=>{
 const fresh=await state(request);assert.equal(fresh.available,true);assert.equal(fresh.browser,false);assert.equal(fresh.receiverApproved,false);assert.equal(receiver.count(),0);
 assert.equal((await request('/api/admin/diagnostics/sharing',{id:'alpha',method:'PUT',body:{revision:0,schemaVersion:1,receiver:true,backend:false}})).status,403);
 const approved=await request('/api/admin/diagnostics/sharing',{method:'PUT',body:{revision:0,schemaVersion:1,receiver:true,backend:false}});assert.equal(approved.status,200);
 const a=await state(request),b=await state(request,'bravo');assert.equal(a.browser,false);assert.equal(b.browser,false);
 const consent={revision:a.revision,schemaVersion:1,recipientRevision:a.recipientRevision,browser:true};
 assert.equal((await request('/api/settings/diagnostics',{id:'alpha',method:'PUT',body:consent})).status,200);
 assert.equal((await request('/api/settings/diagnostics',{id:'alpha',method:'PUT',body:consent})).status,409,'second stale client cannot re-enable');
 assert.equal((await request('/api/settings/diagnostics/synthetic',{id:'bravo',method:'POST',body:{schemaVersion:1,recipientRevision:b.recipientRevision,class:'browser'}})).status,403);
 assert.equal((await request('/api/settings/diagnostics/synthetic',{id:'alpha',method:'POST',body:{schemaVersion:1,recipientRevision:a.recipientRevision,class:'browser'}})).status,202);
 for(let i=0;i<30&&receiver.count()<1;i++)await wait(50);assert.equal(receiver.count(),1);
 const saved=await fs.readFile(path.join(directory,'receiver','reports.json'),'utf8');assert.doesNotMatch(saved,/alpha|bravo|owner|TEST_ONLY|CANARY|example\.invalid/);assert.equal(JSON.parse(saved)[0].report.origin,'synthetic');
 const ownerState=await state(request,'owner');assert.equal((await request('/api/settings/diagnostics/synthetic',{method:'POST',body:{schemaVersion:1,recipientRevision:ownerState.recipientRevision,class:'backend'}})).status,403,'backend requires separate consent');
 assert.equal((await state(request,'bravo')).browser,false);
}));
test('app opt-out purges retries; recipient/schema changes and logout revoke consent; restart/default mode stay off',()=>fixture(async({request,receiver,diagnostics})=>{
 await request('/api/admin/diagnostics/sharing',{method:'PUT',body:{revision:0,schemaVersion:1,receiver:true,backend:true}});
 const a=await state(request);await request('/api/settings/diagnostics',{id:'alpha',method:'PUT',body:{revision:a.revision,schemaVersion:1,recipientRevision:a.recipientRevision,browser:true}});
 receiver.unavailable(true);await request('/api/settings/diagnostics/synthetic',{id:'alpha',method:'POST',body:{schemaVersion:1,recipientRevision:a.recipientRevision,class:'browser'}});await wait(100);
 assert.equal((await state(request)).queued,1);
 assert.equal((await request('/api/settings/diagnostics',{id:'alpha',method:'PUT',body:{revision:a.revision,schemaVersion:1,recipientRevision:a.recipientRevision,browser:false}})).status,200,'stale opt-out is fail closed');assert.equal((await state(request)).queued,0);
 const off=await state(request);assert.equal((await request('/api/settings/diagnostics',{id:'alpha',method:'PUT',body:{revision:off.revision,schemaVersion:2,recipientRevision:off.recipientRevision,browser:true}})).status,409);
 await request('/api/admin/diagnostics/sharing',{method:'PUT',body:{revision:1,schemaVersion:1,receiver:true,backend:false}});
 assert.equal((await request('/api/settings/diagnostics',{id:'alpha',method:'PUT',body:{revision:off.revision,schemaVersion:1,recipientRevision:off.recipientRevision,browser:true}})).status,409);
 const renewed=await state(request);await request('/api/settings/diagnostics',{id:'alpha',method:'PUT',body:{revision:renewed.revision,schemaVersion:1,recipientRevision:renewed.recipientRevision,browser:true}});
 await request('/api/session/logout',{id:'alpha',method:'POST'});assert.equal((await state(request)).browser,false);
 await diagnostics.capture({kind:'backend',category:'unexpected',error:new Error(canary)});assert.equal(JSON.parse(diagnostics.preview()).events.length,1);assert.equal((await request('/api/snapshot',{id:'alpha'})).status,200);
}));
test('application without explicit synthetic recipient keeps sharing unavailable and rejects arbitrary destination/real content',()=>fixture(async({request})=>{
 const s=await state(request);assert.equal(s.available,false);assert.equal(s.browser,false);
 assert.equal((await request('/api/settings/diagnostics',{id:'alpha',method:'PUT',body:{revision:0,schemaVersion:1,recipientRevision:'unknown',browser:true,url:'https://example.invalid'}})).status,400);
 assert.equal((await request('/api/settings/diagnostics/synthetic',{id:'alpha',method:'POST',body:{schemaVersion:1,recipientRevision:'unknown',class:'browser',error:canary}})).status,400);
},{synthetic:false}));
test('handled analytics failure records exactly one fixed local event and preserves generic 503',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-p1d-analytics-'));const d=await LocalDiagnostics.open({directory});let server;
 try{
  const config={version:1,engine:'duckdb',expectedReceiverId:'11111111-1111-4111-8111-111111111111',ssh:{executable:process.execPath,host:'synthetic.invalid',user:'synthetic',identityFile:path.join(directory,'NOT_READ'),knownHostsFile:path.join(directory,'NOT_READ_EITHER')}};
  server=createServer({localDiagnostics:d,configuration:{read:async()=>({})},administration:{},viewers:[identity('owner','admin')],hub:{hosts:[],states:new Map()},historicalAnalytics:config,historicalAnalyticsDependencies:{checkFiles:async()=>{},transport:async()=>{throw new Error(canary);}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const r=await fetch(`http://127.0.0.1:${server.address().port}/api/analytics/history?report=daily&source=session-deltas&fromDay=2026-10-23&toDay=2026-10-23`,{headers:{authorization:'Bearer TEST_ONLY_owner'}});assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/CANARY|example.invalid/);await d.flush();const events=JSON.parse(d.preview()).events;assert.equal(events.length,1);assert.deepEqual(events[0].stack,['backend:analytics']);assert.doesNotMatch(await fs.readFile(path.join(directory,'diagnostics.json'),'utf8'),/CANARY|example.invalid/);
 }finally{if(server)await close(server);await d.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});}
});
test('actual polling parse failure logs only generic text and captures one diagnostic without changing recovery/backoff',async()=>{
 const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');const reader=source.slice(source.indexOf('async function readObservation('),source.indexOf('function stopObservationPolling('));const poll=source.slice(source.indexOf('async function poll(){'),source.indexOf('function replay(at)'));
 const d=new BrowserDiagnostics(),logs=[];let failures=0,schedules=0,disconnects=0;
 const context=vm.createContext({browserDiagnostics:d,AbortSignal,Date,Promise,encodeURIComponent,document:{hidden:false},polling:false,pollTimer:null,snapshot:null,recoveryCursor:null,snapshotAuthorized:true,stopObservationPolling(){},schedulePoll(){schedules++;},observationRetry:{begin:()=>true,fail(){failures++;}},investigation:{invalidate(){}},store:{disconnect(){disconnects++;}},$:()=>({textContent:'',classList:{add(){}}}),render(){},renderHistoryStatus(){},console:{error:(...args)=>logs.push(args.join(' '))},fetch:async()=>new Response(canary,{status:200})});
 await vm.runInContext(reader+'\n'+poll+'\npoll()',context,{timeout:1000});assert.doesNotMatch(logs.join(' '),/CANARY|example.invalid|192\.0\.2|Synthetic/);assert.equal(JSON.parse(d.preview()).events.length,1);assert.deepEqual(JSON.parse(d.preview()).events[0].stack,['client:poll']);assert.equal(failures,1);assert.equal(schedules,1);assert.equal(disconnects,1);assert.equal(context.polling,false);
});
test('actual gateway forwards only GET export-preview without query and retains auth/origin/method boundaries',()=>fixture(async({origin,diagnostics})=>{
 await diagnostics.capture({kind:'backend',category:'unexpected'});
 const gateway=createServer({upstream:{url:origin,token:'TEST_ONLY_owner'},viewTokenHash:crypto.createHash('sha256').update('TEST_ONLY_gateway').digest('hex')});await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${gateway.address().port}/api/admin/diagnostics/export-preview`;
 try{
  const headers={authorization:'Bearer TEST_ONLY_gateway'};const r=await fetch(url,{headers});assert.equal(r.status,200);const body=await r.json();assert.equal(body.preview,diagnostics.preview());
  assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{...headers,origin:'https://synthetic.invalid'}})).status,403);
  assert.equal((await fetch(url+'?extra=1',{headers})).status,400);assert.equal((await fetch(url,{method:'POST',headers})).status,405);
  assert.equal((await fetch(url+'/arbitrary',{headers})).status,404);
 }finally{await close(gateway);}
}));
test('settings sharing actions operate actual app APIs with explicit admin and operator choices',()=>fixture(async({request,receiver})=>{
 const {diagnosticsSharingAction,diagnosticsSettingsHTML}=await import('../public/diagnostics-workspace.mjs');
 assert.equal(typeof diagnosticsSharingAction,'function','settings must expose working application-bound sharing actions');
 const html=diagnosticsSettingsHTML({admin:true});assert.match(html,/data-diagnostics-consent/);assert.match(html,/data-diagnostics-admin-receiver/);assert.doesNotMatch(html,/\schecked(?:\s|=|>)/);
 const makeRoot=()=>{const nodes=new Map();return {nodes,querySelector(selector){if(!nodes.has(selector))nodes.set(selector,{checked:false,disabled:true,textContent:'',setAttribute(){}});return nodes.get(selector);},querySelectorAll(){return [];}};};
 const owner=makeRoot(),alpha=makeRoot();
 const api=id=>async(route,options={})=>{const r=await request(route,{id,...options});if(r.status>=400)throw Object.assign(new Error('Synthetic request rejected'),{status:r.status});return r.data;};
 await diagnosticsSharingAction('sharing-refresh',{root:owner,request:api('owner')});assert.equal(owner.querySelector('[data-diagnostics-consent]').checked,false);
 owner.querySelector('[data-diagnostics-admin-receiver]').checked=true;owner.querySelector('[data-diagnostics-admin-backend]').checked=false;
 await diagnosticsSharingAction('recipient-save',{root:owner,request:api('owner')});
 await diagnosticsSharingAction('sharing-refresh',{root:alpha,request:api('alpha')});assert.equal(alpha.querySelector('[data-diagnostics-consent]').disabled,false);alpha.querySelector('[data-diagnostics-consent]').checked=true;
 await diagnosticsSharingAction('sharing-save',{root:alpha,request:api('alpha')});await diagnosticsSharingAction('synthetic-browser',{root:alpha,request:api('alpha')});
 for(let i=0;i<30&&receiver.count()<1;i++)await wait(50);assert.equal(receiver.count(),1);
 await diagnosticsSharingAction('off',{root:alpha,request:api('alpha')});assert.equal((await state(request)).browser,false);assert.equal((await state(request,'bravo')).browser,false);
}));
test('new app instance with same configured users and recipient does not inherit unrelated or previous consent',()=>fixture(async({request,receiver})=>{
 await request('/api/admin/diagnostics/sharing',{method:'PUT',body:{revision:0,schemaVersion:1,receiver:true,backend:true}});const a=await state(request);await request('/api/settings/diagnostics',{id:'alpha',method:'PUT',body:{revision:a.revision,schemaVersion:1,recipientRevision:a.recipientRevision,browser:true}});
 const fresh=createServer({syntheticDiagnostics:{mode:'synthetic-only',receiverPort:receiver.port},configuration:{read:async()=>({})},administration:{},viewers:[identity('owner','admin'),identity('alpha')]});await new Promise(resolve=>fresh.listen(0,'127.0.0.1',resolve));
 try{const r=await fetch(`http://127.0.0.1:${fresh.address().port}/api/settings/diagnostics`,{headers:{authorization:'Bearer TEST_ONLY_alpha'}});const s=await r.json();assert.equal(r.status,200);assert.equal(s.available,true);assert.equal(s.receiverApproved,false);assert.equal(s.browser,false);assert.equal(s.backend,false);assert.notEqual(s.recipientRevision,a.recipientRevision);}finally{await close(fresh);}
}));
test('shared/legacy authority never proves operator ownership even with synthetic recipient configured',()=>fixture(async({receiver})=>{
 const server=createServer({syntheticDiagnostics:{mode:'synthetic-only',receiverPort:receiver.port},viewTokenHash:crypto.createHash('sha256').update('TEST_ONLY_shared').digest('hex')});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/settings/diagnostics`,{headers:{authorization:'Bearer TEST_ONLY_shared'}});const s=await r.json();assert.equal(r.status,200);assert.equal(s.available,false);assert.equal(s.browser,false);assert.equal(receiver.count(),0);}finally{await close(server);}
}));
test('shipped local receiver entry validates fixed local configuration and accepts only synthetic reports',async()=>{
 const url=new URL('../scripts/diagnostics-receiver.mjs',import.meta.url);assert.equal(await fs.access(url).then(()=>true,()=>false),true,'a runnable local receiver entry is required');
 const {startLocalSyntheticReceiver}=await import(url);const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-p1d-receiver-entry-'));let receiver;
 try{await assert.rejects(startLocalSyntheticReceiver({directory:'relative',port:0}),/absolute/i);receiver=await startLocalSyntheticReceiver({directory:path.join(directory,'new-receiver'),port:0});
 const {syntheticReport}=await import('../lib/diagnostics-telemetry.mjs');const r=await fetch(receiver.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(syntheticReport())});assert.equal(r.status,202);assert.equal(receiver.count(),1);
 await assert.rejects(startLocalSyntheticReceiver({directory:path.join(directory,'new-receiver'),port:0}),/exist/i);
 }finally{await receiver?.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});}
});
test('separate admin backend consent sends only a synthetic aggregate and app-wide queue saturation preserves dashboard',()=>fixture(async({request,receiver,directory})=>{
 await request('/api/admin/diagnostics/sharing',{method:'PUT',body:{revision:0,schemaVersion:1,receiver:true,backend:true}});const owner=await state(request,'owner');
 assert.equal((await request('/api/settings/diagnostics/synthetic',{method:'POST',body:{schemaVersion:1,recipientRevision:owner.recipientRevision,class:'backend'}})).status,202);
 for(let i=0;i<30&&receiver.count()<1;i++)await wait(50);assert.equal(receiver.count(),1);const rows=JSON.parse(await fs.readFile(path.join(directory,'receiver','reports.json'),'utf8'));assert.equal(rows[0].report.class,'backend');
 receiver.unavailable(true);const a=await state(request);await request('/api/settings/diagnostics',{id:'alpha',method:'PUT',body:{revision:a.revision,schemaVersion:1,recipientRevision:a.recipientRevision,browser:true}});
 for(let i=0;i<20;i++)assert.equal((await request('/api/settings/diagnostics/synthetic',{id:'alpha',method:'POST',body:{schemaVersion:1,recipientRevision:a.recipientRevision,class:'browser'}})).status,202);
 assert.equal((await request('/api/settings/diagnostics/synthetic',{id:'alpha',method:'POST',body:{schemaVersion:1,recipientRevision:a.recipientRevision,class:'browser'}})).status,429);assert.equal((await request('/api/snapshot',{id:'alpha'})).status,200);
 assert.equal((await state(request)).queued,20);await request('/api/settings/diagnostics',{id:'alpha',method:'PUT',body:{revision:0,schemaVersion:1,recipientRevision:a.recipientRevision,browser:false}});assert.equal((await state(request)).queued,0);
}));
test('actual application opt-out aborts in-flight synthetic delivery without claiming recall',async()=>{
 const http=await import('node:http');let observed;const delivered=new Promise(resolve=>{observed=resolve;});let wire='';const receiver=http.createServer(async req=>{for await(const chunk of req)wire+=chunk;observed();});await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));
 const app=createServer({configuration:{read:async()=>({})},administration:{},viewers:[identity('owner','admin'),identity('alpha')],syntheticDiagnostics:{mode:'synthetic-only',receiverPort:receiver.address().port}});await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
 const send=async(route,id,method='GET',body)=>{const r=await fetch(`http://127.0.0.1:${app.address().port}`+route,{method,headers:{authorization:'Bearer TEST_ONLY_'+id,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
 try{await send('/api/admin/diagnostics/sharing','owner','PUT',{revision:0,schemaVersion:1,receiver:true,backend:false});const a=(await send('/api/settings/diagnostics','alpha')).data;await send('/api/settings/diagnostics','alpha','PUT',{revision:a.revision,schemaVersion:1,recipientRevision:a.recipientRevision,browser:true});await send('/api/settings/diagnostics/synthetic','alpha','POST',{schemaVersion:1,recipientRevision:a.recipientRevision,class:'browser'});
 await Promise.race([delivered,wait(2500).then(()=>{throw new Error('Synthetic delivery not observed');})]);await send('/api/settings/diagnostics','alpha','PUT',{revision:0,schemaVersion:1,recipientRevision:a.recipientRevision,browser:false});await wait(50);assert.equal((await send('/api/settings/diagnostics','alpha')).data.queued,0);assert.equal(JSON.parse(wire).origin,'synthetic');assert.doesNotMatch(wire,/alpha|owner|CANARY|example.invalid/);
 }finally{await close(app);await close(receiver);}
});
test('gateway rechecks logout before preview delivery and bounds the forwarded response',async()=>{
 const http=await import('node:http');let release,observed;let large=false;const arrived=new Promise(resolve=>{observed=resolve;});const hub=http.createServer(async(req,res)=>{observed();if(!large)await new Promise(resolve=>{release=resolve;});res.setHeader('content-type','application/json');res.end(JSON.stringify({preview:large?'x'.repeat(131073):'CANARY_PRIVATE_PREVIEW'}));});await new Promise(resolve=>hub.listen(0,'127.0.0.1',resolve));
 const gateway=createServer({upstream:{url:`http://127.0.0.1:${hub.address().port}`,token:'TEST_ONLY_owner'},viewTokenHash:crypto.createHash('sha256').update('TEST_ONLY_gateway').digest('hex')});await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${gateway.address().port}`;
 try{
 const login=await fetch(base+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'TEST_ONLY_gateway'})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 const pending=fetch(base+'/api/admin/diagnostics/export-preview',{headers:{cookie}});await arrived;assert.equal((await fetch(base+'/api/session/logout',{method:'POST',headers:{cookie}})).status,200);release();const revoked=await pending;assert.equal(revoked.status,401);assert.doesNotMatch(await revoked.text(),/CANARY/);
 large=true;const oversized=await fetch(base+'/api/admin/diagnostics/export-preview',{headers:{authorization:'Bearer TEST_ONLY_gateway'}});assert.equal(oversized.status,503);assert.doesNotMatch(await oversized.text(),/CANARY|x{100}/);
 }finally{release?.();await close(gateway);await close(hub);}
});
test('two authenticated browser sessions for the same named account require separate explicit consent',()=>fixture(async({request,origin})=>{
 await request('/api/admin/diagnostics/sharing',{method:'PUT',body:{revision:0,schemaVersion:1,receiver:true,backend:false}});
 const login=async()=>{const r=await fetch(origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'TEST_ONLY_alpha'})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
 const a=await login(),b=await login();const call=async(cookie,method='GET',body)=>{const r=await fetch(origin+'/api/settings/diagnostics',{method,headers:{cookie,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
 const first=(await call(a)).data;assert.equal((await call(b)).data.browser,false);await call(a,'PUT',{revision:first.revision,schemaVersion:1,recipientRevision:first.recipientRevision,browser:true});
 assert.equal((await call(a)).data.browser,true);assert.equal((await call(b)).data.browser,false,'a different authenticated browser session cannot inherit sharing');
 const second=(await call(b)).data;assert.notEqual(first.recipientRevision,second.recipientRevision,'consent binds the recipient and current browser grant');
 assert.equal((await call(b,'PUT',{revision:second.revision,schemaVersion:1,recipientRevision:first.recipientRevision,browser:true})).status,409);
}));
test('collector internal operational failure records fixed evidence while ordinary rejection remains unchanged',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-p1d-caught-collector-'));const d=await LocalDiagnostics.open({directory});let server;
 try{server=createServer({localDiagnostics:d,hub:{hosts:[],states:new Map(),authenticateCollector:token=>token==='TEST_ONLY_source'?{id:'synthetic-source'}:null,ingest:async()=>{throw Object.assign(new Error(canary),{status:503});}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/api/collector`;
 const failed=await fetch(url,{method:'POST',headers:{authorization:'Bearer TEST_ONLY_source','content-type':'application/json'},body:'{}'});assert.equal(failed.status,503);assert.equal(await failed.text(),'Collector batch refused');await d.flush();assert.equal(JSON.parse(d.preview()).events.length,1);assert.doesNotMatch(d.preview(),/CANARY|example.invalid/);
 const rejected=await fetch(url,{method:'POST',headers:{authorization:'Bearer TEST_ONLY_source','content-type':'application/json'},body:'not-json'});assert.equal(rejected.status,400);assert.equal(JSON.parse(d.preview()).events.length,1,'routine body rejection does not duplicate operational capture');
 }finally{if(server)await close(server);await d.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});}
});