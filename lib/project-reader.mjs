// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {readProjectActivity} from './project-activity.mjs';
const unavailable=()=>Object.assign(new Error('Project activity unavailable'),{status:503});
if(!isMainThread&&workerData?.kind==='project-reader'){
 parentPort.on('message',({id,options})=>{let db;try{db=new DatabaseSync(workerData.file,{readOnly:true});db.exec('PRAGMA busy_timeout=1000;BEGIN');const value=readProjectActivity(db,options);db.exec('COMMIT');parentPort.postMessage({id,value});}catch(error){parentPort.postMessage({id,error:{status:[400,403].includes(error.status)?error.status:503}});}finally{db?.close();}});
}
// One lazy worker, four admitted reads, no periodic collection. Large retained
// projections must not occupy the HTTP/ingestion event loop. Idle threads exit.
export function createProjectReader(file){
 let worker=null,closed=false,sequence=0,idle=null;const pending=new Map(),terminations=new Set();
 const terminate=target=>{if(!target)return;const promise=target.terminate();terminations.add(promise);void promise.finally(()=>terminations.delete(promise));};
 const stopIdle=()=>{clearTimeout(idle);idle=null;};
 const failAll=()=>{for(const {reject,timer} of pending.values()){clearTimeout(timer);reject(unavailable());}pending.clear();};
 const start=()=>{if(worker)return worker;const current=new Worker(new URL(import.meta.url),{workerData:{kind:'project-reader',file},resourceLimits:{maxOldGenerationSizeMb:128}});worker=current;
  current.on('message',message=>{if(worker!==current)return;const request=pending.get(message?.id);if(!request)return;pending.delete(message.id);clearTimeout(request.timer);if(message.error)request.reject(Object.assign(new Error('Project activity unavailable'),{status:message.error.status}));else request.resolve(message.value);if(!pending.size){idle=setTimeout(()=>{if(worker===current&&!pending.size){worker=null;terminate(current);}},30000);idle.unref();}});
  current.on('error',()=>{if(worker===current){worker=null;stopIdle();failAll();}});current.on('exit',()=>{if(worker===current){worker=null;stopIdle();if(pending.size)failAll();}});return current;
 };
 return {read(options){if(closed)return Promise.reject(unavailable());if(pending.size>=4)return Promise.reject(Object.assign(new Error('Project reader busy'),{status:429}));stopIdle();return new Promise((resolve,reject)=>{let current;try{current=start();}catch{reject(unavailable());return;}const id=++sequence,timer=setTimeout(()=>{if(worker===current){worker=null;failAll();terminate(current);}},30000);pending.set(id,{resolve,reject,timer});current.postMessage({id,options});});},async close(){if(closed)return;closed=true;stopIdle();const current=worker;worker=null;failAll();terminate(current);await Promise.all([...terminations]);}};
}
