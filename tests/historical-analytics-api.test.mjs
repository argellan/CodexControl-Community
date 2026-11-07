// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import {createServer} from '../server.mjs';
import {Administration} from '../lib/administration.mjs';
import {ConfigurationStore} from '../lib/configuration.mjs';
import {DEFAULT_CONFIGURATION} from '../public/settings-schema.mjs';

const RECEIVER='70105d47-af72-42fb-a835-97e2509d28b8',route='/api/analytics/history?report=daily&fromDay=2026-10-01&toDay=2026-10-22&source=session-deltas';
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const tokens={owner:'TEST_ONLY_historical_owner',second:'TEST_ONLY_historical_second',viewer:'TEST_ONLY_historical_viewer',scoped:'TEST_ONLY_historical_scoped',gateway:'TEST_ONLY_historical_gateway'};
const viewers=[{id:'owner',label:'TEST_ONLY owner',role:'admin',hostIds:null,projectIds:null,tokenHash:digest(tokens.owner)},{id:'second',label:'TEST_ONLY second',role:'admin',hostIds:null,projectIds:null,tokenHash:digest(tokens.second)},{id:'viewer',label:'TEST_ONLY viewer',role:'viewer',hostIds:null,projectIds:null,tokenHash:digest(tokens.viewer)},{id:'scoped',label:'TEST_ONLY scoped',role:'viewer',hostIds:['source-a'],projectIds:['TEST_ONLY project'],tokenHash:digest(tokens.scoped)}];
const hosts=()=>[{id:'source-a',role:'codex-source'},{id:'source-b'},{id:'disabled',disabled:true},{id:'expired',expiresAt:'2000-01-01T00:00:00Z'},{id:'target',role:'execution-target'},{id:'job',role:'execution-job'},{id:'unknown',role:'future-role'}].map(h=>({...h,label:'TEST_ONLY '+h.id,tokenHash:digest('TEST_ONLY_collector_'+h.id)}));
const config=()=>({version:1,engine:'duckdb',expectedReceiverId:RECEIVER,ssh:{executable:process.execPath,host:'archive.example.test',user:'codex_analytics',identityFile:path.join(os.tmpdir(),'TEST_ONLY_key'),knownHostsFile:path.join(os.tmpdir(),'TEST_ONLY_pins')}});
const report=query=>({version:1,engine:'duckdb',engineVersion:'1.4.4',receiverId:RECEIVER,report:query.report,generatedAt:'2026-10-22T12:00:00Z',coverage:{completeHistory:false,source:'verified-archive-projection',aggregation:'known-subtotals',headReconstruction:'unavailable',projectedSegments:1,pendingSegments:0,projectedItems:1,archiveItems:1,lastProjectedAt:'2026-10-22T11:00:00Z',matchedRows:query.allowedHostIds?.length===0?0:1,returnedRows:query.allowedHostIds?.length===0?0:1,truncated:false,conflictRows:0,excludedRows:0},rows:query.allowedHostIds?.length===0?[]:[{day:'2026-10-21',hostId:query.hostId??'source-a',project:query.project??'TEST_ONLY project',accountIdentity:null,source:query.source,records:1,values:{input:'10',cached:null,uncached:null,output:null,total:null},known:{input:1,cached:0,uncached:0,output:0,total:0}}]});
const close=async server=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
async function fixture(run,options={}){
 const calls=[],hub={hosts:hosts(),states:new Map()},dependencies={checkFiles:async()=>{},now:()=>calls.length*2000,transport:async args=>{calls.push(args);return JSON.stringify(report(args.request));},...options.historicalAnalyticsDependencies};
 const server=createServer({hub,viewers,historicalAnalytics:config(),readSnapshot:async()=>{throw new Error('Historical queries must not read or capture live state');},...options,historicalAnalyticsDependencies:dependencies});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const get=async(suffix='',identity='owner',extra={})=>{const headers={...(identity?{authorization:'Bearer '+tokens[identity]}:{}),...extra.headers},response=await fetch(origin+route+suffix,{...extra,headers});const text=await response.text();let data;try{data=JSON.parse(text);}catch{data={text};}return {status:response.status,data,headers:response.headers};};
 try{return await run({server,origin,get,calls,hub});}finally{await close(server);}
}

