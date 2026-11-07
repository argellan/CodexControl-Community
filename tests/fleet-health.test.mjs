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
import crypto from 'node:crypto';
import {FleetHub} from '../lib/fleet.mjs';
const key='fixture-health-credential',host={id:'example-source',label:'Example source',tokenHash:crypto.createHash('sha256').update(key).digest('hex')};
const local={host:{},sessions:[],events:[],coverage:{}};

test('local snapshot exposes committed numeric capture coverage without borrowing it for another host',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-local-coverage-'));let hub;
 try{hub=await FleetHub.open({directory,hosts:[]});const source={observedAt:new Date().toISOString(),host:{id:'TEST_ONLY-local',name:'TEST_ONLY local'},sessions:[],events:[],coverage:{limit:128}};
 await hub.captureLocal(source,{usageCapture:{usageSamples:[],coverage:{scannedFiles:7,discoveredFiles:9,unscannedFiles:2,sampleCount:4,backlogged:true,inventoryLimited:false}}});
 const coverage=hub.snapshot(source).hosts[0].coverage.numericUsage;assert.equal(coverage.version,1);assert.equal(coverage.source,'codex-rollout-numeric');assert.equal(coverage.scannedFiles,7);assert.equal(coverage.unscannedFiles,2);assert.equal(coverage.backlogged,true);
 const later={...source,observedAt:new Date(Date.parse(source.observedAt)+1).toISOString()};await hub.captureLocal(later);assert.equal(hub.snapshot(later).hosts[0].coverage.numericUsage.scannedFiles,7);
 assert.equal(hub.snapshot({...source,host:{id:'TEST_ONLY-other'}}).hosts[0].coverage?.numericUsage,undefined);
 }finally{assert.equal(hub?.writer,null);await fs.rm(directory,{recursive:true,force:true});}
});
const fixture=async callback=>{const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-fleet-health-'));try{const hub=await FleetHub.open({directory,hosts:[{...host}]});return await callback(hub,directory);}finally{await fs.rm(directory,{recursive:true,force:true});}};
const payload=coverage=>({hostId:host.id,batchId:'fixture',observedAt:new Date().toISOString(),sessions:[],events:[],coverage});

test('fleet snapshot health uses configured stale/offline thresholds and changes immediately',()=>fixture(async hub=>{
 await hub.ingest(key,payload({}));const received=hub.states.get(host.id).receivedAt;
 hub.healthThresholds={sourceStaleSeconds:60,sourceOfflineSeconds:120};assert.equal(hub.snapshot(local,received+31000).hosts[0].status,'online');assert.equal(hub.snapshot(local,received+61000).hosts[0].status,'stale');assert.equal(hub.snapshot(local,received+121000).hosts[0].status,'disconnected');
 hub.healthThresholds={sourceStaleSeconds:5,sourceOfflineSeconds:10};assert.equal(hub.snapshot(local,received+6000).hosts[0].status,'stale');assert.equal(hub.snapshot(local,received+11000).hosts[0].status,'disconnected');
 hub.healthThresholds={sourceStaleSeconds:NaN,sourceOfflineSeconds:Infinity};assert.equal(hub.snapshot(local,received+16000).hosts[0].status,'stale');assert.equal(hub.snapshot(local,received+31000).hosts[0].status,'disconnected');
}));

test('disabled and expired enrollments never appear online even with a recent accepted batch',()=>fixture(async hub=>{
 await hub.ingest(key,payload({}));const received=hub.states.get(host.id).receivedAt;
 hub.hosts[0].disabled=true;assert.equal(hub.snapshot(local,received+1).hosts[0].status,'disabled');await assert.rejects(hub.ingest(key,payload({})),e=>e.status===401);
 hub.hosts[0].disabled=false;hub.hosts[0].expiresAt=new Date(received-1).toISOString();assert.equal(hub.snapshot(local,received+1).hosts[0].status,'expired');await assert.rejects(hub.ingest(key,payload({})),e=>e.status===401);
}));

test('collector identity and managed configuration coverage survive persistence as strictly typed metadata',()=>fixture(async(hub,directory)=>{
 await hub.ingest(key,payload({identityVerified:true,configurationManaged:true,configurationRevision:7,private:'PRIVATE_SENTINEL'}));let coverage=hub.snapshot(local).hosts[0].coverage;
 assert.equal(coverage.identityVerified,true);assert.equal(coverage.configurationManaged,true);assert.equal(coverage.configurationRevision,7);assert.equal(JSON.stringify(coverage).includes('PRIVATE_SENTINEL'),false);
 const reopened=await FleetHub.open({directory,hosts:[{...host}]});assert.equal(reopened.snapshot(local).hosts[0].coverage.configurationRevision,7);
 for(const invalid of [{identityVerified:'true',configurationManaged:1,configurationRevision:'7'},{identityVerified:null,configurationManaged:{enabled:true},configurationRevision:-1},{identityVerified:[],configurationManaged:[],configurationRevision:1.5}]){await reopened.ingest(key,payload(invalid));coverage=reopened.snapshot(local).hosts[0].coverage;for(const field of ['identityVerified','configurationManaged','configurationRevision'])assert.equal(Object.hasOwn(coverage,field),false);}
 await reopened.ingest(key,payload({identityVerified:false,configurationManaged:false,configurationRevision:null}));coverage=reopened.snapshot(local).hosts[0].coverage;assert.equal(coverage.identityVerified,false);assert.equal(coverage.configurationManaged,false);assert.equal(coverage.configurationRevision,null);
}));
