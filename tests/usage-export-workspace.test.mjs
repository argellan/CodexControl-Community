// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {mountUsageExportWorkspace} from '../public/usage-export-workspace.mjs';
import {EventStore} from '../public/event-model.mjs';
const now=Date.parse('2026-10-20T23:00:00Z');
const payload=()=>({PRIVATE_ACCOUNT:'never-copy',sampleAnalytics:{version:2,scope:{from:new Date(now-60000).toISOString(),to:new Date(now).toISOString()},coverage:{retainedRows:5,matchingRows:5,returnedRows:1,truncated:true},responses:{status:'partial',responseCount:1,totals:{input:100,cached:50,output:10,total:110}},recent:[{host_id:'PRIVATE_HOST',session_id:'PRIVATE_SESSION',project:'PRIVATE_PROJECT',native_turn_id:'PRIVATE_TURN',native_response_id:'PRIVATE_RESPONSE',source_ms:now-1234,received_ms:now,usage_scope:'response',accounting_class:'candidate',source_role:'codex-source',input_tokens:100,cached_input_tokens:50,output_tokens:10,total_tokens:110,reported_mask:63,provider_reported_mask:0,synthesized_mask:0,prompt:'PRIVATE_PROMPT',arguments:'PRIVATE_COMMAND',raw:'PRIVATE_RAW',source_record_key:'PRIVATE_HASH'}]}});
function fixture(options={}){
 const nodes=[],ids=new Map(),downloads=[],urls=[],revoked=[],timers=new Map();let active=null,next=0,paletteReads=0;
 const document={get activeElement(){return active;},getElementById:id=>{const node=ids.get(id);return node?.isConnected?node:null;},createElement(tag){
  const node={tagName:tag.toUpperCase(),children:[],attributes:{},dataset:{},listeners:new Map(),isConnected:false,open:false,checked:false,disabled:false,textContent:'',parentNode:null,src:'',setAttribute(key,value){this.attributes[key]=value;},removeAttribute(key){delete this.attributes[key];if(key==='src')this.src='';},append(...children){for(const child of children){this.children.push(child);child.parentNode=this;connect(child,this.isConnected);}},replaceChildren(...children){for(const child of this.children)connect(child,false);this.children=[];this.append(...children);},addEventListener(type,handler){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(handler);},removeEventListener(type,handler){this.listeners.get(type)?.delete(handler);},async emit(type){for(const handler of this.listeners.get(type)||[])await handler({target:this});},focus(){active=this;},showModal(){this.open=true;},close(){this.open=false;for(const handler of this.listeners.get('close')||[])handler({target:this});},remove(){connect(this,false);if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);},click(){if(this.tagName==='A')downloads.push({url:this.href,name:this.download});return this.emit('click');}};
  Object.defineProperty(node,'id',{get:()=>node.attributes.id,set:value=>{node.attributes.id=value;ids.set(value,node);}});Object.defineProperty(node,'innerHTML',{set(){throw new Error('Untrusted preview HTML insertion');}});nodes.push(node);return node;
 }};
 function connect(node,value){node.isConnected=value;for(const child of node.children)connect(child,value);}
 document.body=document.createElement('body');document.body.isConnected=true;const invoker=document.createElement('button');invoker.id='usage-open';document.body.append(invoker);invoker.focus();
 const window={Blob,URL:{createObjectURL(blob){urls.push(blob);return 'blob:TEST_ONLY-'+urls.length;},revokeObjectURL(url){revoked.push(url);}},setTimeout(fn,delay){timers.set(++next,{fn,delay});return next;},clearTimeout(id){timers.delete(id);},fetch(){throw new Error('No network');},localStorage:{getItem(){throw new Error('No storage');}}};
 const workspace=mountUsageExportWorkspace({document,window,getPalette:()=>{paletteReads++;return undefined;},saveBlob:async(blob,name)=>downloads.push({blob,name}),...options});
 const find=(predicate)=>nodes.find(predicate),button=text=>find(node=>node.tagName==='BUTTON'&&node.textContent===text),pre=()=>find(node=>node.tagName==='PRE');
 return {document,window,nodes,downloads,urls,revoked,timers,workspace,invoker,find,button,pre,get paletteReads(){return paletteReads;}};
}

