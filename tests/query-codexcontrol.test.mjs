// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {createQueryClient,readSingleQuery,validateQueryArguments} from '../scripts/query-codexcontrol.mjs';
import {FleetHub} from '../lib/fleet.mjs';
import {createServer} from './fixture-server.mjs';
import {extractUsageSamples} from '../lib/observer.mjs';

const identity={deploymentId:'TEST_ONLY-query-instance',readOnly:true,protocolVersion:1},sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const historicalReport=()=>({version:1,engine:'duckdb',engineVersion:'1.5.6',receiverId:'11111111-1111-4111-8111-111111111111',report:'daily',generatedAt:'2026-10-22T12:00:00.000Z',coverage:{completeHistory:false,source:'verified-archive-projection',aggregation:'known-subtotals',headReconstruction:'unavailable',projectedSegments:0,pendingSegments:0,projectedItems:0,archiveItems:0,lastProjectedAt:null,matchedRows:0,returnedRows:0,truncated:false,conflictRows:0,excludedRows:0},rows:[]});
const protectScript=String.raw`$ErrorActionPreference='Stop';try{$p=[Console]::In.ReadToEnd()|ConvertFrom-Json;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.FileSecurity;$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($sid);foreach($s in @($sid.Value,'S-1-5-18','S-1-5-32-544')){$principal=New-Object Security.Principal.SecurityIdentifier($s);$r=New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl','Allow');$acl.AddAccessRule($r)};if($p.broad){$everyone=New-Object Security.Principal.SecurityIdentifier('S-1-1-0');$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($everyone,'Read','Allow')))};[IO.File]::SetAccessControl($p.path,$acl);[Console]::Out.Write('OK')}catch{exit 1}`;
async function protect(file,broad=false){if(process.platform!=='win32'){await fs.chmod(file,broad?0o644:0o600);return;}await new Promise((resolve,reject)=>{const child=spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(protectScript,'utf16le').toString('base64')],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});child.on('error',reject);child.stdout.resume();child.stderr.resume();child.on('close',code=>code===0?resolve():reject(new Error('TEST_ONLY ACL setup failed')));child.stdin.end(JSON.stringify({path:file,broad}));});}
async function fixture(run,handler){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-query-TEST_ONLY-')),file=path.join(directory,'query.json'),token=crypto.randomBytes(32).toString('base64url'),calls=[];
 const server=http.createServer((req,res)=>{const call={path:req.url,bearer:req.headers.authorization==='Bearer '+token,anyAuthorization:req.headers.authorization!==undefined};calls.push(call);if(handler)return handler(req,res,call,calls);res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/api/identity'?identity:req.url.startsWith('/api/snapshot')?{hosts:[]}:{observedAt:new Date().toISOString(),accountUsage:{status:'restricted',accountCount:0},burnUsage:{status:'idle',inputTokens:0}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));const config={version:1,origin:`http://127.0.0.1:${server.address().port}`,token,expectedInstanceId:identity.deploymentId};
 try{await fs.writeFile(file,JSON.stringify(config),{mode:0o600});await protect(file);return await run({directory,file,token,calls,server,config,write:async change=>{await fs.writeFile(file,JSON.stringify({...config,...change}));await protect(file);}});}finally{server.closeAllConnections();await new Promise(r=>server.close(r));assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('cc-query-TEST_ONLY-'));await fs.rm(directory,{recursive:true,force:true});}
}

test('every query verifies fixed instance identity without bearer before authenticated GET and strips private fields',()=>fixture(async({file,calls,token})=>{
 const client=await createQueryClient(file),value=await client.query('sources');assert.deepEqual(calls.map(c=>[c.path,c.anyAuthorization,c.bearer]),[['/api/identity',false,false],['/api/snapshot?metadata=1',true,true]]);assert.equal(value.sources[0].hostId,'test-source');assert.equal(value.sources[0].status,'online');assert.ok(!JSON.stringify(value).includes('PRIVATE'));assert.ok(!JSON.stringify(value).includes(token));await client.query('summary');assert.equal(calls.filter(c=>c.path==='/api/identity').length,2);
},(req,res)=>res.end(JSON.stringify(req.url==='/api/identity'?identity:req.url.startsWith('/api/snapshot')?{hosts:[{id:'test-source',status:'online',role:'codex-source',deviceClass:'laptop',preferredAddress:'PRIVATE-ADDRESS',alternateAddresses:['PRIVATE'],label:'PRIVATE-LABEL',telemetry:{secret:'PRIVATE'},coverage:{sourcePath:'PRIVATE'}}],sourcePath:'PRIVATE'}:{accountUsage:{status:'restricted'},secret:'PRIVATE'}))));

test('historical CLI queries fixed archive route and preserves projection coverage without claiming hot-cache history',()=>fixture(async({file,calls})=>{
 const client=await createQueryClient(file),args={report:'daily',source:'session-deltas',fromDay:'2026-10-01',toDay:'2026-10-22',limit:1000};
 const result=await client.query('history-analytics',args);assert.deepEqual(result,historicalReport());
 assert.equal(calls.length,2);assert.equal(calls[0].path,'/api/identity');assert.equal(calls[0].anyAuthorization,false);assert.equal(calls[1].bearer,true);
 const url=new URL(calls[1].path,'http://localhost');assert.equal(url.pathname,'/api/analytics/history');assert.deepEqual(Object.fromEntries(url.searchParams),Object.fromEntries(Object.entries(args).map(([k,v])=>[k,String(v)])));
 for(const bad of [{...args,allowedHostIds:['another-host']},{...args,sql:'select 1'},{...args,fromDay:'2026-02-30'},{...args,limit:1001},{...args,source:'combined'},{report:'responses',source:'account-daily',fromDay:args.fromDay,toDay:args.toDay}])assert.throws(()=>validateQueryArguments('history-analytics',bad),e=>e.queryCode==='INVALID_ARGUMENT');
},(req,res)=>res.end(JSON.stringify(req.url==='/api/identity'?identity:historicalReport()))));

test('historical query refuses unexpected fields and preserves authoritative denial',()=>{let mode='extra';return fixture(async({file})=>{
 const client=await createQueryClient(file),args={report:'daily',source:'session-deltas',fromDay:'2026-10-01',toDay:'2026-10-22'};
 await assert.rejects(client.query('history-analytics',args),e=>e.queryCode==='RESPONSE_INVALID');mode='denied';await assert.rejects(client.query('history-analytics',args),e=>e.queryCode==='FORBIDDEN');
},(req,res)=>{if(req.url==='/api/identity'){res.end(JSON.stringify(identity));return;}if(mode==='denied'){res.writeHead(403);res.end('PRIVATE');return;}res.end(JSON.stringify({...historicalReport(),privateSource:'PRIVATE'}));});});

test('actual event query preserves only the exact typed compaction discriminator and leaves legacy event bytes unchanged',async()=>{
 const legacy={id:'TEST_ONLY-legacy',hostId:'test-source',sessionId:'TEST_ONLY-session',project:'Example',at:'2026-10-20T12:00:00Z',kind:'operation',category:'tool',outcome:'recorded',label:'Context compaction'},typed={...legacy,id:'TEST_ONLY-typed',operationType:'context-compaction'};let includeTyped=false;
 await fixture(async({file,calls})=>{const client=await createQueryClient(file),before=await client.query('events',{limit:100});assert.equal(before.events.length,1);assert.ok(!Object.hasOwn(before.events[0],'operationType'));const originalBytes=JSON.stringify(before.events[0]);includeTyped=true;const after=await client.query('events',{limit:100});assert.equal(JSON.stringify(after.events[0]),originalBytes);assert.equal(after.events[1].operationType,'context-compaction');assert.ok(after.events.slice(2).every(e=>!Object.hasOwn(e,'operationType')));assert.deepEqual(calls.map(c=>[c.path,c.bearer]),[['/api/identity',false],['/api/events?after=0&limit=100',true],['/api/identity',false],['/api/events?after=0&limit=100',true]]);},(req,res)=>{
  if(req.url==='/api/identity'){res.end(JSON.stringify(identity));return;}
  const invalid=['ContextCompaction','compaction','context-compaction ',null,1,true,{}].map((operationType,i)=>({...legacy,id:'TEST_ONLY-invalid-'+i,operationType})),wrongKinds=['tool.start','message','complete'].map((kind,i)=>({...typed,id:'TEST_ONLY-kind-'+i,kind}));res.end(JSON.stringify({events:includeTyped?[legacy,typed,...invalid,...wrongKinds]:[legacy],epoch:'TEST_ONLY-epoch',nextCursor:1,caughtUp:true}));
 });
});

test('wrong identity, redirects, missing authorization and revoked access fail with fixed errors',async()=>{
 for(const status of ['wrong-identity','redirect-identity','redirect-data','401','403'])await fixture(async({file,calls,token})=>{const client=await createQueryClient(file),code={'wrong-identity':'INSTANCE_IDENTITY_MISMATCH','redirect-identity':'REDIRECT_REFUSED','redirect-data':'REDIRECT_REFUSED','401':'AUTH_REQUIRED','403':'FORBIDDEN'}[status];await assert.rejects(client.query('summary'),e=>e.queryCode===code&&!e.message.includes(token));if(status==='wrong-identity'||status==='redirect-identity')assert.equal(calls.some(c=>c.anyAuthorization),false);},(req,res)=>{if(req.url==='/api/identity'){if(status==='redirect-identity'){res.writeHead(302,{location:'https://unrelated.invalid'});res.end();}else res.end(JSON.stringify({...identity,...(status==='wrong-identity'?{deploymentId:'OTHER'}:{})}));}else if(status==='redirect-data'){res.writeHead(307,{location:'https://unrelated.invalid'});res.end();}else{res.writeHead(Number(status));res.end('PRIVATE raw provider error');}});
 let revoked=false;await fixture(async({file,calls})=>{const client=await createQueryClient(file);await client.query('summary');revoked=true;await assert.rejects(client.query('summary'),e=>e.queryCode==='AUTH_REQUIRED');assert.equal(calls.filter(c=>c.path==='/api/identity').length,2);},(req,res)=>{if(req.url==='/api/identity')res.end(JSON.stringify(identity));else if(revoked){res.writeHead(401);res.end('PRIVATE');}else res.end(JSON.stringify({accountUsage:{status:'restricted'}}));});
});

test('a reflected viewer credential is refused even when JSON escaping hides its literal bytes',async()=>{
 let reflected;await fixture(async({file,token,write})=>{reflected=token.slice(0,-1)+'"';await write({token:reflected});const client=await createQueryClient(file);await assert.rejects(client.query('summary'),e=>e.queryCode==='PRIVATE_OUTPUT_REFUSED'&&!e.message.includes(reflected));},(req,res)=>res.end(JSON.stringify(req.url==='/api/identity'?identity:{accountUsage:{accounts:[{planType:reflected}]}})));
});

test('private config requires protected permissions, regular nonlinked bounded JSON and a fixed credential-free origin',()=>fixture(async({file,write,directory,calls})=>{
 await protect(file,true);await assert.rejects(createQueryClient(file),e=>e.queryCode==='PRIVATE_FILE_PERMISSIONS_UNQUALIFIED');await protect(file);
 for(const origin of ['http://example.com','http://127.1','https://user:password@example.com','https://example.com/path','https://example.com/']){await write({origin});await assert.rejects(createQueryClient(file),e=>e.queryCode==='CONFIG_REFUSED');}
 await write({extra:'PRIVATE'});await assert.rejects(createQueryClient(file),e=>e.queryCode==='CONFIG_REFUSED');await write({});
 const link=path.join(directory,'linked');await fs.symlink(directory,link,process.platform==='win32'?'junction':'dir');await assert.rejects(createQueryClient(path.join(link,'query.json')),e=>e.queryCode==='CONFIG_REFUSED');
 await fs.writeFile(file,'x'.repeat(16385));await assert.rejects(createQueryClient(file),e=>e.queryCode==='CONFIG_REFUSED');assert.deepEqual(calls,[]);
}));

test('strict queries and input EOF bounds refuse arbitrary paths, SQL, unknown fields, unsafe cursors and oversized pages before HTTP',()=>fixture(async({file,calls})=>{
 const client=await createQueryClient(file);for(const [name,args]of [['sql',{}],['events',{path:'/private'}],['sources',{hostId:'hidden'}],['summary',{details:1}],['events',{after:-1}],['events',{limit:101}],['events',{epoch:'PRIVATE/path'}],['usage-records',{project:'PRIVATE/path'}]])await assert.rejects(client.query(name,args),e=>e.queryCode==='INVALID_ARGUMENT');assert.equal(calls.length,0);
 assert.throws(()=>validateQueryArguments('sources',{url:'https://elsewhere.invalid'}));await assert.rejects(readSingleQuery(Readable.from([Buffer.from('{"query":"sources"}\n{"query":"sources"}\n')])),e=>e.queryCode==='INPUT_LIMIT');await assert.rejects(readSingleQuery(Readable.from([Buffer.alloc(32771,120)])),e=>e.queryCode==='INPUT_LIMIT');assert.deepEqual(await readSingleQuery(Readable.from(['{"query":"events","arguments":{"limit":100}}\n'])),{query:'events',arguments:{limit:100}});
}));

test('actual query CLI waits for a single complete stdin request and EOF before reading credentials or fetching',()=>fixture(async({file,calls,token})=>{
 const script=fileURLToPath(new URL('../scripts/query-codexcontrol.mjs',import.meta.url));
 async function run(chunks,{waitBeforeEnd=false,config=file}={}){const child=spawn(process.execPath,[script,config],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});let output='',stderr='';child.stdout.on('data',c=>{output+=c;assert.ok(Buffer.byteLength(output)<=262145);});child.stderr.on('data',c=>{stderr+=c;assert.ok(stderr.length<=4096);});child.stdin.on('error',()=>{});const complete=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code));});const timer=setTimeout(()=>child.kill(),8000);try{for(const chunk of chunks)child.stdin.write(chunk);if(waitBeforeEnd){await new Promise(r=>setTimeout(r,100));assert.equal(calls.length,0);}child.stdin.end();const code=await complete;assert.equal(stderr,'');assert.ok(!output.includes(token));return {code,value:JSON.parse(output)};}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill();}}
 const invalid=await run(['{"query":"sources"}\n','{"query":"sources"}\n'],{waitBeforeEnd:true});assert.equal(invalid.code,1);assert.equal(invalid.value.code,'INPUT_LIMIT');assert.equal(calls.length,0);
 const tooLarge=await run([Buffer.alloc(32771,120)],{config:path.join(path.dirname(file),'missing.json')});assert.equal(tooLarge.value.code,'INPUT_LIMIT');assert.equal(calls.length,0);
 const valid=await run(['{"query":"sources"}\n'],{waitBeforeEnd:true});assert.equal(valid.code,0);assert.equal(valid.value.query,'sources');assert.equal(calls.length,2);
}));

