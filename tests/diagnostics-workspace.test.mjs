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
import {LocalDiagnostics} from '../lib/diagnostics-privacy.mjs';
async function implementation(){const url=new URL('../public/diagnostics-workspace.mjs',import.meta.url);assert.equal(await fs.access(url).then(()=>true,()=>false),true,'offline browser diagnostics and reviewed export must be implemented');return import(url);}
test('manual export creates no file before exact preview confirmation and cancel invalidates bytes',async()=>{
  const {ExportReview}=await implementation();const review=new ExportReview();let downloads=[];
  const text=review.begin([{kind:'client-js',category:'unexpected',stack:['client:event'],hour:0}]);
  assert.equal(downloads.length,0);assert.equal(JSON.parse(text).events.length,1);
  review.cancel();assert.equal(review.confirm(value=>downloads.push(value)),false);assert.equal(downloads.length,0);
  const exact=review.begin([{kind:'backend',category:'request-failed',stack:['backend:request'],hour:0}]);
  assert.equal(review.confirm(value=>downloads.push(value)),true);assert.deepEqual(downloads,[exact]);
  assert.equal(review.confirm(value=>downloads.push(value)),false);
});
test('browser errors sanitize before memory, suppress default console reporting, and remain local offline',async()=>{
  const {BrowserDiagnostics}=await implementation();let now=0;const d=new BrowserDiagnostics({now:()=>now});const handlers=new Map();let consoleCalls=0,networkCalls=0;
  const target={addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener:name=>handlers.delete(name),console:{error(){consoleCalls++;}},fetch(){networkCalls++;}};
  d.start(target);let prevented=0;const canary='CANARY_SECRET email@example.invalid C:\\Synthetic 192.0.2.17 https://example.invalid TOKEN';
  handlers.get('error')({error:new Error(canary),message:canary,filename:canary,preventDefault(){prevented++;}});
  handlers.get('unhandledrejection')({reason:new Error(canary),preventDefault(){prevented++;}});
  assert.equal(prevented,2);assert.equal(consoleCalls,0);assert.equal(networkCalls,0);
  assert.equal(d.preview().includes('CANARY'),false);assert.equal(d.preview().includes('example.invalid'),false);
  assert.equal(JSON.parse(d.preview()).events.length,2);
  d.optOut();now=1000;handlers.get('error')({preventDefault(){}});
  assert.equal(JSON.parse(d.preview()).events.length,3);assert.equal(d.sharing,false);
  d.stop();assert.equal(handlers.size,0);
});
test('settings surface keeps unavailable sharing unchecked and exposes privacy facts plus explicit preview/cancel',async()=>{
  const {diagnosticsSettingsHTML}=await implementation();const html=diagnosticsSettingsHTML();
  assert.match(html,/Help improve the app/);assert.match(html,/type="checkbox"[^>]*disabled/);assert.doesNotMatch(html,/\schecked(?:\s|=|>)/);
  assert.match(html,/recipient/i);assert.match(html,/retention/i);assert.match(html,/Preview browser diagnostics/);assert.match(html,/Cancel preview/);
});
test('backend capture and exact export are authenticated admin-only and never include synthetic source secrets',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-diagnostics-http-'));
  const diagnostics=await LocalDiagnostics.open({directory});let server;
  try{
    const key='TEST_ONLY_DIAGNOSTICS_ADMIN';const viewerKey='TEST_ONLY_DIAGNOSTICS_VIEWER';const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
    const identity=(id,role,key)=>({id,label:'TEST_ONLY',role,hostIds:null,projectIds:null,tokenHash:hash(key)});
    server=createServer({localDiagnostics:diagnostics,configuration:{read:async()=>({})},administration:{},viewers:[identity('owner','admin',key),identity('observer','viewer',viewerKey)],readSnapshot:async()=>{throw new Error('CANARY_SECRET person@example.invalid');}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(url+'/api/snapshot',{headers:{authorization:'Bearer '+key}})).status,503);
    const response=await fetch(url+'/api/admin/diagnostics/export-preview',{headers:{authorization:'Bearer '+key}});
    assert.equal(response.status,200,'administrator can preview bounded local backend diagnostics');
    const body=await response.json();assert.equal(typeof body.preview,'string');assert.equal(body.preview.includes('CANARY'),false);assert.equal(body.preview.includes('example.invalid'),false);assert.equal(JSON.parse(body.preview).events[0].kind,'backend');
    assert.equal((await fetch(url+'/api/admin/diagnostics/export-preview',{headers:{authorization:'Bearer '+viewerKey}})).status,403);
    assert.equal((await fetch(url+'/api/admin/diagnostics/export-preview')).status,401);
  }finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await diagnostics.close();await fs.rm(directory,{recursive:true,force:true});}
});
test('cancel during awaited backend preview prevents late bytes from restoring a downloadable export',async()=>{
  const {diagnosticsAction}=await implementation();
  const status={textContent:''},preview={textContent:'',hidden:true},confirm={disabled:true};
  const root={querySelector:selector=>selector==='[data-diagnostics-status]'?status:selector==='[data-diagnostics-preview]'?preview:confirm};
  let resolve;const pending=new Promise(r=>{resolve=r;});
  const running=diagnosticsAction('backend',{root,request:()=>pending});
  await diagnosticsAction('cancel',{root});
  resolve({preview:JSON.stringify({schemaVersion:1,applicationVersion:(await import('../public/build-info.mjs')).APPLICATION_VERSION,events:[]})});
  await running;assert.equal(preview.hidden,true);assert.equal(preview.textContent,'');assert.equal(confirm.disabled,true);
});