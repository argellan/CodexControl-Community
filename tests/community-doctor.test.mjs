// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {communityDoctor,parseDoctorArguments} from '../scripts/community-doctor.mjs';

async function fixture(run){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-doctor-TEST_ONLY-')),app=path.join(directory,'app'),instance=path.join(directory,'instance'),data=path.join(instance,'data');
 try{
  for(const folder of [app,path.join(app,'scripts'),path.join(app,'lib'),path.join(app,'public'),instance,data])await fs.mkdir(folder,{recursive:true,mode:0o700});
  for(const file of ['server.mjs','collector.mjs','scripts/setup-instance.mjs','lib/usage-samples.mjs','public/index.html'])await fs.writeFile(path.join(app,file),'TEST_ONLY fixture');
  await fs.writeFile(path.join(instance,'installation.json'),JSON.stringify({schemaVersion:1,mode:'single-computer',hostId:'PRIVATE-IDENTITY',appDirectory:app,sessionRoot:'PRIVATE-SOURCE-PATH'}),{mode:0o600});
  await fs.writeFile(path.join(instance,'hub.json'),JSON.stringify({instanceId:'PRIVATE-INSTANCE',instanceName:'PRIVATE-LABEL',hosts:[],viewers:[{id:'PRIVATE-USER',tokenHash:'PRIVATE-CREDENTIAL'}],dataDirectory:data,port:4317,listen:'127.0.0.1',publicOrigin:'http://127.0.0.1:4317'}),{mode:0o600});
  await fs.writeFile(path.join(instance,'owner-access.json'),'PRIVATE-OWNER-KEY');await fs.writeFile(path.join(instance,'auth.json'),'PRIVATE-PROVIDER-AUTH');await fs.writeFile(path.join(data,'history.sqlite'),'PRIVATE-HISTORY-BYTES');
  return await run({directory,app,instance,data});
 }finally{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('cc-doctor-TEST_ONLY-'));await fs.rm(directory,{recursive:true,force:true});}
}

test('local doctor redacts metadata values, opens only fixed config metadata and never changes history or credentials',()=>fixture(async({app,instance,data})=>{
 const before=await Promise.all(['installation.json','hub.json','owner-access.json','auth.json'].map(f=>fs.readFile(path.join(instance,f),'utf8'))),history=await fs.readFile(path.join(data,'history.sqlite'),'utf8');
 const result=await communityDoctor({applicationDirectory:app,instanceDirectory:instance}),text=JSON.stringify(result);assert.notEqual(result.status,'fail');assert.equal(result.readOnly,true);assert.equal(result.networkUsed,false);assert.equal(result.childProcessesUsed,false);assert.equal(result.limits.opensHistoryDatabase,false);assert.equal(result.limits.qualifiesInstallation,false);assert.ok(!text.includes('PRIVATE'));assert.ok(!text.includes(instance));assert.ok(!text.includes(app));
 assert.deepEqual(await Promise.all(['installation.json','hub.json','owner-access.json','auth.json'].map(f=>fs.readFile(path.join(instance,f),'utf8'))),before);assert.equal(await fs.readFile(path.join(data,'history.sqlite'),'utf8'),history);
}));

test('default doctor does not discover private instances, source logs, provider auth or a network endpoint',async t=>{
 let network=0; t.mock.method(globalThis,'fetch',()=>{network++;throw new Error('TEST_ONLY network forbidden');});const opened=[],original=fs.open;t.mock.method(fs,'open',async function(file,...args){opened.push(String(file));return original.call(this,file,...args);});
 const result=await communityDoctor();assert.equal(network,0);assert.ok(result.checks.some(c=>c.code==='INSTANCE_NOT_REQUESTED'));assert.ok(opened.every(f=>f==='/proc/self/mountinfo'));assert.equal(result.limits.readsProviderAuth,false);
});

test('malformed and oversized private metadata returns fixed codes without echoing file paths or raw errors',()=>fixture(async({app,instance})=>{
 await fs.writeFile(path.join(instance,'hub.json'),'PRIVATE-BROKEN-'+instance);const broken=await communityDoctor({applicationDirectory:app,instanceDirectory:instance});assert.equal(broken.status,'fail');assert.ok(broken.checks.some(c=>c.code==='METADATA_JSON_INVALID'));assert.ok(!JSON.stringify(broken).includes(instance));assert.ok(!JSON.stringify(broken).includes('PRIVATE-BROKEN'));
 await fs.writeFile(path.join(instance,'hub.json'),'x'.repeat(1048577));const large=await communityDoctor({applicationDirectory:app,instanceDirectory:instance});assert.equal(large.status,'fail');assert.ok(large.checks.some(c=>c.code==='REGULAR_BOUNDED_FILE_REQUIRED'));
}));

