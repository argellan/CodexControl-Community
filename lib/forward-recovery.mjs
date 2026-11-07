// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Administration} from './administration.mjs';
import {validateAdministrationFormat} from './administration-format.mjs';
import {verifyPackagedPerformance} from '../scripts/performance-gate.mjs';
const execute=promisify(execFile),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=message=>{throw new Error(message);};
async function directory(value){
 if(typeof value!=='string'||!path.isAbsolute(value))fail('Absolute real directory required');
 const resolved=path.resolve(value),parsed=path.parse(resolved);let current=parsed.root;
 for(const part of path.relative(parsed.root,resolved).split(path.sep).filter(Boolean)){current=path.join(current,part);const s=await fs.lstat(current);if(!s.isDirectory()||s.isSymbolicLink())fail('Recovery refuses symbolic links or junctions');}
 return fs.realpath(resolved);
}
async function document(file,max=1048576){
 await directory(path.dirname(file));const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size<1||s.size>max)fail('Bounded regular recovery metadata required');
 const bytes=await fs.readFile(file);if(bytes.length>max)fail('Recovery metadata exceeds bound');return {bytes,value:JSON.parse(bytes.toString('utf8')),sha256:hash(bytes)};
}
async function syncDirectory(root){if(process.platform==='win32')return;const handle=await fs.open(root,'r');try{await handle.sync();}finally{await handle.close();}}
async function privateFile(file,value){const handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}}
async function ownedLock(file,instanceId){
 const identity=JSON.stringify({pid:process.pid,instanceId,operation:crypto.randomUUID(),kind:'application-change'}),handle=await fs.open(file,'wx',0o600);let stat;
 try{stat=await handle.stat();await handle.writeFile(identity);await handle.sync();}catch(error){
  await handle.close().catch(()=>{error.cleanupPending=true;});
  try{const actual=await fs.lstat(file),bytes=await fs.readFile(file,'utf8');if(stat&&actual.ino===stat.ino&&(bytes===''||bytes===identity))await fs.unlink(file);else error.cleanupPending=true;}catch(cleanup){if(cleanup.code!=='ENOENT')error.cleanupPending=true;}
  throw error;
 }
 const verify=async()=>{const actual=await fs.lstat(file);if(actual.ino!==stat.ino||(await fs.readFile(file,'utf8'))!==identity)fail('Recovery lock ownership changed; foreign lock preserved');};
 const release=async()=>{await handle.close();await verify();await fs.unlink(file);};release.verify=verify;return release;
}
async function offline(root,instanceId,gateway){
 const record=await document(path.join(root,gateway?'gateway-runtime.pid':'runtime.pid'),4096),p=record.value;
 if(!Number.isInteger(p.pid)||p.pid<1||p.pid>2147483647||p.instanceId!==instanceId)fail('Exact offline process/instance guard required');
 try{process.kill(p.pid,0);}catch(error){if(error.code==='ESRCH')return record.sha256;throw new Error('Recorded process is live or inaccessible; offline recovery refused');}
 fail('A live process is recorded; recovery requires the instance offline');
}
async function requireUninitialized(root,hub,pointer){
 if(pointer.applicationChange?.authority)fail('Initialized authority is missing; update refused');
 let data;try{data=await directory(hub.dataDirectory);}catch(error){if(error.code==='ENOENT')return;throw error;}
 if((await fs.readdir(data)).length)fail('Instance data is initialized; current authority is missing');
 const receipt=(await document(path.join(root,'setup-receipt.json'),16384)).value;
 if(receipt.schemaVersion!==1||receipt.status!=='PREPARED_NOT_STARTED'||receipt.instanceId!==hub.instanceId||typeof receipt.directory!=='string'||path.resolve(receipt.directory)!==root||typeof receipt.hubConfig!=='string'||path.resolve(receipt.hubConfig)!==path.join(root,'hub.json'))fail('Verified never-started setup receipt required');
}
async function verifyTarget(target,authority,administrationDirectory){
 const performance=await verifyPackagedPerformance(target),manifest=await document(path.join(target,'RELEASE_MANIFEST.json'));
 if(authority){
  validateAdministrationFormat(manifest.value.administrationFormat);
  for(const name of ['lib/administration.mjs','lib/administration-format.mjs','scripts/verify-administration.mjs'])if(!manifest.value.runtimePaths.includes(name))fail('Qualified package lacks compatible administration probe closure');
  const probeFile=path.join(target,'scripts','verify-administration.mjs');
  let output;try{output=await execute(process.execPath,[probeFile,'--directory='+administrationDirectory,'--sha256='+authority.sha256,'--instance='+authority.instanceId],{timeout:10000,maxBuffer:16384,windowsHide:true,env:{...process.env,NODE_OPTIONS:undefined,NODE_PATH:undefined}});}catch{fail('Target administration reader probe failed; recovery refused');}
  let result;try{result=JSON.parse(output.stdout);}catch{fail('Target administration probe returned invalid output');}
  if(result.protocolVersion!==1||result.status!=='COMPATIBLE_CURRENT_AUTHORITY'||result.sha256!==authority.sha256||result.instanceId!==authority.instanceId||result.revision!==authority.revision||result.schemaVersion!==authority.schemaVersion)fail('Target administration probe identity mismatch');
  validateAdministrationFormat(result.format);if(JSON.stringify(result.format)!==JSON.stringify(manifest.value.administrationFormat))fail('Target reader and package administration declarations differ');
 }
 return performance;
}
export async function prepareApplicationChange({instanceDirectory,appDirectory,mode='update'}={}){
 if(!['update','forward-recovery'].includes(mode))fail('Unsupported application change mode');
 const root=await directory(instanceDirectory),target=await directory(appDirectory),pointer=path.join(root,'installation.json'),before=await document(pointer),hub=await document(path.join(root,'hub.json'));
 if(before.value.schemaVersion!==1||typeof before.value.hostId!=='string'||!/^[-a-z0-9]{1,64}$/.test(before.value.hostId)||!path.isAbsolute(before.value.appDirectory||''))fail('Invalid installation pointer');
 if(typeof hub.value.instanceId!=='string'||!hub.value.instanceId||hub.value.instanceId.length>128||!path.isAbsolute(hub.value.dataDirectory||''))fail('Invalid current instance data identity');
 let data,authority=null;const administrationDirectory=path.join(hub.value.dataDirectory,'administration');
 try{data=await directory(hub.value.dataDirectory);authority=await Administration.inspect({directory:administrationDirectory});}catch(error){if(mode==='forward-recovery'||error.code!=='ENOENT')throw error;await requireUninitialized(root,hub.value,before.value);}
 if(authority&&authority.instanceId!==hub.value.instanceId)fail('Current administration instance mismatch');
 let releaseInstance,releaseRestore,pending,result,failure,published=false,publicationAttempted=false;
 try{
  releaseInstance=await ownedLock(path.join(root,'application-change.lock'),hub.value.instanceId);
  let pidHash;if(mode==='forward-recovery'){if(!authority)fail('Current authority required; recovery never initializes missing state');pidHash=await offline(data,authority.instanceId,!!hub.value.upstream);releaseRestore=await ownedLock(path.join(data,'restore.lock'),authority.instanceId);}
  const performance=await verifyTarget(target,authority,administrationDirectory);
  const current=await document(pointer),currentHub=await document(path.join(root,'hub.json'));
  if(current.sha256!==before.sha256||currentHub.sha256!==hub.sha256)fail('Installation or instance configuration changed during preparation');
  if(authority&&(await Administration.inspect({directory:administrationDirectory})).sha256!==authority.sha256)fail('Current authority changed during preparation');
  if(mode==='forward-recovery'&&await offline(data,authority.instanceId,!!hub.value.upstream)!==pidHash)fail('Offline process guard changed');
  // Revalidate package bytes after its child probe; never trust a declaration alone.
  const finalPerformance=await verifyPackagedPerformance(target);if(finalPerformance.candidateDigest!==performance.candidateDigest)fail('Target runtime changed during preparation');
  if(!authority)await requireUninitialized(root,hub.value,before.value);
  if(before.value.appDirectory===target&&before.value.applicationChange?.mode===mode&&before.value.applicationChange?.candidateDigest===performance.candidateDigest){result={status:mode==='forward-recovery'?'FORWARD_RECOVERY_PREPARED_NOT_STARTED':'POINTER_UPDATED_INSTANCE_NOT_STARTED',alreadyPrepared:true,operationId:before.value.applicationChange.operationId,serviceStarted:false,installation:pointer,appDirectory:target,authority};}else{
  const operationId=crypto.randomUUID(),at=new Date().toISOString(),previous=pointer+'.previous-'+operationId,applicationChange={schemaVersion:1,operationId,mode,at,candidateDigest:performance.candidateDigest,authority:authority?{schemaVersion:authority.schemaVersion,revision:authority.revision,sha256:authority.sha256,instanceId:authority.instanceId}:null};
  await privateFile(previous,before.value);pending=pointer+'.pending-'+operationId;await privateFile(pending,{...before.value,appDirectory:target,updatedAt:at,applicationChange});
  // Recovery holds restore.lock; authority bytes are never replaced in either mode.
  if((await document(pointer)).sha256!==before.sha256||(await document(path.join(root,'hub.json'))).sha256!==hub.sha256||authority&&(await Administration.inspect({directory:administrationDirectory})).sha256!==authority.sha256)fail('Current state changed before pointer publication');
  if(!authority)await requireUninitialized(root,hub.value,before.value);
  await releaseInstance.verify();if(releaseRestore)await releaseRestore.verify();
  publicationAttempted=true;await fs.rename(pending,pointer);published=true;pending=null;await syncDirectory(root);
  result={status:mode==='forward-recovery'?'FORWARD_RECOVERY_PREPARED_NOT_STARTED':'POINTER_UPDATED_INSTANCE_NOT_STARTED',operationId,serviceStarted:false,installation:pointer,previous,appDirectory:target,authority};
  }
 }catch(error){failure=error;}
 // Attempt every owned cleanup even if one lease changed; never remove a foreign lease.
 try{if(pending)await fs.unlink(pending);}catch(error){if(error.code!=='ENOENT')failure??=error;}
 for(const release of [releaseRestore,releaseInstance])if(release)try{await release();}catch(error){failure??=error;}
 if(failure){if(published||publicationAttempted){failure.causeCode=failure.code??null;failure.code='PUBLICATION_UNCERTAIN';}throw failure;}
 return result;
}
export function recoverApplication(options){return prepareApplicationChange({...options,mode:'forward-recovery'});}
