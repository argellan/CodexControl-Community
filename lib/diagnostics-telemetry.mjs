// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {APPLICATION_VERSION} from '../public/build-info.mjs';
import {LIMITS,validateSyntheticReport,exact} from '../public/diagnostics-schema.mjs';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export function syntheticReport(reportClass='browser',category='unexpected',count=1) {
  return validateSyntheticReport({schemaVersion:1,consentSchemaVersion:1,reportId:crypto.randomUUID(),origin:'synthetic',applicationVersion:APPLICATION_VERSION,class:reportClass,category,count,latencyBucket:'unknown',memoryBucket:'unknown'});
}
export class ConsentGate {
  #revision=0; #receiver=false; #backend=false; #browser=false; #listeners=new Set(); #owned;
  constructor({ownershipVerified=false}={}){this.#owned=ownershipVerified===true;}
  status(){return {revision:this.#revision,schemaVersion:1,receiver:this.#receiver,browser:this.#browser,backend:this.#backend,ownershipVerified:this.#owned};}
  #check(revision,schemaVersion){if(schemaVersion!==1)fail('Consent schema requires renewal',409);if(revision!==this.#revision)fail('Stale consent revision',409);}
  #notify(){this.#revision++;for(const listener of this.#listeners)listener();return this.status();}
  authorize(value){
    if(!exact(value,['revision','schemaVersion','receiver','backend']) || typeof value.receiver!=='boolean'||typeof value.backend!=='boolean')fail('Invalid administrator consent');
    this.#check(value.revision,value.schemaVersion);this.#receiver=value.receiver;this.#backend=this.#receiver&&this.#owned&&value.backend;this.#browser=false;return this.#notify();
  }
  choose(value){
    if(!exact(value,['revision','schemaVersion','browser']) || typeof value.browser!=='boolean')fail('Invalid browser consent');
    // A stale opt-out still closes the gate. A stale enable can never reopen it.
    if(value.browser)this.#check(value.revision,value.schemaVersion);
    this.#browser=this.#receiver&&this.#owned&&value.browser;return this.#notify();
  }
  permits(reportClass){return this.#owned&&this.#receiver&&(reportClass==='browser'?this.#browser:reportClass==='backend'?this.#backend:false);}
  subscribe(listener){this.#listeners.add(listener);return ()=>this.#listeners.delete(listener);}
}

export class SyntheticSender {
  #queue=[]; #active=null; #gate; #unsubscribe; #attempts=0; #closed=false;
  constructor({receiverPort,gate,now=Date.now,random=Math.random}) {
    if(!Number.isSafeInteger(receiverPort)||receiverPort<1||receiverPort>65535)fail('A fixed loopback receiver port is required');
    this.url=`http://127.0.0.1:${receiverPort}/v1/synthetic-reports`;this.now=now;this.random=random;this.#gate=gate;
    this.#unsubscribe=gate.subscribe(()=>{this.#active?.abort();this.#queue=[];});
  }
  #prune(){this.#queue=this.#queue.filter(item=>this.now()-item.created<LIMITS.queueAgeMs&&this.#gate.permits(item.report.class));}
  enqueue(value){
    if(this.#closed)return false;const report=validateSyntheticReport(value);this.#prune();
    if(!this.#gate.permits(report.class)||this.#queue.length>=LIMITS.queue||this.#queue.reduce((sum,item)=>sum+item.bytes,0)+Buffer.byteLength(JSON.stringify(report))>LIMITS.queueBytes)return false;
    if(this.#queue.some(item=>item.report.reportId===report.reportId))return false;
    this.#queue.push({report,bytes:Buffer.byteLength(JSON.stringify(report)),created:this.now(),next:this.now(),attempts:0});return true;
  }
  count(){this.#prune();return this.#queue.length;}
  status(){return {queued:this.count(),attempts:this.#attempts,active:!!this.#active};}
  async pump(){
    this.#prune();const item=this.#queue[0];if(this.#closed||this.#active||!item||item.next>this.now())return;
    const controller=new AbortController();this.#active=controller;const timer=setTimeout(()=>controller.abort(),LIMITS.timeoutMs);timer.unref?.();
    item.attempts++;this.#attempts++;
    try {
      // There is no caller-controlled URL, redirect, credential or persistent identifier.
      const response=await fetch(this.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(item.report),signal:controller.signal,redirect:'error',credentials:'omit'});
      const reader=response.body?.getReader();let bytes=0,text='';
      if(reader){try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>256)fail('Receiver acknowledgment exceeds bound');text+=new TextDecoder().decode(value);}}finally{await reader.cancel().catch(()=>{});}}
      if(controller.signal.aborted||!this.#gate.permits(item.report.class))return;
      if(response.status===200||response.status===202){const ack=JSON.parse(text);if(!exact(ack,['schemaVersion','reportId','accepted'])||ack.schemaVersion!==1||ack.reportId!==item.report.reportId||ack.accepted!==true)fail('Invalid acknowledgment');this.#queue=this.#queue.filter(row=>row!==item);}
      else if([400,409,413,415,426].includes(response.status))this.#queue=this.#queue.filter(row=>row!==item);
      else throw new Error('Synthetic receiver unavailable');
    } catch {if(this.#queue.includes(item)){if(item.attempts>=LIMITS.attempts)this.#queue=this.#queue.filter(row=>row!==item);else item.next=this.now()+Math.min(60000,Math.max(1000,1000*2**(item.attempts-1)*(0.5+Math.max(0,Math.min(1,this.random())))));}}
    finally {clearTimeout(timer);if(this.#active===controller)this.#active=null;}
  }
  close(){this.#closed=true;this.#active?.abort();this.#queue=[];this.#unsubscribe();}
}

export async function openSyntheticReceiver({directory,port=0,now=Date.now}={}) {
  if(!directory)fail('An isolated receiver directory is required');
  if(!Number.isSafeInteger(port)||port<0||port>65535)fail('Invalid local receiver port');
  await fs.mkdir(directory,{recursive:true,mode:0o700});const file=path.join(directory,'reports.json');
  let records=[],inFlight=0,windowStart=now(),requests=0,lostAck=false,offline=false;
  const logs=[];
  const prune=()=>{records=records.filter(row=>row.receivedAt<=now()&&now()-row.receivedAt<LIMITS.receiverAgeMs);};
  try {
    if((await fs.stat(file)).size>LIMITS.receiverBytes)fail('Receiver storage exceeds bound');
    const saved=JSON.parse(await fs.readFile(file,'utf8'));
    if(!Array.isArray(saved)||saved.length>LIMITS.receiverReports)fail('Invalid receiver storage');
    records=saved.map(row=>{if(!exact(row,['receivedAt','report'])||!Number.isSafeInteger(row.receivedAt)||row.receivedAt<0)fail('Invalid receiver record');return {receivedAt:row.receivedAt,report:validateSyntheticReport(row.report)};});prune();
  } catch(error){if(error.code!=='ENOENT')throw new Error('Receiver storage refused; preserve existing files');}
  let writing=false;
  const persist=async candidate=>{
    const text=JSON.stringify(candidate);if(Buffer.byteLength(text)>LIMITS.receiverBytes)fail('Receiver storage full',507);
    const temporary=file+'.pending';const handle=await fs.open(temporary,'w',0o600);
    try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}
    await fs.rename(temporary,file);records=candidate;
  };
  const server=http.createServer(async(req,res)=>{
    const respond=(status,body={schemaVersion:1,status})=>{logs.push({status});if(logs.length>100)logs.shift();res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff',...(status===426?{'supported-schema':'1'}:{}),...(status===429?{'retry-after':'60'}:{})});res.end(JSON.stringify(body));};
    if(inFlight>=2){respond(429);return;}
    inFlight++;
    try{
      if(now()-windowStart>=60000){windowStart=now();requests=0;}
      if(++requests>LIMITS.requestsPerMinute)fail('Rate limit',429);
      if(req.url!=='/v1/synthetic-reports'||req.method!=='POST')fail('Unsupported route',404);
      // No CORS: a website cannot use this test receiver as a browser upload target.
      if(req.headers.origin)fail('Browser uploads prohibited',403);
      if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))fail('JSON required',415);
      if(req.headers['content-encoding'])fail('Encoded request unsupported',415);
      if(offline)fail('Unavailable',503);
      const length=req.headers['content-length'];if(length&&(!/^\d+$/.test(length)||Number(length)>LIMITS.requestBytes))fail('Body too large',413);
      let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>LIMITS.requestBytes)fail('Body too large',413);chunks.push(chunk);}
      let report;try{report=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('Invalid JSON');}
      report=validateSyntheticReport(report);prune();
      if(writing)fail('Storage busy',503);
      const previous=records.find(row=>row.report.reportId===report.reportId);
      if(previous){if(JSON.stringify(previous.report)!==JSON.stringify(report))fail('Idempotency conflict',409);respond(200,{schemaVersion:1,reportId:report.reportId,accepted:true});return;}
      if(records.length>=LIMITS.receiverReports)fail('Storage full',507);
      writing=true;try{await persist([...records,{receivedAt:now(),report}]);}finally{writing=false;}
      if(lostAck){lostAck=false;res.destroy();return;}
      respond(202,{schemaVersion:1,reportId:report.reportId,accepted:true});
    }catch(error){if(!res.destroyed&&!res.writableEnded)respond(error.status||503);}
    finally{inFlight--;}
  });
  server.requestTimeout=3000;server.headersTimeout=3000;server.maxHeadersCount=16;server.maxConnections=4;server.setTimeout(3000,socket=>socket.destroy());
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  port=server.address().port;
  // Purge expired reports at startup and every minute, including when idle.
  const expire=async()=>{if(writing)return;prune();writing=true;try{await persist(records);}catch{}finally{writing=false;}};
  await expire();const retention=setInterval(()=>void expire(),60000);retention.unref();
  return {directory,port,url:`http://127.0.0.1:${port}/v1/synthetic-reports`,count:()=>{prune();return records.length;},logs:()=>structuredClone(logs),loseNextAck:()=>{lostAck=true;},unavailable:value=>{offline=value===true;},async close(){clearInterval(retention);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}