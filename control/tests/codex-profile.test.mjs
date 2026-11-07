import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {codexSpawnPlan} from '../providers/codex/process.mjs';
import {NativeProfileBoundary,codexSpawnSnapshot,assertNativePolicy,CODEX_LIFECYCLE_PIN,CodexProfile} from '../providers/codex/compatibility.mjs';
import {LocalOwnerBoundary} from '../broker/local-owner.mjs';
import {fixture} from './fixtures/authority-fixture.mjs';
import {ControlError} from '../lib/errors.mjs';
test('vendor profile reader access never confers grant-manager owner authority',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t);assert.equal(spawnSync('icacls.exe',[f.directory,'/grant','*S-1-5-32-545:(OI)(CI)RX'],{windowsHide:true,stdio:'ignore'}).status,0);
  assert.equal(NativeProfileBoundary.open({directory:f.directory,account:f.account}).assertCurrent(),true);
  assert.throws(()=>LocalOwnerBoundary.open({directory:f.directory,account:f.account}),e=>e instanceof ControlError);
});
test('foreign write access refuses the native profile without changing its ACL',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t);assert.equal(spawnSync('icacls.exe',[f.directory,'/grant','*S-1-5-32-545:(OI)(CI)M'],{windowsHide:true,stdio:'ignore'}).status,0);
  assert.throws(()=>NativeProfileBoundary.open({directory:f.directory,account:f.account}),e=>e instanceof ControlError);
});
test('a foreign executable named codex.exe cannot become a lifecycle profile',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),exe=path.join(f.directory,'codex.exe');fs.writeFileSync(exe,'TEST_ONLY_NOT_A_CODEX_BINARY');
  assert.throws(()=>CodexProfile.open({profileId:f.profileId,accountRef:f.actorId,executable:exe,codexHome:f.directory,owner:f.ownerBoundary,schemaFile:exe}),e=>e instanceof ControlError&&e.code==='SCHEMA_MISMATCH');
});
test('native returned model, effort, tier and policy must exactly match selection',()=>{
  const profile={assertCurrent:()=>({...CODEX_LIFECYCLE_PIN,model:'gpt-6.1-sol'})},root={directory:'TEST_ONLY_ROOT'};
  const valid={model:'gpt-6.1-sol',modelProvider:'openai',reasoningEffort:'high',serviceTier:'default',cwd:root.directory,approvalPolicy:'never',approvalsReviewer:'user',instructionSources:[],sandbox:{type:'readOnly',networkAccess:false}};
  assert.equal(assertNativePolicy(valid,profile,root).sandbox,'read-only');
  for(const delta of [{model:'OTHER'},{modelProvider:'OTHER'},{reasoningEffort:'low'},{serviceTier:'fast'},{cwd:'OTHER'},{approvalPolicy:'on-request'},{approvalsReviewer:'auto_review'},{sandbox:{type:'dangerFullAccess'}},{sandbox:{type:'readOnly',networkAccess:true}}])assert.throws(()=>assertNativePolicy({...valid,...delta},profile,root),e=>e instanceof ControlError&&e.code==='STALE_CONTEXT');
});


test('missing native profile directory exposes no filesystem path',()=>{assert.throws(()=>NativeProfileBoundary.open({directory:path.resolve('TEST_ONLY_MISSING_PROFILE_'+Date.now()),account:'S-1-5-18'}),e=>e instanceof ControlError&&e.message==='Control foundation request refused'&&!e.cause);});
test('missing native config file exposes only fixed errors', {skip:process.platform!=='win32'},async t=>{const f=await fixture(t),boundary=NativeProfileBoundary.open({directory:f.directory,account:f.account});assert.throws(()=>boundary.readPrivateFile(path.join(f.directory,'config.toml')),e=>e instanceof ControlError&&e.message==='Control foundation request refused'&&!e.cause);});

const pinnedExe=path.join(process.env.LOCALAPPDATA??'', 'OpenAI/Codex/bin/2993767bd1dfb009/codex.exe'),schema=path.resolve('.local/p3-compatibility/normal/codex_app_server_protocol.v2.schemas.json');
test('positive pinned spawn plan disables native computer/shell/exec tools without starting a child',{skip:process.platform!=='win32'||!fs.existsSync(pinnedExe)||!fs.existsSync(schema)},async t=>{const f=await fixture(t),profile=CodexProfile.open({profileId:f.profileId,accountRef:f.actorId,executable:pinnedExe,codexHome:f.directory,owner:f.ownerBoundary,schemaFile:schema});try{const plan=codexSpawnPlan(profile,f.root);assert.equal(plan.options.shell,false);assert.equal(plan.options.windowsHide,true);assert.equal(plan.options.env.CODEX_HOME,f.directory);assert.equal(plan.options.env.OPENAI_API_KEY,undefined);assert.equal(plan.options.env.NODE_OPTIONS,undefined);for(const feature of ['hooks','plugins','apps','computer_use','shell_tool','unified_exec','unified_exec_tty','multi_agent','code_mode_host'])assert.ok(plan.args.some((v,i)=>v==='--disable'&&plan.args[i+1]===feature));}finally{profile.close();}});