test('per-client rate and concurrent-call bounds refuse excess work before issuing requests',()=>fixture(async({file,calls})=>{
 let clock=100000;const client=await createQueryClient(file,{clock:()=>clock});for(let i=0;i<10;i++)await client.query('sources');await assert.rejects(client.query('sources'),e=>e.queryCode==='RATE_LIMITED');assert.equal(calls.length,20);clock+=60001;const pending=client.query('sources');await assert.rejects(client.query('sources'),e=>e.queryCode==='BUSY');await pending;assert.equal(calls.length,22);
}));

test('upstream identity and combined body limits refuse oversized or malformed responses without exposing raw data',async()=>{
 for(const part of ['identity','api','json'])await fixture(async({file,calls})=>{const client=await createQueryClient(file);await assert.rejects(client.query('summary'),e=>e.queryCode===(part==='json'?'RESPONSE_INVALID':'RESPONSE_LIMIT'));if(part==='identity')assert.equal(calls.some(c=>c.anyAuthorization),false);},(req,res)=>{if(req.url==='/api/identity')res.end(part==='identity'?'x'.repeat(8193):JSON.stringify(identity));else res.end(part==='api'?'x'.repeat(2097153):'PRIVATE invalid JSON');});
});

test('the six-second deadline covers identity and data together',()=>fixture(async({file})=>{
 const client=await createQueryClient(file),start=Date.now();await assert.rejects(client.query('summary'),e=>e.queryCode==='QUERY_TIMEOUT');assert.ok(Date.now()-start<7200);
},(req,res)=>{const timer=setTimeout(()=>res.end(JSON.stringify(req.url==='/api/identity'?identity:{accountUsage:{status:'restricted'}})),3200);res.once('close',()=>clearTimeout(timer));}));

