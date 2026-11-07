import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawnSync} from 'node:child_process';
const runner=path.resolve('control/tests/fixtures/qualify-codex-native.mjs');
for(const mode of ['quota','lease','stop','expired'])test('native qualification CLI refuses '+mode+' before fixture or native creation',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'TEST_ONLY-qualified-runner-'));
 try{const at=Date.now(),leasePath=path.join(dir,'job.lock');fs.writeFileSync(path.join(dir,'admission.json'),JSON.stringify({startedAtMs:at-(mode==='expired'?600001:0),deadlineAtMs:at+(mode==='expired'?-1:600000),baselineRemaining:38,resetAt:Math.floor(at/1000)+10000,leasePath,policyOnly:true,maxNativeTurns:0}));fs.writeFileSync(path.join(dir,'usage.json'),JSON.stringify({stage:'PREPARE',remaining:mode==='quota'?37:38,resetAt:Math.floor(at/1000)+10000,observedAtMs:at}));
 if(mode==='lease')fs.writeFileSync(leasePath,'FOREIGN');if(mode==='stop')fs.writeFileSync(path.join(dir,'stop.json'),'{}');
 const r=spawnSync(process.execPath,['--max-old-space-size=64',runner,'--run-owned-native-fixture','--window',dir],{encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(r.status,1);assert.match(r.stdout,/QUALIFICATION_DISPATCH_REFUSED/);assert.doesNotMatch(r.stdout,/PREPARED|WAIT_QUOTA/);assert.equal(fs.existsSync(path.join(dir,'native')),false);if(mode==='lease')assert.equal(fs.readFileSync(leasePath,'utf8'),'FOREIGN');else assert.equal(fs.existsSync(leasePath),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});