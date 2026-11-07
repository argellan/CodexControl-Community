// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
const {RetryPolicy,retryAfterDelay}=await import('../public/retry-policy.mjs').catch(()=>({}));

test('failed attempts grow exponentially, apply bounded jitter and stay inside the delay cap',()=>{
 assert.equal(typeof RetryPolicy,'function');let clock=0;
 const policy=new RetryPolicy({intervalMs:1000,maxMs:8000,clock:()=>clock,random:()=>1});
 for(const expected of [2000,4000,8000,8000]){assert.equal(policy.begin(),true);assert.equal(policy.fail(new Error('TEST_ONLY outage')),expected);assert.equal(policy.remaining(),expected);clock+=expected;}
 const low=new RetryPolicy({intervalMs:1000,maxMs:8000,clock:()=>0,random:()=>0});assert.equal(low.begin(),true);assert.equal(low.fail(),1500);
});

test('a successful synchronization resets the failure budget and schedules the normal interval immediately',()=>{
 assert.equal(typeof RetryPolicy,'function');let clock=0;const policy=new RetryPolicy({intervalMs:1000,maxMs:8000,clock:()=>clock,random:()=>1});
 policy.begin();policy.fail();clock=2000;policy.begin();policy.fail();clock=6000;assert.equal(policy.begin(),true);assert.equal(policy.succeed(),1000);assert.equal(policy.failures,0);assert.equal(policy.remaining(),1000);clock=7000;policy.begin();assert.equal(policy.fail(),2000);
});

test('one in-flight owner and one due time prevent overlap and manual refresh from bypassing backoff',()=>{
 assert.equal(typeof RetryPolicy,'function');let clock=100;const policy=new RetryPolicy({intervalMs:1000,maxMs:8000,clock:()=>clock,random:()=>1});
 assert.equal(policy.begin(),true);assert.equal(policy.begin(),false);policy.fail();clock=2099;assert.equal(policy.remaining(),1);assert.equal(policy.begin(),false);clock=2100;assert.equal(policy.begin(),true);assert.equal(policy.begin(),false);policy.succeed();clock=3100;assert.equal(policy.begin(),true);
});

test('Retry-After seconds and dates apply only to 429/503 responses and are bounded',()=>{
 assert.equal(typeof retryAfterDelay,'function');const now=Date.parse('2026-10-20T00:00:00Z'),options={now,maxMs:30000};
 assert.equal(retryAfterDelay({status:429,retryAfter:'12'},options),12000);assert.equal(retryAfterDelay({status:503,retryAfter:'Tue, 20 Oct 2026 00:00:20 GMT'},options),20000);assert.equal(retryAfterDelay({status:503,retryAfter:'999999999999999999999'},options),30000);assert.equal(retryAfterDelay({status:500,retryAfter:'12'},options),0);assert.equal(retryAfterDelay({status:200,retryAfter:'12'},options),0);
 for(const value of ['-1','1.5','not a date','x'.repeat(129),[],{},null])assert.equal(retryAfterDelay({status:429,retryAfter:value},options),0);
 assert.equal(retryAfterDelay({status:503,retryAfter:'Mon, 19 Oct 2026 23:59:59 GMT'},options),0);
});

test('server retry guidance cannot shorten local backoff or delay beyond the configured cap',()=>{
 assert.equal(typeof RetryPolicy,'function');let clock=0;const wallClock=()=>Date.parse('2026-10-20T00:00:00Z');const policy=new RetryPolicy({intervalMs:1000,maxMs:30000,clock:()=>clock,wallClock,random:()=>1});
 policy.begin();assert.equal(policy.fail({status:429,retryAfter:'25'}),25000);clock=25000;policy.begin();assert.equal(policy.fail({status:503,retryAfter:'0'}),4000);clock=29000;policy.begin();assert.equal(policy.fail({status:503,retryAfter:'3600'}),30000);
});

test('malformed random readings and caller bounds cannot create a hot loop or infinite delay',()=>{
 assert.equal(typeof RetryPolicy,'function');
 for(const random of [()=>NaN,()=>-50,()=>50]){const policy=new RetryPolicy({intervalMs:1000,maxMs:30000,clock:()=>0,random});policy.begin();const delay=policy.fail();assert.ok(delay>=1500&&delay<=2000);assert.equal(policy.remaining(),delay);}
 const policy=new RetryPolicy({intervalMs:60000,maxMs:1000,clock:()=>0,random:()=>0});policy.begin();assert.equal(policy.fail(),60000);
});

test('cadenced observation polls keep their start interval while slow responses retain a minimum rest and errors back off',()=>{let clock=0;const policy=new RetryPolicy({clock:()=>clock,intervalMs:1000,random:()=>1});assert.equal(policy.begin(),true);clock=200;assert.equal(policy.succeed({cadence:true}),800);clock=1000;assert.equal(policy.begin(),true);clock=2200;assert.equal(policy.succeed({cadence:true}),250);assert.equal(policy.begin(),false);clock=2450;assert.equal(policy.begin(),true);assert.equal(policy.fail(),2000);});
