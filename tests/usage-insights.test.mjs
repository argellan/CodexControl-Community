// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveQuotaPace} from '../lib/usage-insights.mjs';
const now=Date.parse('2026-10-20T12:00:00Z'),reset=Math.floor((now+86400000)/1000);
const point=(minutes,used,extra={})=>({hostId:'host',identity:'private-account-key',limitsAt:now-minutes*60000,receivedAt:now-minutes*60000,accountUsage:{planType:'pro',limits:[{limitId:'codex',primary:{usedPercent:used,windowDurationMins:10080,resetsAt:reset}}]},...extra});
test('source-scoped quota pace uses real percent change and never tokens or account pooling',()=>{const [p]=deriveQuotaPace([point(30,10),point(15,11),point(0,12)],{now});assert.equal(p.percentagePointsPerHour,4);assert.equal(p.runwayHours,22);assert.equal(p.remainingPercent,88);assert.equal(p.status,'estimated');assert.equal(JSON.stringify(p).includes('private-account-key'),false);assert.equal(deriveQuotaPace([point(30,10),point(15,11),point(0,12,{hostId:'other'})],{now}).every(r=>r.status==='unavailable'),true);});
test('forecasts require enough distinct comparable observations and duration; duplicates do not warm them',()=>{assert.equal(deriveQuotaPace([point(0,10),point(0,10),point(0,10)],{now})[0].reason,'insufficient-distinct-readings');assert.equal(deriveQuotaPace([point(2,10),point(1,11),point(0,12)],{now})[0].reason,'insufficient-time-span');});
test('gaps, regressions and conflicting timestamps reset the comparison window',()=>{for(const rows of [[point(60,10),point(15,11),point(0,12)],[point(30,10),point(15,9),point(0,10)],[point(30,10),point(15,11),point(15,12),point(0,13)]])assert.equal(deriveQuotaPace(rows,{now})[0].status,'unavailable');});
test('different reset windows never combine; stale/future readings never yield a current forecast',()=>{const shifted=point(0,12);shifted.accountUsage.limits[0].primary.resetsAt++;assert.equal(deriveQuotaPace([point(30,10),point(15,11),shifted],{now}).every(p=>p.status==='unavailable'),true);assert.deepEqual(deriveQuotaPace([point(-1,30)],{now}),[]);assert.equal(deriveQuotaPace([point(60,10),point(45,11),point(30,12)],{now})[0].reason,'stale-source');});
test('a flat allowance does not invent an infinite time-to-exhaustion',()=>{const [p]=deriveQuotaPace([point(30,10),point(15,10),point(0,10)],{now});assert.equal(p.status,'estimated');assert.equal(p.percentagePointsPerHour,0);assert.equal(p.runwayHours,null);assert.equal(p.reason,'no-observed-increase');});
