// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as collector from '../collector.mjs';

test('process capability probing never sends a collector token to an unpinned hub', async t => {
  assert.equal(typeof collector.pollProcessCapabilities,'function','capability probing must verify the endpoint first');
  let credentialRequests=0;
  const server=http.createServer((req,res)=>{
    if(req.headers.authorization)credentialRequests++;
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(req.url==='/api/identity'
      ? {deploymentId:'foreign-instance',readOnly:true,protocolVersion:1}
      : {processTelemetryV1:true}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const config={url:'http://127.0.0.1:'+server.address().port,hostId:'fixture',token:'TEST_ONLY_TOKEN',expectedInstanceId:'correct-instance'};
  await assert.rejects(collector.pollProcessCapabilities(config),/identity or protocol mismatch/);
  assert.equal(credentialRequests,0);
});

test('process capability is requested only after the pinned identity is confirmed', async t => {
  const requests=[];
  const server=http.createServer((req,res)=>{requests.push({url:req.url,authenticated:Boolean(req.headers.authorization)});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/api/identity'?{deploymentId:'correct-instance',readOnly:true,protocolVersion:1}:{processTelemetryV1:true}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const config={url:'http://127.0.0.1:'+server.address().port,hostId:'fixture',token:'TEST_ONLY_TOKEN',expectedInstanceId:'correct-instance'};
  assert.equal((await collector.pollProcessCapabilities(config)).processTelemetryV1,true);
  assert.deepEqual(requests,[{url:'/api/identity',authenticated:false},{url:'/api/collector/process-capabilities',authenticated:true}]);
});
