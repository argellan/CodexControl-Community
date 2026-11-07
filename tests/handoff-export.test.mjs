// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareHandoff,reviewedHandoff,handoffZip} from '../public/handoff-export.mjs';
import {mountHandoff} from '../public/handoff-workspace.mjs';
const event=(n,extra={})=>({id:'private-event-'+n,hostId:'private-host',sessionId:'private-worker',project:'PRIVATE_PROJECT',at:new Date(1800000000000+n*1000).toISOString(),kind:'tool.end',category:'command',outcome:'recorded',durationMs:20,...extra});
test('handoff excludes source text and raw identities, preserves input and requires review',async()=>{
 const source={events:[event(1,{label:'PRIVATE_LABEL',arguments:'PRIVATE_ARGUMENT',output:'PRIVATE_OUTPUT',reasoning:'PRIVATE_REASONING',token:'PRIVATE_CREDENTIAL'})],mode:'replay',knownGaps:1},before=JSON.stringify(source),packet=await prepareHandoff(source);
 assert.equal(JSON.stringify(source),before);assert.equal(packet.snapshot.mode,'replay');assert.equal(packet.snapshot.coverage.knownGaps,1);assert.equal(packet.snapshot.coverage.completeHistory,false);
 assert(!/PRIVATE_|private-host|private-worker|private-event/.test(packet.json));assert.equal(packet.snapshot.observations[0].worker,'worker-001');assert.equal(packet.snapshot.observations[0].day.length,10);
 await assert.rejects(reviewedHandoff(packet),/review/);assert(Object.isFrozen(packet.snapshot.observations[0]));
});
test('handoff hashes are deterministic, version-sensitive and independently verifiable',async()=>{
 const a=await prepareHandoff({events:[event(2),event(1)]}),b=await prepareHandoff({events:[event(1),event(2)]}),c=await prepareHandoff({events:[event(1),event(2,{outcome:'failed'})]});assert.equal(a.fingerprint,b.fingerprint);assert.notEqual(a.fingerprint,c.fingerprint);
 const result=await reviewedHandoff(a,{reviewed:true,summary:'Reviewed <script> and [unsafe](javascript:alert(1))'});
 assert.equal(result.manifest.snapshotSha256,createHash('sha256').update(a.json).digest('hex'));assert.equal(result.manifest.review.outcomesIndependentlyVerified,false);
 for(const row of result.manifest.files){const bytes=result.files.find(f=>f.name===row.path).bytes;assert.equal(bytes.length,row.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),row.sha256);}
 const md=new TextDecoder().decode(result.files[0].bytes);assert(!md.includes('<script>'));assert(md.includes('not independent verification'));assert(md.includes('new, uniquely named folder'));
});
test('bounded handoff discloses truncation and does not delete the selected history',async()=>{
 const events=Array.from({length:1020},(_,i)=>event(i)),packet=await prepareHandoff({events});assert.equal(packet.snapshot.observations.length,1000);assert.equal(packet.snapshot.coverage.selectedCandidates,1020);assert.equal(packet.snapshot.coverage.truncated,true);assert.equal(events.length,1020);
 await assert.rejects(reviewedHandoff(await prepareHandoff({events:[]}),{reviewed:true}),/Select captured/);
});
test('ZIP has only fixed safe paths, CRC-protected entries and exact manifest payloads',async()=>{
 const result=await reviewedHandoff(await prepareHandoff({events:[event(1)]}),{reviewed:true}),zip=handoffZip(result.files),view=new DataView(zip.buffer);let at=0;const decoded=[];
 while(view.getUint32(at,true)===0x04034b50){const length=view.getUint32(at+18,true),nameLength=view.getUint16(at+26,true),name=new TextDecoder().decode(zip.subarray(at+30,at+30+nameLength));decoded.push(name);assert.deepEqual(zip.subarray(at+30+nameLength,at+30+nameLength+length),result.files.find(f=>f.name===name).bytes);at+=30+nameLength+length;}
 assert.equal(view.getUint32(at,true),0x02014b50);assert.deepEqual(decoded,['CodexControl-Handoff.md','observations.json','manifest.json']);assert.equal(view.getUint32(zip.length-22,true),0x06054b50);assert.throws(()=>handoffZip([{name:'../escape',bytes:new Uint8Array()}]),/Invalid/);
});


