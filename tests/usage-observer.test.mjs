// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeRecords} from '../lib/observer.mjs';

const epoch=Date.parse('2026-10-20T08:00:00Z');
const at=n=>new Date(epoch+n).toISOString();
const meta={id:'worker',cwd:'C:\\TEST_ONLY\\Codex-Control',timestamp:at(0)};
const count=(rate_limits,t=1000,info={total_token_usage:{total_tokens:12000},last_token_usage:{total_tokens:4500},model_context_window:10000})=>({type:'event_msg',timestamp:at(t),payload:{type:'token_count',info,rate_limits}});
const summarize=(records,m=meta)=>summarizeRecords(records,m,at(5000),100);

test('native token-count rate windows preserve observed metadata without credentials or account inference',()=>{
 const s=summarize([count({limit_id:'codex',limit_name:'Codex',plan_type:'pro',primary:{used_percent:73,window_minutes:300,resets_at:1792486800,secret:'PRIVATE'},secondary:null,credits:{balance:'PRIVATE'},account_id:'PRIVATE'})]);
 assert.deepEqual(s.lastTokens,{total_tokens:4500});
 assert.equal(s.usageObservedAt,at(1000));
 assert.deepEqual(s.usageLimits,[{limitId:'codex',limitName:'Codex',planType:'pro',accountKey:null,observedAt:at(1000),primary:{usedPercent:73,windowDurationMins:300,resetsAt:1792486800},primaryObservedAt:at(1000),secondary:null,secondaryObservedAt:null}]);
 assert.equal(s.contextWindow,10000);assert.equal(s.tokens.total_tokens,12000);
 assert.ok(!JSON.stringify(s).includes('PRIVATE'));
});

test('sparse native limit updates retain earlier windows without resetting their observation age',()=>{
 const s=summarize([count({limit_id:'codex',primary:{used_percent:60,window_minutes:300,resets_at:1792486800},secondary:{used_percent:20,window_minutes:10080,resets_at:1793000000}},1000),count({limit_id:'codex',secondary:{used_percent:25,window_minutes:10080,resets_at:1793000000}},2000)]);
 assert.equal(s.usageLimits[0].primary.usedPercent,60);
 assert.equal(s.usageLimits[0].secondary.usedPercent,25);
 assert.equal(s.usageLimits[0].observedAt,at(2000));
 assert.equal(s.usageLimits[0].primaryObservedAt,at(1000));
 assert.equal(s.usageLimits[0].secondaryObservedAt,at(2000));
});

test('invalid limit values remain unavailable and inherited fork quota history is excluded',()=>{
 const s=summarize([count({limit_id:'codex',primary:{used_percent:'PRIVATE',window_minutes:-2,resets_at:'PRIVATE'}},1000),count({limit_id:'codex',primary:{used_percent:50}},-1000)],{...meta,forked_from_id:'parent'});
 assert.equal(s.usageLimits,null);assert.ok(!JSON.stringify(s).includes('PRIVATE'));
});

test('zero token and quota values remain observed zeros; numeric allowlists reject nonfinite and negative counters',()=>{
 const s=summarize([count({limit_id:'codex',primary:{used_percent:0,window_minutes:0,resets_at:0}},1000,{last_token_usage:{total_tokens:0,input_tokens:-1,output_tokens:Infinity},total_token_usage:{total_tokens:0},model_context_window:0})]);
 assert.deepEqual(s.lastTokens,{total_tokens:0});assert.deepEqual(s.tokens,{total_tokens:0});
 assert.equal(s.usageLimits[0].primary.usedPercent,0);assert.equal(s.usageLimits[0].primary.resetsAt,0);
});

test('quota buckets are bounded and native response usage does not masquerade as full context occupancy',()=>{
 const records=Array.from({length:12},(_,i)=>count({limit_id:'bucket-'+i,primary:{used_percent:i}},1000+i));
 records.push({type:'token_usage_record',timestamp:at(2000),payload:{usage:{total_tokens:12},thread_token_usage:{total_tokens:12345},account_id:'PRIVATE'}});
 const s=summarize(records);assert.equal(s.usageLimits.length,8);assert.equal(s.usageLimits.at(-1).limitId,'bucket-11');
 assert.equal(s.tokens.total_tokens,12345);assert.equal(s.lastTokens.total_tokens,4500);assert.ok(!JSON.stringify(s).includes('PRIVATE'));
});

test('invalid or older usage records cannot make an earlier quota window appear newly sampled',()=>{
 const s=summarize([count({limit_id:'codex',primary:{used_percent:60}},2000),count({limit_id:'codex',primary:{used_percent:10}},1000),count(null,3000,{total_token_usage:{private:'PRIVATE'},last_token_usage:{},model_context_window:null})]);
 assert.equal(s.usageLimits[0].primary.usedPercent,60);assert.equal(s.usageLimits[0].primaryObservedAt,at(2000));
 assert.equal(s.usageObservedAt,at(2000));assert.equal(s.tokens.total_tokens,12000);assert.equal(s.lastTokens.total_tokens,4500);
});
