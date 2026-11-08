// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeUsage,responseMeasure} from '../public/usage-workspace-model.mjs';

const start=Date.parse('2026-11-01T00:00:00Z'),hour=3600000;
const row=(id,offset,extra={})=>({sampleKey:id,hostId:'host',sessionId:id,project:'Alpha',responseId:id,turnId:'turn',sourceAt:new Date(start+offset).toISOString(),receivedAt:new Date(start+offset+1000).toISOString(),timeBasis:'source',accountAttribution:'unknown',configuredModel:'configured',input:100,cached:70,output:20,reasoning:10,total:120,...extra});
const report=records=>({scope:{from:new Date(start).toISOString(),to:new Date(start+4*hour).toISOString()},coverage:{matchingRows:records.length,returnedRows:records.length,truncated:false},responses:{records}});

test('token partitions reject missing, invalid and inconsistent values without double counting',()=>{
 assert.deepEqual(responseMeasure(row('a',0)),{input:100,cached:70,newInput:30,output:20,reasoning:10,total:120,cacheInvalid:false,reasoningInvalid:false,totalMismatch:false});
 const bad=responseMeasure(row('b',0,{cached:101,reasoning:21,total:121}));
 assert.equal(bad.newInput,null);assert.equal(bad.cached,null);assert.equal(bad.reasoning,null);assert.equal(bad.total,null);
 assert.equal(bad.cacheInvalid,true);assert.equal(bad.reasoningInvalid,true);assert.equal(bad.totalMismatch,true);
 assert.equal(responseMeasure(row('c',0,{input:null,cached:0,total:null})).newInput,null);
 assert.equal(responseMeasure(row('d',0,{input:0,cached:0,output:0,reasoning:0,total:0})).total,0);
});

test('historical buckets preserve gaps, receipt fallback, unknown attribution and aligned comparisons',()=>{
 const a=row('a',hour/4),b=row('b',hour+hour/4,{project:'Beta',input:20,cached:30,output:5,reasoning:2,total:25});
 const c=row('c',2*hour+hour/4,{project:null,sourceAt:null,timeBasis:'receipt',receivedAt:new Date(start+2*hour+hour/4).toISOString(),input:0,cached:0,output:0,reasoning:0,total:0});
 const future=row('future',3*hour,{receivedAt:new Date(start+2*hour).toISOString()});
 const value=analyzeUsage(report([a,b,c,future]),{bucketCount:4,interval:1});
 assert.deepEqual(value.buckets.map(bucket=>bucket.count),[1,1,1,0]);assert.equal(value.buckets[1].newInput,null);assert.equal(value.buckets[1].output,5);
 assert.equal(value.coverage.excludedTime,1);assert.equal(value.coverage.receiptFallback,1);assert.equal(value.coverage.unknownAccount,3);assert.equal(value.coverage.cacheInvalid,1);
 assert.equal(value.comparison.state,'comparable');assert.equal(value.comparison.change,(25-120)/120);assert.equal(value.records.length,1);
 const filtered=analyzeUsage(report([a,b,c]),{bucketCount:4,dimension:'project',contributor:JSON.stringify(['Alpha'])});
 assert.deepEqual(filtered.buckets.map(bucket=>bucket.count),[1,0,0,0]);assert.equal(filtered.records[0].sampleKey,'a');assert.ok(filtered.groups.some(group=>group.unknown));
});

test('zero baselines, incomplete totals and unsafe sums do not become percentages',()=>{
 const zero=row('zero',hour/4,{input:0,cached:0,output:0,reasoning:0,total:0});
 const next=row('next',hour+hour/4),missing=row('missing',2*hour+hour/4,{total:null});
 const value=analyzeUsage(report([zero,next,missing]),{bucketCount:4,interval:1});assert.equal(value.comparison.state,'zero-baseline');
 const incomplete=analyzeUsage(report([zero,next,missing]),{bucketCount:4,interval:2});assert.equal(incomplete.comparison.state,'unavailable');assert.equal(incomplete.coverage.excludedContributions,1);
 const huge=row('huge',hour/4,{input:Number.MAX_SAFE_INTEGER,cached:0,output:1,total:Number.MAX_SAFE_INTEGER});assert.equal(responseMeasure(huge).total,null);
});

test('an empty selected interval preserves the contributor and its period-wide share',()=>{
 const value=analyzeUsage(report([row('alpha',hour/4),row('beta',2*hour,{project:'Beta'})]),{bucketCount:4,dimension:'project',contributor:JSON.stringify(['Alpha']),interval:3});
 assert.equal(value.contributor,JSON.stringify(['Alpha']));assert.equal(value.records.length,0);
 assert.equal(value.groups.find(group=>group.label==='Alpha').share,.5);assert.equal(value.buckets[0].count,1);
});
