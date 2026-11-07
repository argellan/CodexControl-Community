// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {SettingsWorkspace} from '../public/settings-workspace.mjs';
import {createSettingsDraft,DEFAULT_PERSONAL_SETTINGS} from '../public/settings-view-model.mjs';
import {DEFAULT_CONFIGURATION} from '../public/settings-schema.mjs';

// The DOM boundary models replacement/disable blur and focus events. Browser
// acceptance separately exercises real native focus, rendering and disclosure.
function environment(key='sources'){
 const listeners=new Map(),page={body:{tagName:'BODY'},defaultView:{getComputedStyle:()=>({visibility:'visible'})},addEventListener(t,f){if(!listeners.has(t))listeners.set(t,new Set());listeners.get(t).add(f);},removeEventListener(t,f){listeners.get(t)?.delete(f);},emit(t,target,extra={}){for(const f of [...listeners.get(t)||[]])f({target,...extra});}};
 const nodes=[],node=(tagName,id='',dataset={})=>{const n={tagName,id,dataset,isConnected:true,disabled:false,hidden:false,textContent:id,ownerDocument:page,parentElement:null,closest(selector){if(selector==='button')return this.tagName==='BUTTON'?this:null;if(selector==='dialog')return dialog;return null;},getClientRects(){return this.isConnected&&!this.hidden?[{}]:[];},focus(){page.activeElement=this;page.emit('focusin',this);},querySelector(){return null;}};nodes.push(n);return n;};
 const heading=node('H3','settings-section-title'),search=node('INPUT','settings-search'),other=node('INPUT','other-field'),close=node('BUTTON','close'),destination=node('BUTTON','',{workspaceLink:'usage'});destination.textContent='Open usage & archive readings ↗';
 const dialog={open:true,isConnected:true,ownerDocument:page,contains:n=>nodes.includes(n),addEventListener:page.addEventListener.bind(page),removeEventListener:page.removeEventListener.bind(page),querySelector(s){return s==='#settings-section-title'?heading:s==='#settings-search'?search:s==='#settings-close-actions'?closeActions:s==='[data-action="close"]'?close:null;}};
 let button=node('BUTTON','',{resource:key}),contentNodes=[button,destination,other];const content={ownerDocument:page,isConnected:true,parentElement:{scrollTop:12},closest:s=>s==='dialog'?dialog:null,contains:n=>contentNodes.includes(n),querySelectorAll(s){if(s==='details'||s==='[data-setting-row]')return[];if(s==='[id]')return contentNodes.filter(n=>n.id);if(s==='[data-resource]')return contentNodes.filter(n=>n.dataset.resource);if(s==='[data-workspace-link]')return contentNodes.filter(n=>n.dataset.workspaceLink);return[];},querySelector(s){if(s==='[data-resource="'+key+'"]')return button;return null;}};
 const keep=node('BUTTON','',{action:'keep-editing'}),closeActions={hidden:false,contains:n=>n===keep};
 const w=Object.create(SettingsWorkspace.prototype);let resolve,reject;const request=()=>new Promise((yes,no)=>{resolve=yes;reject=no;});
 Object.assign(w,{content,dialog,section:'fleet',query:'',errors:[],state:createSettingsDraft({role:'admin',viewer:{id:'owner'},personal:structuredClone(DEFAULT_PERSONAL_SETTINGS),configuration:structuredClone(DEFAULT_CONFIGURATION),revision:1,personalRevision:1,capabilities:{configurationRead:true,configurationWrite:true,sourcesRead:true,diagnosticsRead:true,auditRead:true,backup:true,personalWrite:true}}),resources:{},isOpen:true,request,captureSecretInputs(){},chrome(){closeActions.hidden=!this.closePending;if(closeActions.hidden&&page.activeElement===keep)page.activeElement=page.body;},render(){const focused=content.contains(page.activeElement);for(const n of contentNodes)n.isConnected=false;button=node('BUTTON','',{resource:key});button.disabled=!!this.resources[key]?.loading;contentNodes=[button,node('BUTTON','',{workspaceLink:'usage'}),other];if(focused)page.activeElement=page.body;}});
 page.activeElement=button;
 return{w,page,heading,close,other,keep,destination,listeners,dialog,get button(){return button;},resolve:v=>resolve(v),reject:e=>reject(e),focus:n=>n.focus(),emit:(...args)=>page.emit(...args)};
}

