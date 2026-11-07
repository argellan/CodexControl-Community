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
import http from 'node:http';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createInstance,validateOrigin,verifyIdentity,updateApplication} from '../scripts/setup-instance.mjs';
const packaging=await import('../scripts/package-release.mjs').catch(()=>({}));
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const protectTlsKey=(file,broad=false)=>{if(process.platform!=='win32')return fs.chmod(file,broad?0o644:0o600);const script=String.raw`$ErrorActionPreference='Stop';try{$p=[Console]::In.ReadToEnd()|ConvertFrom-Json;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.FileSecurity;$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($sid);foreach($s in @($sid.Value,'S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($s)),'FullControl','Allow')))};if($p.broad){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-1-0')),'Read','Allow')))};[IO.File]::SetAccessControl($p.path,$acl);[Console]::Out.Write('OK')}catch{exit 1}`;const result=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:JSON.stringify({path:file,broad}),encoding:'utf8',timeout:5000,windowsHide:true});assert.equal(result.status,0,'TEST_ONLY TLS ACL setup');assert.equal(result.stdout,'OK');};
async function fixture(run){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-release-TEST_ONLY-'));try{await run(directory);}finally{const resolved=path.resolve(directory);assert.ok(path.dirname(resolved)===path.resolve(os.tmpdir())&&path.basename(resolved).startsWith('cc-release-TEST_ONLY-'));await fs.rm(resolved,{recursive:true,force:true});}}

test('fresh setup writes private distinct credentials and metadata without source edits or secret stdout',()=>fixture(async directory=>{
 const instanceDirectory=path.join(directory,'instance'),result=await createInstance({mode:'single-computer',hostId:'test-only-source',instanceDirectory,appDirectory:ROOT});
 const config=JSON.parse(await fs.readFile(result.hubConfig,'utf8')),access=JSON.parse(await fs.readFile(result.ownerAccessFile,'utf8'));
 assert.equal(result.status,'PREPARED_NOT_STARTED');assert.equal(config.instanceId,access.instanceId);assert.equal(config.viewers[0].role,'admin');assert.equal(config.viewers[0].hostIds,null);assert.equal(config.viewers[0].projectIds,null);assert.equal(config.viewers[0].tokenHash,crypto.createHash('sha256').update(access.token).digest('hex'));assert.ok(!JSON.stringify(result).includes(access.token));assert.ok(path.isAbsolute(config.dataDirectory));
 if(process.platform!=='win32')assert.equal((await fs.stat(result.ownerAccessFile)).mode&0o777,0o600);
 await assert.rejects(createInstance({mode:'single-computer',hostId:'test-only-source',instanceDirectory,appDirectory:ROOT}),/already exists/);
}));

test('setup rejects a privileged port before creating instance data or credentials',()=>fixture(async directory=>{
 const instanceDirectory=path.join(directory,'rejected-port');await assert.rejects(createInstance({mode:'single-computer',hostId:'test-only-source',instanceDirectory,appDirectory:ROOT,port:443}),/port/i);await assert.rejects(fs.access(instanceDirectory),error=>error.code==='ENOENT');
}));

test('fleet setup requires secure origin and expected source identity; owner and collector credentials differ',()=>fixture(async directory=>{
 await assert.rejects(createInstance({mode:'fleet-hub',hostId:'test-hub',instanceDirectory:path.join(directory,'bad'),publicOrigin:'http://dashboard.example.com'}),/HTTPS/);
 const cert=path.join(directory,'TEST_ONLY.crt'),key=path.join(directory,'TEST_ONLY.key');await fs.writeFile(cert,'TEST_ONLY readable fixture; not a certificate');await fs.writeFile(key,'TEST_ONLY readable fixture; not a key');await protectTlsKey(key,true);
 await assert.rejects(createInstance({mode:'fleet-hub',hostId:'test-hub',firstHostId:'test-laptop',expectedHostname:'TEST-LAPTOP',instanceDirectory:path.join(directory,'fleet'),appDirectory:ROOT,publicOrigin:'https://dashboard.example.com:4317',tlsCert:cert,tlsKey:key}),/private key/i);
 await assert.rejects(fs.access(path.join(directory,'fleet')),error=>error.code==='ENOENT');await protectTlsKey(key);
 const result=await createInstance({mode:'fleet-hub',hostId:'test-hub',firstHostId:'test-laptop',expectedHostname:'TEST-LAPTOP',instanceDirectory:path.join(directory,'fleet'),appDirectory:ROOT,publicOrigin:'https://dashboard.example.com:4317',tlsCert:cert,tlsKey:key}),collector=JSON.parse(await fs.readFile(result.enrollmentFile,'utf8')),owner=JSON.parse(await fs.readFile(result.ownerAccessFile,'utf8'));
 assert.notEqual(collector.token,owner.token);assert.equal(collector.expectedInstanceId,result.instanceId);assert.equal(collector.expectedHostname,'TEST-LAPTOP');assert.ok(!JSON.stringify(result).includes(collector.token));assert.match(result.tlsVerification,/Private key file permissions checked/);
}));

test('identity probe is unauthenticated, bounded and rejects mismatched deployment/machine identities',async()=>{
 let authorization='unobserved';const server=http.createServer((req,res)=>{authorization=req.headers.authorization;res.setHeader('content-type','application/json');res.end(JSON.stringify({deploymentId:'TEST_ONLY-instance',readOnly:true,protocolVersion:1}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const origin=`http://127.0.0.1:${server.address().port}`;assert.equal((await verifyIdentity({origin,expectedInstanceId:'TEST_ONLY-instance'})).verified,true);assert.equal(authorization,undefined);await assert.rejects(verifyIdentity({origin,expectedInstanceId:'wrong'}),/mismatch/);await assert.rejects(verifyIdentity({origin,expectedInstanceId:'TEST_ONLY-instance',expectedHostname:'OTHER',hostname:'FIXTURE'}),/hostname/);assert.throws(()=>validateOrigin('https://user:password@example.com'),/credentials/);}finally{await new Promise(r=>server.close(r));}
});

test('setup HTTPS identity probe forces certificate verification despite an insecure external environment',async t=>{
 const previous=process.env.NODE_TLS_REJECT_UNAUTHORIZED;process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';t.after(()=>{if(previous===undefined)delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;else process.env.NODE_TLS_REJECT_UNAUTHORIZED=previous;});let captured;
 t.mock.method(https,'get',(url,options,callback)=>{captured={url,options};const request=new EventEmitter();request.destroy=error=>request.emit('error',error);queueMicrotask(()=>{const response=new EventEmitter();response.statusCode=200;callback(response);response.emit('data',Buffer.from(JSON.stringify({deploymentId:'TEST_ONLY-instance',readOnly:true,protocolVersion:1})));response.emit('end');});return request;});
 assert.equal((await verifyIdentity({origin:'https://dashboard.example.com',expectedInstanceId:'TEST_ONLY-instance'})).verified,true);assert.equal(captured.options.rejectUnauthorized,true);assert.equal(captured.options.headers.authorization,undefined);
});

test('application update refuses unqualified source without changing its pointer or private identity',()=>fixture(async directory=>{
 const result=await createInstance({mode:'single-computer',hostId:'fixture',instanceDirectory:path.join(directory,'instance'),appDirectory:ROOT}),before=await fs.readFile(result.hubConfig,'utf8'),replacement=path.join(directory,'new-app');await fs.mkdir(replacement);await fs.writeFile(path.join(replacement,'server.mjs'),'// TEST_ONLY');await fs.writeFile(path.join(replacement,'collector.mjs'),'// TEST_ONLY');
 await assert.rejects(updateApplication({instanceDirectory:result.directory,appDirectory:replacement}),/ENOENT|performance-qualified/);assert.equal(await fs.readFile(result.hubConfig,'utf8'),before);assert.equal(JSON.parse(await fs.readFile(path.join(result.directory,'installation.json'),'utf8')).appDirectory,ROOT);
}));

test('package allowlist excludes operational trees and rejects suspicious content and traversal',()=>{
 assert.equal(typeof packaging.scanPublicContent,'function');assert.deepEqual(packaging.scanPublicContent('README.md','TEST_ONLY public documentation'),[]);
 const privateAddress=['10','1','2','3'].join('.');assert.ok(packaging.scanPublicContent('public/app.js',privateAddress).length);assert.ok(packaging.scanPublicContent('examples/bad.json',JSON.stringify({token:'TEST_ONLY_literal_credential'})).length);assert.throws(()=>packaging.validateReleasePath('../outside'),/path/);assert.throws(()=>packaging.validateReleasePath('.local/secret.json'),/operational/);
});

test('public path checking distinguishes API account routes from actual user filesystem paths',()=>{
 for(const value of ["fetch('/api/admin/users/'+id+'/password')",'POST /api/settings/password'])assert.deepEqual(packaging.scanPublicContent('public/test.mjs',value),[]);
 const home=['/home','TEST_ONLY-account','private.txt'].join('/'),windows=['C:','Users','TEST_ONLY-account','private.txt'].join(String.fromCharCode(92));
 for(const value of [home,windows])assert.ok(packaging.scanPublicContent('test.mjs',value).some(f=>f.reason==='private user path'));
});

test('generated launcher enters the runtime main guard from another working directory',()=>fixture(async directory=>{
 const app=path.join(directory,'TEST_ONLY-app');await fs.mkdir(app);await fs.writeFile(path.join(app,'collector.mjs'),'// TEST_ONLY');await fs.writeFile(path.join(app,'server.mjs'),"import path from 'node:path'; import {fileURLToPath} from 'node:url'; if(path.resolve(process.argv[1])!==fileURLToPath(import.meta.url))throw new Error('main guard bypassed'); console.log(JSON.stringify({classification:'TEST_ONLY',hostId:process.env.CODEX_CONTROL_HOST_ID,configured:!!process.env.CODEX_CONTROL_CONFIG}));");
 const result=await createInstance({mode:'single-computer',hostId:'test-launcher',instanceDirectory:path.join(directory,'instance'),appDirectory:app}),launched=spawnSync(process.execPath,[result.launcher],{cwd:os.tmpdir(),encoding:'utf8',timeout:5000});assert.equal(launched.status,0,launched.stderr);assert.deepEqual(JSON.parse(launched.stdout),{classification:'TEST_ONLY',hostId:'test-launcher',configured:true});
}));

test('candidate rejects content findings and incomplete final runtime before creating output',()=>fixture(async directory=>{
 const source=path.join(directory,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,'server.mjs'),JSON.stringify({token:'TEST_ONLY_literal_credential'}));const manifest={schemaVersion:1,runtime:['server.mjs'],support:[],documents:{}},destination=path.join(directory,'rejected');await assert.rejects(packaging.buildCandidate({sourceRoot:source,destination,manifest,finalRuntime:true}),/content check/);await assert.rejects(fs.access(destination));await fs.writeFile(path.join(source,'server.mjs'),'// TEST_ONLY');await assert.rejects(packaging.buildCandidate({sourceRoot:source,destination,manifest:{...manifest,runtime:['server.mjs','missing.mjs']},finalRuntime:true}),/incomplete/);await assert.rejects(fs.access(destination));
}));

test('candidate refuses a symlinked source subtree',()=>fixture(async directory=>{
 const source=path.join(directory,'source'),other=path.join(directory,'other');await fs.mkdir(source);await fs.mkdir(other);await fs.writeFile(path.join(other,'inside.mjs'),'// TEST_ONLY');await fs.symlink(other,path.join(source,'lib'),process.platform==='win32'?'junction':'dir');await assert.rejects(packaging.buildCandidate({sourceRoot:source,destination:path.join(directory,'candidate'),manifest:{schemaVersion:1,runtime:['lib/inside.mjs'],support:[],documents:{}},finalRuntime:true}),/symlinks/);
}));

test('synthetic candidate packaging includes only explicit files with reproducible checksums and refuses overwrite',()=>fixture(async directory=>{
 const source=path.join(directory,'source'),destination=path.join(directory,'candidate');await fs.mkdir(source);const manifest={schemaVersion:1,runtime:['server.mjs','collector.mjs'],support:[],documents:{'release/README.md':'README.md'}};for(const file of ['server.mjs','collector.mjs','release/README.md','README.md']){await fs.mkdir(path.dirname(path.join(source,file)),{recursive:true});await fs.writeFile(path.join(source,file),'TEST_ONLY sanitized fixture\n');}await fs.mkdir(path.join(source,'.local'));await fs.writeFile(path.join(source,'.local','never-copy'),'TEST_ONLY sensitive fixture');
 const receipt=await packaging.buildCandidate({sourceRoot:source,destination,manifest,finalRuntime:true});assert.equal(receipt.status,'READY_FOR_REVIEW_NOT_PUBLISHED');assert.ok(!(await fs.readdir(destination)).includes('.local'));const generated=JSON.parse(await fs.readFile(path.join(destination,'RELEASE_MANIFEST.json'),'utf8'));assert.equal(generated.files.length,3);for(const record of generated.files)assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(destination,record.path))).digest('hex'),record.sha256);await assert.rejects(packaging.buildCandidate({sourceRoot:source,destination,manifest,finalRuntime:true}),/already exists/);
}));

