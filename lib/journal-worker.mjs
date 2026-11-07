// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import {parentPort,workerData} from 'node:worker_threads';
import {HistoryJournal} from './history.mjs';
import {storageAdmissionOptions} from './storage-admission.mjs';
const journal=Object.assign(new HistoryJournal(),workerData);
let lastId=0;
parentPort.on('message',message=>{
 if(!Number.isSafeInteger(message?.id)||message.id!==lastId+1||typeof message.payload!=='string')throw new Error('Invalid journal writer command');
 lastId=message.id;
 try{
  journal.storageAdmission=storageAdmissionOptions(message.storageAdmission);
  const result=journal.commit(JSON.parse(message.payload));
  parentPort.postMessage({id:message.id,kind:'committed',result});
 }catch(error){
  parentPort.postMessage({id:message.id,kind:'rejected',error:{message:String(error.message).slice(0,512),code:error.code,sqliteCode:Number.isInteger(error.errcode)?error.errcode:undefined,status:error.status,retryAfter:error.retryAfter,journalOutcome:error.journalOutcome||'uncertain'}});
 }
});
