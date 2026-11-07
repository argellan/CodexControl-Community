import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {fixture} from './fixtures/authority-fixture.mjs';
import {CodexProfile,NativeProfileBoundary} from '../providers/codex/compatibility.mjs';
const exe=path.join(process.env.LOCALAPPDATA??'','OpenAI/Codex/bin/2993767bd1dfb009/codex.exe'),schema=path.resolve('.local/p3-compatibility/normal/codex_app_server_protocol.v2.schemas.json');
function consent(file){const s=fs.lstatSync(file,{bigint:true});return {version:1,evidenceRef:'TEST_ONLY_OWNER_GLOBAL_AGENTS',identity:Object.fromEntries(['dev','ino','size','mtimeNs','birthtimeNs','ctimeNs'].map(k=>[k,String(s[k])]))};}
async function setup(t){const f=await fixture(t),file=path.join(f.directory,'AGENTS.md');fs.writeFileSync(file,'TEST_ONLY_PRIVATE_INSTRUCTIONS');fs.writeFileSync(path.join(f.directory,'auth.json'),'TEST_ONLY_CREDENTIAL_NOT_READ');const options={profileId:f.profileId,accountRef:f.actorId,executable:exe,codexHome:f.directory,owner:NativeProfileBoundary.open({directory:f.directory,account:f.account}),schemaFile:schema,selectExistingAccount:true};return {f,file,options};}
const native={skip:process.platform!=='win32'||!fs.existsSync(exe)||!fs.existsSync(schema)};
test('global instruction file requires explicit version-bound consent',native,async t=>{const h=await setup(t);assert.throws(()=>CodexProfile.open(h.options));});
test('granted global source is exact, metadata pinned and never content-read',native,async t=>{
 const h=await setup(t),grant=consent(h.file),originalOpen=fs.openSync,originalRead=fs.readSync,originalReadFile=fs.readFileSync,held=new Set();let reads=0,profile;
 fs.openSync=(file,...args)=>{const fd=originalOpen(file,...args);if(String(file)===h.file)held.add(fd);return fd;};
 fs.readSync=(fd,...args)=>{if(held.has(fd)){reads++;throw Error('PRIVATE_INSTRUCTION_READ');}return originalRead(fd,...args);};
 fs.readFileSync=(file,...args)=>{if(String(file)===h.file){reads++;throw Error('PRIVATE_INSTRUCTION_READ');}return originalReadFile(file,...args);};
 try{profile=CodexProfile.open({...h.options,globalAgentsConsent:grant});assert.equal(typeof profile.checkInstructionSources,'function');assert.equal(profile.checkInstructionSources([h.file]).scope,'PINNED_GLOBAL_AGENTS');assert.throws(()=>profile.checkInstructionSources([path.join(h.f.root.directory,'AGENTS.md')]));assert.throws(()=>profile.checkInstructionSources([h.file,h.file]));assert.equal(reads,0);assert.equal(JSON.stringify(profile.metadata).includes('TEST_ONLY_PRIVATE'),false);assert.match(profile.metadata.instructionBinding,/^[a-f0-9]{64}$/);}
 finally{fs.openSync=originalOpen;fs.readSync=originalRead;fs.readFileSync=originalReadFile;profile?.close();}
});
test('global instruction version drift and override appearance fence the profile',native,async t=>{
 for(const kind of ['version','override']){const h=await setup(t),profile=CodexProfile.open({...h.options,globalAgentsConsent:consent(h.file)});try{if(kind==='version')fs.appendFileSync(h.file,'CHANGED');else fs.writeFileSync(path.join(h.f.directory,'AGENTS.override.md'),'OTHER');assert.throws(()=>profile.assertCurrent(),e=>e.code==='STALE_CONTEXT');}finally{profile.close();}}
});
test('consent for an older file version cannot silently repin',native,async t=>{const h=await setup(t),grant=consent(h.file);fs.appendFileSync(h.file,'CHANGED');assert.throws(()=>CodexProfile.open({...h.options,globalAgentsConsent:grant}));});