test('generic Windows installer probes identity before reading enrollment and parses without execution',async()=>{
 const file=path.join(ROOT,'scripts/install-collector.ps1'),source=await fs.readFile(file,'utf8');assert.ok(source.indexOf('--verify-origin=')<source.indexOf('Get-Content -LiteralPath $EnrollmentConfig'));assert.ok(source.includes('ExpectedHostname'));assert.ok(source.includes('-WindowStyle Hidden'));assert.ok(!source.includes('Invoke-WebRequest'));assert.ok(!source.includes('ExecutionPolicy Bypass'));
 if(process.platform==='win32'){const command="$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('"+file.replace(/'/g,"''")+"',[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count){$errors | ForEach-Object { $_.Message }; exit 1}";const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stdout+result.stderr);}
});

test('Windows collector permissions remove explicit and inherited grants before writing configuration',{skip:process.platform!=='win32'},()=>fixture(async directory=>{
 const file=path.join(ROOT,'scripts/install-collector.ps1'),source=await fs.readFile(file,'utf8'),begin=source.indexOf('New-Item -ItemType Directory -Path $destinationRoot -Force'),end=source.indexOf("$application = Join-Path $destinationRoot 'app'",begin);assert.ok(begin>=0&&end>begin);
 const installerPermissions=source.slice(begin,end),quote=value=>"'"+value.replace(/'/g,"''")+"'";
 const command=`$ErrorActionPreference='Stop'; Import-Module "$env:WINDIR\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop; $tokens=$null;$errors=$null;$ast=[System.Management.Automation.Language.Parser]::ParseFile(${quote(file)},[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Parser failed'};$function=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Set-PrivateCollectorDirectory'},$true);if($function){Invoke-Expression $function.Extent.Text};$parent=${quote(path.join(directory,'TEST_ONLY-acl-parent'))};New-Item -ItemType Directory -Path $parent | Out-Null;$acl=Get-Acl -LiteralPath $parent;$everyone=[Security.Principal.SecurityIdentifier]::new('S-1-1-0');$rule=[Security.AccessControl.FileSystemAccessRule]::new($everyone,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule);Set-Acl -LiteralPath $parent -AclObject $acl;foreach($mode in @('inherited','explicit')){$destinationRoot=Join-Path $parent $mode;if($mode -eq 'explicit'){New-Item -ItemType Directory -Path $destinationRoot|Out-Null;$acl=Get-Acl -LiteralPath $destinationRoot;$acl.AddAccessRule($rule);Set-Acl -LiteralPath $destinationRoot -AclObject $acl};${installerPermissions};$child=Join-Path $destinationRoot 'TEST_ONLY-configuration.json';[IO.File]::WriteAllText($child,'{}');$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;foreach($target in @($destinationRoot,$child)){$actual=Get-Acl -LiteralPath $target;foreach($access in $actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($access.IdentityReference.Value -notin @($me,'S-1-5-18')){throw 'Unexpected principal retained'}}};if(-not (Get-Acl -LiteralPath $destinationRoot).AreAccessRulesProtected){throw 'Inheritance still enabled'}};Write-Output 'TEST_ONLY two directory cases and child configuration ACLs passed'`;
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(result.status,0,result.stdout+result.stderr);
}));


test('documentation media accepts only reviewed exact paths and preserves their bytes',()=>fixture(async directory=>{
 const source=path.join(directory,'source'),destination=path.join(directory,'candidate');
 const png=Buffer.from('89504e470d0a1a0a00000000','hex'),mp4=Buffer.from('000000106674797069736f6d00000000','hex');
 const media={'docs/images/overview.png':png,'docs/images/replay.png':png,'docs/images/export-preview.png':png,'docs/media/walkthrough.mp4':mp4};
 for(const [name,bytes] of Object.entries(media)){await fs.mkdir(path.dirname(path.join(source,name)),{recursive:true});await fs.writeFile(path.join(source,name),bytes);}
 const result=await packaging.buildCandidate({sourceRoot:source,destination,manifest:{schemaVersion:1,runtime:[],support:Object.keys(media),documents:{}},finalRuntime:true});
 assert.equal(result.files.length,4);
 for(const [name,bytes] of Object.entries(media)){assert.deepEqual(await fs.readFile(path.join(destination,name)),bytes);assert.equal(result.files.find(f=>f.path===name).sha256,crypto.createHash('sha256').update(bytes).digest('hex'));}
}));

test('documentation media does not admit adjacent captures or private operational files',()=>fixture(async directory=>{
 const source=path.join(directory,'source');await fs.mkdir(source);
 for(const name of ['docs/images/private.png','docs/media/private.mp4','docs/images/overview.PNG','private/overview.png','docs/images/../images/overview.png','.local/docs/images/overview.png','data/history.sqlite','credentials/owner.json','docs/media/walkthrough.mp4.bak']){
  assert.throws(()=>packaging.validateReleasePath(name),/path/i,name);
  const destination=path.join(directory,'rejected');await assert.rejects(packaging.buildCandidate({sourceRoot:source,destination,manifest:{schemaVersion:1,runtime:[],support:[name],documents:{}},finalRuntime:true}),/path/i);await assert.rejects(fs.access(destination));
 }
}));

test('documentation media rejects disguised non-media bytes before output',()=>fixture(async directory=>{
 const source=path.join(directory,'source');
 for(const name of ['docs/images/overview.png','docs/media/walkthrough.mp4']){
  await fs.mkdir(path.dirname(path.join(source,name)),{recursive:true});await fs.writeFile(path.join(source,name),'TEST_ONLY non-media text');
  const destination=path.join(directory,'rejected');await assert.rejects(packaging.buildCandidate({sourceRoot:source,destination,manifest:{schemaVersion:1,runtime:[],support:[name],documents:{}},finalRuntime:true}),/media signature/);await assert.rejects(fs.access(destination));
 }
}));
