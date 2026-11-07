// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {gzipSync,gunzipSync,createGzip,constants} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {remoteJSON} from '../lib/upstream-json.mjs';
import {createServer} from './fixture-server.mjs';
const token='TEST_ONLY_upstream_key',hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const payload={source:'TEST_ONLY',label:'λ / 🛰 / é',missing:null,counter:Number.MAX_SAFE_INTEGER,rows:Array.from({length:128},(_,i)=>({id:'row-'+i,tokens:i*19,missing:null}))},plain=Buffer.from(JSON.stringify(payload)),compressed=gzipSync(plain,{level:1});
async function fixture(handler,run){const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{return await run({server,configuration:{url:'http://127.0.0.1:'+server.address().port,token}});}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
const raw=(server,route,{key='TEST_ONLY_gateway_key',origin,encoding='identity'}={})=>new Promise((resolve,reject)=>{const request=http.get({host:'127.0.0.1',port:server.address().port,path:route,headers:{authorization:'Bearer '+key,'accept-encoding':encoding,...(origin?{origin}:{})}},response=>{const chunks=[];response.on('error',reject);response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));});request.on('error',reject);});

test('eligible GETs negotiate gzip and streaming decode preserves exact Unicode/null/safe counters',async t=>{
 const seen=[];await fixture((req,res)=>{seen.push({path:req.url,encoding:req.headers['accept-encoding'],authorization:req.headers.authorization});res.writeHead(200,{'Content-Type':'application/json','Content-Encoding':req.url.includes('identity')?'identity':'gzip'});const source=req.url.includes('identity')?plain:compressed;for(let i=0;i<source.length;i+=7)res.write(source.subarray(i,i+7));res.end();},async({configuration})=>{
  for(const route of ['/api/snapshot?metadata=1','/api/events?after=0','/api/history?before=fixture','/api/account/usage?details=1','/api/snapshot?identity=1']){const result=await remoteJSON(configuration,route);assert.deepEqual(result,payload);assert.deepEqual(Buffer.from(JSON.stringify(result)),plain);}
 });assert.equal(seen.every(r=>r.encoding==='gzip'&&r.authorization==='Bearer '+token),true);t.diagnostic(JSON.stringify({classification:'TEST_ONLY loopback streaming fixture; entity bytes only',identityBytes:plain.length,gzipBytes:compressed.length}));
});

test('legacy identity and sensitive/write requests preserve method/body/authorization without gzip negotiation',async()=>{
 const seen=[];await fixture(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);seen.push({path:req.url,method:req.method,encoding:req.headers['accept-encoding'],authorization:req.headers.authorization,contentType:req.headers['content-type'],body:Buffer.concat(chunks).toString()});res.end(JSON.stringify({ok:true}));},async({configuration})=>{
  for(const route of ['/api/account','/api/preferences','/api/settings','/api/admin/users','/api/session','/api/auth/capabilities','/api/identity','/api/diagnostics'])assert.deepEqual(await remoteJSON(configuration,route),{ok:true});
  await remoteJSON(configuration,'/api/preferences','PUT',{fontSize:16});await remoteJSON(configuration,'/api/settings/personal','PUT',{palette:'TEST_ONLY'});await remoteJSON(configuration,'/api/snapshot','POST',{query:'TEST_ONLY'});await remoteJSON(configuration,'/api/snapshot','GET',{query:'TEST_ONLY'});
 });assert.equal(seen.every(r=>r.encoding===undefined&&r.authorization==='Bearer '+token),true);assert.equal(seen[8].method,'PUT');assert.equal(seen[8].contentType,'application/json');assert.equal(seen[8].body,'{"fontSize":16}');assert.equal(seen[11].method,'GET');assert.equal(seen[11].body,'{"query":"TEST_ONLY"}');
});

test('wire and decoded limits are independent and enforced before whole-response allocation',async t=>{
 const largeDecoded=Buffer.from(JSON.stringify({payload:'x'.repeat(16384)})),smallWire=gzipSync(largeDecoded,{level:1}),smallDecoded=Buffer.from('{}'),largeWire=Buffer.concat([...Array.from({length:900},()=>gzipSync(Buffer.alloc(0))),gzipSync(smallDecoded)]);
 assert.ok(smallWire.length<16384);assert.ok(largeDecoded.length>16384);assert.ok(largeWire.length>16384);assert.deepEqual(gunzipSync(largeWire),smallDecoded);
 await fixture((req,res)=>{res.setHeader('Content-Encoding','gzip');res.end(smallWire);},async({configuration})=>{await assert.rejects(remoteJSON(configuration,'/api/preferences'),/Upstream exceeds bound/);});
 await fixture((req,res)=>{res.setHeader('Content-Encoding','gzip');res.write(largeWire.subarray(0,8192));res.end(largeWire.subarray(8192));},async({configuration})=>{await assert.rejects(remoteJSON(configuration,'/api/preferences'),/Upstream exceeds bound/);});
 await fixture((req,res)=>res.end('x'.repeat(16385)),async({configuration})=>{await assert.rejects(remoteJSON(configuration,'/api/preferences'),/Upstream exceeds bound/);});
 t.diagnostic(JSON.stringify({classification:'TEST_ONLY low-memory preference-route bounds',decodedLimit:16384,wireLimit:16384,decodedOverflow:{wireBytes:smallWire.length,decodedBytes:largeDecoded.length},wireOverflow:{wireBytes:largeWire.length,decodedBytes:smallDecoded.length}}));
});

