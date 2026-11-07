// Author: Bishop Crockett
// Owner: Argellan.com
// SPDX-License-Identifier: MIT
import test from 'node:test';import assert from 'node:assert/strict';
import {serviceHealth} from '../lib/targets.mjs';
test('Windows configured service observation uses native readonly provider, no systemd',async()=>{
 const calls=[];const result=await serviceHealth(['TEST_ONLY_Service'],{platform:'win32',execute:async(executable,args)=>{calls.push({executable,args});return {stdout:JSON.stringify({Id:'TEST_ONLY_Service',ActiveState:'active',SubState:'Running',MainPID:123,MemoryCurrent:null,CPUUsageNSec:null})};}});
 assert.equal(result.length,1);assert.equal(result[0].unit,'TEST_ONLY_Service');assert.equal(result[0].state,'active');assert.equal(result[0].pid,123);assert.equal(result[0].memory,null);assert.equal(calls.length,1);assert.match(calls[0].executable,/powershell/i);assert.ok(!calls[0].args.join(' ').includes('systemctl'));
});
test('Windows service observation rejects shell syntax and retains unknown-state refusals',async()=>{
 let calls=0;const result=await serviceHealth(['TEST_ONLY_Service','bad;Stop-Service Spooler'],{platform:'win32',execute:async()=>{calls++;throw new Error('TEST_ONLY native provider unavailable');}});
 assert.equal(calls,1);assert.deepEqual(result,[{unit:'TEST_ONLY_Service',state:'unavailable'}]);
});
