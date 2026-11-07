import test from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import fs from 'node:fs';
import {fixture} from './fixtures/authority-fixture.mjs';
const {WindowsJobHost}=await import('../providers/codex/windows-job.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
for(const naturalExit of [false,true])test('Windows job proves zero active descendants after '+(naturalExit?'natural root exit':'owned stop'),{skip:process.platform!=='win32',timeout:30000},async t=>{
 assert.equal(typeof WindowsJobHost,'function','Windows job containment must be implemented');
 const f=await fixture(t),host=WindowsJobHost.create({directory:f.directory,owner:f.ownerBoundary});
 t.after(()=>host.close());
 const program="const {spawn}=require('node:child_process');const child=spawn(process.execPath,['--max-old-space-size=32','-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(JSON.stringify({root:process.pid,descendant:child.pid}));"+(naturalExit?"setTimeout(()=>process.exit(0),300);":"setInterval(()=>{},1000);");
 const plan=host.plan({executable:process.execPath,args:['--max-old-space-size=32','-e',program],options:{cwd:f.root.directory,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))}});
 const child=spawn(plan.executable,plan.args,plan.options);let closed=false;const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{closed=true;resolve(code);});});
 t.after(async()=>{if(!closed){plan.control.requestStop();await exit;}});
 let text='';const sawChild=new Promise(resolve=>child.stdout.on('data',bytes=>{text+=bytes.toString();if(text.includes('\n'))resolve();}));child.stderr.on('data',()=>{});
 let timer;try{await Promise.race([sawChild,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('FIXTURE_START_TIMEOUT')),10000);})]);clearTimeout(timer);
 if(!naturalExit)plan.control.requestStop();
 assert.equal(await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('FIXTURE_EXIT_TIMEOUT')),10000);})]),0);
 const proof=plan.control.proof(child.pid);assert.equal(proof.processTreeExitConfirmed,true);assert.equal(proof.activeProcesses,0);assert.ok(proof.totalProcesses>=2);assert.equal(proof.assignedBeforeResume,true);assert.equal(proof.breakawayAllowed,false);
 const valid=JSON.parse(fs.readFileSync(plan.control.statusFile,'utf8'));for(const delta of [{totalProcesses:null},{nativePid:null},{jobMemoryLimitBytes:0},{maxProcesses:0},{nativeCreationFileTime:'INVALID'}]){fs.writeFileSync(plan.control.statusFile,JSON.stringify({...valid,...delta}));assert.equal(plan.control.proof(child.pid).processTreeExitConfirmed,false);}
 fs.writeFileSync(plan.control.statusFile,'{}');assert.equal(plan.control.proof(child.pid).processTreeExitConfirmed,false);
 }finally{clearTimeout(timer);}
});
test('owned host preserves literal arguments and protocol stdin/stdout',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const f=await fixture(t),host=WindowsJobHost.create({directory:f.directory,owner:f.ownerBoundary});t.after(()=>host.close());
 const values=['space word','double"quote','tail\\'],program="let input='';process.stdin.on('data',b=>{input+=b;});process.stdin.on('end',()=>{console.log(JSON.stringify({args:process.argv.slice(1),input}));});";
 const plan=host.plan({executable:process.execPath,args:['--max-old-space-size=32','-e',program,...values],options:{cwd:f.root.directory,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']}});
 const child=spawn(plan.executable,plan.args,plan.options);let text='';child.stdout.on('data',b=>{text+=b;});child.stderr.on('data',()=>{});const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});child.stdin.end('TEST_ONLY_JSONL\n');
 assert.equal(await exited,0);const value=JSON.parse(text);assert.deepEqual(value.args,values);assert.equal(value.input,'TEST_ONLY_JSONL\n');assert.equal(plan.control.proof(child.pid).processTreeExitConfirmed,true);
});