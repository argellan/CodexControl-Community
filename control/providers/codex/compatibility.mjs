import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ControlError} from '../../lib/errors.mjs';
import {strictRecord,uuid,deepFreeze,arrayValues,opaqueToken} from '../../lib/privacy.mjs';
import {LocalOwnerBoundary,assertLocalOwner,localDirectory as baseLocalDirectory} from '../../broker/local-owner.mjs';

const fail=code=>{throw new ControlError(code??'CONTROL_DISABLED');};
function localDirectory(value){try{return baseLocalDirectory(value);}catch(error){if(error instanceof ControlError)throw error;fail('STORAGE_UNAVAILABLE');}}
export const CODEX_LIFECYCLE_PIN=deepFreeze({
  version:'codex-cli 0.164.0-alpha.11.1',platform:'win32',arch:'x64',
  executableSha256:'1103e9e09c71fa2cd0afd6d8f3b9a2d63174fe8efd7cb5bd09f1cb14ef58a098',
  schemaSha256:'8fe0d6335768743b8388dfdbe95fef85303524093e2dffc301704555e73e718f',
  maturity:'EXPERIMENTAL_PREVIEW',adapterVersion:1
});
export const LIFECYCLE_METHODS=Object.freeze(['initialize','account/read','config/read','model/list','thread/start','thread/resume','turn/start','turn/steer','turn/interrupt']);
export const NATIVE_HOME_CONFIG='model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\nservice_tier = "default"\napproval_policy = "never"\napprovals_reviewer = "user"\nsandbox_mode = "read-only"\n';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fileHash(fd){const h=createHash('sha256'),chunk=Buffer.alloc(1048576);let position=0,n;while((n=fs.readSync(fd,chunk,0,chunk.length,position))>0){h.update(chunk.subarray(0,n));position+=n;}chunk.fill(0);return h.digest('hex');}
const identities=new WeakSet();
function same(a,b){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.birthtimeNs===b.birthtimeNs;}
function local(value){if(typeof value!=='string'||!path.isAbsolute(value)||/^(?:\\\\|\/\/)/.test(value))fail('INVALID_INPUT');return path.resolve(value);}
/** Native vendor profile: owner-bound and no foreign writers. Read-only vendor sandbox access is retained. This conveys no grant-management authority. */
export class NativeProfileBoundary {
  #directory;#account;
  static open(options){return new NativeProfileBoundary(options);}
  constructor(options){strictRecord(options,['directory','account']);this.#directory=localDirectory(options.directory);if(typeof options.account!=='string'||!/^S-1-[0-9-]+$/.test(options.account))fail('INVALID_INPUT');this.#account=options.account;this.assertCurrent();Object.freeze(this);}
  get directory(){return this.#directory;}
  assertCurrent(file=null){
    localDirectory(this.#directory);if(file!==null&&!['config.toml','auth.json','AGENTS.md'].some(name=>file===path.join(this.#directory,name)))fail('INVALID_INPUT');
    const script="$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd()|ConvertFrom-Json;$s=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$a=if($p.file){[IO.File]::GetAccessControl($p.file)}else{[IO.Directory]::GetAccessControl($p.directory)};$ok=($s -eq $p.account -and $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $s);$w=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership;foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin @($s,'S-1-5-18','S-1-5-32-544') -and ($r.FileSystemRights -band $w) -ne 0){$ok=$false}};@{ok=$ok}|ConvertTo-Json -Compress";
    const r=spawnSync(path.join(process.env.SystemRoot??'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{input:JSON.stringify({directory:this.#directory,account:this.#account,file}),encoding:'utf8',windowsHide:true,shell:false,timeout:5000,maxBuffer:4096});
    try{if(r.status!==0||JSON.parse(r.stdout).ok!==true)fail();}catch{fail();}return true;
  }
  readPrivateFile(file){try{if(file!==path.join(this.#directory,'config.toml'))fail('CONTROL_DISABLED');this.assertCurrent(file);const before=fs.lstatSync(file,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>524288n)fail();const fd=fs.openSync(file,fs.constants.O_RDONLY);try{if(!same(before,fs.fstatSync(fd,{bigint:true})))fail('STALE_CONTEXT');const bytes=fs.readFileSync(fd);if(!same(before,fs.lstatSync(file,{bigint:true}))) {bytes.fill(0);fail('STALE_CONTEXT');}this.assertCurrent(file);return bytes;}finally{fs.closeSync(fd);}}catch(error){if(error instanceof ControlError)throw error;fail('STORAGE_UNAVAILABLE');}}
}
export class CodexProfile {
  #exe;#fd;#stat;#home;#homeFd;#homeStat;#owner;#email;#metadata;#authFile;#authStat=null;#configuration=null;#servers=[];#select=false;#closed=false;#instructionFile=null;#instructionStat=null;#instructionFd;#instructionBinding=null;
  static open(options){try{return new CodexProfile(options);}catch(error){if(error instanceof ControlError)throw error;fail('CONTROL_DISABLED');}}
  constructor(options){
    strictRecord(options,['profileId','accountRef','executable','codexHome','owner','schemaFile','expectedEmail','homeConfiguration','selectExistingAccount','globalAgentsConsent','reasoningEffort'],['profileId','accountRef','executable','codexHome','owner','schemaFile']);
    if(options.reasoningEffort!==undefined&&!['high','xhigh'].includes(options.reasoningEffort))fail('INVALID_INPUT');
    if(process.platform!==CODEX_LIFECYCLE_PIN.platform||process.arch!==CODEX_LIFECYCLE_PIN.arch)fail();
    this.#exe=local(options.executable);this.#home=local(options.codexHome);
    if(options.owner instanceof LocalOwnerBoundary)assertLocalOwner(options.owner,this.#home);else if(!(options.owner instanceof NativeProfileBoundary)||options.owner.directory!==this.#home)fail();options.owner.assertCurrent();this.#owner=options.owner;
    if(options.expectedEmail!==undefined&&(typeof options.expectedEmail!=='string'||options.expectedEmail.length<3||options.expectedEmail.length>254))fail('INVALID_INPUT');this.#email=options.expectedEmail??null;if(options.selectExistingAccount!==undefined&&typeof options.selectExistingAccount!=='boolean')fail('INVALID_INPUT');this.#select=options.selectExistingAccount??false;
    try{
      const stat=fs.lstatSync(this.#exe,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.size>536870912n)fail();
      this.#fd=fs.openSync(this.#exe,fs.constants.O_RDONLY);this.#stat=fs.fstatSync(this.#fd,{bigint:true});
      if(!same(stat,this.#stat)||fileHash(this.#fd)!==CODEX_LIFECYCLE_PIN.executableSha256)fail('SCHEMA_MISMATCH');
      const schema=local(options.schemaFile),schemaStat=fs.lstatSync(schema);if(!schemaStat.isFile()||schemaStat.isSymbolicLink()||schemaStat.size>2097152)fail('SCHEMA_MISMATCH');
      if(hash(fs.readFileSync(schema))!==CODEX_LIFECYCLE_PIN.schemaSha256)fail('SCHEMA_MISMATCH');
      this.#homeFd=fs.openSync(this.#home,fs.constants.O_RDONLY);this.#homeStat=fs.fstatSync(this.#homeFd,{bigint:true});
      const config=path.join(this.#home,'config.toml');if(fs.existsSync(config)){const bytes=this.#owner.readPrivateFile(config);try{const stat=fs.lstatSync(config,{bigint:true});if(bytes.toString('utf8')!==NATIVE_HOME_CONFIG){const c=options.homeConfiguration;strictRecord(c,['version','mcpServerNames','fileSize','mtimeNs','inode']);if(c.version!==1||String(stat.ino)!==c.inode||String(stat.mtimeNs)!==c.mtimeNs||Number(stat.size)!==c.fileSize)fail('STALE_CONTEXT');this.#servers=arrayValues(c.mcpServerNames,0,64).map(opaqueToken);if(this.#servers.some(name=>!/^[A-Za-z0-9_-]+$/.test(name))||new Set(this.#servers).size!==this.#servers.length)fail('INVALID_INPUT');}this.#configuration=stat;}finally{bytes.fill(0);}}
      this.#authFile=path.join(this.#home,'auth.json');if(fs.existsSync(this.#authFile)){if(!(this.#owner instanceof NativeProfileBoundary))fail('CONTROL_DISABLED');this.#owner.assertCurrent(this.#authFile);const a=fs.lstatSync(this.#authFile,{bigint:true});if(!a.isFile()||a.isSymbolicLink()||a.nlink!==1n)fail();this.#authStat=a;}
      if(options.globalAgentsConsent!==undefined){
        const consent=options.globalAgentsConsent;strictRecord(consent,['version','evidenceRef','identity']);strictRecord(consent.identity,['dev','ino','size','mtimeNs','birthtimeNs','ctimeNs']);opaqueToken(consent.evidenceRef);if(consent.version!==1||options.selectExistingAccount!==true||!this.#authStat||!(this.#owner instanceof NativeProfileBoundary))fail('CONTROL_DISABLED');
        if(fs.existsSync(path.join(this.#home,'AGENTS.override.md')))fail('CONTROL_DISABLED');
        const file=path.join(this.#home,'AGENTS.md');this.#owner.assertCurrent(file);const stat=fs.lstatSync(file,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.size<1n||stat.size>524288n)fail('CONTROL_DISABLED');
        for(const key of ['dev','ino','size','mtimeNs','birthtimeNs','ctimeNs'])if(typeof consent.identity[key]!=='string'||consent.identity[key]!==String(stat[key]))fail('STALE_CONTEXT');
        this.#instructionFile=file;this.#instructionStat=stat;this.#instructionFd=fs.openSync(file,fs.constants.O_RDONLY);const held=fs.fstatSync(this.#instructionFd,{bigint:true});if(!same(stat,held)||stat.ctimeNs!==held.ctimeNs)fail('STALE_CONTEXT');
        this.#instructionBinding=hash(Buffer.from(JSON.stringify({evidenceRef:consent.evidenceRef,identity:consent.identity,profileId:uuid(options.profileId),accountRef:uuid(options.accountRef)})));
      }
      const accountBinding=this.#authStat?hash(Buffer.from(JSON.stringify({accountRef:uuid(options.accountRef),homeDev:String(this.#homeStat.dev),homeIno:String(this.#homeStat.ino),authDev:String(this.#authStat.dev),authIno:String(this.#authStat.ino),authMtime:String(this.#authStat.mtimeNs),authSize:String(this.#authStat.size)}))):randomUUID();
      this.#metadata=deepFreeze({accountBinding,instructionBinding:this.#instructionBinding,profileId:uuid(options.profileId),accountRef:uuid(options.accountRef),...CODEX_LIFECYCLE_PIN,
        model:'gpt-6.1-sol',effort:options.reasoningEffort??'high',serviceTier:'default',approvalPolicy:'never',approvalsReviewer:'user',sandbox:'read-only'});
      this.assertCurrent();identities.add(this);
    }catch(error){this.close();if(error instanceof ControlError)throw error;fail();}
  }
  assertCurrent(){
    if(this.#closed)fail('CLOSED');this.#owner.assertCurrent();
    try{
      if(!same(fs.lstatSync(this.#exe,{bigint:true}),this.#stat)||!same(fs.fstatSync(this.#fd,{bigint:true}),this.#stat))fail('STALE_CONTEXT');
      const current=fs.lstatSync(this.#home,{bigint:true}),held=fs.fstatSync(this.#homeFd,{bigint:true});
      if(current.isSymbolicLink()||current.dev!==this.#homeStat.dev||current.ino!==this.#homeStat.ino||held.ino!==current.ino)fail('STALE_CONTEXT');
      const config=path.join(this.#home,'config.toml');if(this.#configuration){const current=fs.lstatSync(config,{bigint:true});if(current.isSymbolicLink()||!same(current,this.#configuration))fail('STALE_CONTEXT');}else if(fs.existsSync(config))fail('STALE_CONTEXT');
      if(this.#authStat){const a=fs.lstatSync(this.#authFile,{bigint:true});if(a.isSymbolicLink()||!same(a,this.#authStat))fail('STALE_CONTEXT');}else if(fs.existsSync(this.#authFile))fail('STALE_CONTEXT');
      this.#assertInstructions();return this.#metadata;
    }catch(error){if(error instanceof ControlError)throw error;fail('STALE_CONTEXT');}
  }
  #assertInstructions(){
    if(this.#instructionFile){if(fs.existsSync(path.join(this.#home,'AGENTS.override.md')))fail('STALE_CONTEXT');const current=fs.lstatSync(this.#instructionFile,{bigint:true}),held=fs.fstatSync(this.#instructionFd,{bigint:true});if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1n||!same(current,this.#instructionStat)||current.ctimeNs!==this.#instructionStat.ctimeNs||!same(held,this.#instructionStat)||held.ctimeNs!==this.#instructionStat.ctimeNs)fail('STALE_CONTEXT');}
    else for(const name of ['AGENTS.md','AGENTS.override.md']){const file=path.join(this.#home,name);if(fs.existsSync(file)){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>0)fail('STALE_CONTEXT');}}
  }
  checkInstructionSources(sources){this.assertCurrent();const values=arrayValues(sources,0,1);if(values.length){const file=values[0];if(!this.#instructionFile||typeof file!=='string'||!path.isAbsolute(file)||path.toNamespacedPath(path.resolve(file)).toLowerCase()!==path.toNamespacedPath(this.#instructionFile).toLowerCase())fail('STALE_CONTEXT');}return deepFreeze({scope:values.length?'PINNED_GLOBAL_AGENTS':'NONE',instructionBinding:this.#instructionBinding});}
  checkAccount(result){
    this.assertCurrent();
    if(!result||typeof result!=='object'||!Object.hasOwn(result,'account')||typeof result.requiresOpenaiAuth!=='boolean')fail('SCHEMA_MISMATCH');
    if(result.account===null)return deepFreeze({state:'UNAUTHENTICATED',accountRef:this.#metadata.accountRef});
    // Explicit account identity stays in private configuration/RAM, never telemetry.
    if(!this.#authStat)fail('CONTROL_DISABLED');
    if(this.#email===null&&this.#select&&result.account.type==='chatgpt'&&typeof result.account.email==='string'&&result.account.email.length<=254){this.#email=result.account.email;this.#select=false;}
    if(!this.#email||result.account.type!=='chatgpt'||result.account.email!==this.#email)fail('STALE_CONTEXT');
    return deepFreeze({state:'AUTHENTICATED',accountRef:this.#metadata.accountRef});
  }
  spawnSnapshot(){this.assertCurrent();return deepFreeze({executable:this.#exe,codexHome:this.#home,disabledMcpServers:[...this.#servers],effort:this.#metadata.effort});}
  get disabledMcpServers(){this.assertCurrent();return [...this.#servers];}
  get executable(){this.assertCurrent();return this.#exe;}
  get codexHome(){this.assertCurrent();return this.#home;}
  get metadata(){return this.assertCurrent();}
  close(){if(this.#closed)return;this.#closed=true;for(const fd of [this.#fd,this.#homeFd,this.#instructionFd])if(fd!==undefined)try{fs.closeSync(fd);}catch{}this.#email=null;}
}
export function assertCodexProfile(profile){if(!identities.has(profile))fail();return profile.assertCurrent();}
export function codexSpawnSnapshot(profile){if(!identities.has(profile))fail();return CodexProfile.prototype.spawnSnapshot.call(profile);}
const sessionPolicyBindings=new WeakMap();
export function bindNativeSessionPolicy(profile,root,params){
  const selected=profile.assertCurrent();
  strictRecord(params,['cwd','model','modelProvider','approvalPolicy','approvalsReviewer','sandbox','serviceTier','config','baseInstructions','developerInstructions','ephemeral','threadId','excludeTurns'],['cwd','model','modelProvider','approvalPolicy','approvalsReviewer','sandbox','serviceTier','config','baseInstructions','developerInstructions']);
  strictRecord(params.config,['model_reasoning_effort','project_doc_max_bytes']);
  if(selected.executableSha256!==CODEX_LIFECYCLE_PIN.executableSha256||selected.schemaSha256!==CODEX_LIFECYCLE_PIN.schemaSha256||selected.model!=='gpt-6.1-sol'||!['high','xhigh'].includes(selected.effort)||selected.serviceTier!=='default'||typeof selected.accountBinding!=='string'||params.cwd!==root.directory||params.model!==selected.model||params.modelProvider!=='openai'||params.approvalPolicy!=='never'||params.approvalsReviewer!=='user'||params.sandbox!=='read-only'||params.serviceTier!=='default'||params.config.model_reasoning_effort!==selected.effort||params.config.project_doc_max_bytes!==0||typeof params.baseInstructions!=='string'||params.baseInstructions.length>4096||typeof params.developerInstructions!=='string'||params.developerInstructions.length>4096)fail('STALE_CONTEXT');
  if(Object.hasOwn(params,'threadId')){opaqueToken(params.threadId);if(params.excludeTurns!==true||Object.hasOwn(params,'ephemeral'))fail('INVALID_INPUT');}else if(params.ephemeral!==false||Object.hasOwn(params,'excludeTurns'))fail('INVALID_INPUT');
  deepFreeze(params);const proof=Object.freeze({});sessionPolicyBindings.set(proof,{profile,root,params,accountBinding:selected.accountBinding,instructionBinding:selected.instructionBinding??null,executableSha256:selected.executableSha256,schemaSha256:selected.schemaSha256});return proof;
}
export function assertNativePolicy(result,profile,root,proof=undefined){
  const selected=profile.assertCurrent(),binding=sessionPolicyBindings.get(proof);
  if(proof!==undefined){sessionPolicyBindings.delete(proof);if(!binding||binding.profile!==profile||binding.root!==root||binding.params.cwd!==root.directory||binding.params.model!==selected.model||binding.params.config.model_reasoning_effort!==selected.effort||binding.accountBinding!==selected.accountBinding||binding.instructionBinding!==(selected.instructionBinding??null)||binding.executableSha256!==selected.executableSha256||binding.schemaSha256!==selected.schemaSha256||selected.serviceTier!=='default')fail('STALE_CONTEXT');}
  const boundNullable=result?.serviceTier===null&&!!binding;
  if(!result||typeof result!=='object'||result.model!==selected.model||result.modelProvider!=='openai'||result.reasoningEffort!==(selected.effort??'high')||(result.serviceTier!=='default'&&!boundNullable)||result.cwd!==root.directory||result.approvalPolicy!=='never'||result.approvalsReviewer!=='user'||result.sandbox?.type!=='readOnly'||result.sandbox.networkAccess===true||!Array.isArray(result.instructionSources))fail('STALE_CONTEXT');
  if(typeof profile.checkInstructionSources==='function')profile.checkInstructionSources(result.instructionSources);else if(result.instructionSources.length!==0)fail('STALE_CONTEXT');
  return deepFreeze({model:result.model,effort:result.reasoningEffort,serviceTier:result.serviceTier,requestedServiceTier:'default',sandbox:'read-only',approvalPolicy:'never'});
}