test('HTTPS rejects untrusted certificates even when an external environment requests insecure TLS and never follows TLS redirects',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-query-tls-TEST_ONLY-')),key=path.join(directory,'key.pem'),cert=path.join(directory,'cert.pem'),file=path.join(directory,'query.json');let server;const openssl=process.platform==='win32'?'C:\\Program Files\\Git\\usr\\bin\\openssl.exe':'openssl';
 try{try{await promisify(execFile)(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{timeout:10000,windowsHide:true});}catch{t.skip('OpenSSL TEST_ONLY certificate fixture unavailable');return;}let mode='normal',requests=0;server=https.createServer({key:await fs.readFile(key),cert:await fs.readFile(cert)},(req,res)=>{requests++;if(mode==='redirect'){res.writeHead(302,{location:'https://unrelated.invalid'});res.end();}else res.end(JSON.stringify(req.url==='/api/identity'?identity:{hosts:[]}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));const config={version:1,origin:`https://localhost:${server.address().port}`,token:crypto.randomBytes(32).toString('base64url'),expectedInstanceId:identity.deploymentId};await fs.writeFile(file,JSON.stringify(config));await protect(file);const previous=process.env.NODE_TLS_REJECT_UNAUTHORIZED;process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';try{await assert.rejects((await createQueryClient(file)).query('sources'));assert.equal(requests,0);}finally{if(previous===undefined)delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;else process.env.NODE_TLS_REJECT_UNAUTHORIZED=previous;}
 await protect(cert);await fs.writeFile(file,JSON.stringify({...config,caFile:cert}));const client=await createQueryClient(file);assert.equal((await client.query('sources')).sources.length,0);assert.equal(requests,2);mode='redirect';await assert.rejects(client.query('sources'),e=>e.queryCode==='REDIRECT_REFUSED');assert.equal(requests,3);
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('cc-query-tls-TEST_ONLY-'));await fs.rm(directory,{recursive:true,force:true});}
});

