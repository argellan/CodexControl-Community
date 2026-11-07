// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createSyntheticDemo} from '../public/synthetic-demo.mjs';
import {buildUsageExport,usageExportJSON,usageExportSVG} from '../public/usage-export.mjs';

test('synthetic fixture is explicit, deterministic, immutable and exportable without pretending to be live usage',()=>{
 const demo=createSyntheticDemo(),again=createSyntheticDemo();assert.deepEqual(demo,again);assert.equal(demo.mode,'TEST_ONLY');assert.equal(demo.synthetic,true);assert.match(demo.label,/SYNTHETIC DEMO/);assert.equal(demo.integration.liveIngestion,false);assert.equal(demo.integration.persistCursors,false);assert.equal(demo.integration.notifications,false);assert.ok(Object.isFrozen(demo.snapshot.events));
 for(const host of demo.snapshot.hosts)assert.match(host.id,/^TEST_ONLY_/);
 for(const event of demo.snapshot.events){assert.match(event.id,/^TEST_ONLY_/);assert.equal(event.synthetic,true);}
 const model=buildUsageExport(demo.accountUsageResponse);assert.equal(model.synthetic,true);assert.equal(model.accountComplete,false);assert.match(usageExportJSON(model),/"synthetic": true/);assert.match(usageExportSVG(model),/TEST_ONLY · SYNTHETIC DEMO/);
});

test('synthetic response totals and ratio denominators match source rows, with reasoning/cache correctly treated as subsets',()=>{
 const demo=createSyntheticDemo({seed:21,workers:32}),analytics=demo.accountUsageResponse.sampleAnalytics,rows=analytics.recent;
 for(const [label,column] of Object.entries({input:'input_tokens',cached:'cached_input_tokens',cacheWrite:'cache_write_input_tokens',output:'output_tokens',reasoning:'reasoning_output_tokens',total:'total_tokens'}))assert.equal(analytics.responses.totals[label],rows.reduce((n,row)=>n+row[column],0));
 for(const row of rows){assert.ok(row.cached_input_tokens<=row.input_tokens);assert.ok(row.reasoning_output_tokens<=row.output_tokens);assert.equal(row.total_tokens,row.input_tokens+row.output_tokens);assert.equal(row.synthesized_mask,63);assert.equal(row.provider_reported_mask,0);}
 assert.equal(analytics.responses.ratios.cacheHit.denominator,analytics.responses.totals.input);assert.equal(analytics.responses.ratios.reasoningShare.denominator,analytics.responses.totals.output);assert.equal(demo.snapshot.sessions.length,32);assert.equal(demo.snapshot.events.length,64);
});

test('synthetic input bounds reject unbounded workers/seeds/clocks, and seeds change the fixture without accessing live systems',()=>{
 for(const options of [{workers:0},{workers:33},{workers:1.2},{seed:-1},{seed:4294967296},{now:0},{now:Infinity}])assert.throws(()=>createSyntheticDemo(options),/bounds/);
 assert.notDeepEqual(createSyntheticDemo({seed:1}).accountUsageResponse.sampleAnalytics.recent,createSyntheticDemo({seed:2}).accountUsageResponse.sampleAnalytics.recent);
 const original=Date.now;try{Date.now=()=>{throw new Error('live clock not expected');};assert.doesNotThrow(()=>createSyntheticDemo());}finally{Date.now=original;}
});

test('synthetic module has no live transport/storage/timer/notification imports or cursor persistence seam',async()=>{
 const source=await fs.readFile(new URL('../public/synthetic-demo.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/\b(?:import|fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|setInterval|setTimeout|Notification|indexedDB)\s*(?:\(|\.|\{|\w)/);
 const demo=createSyntheticDemo();for(const object of [demo,demo.snapshot,...demo.snapshot.events])for(const key of ['epoch','cursor','journalSequence','accessToken','usageCapture','usageCursor'])assert.equal(Object.hasOwn(object,key),false);
});