test('handoff preserves the current supported metadata kinds and escapes reviewer Markdown literally',async()=>{
 const kinds=['operation','remote.start','remote.end','remote.progress'],packet=await prepareHandoff({events:kinds.map((kind,i)=>event(i,{kind,category:'remote'}))});
 assert.deepEqual(packet.snapshot.observations.map(e=>e.kind),kinds);
 const summary='---\n- item\n1. ordered\n~~strike~~\n$$math$$\n%%comment%%\nhttps://example.invalid';
 const result=await reviewedHandoff(packet,{reviewed:true,summary}),md=new TextDecoder().decode(result.files[0].bytes),section=md.split('## Reviewer summary\n')[1].split('\n## Recorded activity')[0];
 const expected=String.raw`\-\-\-
\- item
1\. ordered
\~\~strike\~\~
\$\$math\$\$
\%\%comment\%\%
https\:\/\/example\.invalid`;
 assert.equal(section.trim(),expected);
 assert.match(md,/new, uniquely named folder/);assert.match(md,/Do not overwrite/);
});

function workspaceFixture({queuedClose=false,authorize}={}){
 const nodes=[],pendingClose=[],downloads=[];let active=null;
 const document={get activeElement(){return active;},querySelectorAll(){return nodes.filter(n=>n.tagName==='DIALOG'&&n.open);},createElement(tag){
  const n={tagName:tag.toUpperCase(),children:[],attributes:{},listeners:new Map(),isConnected:false,open:false,disabled:false,checked:false,value:'',textContent:'',setAttribute(k,v){this.attributes[k]=v;},append(...children){this.children.push(...children);for(const c of children)c.isConnected=this.isConnected;},addEventListener(type,handler){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(handler);},async emit(type){for(const f of this.listeners.get(type)||[])await f({target:this});},focus(){active=this;},showModal(){this.open=true;},close(){if(!this.open)return;this.open=false;const run=()=>{for(const f of this.listeners.get('close')||[])f({target:this});};if(queuedClose)pendingClose.push(run);else run();},remove(){this.isConnected=false;},click(){return this.emit('click');}};
  nodes.push(n);return n;
 }};
 document.body=document.createElement('body');document.body.isConnected=true;const invoker=document.createElement('button');invoker.isConnected=true;invoker.focus();
 const selected={events:[event(1)],mode:'live',knownGaps:0,authorityStamp:'authority-A'},window={Blob,URL:{revokeObjectURL(){}},clearTimeout(){}};
 const workspace=mountHandoff({document,window,getSelection:()=>selected,authorize,saveBlob:async(blob,name)=>downloads.push({blob,name})}),find=predicate=>nodes.find(predicate);
 return {workspace,selected,downloads,invoker,document,flushClose(){for(const f of pendingClose.splice(0))f();},dialog:find(n=>n.tagName==='DIALOG'),review:find(n=>n.type==='checkbox'),summary:find(n=>n.tagName==='TEXTAREA'),preview:find(n=>n.tagName==='PRE'),status:find(n=>n.attributes.role==='status'),download:find(n=>n.tagName==='BUTTON'&&n.textContent==='Download reviewed export')};
}

