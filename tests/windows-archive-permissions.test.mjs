// Author: Bishop Crockett
// Owner: Argellan.com
// SPDX-License-Identifier: MIT
import test from 'node:test';import assert from 'node:assert/strict';
import {validateWindowsArchiveDescriptor,verifyWindowsArchivePaths} from '../lib/windows-archive-permissions.mjs';
const current='S-1-5-21-123';const base=()=>({owner:current,filesystem:'NTFS',fixed:true,reparse:false,allows:[{sid:current,mask:0x1f01ff,inheritOnly:false}]});
test('NTFS archive ACL policy rejects broad access, unsafe ancestors and unknown storage',()=>{
 assert.doesNotThrow(()=>validateWindowsArchiveDescriptor(base(),current,{privateFile:true}));
 for(const extra of [{owner:'S-1-1-0'},{filesystem:'ReFS'},{fixed:false},{reparse:true},{allows:null},{nullDacl:true},{unknownAces:true},{allows:[{sid:'S-1-1-0',mask:1,inheritOnly:false}]}])assert.throws(()=>validateWindowsArchiveDescriptor({...base(),...extra},current,{privateFile:true}),/ARCHIVE_CONFIG_PERMISSIONS/);
 for(const mask of [0x40,0x10000,0x40000,0x80000,0x10000000,0x40000000])assert.throws(()=>validateWindowsArchiveDescriptor({...base(),allows:[{sid:'S-1-1-0',mask,inheritOnly:false}]},current,{ancestor:true}),/ARCHIVE_CONFIG_PERMISSIONS/);
 assert.doesNotThrow(()=>validateWindowsArchiveDescriptor({...base(),allows:[{sid:'S-1-1-0',mask:0x1200af,inheritOnly:false}]},current,{ancestor:true}));
});
test('inherit-only ACEs do not grant the current object access',()=>assert.doesNotThrow(()=>validateWindowsArchiveDescriptor({...base(),allows:[{sid:'S-1-1-0',mask:0x1f01ff,inheritOnly:true}]},current,{privateFile:true})));
test('Windows permission helper is skipped on POSIX and cannot accept relative or network requests',async()=>{
 let called=false;await verifyWindowsArchivePaths([],{platform:'linux',collect:()=>{called=true;}});assert.equal(called,false);
 for(const p of ['relative',String.raw`\\server\share\file`,String.raw`\\?\C:\file`])await assert.rejects(verifyWindowsArchivePaths([{path:p,privateFile:true}],{platform:'win32',collect:()=>{called=true;}}),/ARCHIVE_CONFIG_PERMISSIONS/);
 assert.equal(called,false);
});
test('complete ancestor chain is required and permission refusal propagates before file use',async()=>{
 const p=String.raw`C:\TEST_ONLY\file`;let called=0;
 await assert.rejects(verifyWindowsArchivePaths([{path:p,privateFile:true}],{platform:'win32',collect:async()=>({currentSid:current,checks:[{path:p,chain:[]}]})}),/ARCHIVE_CONFIG_PERMISSIONS/);
 await assert.rejects(verifyWindowsArchivePaths([{path:p,privateFile:true}],{platform:'win32',collect:async()=>{called++;throw Error('TEST_ONLY refusal');}}),/ARCHIVE_CONFIG_PERMISSIONS/);assert.equal(called,1);
});

test('complete trusted chain admits the exact requested private file',async()=>{
 const p=String.raw`C:\TEST_ONLY\file`,chain=[p,String.raw`C:\TEST_ONLY`,'C:\\'].map(path=>({...base(),path}));
 await verifyWindowsArchivePaths([{path:p,privateFile:true}],{platform:'win32',collect:async()=>({currentSid:current,checks:[{path:p,chain}]})});
});
test('OS-owned volume root admits safe descendants without trusting private or intermediate owners',async()=>{
 const ti='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464',p=String.raw`C:\TEST_ONLY\file`,root='C:\\';
 const chain=[p,String.raw`C:\TEST_ONLY`,root].map(path=>({...base(),path}));chain[2].owner=ti;
 const read=async()=>({currentSid:current,checks:[{path:p,chain}]});
 await verifyWindowsArchivePaths([{path:p,privateFile:true}],{platform:'win32',collect:read});
 chain[0].owner=ti;await assert.rejects(verifyWindowsArchivePaths([{path:p,privateFile:true}],{platform:'win32',collect:read}),/ARCHIVE_CONFIG_PERMISSIONS/);chain[0].owner=current;
 chain[1].owner=ti;await assert.rejects(verifyWindowsArchivePaths([{path:p,privateFile:true}],{platform:'win32',collect:read}),/ARCHIVE_CONFIG_PERMISSIONS/);
});
test('OS-owned volume root retains unsafe grant/reparse/filesystem refusal',async()=>{
 const ti='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464',p=String.raw`C:\TEST_ONLY\file`;
 for(const extra of [{allows:[{sid:'S-1-1-0',mask:0x10000,inheritOnly:false}]},{reparse:true},{filesystem:'ReFS'}]){
  const chain=[p,String.raw`C:\TEST_ONLY`,'C:\\'].map(path=>({...base(),path}));Object.assign(chain[2],{owner:ti},extra);
  await assert.rejects(verifyWindowsArchivePaths([{path:p,privateFile:true}],{platform:'win32',collect:async()=>({currentSid:current,checks:[{path:p,chain}]})}),/ARCHIVE_CONFIG_PERMISSIONS/);
 }
});
test('native permission collector isolates incompatible inherited PowerShell module paths',{skip:process.platform!=='win32'},async()=>{
 const {default:os}=await import('node:os');const {default:path}=await import('node:path');const previous=process.env.PSModulePath;
 try{process.env.PSModulePath=[path.join(process.env.ProgramFiles,'PowerShell','7','Modules'),path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','Modules')].join(';');await verifyWindowsArchivePaths([{path:os.homedir(),privateFile:false}]);}
 finally{if(previous===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=previous;}
});
test('owner-relative grant never admits an untrusted owner or additional principal',()=>{
 const currentInfo={...base(),allows:[{sid:'S-1-3-4',mask:0x1f01ff,inheritOnly:false}]};
 assert.doesNotThrow(()=>validateWindowsArchiveDescriptor(currentInfo,current,{privateFile:true}));
 assert.throws(()=>validateWindowsArchiveDescriptor({...currentInfo,owner:'S-1-1-0'},current,{privateFile:true}),/ARCHIVE_CONFIG_PERMISSIONS/);
 assert.throws(()=>validateWindowsArchiveDescriptor({...currentInfo,allows:[...currentInfo.allows,{sid:'S-1-1-0',mask:1,inheritOnly:false}]},current,{privateFile:true}),/ARCHIVE_CONFIG_PERMISSIONS/);
 assert.throws(()=>validateWindowsArchiveDescriptor({...currentInfo,owner:'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'},current,{ancestor:true,volumeRoot:true}),/ARCHIVE_CONFIG_PERMISSIONS/);
});