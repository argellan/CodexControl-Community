#!/usr/bin/env node
// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createQueryClient,QUERY_DEFINITIONS,validateQueryArguments} from './query-codexcontrol.mjs';

export const MCP_PROTOCOL_VERSION='2025-11-25';
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const plain=(v,names)=>object(v)&&Object.keys(v).every(k=>names.includes(k));
const validId=v=>Number.isSafeInteger(v)||typeof v==='string'&&v.length>0&&v.length<=128&&v.isWellFormed()&&!/[\x00-\x1f\x7f]/.test(v);
const safeCodes=new Set(['INVALID_ARGUMENT','BUSY','RATE_LIMITED','AUTH_REQUIRED','FORBIDDEN','REDIRECT_REFUSED','QUERY_UNAVAILABLE','QUERY_TIMEOUT','RESPONSE_INVALID','RESPONSE_LIMIT','OUTPUT_LIMIT','PRIVATE_OUTPUT_REFUSED','INSTANCE_IDENTITY_MISMATCH']);
const rpcError=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
const toolError=code=>({content:[{type:'text',text:JSON.stringify({status:'error',code})}],isError:true});
const tools=QUERY_DEFINITIONS.map(d=>({name:d.tool,description:d.description,inputSchema:d.inputSchema,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},execution:{taskSupport:'forbidden'}}));

export async function serveReadOnlyMcp({client,input=process.stdin,output=process.stdout}={}){
 let state='new',tail=Buffer.alloc(0);const ignoreOutputError=()=>{};output.on('error',ignoreOutputError);
 const send=async message=>{const encoded=JSON.stringify(message)+'\n';if(Buffer.byteLength(encoded)>262144)throw new Error('Output bound');await new Promise((resolve,reject)=>output.write(encoded,e=>e?reject(new Error('Output closed')):resolve()));};
 async function handle(line){
  let m;try{m=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));}catch{await send(rpcError(null,-32700,'Parse error'));return;}
  if(!plain(m,['jsonrpc','id','method','params'])||m.jsonrpc!=='2.0'||typeof m.method!=='string'||m.method.length>128||Object.hasOwn(m,'id')&&!validId(m.id)||m.params!==undefined&&!object(m.params)){await send(rpcError(null,-32600,'Invalid request'));return;}
  const notification=!Object.hasOwn(m,'id'),p=m.params??{};
  if(notification){if(m.method==='notifications/initialized'&&state==='initializing'&&plain(p,[]))state='ready';return;}
  if(m.method==='ping'){await send(plain(p,[])?{jsonrpc:'2.0',id:m.id,result:{}}:rpcError(m.id,-32602,'Invalid params'));return;}
  if(m.method==='initialize'){
   if(state!=='new'){await send(rpcError(m.id,-32600,'Already initialized'));return;}
   const capabilities=object(p.capabilities)&&Object.keys(p.capabilities).every(k=>['experimental','roots','sampling','elicitation','tasks'].includes(k));
   const info=plain(p.clientInfo,['name','title','version','description','icons','websiteUrl'])&&typeof p.clientInfo.name==='string'&&p.clientInfo.name.length<=128&&typeof p.clientInfo.version==='string'&&p.clientInfo.version.length<=128;
   if(!plain(p,['protocolVersion','capabilities','clientInfo'])||typeof p.protocolVersion!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(p.protocolVersion)||!capabilities||!info){await send(rpcError(m.id,-32602,'Invalid initialization'));return;}
   state='initializing';await send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:MCP_PROTOCOL_VERSION,capabilities:{tools:{listChanged:false}},serverInfo:{name:'argellan-codexcontrol-readonly',title:'ARGELLAN CodexControl read-only queries',version:'1.0.1'},instructions:'Read-only authorized hot-cache observations. No worker controls, arbitrary fetches, SQL or NAS archive access. Missing fields are unknown; configured context is not producing-model attribution.'}});return;
  }
  if(state!=='ready'){await send(rpcError(m.id,-32000,'Initialization required'));return;}
  if(m.method==='tools/list'){await send(plain(p,[])?{jsonrpc:'2.0',id:m.id,result:{tools}}:rpcError(m.id,-32602,'Invalid params'));return;}
  if(m.method==='tools/call'){
   const definition=QUERY_DEFINITIONS.find(d=>d.tool===p.name),args=p.arguments===undefined?{}:p.arguments;
   try{if(!plain(p,['name','arguments'])||!definition)throw new Error('Invalid');validateQueryArguments(definition.name,args);}catch{await send(rpcError(m.id,-32602,'Invalid tool arguments'));return;}
   let result;try{const data=await client.query(definition.name,args);result={content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,isError:false};if(Buffer.byteLength(JSON.stringify({jsonrpc:'2.0',id:m.id,result}))>262143)result=toolError('OUTPUT_LIMIT');}catch(e){result=toolError(safeCodes.has(e.queryCode)?e.queryCode:'QUERY_UNAVAILABLE');}
   await send({jsonrpc:'2.0',id:m.id,result});return;
  }
  await send(rpcError(m.id,-32601,'Method not found'));
 }
 try{
  // An async stream iterator plus awaited writes/queries provides serial
  // backpressure: no unbounded queue of parsed requests or provider responses.
  for await(const raw of input){const chunk=Buffer.from(raw);let start=0,end;
   while((end=chunk.indexOf(10,start))>=0){const piece=chunk.subarray(start,end);if(tail.length+piece.length>32768){await send(rpcError(null,-32600,'Input bound exceeded'));input.destroy();return 1;}const line=tail.length?Buffer.concat([tail,piece]):piece;tail=Buffer.alloc(0);await handle(line);start=end+1;}
   const rest=chunk.subarray(start);if(tail.length+rest.length>32768){await send(rpcError(null,-32600,'Input bound exceeded'));input.destroy();return 1;}tail=Buffer.concat([tail,rest]);
  }
  if(tail.length){await send(rpcError(null,-32700,'Unterminated message'));return 1;}return 0;
 }catch{return 1;}finally{output.removeListener('error',ignoreOutputError);}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==3)throw new Error('Configuration required');const client=await createQueryClient(process.argv[2]);process.exitCode=await serveReadOnlyMcp({client});}catch{process.stderr.write('Read-only MCP configuration unavailable.\n');process.exitCode=1;}
}
