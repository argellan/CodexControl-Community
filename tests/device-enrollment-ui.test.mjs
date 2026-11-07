// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import * as ui from '../public/settings-workspace.mjs';
const state={role:'admin',capabilities:{sourceEnrollment:true,sourcesRead:true},viewer:{id:'owner'}};
const context={resources:{sources:{data:{revision:3,sources:[]}}},adminDrafts:{sources:{step:'identify',role:'codex-source'}}};
test('enrollment identify screen exposes purpose hostname and non-destructive cancel',()=>{
 assert.equal(typeof ui.renderDeviceEnrollmentControls,'function');
 const html=ui.renderDeviceEnrollmentControls(state,context);
 assert.match(html,/Codex activity/);assert.match(html,/Expected hostname/);assert.match(html,/Review device access/);assert.match(html,/Cancel/);assert.ok(!html.includes('data-admin-action="enroll-source"'));
});
test('replacement review explicitly describes impact before package action',()=>{
 assert.equal(typeof ui.renderDeviceEnrollmentControls,'function');
 const html=ui.renderDeviceEnrollmentControls(state,{...context,adminDrafts:{sources:{step:'review',id:'test-device',replace:true,expectedGeneration:2,role:'codex-source'}}});
 assert.match(html,/existing collector will lose access/i);assert.match(html,/confirmReplacement/);assert.match(html,/Back/);
});
test('installed view keeps unverified startup separate and offers read-only checks',()=>{
 assert.equal(typeof ui.renderDeviceEnrollmentControls,'function');
 const html=ui.renderDeviceEnrollmentControls(state,{...context,adminDrafts:{sources:{step:'install',id:'test-device',sourceId:'test-device',requestId:'test-request'}}});
 assert.match(html,/Check reporting/);assert.match(html,/not verified/i);assert.match(html,/Download available/);assert.match(html,/Close setup/);assert.ok(!html.includes('data-admin-action="enroll-source"'));
});
test('viewer cannot render enrollment controls',()=>{assert.equal(typeof ui.renderDeviceEnrollmentControls,'function');assert.equal(ui.renderDeviceEnrollmentControls({...state,role:'viewer',capabilities:{}},context),'');});

import {SettingsWorkspace} from '../public/settings-workspace.mjs';
import {createSettingsDraft,DEFAULT_PERSONAL_SETTINGS} from '../public/settings-view-model.mjs';
import {DEFAULT_CONFIGURATION} from '../public/settings-schema.mjs';
const button=action=>({dataset:{adminAction:action},disabled:false});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function workspace(){
 const w=Object.create(SettingsWorkspace.prototype),focus=[];
 Object.assign(w,{state:createSettingsDraft({personal:structuredClone(DEFAULT_PERSONAL_SETTINGS),personalRevision:1,configuration:structuredClone(DEFAULT_CONFIGURATION),revision:1,viewer:{id:'owner'},role:'admin',capabilities:{sourceEnrollment:true,sourcesRead:true}}),
 resources:{sources:{data:{revision:1,sources:[]}}},adminDrafts:{sources:{step:'review',id:'test-only-device',label:'TEST_ONLY device',expectedHostname:'TEST-ONLY',role:'codex-source',requestId:crypto.randomUUID()}},adminDraftDirty:new Set(['sources']),issued:[],errors:[],isOpen:true,status:'',render(){},content:{querySelector:()=>({focus:()=>focus.push('step')})}});
 w.focusEvents=focus;return w;
}
test('repeated creation clicks send one request and focus install step after success',async()=>{
 const w=workspace(),pending=deferred();let calls=0;w.request=()=>{calls++;return pending.promise;};
 const first=w.adminAction(button('enroll-source'));await w.adminAction(button('enroll-source'));assert.equal(calls,1);
 pending.resolve({revision:2,source:{id:'test-only-device',status:'active',credentialGeneration:1}});await first;
 assert.equal(w.adminDrafts.sources.step,'install');assert.equal(w.adminDrafts.sources.sourceId,'test-only-device');assert.deepEqual(w.focusEvents,['step','step']);
});
test('lost reply preserves original request through cancel and rejects another Add',async()=>{
 const w=workspace(),sent=[];w.request=async(path,o)=>{sent.push({path,body:o?.body});throw new Error('TEST_ONLY connection lost');};
 await w.adminAction(button('enroll-source'));const original=structuredClone(w.adminDrafts.sources.pendingRequest);
 await w.adminAction(button('cancel-source'));assert.equal(w.adminDrafts.sources.step,'recover');assert.deepEqual(w.adminDrafts.sources.pendingRequest,original);
 await w.adminAction(button('new-source'));assert.equal(sent.length,1);assert.equal(w.adminDrafts.sources.requestId,original.body.requestId);
 w.request=async path=>{assert.equal(path,'/api/admin/sources/enrollments/'+original.body.requestId);return {revision:2,source:{id:'test-only-device',status:'active',credentialGeneration:1}};};
 await w.adminAction(button('reconcile-source'));assert.equal(w.adminDrafts.sources.step,'install');assert.equal(w.issued.length,0);
});
test('definitive validation failure preserves editable input without a repeatable pending write',async()=>{
 const w=workspace();w.request=async()=>{throw Object.assign(new Error('Invalid device details'),{status:400});};
 await w.adminAction(button('enroll-source'));assert.equal(w.adminDrafts.sources.step,'identify');assert.equal(w.adminDrafts.sources.label,'TEST_ONLY device');assert.equal(w.adminDrafts.sources.pendingRequest,undefined);assert.equal(w.error,true);
});
test('receipt not found permits explicit review with a fresh request instead of automatic issuance',async()=>{
 const w=workspace();w.request=async()=>{throw new Error('Lost reply');};await w.adminAction(button('enroll-source'));const prior=w.adminDrafts.sources.requestId;
 let writes=0;w.request=async(path,o)=>{if(o?.method==='POST')writes++;throw Object.assign(new Error('Not found'),{status:404});};
 await w.adminAction(button('reconcile-source'));assert.equal(w.adminDrafts.sources.step,'identify');assert.notEqual(w.adminDrafts.sources.requestId,prior);assert.equal(w.adminDrafts.sources.pendingRequest,undefined);assert.equal(writes,0);
});
test('Back and Cancel before issuance preserve choices then discard without network effects',async()=>{
 const w=workspace();let calls=0;w.request=async()=>{calls++;};
 await w.adminAction(button('back-source'));assert.equal(w.adminDrafts.sources.step,'identify');assert.equal(w.adminDrafts.sources.role,'codex-source');
 await w.adminAction(button('review-source'));assert.equal(w.adminDrafts.sources.step,'review');
 await w.adminAction(button('cancel-source'));assert.deepEqual(w.adminDrafts.sources,{});assert.equal(calls,0);
});
test('replacement cannot be submitted without impact confirmation and preserves expected generation',async()=>{
 const w=workspace();Object.assign(w.adminDrafts.sources,{replace:true,expectedGeneration:2});let sent;
 w.request=async(path,o)=>{sent={path,...o};return {revision:2,source:{id:'test-only-device',credentialGeneration:3,status:'active'}};};
 await w.adminAction(button('enroll-source'));assert.equal(sent,undefined);assert.equal(w.adminDrafts.sources.step,'review');
 w.adminDrafts.sources.confirmReplacement=true;await w.adminAction(button('enroll-source'));
 assert.equal(sent.path,'/api/admin/sources/test-only-device/replace');assert.equal(sent.body.expectedGeneration,2);assert.equal(w.adminDrafts.sources.step,'install');
});
test('a late issuance after authority changes cannot repopulate private packages or setup state',async()=>{
 const w=workspace(),pending=deferred();let calls=0;w.request=()=>{calls++;return pending.promise;};
 const action=w.adminAction(button('enroll-source'));assert.equal(calls,1);w.state.role='viewer';w.adminDrafts={};w.issued=[];
 pending.resolve({revision:2,source:{id:'PRIVATE'},issuedCredential:{downloadId:'PRIVATE',id:'PRIVATE',kind:'collector'}});await action;
 assert.deepEqual(w.adminDrafts,{});assert.deepEqual(w.issued,[]);
});


