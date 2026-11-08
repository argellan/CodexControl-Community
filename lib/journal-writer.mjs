// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import {Worker} from 'node:worker_threads';
import {StorageBackpressure} from './storage-admission.mjs';
const natural=value=>Number.isSafeInteger(value)&&value>=0;
const uncertain=message=>Object.assign(new Error(message),{code:'JOURNAL_WRITER_UNCERTAIN',status:503,journalOutcome:'uncertain'});
function validResult(value,expected){
 return value?.schemaVersion===1&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.epoch)&&
 ['added','latestSequence','retentionFloor','gapThrough','retainedEvents','retainedBytes','maxEvents','maxBytes','maxAgeMs'].every(key=>natural(value[key]))&&
 value.added<=expected.events&&value.retainedEvents>=value.added&&value.latestSequence>=value.retainedEvents&&value.retentionFloor<=value.latestSequence&&value.gapThrough<=value.latestSequence&&
 value.scope==='fleet'&&value.completeHistory===false&&value.eventArchive?.status==='not-configured'&&value.eventArchive.receiptRequired===true&&value.eventArchive.pendingRecords===value.retainedEvents&&
 value.samples?.received===expected.samples&&natural(value.samples.added)&&natural(value.samples.duplicates)&&value.samples.added+value.samples.duplicates===expected.samples&&
 (expected.processes===0||value.processes?.received===expected.processes&&natural(value.processes.added)&&natural(value.processes.duplicates)&&value.processes.added+value.processes.duplicates===expected.processes);
}
function validError(value){return value&&typeof value.message==='string'&&value.message.length<=512&&
 (value.code===undefined||typeof value.code==='string'&&/^[A-Z0-9_]{1,128}$/.test(value.code))&&
 (value.status===undefined||[400,401,403,409,413,429,500,503].includes(value.status))&&
 (value.sqliteCode===undefined||natural(value.sqliteCode)&&value.sqliteCode<=2147483647)&&
 (value.retryAfter===undefined||Number.isSafeInteger(value.retryAfter)&&value.retryAfter>=1&&value.retryAfter<=3600)&&
 ['not-started','rolled-back','uncertain'].includes(value.journalOutcome);}
// Exactly one command in flight; FleetHub owns the bounded parent FIFO.
export class JournalWriter {
 constructor(journal,{timeoutMs=15000}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>60000)throw new Error('Invalid journal writer deadline');
  this.timeoutMs=timeoutMs;this.sequence=0;this.pending=null;this.closed=false;this.closing=false;
  this.worker=new Worker(new URL('./journal-worker.mjs',import.meta.url),{workerData:{file:journal.file,maxEvents:journal.maxEvents,maxBytes:journal.maxBytes,maxAgeMs:journal.maxAgeMs}});
  this.exited=new Promise(resolve=>{this.worker.once('exit',code=>{this.closed=true;this.closing=true;this.finish(this.failure||uncertain('Journal writer exited before confirmation'));resolve(code);});});
  this.worker.on('error',()=>{void this.abort(uncertain('Journal writer failed before confirmation'));});
  this.worker.on('messageerror',()=>{void this.abort(uncertain('Journal writer response could not be decoded'));});
  this.worker.on('message',message=>{
   if(this.closing)return;
   const pending=this.pending;
   if(!pending||message?.id!==pending.id||!['committed','rejected'].includes(message?.kind)){void this.abort(uncertain('Invalid journal writer response'));return;}
   if(message.kind==='committed'){
    if(!validResult(message.result,pending.expected)){void this.abort(uncertain('Invalid journal commit confirmation'));return;}
    this.finish(null,message.result);return;
   }
   const data=message.error;
   if(!validError(data)){void this.abort(uncertain('Invalid journal rejection'));return;}
   if(data.journalOutcome==='uncertain'){void this.abort(Object.assign(uncertain('Journal write outcome is uncertain'),{cause:{code:data.code,sqliteCode:data.sqliteCode,message:data.message}}));return;}
   if(data.code==='STORAGE_BACKPRESSURE'){
    if(data.journalOutcome!=='rolled-back'||data.status!==503||data.retryAfter!==60){void this.abort(uncertain('Invalid storage admission rejection'));return;}
    this.finish(Object.assign(new StorageBackpressure(),{journalOutcome:'rolled-back'}));return;
   }
   const error=Object.assign(new Error(data.message),{journalOutcome:data.journalOutcome});
   for(const key of ['code','sqliteCode','status','retryAfter'])if(data[key]!==undefined)error[key]=data[key];this.finish(error);
  });
  this.worker.unref();
 }
 finish(error,value){const pending=this.pending;if(!pending)return;this.pending=null;clearTimeout(pending.timer);this.worker.unref();if(error)pending.reject(error);else pending.resolve(value);}
 commit(payload,storageAdmission){
  if(this.closed||this.closing||this.pending)return Promise.reject(Object.assign(new Error('Journal writer unavailable'),{code:'JOURNAL_WRITER_UNAVAILABLE',status:503,journalOutcome:'not-started'}));
  let expected;try{const args=JSON.parse(payload);expected={events:args.events?.length??0,samples:args.usageSamples?.length??0,processes:args.processSamples?.length??0};}catch{return Promise.reject(Object.assign(new Error('Invalid journal command'),{journalOutcome:'not-started'}));}
  const id=this.sequence+1;this.worker.ref();
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{void this.abort(uncertain('Journal confirmation deadline exceeded'));},this.timeoutMs);
   this.pending={id,expected,timer,resolve,reject};
   try{this.worker.postMessage({id,payload,storageAdmission});this.sequence=id;}catch{void this.abort(Object.assign(new Error('Journal command could not be posted'),{code:'JOURNAL_WRITER_POST',status:503,journalOutcome:'not-started'}));}
  });
 }
 abort(error=uncertain('Journal writer stopped before confirmation')){
  this.closing=true;this.failure??=error;
  this.termination??=(async()=>{if(!this.closed)await this.worker.terminate();await this.exited;})();
  return this.termination;
 }
 close(){return this.abort();}
}
