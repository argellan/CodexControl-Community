// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import path from 'node:path';

export const TASK_LABEL_SOURCE='codex-session-index';
const empty=()=>({taskLabel:null,taskLabelSource:null,taskLabelUpdatedAt:null});
const clean=value=>typeof value==='string'?[...value.replace(/[\x00-\x1f\x7f]/g,'').trim()].slice(0,120).join(''):null;
const id=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\x00-\x1f\x7f]/.test(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const stamp=value=>typeof value==='string'&&value.length<=64&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;

export function normalizeTaskLabelMetadata(value,{reference}={}){
 if(!object(value)||value.taskLabelSource!==TASK_LABEL_SOURCE)return empty();
 const taskLabel=clean(value.taskLabel);if(!taskLabel)return empty();
 const taskLabelUpdatedAt=stamp(value.taskLabelUpdatedAt);
 // Current assignment metadata must never masquerade as a historical title.
 if(reference!==undefined&&(!Number.isFinite(reference)||!taskLabelUpdatedAt||Date.parse(taskLabelUpdatedAt)>reference))return empty();
 return {taskLabel,taskLabelSource:TASK_LABEL_SOURCE,taskLabelUpdatedAt};
}

export function sessionIndexPath(file,{sessionRoot}={}){
 if(typeof file!=='string'||!file||/[\x00-\x1f\x7f]/.test(file))return null;
 const paths=/^(?:[A-Za-z]:[\\/]|\\\\)/.test(file)?path.win32:path.posix;
 if(!paths.isAbsolute(file))return null;
 if(sessionRoot!==undefined){
  if(typeof sessionRoot!=='string'||!paths.isAbsolute(sessionRoot))return null;
  const relative=paths.relative(sessionRoot,file);if(!relative||relative==='..'||relative.startsWith('..'+paths.sep)||paths.isAbsolute(relative))return null;
  return paths.join(paths.dirname(sessionRoot),'session_index.jsonl');
 }
 let directory=paths.dirname(paths.normalize(file));
 // Only the file's own native sessions ancestor establishes its Codex home.
 for(let depth=0;depth<12;depth++){
  if(paths.basename(directory).toLowerCase()==='sessions')return paths.join(paths.dirname(directory),'session_index.jsonl');
  const parent=paths.dirname(directory);if(parent===directory)break;directory=parent;
 }
 return null;
}

export class TaskLabelReader {
 constructor({maxBytes=2097152,pollMs=2000,now=Date.now}={}){
  this.maxBytes=Number.isSafeInteger(maxBytes)?Math.max(16384,Math.min(2097152,maxBytes)):2097152;
  this.pollMs=Number.isSafeInteger(pollMs)?Math.max(250,Math.min(60000,pollMs)):2000;
  this.now=typeof now==='function'?now:Date.now;this.cache=new Map();
 }
 async index(file){
  const now=this.now(),previous=this.cache.get(file);
  if(previous?.pending)return previous.pending;
  if(previous&&Number.isFinite(now)&&now>=previous.checkedAt&&now-previous.checkedAt<this.pollMs)return previous.labels;
  const entry={checkedAt:now,signature:null,labels:new Map(),pending:null};
  this.cache.delete(file);this.cache.set(file,entry);
  while(this.cache.size>8)this.cache.delete(this.cache.keys().next().value);
  entry.pending=(async()=>{
   let handle;
   try{
    const link=await fs.lstat(file);if(!link.isFile()||link.isSymbolicLink())return entry.labels;
    handle=await fs.open(file,'r');const stat=await handle.stat();if(!stat.isFile())return entry.labels;
    const signature=[stat.size,stat.mtimeMs,stat.birthtimeMs,stat.ino].join(':');entry.signature=signature;
    if(previous?.signature===signature){entry.labels=previous.labels;return entry.labels;}
    const count=Math.min(stat.size,this.maxBytes),offset=stat.size-count,buffer=Buffer.alloc(count);
    const read=await handle.read(buffer,0,count,offset);let content=buffer.subarray(0,read.bytesRead).toString('utf8');
    if(offset>0){const newline=content.indexOf('\n');if(newline<0)return entry.labels;content=content.slice(newline+1);}
    const lines=content.split('\n'),versions=new Map();let inspected=0;
    for(let n=lines.length-1;n>=0&&inspected<4096;n--){
     const line=lines[n];if(!line.trim())continue;inspected++;if(Buffer.byteLength(line)>16384)continue;
     let record;try{record=JSON.parse(line);}catch{continue;}
     if(!object(record)||Object.keys(record).some(key=>!['id','thread_name','updated_at'].includes(key))||!id(record.id)||typeof record.thread_name!=='string')continue;
     const metadata=normalizeTaskLabelMetadata({taskLabel:record.thread_name,taskLabelSource:TASK_LABEL_SOURCE,taskLabelUpdatedAt:record.updated_at});
     const at=Date.parse(stamp(record.updated_at)),oldAt=versions.get(record.id);
     if(!entry.labels.has(record.id)||Number.isFinite(at)&&(!Number.isFinite(oldAt)||at>oldAt)){entry.labels.set(record.id,metadata);versions.set(record.id,at);}
    }
    return entry.labels;
   }catch{return entry.labels;}finally{if(handle)await handle.close();}
  })();
  try{return await entry.pending;}finally{entry.pending=null;}
 }
 async read(file,sessionId,options={}){
  const index=sessionIndexPath(file,options);if(!index||!id(sessionId))return empty();
  const metadata=(await this.index(index)).get(sessionId);return normalizeTaskLabelMetadata(metadata,options);
 }
}