test('workspace mount reads no source, palette, storage or network; preview is explicit and redacted by default',()=>{
 const f=fixture(),input=payload(),before=structuredClone(input);try{assert.equal(f.paletteReads,0);assert.equal(f.downloads.length,0);assert.ok(f.nodes.filter(node=>node.tagName==='DIALOG').every(node=>!node.open));f.workspace.openExport(input);assert.equal(f.paletteReads,1);assert.equal(f.document.getElementById('usage-export-dialog').open,true);assert.equal(f.document.getElementById('usage-export-identities').checked,false);assert.equal(f.document.getElementById('usage-export-times').checked,false);assert.match(f.pre().textContent,/host-001/);assert.doesNotMatch(f.pre().textContent,/PRIVATE|sourceAt|receivedAt/);assert.equal(f.downloads.length,0);assert.deepEqual(input,before);assert.ok(f.nodes.some(node=>node.textContent.includes('account completeness NOT ESTABLISHED')));}finally{f.workspace.destroy();}
});

test('identity/time disclosure are independent opt-ins that reset each opening without changing user focus',async()=>{
 const f=fixture();try{f.workspace.openExport(payload());const identity=f.document.getElementById('usage-export-identities'),precise=f.document.getElementById('usage-export-times');identity.focus();identity.checked=true;await identity.emit('change');assert.equal(f.document.activeElement,identity);assert.match(f.pre().textContent,/PRIVATE_HOST/);assert.doesNotMatch(f.pre().textContent,/sourceAt|PRIVATE_PROMPT|PRIVATE_HASH/);assert.equal(precise.checked,false);
 precise.focus();precise.checked=true;await precise.emit('change');assert.equal(f.document.activeElement,precise);assert.match(f.pre().textContent,/sourceAt/);assert.equal(f.downloads.length,0);f.document.getElementById('usage-export-dialog').close();f.workspace.openExport(payload());assert.equal(identity.checked,false);assert.equal(precise.checked,false);assert.doesNotMatch(f.pre().textContent,/PRIVATE_HOST|sourceAt/);
 }finally{f.workspace.destroy();}
});

test('each explicit format download stays local, bounded and uses the reviewed frozen selection',async()=>{
 const f=fixture({makePNG:async model=>{assert.equal(model.identityMode,'stable-aliases');return new Blob(['TEST_ONLY_png'],{type:'image/png'});}}),data=payload();try{f.workspace.openExport(data);data.sampleAnalytics.recent[0].input_tokens=999999;for(const format of ['JSON','CSV','SVG','PNG'])await f.button('Download '+format).click();assert.equal(f.downloads.length,4);for(const file of f.downloads){assert.match(file.name,/^argellan-codexcontrol-usage-2026-10-20\.(json|csv|svg|png)$/);assert.ok(file.blob.size<=8388608);assert.doesNotMatch(await file.blob.text(),/PRIVATE|999999/);}assert.equal(JSON.parse(await f.downloads[0].blob.text()).rows[0].tokens.input,100);}finally{f.workspace.destroy();}
});

test('closing during PNG work prevents a late download and restores the originating keyboard focus',async()=>{
 let finish;const f=fixture({makePNG:()=>new Promise(resolve=>{finish=resolve;})});try{f.workspace.openExport(payload());const request=f.button('Download PNG').click();assert.equal(f.button('Download JSON').disabled,true);await f.button('Download JSON').click();assert.equal(f.downloads.length,0);f.document.getElementById('usage-export-dialog').close();assert.equal(f.document.activeElement,f.invoker);finish(new Blob(['TEST_ONLY']));await request;assert.equal(f.downloads.length,0);assert.equal(f.pre().textContent,'');}finally{f.workspace.destroy();}
});

test('oversized or failed rasterization does not leak raw errors or trigger downloads',async()=>{
 for(const makePNG of [async()=>({size:8388609}),async()=>{throw new Error('PRIVATE_ERROR');}]){const f=fixture({makePNG});try{f.workspace.openExport(payload());await f.button('Download PNG').click();assert.equal(f.downloads.length,0);assert.ok(f.nodes.some(node=>node.textContent.includes('Local export could not be generated')));assert.ok(f.nodes.every(node=>!node.textContent.includes('PRIVATE_ERROR')));assert.equal(f.button('Download JSON').disabled,false);}finally{f.workspace.destroy();}}
});

test('download object URLs are created only after a click and all temporary resources are reclaimed',async()=>{
 const f=fixture({saveBlob:null});f.workspace.openExport(payload());assert.equal(f.urls.length,0);await f.button('Download JSON').click();assert.equal(f.urls.length,1);assert.equal(f.timers.size,1);assert.ok(f.downloads[0].url.startsWith('blob:TEST_ONLY'));f.workspace.destroy();assert.equal(f.revoked.length,1);assert.equal(f.timers.size,0);assert.ok(f.nodes.filter(node=>node.tagName==='DIALOG').every(node=>!node.isConnected));
});

