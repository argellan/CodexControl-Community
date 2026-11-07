// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {verifyWindowsArchivePaths} from '../lib/windows-archive-permissions.mjs';
import {fileURLToPath} from 'node:url';
import {installUsageArchive,bootstrapUsageArchive,selectArchiveBatch,acknowledgeArchiveBatch,archiveStatus,setArchiveHealth} from '../lib/usage-archive.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HEX=/^[a-f0-9]{64}$/;
const OUTPUT_LIMIT=131072,MAX_RUN_MS=110000;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const ownKeys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
const absolute=value=>typeof value==='string'&&path.isAbsolute(value)&&value.length<=4096&&!/[\x00-\x1f\x7f]/.test(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const safeCode=error=>['ARCHIVE_LOCKED','ARCHIVE_LOCK_INVALID','ARCHIVE_CONFIG','ARCHIVE_CONFIG_PERMISSIONS','ARCHIVE_PATH','ARCHIVE_TRANSPORT_TIMEOUT','ARCHIVE_TRANSPORT_FAILED','ARCHIVE_TRANSPORT_OUTPUT','ARCHIVE_RECEIPT','ARCHIVE_ABORTED','ARCHIVE_DATABASE'].includes(error?.code)?error.code:'ARCHIVE_FAILED';

// This is an owner-side configuration, never a browser setting. Its only SSH
// credential reference is an absolute file path; key material is not read here.
export function validateArchiveSenderConfig(value){
 if(!ownKeys(value,['version','database','receiverId','ssh','local','maxBatches','maxRecords','maxBytes','bootstrapLimit','timeoutMs'])||value.version!==1||!absolute(value.database)||!UUID.test(value.receiverId||''))fail('ARCHIVE_CONFIG');
 if(Boolean(value.local)===Boolean(value.ssh)||/^(?:\\\\|\/\/)/.test(value.database))fail('ARCHIVE_CONFIG');
 const local=value.local;if(local&&(!ownKeys(local,['python','script','config'])||Object.keys(local).length!==3||Object.values(local).some(v=>!absolute(v)||/^(?:\\\\|\/\/)/.test(v))))fail('ARCHIVE_CONFIG');
 const ssh=value.ssh;if(!local&&(!ownKeys(ssh,['executable','host','port','user','identityFile','knownHostsFile'])||!absolute(ssh.executable)||!absolute(ssh.identityFile)||!absolute(ssh.knownHostsFile)||typeof ssh.host!=='string'||ssh.host.length>253||!/^\w[\w.:-]*$/.test(ssh.host)||typeof ssh.user!=='string'||!/^[_a-zA-Z][_a-zA-Z0-9.-]{0,63}$/.test(ssh.user)||!integer(ssh.port??22,1,65535)))fail('ARCHIVE_CONFIG');
 const limits={maxBatches:value.maxBatches??4,maxRecords:value.maxRecords??1000,maxBytes:value.maxBytes??2097152,bootstrapLimit:value.bootstrapLimit??1000,timeoutMs:value.timeoutMs??20000};
 for(const [key,min,max] of [['maxBatches',1,32],['maxRecords',1,1000],['maxBytes',1024,2097152],['bootstrapLimit',1,1000],['timeoutMs',50,30000]])if(!integer(limits[key],min,max))fail('ARCHIVE_CONFIG');
 return {version:1,database:path.resolve(value.database),receiverId:value.receiverId,...(local?{local:{...local}}:{ssh:{...ssh,port:ssh.port??22}}),...limits};
}

async function checkedFile(file,{privateFile=false,windowsAcl=true}={}){
 if(!absolute(file))fail('ARCHIVE_PATH');
 let stat;try{stat=await fs.lstat(file);}catch{fail('ARCHIVE_PATH');}
 if(stat.isSymbolicLink()||!stat.isFile())fail('ARCHIVE_PATH');
 const real=await fs.realpath(file);if(path.resolve(real)!==path.resolve(file))fail('ARCHIVE_PATH');
 if(process.platform!=='win32'){
  if(privateFile&&(stat.mode&0o077)!==0)fail('ARCHIVE_CONFIG_PERMISSIONS');
  if(stat.uid!==process.getuid()&&stat.uid!==0)fail('ARCHIVE_CONFIG_PERMISSIONS');
  if((stat.mode&0o022)!==0)fail('ARCHIVE_CONFIG_PERMISSIONS');
 }
 if(windowsAcl)await verifyWindowsArchivePaths([{path:path.resolve(file),privateFile}]);
 const after=await fs.lstat(file);if(after.ino!==stat.ino||after.dev!==stat.dev||after.isSymbolicLink())fail('ARCHIVE_PATH');
 return stat;
}
export async function loadArchiveSenderConfig(file){
 const stat=await checkedFile(file,{privateFile:true});if(stat.size>16384)fail('ARCHIVE_CONFIG');
 let value;try{value=JSON.parse(await fs.readFile(file,'utf8'));}catch{fail('ARCHIVE_CONFIG');}
 const config=validateArchiveSenderConfig(value);
 const admission=[{path:config.database,privateFile:true},...(config.local?[{path:config.local.python,privateFile:false},{path:config.local.script,privateFile:false},{path:config.local.config,privateFile:true}]:[{path:config.ssh.executable,privateFile:false},{path:config.ssh.identityFile,privateFile:true},{path:config.ssh.knownHostsFile,privateFile:false}])];
 await verifyWindowsArchivePaths(admission);
 await checkedFile(config.database,{privateFile:true,windowsAcl:false});
 if(config.local){await checkedFile(config.local.python,{windowsAcl:false});await checkedFile(config.local.script,{windowsAcl:false});await checkedFile(config.local.config,{privateFile:true,windowsAcl:false});return config;}
 await checkedFile(config.ssh.identityFile,{privateFile:true,windowsAcl:false});
 await checkedFile(config.ssh.knownHostsFile,{windowsAcl:false});
 const executable=await checkedFile(config.ssh.executable,{windowsAcl:false});if(process.platform!=='win32'&&(executable.mode&0o111)===0)fail('ARCHIVE_PATH');
 return config;
}

export function archiveSshArguments(config){
 const empty=process.platform==='win32'?'NUL':'/dev/null';
 return ['-T','-F',empty,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes','-o','IdentityAgent=none','-o','PreferredAuthentications=publickey','-o','PasswordAuthentication=no','-o','KbdInteractiveAuthentication=no','-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no','-o','ControlMaster=no','-o','ControlPath=none','-o','VerifyHostKeyDNS=no','-o','UpdateHostKeys=no','-o',`GlobalKnownHostsFile=${empty}`,'-o','ConnectTimeout=5','-o','ConnectionAttempts=1','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-o',`UserKnownHostsFile=${config.ssh.knownHostsFile}`,'-i',config.ssh.identityFile,'-p',String(config.ssh.port),'-l',config.ssh.user,'--',config.ssh.host,'archive'];
}

// Exactly one remote forced command receives a bounded gzip stream. Stderr is
// discarded, so remote diagnostics cannot leak private paths into hub health.
export async function sendArchiveOverSsh({config,compressed,signal,timeoutMs=config.timeoutMs},dependencies={}){
 if(!Buffer.isBuffer(compressed)||compressed.length>4194304||!integer(timeoutMs,1,30000))fail('ARCHIVE_TRANSPORT_FAILED');
 const spawnChild=dependencies.spawn??spawn;
 return new Promise((resolve,reject)=>{
  let child,done=false,size=0,stderrSize=0,killTimer;const chunks=[];
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error&&child){child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),250);killTimer.unref();}error?reject(error):resolve(value);};
  const abort=()=>finish(Object.assign(new Error('ARCHIVE_ABORTED'),{code:'ARCHIVE_ABORTED'}));
  const timer=setTimeout(()=>finish(Object.assign(new Error('ARCHIVE_TRANSPORT_TIMEOUT'),{code:'ARCHIVE_TRANSPORT_TIMEOUT'})),timeoutMs);
  if(signal?.aborted){abort();return;}
  signal?.addEventListener('abort',abort,{once:true});
  try{child=spawnChild(config.local?config.local.python:config.ssh.executable,config.local?['-I','-B',config.local.script,'--config',config.local.config]:archiveSshArguments(config),{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});}catch{finish(Object.assign(new Error('ARCHIVE_TRANSPORT_FAILED'),{code:'ARCHIVE_TRANSPORT_FAILED'}));return;}
  child.on('error',()=>finish(Object.assign(new Error('ARCHIVE_TRANSPORT_FAILED'),{code:'ARCHIVE_TRANSPORT_FAILED'})));
  child.stdout.on('data',chunk=>{if(done)return;size+=chunk.length;if(size>OUTPUT_LIMIT){finish(Object.assign(new Error('ARCHIVE_TRANSPORT_OUTPUT'),{code:'ARCHIVE_TRANSPORT_OUTPUT'}));return;}chunks.push(chunk);});
  child.stderr.on('data',chunk=>{stderrSize+=chunk.length;if(stderrSize>OUTPUT_LIMIT)finish(Object.assign(new Error('ARCHIVE_TRANSPORT_OUTPUT'),{code:'ARCHIVE_TRANSPORT_OUTPUT'}));});
  child.stdin.on('error',()=>{});
  child.on('close',code=>{clearTimeout(killTimer);if(code!==0){finish(Object.assign(new Error('ARCHIVE_TRANSPORT_FAILED'),{code:'ARCHIVE_TRANSPORT_FAILED'}));return;}finish(null,Buffer.concat(chunks).toString('utf8'));});
  child.stdin.end(compressed);
 });
}

