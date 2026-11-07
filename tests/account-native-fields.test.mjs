// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeAccountUsage,buildAccountUsageResponse} from '../lib/account-usage.mjs';
import {normalizeAccountLimits,normalizeAccountLimitState,normalizeAccountTokenUsage} from '../lib/codex-account-observer.mjs';
import {buildAccountUsageView,renderAccountUsageDetails,renderAccountStrip} from '../public/account-usage.mjs';

const now=Date.parse('2026-10-20T23:00:00Z'),at=new Date(now).toISOString(),admin={role:'admin',hostIds:null,projectIds:null};
const summary={lifetimeTokens:null,peakDailyTokens:null,longestRunningTurnSec:null,currentStreakDays:null,longestStreakDays:null};
const report=()=>({version:1,source:'codex-app-server',status:'available',observedAt:at,lastAttemptAt:at,accountKey:'d'.repeat(64),planType:'pro',limitsObservedAt:at,usageObservedAt:at,limits:[{limitId:'codex',limitName:null,planType:'pro',primary:{usedPercent:24,windowDurationMins:10080,resetsAt:1793082757},secondary:null}],summary:{...summary},dailyUsageBuckets:null,errorCode:null});
const native=()=>({ordinaryUsageAllowed:true,rateLimitResetCredits:{availableCount:0,credits:[]},threadUsage:null});
const nativeLimit=()=>({credits:{hasCredits:true,unlimited:false,balance:'12345.6789000000'},spendControlReached:false,individualLimit:null,normalModelSlug:null,rateLimitReachedType:null});
const extended=()=>{const value={...report(),...native()};Object.assign(value.limits[0],nativeLimit());return value;};

test('legacy canonical account bytes remain identical without injected optional fields',()=>{
 const original=JSON.stringify(report());let value=JSON.parse(original);
 for(let i=0;i<4;i++){value=sanitizeAccountUsage(value);assert.equal(JSON.stringify(value),original);}
 for(const key of Object.keys(native()))assert.equal(Object.hasOwn(value,key),false);
 for(const key of Object.keys(nativeLimit()))assert.equal(Object.hasOwn(value.limits[0],key),false);
 const present=extended(),canonical=sanitizeAccountUsage(present);assert.deepEqual(canonical,present);assert.equal(JSON.stringify(sanitizeAccountUsage(canonical)),JSON.stringify(canonical));
});

test('optional numeric/boolean/null presence is exact and decimal credit text is never converted to float',()=>{
 const value=extended();value.ordinaryUsageAllowed=false;value.limits[0].credits={hasCredits:false,unlimited:false,balance:'0.0000000000000001'};value.limits[0].spendControlReached=false;
 const clean=sanitizeAccountUsage(value);assert.equal(clean.ordinaryUsageAllowed,false);assert.equal(clean.rateLimitResetCredits.availableCount,0);assert.deepEqual(clean.rateLimitResetCredits.credits,[]);assert.equal(clean.limits[0].credits.balance,'0.0000000000000001');assert.equal(clean.threadUsage,null);
 for(const key of ['ordinaryUsageAllowed','rateLimitResetCredits','threadUsage']){const v=report();v[key]=null;assert.equal(sanitizeAccountUsage(v)[key],null);}
 for(const key of Object.keys(nativeLimit())){const v=report();v.limits[0][key]=null;assert.equal(sanitizeAccountUsage(v).limits[0][key],null);}
 const sparse=extended();delete sparse.limits[0].credits.balance;delete sparse.rateLimitResetCredits.credits;const result=sanitizeAccountUsage(sparse);assert.equal(Object.hasOwn(result.limits[0].credits,'balance'),false);assert.equal(Object.hasOwn(result.rateLimitResetCredits,'credits'),false);
});

