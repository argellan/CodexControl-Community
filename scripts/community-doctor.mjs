#!/usr/bin/env node
// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const APPLICATION=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const inside=(parent,target)=>{const rel=path.relative(parent,target);return rel!==''&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
const localFilesystems=new Set(['ext2','ext3','ext4','btrfs','xfs','zfs','f2fs','overlay','tmpfs']);
const problem=code=>Object.assign(new Error('Local diagnostic unavailable'),{diagnosticCode:code});
const octal=value=>value.replace(/\\([0-7]{3})/g,(_,digits)=>String.fromCharCode(parseInt(digits,8)));

// Only fixed, bounded local metadata files are opened. This tool never starts
// the app, reads provider auth/owner-access files, opens SQLite, or calls a host.
async function boundedText(file,maximum=1048576){
 const stat=await fs.lstat(file);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>maximum)throw problem('REGULAR_BOUNDED_FILE_REQUIRED');
 const handle=await fs.open(file,'r');try{const bytes=Buffer.alloc(maximum+1);let used=0;while(used<bytes.length){const {bytesRead}=await handle.read(bytes,used,Math.min(65536,bytes.length-used),null);if(!bytesRead)break;used+=bytesRead;}if(used>maximum)throw problem('METADATA_SIZE_LIMIT');return bytes.subarray(0,used).toString('utf8');}finally{await handle.close();}
}
async function jsonMetadata(file){try{return JSON.parse(await boundedText(file));}catch(error){if(error.diagnosticCode)throw error;throw problem(error.code==='ENOENT'?'METADATA_MISSING':'METADATA_JSON_INVALID');}}
async function noLinks(directory){
 const resolved=path.resolve(directory),root=path.parse(resolved).root,parts=path.relative(root,resolved).split(path.sep).filter(Boolean);if(parts.length>64)throw problem('PATH_DEPTH_LIMIT');
 let current=root;for(const part of parts){current=path.join(current,part);const stat=await fs.lstat(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw problem('DIRECTORY_LINK_OR_TYPE_REFUSED');}return fs.lstat(resolved);
}
async function localStorage(directory,{platform,systemDrive,mountInfo}){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||/[\x00-\x1f\x7f]/.test(directory)||/^(?:\\\\|\/\/)/.test(directory))return {status:'fail',code:'ABSOLUTE_LOCAL_DIRECTORY_REQUIRED',inspect:false};
 if(platform==='win32'){
  const drive=path.win32.parse(directory).root.toLowerCase(),system=path.win32.parse((systemDrive||'C:')+'\\').root.toLowerCase();
  return drive===system?{status:'warn',code:'WINDOWS_LOCAL_VOLUME_AND_ACL_REQUIRE_OPERATOR_VERIFICATION',inspect:true}:{status:'warn',code:'NON_SYSTEM_VOLUME_NOT_INSPECTED',inspect:false};
 }
 if(platform!=='linux')return {status:'not-run',code:'PLATFORM_STORAGE_NOT_QUALIFIED',inspect:false};
 let text;try{text=mountInfo??await boundedText('/proc/self/mountinfo');}catch{return {status:'not-run',code:'LOCAL_MOUNT_IDENTITY_UNAVAILABLE',inspect:false};}
 const candidates=[];for(const line of text.split('\n')){const [before,after]=line.split(' - ');if(!after)continue;const mount=octal(before.split(' ')[4]||''),filesystem=after.split(' ')[0];if(mount&&path.isAbsolute(mount)&&(path.resolve(directory)===mount||inside(mount,path.resolve(directory))))candidates.push({mount,filesystem});}
 candidates.sort((a,b)=>b.mount.length-a.mount.length);const filesystem=candidates[0]?.filesystem;
 if(!localFilesystems.has(filesystem))return {status:'fail',code:'NETWORK_OR_UNQUALIFIED_FILESYSTEM_REFUSED',inspect:false};
 return {status:filesystem==='tmpfs'?'warn':'pass',code:filesystem==='tmpfs'?'VOLATILE_LOCAL_STORAGE':'LOCAL_FILESYSTEM_DECLARED',inspect:true};
}
function configurationShape(value){
 if(!object(value)||typeof value.instanceId!=='string'||!value.instanceId||!Array.isArray(value.hosts)||value.hosts.length>64||!Array.isArray(value.viewers)||value.viewers.length>1024||!Number.isSafeInteger(value.port)||value.port<1024||value.port>65535||typeof value.dataDirectory!=='string'||!path.isAbsolute(value.dataDirectory))return false;
 try{const u=new URL(value.publicOrigin),loopback=['127.0.0.1','localhost','[::1]'].includes(u.hostname);if(u.username||u.password||u.pathname!=='/'||u.search||u.hash||u.protocol!=='https:'&&!(u.protocol==='http:'&&loopback))return false;if(u.protocol==='https:'&&(!object(value.tls)||typeof value.tls.cert!=='string'||typeof value.tls.key!=='string'))return false;}catch{return false;}
 return true;
}
function permissionCheck(stat,platform){return platform==='win32'?{status:'not-run',code:'WINDOWS_ACL_NOT_INSPECTED'}:(stat.mode&0o077)!==0?{status:'fail',code:'PRIVATE_METADATA_PERMISSIONS_REQUIRED'}:{status:'pass',code:'OWNER_ONLY_MODE_BITS'};}