test('report refresh and close restore focus to a meaningful surviving control',async()=>{
 const w=workspace(),selected=[];w.content.querySelector=selector=>({focus:()=>selected.push(selector)});w.adminDrafts.sources={step:'install',id:'test-only-device',sourceId:'test-only-device'};
 w.fetchResource=async()=>{};await w.adminAction(button('check-source'));assert.equal(selected.at(-1),'#device-enrollment-step');
 await w.adminAction(button('close-source'));assert.equal(selected.at(-1),'[data-admin-action="new-source"]');
});



test('security refresh restores only a matching-owner metadata recovery step without another write',async()=>{
 const w=workspace(),values=new Map(),storage={setItem:(k,v)=>values.set(k,v),getItem:k=>values.get(k),removeItem:k=>values.delete(k)};
 const {savePendingDeviceSetup}=await import('../public/device-enrollment.mjs');const instanceId=crypto.randomUUID(),requestId=crypto.randomUUID();
 savePendingDeviceSetup({requestId,actorId:'owner',instanceId,hostId:'test-only-device'},storage);
 w.setupStorage=storage;w.adminDrafts={};let writes=0;w.request=async()=>{writes++;};
 assert.equal(w.restorePendingSetup({instanceId}),true);assert.equal(w.adminDrafts.sources.step,'recover');assert.equal(w.adminDrafts.sources.requestId,requestId);assert.equal(writes,0);
 await w.adminAction(button('new-source'));assert.equal(w.adminDrafts.sources.requestId,requestId);assert.equal(writes,0);
 w.state.viewer.id='other';w.adminDrafts={};assert.equal(w.restorePendingSetup({instanceId}),false);assert.deepEqual(w.adminDrafts,{});
});


test('replacement removes the old package handle and local confirmation error is actionable',async()=>{
 const w=workspace();w.issued=[{downloadId:'old',kind:'collector',id:'test-only-device'}];
 w.rememberIssued({source:{id:'test-only-device'},enrollment:{requestId:'request'},issuedCredential:{downloadId:'new',kind:'collector',id:'test-only-device'}});
 assert.deepEqual(w.issued.map(x=>x.downloadId),['new']);
 Object.assign(w.adminDrafts.sources,{replace:true,expectedGeneration:1});w.request=async()=>{throw Error('Should not issue');};
 await w.adminAction(button('enroll-source'));assert.equal(w.status,'Confirm the replacement impact before continuing.');
});


test('pending issuance shows a distinct waiting state and recovery controls stay disabled until its result',async()=>{
 const w=workspace(),pending=deferred();w.request=()=>pending.promise;
 const action=w.adminAction(button('enroll-source'));
 const html=ui.renderDeviceEnrollmentControls(w.state,{adminDrafts:w.adminDrafts});assert.match(html,/Creating collector access/);assert.match(html,/disabled/);
 pending.reject(new Error('TEST_ONLY lost reply'));await action;
 const failed=ui.renderDeviceEnrollmentControls(w.state,{adminDrafts:w.adminDrafts});assert.match(failed,/Check interrupted setup/);assert.ok(!failed.includes('disabled'));
});