test('optional account boundary rejects invalid, unqualified and malicious shapes',()=>{
 const invalid=[
  v=>v.ordinaryUsageAllowed=0,v=>v.ordinaryUsageAllowed=undefined,v=>v.threadUsage={},v=>v.threadUsage='PRIVATE',
  v=>v.rateLimitResetCredits={availableCount:-1},v=>v.rateLimitResetCredits={availableCount:Number.MAX_SAFE_INTEGER+1},v=>v.rateLimitResetCredits={availableCount:0,credits:[{id:'PRIVATE'}]},v=>v.rateLimitResetCredits={availableCount:0,secret:'PRIVATE'},
  v=>v.limits[0].credits={hasCredits:1,unlimited:false},v=>v.limits[0].credits={hasCredits:true},v=>v.limits[0].credits={hasCredits:true,unlimited:false,token:'PRIVATE'},
  ...['<img src=x>','1e6','NaN','-1','1.','1\n','9'.repeat(65),0].map(balance=>v=>v.limits[0].credits={hasCredits:true,unlimited:false,balance}),
  v=>v.limits[0].spendControlReached='false',v=>v.limits[0].individualLimit={limit:'100'},v=>v.limits[0].normalModelSlug='user@example.test',v=>v.limits[0].normalModelSlug='<script>',v=>v.limits[0].rateLimitReachedType='PRIVATE',v=>v.limits[0].rateLimitReachedType={},v=>v.private='PRIVATE'
 ];
 for(const mutate of invalid){const value=extended();mutate(value);assert.throws(()=>sanitizeAccountUsage(value),/Invalid account observation/);}
 for(const reached of ['rate_limit_reached','workspace_owner_credits_depleted','workspace_member_credits_depleted','workspace_owner_usage_limit_reached','workspace_member_usage_limit_reached']){const value=report();value.limits[0].rateLimitReachedType=reached;assert.equal(sanitizeAccountUsage(value).limits[0].rateLimitReachedType,reached);}
 const slug=report();slug.limits[0].normalModelSlug='codex/gpt-6.1-sol';assert.equal(sanitizeAccountUsage(slug).limits[0].normalModelSlug,'codex/gpt-6.1-sol');
});

test('native normalization preserves qualified fields while dropping identifiers and unqualified detail objects',()=>{
 const limit={...report().limits[0],...nativeLimit(),accountId:'PRIVATE_ACCOUNT',upsell:{html:'PRIVATE_UPSELL'}};
 const response={rateLimits:limit,ordinaryUsageAllowed:false,rateLimitResetCredits:{availableCount:0,credits:[],secret:'PRIVATE'},email:'PRIVATE_EMAIL'};
 const value={...report(),...normalizeAccountLimitState(response),...normalizeAccountTokenUsage({summary,threadUsage:null,dailyUsageBuckets:null}),limits:normalizeAccountLimits(response)};
 const clean=sanitizeAccountUsage(value);assert.equal(clean.ordinaryUsageAllowed,false);assert.equal(clean.limits[0].credits.balance,'12345.6789000000');assert.equal(clean.limits[0].spendControlReached,false);assert.equal(clean.threadUsage,null);assert.ok(!JSON.stringify(clean).includes('PRIVATE'));
 const unsupported=normalizeAccountLimitState({ordinaryUsageAllowed:'yes',rateLimitResetCredits:{availableCount:2,credits:[{id:'PRIVATE',title:'PRIVATE'}]}});assert.deepEqual(unsupported,{rateLimitResetCredits:{availableCount:2}});
 const unknown=normalizeAccountLimits({rateLimits:{...limit,individualLimit:{secret:'PRIVATE'},normalModelSlug:'<svg>',rateLimitReachedType:'PRIVATE',spendControlReached:1,credits:{hasCredits:true,unlimited:false,balance:'PRIVATE'}}})[0];assert.equal(Object.hasOwn(unknown,'individualLimit'),false);assert.equal(Object.hasOwn(unknown,'normalModelSlug'),false);assert.equal(Object.hasOwn(unknown,'rateLimitReachedType'),false);assert.equal(Object.hasOwn(unknown,'spendControlReached'),false);assert.deepEqual(unknown.credits,{hasCredits:true,unlimited:false});
 assert.equal(Object.hasOwn(normalizeAccountTokenUsage({summary,threadUsage:{groups:[{model:'PRIVATE'}]}}),'threadUsage'),false);
});

