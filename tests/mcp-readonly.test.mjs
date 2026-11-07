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
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {Readable,Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {serveReadOnlyMcp,MCP_PROTOCOL_VERSION} from '../scripts/mcp-readonly.mjs';

const script=fileURLToPath(new URL('../scripts/mcp-readonly.mjs',import.meta.url));
const identity={deploymentId:'TEST_ONLY-mcp-instance',readOnly:true,protocolVersion:1};
const initialize=(id=1,version=MCP_PROTOCOL_VERSION)=>({jsonrpc:'2.0',id,method:'initialize',params:{protocolVersion:version,capabilities:{},clientInfo:{name:'TEST_ONLY-client',version:'1'}}});
const initialized={jsonrpc:'2.0',method:'notifications/initialized'};
const request=(id,method,params={})=>({jsonrpc:'2.0',id,method,params});
const call=(id,name,args={})=>request(id,'tools/call',{name:'codexcontrol_'+name,arguments:args});
const protectScript=String.raw`$ErrorActionPreference='Stop';try{$p=[Console]::In.ReadToEnd()|ConvertFrom-Json;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.FileSecurity;$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($sid);foreach($s in @($sid.Value,'S-1-5-18','S-1-5-32-544')){$principal=New-Object Security.Principal.SecurityIdentifier($s);$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl','Allow')))};[IO.File]::SetAccessControl($p.path,$acl);[Console]::Out.Write('OK')}catch{exit 1}`;
async function protect(file){if(process.platform!=='win32'){await fs.chmod(file,0o600);return;}await new Promise((resolve,reject)=>{const c=spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(protectScript,'utf16le').toString('base64')],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});const timer=setTimeout(()=>{c.kill();reject(new Error('TEST_ONLY ACL setup timeout'));},4000);c.on('error',reject);c.stdout.resume();c.stderr.resume();c.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('TEST_ONLY ACL setup refused'));});c.stdin.end(JSON.stringify({path:file}));});}

async function fixture(run,handler){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-mcp-TEST_ONLY-')),file=path.join(directory,'query.json'),token=crypto.randomBytes(32).toString('base64url'),calls=[],children=[];
 const server=http.createServer((req,res)=>{const c={path:req.url,authorized:req.headers.authorization==='Bearer '+token,anyAuthorization:req.headers.authorization!==undefined};calls.push(c);if(handler)return handler(req,res,c,calls);res.end(JSON.stringify(req.url==='/api/identity'?identity:{hosts:[{id:'test-source',status:'online',preferredAddress:'PRIVATE-ADDRESS',label:'PRIVATE-LABEL'}]}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 function launch(){
  const child=spawn(process.execPath,[script,file],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false}),messages=[],waiters=[];let tail='',stderr='',failed;
  children.push(child);const complete=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));});
  child.stdin.on('error',()=>{});child.stderr.on('data',chunk=>{stderr+=chunk.toString();assert.ok(stderr.length<=4096);});
  child.stdout.on('data',chunk=>{tail+=chunk.toString('utf8');let end;while((end=tail.indexOf('\n'))>=0){const line=tail.slice(0,end);tail=tail.slice(end+1);try{assert.ok(Buffer.byteLength(line)<=262143);const m=JSON.parse(line);assert.equal(m.jsonrpc,'2.0');messages.push(m);for(const waiter of [...waiters])if(waiter.id===m.id){waiters.splice(waiters.indexOf(waiter),1);clearTimeout(waiter.timer);waiter.resolve(m);}}catch(e){failed=e;for(const waiter of waiters.splice(0)){clearTimeout(waiter.timer);waiter.reject(e);}}}assert.ok(tail.length<=262144);});
  return {child,messages,send(...values){child.stdin.write(values.map(v=>JSON.stringify(v)+'\n').join(''));},raw(value){child.stdin.write(value);},async next(id){if(failed)throw failed;const found=messages.find(m=>m.id===id);if(found)return found;return new Promise((resolve,reject)=>{const waiter={id,resolve,reject,timer:setTimeout(()=>{waiters.splice(waiters.indexOf(waiter),1);reject(new Error('TEST_ONLY STDIO response timeout'));},10000)};waiters.push(waiter);});},async ready(){this.send(initialize(),initialized);assert.equal((await this.next(1)).result.protocolVersion,MCP_PROTOCOL_VERSION);},async finish(){child.stdin.end();const result=await complete;assert.equal(tail,'');assert.ok(!stderr.includes(token));return result;},get stderr(){return stderr;}};
 }
 try{await fs.writeFile(file,JSON.stringify({version:1,origin:`http://127.0.0.1:${server.address().port}`,token,expectedInstanceId:identity.deploymentId}),{mode:0o600});await protect(file);return await run({launch,calls,token});}
 finally{for(const c of children)if(c.exitCode===null&&c.signalCode===null){c.kill();await new Promise(r=>c.once('close',r));}server.closeAllConnections();await new Promise(r=>server.close(r));assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('cc-mcp-TEST_ONLY-'));await fs.rm(directory,{recursive:true,force:true});}
}