test('workspace cannot confirm before preview, freezes selected events and resets review on summary edits',async()=>{
 const f=workspaceFixture();try{const opening=f.workspace.open();assert.equal(f.review.disabled,true);assert.equal(f.download.disabled,true);f.selected.events[0].outcome='failed';f.selected.events.push(event(2));await opening;
 assert.equal(f.review.disabled,false);assert.equal(f.review.checked,false);const shown=JSON.parse(f.preview.textContent);assert.equal(shown.observations.length,1);assert.equal(shown.observations[0].outcome,'recorded');
 f.review.checked=true;await f.review.emit('change');assert.equal(f.download.disabled,false);f.summary.value='Updated summary';await f.summary.emit('input');assert.equal(f.review.checked,false);assert.equal(f.download.disabled,true);
 f.review.checked=true;await f.review.emit('change');await f.download.click();assert.equal(f.downloads.length,1);
 }finally{f.workspace.destroy();}
});

test('workspace invalidation blocks late preview and late export and restores focus',async()=>{
 const f=workspaceFixture();try{const opening=f.workspace.open();f.workspace.invalidate();await opening;assert.equal(f.dialog.open,false);assert.equal(f.preview.textContent,'');assert.equal(f.downloads.length,0);assert.equal(f.document.activeElement,f.invoker);
 await f.workspace.open();f.review.checked=true;await f.review.emit('change');const downloading=f.download.click();f.workspace.invalidate();await downloading;assert.equal(f.downloads.length,0);assert.equal(f.preview.textContent,'');
 }finally{f.workspace.destroy();}
});

test('a queued close from an earlier opening cannot clear a newly reviewed preview',async()=>{
 const f=workspaceFixture({queuedClose:true});try{await f.workspace.open();const next=f.workspace.open();f.flushClose();await next;assert.equal(f.dialog.open,true);assert.notEqual(f.preview.textContent,'');assert.equal(f.review.disabled,false);
 }finally{f.workspace.destroy();}
});


test('authority is freshly checked before preparing or exporting with the stamp frozen at opening',async()=>{
 const stamps=[];let resolve,granted=true;const f=workspaceFixture({authorize:stamp=>{stamps.push(stamp);return stamps.length===1?new Promise(r=>{resolve=r;}):granted;}});
 try{const opening=f.workspace.open();assert.equal(f.preview.textContent,'');assert.equal(f.review.disabled,true);f.selected.events[0].outcome='failed';f.selected.authorityStamp='authority-B';resolve(true);await opening;assert.equal(JSON.parse(f.preview.textContent).observations[0].outcome,'recorded');
 f.review.checked=true;await f.review.emit('change');granted=false;await f.download.click();assert.deepEqual(stamps,['authority-A','authority-A']);assert.equal(f.downloads.length,0);assert.equal(f.preview.textContent,'');assert.equal(f.download.disabled,true);assert.match(f.status.textContent,/sign in.*refresh/i);
 }finally{f.workspace.destroy();}
});

test('unknown and failed authority probes refuse cached data on every opening',async()=>{
 for(const authorize of [async()=>false,async()=>undefined,async()=>{throw new Error('PRIVATE_FAILURE');}]){
 const f=workspaceFixture({authorize});try{await f.workspace.open();assert.equal(f.preview.textContent,'');assert.equal(f.download.disabled,true);assert.match(f.status.textContent,/sign in.*refresh/i);assert.doesNotMatch(f.status.textContent,/PRIVATE_FAILURE/);await f.workspace.open();assert.equal(f.preview.textContent,'');assert.equal(f.downloads.length,0);}finally{f.workspace.destroy();}
 }
});


test('invalidation while ZIP manifest hashes are pending suppresses the eventual download',async()=>{
 const f=workspaceFixture(),subtle=globalThis.crypto.subtle,original=subtle.digest;let release;
 try{await f.workspace.open();f.review.checked=true;await f.review.emit('change');let started;const hashing=new Promise(r=>{started=r;}),gate=new Promise(r=>{release=r;});subtle.digest=async(...args)=>{started();await gate;return original.apply(subtle,args);};
 const request=f.download.click();await hashing;f.workspace.invalidate();release();await request;assert.equal(f.downloads.length,0);assert.equal(f.preview.textContent,'');assert.equal(f.dialog.open,false);
 }finally{subtle.digest=original;release?.();f.workspace.destroy();}
});