test('linked-account projection replaces optional fields only with their own newest section and never leaks to scoped viewers',()=>{
 const old=extended(),later={...report(),observedAt:new Date(now+1000).toISOString(),usageObservedAt:new Date(now+1000).toISOString(),limitsObservedAt:new Date(now-1000).toISOString()};later.summary.peakDailyTokens=0;
 const response=buildAccountUsageResponse({viewer:admin,now:now+1000,sources:[{hostId:'TEST_ONLY-old',accountUsage:old},{hostId:'TEST_ONLY-new',accountUsage:later}]});
 const account=response.accountUsage.accounts[0];assert.equal(account.ordinaryUsageAllowed,true);assert.deepEqual(account.rateLimitResetCredits,{availableCount:0,credits:[]});assert.equal(Object.hasOwn(account,'threadUsage'),false);assert.equal(account.summary.peakDailyTokens,0);assert.equal(response.accountUsage.accountCount,1);
 later.limitsObservedAt=later.observedAt;const changed=buildAccountUsageResponse({viewer:admin,now:now+1000,sources:[{hostId:'TEST_ONLY-old',accountUsage:old},{hostId:'TEST_ONLY-new',accountUsage:later}]}).accountUsage.accounts[0];assert.equal(Object.hasOwn(changed,'ordinaryUsageAllowed'),false);assert.equal(Object.hasOwn(changed,'rateLimitResetCredits'),false);assert.equal(Object.hasOwn(changed.limits[0],'credits'),false);
 for(const viewer of [{...admin,role:'viewer'},{...admin,hostIds:['TEST_ONLY-old']}]){const restricted=buildAccountUsageResponse({viewer,now,sources:[{hostId:'TEST_ONLY-old',accountUsage:old}]});assert.equal(restricted.accountUsage.status,'restricted');assert.ok(!JSON.stringify(restricted).includes('12345.6789000000'));}
});

test('compact native controls render exact credit units, independent windows, zero and unknown coverage without inference',()=>{
 const value=extended();value.ordinaryUsageAllowed=false;value.limits[0].secondary={usedPercent:50,windowDurationMins:300,resetsAt:1793082757};
 const view=buildAccountUsageView({accountUsage:{accounts:[value]},activeUsage:{},burnUsage:{}},{now}),html=renderAccountUsageDetails(view),strip=renderAccountStrip(view);
 assert.match(html,/Native account controls &amp; coverage · 0\/5/);assert.match(html,/12,345\.6789000000 · source units unspecified/);assert.match(html,/Has credits<\/dt><dd>Yes/);assert.match(html,/Credit pool unlimited<\/dt><dd>No/);assert.match(html,/Spend control reached<\/dt><dd>No/);assert.match(html,/Reset credits available<\/dt><dd>0/);assert.match(html,/0 rows reported/);assert.match(html,/ordinary included usage is blocked/);assert.match(html,/primary<\/th><td>24%<\/td><td>76%/);assert.match(html,/secondary<\/th><td>50%<\/td><td>50%/);assert.match(html,/Remaining \(derived\)/);assert.match(html,/Native thread estimate<\/dt><dd>Unavailable \(reported unknown\)/);assert.match(html,/Updated 0s ago/);assert.match(html,/not the model producing a response/);assert.doesNotMatch(html,/\$\d|USD\s\d/);assert.doesNotMatch(strip,/12345|12,345|Native account controls/);
 const zeros=report();zeros.summary=Object.fromEntries(Object.keys(summary).map(key=>[key,0]));zeros.dailyUsageBuckets=[];const zeroHtml=renderAccountUsageDetails(buildAccountUsageView({accountUsage:{accounts:[zeros]}},{now}));assert.match(zeroHtml,/5\/5 summary values available/);assert.match(zeroHtml,/Longest reported turn<\/dt><dd>0 sec/);assert.match(zeroHtml,/0 valid rows reported/);assert.match(zeroHtml,/Ordinary included usage allowed<\/dt><dd>Not reported/);
});

test('explicit missing section timestamps cannot borrow overall freshness and hostile values never become markup',()=>{
 const value=extended();value.limitsObservedAt=null;value.usageObservedAt=null;value.limits[0].credits.balance='<img src=x>';value.limits[0].normalModelSlug='<script>PRIVATE</script>';value.limits[0].rateLimitReachedType='<svg>';value.limits[0].limitId='<img>';
 const account=buildAccountUsageView({accountUsage:{accounts:[value]}},{now}).accounts[0];assert.equal(account.limitsState,'unavailable');assert.equal(account.usageState,'unavailable');assert.equal(account.limitsAge,'No source reading');
 const html=renderAccountUsageDetails(buildAccountUsageView({accountUsage:{accounts:[value]}},{now}));assert.doesNotMatch(html,/<img|<script|<svg|PRIVATE/);assert.match(html,/&lt;img&gt;/);assert.match(html,/No source reading/);
});