test('actual STDIO negotiates the pinned protocol, requires initialized and exposes only strict read-only tools',()=>fixture(async({launch,calls,token})=>{
 const p=launch();p.send(request(0,'tools/list'));assert.equal((await p.next(0)).error.code,-32000);p.send(request('ping','ping'));assert.deepEqual((await p.next('ping')).result,{});p.send(initialize(1,'2025-03-26'));assert.equal((await p.next(1)).result.protocolVersion,'2025-11-25');p.send(request(2,'tools/list'));assert.equal((await p.next(2)).error.code,-32000);p.send(initialized,request(3,'tools/list'));
 const tools=(await p.next(3)).result.tools;assert.deepEqual(tools.map(t=>t.name),['codexcontrol_summary','codexcontrol_sources','codexcontrol_events','codexcontrol_usage_records','codexcontrol_history_analytics']);for(const tool of tools){assert.deepEqual(tool.annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});assert.equal(tool.inputSchema.additionalProperties,false);assert.equal(tool.execution.taskSupport,'forbidden');}
 p.send(request(4,'tools/list',{cursor:'unapproved'}),call(5,'events',{limit:101}),call(6,'sources',{url:'https://unrelated.invalid'}),request(7,'resources/list'),request(8,'sampling/createMessage'));for(const id of [4,5,6])assert.equal((await p.next(id)).error.code,-32602);for(const id of [7,8])assert.equal((await p.next(id)).error.code,-32601);assert.equal(calls.length,0);
 p.send(call(9,'sources'));const value=(await p.next(9)).result;assert.equal(value.isError,false);assert.equal(value.structuredContent.sources[0].hostId,'test-source');assert.ok(!JSON.stringify(value).includes('PRIVATE'));assert.ok(!JSON.stringify(value).includes(token));assert.deepEqual(calls.map(c=>[c.path,c.anyAuthorization,c.authorized]),[['/api/identity',false,false],['/api/snapshot?metadata=1',true,true]]);assert.equal((await p.finish()).code,0);assert.equal(p.stderr,'');
}));

test('actual STDIO serializes requests and surfaces fresh revocation or scope denial without raw errors',()=>{
 let mode='ok',apiActive=0,maximumActive=0;
 return fixture(async({launch,calls})=>{const p=launch();await p.ready();p.send(call(2,'sources'),call(3,'sources'));assert.equal((await p.next(2)).result.isError,false);assert.equal((await p.next(3)).result.isError,false);assert.deepEqual(calls.map(c=>c.path),['/api/identity','/api/snapshot?metadata=1','/api/identity','/api/snapshot?metadata=1']);assert.equal(maximumActive,1);mode='401';p.send(call(4,'sources'));assert.equal(JSON.parse((await p.next(4)).result.content[0].text).code,'AUTH_REQUIRED');mode='403';p.send(call(5,'events',{hostId:'unauthorized'}));assert.equal(JSON.parse((await p.next(5)).result.content[0].text).code,'FORBIDDEN');assert.equal(calls.filter(c=>c.path==='/api/identity').length,4);assert.ok(!JSON.stringify(p.messages).includes('PRIVATE'));assert.equal((await p.finish()).code,0);},(req,res)=>{if(req.url==='/api/identity'){res.end(JSON.stringify(identity));return;}if(mode!=='ok'){res.writeHead(Number(mode));res.end('PRIVATE upstream error');return;}apiActive++;maximumActive=Math.max(maximumActive,apiActive);setTimeout(()=>{apiActive--;res.end(JSON.stringify({hosts:[]}));},40);});
});

test('actual STDIO rate bound allows ten queries per minute and refuses the eleventh before HTTP',()=>fixture(async({launch,calls})=>{
 const p=launch();await p.ready();p.send(...Array.from({length:11},(_,i)=>call(i+2,'sources')));for(let id=2;id<12;id++)assert.equal((await p.next(id)).result.isError,false);assert.equal(JSON.parse((await p.next(12)).result.content[0].text).code,'RATE_LIMITED');assert.equal(calls.length,20);assert.equal((await p.finish()).code,0);
}));

test('actual STDIO rejects malformed UTF-8, duplicate initialization, oversized and unterminated messages without fetching',()=>fixture(async({launch,calls})=>{
 const p=launch();p.raw(Buffer.from([0xff,10]));assert.equal((await p.next(null)).error.code,-32700);p.send(initialize(),initialized,initialize(2));assert.equal((await p.next(1)).result.protocolVersion,MCP_PROTOCOL_VERSION);assert.equal((await p.next(2)).error.code,-32600);p.raw('{');const closed=await p.finish();assert.equal(closed.code,1);assert.equal(p.messages.at(-1).error.message,'Unterminated message');assert.equal(calls.length,0);
 const oversize=launch();oversize.raw(Buffer.alloc(32769,120));assert.equal((await oversize.next(null)).error.message,'Input bound exceeded');assert.equal((await oversize.finish()).code,1);assert.equal(calls.length,0);
}));

test('bounded MCP output and delayed writes provide serial backpressure with sanitized tool failures',async()=>{
 const commands=[initialize(),initialized,call(2,'summary'),call(3,'sources'),call(4,'sources')];let active=0,maxActive=0,query=0;const messages=[];
 const client={async query(){maxActive=Math.max(maxActive,++active);await new Promise(r=>setTimeout(r,5));active--;if(++query===1)return {blob:'x'.repeat(140000)};if(query===2)throw new Error('PRIVATE raw source error');return {version:1,sources:[]};}};
 const output=new Writable({highWaterMark:64,write(chunk,encoding,callback){messages.push(JSON.parse(chunk.toString()));setTimeout(callback,5);}});
 const code=await serveReadOnlyMcp({client,input:Readable.from([Buffer.from(commands.map(v=>JSON.stringify(v)+'\n').join(''))]),output});assert.equal(code,0);assert.equal(maxActive,1);assert.equal(JSON.parse(messages.find(m=>m.id===2).result.content[0].text).code,'OUTPUT_LIMIT');assert.equal(JSON.parse(messages.find(m=>m.id===3).result.content[0].text).code,'QUERY_UNAVAILABLE');assert.equal(messages.find(m=>m.id===4).result.isError,false);assert.ok(!JSON.stringify(messages).includes('PRIVATE'));
});