export function receiptOf(raw,batch,compressed,receiverId){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>OUTPUT_LIMIT)fail('ARCHIVE_RECEIPT');
 let receipt;try{receipt=JSON.parse(raw);}catch{fail('ARCHIVE_RECEIPT');}
 // Raw bytes and exact record membership identify the durable batch. A receiver
 // may already hold another valid gzip encoding of those same raw bytes; its
 // stored compressed hash is independent of this transmission's gzip hash.
 if(!ownKeys(receipt,['version','batchId','rawSha256','compressedSha256','receivedCompressedSha256','records','receiverId','durable','itemIds','segment'])||receipt.version!==1||receipt.batchId!==batch.batchId||receipt.rawSha256!==batch.rawSha256||typeof receipt.compressedSha256!=='string'||!HEX.test(receipt.compressedSha256)||receipt.receivedCompressedSha256!==undefined&&receipt.receivedCompressedSha256!==sha(compressed)||receipt.receiverId!==receiverId||receipt.durable!==true||receipt.records!==batch.records||!Array.isArray(receipt.itemIds)||receipt.itemIds.length!==batch.itemIds.length||receipt.itemIds.some((id,i)=>!HEX.test(id)||id!==batch.itemIds[i])||typeof receipt.segment!=='string'||receipt.segment.length<1||receipt.segment.length>256||receipt.segment.startsWith('/')||receipt.segment.includes('\\')||receipt.segment.split('/').some(part=>part==='..'||part==='.'||!part)||/[\x00-\x1f\x7f]/.test(receipt.segment))fail('ARCHIVE_RECEIPT');
 return receipt;
}

