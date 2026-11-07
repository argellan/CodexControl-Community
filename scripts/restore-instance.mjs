// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import {createReadStream,constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {rotateUsageGeneration} from '../lib/usage-history.mjs';
import {archiveStatus} from '../lib/usage-archive.mjs';
import {acquireArchiveLock} from './archive-usage.mjs';
import {fileURLToPath} from 'node:url';
import {Administration,inspectJournal} from '../lib/administration.mjs';
import {ConfigurationStore} from '../lib/configuration.mjs';
import {validateConfiguration} from '../public/settings-schema.mjs';

const fail=message=>{throw new Error(message);};
const ownBackup=id=>typeof id==='string'&&/^backup-\d{13}-[a-f0-9]{12}$/.test(id);
const inside=(root,target)=>{const rel=path.relative(root,target);return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);};
async function checked(root,relative,{directory=false,optional=false}={}){
 const target=path.resolve(root,relative);if(!inside(root,target))fail('Restore path containment refused');
 let current=root;const parts=path.relative(root,target).split(path.sep);
 for(const [i,part] of parts.entries()){current=path.join(current,part);let stat;try{stat=await fs.lstat(current);}catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}if(stat.isSymbolicLink())fail('Restore refuses symbolic links or junctions');if(i<parts.length-1&&!stat.isDirectory())fail('Restore parent is not a directory');if(i===parts.length-1&&(directory?!stat.isDirectory():!stat.isFile()))fail('Restore requires the exact expected file type');const actual=await fs.realpath(current);if(!inside(root,actual))fail('Restore real path escapes the data directory');}
 return target;
}
async function json(file,max=2097152){const stat=await fs.stat(file);if(stat.size>max)fail('Restore metadata exceeds its bound');const raw=await fs.readFile(file,'utf8');if(Buffer.byteLength(raw)>max)fail('Restore metadata exceeds its bound');return JSON.parse(raw);}
async function hashFile(file){const digest=crypto.createHash('sha256');let bytes=0;for await(const chunk of createReadStream(file,{highWaterMark:262144})){bytes+=chunk.length;if(bytes>512*1048576)fail('Restore file exceeds its bound');digest.update(chunk);}return {sha256:digest.digest('hex'),bytes};}
async function syncDirectory(directory){if(process.platform==='win32')return;const handle=await fs.open(directory,'r');try{await handle.sync();}finally{await handle.close();}}
async function copied(source,target){await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.copyFile(source,target,constants.COPYFILE_EXCL);await fs.chmod(target,0o600);const handle=await fs.open(target,'r+');try{await handle.sync();}finally{await handle.close();}}
async function replace(source,target,operation){
 const temporary=target+'.restore-'+operation+'.tmp';let failure;
 try{await copied(source,temporary);await fs.rename(temporary,target);await syncDirectory(path.dirname(target));}catch(error){failure=error;}
 try{await fs.unlink(temporary);}catch(error){if(error.code!=='ENOENT')failure??=error;}
 if(failure)throw failure;
}
async function receiptFile(file,value){const handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();}finally{await handle.close();}await syncDirectory(path.dirname(file));}
async function processGuard(root,instanceId){
 let file;try{file=await checked(root,'runtime.pid');}catch{fail('A valid offline process/PID guard is required');}
 const value=await json(file,4096);if(!Number.isInteger(value.pid)||value.pid<1||value.pid>2147483647||value.instanceId!==instanceId)fail('Process/PID guard does not identify this instance');
 try{process.kill(value.pid,0);fail('A live process is recorded; restore requires the instance to be offline');}catch(error){if(error.code==='ESRCH')return value;if(error.code==='EPERM')fail('Recorded process is live or inaccessible; offline restore refused');throw error;}
}
function typedStoredState(value){
 if(!value||value.schemaVersion!==1||!Number.isSafeInteger(value.revision)||value.revision<1||typeof value.requiresRestart!=='boolean'||!Array.isArray(value.audit)||value.audit.length>256)fail('Existing typed configuration state is invalid; offline repair required');
 validateConfiguration(value.configuration);if(value.previousConfiguration!==null)validateConfiguration(value.previousConfiguration);
 for(const a of value.audit)if(!a||!Number.isSafeInteger(a.revision)||a.revision<1||a.revision>value.revision||!Number.isFinite(Date.parse(a.at))||!['seed','save','rollback','recovery','activate'].includes(a.action)||!Array.isArray(a.changedPaths))fail('Existing configuration audit is invalid');
 return value;
}
function requireArchivedCurrentUsage(file){
 const refuse=message=>{throw Object.assign(new Error(message),{code:'ARCHIVE_CUSTODY_REQUIRED'});};
 const journal=inspectJournal(file);
 if(!journal.usage)return;
 if(!journal.archive){if(Object.entries(journal.usage).some(([key,value])=>key!=='schemaVersion'&&value>0))refuse('Current usage has not entered archive custody; start the hub and complete its archive before restoring');return;}
 const db=new DatabaseSync(file,{readOnly:true});try{const status=archiveStatus(db);if(!status.bootstrapComplete||status.pendingRecords||status.inflightRecords)refuse('Current usage archive is incomplete; drain pending records before restoring');}finally{db.close();}
}

