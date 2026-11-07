// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserDiagnostics,browserDiagnostics,diagnosticsSharingAction,invalidateDiagnosticsSharing} from '../public/diagnostics-workspace.mjs';

const grant=(browser=true)=>({available:true,schemaVersion:1,revision:4,adminRevision:2,receiverApproved:true,backend:true,browser,queued:0,recipientRevision:'TEST_ONLY_recipient',recipient:'Owned synthetic recipient',realReporting:false});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
test('tab reload retains only the local off intent, never a grant; successful explicit enable releases it',()=>{
 const bits=new Map(),intentStore={getItem:k=>bits.get(k),setItem:(k,v)=>bits.set(k,v),removeItem:k=>bits.delete(k)};
 const first=new BrowserDiagnostics({intentStore});first.configureSharing(grant(),async()=>grant(),{explicitEnable:true});first.optOut({explicit:true});
 const reloaded=new BrowserDiagnostics({intentStore});reloaded.configureSharing(grant(),async()=>grant());
 assert.equal(reloaded.sharing,false,'a new page must not revive the old server grant');
 reloaded.configureSharing(grant(),async()=>grant(),{explicitEnable:true});assert.equal(reloaded.sharing,true);
 const again=new BrowserDiagnostics({intentStore});again.configureSharing(grant(),async()=>grant());assert.equal(again.sharing,true);
 assert.equal([...bits.values()].some(x=>x.includes('TEST_ONLY')),false,'no recipient, grant or identity stored');
 first.optOut();reloaded.optOut();again.optOut();
});
// Minimal DOM model reproduces native disabled-button focus loss. The actual
// browser reproductions remain required evidence; this is a deterministic guard.
function surface(){
 const page=new EventTarget(),body={tagName:'BODY'},dialog={open:true};page.body=body;page.activeElement=body;
 page.defaultView={getComputedStyle:()=>({visibility:'visible'})};
 const nodes=new Map(),root={ownerDocument:page,isConnected:true,closest:()=>dialog,querySelector(selector){return nodes.get(selector)||null;}};
 function node(selector){let disabled=false;const n={ownerDocument:page,isConnected:true,checked:false,textContent:'',get disabled(){return disabled;},set disabled(value){disabled=value;if(value&&page.activeElement===n)page.activeElement=body;},getClientRects:()=>[{}],closest:()=>null,focus(){page.activeElement=n;const e=new Event('focusin');Object.defineProperty(e,'target',{value:n});page.dispatchEvent(e);}};nodes.set(selector,n);return n;}
 for(const s of ['[data-diagnostics-status]','[data-diagnostics-consent]','[data-diagnostics-admin-receiver]','[data-diagnostics-admin-backend]','[data-diagnostics-recipient]'])node(s);
 const actions=['sharing-refresh','sharing-save','synthetic-browser','recipient-save','synthetic-backend','off'];
 const buttons=Object.fromEntries(actions.map(a=>[a,node('[data-diagnostics-action="'+a+'"]')]));
 return{page,root,dialog,buttons,node};
}
async function seeded(){
 invalidateDiagnosticsSharing();const ui=surface();
 browserDiagnostics.configureSharing(grant(),async()=>grant(),{explicitEnable:true});
 await diagnosticsSharingAction('sharing-refresh',{root:ui.root,request:async()=>grant()});return ui;
}

test('failed explicit opt-out survives repeated passive reads, reopening and failed enable; deliberate current Save can enable',async()=>{
 const ui=await seeded();
 await diagnosticsSharingAction('off',{root:ui.root,request:async()=>{throw Object.assign(new Error('Synthetic unavailable'),{status:503});}});
 assert.equal(browserDiagnostics.sharing,false);
 for(let i=0;i<3;i++)await diagnosticsSharingAction('sharing-refresh',{root:ui.root,request:async()=>grant()});
 assert.equal(browserDiagnostics.sharing,false,'old server grant cannot override local opt-out');
 assert.equal(ui.root.querySelector('[data-diagnostics-consent]').checked,false);
 assert.equal(ui.buttons['synthetic-browser'].disabled,true);
 invalidateDiagnosticsSharing();const reopened=surface();
 await diagnosticsSharingAction('sharing-refresh',{root:reopened.root,request:async()=>grant()});
 assert.equal(browserDiagnostics.sharing,false,'workspace reopening is a passive read');
 reopened.root.querySelector('[data-diagnostics-consent]').checked=true;
 await diagnosticsSharingAction('sharing-save',{root:reopened.root,request:async()=>{throw Object.assign(new Error('Synthetic conflict'),{status:409});}});
 assert.equal(browserDiagnostics.sharing,false,'rejected explicit enable cannot clear intent');
 reopened.root.querySelector('[data-diagnostics-consent]').checked=true;
 await diagnosticsSharingAction('sharing-save',{root:reopened.root,request:async()=>grant()});
 assert.equal(browserDiagnostics.sharing,true,'successful deliberate current enable remains available');
 browserDiagnostics.optOut();
});