test('native MCP overrides parse as existing bare keys and never launch the configured tool',{skip:process.platform!=='win32'||!fs.existsSync(pinnedExe)||!fs.existsSync(schema)},async t=>{const f=await fixture(t),file=path.join(f.directory,'config.toml');fs.writeFileSync(file,'[mcp_servers.TEST_ONLY-helper]\ncommand = "TEST_ONLY_NEVER_EXECUTED"\nenabled = true\n');const st=fs.lstatSync(file,{bigint:true}),profile=CodexProfile.open({profileId:f.profileId,accountRef:f.actorId,executable:pinnedExe,codexHome:f.directory,owner:f.ownerBoundary,schemaFile:schema,homeConfiguration:{version:1,mcpServerNames:['TEST_ONLY-helper'],fileSize:Number(st.size),mtimeNs:String(st.mtimeNs),inode:String(st.ino)}});try{const plan=codexSpawnPlan(profile,f.root);assert.ok(plan.args.includes('mcp_servers.TEST_ONLY-helper.enabled=false'));const args=plan.args.filter((v,i,a)=>v!=='--listen'&&a[i-1]!=='--listen');const result=spawnSync(plan.executable,[...args,'--print-startup-config'],{...plan.options,stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:10000,maxBuffer:65536});assert.equal(result.status,0);assert.ok(JSON.parse(result.stdout).configRequirements);}finally{profile.close();}});

test('real profile binds account/store metadata without opening credential contents',{skip:process.platform!=='win32'||!fs.existsSync(pinnedExe)||!fs.existsSync(schema)},async t=>{const f=await fixture(t),auth=path.join(f.directory,'auth.json');fs.writeFileSync(auth,'TEST_ONLY_CREDENTIAL_MUST_NOT_BE_READ');const owner=NativeProfileBoundary.open({directory:f.directory,account:f.account}),original=fs.openSync;let credentialOpens=0,profile;fs.openSync=(file,...args)=>{if(String(file)===auth){credentialOpens++;throw Error('TEST_ONLY_CREDENTIAL_OPEN');}return original(file,...args);};try{profile=CodexProfile.open({profileId:f.profileId,accountRef:f.actorId,executable:pinnedExe,codexHome:f.directory,owner,schemaFile:schema,selectExistingAccount:true});const account={account:{type:'chatgpt',email:'TEST_ONLY@example.invalid',planType:'pro'},requiresOpenaiAuth:true};assert.equal(profile.checkAccount(account).state,'AUTHENTICATED');assert.throws(()=>profile.checkAccount({...account,account:{...account.account,email:'OTHER@example.invalid'}}),e=>e instanceof ControlError&&e.code==='STALE_CONTEXT');assert.equal(credentialOpens,0);assert.equal(JSON.stringify(profile.metadata).includes('TEST_ONLY'),false);fs.writeFileSync(auth,'TEST_ONLY_CHANGED_ACCOUNT_STORE');assert.throws(()=>profile.assertCurrent(),e=>e instanceof ControlError&&e.code==='STALE_CONTEXT');}finally{fs.openSync=original;profile?.close();}});
test('native profile metadata boundary exposes no credential-content reader',{skip:process.platform!=='win32'},async t=>{const f=await fixture(t),owner=NativeProfileBoundary.open({directory:f.directory,account:f.account});fs.writeFileSync(path.join(f.directory,'auth.json'),'TEST_ONLY_CREDENTIAL');assert.throws(()=>owner.readPrivateFile(path.join(f.directory,'auth.json')),e=>e instanceof ControlError&&e.code==='CONTROL_DISABLED');});

test('spawn snapshot preserves selected effort and rejects profile drift before plan creation',{skip:process.platform!=='win32'||!fs.existsSync(pinnedExe)||!fs.existsSync(schema)},async t=>{
const f=await fixture(t),profile=CodexProfile.open({profileId:f.profileId,accountRef:f.actorId,executable:pinnedExe,codexHome:f.directory,owner:f.ownerBoundary,schemaFile:schema,reasoningEffort:'xhigh'});
try{const snapshot=codexSpawnSnapshot(profile);assert.equal(snapshot.effort,'xhigh');assert.equal(snapshot.executable,pinnedExe);assert.ok(Object.isFrozen(snapshot));assert.ok(Object.isFrozen(snapshot.disabledMcpServers));assert.throws(()=>codexSpawnSnapshot({spawnSnapshot:()=>snapshot}),e=>e instanceof ControlError);const plan=codexSpawnPlan(profile,f.root);assert.ok(plan.args.includes('model_reasoning_effort="xhigh"'));fs.writeFileSync(path.join(f.directory,'config.toml'),'TEST_ONLY_DRIFT');assert.throws(()=>codexSpawnSnapshot(profile),e=>e instanceof ControlError&&e.code==='STALE_CONTEXT');assert.throws(()=>codexSpawnPlan(profile,f.root),e=>e instanceof ControlError&&e.code==='STALE_CONTEXT');}finally{profile.close();}
});
