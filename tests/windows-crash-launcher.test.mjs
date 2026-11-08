// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';

test('the real Windows launcher captures a controlled child failure without persisting output secrets', {skip: process.platform !== 'win32', timeout: 20000}, async () => {
  const helper = path.resolve('release/windows/CrashEvidence.cs');
  assert.equal(await fs.access(helper).then(() => true, () => false), true, 'Windows launcher crash capture must exist');
  const tempRoot = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(tempRoot, 'cc-launch-crash-'));
  assert.ok(path.resolve(directory).startsWith(tempRoot + path.sep));
  try {
    const app = path.join(directory, 'app-root'), instance = path.join(directory, 'instance');
    const exe = path.join(app, 'CodexControl-Community.exe');
    await fs.mkdir(path.join(app, 'runtimes', 'node'), {recursive: true});
    await fs.mkdir(path.join(app, 'app', 'scripts'), {recursive: true});
    await fs.mkdir(path.join(app, 'app', 'lib'), {recursive: true});
    await fs.mkdir(path.join(app, 'app', 'public'), {recursive: true});
    await fs.mkdir(path.join(instance, 'data'), {recursive: true});
    await fs.copyFile(process.execPath, path.join(app, 'runtimes', 'node', 'node.exe'));
    await fs.copyFile('lib/crash-evidence.mjs', path.join(app, 'app', 'lib', 'crash-evidence.mjs'));
    await fs.copyFile('public/build-info.mjs', path.join(app, 'app', 'public', 'build-info.mjs'));
    await fs.writeFile(path.join(app, 'app', 'scripts', 'windows-community.mjs'), `
      import {installCrashEvidence} from '../lib/crash-evidence.mjs';
      import path from 'node:path';
      const instance=process.argv.find(arg=>arg.startsWith('--instance=')).slice(11);
      installCrashEvidence({directory:path.join(instance,'data','crash-reports'),correlationId:process.env.CODEX_CONTROL_CRASH_RUN_ID,buildId:process.env.CODEX_CONTROL_CRASH_BUILD_ID});
      console.log('PRIVATE_LAUNCH_CANARY stdout token');
      process.stdout.write('PRIVATE_LAUNCH_CANARY '+ 'x'.repeat(200000)+'\\n');
      console.error('PRIVATE_LAUNCH_CANARY stderr C:\\\\secret.txt');
      setImmediate(()=>{throw new TypeError('PRIVATE_LAUNCH_CANARY exception');});
    `);
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    await fs.writeFile(path.join(instance, 'hub.json'), JSON.stringify({instanceId:'test-instance', publicOrigin:'http://127.0.0.1:'+port, dataDirectory:path.join(instance,'data')}));
    await fs.writeFile(path.join(app, 'CE_INSTALLATION.json'), JSON.stringify({instance}));
    await fs.writeFile(path.join(app, 'INSTALLER_MANIFEST.json'), '{}');
    const compiler = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';
    const compiled = spawnSync(compiler, ['/nologo','/target:exe','/platform:x64',
      '/r:System.IO.Compression.dll','/r:System.IO.Compression.FileSystem.dll','/r:System.Windows.Forms.dll',
      '/r:System.Drawing.dll','/r:System.Web.Extensions.dll','/r:System.Security.dll','/out:'+exe,
      path.resolve('release/windows/Installer.cs'),path.resolve('release/windows/Installer.Update.cs'),helper],
      {encoding:'utf8',timeout:15000,windowsHide:true});
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const launched = spawnSync(exe, ['--launch','--no-browser'], {cwd:app, encoding:'utf8', timeout:10000, windowsHide:true});
    assert.equal(launched.status, 1, 'a fatal child must remain a failed launch');
    const folder = path.join(instance, 'data', 'crash-reports');
    const launcher = await fs.readFile(path.join(folder, 'launcher.jsonl'), 'utf8');
    const runtime = await fs.readFile(path.join(folder, 'runtime.jsonl'), 'utf8');
    assert.equal(launcher.includes('PRIVATE_LAUNCH_CANARY'), false);
    assert.equal(runtime.includes('PRIVATE_LAUNCH_CANARY'), false);
    assert.equal(launcher.includes('secret.txt'), false);
    const parentEvents = launcher.trim().split('\n').map(JSON.parse);
    const childEvents = runtime.trim().split('\n').map(JSON.parse);
    assert.equal(parentEvents.find(event=>event.kind==='process-exit')?.exitCode, 1);
    assert.ok(parentEvents.some(event=>event.kind==='output' && event.stream==='stderr'));
    assert.ok(parentEvents.some(event=>event.kind==='output' && event.stream==='stdout'));
    assert.ok(parentEvents.some(event=>event.kind==='output' && event.category==='line-truncated'), 'oversize lines must be bounded before logging');
    assert.equal(parentEvents[0].correlationId, childEvents[0].correlationId);
    assert.equal(parentEvents[0].buildId, childEvents[0].buildId);
    assert.equal(childEvents.find(event=>event.kind==='fatal')?.category,'uncaught-exception');
    const restarted = spawnSync(exe, ['--launch','--no-browser'], {cwd:app, encoding:'utf8', timeout:10000, windowsHide:true});
    assert.equal(restarted.status, 1);
    const afterRestart = (await fs.readFile(path.join(folder, 'launcher.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const launches = afterRestart.filter(event=>event.kind==='launch');
    assert.equal(launches.length, 2, 'the first run must remain visible after restarting');
    assert.notEqual(launches[0].correlationId, launches[1].correlationId);
    assert.equal(launches[0].correlationId, parentEvents[0].correlationId);
    await fs.writeFile(path.join(app, 'app', 'scripts', 'windows-community.mjs'), `
      import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
      const instance=process.argv.find(arg=>arg.startsWith('--instance=')).slice(11);
      const hub=JSON.parse(fs.readFileSync(path.join(instance,'hub.json'),'utf8'));
      const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({deploymentId:hub.instanceId}));});
      server.listen(new URL(hub.publicOrigin).port,'127.0.0.1',()=>{
        console.log(JSON.stringify({status:'COMMUNITY_READY',instanceId:hub.instanceId}));
        const timer=setInterval(()=>{if(fs.existsSync(path.join(instance,'data','launcher-ready.json'))){clearInterval(timer);server.close(()=>process.exit(0));}},25);
        setTimeout(()=>process.exit(2),4000).unref();
      });
    `);
    const ready = spawnSync(exe, ['--launch','--no-browser'], {cwd:app, encoding:'utf8', timeout:10000, windowsHide:true});
    assert.equal(ready.status, 0, 'the launcher must still recognize and acknowledge runtime readiness: '+ready.stderr);
    const receipt=JSON.parse(await fs.readFile(path.join(instance,'data','launcher-ready.json'),'utf8'));
    assert.equal(receipt.instanceId,'test-instance');
    await fs.writeFile(path.join(app, 'app', 'scripts', 'windows-community.mjs'), `
      for(let i=0;i<256;i++)process.stderr.write('TEST_ONLY '+ 'x'.repeat(4096)+'\\n');
      process.stderr.end(()=>{setImmediate(()=>{throw new Error('TEST_ONLY fault');});});
      setTimeout(()=>process.exit(42),2000).unref();
    `);
    const blocked=spawn(exe,['--launch','--no-browser'],{cwd:app,stdio:['ignore','ignore','pipe'],windowsHide:true});
    blocked.stderr.pause();
    let timer;
    const exited=new Promise((resolve,reject)=>{blocked.once('error',reject);blocked.once('exit',code=>resolve({code}));});
    const closed=new Promise(resolve=>blocked.once('close',resolve));
    const outcome=await Promise.race([
      exited,
      new Promise(resolve=>{timer=setTimeout(()=>resolve({timeout:true}),5000);})
    ]);
    clearTimeout(timer);
    if(outcome.timeout){blocked.kill();await exited;} // This handle is the isolated fixture launcher.
    blocked.stderr.resume();
    await closed;
    assert.equal(outcome.timeout,undefined,'a stalled stderr consumer must not hold the failed launcher open');
    assert.equal(outcome.code,1);
  } finally {
    const realRoot = await fs.realpath(tempRoot), realDirectory = await fs.realpath(directory);
    assert.ok(realDirectory.startsWith(realRoot + path.sep));
    await fs.rm(realDirectory, {recursive:true, force:true});
  }
});

test('native launcher evidence rotates within its fixed local file budget', {skip: process.platform !== 'win32', timeout: 20000}, async () => {
  const tempRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(tempRoot, 'cc-launch-rotation-'));
  try {
    const source = path.join(directory, 'Rotation.cs'), exe = path.join(directory, 'Rotation.exe');
    await fs.writeFile(source, "class Rotation { static int Main(string[] args) { var log=new CrashEvidence(args[0],new string('a',64)); for(int i=0;i<1800;i++)log.Start(); return 0; } }");
    const compiled = spawnSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
      ['/nologo','/target:exe','/r:System.Web.Extensions.dll','/out:'+exe,source,path.resolve('release/windows/CrashEvidence.cs')],
      {encoding:'utf8',timeout:15000,windowsHide:true});
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const run = spawnSync(exe, [directory], {encoding:'utf8',timeout:15000,windowsHide:true});
    assert.equal(run.status, 0, run.stderr);
    const files = (await fs.readdir(directory)).filter(file=>file.startsWith('launcher.jsonl'));
    assert.equal(files.length, 4);
    for(const file of files) assert.ok((await fs.stat(path.join(directory,file))).size <= 65536);
  } finally {
    const target=await fs.realpath(directory);
    assert.ok(target.startsWith(tempRoot + path.sep));
    await fs.rm(target,{recursive:true,force:true});
  }
});