for(const key of ['sources','diagnostics','audit','backups'])test(key+' Refresh keeps visible loading context then returns focus to its current trigger',async()=>{
 const e=environment(key),pending=e.w.fetchResource(key);assert.equal(e.page.activeElement,e.close,'loading must retain a surviving visible context');e.resolve({fixture:true});await pending;assert.equal(e.page.activeElement,e.button);assert.equal(e.button.disabled,false);assert.equal([...e.listeners.values()].reduce((n,s)=>n+s.size,0),0);
});

test('failed Refresh restores its enabled retry trigger and retains the error',async()=>{
 const e=environment(),pending=e.w.fetchResource('sources');e.reject(new Error('TEST_ONLY unavailable'));await pending;assert.equal(e.w.resources.sources.error,'TEST_ONLY unavailable');assert.equal(e.page.activeElement,e.button);
});

test('Refresh completion does not reclaim focus after the user moves to another field',async()=>{
 const e=environment(),pending=e.w.fetchResource('sources');e.focus(e.other);e.resolve({fixture:true});await pending;assert.notEqual(e.page.activeElement,e.button);
});

for(const change of ['section','query','authority','close','newer-resource'])test('Refresh focus and data respect '+change+' interruption',async()=>{
 const e=environment(),pending=e.w.fetchResource('sources');if(change==='section')e.w.section='appearance';if(change==='query')e.w.query='layout';if(change==='authority')e.w.state.role='viewer';if(change==='close'){e.w.isOpen=false;e.dialog.open=false;}if(change==='newer-resource')e.w.resources.sources={data:{newer:true}};e.resolve({stale:true});await pending;assert.notEqual(e.page.activeElement,e.button);if(['authority','newer-resource'].includes(change))assert.notEqual(e.w.resources.sources?.data?.stale,true);
});

test('Keep editing returns focus to the Usage destination before hiding the focused Cancel control',async()=>{
 const e=environment();e.w.isDirty=()=>true;e.focus(e.destination);assert.equal(e.w.close(),false);e.focus(e.keep);await e.w.handleClick({target:e.keep});assert.equal(e.w.closePending,false);assert.equal(e.page.activeElement.dataset?.workspaceLink,'usage');assert.equal(e.w.isOpen,true);
});

test('Keep editing does not move focus if another visible control already owns it',async()=>{
 const e=environment();e.w.closePending=true;e.focus(e.other);await e.w.handleClick({target:e.keep});assert.equal(e.page.activeElement,e.other);
});

test('a superseded resource completion cannot focus a newer rendered retry control',async()=>{
 const e=environment(),pending=e.w.fetchResource('sources');e.w.resources.sources={data:{newer:true}};e.w.render();e.resolve({stale:true});await pending;assert.notEqual(e.page.activeElement,e.button);assert.deepEqual(e.w.resources.sources.data,{newer:true});
});

test('pointer and keyboard movement cancel Refresh focus restoration without suppressing its data',async()=>{
 for(const gesture of ['pointerdown','keydown','wheel']){const e=environment(),pending=e.w.fetchResource('sources');e.emit(gesture,e.close,{key:'Tab'});e.resolve({fixture:true});await pending;assert.notEqual(e.page.activeElement,e.button,gesture);assert.deepEqual(e.w.resources.sources.data,{fixture:true});}
});

test('repeated activation while a resource is loading does not issue another protected request',async()=>{
 const e=environment(),pending=e.w.fetchResource('sources');await e.w.fetchResource('sources');e.resolve({fixture:true});await pending;assert.deepEqual(e.w.resources.sources.data,{fixture:true});assert.equal(e.w.resources.sources.loading,false);
});
