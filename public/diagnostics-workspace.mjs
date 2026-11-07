// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {APPLICATION_VERSION} from './build-info.mjs';
import {LIMITS,DIAGNOSTICS_SCHEMA,sanitizedEvent,validLocalEvent,exact,localExport} from './diagnostics-schema.mjs';

export class ExportReview {
  #text=null;
  begin(events){this.#text=localExport(events.filter(validLocalEvent).slice(-LIMITS.events));return this.#text;}
  cancel(){this.#text=null;}
  confirm(download){if(this.#text===null)return false;const frozen=this.#text;this.#text=null;download(frozen);return true;}
}
export class BrowserDiagnostics {
  #events=[]; #stop=null; #window=-1; #admitted=0; #grant=null; #counts=new Map(); #sendTimer=null; #sending=null; #generation=0; #producerWindow=-1; #producerRequests=0; #localOptOut=false; #intentGeneration=0;
  #intentStore=null;
  constructor({now=Date.now,intentStore=null}={}){this.now=now;this.sharing=false;this.#intentStore=intentStore;try{this.#localOptOut=intentStore?.getItem('argellan-codex-diagnostics-local-off-v1')==='off';}catch{this.#localOptOut=true;}}
  #rememberIntent(){try{if(this.#localOptOut)this.#intentStore?.setItem('argellan-codex-diagnostics-local-off-v1','off');else this.#intentStore?.removeItem('argellan-codex-diagnostics-local-off-v1');}catch{/* Memory still fails closed; no grant or identity is persisted. */}}
  capture(input){const now=this.now(),second=Math.floor(now/1000);if(second!==this.#window){this.#window=second;this.#admitted=0;}if(this.#admitted++>=20)return false;this.#prune();const event=sanitizedEvent(input,now);this.#events.push(event);
    if(this.#grant){this.#counts.set(event.category,Math.min(100,(this.#counts.get(event.category)||0)+1));this.#scheduleSend();}this.#events=this.#events.slice(-LIMITS.events);return true;}
  #prune(){const hour=Math.floor(this.now()/3600000);this.#events=this.#events.filter(e=>e.hour<=hour&&(hour-e.hour)*3600000<LIMITS.localAgeMs);}
  preview(){this.#prune();return localExport(this.#events);}
  get locallyOptedOut(){return this.#localOptOut;}
  get intentGeneration(){return this.#intentGeneration;}
  optOut({explicit=false}={}){if(explicit){this.#localOptOut=true;this.#intentGeneration++;this.#rememberIntent();}this.sharing=false;this.#generation++;this.#grant=null;this.#counts.clear();clearTimeout(this.#sendTimer);this.#sendTimer=null;this.#sending?.abort();this.#sending=null;}
  configureSharing(state,request,{explicitEnable=false,intentGeneration=this.#intentGeneration}={}){
    this.optOut();
    if(state?.available&&state.receiverApproved&&state.browser&&state.schemaVersion===1&&state.realReporting===false&&typeof request==='function'){
      // Only a current, successful explicit enable can release a local opt-out.
      // A passive read may still contain the earlier server grant after an outage.
      if(explicitEnable&&intentGeneration===this.#intentGeneration){this.#localOptOut=false;this.#rememberIntent();}
      if(this.#localOptOut)return;
      this.#grant={revision:state.revision,recipientRevision:state.recipientRevision,request};this.sharing=true;
    }
  }
  #scheduleSend(){
    if(!this.#grant||this.#sendTimer||this.#sending||!this.#counts.size)return;
    // One event-triggered timer per batch. No idle polling or browser retry loop.
    this.#sendTimer=setTimeout(()=>{this.#sendTimer=null;void this.#send();},250);
  }
  async #send(){
    const grant=this.#grant,generation=this.#generation;if(!grant||this.#sending)return;
    const minute=Math.floor(this.now()/60000);if(minute!==this.#producerWindow){this.#producerWindow=minute;this.#producerRequests=0;}
    if(this.#producerRequests++>=30){this.#counts.clear();return;}
    const first=this.#counts.entries().next().value;if(!first)return;
    const [category,count]=first;this.#counts.delete(category);
    const controller=new AbortController();this.#sending=controller;
    const timeout=setTimeout(()=>controller.abort(),2000);
    try{const state=await grant.request('/api/settings/diagnostics/synthetic',{method:'POST',signal:controller.signal,body:{schemaVersion:1,recipientRevision:grant.recipientRevision,revision:grant.revision,class:'browser',category,count}});
      if(generation===this.#generation&&(!state?.browser||state.revision!==grant.revision||state.recipientRevision!==grant.recipientRevision))this.optOut();
    }catch{if(generation===this.#generation)this.optOut();}
    finally{clearTimeout(timeout);if(generation===this.#generation){this.#sending=null;this.#scheduleSend();}}
  }
  start(target){
    if(this.#stop||!target?.addEventListener)return;
    // Do not inspect event.error/reason/message/filename. Suppress the browser's
    // default raw error rendering for these captured events. Other console users
    // and browser extensions are outside this module's control.
    const error=event=>{event.preventDefault?.();this.capture({kind:'client-js',category:'unexpected',site:'client:event'});};
    const rejection=event=>{event.preventDefault?.();this.capture({kind:'client-js',category:'unhandled-rejection',site:'client:rejection'});};
    target.addEventListener('error',error);target.addEventListener('unhandledrejection',rejection);
    this.#stop=()=>{target.removeEventListener('error',error);target.removeEventListener('unhandledrejection',rejection);};
  }
  stop(){this.#stop?.();this.#stop=null;}
}
// Persist only one tab-local off bit across page reload. Grants remain on the
// authenticated server. Unavailable browser storage requires explicit enable.
export const browserDiagnostics=new BrowserDiagnostics({intentStore:{getItem:key=>window.sessionStorage.getItem(key),setItem:(key,value)=>window.sessionStorage.setItem(key,value),removeItem:key=>window.sessionStorage.removeItem(key)}});
const review=new ExportReview();
let previewGeneration=0;
export function cancelDiagnosticsPreview(){previewGeneration++;review.cancel();}
export function diagnosticsSettingsHTML({admin=false}={}) {
  return `<section class="settings-card"><h4>Help improve the app</h4><label><input type="checkbox" data-diagnostics-consent disabled aria-describedby="diagnostics-sharing-scope"> Help improve the app</label><p id="diagnostics-sharing-scope">Off by default. Only an explicitly configured local synthetic recipient and a current named account can enable synthetic test sharing. Real-report classes remain unavailable because recipient and ownership are unproved. No account, network connection or consent is required for local diagnostics.</p><p>Before any future sharing, an administrator must authorize a fixed receiver and each browser operator must explicitly consent. Backend aggregates require separate administrator consent. A wider collection schema requires renewed consent.</p><p>Fields: app version, generic failure category, count and coarse latency/memory buckets. No error text, prompts, source, environment, credentials, paths, people, network addresses or persistent user/session identifiers. HTTPS recipients may observe an IP address; this is not a promise of anonymity.</p><p>Retention: local diagnostics keep at most 100 events / 64 KiB / 7 days. Browser evidence lives only in this tab until reload. Synthetic test queues expire after 24 hours; the local synthetic receiver retains at most 100 reports / 64 KiB / 24 hours. With explicit local synthetic consent, future fixed failure categories and bounded counts are sent automatically. Historical local diagnostics, exception text and stack evidence are never uploaded.</p><button type="button" data-diagnostics-action="sharing-refresh">Refresh sharing state</button><button type="button" data-diagnostics-action="sharing-save" disabled>Save my synthetic sharing choice</button><button type="button" data-diagnostics-action="synthetic-browser" disabled>Send my synthetic test report</button><p data-diagnostics-recipient>Recipient not read. Refresh sharing state to inspect the fixed local recipient.</p>${admin?'<fieldset><legend>Local synthetic recipient · administrator</legend><label><input type="checkbox" data-diagnostics-admin-receiver disabled> Authorize the configured loopback synthetic recipient</label><label><input type="checkbox" data-diagnostics-admin-backend disabled> Separately allow synthetic backend aggregates</label><button type="button" data-diagnostics-action="recipient-save" disabled>Save recipient authorization</button><button type="button" data-diagnostics-action="synthetic-backend" disabled>Send synthetic backend aggregate</button></fieldset>':''}<button type="button" data-diagnostics-action="off">Keep sharing off</button><p data-diagnostics-status role="status" aria-live="polite">Local diagnostics remain available offline.</p><details><summary>Preview and manually export local diagnostics</summary><p>Preview freezes the exact outgoing JSON. Cancel clears the preview before any download file is created. Confirm downloads to this browser only; sharing it afterward is your decision.</p><button type="button" data-diagnostics-action="browser">Preview browser diagnostics</button>${admin?'<button type="button" data-diagnostics-action="backend">Preview backend diagnostics</button>':''}<pre class="settings-data" data-diagnostics-preview tabindex="0" aria-label="Exact diagnostic export preview" hidden></pre><button type="button" data-diagnostics-action="cancel">Cancel preview</button><button type="button" data-diagnostics-action="download" disabled>Download exact preview</button></details><p>Client JavaScript failures and caught backend failures are distinct. An unclean-close marker only says the previous process did not record a clean close; cause is unknown and crash detection is incomplete.</p></section>`;
}
export async function diagnosticsAction(action,{root,request,producerRequest=request,isCurrent=()=>true,download=downloadJSON}={}) {
  const status=root.querySelector('[data-diagnostics-status]'),preview=root.querySelector('[data-diagnostics-preview]'),confirm=root.querySelector('[data-diagnostics-action="download"]');
  const clear=()=>{cancelDiagnosticsPreview();if(preview){preview.textContent='';preview.hidden=true;}if(confirm)confirm.disabled=true;};
  if(['sharing-refresh','sharing-save','recipient-save','synthetic-browser','synthetic-backend','off'].includes(action)){if(action==='off')clear();await diagnosticsSharingAction(action,{root,request,producerRequest,isCurrent});return;}
  if(action==='cancel'){clear();if(action==='off')browserDiagnostics.optOut();if(status)status.textContent=action==='off'?'Sharing is off. Local diagnostics still work. Already delivered bytes cannot be recalled.':'Preview cancelled. No download was created.';return;}
  if(action==='download'){if(review.confirm(download)){clear();if(status)status.textContent='The exact reviewed JSON was downloaded to this browser.';}return;}
  if(!['browser','backend'].includes(action))return;
  clear();const generation=previewGeneration;if(status)status.textContent='Preparing a bounded local preview…';
  try{
    let text=browserDiagnostics.preview();
    if(action==='backend')text=(await request('/api/admin/diagnostics/export-preview')).preview;
    if(!isCurrent()||generation!==previewGeneration)return;
    if(typeof text!=='string'||new TextEncoder().encode(text).byteLength>LIMITS.localBytes)throw new Error('Invalid preview');
    const payload=JSON.parse(text);
    if(!exact(payload,['schemaVersion','applicationVersion','events'])||payload.schemaVersion!==DIAGNOSTICS_SCHEMA||payload.applicationVersion!==APPLICATION_VERSION||!Array.isArray(payload.events)||payload.events.length>LIMITS.events||!payload.events.every(validLocalEvent))throw new Error('Invalid preview');
    const frozen=review.begin(payload.events);if(preview){preview.textContent=frozen;preview.hidden=false;}if(confirm)confirm.disabled=false;if(status)status.textContent='Exact export preview ready. Review it, then download or cancel. No download file has been created.';
  }catch{if(!isCurrent()||generation!==previewGeneration)return;clear();if(status)status.textContent='Local preview unavailable. Retry with current access; no download was created.';}
}
function downloadJSON(text){const url=URL.createObjectURL(new Blob([text],{type:'application/json;charset=utf-8'}));try{const anchor=document.createElement('a');anchor.href=url;anchor.download='codex-control-diagnostics-v1.json';anchor.click();}finally{setTimeout(()=>URL.revokeObjectURL(url),0);}}
const sharingViews=new WeakMap();let sharingEpoch=0;
export function invalidateDiagnosticsSharing(){sharingEpoch++;}
function validSharingState(s){return !!s&&s.schemaVersion===1&&typeof s.available==='boolean'&&typeof s.browser==='boolean'&&typeof s.receiverApproved==='boolean'&&typeof s.backend==='boolean'&&s.realReporting===false&&Number.isSafeInteger(s.revision)&&Number.isSafeInteger(s.adminRevision)&&Number.isSafeInteger(s.queued)&&s.queued>=0&&s.queued<=20&&typeof s.recipientRevision==='string'&&s.recipientRevision.length<=64&&typeof s.recipient==='string'&&s.recipient.length<=256;}
function paintSharing(root,s){
 const browser=s.browser&&!browserDiagnostics.locallyOptedOut;
 const input=root.querySelector('[data-diagnostics-consent]');if(input){input.checked=browser;input.disabled=!s.available||!s.receiverApproved;}
 for(const [selector,checked] of [['[data-diagnostics-admin-receiver]',s.receiverApproved],['[data-diagnostics-admin-backend]',s.backend]]){const node=root.querySelector(selector);if(node){node.checked=checked;node.disabled=!s.available;}}
 for(const [action,enabled] of [['sharing-refresh',true],['sharing-save',s.available&&s.receiverApproved],['recipient-save',s.available],['synthetic-browser',s.available&&s.receiverApproved&&browser],['synthetic-backend',s.available&&s.receiverApproved&&s.backend]]){const node=root.querySelector('[data-diagnostics-action="'+action+'"]');if(node)node.disabled=!enabled;}
 const recipient=root.querySelector('[data-diagnostics-recipient]');if(recipient)recipient.textContent=s.recipient+'. Pending synthetic reports for this account: '+s.queued+'. Real reports remain disabled.';
}
function retainSharingFocus(root,trigger){
 const page=root.ownerDocument,dialog=root.closest?.('dialog');
 if(!page||page.activeElement!==trigger)return()=>{};
 let moved=false;
 const movement=event=>{if(event.target!==page.body)moved=true;},pointer=()=>{moved=true;},key=event=>{if(['Tab','Escape','PageUp','PageDown','Home','End','ArrowUp','ArrowDown',' '].includes(event.key))moved=true;};
 page.addEventListener('focusin',movement);page.addEventListener('pointerdown',pointer);page.addEventListener('keydown',key);
 return current=>{
  page.removeEventListener('focusin',movement);page.removeEventListener('pointerdown',pointer);page.removeEventListener('keydown',key);
  if(!current||moved||root.isConnected===false||dialog&&!dialog.open||page.activeElement!==page.body&&page.activeElement!==trigger)return;
  const usable=node=>node&&node.isConnected!==false&&!node.disabled&&!node.hidden&&!node.closest?.('[hidden],[inert]')&&(!node.getClientRects||node.getClientRects().length>0)&&page.defaultView?.getComputedStyle?.(node)?.visibility!=='hidden';
  const target=[trigger,root.querySelector('[data-diagnostics-action="sharing-refresh"]'),root.querySelector('[data-diagnostics-action="off"]')].find(usable);
  target?.focus({preventScroll:true});
 };
}
export async function diagnosticsSharingAction(action,{root,request,producerRequest=request,isCurrent=()=>true}={}){
 const status=root.querySelector('[data-diagnostics-status]');let view=sharingViews.get(root);if(!view||view.epoch!==sharingEpoch){view={epoch:sharingEpoch,state:null};sharingViews.set(root,view);}
 const token={};view.token=token;const current=()=>isCurrent()&&view.epoch===sharingEpoch&&view.token===token;
 const browserChoice=action==='sharing-save'?root.querySelector('[data-diagnostics-consent]').checked===true:null;
 if(action==='off'||browserChoice===false)browserDiagnostics.optOut({explicit:true});
 const intentGeneration=browserDiagnostics.intentGeneration;
 if(status)status.textContent=action==='sharing-refresh'?'Reading authenticated synthetic sharing state…':'Applying the explicit synthetic sharing choice…';
 const trigger=root.querySelector('[data-diagnostics-action="'+action+'"]'),restoreFocus=retainSharingFocus(root,trigger);if(trigger&&action!=='off')trigger.disabled=true;
 try{
  if(typeof request!=='function')throw new Error('Offline');let s=view.state;
  if(action==='sharing-refresh')s=await request('/api/settings/diagnostics');
  else if(action==='off')s=await request('/api/settings/diagnostics',{method:'PUT',body:{revision:s?.revision??0,schemaVersion:1,recipientRevision:s?.recipientRevision??'unknown',browser:false}});
  else{
   if(!s||!s.available)throw new Error('Refresh required');
   if(action==='sharing-save')s=await request('/api/settings/diagnostics',{method:'PUT',body:{revision:s.revision,schemaVersion:s.schemaVersion,recipientRevision:s.recipientRevision,browser:browserChoice}});
   else if(action==='recipient-save')s=await request('/api/admin/diagnostics/sharing',{method:'PUT',body:{revision:s.adminRevision,schemaVersion:s.schemaVersion,receiver:root.querySelector('[data-diagnostics-admin-receiver]').checked===true,backend:root.querySelector('[data-diagnostics-admin-backend]').checked===true}});
   else if(action==='synthetic-browser'&&browserDiagnostics.locallyOptedOut)throw new Error('Explicit enable required');
   else if(['synthetic-browser','synthetic-backend'].includes(action))s=await request('/api/settings/diagnostics/synthetic',{method:'POST',body:{schemaVersion:s.schemaVersion,recipientRevision:s.recipientRevision,class:action==='synthetic-browser'?'browser':'backend'}});
   else return;
  }
  if(!current())return;if(!validSharingState(s))throw new Error('Invalid sharing state');view.state=s;browserDiagnostics.configureSharing(s,producerRequest,{explicitEnable:browserChoice===true,intentGeneration});paintSharing(root,s);
  if(status)status.textContent=action==='off'?'Sharing is off; pending unsent reports were purged. Already delivered bytes cannot be recalled. Local diagnostics still work.':action.startsWith('synthetic-')?'Fixed synthetic test report accepted into the bounded local queue. Refresh to inspect pending count.':browserDiagnostics.locallyOptedOut&&s.browser?'Local sharing remains off. The server still reports an earlier choice. Retry Keep sharing off to confirm cancellation, or explicitly save a new sharing choice.':!s.available?'Synthetic sharing unavailable. Local diagnostics and browser export still work offline.':'Authenticated synthetic sharing state loaded. Changes require the explicit Save button. Only future fixed categories/counts can be sent; local diagnostic history is never uploaded.';
 }catch(error){if(!current())return;if(view.state)paintSharing(root,view.state);if(status)status.textContent=action==='off'?'Local sharing is off, but server cancellation could not be confirmed. Retry Keep sharing off when connected; delivered bytes cannot be recalled.':error.status===409?'Sharing changed in another client, recipient or schema. Refresh and review before explicitly choosing again.':'Synthetic sharing action unavailable. Refresh with current access; local diagnostics still work.';}
 finally{if(current()&&action==='sharing-refresh'&&trigger)trigger.disabled=false;restoreFocus(current());}
}
