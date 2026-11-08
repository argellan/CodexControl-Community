// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildUsageExport,usageExportPreview,usageExportJSON,usageExportCSV,usageExportSVG,usageExportPNG} from '../public/usage-export.mjs';

const now=Date.parse('2026-10-20T12:00:01.123Z');
const row=(extra={})=>({host_id:'PRIVATE_HOST',session_id:'PRIVATE_SESSION',project:'PRIVATE_PROJECT',native_thread_id:'PRIVATE_THREAD',native_session_id:'PRIVATE_NATIVE_SESSION',native_turn_id:'PRIVATE_TURN',native_root_turn_id:'PRIVATE_ROOT',native_response_id:'PRIVATE_RESPONSE',source_ms:now,received_ms:now+25,usage_scope:'response',accounting_class:'candidate',source_role:'codex-source',input_tokens:100,cached_input_tokens:20,cache_write_input_tokens:3,output_tokens:10,reasoning_output_tokens:4,total_tokens:110,reported_mask:63,provider_reported_mask:0,synthesized_mask:0,source_id:'PRIVATE_SOURCE_ID',source_record_key:'PRIVATE_RECORD_KEY',sample_key:'PRIVATE_SAMPLE_KEY',path:'C:\\PRIVATE_PATH',prompt:'PRIVATE_PROMPT',arguments:'PRIVATE_ARGS',output:'PRIVATE_OUTPUT',reasoning:'PRIVATE_REASONING',accessToken:'PRIVATE_TOKEN',...extra});
const payload=(rows=[row()])=>({password:'PRIVATE_PASSWORD',sampleAnalytics:{scope:{from:new Date(now-60000).toISOString(),to:new Date(now).toISOString()},coverage:{retainedRows:1000,matchingRows:rows.length,returnedRows:rows.length,truncated:false,excludedRows:0,identityMissing:0,conflictingResponses:0,notes:['PRIVATE_NOTE'],latestReceivedAt:new Date(now).toISOString()},responses:{status:'available',responseCount:1,totals:{input:100,cached:20,cacheWrite:3,output:10,reasoning:4,total:110,private:'PRIVATE_TOTAL'},ratios:{cacheHit:{numerator:20,denominator:100,comparableRows:1,excludedRows:0,value:999},reasoningShare:{numerator:4,denominator:10,comparableRows:1,excludedRows:0}}},recent:rows}});

test('default export redacts every identity, precise time and unapproved/private field while preserving six counters and caveats',()=>{
 const model=buildUsageExport(payload()),json=usageExportJSON(model),csv=usageExportCSV(model),svg=usageExportSVG(model);
 for(const result of [json,csv,svg])assert.doesNotMatch(result,/PRIVATE_|12:00:|\.123Z|source_record_key|source_id|sample_key|accessToken/);
 assert.equal(model.rows[0].day,'2026-10-20');assert.equal(Object.hasOwn(model.rows[0],'sourceAt'),false);assert.equal(model.scope.to,'2026-10-20');assert.equal(model.accountComplete,false);assert.equal(model.rows[0].identities.host,'host-001');
 assert.deepEqual(model.rows[0].tokens,{input:100,cached:20,cacheWrite:3,output:10,reasoning:4,total:110});assert.equal(model.responses.ratios.cacheHit.value,.2);
 assert.match(json,/denominator/);assert.match(csv,/no conversion is inferred/);assert.match(csv,/cacheHitDenominator/);assert.match(csv,/matchingRows/);assert.match(svg,/subset|subsets/);assert.match(svg,/NOT ESTABLISHED/);
 assert.ok(Object.isFrozen(model)&&Object.isFrozen(model.rows[0].tokens));
});