test('rapid explicit downloads keep at most four object URLs and cleanup timers resident',async()=>{
 const f=fixture({saveBlob:null});try{f.workspace.openExport(payload());for(let i=0;i<9;i++)await f.button('Download JSON').click();assert.equal(f.urls.length,9);assert.equal(f.revoked.length,5);assert.equal(f.timers.size,4);}finally{f.workspace.destroy();}assert.equal(f.revoked.length,9);assert.equal(f.timers.size,0);
});

test('demo stays in isolated synthetic dialogs and never changes real events, cursors or disclosure defaults',async()=>{
 const real=new EventStore();real.events.set('retained',{id:'retained'});real.newTotal=7;const state=JSON.stringify({events:[...real.events],newTotal:real.newTotal}),f=fixture();try{f.workspace.openDemo();assert.equal(f.document.getElementById('usage-demo-dialog').open,true);assert.equal(f.document.activeElement,f.button('Return to live'));assert.ok(f.nodes.some(node=>node.textContent.includes('TEST_ONLY · SYNTHETIC')));assert.equal(f.nodes.filter(node=>node.className==='usage-demo-worker').length,6);
 await f.button('Preview synthetic export').click();assert.match(f.pre().textContent,/"synthetic": true/);assert.equal(f.document.getElementById('usage-export-identities').checked,false);await f.button('Download JSON').click();assert.match(f.downloads[0].name,/^TEST_ONLY-/);assert.equal(JSON.parse(await f.downloads[0].blob.text()).synthetic,true);f.document.getElementById('usage-export-dialog').close();await f.button('Return to live').click();assert.equal(f.document.getElementById('usage-demo-dialog').open,false);assert.equal(JSON.stringify({events:[...real.events],newTotal:real.newTotal}),state);assert.equal(f.document.activeElement,f.invoker);
 }finally{f.workspace.destroy();}
});

test('known live access loss revokes an open export and pending PNG, while an isolated synthetic preview remains usable',async()=>{
 let finish;const f=fixture({makePNG:()=>new Promise(resolve=>{finish=resolve;})});try{
  f.workspace.openExport(payload());const pending=f.button('Download PNG').click();f.workspace.invalidate();assert.equal(f.document.getElementById('usage-export-dialog').open,false);assert.equal(f.pre().textContent,'');assert.equal(f.document.getElementById('usage-export-identities').checked,false);assert.equal(f.button('Download JSON').disabled,true);finish(new Blob(['TEST_ONLY']));await pending;await f.button('Download JSON').click();assert.equal(f.downloads.length,0);
  f.workspace.openDemo();await f.button('Preview synthetic export').click();f.workspace.invalidate();assert.equal(f.document.getElementById('usage-export-dialog').open,true);await f.button('Download JSON').click();assert.equal(f.downloads.length,1);assert.match(f.downloads[0].name,/^TEST_ONLY-/);
 }finally{f.workspace.destroy();}
});

test('the actual app authorization invalidation callback revokes exports before potentially fallible motion work',async()=>{
 const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8'),start=source.indexOf('onInvalidate:()=>{'),end=source.indexOf(',getPalette:',start);assert.ok(start>0&&end>start);const f=fixture();try{
  f.workspace.openExport(payload());let handoffInvalidations=0;const context=vm.createContext({settingsWorkspace:{invalidate(){}},githubWorkspace:{invalidate(){}},snapshotAuthorized:true,investigation:{invalidate(){}},handoffWorkspace:{invalidate(){handoffInvalidations++;}},usageExportWorkspace:f.workspace,tokenUsagePayload:payload(),burnSpikeTracker:{clear(){}},browserAlarms:{clear(){}},syncTokenUsage(){throw new Error('TEST_ONLY render failure');}}),invalidate=vm.runInContext('('+source.slice(start+'onInvalidate:'.length,end)+')',context);assert.throws(invalidate,/TEST_ONLY render failure/);assert.equal(handoffInvalidations,1);assert.equal(f.document.getElementById('usage-export-dialog').open,false);assert.equal(f.pre().textContent,'');await f.button('Download JSON').click();assert.equal(f.downloads.length,0);
 }finally{f.workspace.destroy();}
});