// HTTP is real loopback HTTP. The report producer and private-file check below
// are explicitly controlled stubs; actual-engine qualification is separate.
test('HTTP requires authenticated unrestricted authoritative administrators and original origin policy',()=>fixture(async({get,calls})=>{
 assert.equal((await get('',null)).status,401);for(const identity of ['viewer','scoped'])assert.equal((await get('',identity)).status,403);
 assert.equal((await get('','owner',{headers:{origin:'https://untrusted.example'}})).status,403);
 assert.equal((await get('','owner',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
 assert.equal(calls.length,0);
 const result=await get();assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');assert.deepEqual(calls[0].request.allowedHostIds,['source-a','source-b']);assert.equal(result.data.rows[0].values.input,'10');assert.equal(result.data.coverage.completeHistory,false);
}));

test('HTTP query restrictions deny unknown/duplicate fields, bad dates, unsupported sources and bounded limit violations',()=>fixture(async({get,calls,origin})=>{
 for(const suffix of ['&sql=SELECT+1','&allowedHostIds=disabled','&source=account-daily','&hostId=source-a&hostId=source-b','&limit=0','&limit=1001','&limit=1e2','&limit=001','&limit=100&limit=100','&project=%00','&project='+encodeURIComponent('x'.repeat(257))])assert.equal((await get(suffix)).status,400,suffix);
 for(const candidate of ['/api/analytics/history','/api/analytics/history?report=daily&fromDay=2026-02-30&toDay=2026-10-22&source=session-deltas','/api/analytics/history?report=responses&fromDay=2026-10-01&toDay=2026-10-22&source=session-deltas','/api/analytics/history?report=daily&fromDay=2026-10-01&toDay=2026-10-22&source=account-daily&project=TEST_ONLY'])assert.equal((await fetch(origin+candidate,{headers:{authorization:'Bearer '+tokens.owner}})).status,400,candidate);
 for(const host of ['disabled','expired','target','job','unknown','absent'])assert.equal((await get('&hostId='+host)).status,403,host);
 assert.equal(calls.length,0);const allowed=await get('&hostId=source-a&project=TEST_ONLY+project&limit=10');assert.equal(allowed.status,200);assert.equal(calls[0].request.limit,10);assert.equal(calls[0].request.project,'TEST_ONLY project');
 assert.equal((await get('','owner',{method:'HEAD'})).status,405);assert.equal((await get('','owner',{method:'POST'})).status,405);
}));

test('unconfigured and unsupported engines are unavailable without invoking controlled transport',async()=>{
 for(const historicalAnalytics of [undefined,{engine:'timescale'},{...config(),ssh:{...config().ssh,host:'bad;command'}}])await fixture(async({get,calls})=>{const result=await get();assert.equal(result.status,503);assert.equal(result.data.status,'unavailable');assert.equal(calls.length,0);},{historicalAnalytics});
 await fixture(async({get,calls})=>{assert.equal((await get()).status,503);assert.equal(calls.length,0);},{hub:undefined});
});

test('local preview cannot gain history access through bootstrap cookies or even an admin token',async()=>{
 await fixture(async({origin,calls})=>{const page=await fetch(origin+'/');const cookie=page.headers.get('set-cookie').split(';')[0],response=await fetch(origin+route,{headers:{cookie}});assert.equal(response.status,401);assert.equal(calls.length,0);},{viewers:[],localPreview:{name:'TEST_ONLY preview'}});
 await fixture(async({get,calls})=>{assert.equal((await get()).status,403);assert.equal(calls.length,0);},{localPreview:{name:'TEST_ONLY preview'}});
});

test('current source allowlist is empty when all enrollments are disabled',()=>fixture(async({hub,get,calls})=>{for(const host of hub.hosts)host.disabled=true;const result=await get();assert.equal(result.status,200);assert.deepEqual(calls[0].request.allowedHostIds,[]);assert.deepEqual(result.data.rows,[]);}));

test('controlled producer cannot return denied host, project or report details',async()=>{
 for(const mutate of [r=>r.rows[0].hostId='disabled',r=>r.rows[0].project='PRIVATE denied project',r=>r.receiverId='f42a4f46-bcd8-48c0-937f-9b4ad7accc44',r=>r.rows[0].privatePrompt='PRIVATE'])await fixture(async({get})=>{const result=await get('&project=TEST_ONLY+project');assert.equal(result.status,503);assert.equal(JSON.stringify(result.data).includes('PRIVATE'),false);},{historicalAnalyticsDependencies:{transport:async({request})=>{const value=report(request);mutate(value);return JSON.stringify(value);}}});
});

for(const mutation of ['disabled','expired','role','removed'])test('source '+mutation+' during a controlled async query is rechecked before delivery',async()=>{
 let arrived,release;const started=new Promise(resolve=>arrived=resolve),held=new Promise(resolve=>release=resolve);
 await fixture(async({get,hub})=>{const pending=get();await started;if(mutation==='disabled')hub.hosts[0].disabled=true;else if(mutation==='expired')hub.hosts[0].expiresAt='2000-01-01T00:00:00Z';else if(mutation==='role')hub.hosts[0].role='execution-target';else hub.hosts.shift();release();const result=await pending;assert.equal(result.status,403);assert.equal(result.data.rows,undefined);},{historicalAnalyticsDependencies:{transport:async({request})=>{arrived();await held;return JSON.stringify(report(request));}}});
});

test('administrator credential revocation over real administration HTTP suppresses an in-flight report',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-historical-authority-TEST_ONLY-'));let release;
 try{
  const administration=await Administration.open({directory:path.join(directory,'administration'),initial:{instanceId:crypto.randomUUID(),viewers,hosts:hosts().filter(h=>['source-a','source-b'].includes(h.id))}}),securityState=await administration.state(),configuration=await ConfigurationStore.open({directory:path.join(directory,'configuration'),initial:structuredClone(DEFAULT_CONFIGURATION)});let arrived;const started=new Promise(resolve=>arrived=resolve),held=new Promise(resolve=>release=resolve);
  await fixture(async({get,origin})=>{
   const pending=get();await started;
   const response=await fetch(origin+'/api/admin/users/owner/revoke',{method:'POST',headers:{authorization:'Bearer '+tokens.second,'content-type':'application/json'},body:JSON.stringify({revision:securityState.revision})});assert.equal(response.status,200);
   release();const result=await pending;assert.equal(result.status,401);assert.equal(result.data.rows,undefined);
  },{administration,configuration,securityState,hub:{hosts:securityState.hosts,states:new Map()},historicalAnalyticsDependencies:{transport:async({request})=>{arrived();await held;return JSON.stringify(report(request));}}});
 }finally{release?.();const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('cc-historical-authority-TEST_ONLY-'));await fs.rm(resolved,{recursive:true,force:true});}
});

test('HTTP admission rejects a concurrent query and a new query inside the rate interval',async()=>{
 let arrived,release;const started=new Promise(resolve=>arrived=resolve),held=new Promise(resolve=>release=resolve);
 await fixture(async({get})=>{const pending=get();await started;const busy=await get();assert.equal(busy.status,429);assert.equal(busy.headers.get('retry-after'),'1');release();assert.equal((await pending).status,200);assert.equal((await get()).status,429);},{historicalAnalyticsDependencies:{now:()=>0,transport:async({request})=>{arrived();await held;return JSON.stringify(report(request));}}});
});

test('HTTP disconnect aborts the controlled transport and retains admission until it settles',async()=>{
 let arrived,release,cancelled;const started=new Promise(resolve=>arrived=resolve),aborted=new Promise(resolve=>cancelled=resolve),held=new Promise(resolve=>release=resolve);
 await fixture(async({origin,get})=>{
  const client=http.get(origin+route,{headers:{authorization:'Bearer '+tokens.owner}});client.on('error',()=>{});await started;client.destroy();await aborted;assert.equal((await get()).status,429);release();
 },{historicalAnalyticsDependencies:{now:()=>2000,transport:async({request,signal})=>{signal.addEventListener('abort',()=>cancelled(),{once:true});arrived();await held;return JSON.stringify(report(request));}}});
});

test('gateway forwards through its configured authenticated upstream and preserves authoritative denial',async()=>{
 for(const upstreamIdentity of ['owner','viewer'])await fixture(async({origin:authoritative})=>{
  await fixture(async({get})=>{const result=await get('','gateway');assert.equal(result.status,upstreamIdentity==='owner'?200:403);if(result.status===200)assert.equal(result.data.receiverId,RECEIVER);else assert.equal(result.data.rows,undefined);},{hub:undefined,viewers:[],viewTokenHash:digest(tokens.gateway),upstream:{url:authoritative,token:tokens[upstreamIdentity]}});
 });
});

test('gateway preserves non-JSON upstream denial and refuses unknown response data',async()=>{
 const upstreamToken=crypto.randomBytes(32).toString('hex');
 for(const denial of [401,403,503,200]){
  const upstream=http.createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer '+upstreamToken);assert.equal(req.url.startsWith('/api/analytics/history?'),true);res.writeHead(denial,{'Content-Type':'text/plain',...(denial===403?{'Content-Encoding':'unsupported','Content-Length':'9999999'}:{})});res.end(denial===200?'PRIVATE invalid JSON':'PRIVATE upstream path');});await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  try{await fixture(async({get})=>{const result=await get('','gateway');assert.equal(result.status,denial===200?503:denial);assert.equal(JSON.stringify(result.data).includes('PRIVATE'),false);},{hub:undefined,viewers:[],viewTokenHash:digest(tokens.gateway),upstream:{url:'http://127.0.0.1:'+upstream.address().port,token:upstreamToken}});}finally{await close(upstream);}
 }
});

test('gateway local authentication is required before upstream dispatch',()=>fixture(async({origin:authoritative,calls})=>{
 const server=createServer({upstream:{url:authoritative,token:tokens.owner}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const origin='http://127.0.0.1:'+server.address().port,page=await fetch(origin+'/'),cookie=page.headers.get('set-cookie').split(';')[0];const response=await fetch(origin+route,{headers:{cookie}});assert.equal(response.status,401);assert.equal(calls.length,0);}finally{await close(server);}
}));

test('Standalone history authorizes its known desktop identity without reading live sources or inventing an enrollment',()=>{const localHub={hosts:[],states:new Map()};return fixture(async({get,calls})=>{
 const result=await get('&hostId=standalone-desktop');assert.equal(result.status,200);assert.deepEqual(calls[0].request.allowedHostIds,['standalone-desktop']);assert.equal(result.data.rows[0].hostId,'standalone-desktop');assert.equal(localHub.hosts.length,0);
 assert.equal((await get('&hostId=another-computer')).status,403);
},{hub:localHub,localObservation:{hostId:'standalone-desktop',metadata:()=>null}});});
test('local history does not bypass an explicitly disabled enrollment',()=>fixture(async({get,calls})=>{
 assert.equal((await get('&hostId=disabled')).status,403);assert.equal(calls.length,0);
},{localObservation:{hostId:'disabled',metadata:()=>null}}));
