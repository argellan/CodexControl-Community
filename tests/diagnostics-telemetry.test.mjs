// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function implementation() {
  const url = new URL('../lib/diagnostics-telemetry.mjs', import.meta.url);
  assert.equal(await fs.access(url).then(() => true, () => false), true,
    'synthetic-only consent, queue and receiver implementation is required');
  return import(url);
}
async function fixture(run) {
  const module = await implementation();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-synthetic-telemetry-'));
  let receiver;
  try {
    receiver = await module.openSyntheticReceiver({directory});
    await run({...module, receiver, directory});
  } finally {
    await receiver?.close();
    await fs.rm(directory, {recursive:true, force:true});
  }
}
test('receiver enforces schema, content type, unknown fields, nesting, version, size and idempotency', () => fixture(async ({receiver, syntheticReport}) => {
  const url = receiver.url;
  const report = syntheticReport('browser');
  const post = (body, type='application/json') => fetch(url, {method:'POST', headers:{'content-type':type}, body:typeof body==='string'?body:JSON.stringify(body)});
  assert.equal((await post(report)).status, 202);
  assert.equal((await post(report)).status, 200);
  assert.equal(receiver.count(), 1);
  assert.equal((await post({...report, count:2})).status, 409);
  assert.equal((await post({...report, reportId:crypto.randomUUID(), arbitrary:'CANARY_SECRET person@example.invalid'})).status, 400);
  assert.equal((await post({...report, count:{nested:'CANARY_SECRET'}})).status, 400);
  assert.equal((await post({...report, schemaVersion:2})).status, 426);
  assert.equal((await post(report,'text/plain')).status, 415);
  assert.equal((await post(' '.repeat(2048))).status, 400);
  assert.equal((await post(' '.repeat(2049))).status, 413);
  assert.equal(receiver.count(), 1);
  const saved = await fs.readFile(path.join(receiver.directory,'reports.json'),'utf8');
  assert.equal(saved.includes('CANARY'), false);
  assert.equal(saved.includes('example.invalid'), false);
  assert.equal(receiver.logs().some(row => JSON.stringify(row).includes('CANARY')), false);
}));
test('consent is default off, revisioned, separate for backend, schema renewing and stale-client safe', async () => {
  const {ConsentGate} = await implementation();
  const gate = new ConsentGate({ownershipVerified:true});
  assert.equal(gate.permits('browser'), false);
  assert.equal(gate.permits('backend'), false);
  gate.authorize({revision:0, schemaVersion:1, receiver:true, backend:false});
  gate.choose({revision:1, schemaVersion:1, browser:true});
  assert.equal(gate.permits('browser'), true);
  assert.equal(gate.permits('backend'), false);
  assert.throws(() => gate.choose({revision:1, schemaVersion:1, browser:true}), /stale/i);
  gate.choose({revision:2, schemaVersion:1, browser:false});
  assert.equal(gate.permits('browser'), false);
  assert.throws(() => gate.choose({revision:3, schemaVersion:2, browser:true}), /schema/i);
  const unknown = new ConsentGate();
  unknown.authorize({revision:0, schemaVersion:1, receiver:true, backend:true});
  assert.equal(unknown.permits('backend'), false);
});
test('sender isolates outage, bounds queue, retries lost ACK idempotently and opt-out purges/cancels', () => fixture(async ({receiver, ConsentGate, SyntheticSender, syntheticReport}) => {
  let now=0;
  const gate=new ConsentGate({ownershipVerified:true});
  const sender=new SyntheticSender({receiverPort:receiver.port, gate, now:()=>now, random:()=>0.5});
  assert.equal(sender.enqueue(syntheticReport('browser')), false);
  gate.authorize({revision:0,schemaVersion:1,receiver:true,backend:false});
  gate.choose({revision:1,schemaVersion:1,browser:true});
  const report=syntheticReport('browser');
  receiver.loseNextAck();
  assert.equal(sender.enqueue(report),true);
  await sender.pump();
  assert.equal(receiver.count(),1);
  assert.equal(sender.count(),1);
  now=2000;
  await sender.pump();
  assert.equal(sender.count(),0);
  assert.equal(receiver.count(),1);
  for(let i=0;i<20;i++) assert.equal(sender.enqueue(syntheticReport('browser')),true);
  assert.equal(sender.enqueue(syntheticReport('browser')),false);
  gate.choose({revision:2,schemaVersion:1,browser:false});
  assert.equal(sender.count(),0);
  assert.equal(sender.enqueue(syntheticReport('browser')),false);
  sender.close();
}));
test('receiver outage does not affect local diagnostics; retry cap and recovery are bounded', () => fixture(async ({receiver, ConsentGate, SyntheticSender, syntheticReport}) => {
  const gate=new ConsentGate({ownershipVerified:true});
  gate.authorize({revision:0,schemaVersion:1,receiver:true,backend:false});
  gate.choose({revision:1,schemaVersion:1,browser:true});
  let now=0;
  const sender=new SyntheticSender({receiverPort:receiver.port,gate,now:()=>now,random:()=>0.5});
  receiver.unavailable(true);
  sender.enqueue(syntheticReport('browser'));
  await sender.pump();assert.equal(sender.count(),1);
  now=2000;receiver.unavailable(false);
  await sender.pump();assert.equal(sender.count(),0);assert.equal(receiver.count(),1);
  receiver.unavailable(true);sender.enqueue(syntheticReport('browser'));
  for(let i=0;i<5;i++){now+=65000;await sender.pump();}
  assert.equal(sender.count(),0);assert.equal(sender.status().attempts,7);
  sender.close();
}));
test('idempotent retry is independent of JSON object property order',()=>fixture(async({receiver,syntheticReport})=>{
  const report=syntheticReport();
  const post=body=>fetch(receiver.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post(report)).status,202);
  const reordered=Object.fromEntries(Object.entries(report).reverse());
  assert.equal((await post(reordered)).status,200,'same validated report with reordered JSON keys is the same delivery');
  assert.equal(receiver.count(),1);
}));
test('rate limit rejects plus-one and expired receipt storage is physically purged on reopen',()=>fixture(async({receiver,syntheticReport,directory,openSyntheticReceiver})=>{
  const post=()=>fetch(receiver.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(syntheticReport())});
  for(let i=0;i<30;i++)assert.equal((await post()).status,202);
  assert.equal((await post()).status,429);assert.equal(receiver.count(),30);
  const file=path.join(directory,'reports.json');const rows=JSON.parse(await fs.readFile(file,'utf8'));
  const expiredDirectory=path.join(directory,'expired');await fs.mkdir(expiredDirectory);await fs.copyFile(file,path.join(expiredDirectory,'reports.json'));
  const expired=await openSyntheticReceiver({directory:expiredDirectory,now:()=>rows[rows.length-1].receivedAt+86400001});
  assert.equal(expired.count(),0);assert.deepEqual(JSON.parse(await fs.readFile(path.join(expiredDirectory,'reports.json'),'utf8')),[]);await expired.close();
}));
test('in-flight opt-out aborts wait and discards queue but does not claim recall of delivered bytes',async()=>{
  const {ConsentGate,SyntheticSender,syntheticReport}=await implementation();
  const http=await import('node:http');let observed;const delivered=new Promise(resolve=>{observed=resolve;});let wire='';
  const server=http.createServer(async req=>{for await(const chunk of req)wire+=chunk;observed();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const gate=new ConsentGate({ownershipVerified:true});gate.authorize({revision:0,schemaVersion:1,receiver:true,backend:false});gate.choose({revision:1,schemaVersion:1,browser:true});
  const sender=new SyntheticSender({receiverPort:server.address().port,gate});
  try{
    const report=syntheticReport();sender.enqueue(report);const pumping=sender.pump();await delivered;
    gate.choose({revision:2,schemaVersion:1,browser:false});await pumping;
    assert.equal(sender.count(),0);assert.equal(sender.status().active,false);assert.equal(JSON.parse(wire).reportId,report.reportId);assert.equal(wire.includes('CANARY'),false);
    assert.throws(()=>sender.enqueue({...syntheticReport(),error:'CANARY_SECRET person@example.invalid'}),/Invalid/);
  }finally{sender.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('receiver storage limit rejects report 101 without evicting accepted reports',()=>fixture(async({directory,openSyntheticReceiver,syntheticReport})=>{
  let now=0;const receiver=await openSyntheticReceiver({directory:path.join(directory,'capacity'),now:()=>now});
  try{
    for(let i=0;i<100;i++){now+=60001;const response=await fetch(receiver.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(syntheticReport())});assert.equal(response.status,202);}
    now+=60001;const response=await fetch(receiver.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(syntheticReport())});assert.equal(response.status,507);assert.equal(receiver.count(),100);
    assert.equal(JSON.parse(await fs.readFile(path.join(receiver.directory,'reports.json'),'utf8')).length,100);
  }finally{await receiver.close();}
}));
test('backoff never retries before one second even at the minimum jitter value',()=>fixture(async({receiver,ConsentGate,SyntheticSender,syntheticReport})=>{
  let now=0;const gate=new ConsentGate({ownershipVerified:true});gate.authorize({revision:0,schemaVersion:1,receiver:true,backend:false});gate.choose({revision:1,schemaVersion:1,browser:true});
  const sender=new SyntheticSender({receiverPort:receiver.port,gate,now:()=>now,random:()=>0});
  try{receiver.unavailable(true);sender.enqueue(syntheticReport());await sender.pump();now=999;await sender.pump();assert.equal(sender.status().attempts,1,'jitter cannot undercut the one-second minimum');now=1000;await sender.pump();assert.equal(sender.status().attempts,2);}finally{sender.close();}
}));
test('receiver rate budget covers malformed requests too',()=>fixture(async({receiver})=>{
  for(let i=0;i<30;i++)assert.equal((await fetch(receiver.url,{method:'POST',headers:{'content-type':'text/plain'},body:'synthetic'})).status,415);
  assert.equal((await fetch(receiver.url,{method:'POST',headers:{'content-type':'text/plain'},body:'synthetic'})).status,429);
}));
test('sender queue age expires unsent telemetry and unknown ownership keeps both classes off',()=>fixture(async({receiver,ConsentGate,SyntheticSender,syntheticReport})=>{
  let now=0;const gate=new ConsentGate({ownershipVerified:true});gate.authorize({revision:0,schemaVersion:1,receiver:true,backend:false});gate.choose({revision:1,schemaVersion:1,browser:true});const sender=new SyntheticSender({receiverPort:receiver.port,gate,now:()=>now});
  try{sender.enqueue(syntheticReport());now=86400000;assert.equal(sender.count(),0);await sender.pump();assert.equal(receiver.count(),0);assert.equal(sender.status().attempts,0);}finally{sender.close();}
  const unknown=new ConsentGate();unknown.authorize({revision:0,schemaVersion:1,receiver:true,backend:true});unknown.choose({revision:1,schemaVersion:1,browser:true});assert.equal(unknown.permits('browser'),false);assert.equal(unknown.permits('backend'),false);
  const secondOperator=new ConsentGate({ownershipVerified:true});assert.equal(secondOperator.permits('browser'),false);
}));