test('identity and precise-time disclosure require separate explicit boolean choices with an inspectable preview',()=>{
 const identities=buildUsageExport(payload(),{includeIdentities:true});assert.equal(identities.rows[0].identities.host,'PRIVATE_HOST');assert.equal(Object.hasOwn(identities.rows[0],'sourceAt'),false);assert.match(usageExportPreview(identities).warning,/Raw selected identities/);
 const times=buildUsageExport(payload(),{includePreciseTimes:true});assert.equal(times.rows[0].sourceAt,new Date(now).toISOString());assert.equal(times.rows[0].receivedAt,new Date(now+25).toISOString());assert.equal(times.rows[0].identities.host,'host-001');
 const strings=buildUsageExport(payload(),{includeIdentities:'true',includePreciseTimes:1});assert.equal(strings.identityMode,'stable-aliases');assert.equal(strings.timeResolution,'day');
 const both=usageExportJSON(buildUsageExport(payload(),{includeIdentities:true,includePreciseTimes:true}));assert.match(both,/PRIVATE_HOST/);assert.match(both,/12:00:01.123Z/);assert.doesNotMatch(both,/PRIVATE_SOURCE|PRIVATE_RECORD|PRIVATE_SAMPLE|PRIVATE_PATH|PRIVATE_PROMPT|PRIVATE_ARGS|PRIVATE_OUTPUT|PRIVATE_REASONING|PRIVATE_TOKEN/);
});

test('aliases are stable across row reordering and repeated references for a selected identity set',()=>{
 const a=row({host_id:'private-z',native_response_id:'response-z'}),b=row({host_id:'private-a',native_response_id:'response-a'});
 const first=buildUsageExport(payload([a,b,a])),second=buildUsageExport(payload([b,a]));assert.deepEqual(first.rows[0].identities,second.rows[1].identities);assert.deepEqual(first.rows[0].identities,first.rows[2].identities);
});

test('export bounds are explicit; source arrays and caller objects are never mutated or serialized directly',()=>{
 const source=payload(Array.from({length:1100},(_,i)=>row({native_response_id:'r'+i}))),before=JSON.stringify(source),model=buildUsageExport(source,{maxRows:2});assert.equal(model.rows.length,2);assert.equal(model.coverage.truncated,true);assert.equal(JSON.stringify(source),before);
 for(const maxRows of [0,-1,1001,1.2,Infinity])assert.throws(()=>buildUsageExport(source,{maxRows}),/row limit/);
 for(const serialize of [usageExportJSON,usageExportCSV,usageExportSVG,usageExportPreview])assert.throws(()=>serialize({...model,secret:'PRIVATE'}),/Build a usage export/);
});

test('missing, unsafe and inconsistent values stay unknown and cannot produce fabricated ratios or billing',()=>{
 const source=payload([row({input_tokens:-1,output_tokens:Infinity,reasoning_output_tokens:true,total_tokens:Number.MAX_SAFE_INTEGER+1,reported_mask:999})]);source.sampleAnalytics.responses.ratios.cacheHit={numerator:200,denominator:100};source.sampleAnalytics.responses.ratios.reasoningShare={numerator:0,denominator:0};source.sampleAnalytics.responses.totals.input=null;
 const model=buildUsageExport(source);assert.equal(model.rows[0].tokens.input,null);assert.equal(model.rows[0].tokens.output,null);assert.equal(model.rows[0].tokens.reasoning,null);assert.equal(model.rows[0].tokens.total,null);assert.equal(model.rows[0].reportedMask,null);assert.equal(model.responses.ratios.cacheHit.value,null);assert.equal(model.responses.ratios.reasoningShare.value,null);assert.match(usageExportSVG(model),/Unavailable/);assert.equal(model.accountComplete,false);
 assert.equal(buildUsageExport({}).rows.length,0);assert.equal(buildUsageExport({}).responses.status,'unavailable');
});

test('CSV neutralizes formula prefixes on all disclosed identity strings and quotes delimiters safely',()=>{
 const model=buildUsageExport(payload([row({host_id:'=HYPERLINK("https://evil.invalid")',session_id:'  +SUM(1,2)',project:'@evil',native_thread_id:'-formula',native_turn_id:'safe,"quoted"'})]),{includeIdentities:true}),csv=usageExportCSV(model);
 for(const text of ["'=HYPERLINK", "'  +SUM", "'@evil", "'-formula"])assert.ok(csv.includes(text));assert.ok(csv.includes('safe,""quoted""'));assert.doesNotMatch(csv,/PRIVATE_PROMPT|PRIVATE_TOKEN/);
});

test('absolute path-like identities remain excluded even with identity inclusion enabled',()=>{
 const model=buildUsageExport(payload([row({project:'C:\\PRIVATE_PATH',session_id:'/srv/PRIVATE',native_thread_id:'file:///PRIVATE'})]),{includeIdentities:true});assert.equal(model.rows[0].identities.project,null);assert.equal(model.rows[0].identities.session,null);assert.equal(model.rows[0].identities.thread,null);
});