test('actual authenticated API scopes constrain sources, events and numeric samples without exposing account keys or paths',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-query-scope-TEST_ONLY-')),file=path.join(directory,'query.json'),token=crypto.randomBytes(32).toString('base64url');let server;
 try{const hosts=['visible','hidden'].map(id=>({id,tokenHash:sha('TEST_ONLY-'+id),label:'PRIVATE-LABEL',preferredAddress:'203.0.113.9'})),hub=await FleetHub.open({directory:path.join(directory,'hub'),hosts}),at=new Date().toISOString();for(const host of hosts){const sample=extractUsageSamples({type:'token_usage_record',timestamp:at,payload:{thread_id:'TEST_ONLY-thread',turn_id:'TEST_ONLY-turn',response_id:host.id+'-response',usage:{input_tokens:10,reasoning_output_tokens:2,output_tokens:3,total_tokens:13}}},{metadata:{id:host.id+'-session',cwd:host.id==='visible'?'/TEST_ONLY/allowed':'/TEST_ONLY/hidden'},sourceId:'a'.repeat(64),sourceOffset:100});await hub.ingest('TEST_ONLY-'+host.id,{hostId:host.id,batchId:host.id,observedAt:at,sessions:[{id:host.id+'-session',project:host.id==='visible'?'allowed':'hidden',cwd:'PRIVATE-PATH'}],events:[{id:host.id+'-event',sessionId:host.id+'-session',project:host.id==='visible'?'allowed':'hidden',kind:'operation',at,label:'PRIVATE-FREEFORM',category:'tool'}],usageSamples:sample});}
 server=createServer({hub,instanceId:identity.deploymentId,viewers:[{id:'test-viewer',label:'PRIVATE-VIEWER',tokenHash:sha(token),hostIds:['visible'],projectIds:['allowed']} ]});await new Promise(r=>server.listen(0,'127.0.0.1',r));await fs.writeFile(file,JSON.stringify({version:1,origin:`http://127.0.0.1:${server.address().port}`,token,expectedInstanceId:identity.deploymentId}));await protect(file);const client=await createQueryClient(file),sources=await client.query('sources'),events=await client.query('events',{limit:100}),samples=await client.query('usage-records',{hostId:'visible',project:'allowed'}),summary=await client.query('summary',{details:true});assert.deepEqual(sources.sources.map(s=>s.hostId),['visible']);assert.ok(events.events.every(e=>e.hostId==='visible'&&e.project==='allowed'));assert.ok(samples.records.every(r=>r.host_id==='visible'&&r.project==='allowed'));assert.equal(samples.records.length,1);assert.equal(summary.accountUsage.status,'restricted');assert.ok(!JSON.stringify([sources,events,samples,summary]).includes('PRIVATE'));assert.ok(!JSON.stringify(samples).includes('provider_account_key'));await assert.rejects(client.query('events',{hostId:'hidden'}),e=>e.queryCode==='FORBIDDEN');
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('cc-query-scope-TEST_ONLY-'));await fs.rm(directory,{recursive:true,force:true});}
});