test('explicit off cancels an unsent producer batch and in-flight producer; stale enable cannot release newer off intent',async()=>{
 const d=new BrowserDiagnostics(),entered=deferred(),pending=deferred();let calls=0,signal;
 const request=async(_route,options)=>{calls++;signal=options.signal;entered.resolve();return pending.promise;};
 d.configureSharing(grant(),request,{explicitEnable:true});d.capture({kind:'client-js',category:'unexpected',site:'client:event'});
 d.optOut({explicit:true});await pause(300);assert.equal(calls,0,'local unsent counts purged');
 d.configureSharing(grant(),request);d.capture({kind:'client-js',category:'unexpected',site:'client:event'});
 await pause(300);assert.equal(calls,0,'passive read leaves producer stopped');
 d.configureSharing(grant(),request,{explicitEnable:true});d.capture({kind:'client-js',category:'unexpected',site:'client:event'});
 await entered.promise;assert.equal(calls,1);const oldIntent=d.intentGeneration;
 d.optOut({explicit:true});assert.equal(signal.aborted,true);pending.resolve(grant());await pause(0);
 d.configureSharing(grant(),request,{explicitEnable:true,intentGeneration:oldIntent});assert.equal(d.sharing,false,'old enable response cannot release newer explicit opt-out');
 d.configureSharing({...grant(),recipientRevision:'changed'},request);assert.equal(d.sharing,false);
 d.optOut();
});

for(const action of ['sharing-refresh','sharing-save','synthetic-browser','recipient-save','synthetic-backend']){
 for(const failure of [false,true])test(action+' retains owned keyboard focus on '+(failure?'503':'success'),async()=>{
  const ui=await seeded();ui.root.querySelector('[data-diagnostics-consent]').checked=true;ui.buttons[action].focus();
  await diagnosticsSharingAction(action,{root:ui.root,request:async()=>{if(failure)throw Object.assign(new Error('Synthetic unavailable'),{status:503});return grant();}});
  assert.equal(ui.page.activeElement,ui.buttons[action],'completion retains a visible meaningful action');
 });
}

test('async diagnostic action does not reclaim focus after movement, closure, context replacement or newer request',async()=>{
 for(const interruption of ['movement','tab','closure','context','newer']){
  const ui=await seeded(),response=deferred();let current=true;ui.buttons['sharing-refresh'].focus();
  const running=diagnosticsSharingAction('sharing-refresh',{root:ui.root,request:()=>response.promise,isCurrent:()=>current});
  if(interruption==='movement')ui.buttons.off.focus();
  if(interruption==='tab'){const e=new Event('keydown');Object.defineProperty(e,'key',{value:'Tab'});ui.page.dispatchEvent(e);}
  if(interruption==='closure'){ui.dialog.open=false;current=false;}
  if(interruption==='context'){invalidateDiagnosticsSharing();current=false;}
  if(interruption==='newer'){ui.buttons.off.focus();await diagnosticsSharingAction('off',{root:ui.root,request:async()=>grant(false)});}
  const active=ui.page.activeElement;response.resolve(grant());await running;assert.equal(ui.page.activeElement,active,interruption+' must retain user/context focus');
 }
 browserDiagnostics.optOut();
});

test('initial Refresh error remains enabled and focused for retry; lost grant selects a visible fallback',async()=>{
 invalidateDiagnosticsSharing();const ui=surface();ui.buttons['sharing-refresh'].focus();
 await diagnosticsSharingAction('sharing-refresh',{root:ui.root,request:async()=>{throw new Error('Synthetic offline');}});
 assert.equal(ui.buttons['sharing-refresh'].disabled,false);assert.equal(ui.page.activeElement,ui.buttons['sharing-refresh']);
 await diagnosticsSharingAction('sharing-refresh',{root:ui.root,request:async()=>grant()});ui.buttons['synthetic-browser'].focus();
 await diagnosticsSharingAction('synthetic-browser',{root:ui.root,request:async()=>grant(false)});
 assert.equal(ui.buttons['synthetic-browser'].disabled,true);assert.equal(ui.page.activeElement,ui.buttons['sharing-refresh']);
 browserDiagnostics.optOut();
});