test('malformed/truncated/CRC/garbage gzip, unsupported encodings and interrupted responses fail closed',async()=>{
 const badCRC=Buffer.from(compressed);badCRC[badCRC.length-8]^=1;
 for(const [coding,bytes] of [['gzip',Buffer.from('TEST_ONLY not gzip')],['gzip',compressed.subarray(0,-8)],['gzip',badCRC],['gzip',Buffer.concat([compressed,Buffer.from('garbage')])],['br',compressed],['deflate',compressed],['gzip, identity',compressed]])await fixture((req,res)=>{res.writeHead(200,{'Content-Encoding':coding});res.end(bytes);},async({configuration})=>{await assert.rejects(remoteJSON(configuration,'/api/events'));});
 await fixture((req,res)=>{res.writeHead(200,{'Content-Encoding':'gzip'});res.write(compressed.subarray(0,12));setImmediate(()=>res.destroy());},async({configuration})=>{await assert.rejects(remoteJSON(configuration,'/api/snapshot'));});
 await fixture((req,res)=>res.end('{"incomplete":'),async({configuration})=>{await assert.rejects(remoteJSON(configuration,'/api/snapshot'),SyntaxError);});
});

test('status/error contracts remain bounded and redirects never become another destination',async()=>{
 let requests=0;await fixture((req,res)=>{requests++;const status=req.url.includes('redirect')?302:403;res.writeHead(status,{'Content-Encoding':'gzip',Location:'/api/other'});res.end(gzipSync(JSON.stringify({error:'TEST_ONLY denied',errors:[{path:'fixture',message:'TEST_ONLY detail'}]})));},async({configuration})=>{
  for(const [route,status] of [['/api/events',403],['/api/snapshot?redirect=1',302]])await assert.rejects(remoteJSON(configuration,route),error=>error.status===status&&error.message==='TEST_ONLY denied'&&error.errors[0].path==='fixture');
  await assert.rejects(remoteJSON(configuration,'http://127.0.0.1:1/api/snapshot'),/configured origin/);await assert.rejects(remoteJSON(configuration,'//127.0.0.1:1/api/snapshot'),/configured origin/);
 });assert.equal(requests,2);await assert.rejects(remoteJSON({url:'http://192.0.2.1',token},'/api/snapshot'),/Encrypted upstream required/);
});

test('absolute six-second deadline aborts a continuously active gzip response and cleans its stream', {timeout:10000},async()=>{
 let closed=false,timer;
 await fixture((req,res)=>{res.writeHead(200,{'Content-Encoding':'gzip'});const encoder=createGzip({level:1});encoder.on('error',()=>{});encoder.pipe(res);encoder.write('{"padding":"');encoder.flush(constants.Z_SYNC_FLUSH);timer=setInterval(()=>{encoder.write(' ');encoder.flush(constants.Z_SYNC_FLUSH);},100);res.on('close',()=>{closed=true;clearInterval(timer);encoder.destroy();});},async({configuration})=>{
  const start=performance.now();await assert.rejects(remoteJSON(configuration,'/api/snapshot'),/Upstream timeout/);const elapsed=performance.now()-start;assert.ok(elapsed>=5700&&elapsed<7500,'absolute deadline rather than activity-reset timeout');await new Promise(resolve=>setImmediate(resolve));
 });clearInterval(timer);assert.equal(closed,true);
});

test('real gateway requests compressed upstream metadata while preserving scope and local auth/origin guards',async()=>{
 const upstreamKey='TEST_ONLY_scoped_upstream',gatewayKey='TEST_ONLY_gateway_key',seen=[],observedAt='2026-10-20T12:00:00.000Z';let upstream,gateway;
 const data={observedAt,mode:'read-only-log-observer',host:{id:'hub',name:'TEST_ONLY hub'},hosts:[{id:'allowed',status:'online'},{id:'denied',status:'online'}],sessions:Array.from({length:40},(_,i)=>({id:'session-'+i,hostId:i%2?'denied':'allowed',project:i%2?'Hidden':'Alpha',provider:'TEST_ONLY',model:'TEST_ONLY',state:'Turn completed'})),events:[],coverage:{completeHistory:false}};
 try{
  upstream=createServer({viewers:[{id:'scoped',label:'Scoped fixture',tokenHash:hash(upstreamKey),hostIds:['allowed'],projectIds:['Alpha']}],readSnapshot:async()=>structuredClone(data)});upstream.prependListener('request',req=>seen.push({path:req.url,encoding:req.headers['accept-encoding'],authorization:req.headers.authorization}));await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  gateway=createServer({viewTokenHash:hash(gatewayKey),upstream:{url:'http://127.0.0.1:'+upstream.address().port,token:upstreamKey},readSnapshot:async()=>{throw new Error('TEST_ONLY gateway must not inspect native sources');}});await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
  assert.equal((await raw(gateway,'/api/snapshot?metadata=1',{key:'wrong'})).status,401);assert.equal((await raw(gateway,'/api/snapshot?metadata=1',{origin:'https://foreign.example.invalid'})).status,403);assert.equal(seen.length,0);
  const response=await raw(gateway,'/api/snapshot?metadata=1');assert.equal(response.status,200);assert.equal(response.headers['cache-control'],'no-store');const result=JSON.parse(response.body);assert.deepEqual(result.hosts.map(h=>h.id),['allowed']);assert.equal(result.sessions.length,20);assert.equal(result.sessions.every(s=>s.hostId==='allowed'&&s.project==='Alpha'),true);assert.equal(response.body.toString().includes('Hidden'),false);assert.equal(response.body.toString().includes(upstreamKey),false);assert.deepEqual(seen,[{path:'/api/snapshot?metadata=1',encoding:'gzip',authorization:'Bearer '+upstreamKey}]);
 }finally{for(const server of [gateway,upstream])if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
});
