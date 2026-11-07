// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceConnection} from '../public/source-connection.mjs';
test('dashboard access is distinct from collector reporting and never claims a machine is powered off',()=>{
 const initial=sourceConnection({status:'not connected'});assert.equal(initial.label,'Collector not reporting');assert.equal(initial.needsSetup,true);assert.match(initial.detail,/Opening the dashboard only displays data/);assert.match(initial.detail,/Install and start the collector/);
 const lost=sourceConnection({status:'disconnected',receivedAt:'2026-10-23T12:00:00Z'});assert.equal(lost.label,'Source reports stopped');assert.match(lost.detail,/power state is unknown/);assert.equal(lost.needsSetup,false);
 assert.equal(sourceConnection({status:'online'}).label,'Reporting');assert.equal(sourceConnection({role:'hub',status:'online'}).label,'Hub reporting');
 for(const status of ['not connected','disconnected','stale','disabled','expired','unknown'])assert.ok(!sourceConnection({status}).label.toLowerCase().includes('offline'));
});