// Offline owner command only. Web routes can stage an own verified backup, but
// cannot execute this transaction, stop a process or restart the service.
export async function restoreInstance({dataDirectory}={}){
 if(typeof dataDirectory!=='string'||!path.isAbsolute(dataDirectory))fail('An absolute data directory is required');
 const requested=path.resolve(dataDirectory),rootStat=await fs.lstat(requested);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())fail('Data directory must be a real directory without a symbolic link');const root=await fs.realpath(requested);
 const registryFile=await checked(root,'administration/administration.json'),configurationFile=await checked(root,'configuration/configuration.json'),goodFile=await checked(root,'configuration/configuration.last-good.json'),historyFile=await checked(root,'history.sqlite'),stage=await checked(root,'administration/restore-staging/pending',{directory:true});
 const administration=await Administration.open({directory:path.dirname(registryFile)}),security=await administration.state();await processGuard(root,security.instanceId);
 const stageNames=(await fs.readdir(stage)).sort();if(JSON.stringify(stageNames)!==JSON.stringify(['configuration.json','history.sqlite','manifest.json']))fail('Staged restore contains unexpected files');
 const manifestFile=await checked(root,'administration/restore-staging/pending/manifest.json'),manifest=await json(manifestFile,65536);
 if(!manifest||manifest.schemaVersion!==1||!ownBackup(manifest.id)||manifest.instanceId!==security.instanceId||!Array.isArray(manifest.files)||manifest.files.length!==2||JSON.stringify(manifest.files.map(f=>f.name).sort())!==JSON.stringify(['configuration.json','history.sqlite'])||Object.keys(manifest).some(k=>!['schemaVersion','id','instanceId','createdAt','files','journal','requiresRestart','applyMode','stagedAt'].includes(k)))fail('Staged manifest is not an own approved backup');
 const stagedFiles={};for(const f of manifest.files){if(typeof f.sha256!=='string'||!/^[a-f0-9]{64}$/.test(f.sha256)||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>512*1048576)fail('Staged file inventory is invalid');const source=await checked(root,'administration/restore-staging/pending/'+f.name),actual=await hashFile(source);if(actual.sha256!==f.sha256||actual.bytes!==f.bytes)fail('Staged backup checksum mismatch');stagedFiles[f.name]=source;}
 const desiredDocument=await json(stagedFiles['configuration.json']),desired=validateConfiguration(desiredDocument.configuration||desiredDocument),observedJournal=inspectJournal(stagedFiles['history.sqlite']);if(JSON.stringify(observedJournal)!==JSON.stringify(manifest.journal))fail('Staged journal schema/count metadata mismatch');
 const current=typedStoredState(await json(configurationFile));typedStoredState(await json(goodFile));
 const lockFile=path.join(root,'restore.lock'),lockValue=JSON.stringify({pid:process.pid,instanceId:security.instanceId,operation:crypto.randomUUID(),at:new Date().toISOString()}),lock=await fs.open(lockFile,'wx',0o600);try{await lock.writeFile(lockValue);await lock.sync();}finally{await lock.close();}
 const operation=crypto.randomUUID(),previousDirectory=path.join(root,'restore-previous-'+operation);let changed=false,canUnlock=true,result,releaseArchive;
 const originals=[];
 try{
  releaseArchive=await acquireArchiveLock(historyFile);
  await processGuard(root,security.instanceId);requireArchivedCurrentUsage(historyFile);await fs.mkdir(previousDirectory,{mode:0o700});
  for(const relative of ['history.sqlite','history.sqlite-wal','history.sqlite-shm','configuration/configuration.json','configuration/configuration.last-good.json']){const source=await checked(root,relative,{optional:relative.endsWith('-wal')||relative.endsWith('-shm')});if(!source){originals.push({path:relative,exists:false});continue;}const before=await hashFile(source),preserved=path.join(previousDirectory,'original',relative);await copied(source,preserved);const after=await hashFile(preserved);if(after.sha256!==before.sha256||after.bytes!==before.bytes)fail('Preserved original checksum mismatch');originals.push({path:relative,exists:true,...before});}
  const candidate=path.join(previousDirectory,'candidate'),candidateHistory=path.join(candidate,'history.sqlite');await copied(stagedFiles['history.sqlite'],candidateHistory);const candidateConfig=path.join(candidate,'configuration');for(const relative of ['configuration.json','configuration.last-good.json'])await copied(path.join(root,'configuration',relative),path.join(candidateConfig,relative));
  const configStore=await ConfigurationStore.open({directory:candidateConfig,initial:current.configuration});await configStore.save({revision:current.revision,configuration:desired,actor:{id:'offline-restore',role:'system'}});const prepared=await configStore.read();
  const candidateHash=await hashFile(candidateHistory);if(candidateHash.sha256!==manifest.files.find(f=>f.name==='history.sqlite').sha256)fail('Prepared journal checksum mismatch');inspectJournal(candidateHistory);
  // The verified backup may have an older usage cursor under the same event
  // epoch. Rotate only its presentation stream identity, after validating the
  // original bytes, so clients prime recovery instead of waiting for old IDs.
  const usageDb=new DatabaseSync(candidateHistory);let usageStreamRotated=false;
  try{usageStreamRotated=rotateUsageGeneration(usageDb)!==null;}finally{usageDb.close();}
  inspectJournal(candidateHistory);
  await processGuard(root,security.instanceId);requireArchivedCurrentUsage(historyFile);changed=true;
  for(const suffix of ['-wal','-shm']){const old=await checked(root,'history.sqlite'+suffix,{optional:true});if(old){const retired=path.join(previousDirectory,'retired','history.sqlite'+suffix);await fs.mkdir(path.dirname(retired),{recursive:true,mode:0o700});await fs.rename(old,retired);}}
  await replace(candidateHistory,historyFile,operation);await replace(path.join(candidateConfig,'configuration.json'),configurationFile,operation);await replace(path.join(candidateConfig,'configuration.last-good.json'),goodFile,operation);
  result={schemaVersion:1,status:'restored',at:new Date().toISOString(),backupId:manifest.id,instanceId:security.instanceId,previousDirectory,requiresRestart:true,serviceStarted:false,configurationRevision:prepared.revision,usageStreamRotated,preservedFiles:originals};await receiptFile(path.join(previousDirectory,'receipt.json'),result);return result;
 }catch(error){
  let rolledBack=!changed;
  if(changed){try{await processGuard(root,security.instanceId);for(const original of originals){const target=path.join(root,original.path);if(original.exists)await replace(path.join(previousDirectory,'original',original.path),target,operation+'-rollback');else{const added=await checked(root,original.path,{optional:true});if(added){const retired=path.join(previousDirectory,'rollback-new',original.path);await fs.mkdir(path.dirname(retired),{recursive:true,mode:0o700});await fs.rename(added,retired);}}}rolledBack=true;}catch{rolledBack=false;canUnlock=false;}}
  if(previousDirectory&&await fs.stat(previousDirectory).catch(()=>null)){result={schemaVersion:1,status:rolledBack?'failed-rolled-back':'failed-recovery-required',at:new Date().toISOString(),backupId:manifest.id,instanceId:security.instanceId,previousDirectory,requiresRestart:true,serviceStarted:false,preservedFiles:originals};try{await receiptFile(path.join(previousDirectory,'receipt.json'),result);}catch{}}
  const reason=error.code==='ARCHIVE_CUSTODY_REQUIRED'?error.message:error.code==='ARCHIVE_LOCKED'?'Archive sender is active; stop its timer and service before restoring':null;
  const failure=new Error(reason||(rolledBack?'Offline restore failed; original active files are preserved or rolled back':'Offline restore failed; manual recovery required and restore lock retained'),{cause:error});failure.receipt=result;throw failure;
 }finally{
  if(releaseArchive)await releaseArchive();
  if(canUnlock){const currentLock=await fs.readFile(lockFile,'utf8').catch(()=>null);if(currentLock===lockValue)await fs.unlink(lockFile);}
 }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.length!==1||!args[0].startsWith('--data=')){process.stderr.write('Usage: node restore-instance.mjs --data=ABSOLUTE_DATA_DIRECTORY\n');process.exitCode=1;}else{try{const receipt=await restoreInstance({dataDirectory:args[0].slice(7)});process.stdout.write(JSON.stringify(receipt,null,2)+'\n');}catch(error){process.stderr.write(error.message+'\n');if(error.receipt)process.stderr.write(JSON.stringify(error.receipt,null,2)+'\n');process.exitCode=1;}}
}