function processAlive(pid){try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}
async function lockOwner(directory){
 const file=path.join(directory,'owner.json');let stat;try{stat=await fs.lstat(file);}catch{fail('ARCHIVE_LOCK_INVALID');}
 if(stat.isSymbolicLink()||!stat.isFile()||stat.size>1024)fail('ARCHIVE_LOCK_INVALID');
 let owner;try{owner=JSON.parse(await fs.readFile(file,'utf8'));}catch{fail('ARCHIVE_LOCK_INVALID');}
 if(!ownKeys(owner,['version','pid','uid','nonce'])||owner.version!==1||!integer(owner.pid,1,2147483647)||!UUID.test(owner.nonce||'')||owner.uid!==(process.getuid?.()??null))fail('ARCHIVE_LOCK_INVALID');
 return owner;
}
// Offline restore and the sender share this exact lock. A restore holds it
// across the final custody check, SQLite replacement and restore cleanup.
export async function acquireArchiveLock(database){
 await checkedFile(database,{privateFile:true});
 const directory=database+'.usage-archive.lock',owner={version:1,pid:process.pid,uid:process.getuid?.()??null,nonce:crypto.randomUUID()};
 for(let attempt=0;attempt<3;attempt++){
  let created=false;
  try{await fs.mkdir(directory,{mode:0o700});created=true;await fs.writeFile(path.join(directory,'owner.json'),JSON.stringify(owner),{flag:'wx',mode:0o600});return async()=>{try{const current=await lockOwner(directory);if(current.nonce!==owner.nonce)return;await fs.unlink(path.join(directory,'owner.json'));await fs.rmdir(directory);}catch(error){if(error.code!=='ENOENT')throw error;}};}catch(error){if(created){try{await fs.unlink(path.join(directory,'owner.json'));}catch{}try{await fs.rmdir(directory);}catch{}throw error;}if(error.code!=='EEXIST')throw error;}
  const stat=await fs.lstat(directory);if(stat.isSymbolicLink()||!stat.isDirectory()||process.platform!=='win32'&&(stat.uid!==process.getuid()||(stat.mode&0o077)!==0))fail('ARCHIVE_LOCK_INVALID');
  const previous=await lockOwner(directory);if(processAlive(previous.pid))fail('ARCHIVE_LOCKED');
  const reclaim=path.join(directory,'reclaim');try{await fs.mkdir(reclaim,{mode:0o700});}catch(error){if(error.code==='ENOENT')continue;fail('ARCHIVE_LOCKED');}
  try{const current=await lockOwner(directory);if(current.nonce!==previous.nonce||processAlive(current.pid))fail('ARCHIVE_LOCKED');await fs.unlink(path.join(directory,'owner.json'));await fs.rmdir(reclaim);await fs.rmdir(directory);}catch(error){try{await fs.rmdir(reclaim);}catch{}if(error.code!=='ENOENT')throw error;}
 }
 fail('ARCHIVE_LOCKED');
}

