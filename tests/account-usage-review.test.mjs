// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAccountLimits} from '../lib/codex-account-observer.mjs';
import {sanitizeAccountUsage,buildAccountUsageResponse,activeTokenUsage} from '../lib/account-usage.mjs';

const now=Date.parse('2026-10-20T12:00:00Z'),at=new Date(now).toISOString();
const viewer={role:'admin',hostIds:null,projectIds:null};
const report=(changes={})=>({version:1,source:'codex-app-server',status:'available',observedAt:at,lastAttemptAt:at,accountKey:'b'.repeat(64),planType:'pro',limitsObservedAt:at,usageObservedAt:at,limits:[{limitId:'codex',limitName:null,planType:'pro',primary:{usedPercent:17,windowDurationMins:10080,resetsAt:Math.floor(now/1000)+3600},secondary:null}],summary:{lifetimeTokens:10000,peakDailyTokens:300,longestRunningTurnSec:45,currentStreakDays:3,longestStreakDays:5},dailyUsageBuckets:[{startDate:'2026-10-19',tokens:300}],errorCode:null,...changes});

test('observer normalized quota labels are always accepted by the fleet boundary',()=>{
 const limits=normalizeAccountLimits({rateLimitsByLimitId:{codex:{limitId:'codex',limitName:'TEST_ONLY \ud800',primary:{usedPercent:17}}}});
 assert.doesNotThrow(()=>sanitizeAccountUsage(report({limits})));
});

test('observer normalizes duplicate provider limit aliases into a boundary-valid report',()=>{
 const limits=normalizeAccountLimits({rateLimitsByLimitId:{first:{limitId:'codex',primary:{usedPercent:17}},second:{limitId:'codex',primary:{usedPercent:18}}}});
 assert.doesNotThrow(()=>sanitizeAccountUsage(report({limits})));
});

test('a clock-ahead source cannot displace a current verified section from another linked observer',()=>{
 const future=new Date(now+86400000).toISOString();
 const a=report(),b=report({observedAt:future,limitsObservedAt:future,usageObservedAt:future,limits:[{...a.limits[0],primary:{...a.limits[0].primary,usedPercent:99}}],summary:{...a.summary,peakDailyTokens:999}});
 const sources=[{hostId:'TEST_ONLY-current',accountUsage:a},{hostId:'TEST_ONLY-clock-ahead',accountUsage:b}];
 for(const ordered of [sources,[...sources].reverse()]){
  const r=buildAccountUsageResponse({viewer,now,sources:ordered});
  assert.equal(r.accountUsage.summary.peakDailyTokens,300);
  assert.equal(r.accountUsage.rateLimitsByLimitId.codex.primary.usedPercent,17);
  assert.equal(r.accountUsage.status,'available');
 }
});

test('active usage retains mixed-age status and never rounds an unsafe aggregate into a valid counter',()=>{
 const base={hostId:'TEST_ONLY-source',project:'TEST_ONLY',state:'Turn started',lastEventAt:at,usageObservedAt:at,tokens:{input_tokens:0,cached_input_tokens:0,output_tokens:0,total_tokens:Number.MAX_SAFE_INTEGER}};
 const sessions=[{...base,id:'current'},{...base,id:'older',usageObservedAt:new Date(now-120001).toISOString(),tokens:{...base.tokens,total_tokens:1}}];
 const r=activeTokenUsage({hosts:[{id:base.hostId,status:'online'}],sessions},now);
 assert.equal(r.status,'partial');assert.equal(r.sessions,2);assert.equal(r.totalTokens,Number.MAX_SAFE_INTEGER);assert.equal(r.inputTokens,0);
 const allFresh=activeTokenUsage({hosts:[{id:base.hostId,status:'online'}],sessions:sessions.map(s=>({...s,usageObservedAt:at}))},now);
 assert.equal(allFresh.totalTokens,null);
});