test('network and unqualified filesystems are refused before private metadata is opened',async t=>{
 const original=fs.open,opened=[];t.mock.method(fs,'open',async function(file,...args){opened.push(String(file));return original.call(this,file,...args);});
 const result=await communityDoctor({instanceDirectory:path.resolve('TEST_ONLY-private')},{platform:'linux',mountInfo:'1 0 0:1 / / rw - cifs example rw\n'});assert.equal(result.status,'fail');assert.ok(result.checks.some(c=>c.code==='NETWORK_OR_UNQUALIFIED_FILESYSTEM_REFUSED'));assert.deepEqual(opened,[]);
 const unc=await communityDoctor({instanceDirectory:'\\\\TEST_ONLY-server\\share\\private'});assert.ok(unc.checks.some(c=>c.code==='ABSOLUTE_LOCAL_DIRECTORY_REQUIRED'));
});

test('short mount-table reads cannot hide a later network mount behind a local root classification',t=>fixture(async({app,instance})=>{
 const escaped=value=>value.replace(/\\/g,'\\134').replace(/ /g,'\\040'),root=path.parse(instance).root;
 const mountText=Buffer.from(`1 0 0:1 / ${escaped(root)} rw - ext4 local rw\n2 1 0:2 / ${escaped(instance)} rw - cifs network rw\n`),originalOpen=fs.open,originalStat=fs.lstat,opened=[];
 t.mock.method(fs,'lstat',async function(file,...args){if(file==='/proc/self/mountinfo')return {size:0,isSymbolicLink:()=>false,isFile:()=>true};return originalStat.call(this,file,...args);});
 t.mock.method(fs,'open',async function(file,...args){opened.push(String(file));if(file==='/proc/self/mountinfo'){let position=0;return {read:async(buffer,offset,length)=>{const bytes=Math.min(length,23,mountText.length-position);mountText.copy(buffer,offset,position,position+bytes);position+=bytes;return {bytesRead:bytes};},close:async()=>{}};}return originalOpen.call(this,file,...args);});
 const result=await communityDoctor({applicationDirectory:app,instanceDirectory:instance},{platform:'linux'});assert.ok(result.checks.some(c=>c.name==='instance-storage'&&c.code==='NETWORK_OR_UNQUALIFIED_FILESYSTEM_REFUSED'));assert.ok(!opened.includes(path.join(instance,'hub.json')));
}));

test('linked instance roots are refused and a future runtime is reported outside the qualified baseline',()=>fixture(async({directory,app,instance})=>{
 const link=path.join(directory,'instance-link');await fs.symlink(instance,link,process.platform==='win32'?'junction':'dir');const linked=await communityDoctor({applicationDirectory:app,instanceDirectory:link});assert.equal(linked.status,'fail');assert.ok(linked.checks.some(c=>c.code==='DIRECTORY_LINK_OR_TYPE_REFUSED'));
 const newer=await communityDoctor({applicationDirectory:app},{nodeVersion:'25.0.0'});assert.ok(newer.checks.some(c=>c.code==='RUNTIME_DIFFERS_FROM_QUALIFIED_BASELINE'));const older=await communityDoctor({applicationDirectory:app},{nodeVersion:'23.9.0'});assert.equal(older.status,'fail');
}));

test('doctor CLI accepts only bounded local metadata arguments and never prints a requested private path',async()=>{
 for(const args of [['--run=anything'],['--instance-dir='],['--instance-dir=/TEST_ONLY/a','--instance-dir=/TEST_ONLY/b'],['--upload']])assert.throws(()=>parseDoctorArguments(args),e=>e.diagnosticCode==='DOCUMENTED_ARGUMENTS_REQUIRED');
 const script=path.resolve('scripts/community-doctor.mjs'),result=await promisify(execFile)(process.execPath,[script],{timeout:5000,windowsHide:true});const report=JSON.parse(result.stdout);assert.equal(report.readOnly,true);assert.equal(report.childProcessesUsed,false);assert.equal(report.networkUsed,false);
});

test('diagnostic implementation has no subprocess, network, shell, model or mutable filesystem code paths',async()=>{
 const source=await fs.readFile(new URL('../scripts/community-doctor.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/node:(?:child_process|http|https|net|dgram|sqlite)/);assert.doesNotMatch(source,/\b(?:fetch|spawn|execFile|execSync|writeFile|appendFile|unlink|rename|chmod|mkdir|rm)\s*\(/);
});
