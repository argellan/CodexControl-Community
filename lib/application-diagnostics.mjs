// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import crypto from 'node:crypto';
import {ConsentGate,SyntheticSender,syntheticReport} from './diagnostics-telemetry.mjs';
import {exact,CATEGORIES} from '../public/diagnostics-schema.mjs';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
// This application adapter accepts no report content. It creates only constant
// synthetic reports after current registered account authority is established.
export class ApplicationDiagnostics {
 #configuration; #current; #records=new Map(); #revision=0; #recipient=crypto.randomUUID(); #receiver=false; #backend=false; #timer=null; #pumping=false; #closed=false; #rateWindow=-1; #rateCount=0;
 constructor({configuration,currentOwner}={}){
  if(configuration!==undefined&&(!exact(configuration,['mode','receiverPort'])||configuration.mode!=='synthetic-only'||!Number.isSafeInteger(configuration.receiverPort)||configuration.receiverPort<1||configuration.receiverPort>65535))fail('Use an explicitly configured synthetic loopback receiver');
  this.#configuration=configuration;this.#current=currentOwner;
 }
 #eligible(viewer){return !!this.#configuration&&!!viewer&&!['local','legacy'].includes(viewer.id)&&typeof viewer.profileKey==='string'&&/^[a-f0-9]{64}$/.test(viewer.profileKey)&&typeof viewer.diagnosticClientKey==='string'&&/^[a-f0-9]{64}$/.test(viewer.diagnosticClientKey)&&!!this.#current?.(viewer.id);}
 #admin(viewer){if(!this.#eligible(viewer)||viewer.role!=='admin'||viewer.hostIds!==null||viewer.projectIds!==null)fail('Authenticated unrestricted administrator required',403);}
 #clearRow(row){row.gate.choose({revision:row.gate.status().revision,schemaVersion:1,browser:false});row.until=0;}
 #recipientFor(row){return crypto.createHash('sha256').update(this.#recipient+'\0'+row.epoch).digest('hex');}
 #record(viewer){
  if(!this.#eligible(viewer))return null;
  const key=viewer.diagnosticClientKey;let row=this.#records.get(key);
  for(const [oldKey,old] of this.#records){if(oldKey!==key&&old.until<=Date.now()&&!old.sender.count()){old.sender.close();this.#records.delete(oldKey);}}
  if(row&&row.until<=Date.now())this.#clearRow(row);
  if(!row){if(this.#records.size>=64)fail('Synthetic consent capacity reached',429);const gate=new ConsentGate({ownershipVerified:true});gate.authorize({revision:0,schemaVersion:1,receiver:this.#receiver,backend:this.#backend});row={ownerId:viewer.id,admin:viewer.role==='admin'&&viewer.hostIds===null&&viewer.projectIds===null,epoch:crypto.randomUUID(),gate,sender:new SyntheticSender({receiverPort:this.#configuration.receiverPort,gate}),until:0};this.#records.set(key,row);}
  row.until=Math.min(Date.now()+900000,viewer.diagnosticAuthorityUntil??Date.now());return row;
 }
 state(viewer){const row=this.#record(viewer);return {available:!!row,mode:'synthetic-only',schemaVersion:1,revision:row?.gate.status().revision??0,adminRevision:this.#revision,recipientRevision:row?this.#recipientFor(row):this.#recipient,receiverApproved:this.#receiver,backend:this.#backend,browser:row?.gate.status().browser??false,queued:row?.sender.count()??0,recipient:row?'Configured loopback synthetic test receiver on port '+this.#configuration.receiverPort:'Unavailable: explicit synthetic receiver and current named account required',realReporting:false};}
 authorize(viewer,body){
  this.#admin(viewer);if(body.schemaVersion!==1||body.revision!==this.#revision)fail('Stale administrator consent or schema',409);
  this.#receiver=body.receiver;this.#backend=body.receiver&&body.backend;this.#revision++;this.#recipient=crypto.randomUUID();
  for(const row of this.#records.values())row.gate.authorize({revision:row.gate.status().revision,schemaVersion:1,receiver:this.#receiver,backend:this.#backend});
  return this.state(viewer);
 }
 choose(viewer,body){
  const row=this.#record(viewer);if(!row)fail('Synthetic sharing unavailable',503);
  if(body.browser&&(body.schemaVersion!==1||body.recipientRevision!==this.#recipientFor(row)))fail('Recipient or schema changed; renew consent',409);
  row.gate.choose({revision:body.revision,schemaVersion:body.schemaVersion,browser:body.browser});return this.state(viewer);
 }
 enqueue(viewer,body){
  const row=this.#record(viewer);if(!row)fail('Synthetic sharing unavailable',503);
  if(body.schemaVersion!==1||body.recipientRevision!==this.#recipientFor(row))fail('Recipient or schema changed; renew consent',409);
  if(body.category!==undefined&&(body.class!=='browser'||body.revision!==row.gate.status().revision))fail('Stale browser producer grant',409);
  if(body.class==='backend')this.#admin(viewer);
  if(!row.gate.permits(body.class))fail('Explicit sharing consent required',403);
  // Global cap remains 20 constant reports (<16 KiB encoded), across all users.
  if([...this.#records.values()].reduce((sum,r)=>sum+r.sender.count(),0)>=20)fail('Synthetic queue full',429);
  if(!this.#admit())fail('Synthetic producer rate limit',429);
  if(!row.sender.enqueue(syntheticReport(body.class,body.category,body.count)))fail('Synthetic queue full',429);
  this.#schedule(100);return this.state(viewer);
 }
 #admit(){const minute=Math.floor(Date.now()/60000);if(minute!==this.#rateWindow){this.#rateWindow=minute;this.#rateCount=0;}return this.#rateCount++<30;}
 // Future fixed backend categories only; never enumerate or replay local history.
 captureBackend(event){
  if(this.#closed||!this.#receiver||!this.#backend||event.kind!=='backend'||!CATEGORIES.includes(event.category))return;
  const row=[...this.#records.values()].find(r=>r.admin&&r.until>Date.now()&&this.#current?.(r.ownerId)&&r.gate.permits('backend'));
  if(!row||[...this.#records.values()].reduce((n,r)=>n+r.sender.count(),0)>=20||!this.#admit())return;
  if(row.sender.enqueue(syntheticReport('backend',event.category,1)))this.#schedule(100);
 }
 revoke(id,clientKey){for(const [key,row] of this.#records)if(row.ownerId===id&&(!clientKey||key===clientKey))this.#clearRow(row);}
 revokeAll(){this.#receiver=false;this.#backend=false;this.#revision++;this.#recipient=crypto.randomUUID();for(const row of this.#records.values()){row.gate.authorize({revision:row.gate.status().revision,schemaVersion:1,receiver:false,backend:false});row.until=0;}}
 #schedule(ms){if(this.#closed||this.#timer)return;this.#timer=setTimeout(()=>{this.#timer=null;void this.#pump();},ms);this.#timer.unref();}
 async #pump(){
  if(this.#closed||this.#pumping)return;this.#pumping=true;
  try{for(const row of this.#records.values()){if(!this.#current?.(row.ownerId)||row.until<=Date.now()){this.#clearRow(row);continue;}if(row.sender.count()){await row.sender.pump();break;}}}
  finally{this.#pumping=false;if([...this.#records.values()].some(row=>row.sender.count()))this.#schedule(1000);}
 }
 close(){this.#closed=true;clearTimeout(this.#timer);for(const row of this.#records.values())row.sender.close();this.#records.clear();}
}