export async function communityDoctor({instanceDirectory,applicationDirectory=APPLICATION}={},dependencies={}){
 const platform=dependencies.platform??process.platform,nodeVersion=dependencies.nodeVersion??process.versions.node,systemDrive=dependencies.systemDrive??process.env.SystemDrive,checks=[];
 const add=(name,result)=>checks.push({name,status:result.status,code:result.code});
 const major=Number(nodeVersion.split('.')[0]);add('node-runtime',{status:Number.isSafeInteger(major)&&major>=24?'pass':'fail',code:Number.isSafeInteger(major)&&major>=24?'NODE_24_OR_LATER_PRESENT':'NODE_24_REQUIRED'});
 add('qualified-baseline',{status:nodeVersion==='24.19.0'?'pass':'warn',code:nodeVersion==='24.19.0'?'NODE_24_19_0_BASELINE':'RUNTIME_DIFFERS_FROM_QUALIFIED_BASELINE'});
 const appStorage=await localStorage(applicationDirectory,{platform,systemDrive,mountInfo:dependencies.mountInfo});add('application-storage',appStorage);
 if(appStorage.inspect){try{await noLinks(applicationDirectory);for(const relative of ['server.mjs','collector.mjs','scripts/setup-instance.mjs','lib/usage-samples.mjs','public/index.html']){const target=path.join(applicationDirectory,relative);await noLinks(path.dirname(target));const stat=await fs.lstat(target);if(!stat.isFile()||stat.isSymbolicLink())throw problem('APPLICATION_FILES_MISSING_OR_LINKED');}add('application-files',{status:'pass',code:'EXPECTED_APPLICATION_FILES_PRESENT'});}catch{add('application-files',{status:'fail',code:'APPLICATION_FILES_MISSING_OR_LINKED'});}}
 if(instanceDirectory===undefined)add('private-instance',{status:'not-run',code:'INSTANCE_NOT_REQUESTED'});
 else{
  const storage=await localStorage(instanceDirectory,{platform,systemDrive,mountInfo:dependencies.mountInfo});add('instance-storage',storage);
  if(storage.inspect){
   try{
    const directory=path.resolve(instanceDirectory);if(directory===path.resolve(applicationDirectory)||inside(path.resolve(applicationDirectory),directory))throw problem('PRIVATE_INSTANCE_INSIDE_APPLICATION');
    add('instance-permissions',permissionCheck(await noLinks(directory),platform));
    const installation=await jsonMetadata(path.join(directory,'installation.json')),configuration=await jsonMetadata(path.join(directory,'hub.json'));
    add('metadata-permissions',permissionCheck(await fs.lstat(path.join(directory,'hub.json')),platform));
    if(!object(installation)||installation.schemaVersion!==1||!['single-computer','fleet-hub'].includes(installation.mode)||typeof installation.appDirectory!=='string'||!path.isAbsolute(installation.appDirectory))throw problem('INSTALLATION_METADATA_INVALID');
    if(!configurationShape(configuration))throw problem('RUNTIME_CONFIGURATION_INVALID');
    add('instance-metadata',{status:'pass',code:'METADATA_SYNTAX_AND_CORE_SHAPE_VALID'});
    add('application-pointer',{status:path.resolve(installation.appDirectory)===path.resolve(applicationDirectory)?'pass':'warn',code:path.resolve(installation.appDirectory)===path.resolve(applicationDirectory)?'POINTER_MATCHES_THIS_APPLICATION':'POINTER_SELECTS_DIFFERENT_APPLICATION'});
    const data=await localStorage(configuration.dataDirectory,{platform,systemDrive,mountInfo:dependencies.mountInfo});add('database-storage',data);
    if(data.inspect){try{add('data-permissions',permissionCheck(await noLinks(configuration.dataDirectory),platform));}catch{add('data-permissions',{status:'fail',code:'DATA_DIRECTORY_MISSING_OR_LINKED'});}}
   }catch(error){add('instance-metadata',{status:'fail',code:error.diagnosticCode??'PRIVATE_METADATA_UNAVAILABLE'});}
  }
 }
 const status=checks.some(c=>c.status==='fail')?'fail':checks.some(c=>c.status==='warn'||c.status==='not-run')?'attention':'pass';
 return {version:1,tool:'codexcontrol-community-doctor',status,readOnly:true,networkUsed:false,childProcessesUsed:false,checks,limits:{startsApplication:false,readsProviderAuth:false,opensHistoryDatabase:false,checksCertificateTrust:false,qualifiesInstallation:false}};
}

export function parseDoctorArguments(args){const options={};for(const arg of args){if(arg==='--help')options.help=true;else if(arg.startsWith('--instance-dir=')&&!Object.hasOwn(options,'instanceDirectory')&&arg.length>15)options.instanceDirectory=arg.slice(15);else throw problem('DOCUMENTED_ARGUMENTS_REQUIRED');}return options;}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const options=parseDoctorArguments(process.argv.slice(2));if(options.help)console.log('node scripts/community-doctor.mjs [--instance-dir=ABSOLUTE_PRIVATE_INSTANCE]\nLocal metadata only. No network, subprocesses, source-log scan, auth read, database open or changes.');else{const result=await communityDoctor(options);console.log(JSON.stringify(result,null,2));process.exitCode=result.status==='fail'?1:0;}}
 catch(error){console.error(JSON.stringify({version:1,tool:'codexcontrol-community-doctor',status:'fail',readOnly:true,code:error.diagnosticCode??'LOCAL_DIAGNOSTIC_UNAVAILABLE'}));process.exitCode=1;}
}