test('SVG uses bounded dimensions, approved palette and escaped fixed text without executable/external content',()=>{
 const model=buildUsageExport(payload([row({project:'<script>alert(1)</script>'})]),{includeIdentities:true}),svg=usageExportSVG(model,{width:640,height:640,palette:'url(evil)',theme:'<script>'});assert.match(svg,/<svg[^>]+width="640"[^>]+height="640"/);for(const color of ['#F5C451','#FF8475','#2DD4BF'])assert.ok(svg.includes(color));assert.doesNotMatch(svg,/<script|foreignObject|<image|href=|onload=|PRIVATE_|url\(/i);assert.match(svg,/<desc[^>]*>.*billing/);
 for(const dimensions of [{width:639},{width:1601},{height:639},{height:1201},{width:Infinity},{width:'1200'}])assert.throws(()=>usageExportSVG(model,dimensions),/dimensions/);
});

function environment({failImage=false,failBlob=false,throwImage=false}={}){
 const calls=[],canvas={width:0,height:0,getContext:()=>({drawImage:(...args)=>calls.push(['draw',...args.slice(1)])}),toBlob:callback=>callback(failBlob?null:new Blob(['PNG_TEST_ONLY'],{type:'image/png'}))};
 return {calls,canvas,document:{createElement:tag=>{calls.push(['element',tag]);return canvas;}},Image:class{constructor(){if(throwImage)throw new Error('TEST_ONLY image failure');}set src(value){calls.push(['src',value]);queueMicrotask(()=>failImage?this.onerror?.():this.onload?.());}},URL:{createObjectURL:blob=>{calls.push(['create',blob.type]);return 'blob:TEST_ONLY_local';},revokeObjectURL:url=>calls.push(['revoke',url])},Blob};
}
test('PNG performs local bounded rasterization with a self-contained data image and releases canvas on success',async()=>{
 const env=environment(),blob=await usageExportPNG(buildUsageExport(payload()),{width:800,height:700,environment:env});assert.equal(blob.type,'image/png');assert.deepEqual(env.calls.find(v=>v[0]==='draw'),['draw',0,0,800,700]);assert.match(env.calls.find(v=>v[0]==='src')[1],/^data:image\/svg\+xml;charset=utf-8,%3Csvg/);assert.equal(env.calls.some(v=>['create','revoke'].includes(v[0])),false);assert.equal(env.canvas.width,0);assert.equal(env.canvas.height,0);
});
test('PNG prefers direct Blob decoding without a URL or Image load, preserving the strict image CSP',async()=>{
 const env=environment();delete env.Image;let closed=0;env.createImageBitmap=async blob=>{assert.equal(blob.type,'image/svg+xml');return {close:()=>closed++};};
 const result=await usageExportPNG(buildUsageExport(payload()),{environment:env});assert.equal(result.type,'image/png');assert.equal(closed,1);assert.equal(env.calls.some(v=>['create','src','revoke'].includes(v[0])),false);assert.equal(env.canvas.width,0);
 env.createImageBitmap=async()=>{throw new Error('TEST_ONLY decoding failure');};await assert.rejects(usageExportPNG(buildUsageExport(payload()),{environment:env}),/conversion failed/);
});
test('PNG falls back when a present bitmap decoder rejects SVG, without requiring a blob image CSP allowance',async()=>{
 const env=environment();env.createImageBitmap=async()=>{throw new Error('TEST_ONLY SVG unsupported');};const blob=await usageExportPNG(buildUsageExport(payload()),{environment:env});assert.equal(blob.type,'image/png');assert.match(env.calls.find(v=>v[0]==='src')[1],/^data:image\/svg\+xml/);assert.equal(env.calls.some(v=>['create','revoke'].includes(v[0])),false);
});
test('PNG rejects unavailable/failed conversion and cleans up canvas even when Image construction throws',async()=>{
 const model=buildUsageExport(payload());await assert.rejects(usageExportPNG(model,{environment:{}}),/unavailable/);
 for(const options of [{failImage:true},{failBlob:true},{throwImage:true}]){const env=environment(options);await assert.rejects(usageExportPNG(model,{environment:env}),/failed|failure/);assert.equal(env.calls.some(v=>['create','revoke'].includes(v[0])),false);assert.equal(env.canvas.width,0);}
 const env=environment();await assert.rejects(usageExportPNG(model,{width:50000,environment:env}),/dimensions/);assert.deepEqual(env.calls,[]);
});