test('a blocked parent console cannot block the child-output reader', {skip: process.platform !== 'win32', timeout: 10000}, async () => {
  const helper = await fs.readFile('release/windows/CrashEvidence.cs','utf8');
  assert.match(helper,/class BoundedConsoleForwarder/, 'console forwarding needs a bounded independent queue');
  const tempRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(tempRoot,'cc-blocked-console-'));
  try {
    const source=path.join(directory,'Blocked.cs'), exe=path.join(directory,'Blocked.exe');
    await fs.writeFile(source, `
      using System;using System.IO;using System.Text;using System.Threading;
      class BlockedWriter:TextWriter {public override Encoding Encoding {get{return Encoding.UTF8;}} public override void WriteLine(string value){Thread.Sleep(3000);}}
      class Test {static int Main(){var f=new BoundedConsoleForwarder(new BlockedWriter(),2);for(int i=0;i<1000;i++)f.Enqueue("fixture");return f.Dropped>0?0:1;}}
    `);
    const compiled=spawnSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
      ['/nologo','/target:exe','/r:System.Web.Extensions.dll','/out:'+exe,source,path.resolve('release/windows/CrashEvidence.cs')],
      {encoding:'utf8',timeout:5000,windowsHide:true});
    assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
    const run=spawnSync(exe,[],{encoding:'utf8',timeout:2000,windowsHide:true});
    assert.equal(run.status,0,'an unwritable output consumer must not block producers');
  } finally {
    const target=await fs.realpath(directory);
    assert.ok(target.startsWith(tempRoot+path.sep));
    await fs.rm(target,{recursive:true,force:true});
  }
});