function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
async function boundedTransport(transport,args){
 const controller=new AbortController();let timer,rejectWait;
 const wait=new Promise((_,reject)=>{rejectWait=reject;timer=setTimeout(()=>{reject(Object.assign(new Error('ARCHIVE_TRANSPORT_TIMEOUT'),{code:'ARCHIVE_TRANSPORT_TIMEOUT'}));controller.abort();},args.timeoutMs);});
 const abort=()=>{rejectWait(Object.assign(new Error('ARCHIVE_ABORTED'),{code:'ARCHIVE_ABORTED'}));controller.abort();};args.signal?.addEventListener('abort',abort,{once:true});if(args.signal?.aborted)abort();
 try{return await Promise.race([transport({...args,signal:controller.signal}),wait]);}finally{clearTimeout(timer);args.signal?.removeEventListener('abort',abort);}
}

// A timer invokes this once. Each ACK is committed independently; a crash,
// timeout or rejected receipt leaves the identical unacknowledged rows retryable.
export function reclaimArchivePages(db,{maxPages=256}={}){
 if(!integer(maxPages,1,256))fail('ARCHIVE_CONFIG');if(db.prepare('PRAGMA auto_vacuum').get().auto_vacuum!==2)return 0;
 const before=db.prepare('PRAGMA freelist_count').get().freelist_count;if(!before)return 0;
 db.exec(`PRAGMA incremental_vacuum(${maxPages})`);return Math.max(0,before-db.prepare('PRAGMA freelist_count').get().freelist_count);
}
export async function pumpUsageArchive(configuration,{transport=sendArchiveOverSsh,signal,now=()=>Date.now()}={}){
 const config=validateArchiveSenderConfig(configuration),release=await acquireArchiveLock(config.database);let db,batches=0,records=0,bytes=0,reclaimedPages=0,maintenanceDeferred=false;const started=performance.now();
 try{
  db=new DatabaseSync(config.database);db.exec('PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL;');installUsageArchive(db);
  transaction(db,()=>setArchiveHealth(db,{receiverId:config.receiverId,status:'pending',lastAttemptAt:new Date(now()).toISOString(),errorCode:null}));
  for(let index=0;index<config.maxBatches;index++){
   if(signal?.aborted)fail('ARCHIVE_ABORTED');if(performance.now()-started>=MAX_RUN_MS)fail('ARCHIVE_TRANSPORT_TIMEOUT');
   const batch=transaction(db,()=>{bootstrapUsageArchive(db,{limit:config.bootstrapLimit});return selectArchiveBatch(db,{maxRecords:config.maxRecords,maxBytes:config.maxBytes});});
   if(!batch){try{reclaimedPages+=reclaimArchivePages(db);}catch{maintenanceDeferred=true;}break;}
   if(typeof batch.body!=='string'||!batch.body.endsWith('\n')||Buffer.byteLength(batch.body)>config.maxBytes||!integer(batch.records,1,config.maxRecords)||!Array.isArray(batch.itemIds)||batch.itemIds.length!==batch.records||batch.itemIds.some(id=>!HEX.test(id))||batch.rawSha256!==sha(batch.body)||batch.batchId!==batch.rawSha256)fail('ARCHIVE_DATABASE');
   transaction(db,()=>setArchiveHealth(db,{receiverId:config.receiverId,status:'sending',lastAttemptAt:new Date(now()).toISOString(),errorCode:null}));
   const compressed=gzipSync(Buffer.from(batch.body),{level:1}),remaining=Math.floor(MAX_RUN_MS-(performance.now()-started));if(remaining<1)fail('ARCHIVE_TRANSPORT_TIMEOUT');
   const raw=await boundedTransport(transport,{config,batch,compressed,signal,timeoutMs:Math.min(config.timeoutMs,remaining)});
   if(signal?.aborted)fail('ARCHIVE_ABORTED');const receipt=receiptOf(raw,batch,compressed,config.receiverId);
   transaction(db,()=>{acknowledgeArchiveBatch(db,{batch,receipt,expectedReceiverId:config.receiverId});setArchiveHealth(db,{receiverId:config.receiverId,status:'healthy',lastAttemptAt:new Date(now()).toISOString(),lastSuccessAt:new Date(now()).toISOString(),errorCode:null});});
   batches++;records+=batch.records;bytes+=Buffer.byteLength(batch.body);
   if(MAX_RUN_MS-(performance.now()-started)>2000)try{reclaimedPages+=reclaimArchivePages(db);}catch{maintenanceDeferred=true;}
  }
  let status=archiveStatus(db);if(!status.pendingRecords&&!records){transaction(db,()=>setArchiveHealth(db,{receiverId:config.receiverId,status:'idle',lastAttemptAt:new Date(now()).toISOString(),errorCode:null}));status=archiveStatus(db);}return {version:1,status:'complete',batches,records,bytes,reclaimedPages,maintenanceDeferred,archive:status};
 }catch(error){
  const code=safeCode(error);if(db)try{transaction(db,()=>setArchiveHealth(db,{receiverId:config.receiverId,status:'failed',lastAttemptAt:new Date(now()).toISOString(),errorCode:code}));}catch{}
  throw Object.assign(new Error(code),{code,batches,records});
 }finally{db?.close();await release();}
}

async function main(){
 const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--config'||!absolute(args[1]))fail('ARCHIVE_CONFIG');
 const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
 try{const config=await loadArchiveSenderConfig(args[1]),result=await pumpUsageArchive(config,{signal:controller.signal});console.log(JSON.stringify({version:1,status:result.status,batches:result.batches,records:result.records,bytes:result.bytes}));}finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({version:1,status:'failed',code:safeCode(error)}));process.exitCode=1;});
