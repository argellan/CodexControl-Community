// Author: Bishop Crockett
// Owner: Argellan.com
// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {buildCandidate} from './package-release.mjs';
const execute=promisify(execFile),ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
export function validateWindowsMember(value){if(typeof value!=='string'||!value||value.length>230||/[\\:<>|"*?\x00-\x1f]/.test(value)||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p)))throw new Error('Unsafe Windows payload member');return value;}
async function inventory(root,prefix=''){const result=[];for(const entry of await fs.readdir(path.join(root,prefix),{withFileTypes:true})){const name=prefix?prefix+'/'+entry.name:entry.name;validateWindowsMember(name);if(entry.isSymbolicLink())throw new Error('Payload links refused');if(entry.isDirectory())result.push(...await inventory(root,name));else if(entry.isFile()){const b=await fs.readFile(path.join(root,name));result.push({path:name,bytes:b.length,sha256:hash(b)});}else throw new Error('Nonregular payload refused');}return result;}
export async function buildWindowsInstaller({destination,downloads,pythonBuild}={}){
 if(process.platform!=='win32')throw new Error('Native win32 build required');for(const value of [destination,downloads,pythonBuild])if(!path.isAbsolute(value||'')||/^(?:\\\\|\/\/)/.test(value))throw new Error('Absolute local build inputs required');
 await fs.mkdir(destination,{recursive:false});const staging=path.join(destination,'payload');await fs.mkdir(staging);
 const sourceManifest=JSON.parse(await fs.readFile(path.join(ROOT,'release/runtime-files.json'),'utf8'));
 // Runtime features remain explicit. Test sources stay in the private source tree,
 // not in the installed application; no runtime feature is removed by this filter.
 const manifest={...sourceManifest,runtime:sourceManifest.runtime.filter(p=>!/(?:^|\/)tests\//.test(p)),support:sourceManifest.support.filter(p=>!/(?:^|\/)tests\//.test(p))};
 for(const p of ['scripts/windows-community.mjs','scripts/archive-receiver.py','scripts/archive-analytics.py','scripts/archive-usage.mjs','scripts/archive-github.mjs'])if(!manifest.runtime.includes(p)&&!manifest.support.includes(p))manifest.support.push(p);
 const candidate=await buildCandidate({sourceRoot:ROOT,destination:path.join(staging,'app'),manifest,finalRuntime:false});
 if(candidate.missing.length)throw new Error('Installer payload incomplete: '+candidate.missing.join(', '));
 const dependencies=[['node-v24.19.0-win-x64.zip','57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'],['python-3.13.5-embed-amd64.zip','7d2650fd9d1b9d002d4a315d5f354247fd6a44f30517c7ef577b08f57a0fb6d9'],['duckdb-1.5.6-cp313-cp313-win_amd64.whl','ced693d33ddcee2e5345f077d342c87d2aaa80e41c514e64c9ff2d4e5963c251']];
 for(const [name,sha]of dependencies)if(hash(await fs.readFile(path.join(downloads,name)))!==sha)throw new Error('Dependency identity mismatch: '+name);
 const preparation=String.raw`import zipfile,sys,pathlib,shutil,json
root=pathlib.Path(sys.argv[1]);downloads=pathlib.Path(sys.argv[2])
node=root/'runtimes'/'node';node.mkdir(parents=True)
with zipfile.ZipFile(downloads/'node-v24.19.0-win-x64.zip') as z:
 for source,target in [('node-v24.19.0-win-x64/node.exe','node.exe'),('node-v24.19.0-win-x64/LICENSE','LICENSE')]:
  (node/target).write_bytes(z.read(source))
python=root/'runtimes'/'python';python.mkdir(parents=True)
for name,target in [('python-3.13.5-embed-amd64.zip',python),('duckdb-1.5.6-cp313-cp313-win_amd64.whl',python/'Lib'/'site-packages')]:
 with zipfile.ZipFile(downloads/name) as z:
  for item in z.infolist():
   parts=pathlib.PurePosixPath(item.filename).parts
   if item.filename.startswith('/') or any(p in ('..','.') for p in parts) or '\\' in item.filename or ':' in item.filename:raise RuntimeError('Unsafe dependency member')
   if item.is_dir():continue
   p=target.joinpath(*parts);p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(z.read(item))
(python/'python313._pth').write_text('python313.zip\n.\nLib/site-packages\n',encoding='utf-8')
`;
 await execute(pythonBuild,['-I','-B','-c',preparation,staging,downloads],{timeout:60000,maxBuffer:65536,windowsHide:true});
 const runtimePython=path.join(staging,'runtimes','python','python.exe');
 const runtime=await execute(runtimePython,['-I','-B','-c','import sys,sqlite3,duckdb;print(sys.version);print(sqlite3.sqlite_version);print(duckdb.__version__)'],{timeout:15000,maxBuffer:65536,windowsHide:true});
 const files=(await inventory(staging)).sort((a,b)=>a.path.localeCompare(b.path));const receipt={version:'0.1.0',edition:'Community',platform:'win32-x64',status:'LOCAL_TEST_ONLY_NOT_RELEASE_QUALIFIED',bundledRuntimes:{node:'24.19.0',python:'3.13.5',duckdb:'1.5.6'},files};
 const bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n');await fs.writeFile(path.join(staging,'INSTALLER_MANIFEST.json'),bytes,{flag:'wx'});
 const zipper=String.raw`import zipfile,sys,pathlib
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2],'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for p in sorted(root.rglob('*')):
  if p.is_file():z.write(p,p.relative_to(root).as_posix())
`;
 const zip=path.join(destination,'payload.zip');await execute(pythonBuild,['-I','-B','-c',zipper,staging,zip],{timeout:60000,maxBuffer:65536,windowsHide:true});
 const exe=path.join(destination,'CodexControl-Community-0.1.0-Setup.exe');
 const result=await execute('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',['/nologo','/target:exe','/platform:x64','/optimize+','/r:System.IO.Compression.dll','/r:System.IO.Compression.FileSystem.dll','/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll','/r:System.Security.dll','/resource:'+zip+',payload.zip','/out:'+exe,path.join(ROOT,'release/windows/Installer.cs'),path.join(ROOT,'release/windows/Installer.Update.cs'),path.join(ROOT,'release/windows/CrashEvidence.cs')],{timeout:60000,maxBuffer:65536,windowsHide:true});
 const built={...receipt,files:files.length,appFiles:candidate.files.length,payloadManifestSha256:hash(bytes),installer:exe,installerSha256:hash(await fs.readFile(exe)),installerBytes:(await fs.stat(exe)).size,runtimeProbe:runtime.stdout.trim(),compilerOutput:result.stdout.trim(),performanceGate:'NOT_RUN_BLOCKS_RELEASE',featureParity:'PENDING_SOURCE_RECONCILIATION'};
 await fs.writeFile(path.join(destination,'BUILD_RECEIPT.json'),JSON.stringify(built,null,2)+'\n',{flag:'wx'});return built;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{const options={};for(const a of process.argv.slice(2)){const m=/^--(destination|downloads|python-build)=(.+)$/.exec(a);if(!m)throw new Error('Use explicit build paths');options[m[1]==='python-build'?'pythonBuild':m[1]]=m[2];}console.log(JSON.stringify(await buildWindowsInstaller(options),null,2));}catch(error){console.error(JSON.stringify({status:'BUILD_FAILED',error:error.message,details:error.stdout||'',findings:error.findings||[]}));process.exitCode=1;}
