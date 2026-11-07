// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {gunzipSync} from 'node:zlib';
import {encodingQualities,createRepresentationDelivery,deliverRepresentation,REPRESENTATION_LIMITS as limits} from '../lib/http-representation.mjs';

class Response extends EventEmitter{
 constructor(statusCode=200){super();this.statusCode=statusCode;this.headers=new Map();this.destroyed=false;this.writableEnded=false;}
 getHeader(name){return this.headers.get(name.toLowerCase());}
 hasHeader(name){return this.headers.has(name.toLowerCase());}
 setHeader(name,value){this.headers.set(name.toLowerCase(),value);}
 end(body){assert.equal(this.writableEnded,false);this.body=body;this.writableEnded=true;}
 disconnect(){this.destroyed=true;this.emit('close');}
}
const request=(encoding='gzip',method='GET')=>({method,headers:{'accept-encoding':encoding}}),payload=JSON.stringify({source:'TEST_ONLY',rows:Array.from({length:128},(_,i)=>({id:i,tokens:i*17,missing:null,label:'source-λ-🛰'}))});

test('negotiation handles explicit, wildcard, empty, identity and bounded valid q values',()=>{
 for(const [header,expected] of [[undefined,{gzip:0,identity:1}],['',{gzip:0,identity:1}],['gzip',{gzip:1,identity:1}],['GZIP ; Q=0.500, identity;q=0.2',{gzip:.5,identity:.2}],['gzip;q=0, *;q=1',{gzip:0,identity:1}],['*;q=0, identity;q=0.5',{gzip:0,identity:.5}],['*;q=0.4',{gzip:.4,identity:1}],['br, identity;q=0',{gzip:0,identity:0}],['gzip;q=1, gzip;q=0',{gzip:0,identity:1}],[' , , ',{gzip:0,identity:1}]])assert.deepEqual(encodingQualities(header),expected,header);
 for(const header of ['gzip;q=2','gzip;q=-1','gzip;q=.5','gzip;q=0.1234','gzip;q=1.001','gzip;q=NaN','gzip;q=0;level=1','gzip;foo=1','gzip;q=','x'.repeat(8193),Array(130).fill('gzip').join(',')])assert.throws(()=>encodingQualities(header),error=>error.status===400,header);
});

test('gzip is byte-exact for unicode/null/counters and preserves Vary with no cache',async()=>{
 const compressed=new Response();compressed.setHeader('Vary','Origin');compressed.setHeader('Cache-Control','no-store');await deliverRepresentation(request(),compressed,payload);
 assert.equal(compressed.getHeader('Content-Encoding'),'gzip');assert.deepEqual(gunzipSync(compressed.body),Buffer.from(payload));assert.equal(compressed.getHeader('Content-Length'),compressed.body.length);assert.equal(compressed.getHeader('Vary'),'Origin, Accept-Encoding');assert.equal(compressed.getHeader('Cache-Control'),'no-store');
 const identity=new Response();await deliverRepresentation(request('gzip;q=0,*;q=1'),identity,payload);assert.equal(identity.getHeader('Content-Encoding'),undefined);assert.equal(identity.body,payload);assert.equal(identity.getHeader('Content-Length'),Buffer.byteLength(payload));
 const preferred=new Response();await deliverRepresentation(request('gzip;q=0.2,identity;q=0.8'),preferred,payload);assert.equal(preferred.body,payload);
 const varied=new Response();varied.setHeader('Vary','accept-encoding');await deliverRepresentation(request('identity'),varied,payload);assert.equal(varied.getHeader('Vary'),'accept-encoding');
});

test('unsupported representations refuse and HEAD/no-body responses never compress or compute a body',async()=>{
 let calls=0;const deliver=createRepresentationDelivery({compress(){calls++;throw new Error('not expected');}});
 for(const value of ['gzip;q=0,identity;q=0','br,identity;q=0','*;q=0'])await assert.rejects(deliver(request(value),new Response(),payload),error=>error.status===406);
 const head=new Response();await deliver(request('gzip,identity;q=0','HEAD'),head,null);assert.equal(head.body,undefined);assert.equal(head.getHeader('Content-Length'),undefined);assert.equal(head.getHeader('Content-Encoding'),undefined);assert.equal(head.getHeader('Vary'),'Accept-Encoding');
 for(const status of [204,205,304]){const res=new Response(status);await deliver(request(),res,null);assert.equal(res.body,undefined);}
 assert.equal(calls,0);
 const cookie=new Response();cookie.setHeader('Set-Cookie','TEST_ONLY_cookie');await deliver(request(),cookie,payload);assert.equal(cookie.body,payload);assert.equal(calls,0);
});

test('global admission has two actual tasks, no queue, and disconnect holds a slot until completion',async()=>{
 const held=[],compress=(input,options,done)=>held.push({input,options,done}),one=createRepresentationDelivery({compress,maxWaitMs:0}),two=createRepresentationDelivery({compress,maxWaitMs:0});
 const first=new Response(),second=new Response(),pending=[one(request(),first,payload),two(request(),second,payload)];assert.equal(held.length,2);assert.equal(held[0].options.level,3);assert.equal(held[0].options.maxOutputLength,limits.maxOutputBytes);
 const fallback=new Response();await one(request(),fallback,payload);assert.equal(fallback.body,payload);assert.equal(held.length,2);
 await assert.rejects(two(request('gzip,identity;q=0'),new Response(),payload),error=>error.status===503);
 first.disconnect();const stillBusy=new Response();await one(request(),stillBusy,payload);assert.equal(stillBusy.body,payload);assert.equal(held.length,2);
 held[0].done(null,Buffer.from('gzip-result'));await pending[0];assert.equal(first.writableEnded,false);assert.equal(first.listenerCount('close'),0);
 const third=new Response(),thirdPending=two(request(),third,payload);assert.equal(held.length,3);held[1].done(null,Buffer.from('gzip-result'));held[2].done(null,Buffer.from('gzip-result'));await Promise.all([pending[1],thirdPending]);
 assert.equal(second.getHeader('Content-Encoding'),'gzip');assert.equal(third.getHeader('Content-Encoding'),'gzip');
});

test('input/output/failure bounds fall back safely and release admission on every completion',async()=>{
 let calls=0;const deliver=createRepresentationDelivery({compress(input,options,done){calls++;done(new Error('TEST_ONLY failure'));}}),oversize='λ'.repeat(limits.maxInputBytes/2+1);
 const tooLarge=new Response();await deliver(request(),tooLarge,oversize);assert.equal(calls,0);assert.equal(tooLarge.body,oversize);await assert.rejects(deliver(request('gzip,identity;q=0'),new Response(),oversize),error=>error.status===503);
 const fail=new Response();await deliver(request(),fail,payload);assert.equal(fail.body,payload);await assert.rejects(deliver(request('gzip,identity;q=0'),new Response(),payload),error=>error.status===503);
 const boundary=new Response();await deliverRepresentation(request('gzip,identity;q=0'),boundary,Buffer.alloc(limits.maxInputBytes,65));assert.equal(gunzipSync(boundary.body).length,limits.maxInputBytes);assert.equal(boundary.getHeader('Content-Encoding'),'gzip');
 const throws=createRepresentationDelivery({compress(){throw new Error('TEST_ONLY sync failure');}});await assert.rejects(throws(request('gzip,identity;q=0'),new Response(),payload),error=>error.status===503);
 const excess=createRepresentationDelivery({compress(input,options,done){done(null,Buffer.alloc(limits.maxOutputBytes+1));}});await assert.rejects(excess(request('gzip,identity;q=0'),new Response(),payload),error=>error.status===503);
 const recovered=new Response();await deliverRepresentation(request('gzip,identity;q=0'),recovered,payload);assert.deepEqual(gunzipSync(recovered.body),Buffer.from(payload));
});

test('async completion revalidates authority before headers or data leave the helper',async()=>{
 let complete,valid=true,checks=0;const deliver=createRepresentationDelivery({compress(input,options,done){complete=done;}}),res=new Response();
 const pending=deliver(request(),res,payload,{validate(){checks++;if(!valid)throw Object.assign(new Error('TEST_ONLY revoked'),{status:401});}});
 valid=false;complete(null,Buffer.from('short'));await assert.rejects(pending,error=>error.status===401);assert.equal(checks,2);assert.equal(res.writableEnded,false);assert.equal(res.getHeader('Content-Encoding'),undefined);
});

test('short bounded queue compresses concurrent endpoint bursts and releases disconnected waiters',async()=>{
 const held=[],deliver=createRepresentationDelivery({compress:(input,options,done)=>held.push(done)}),first=new Response(),second=new Response(),third=new Response(),gone=new Response();
 const a=deliver(request(),first,payload),b=deliver(request(),second,payload),c=deliver(request(),third,payload),d=deliver(request(),gone,payload);assert.equal(held.length,2);gone.disconnect();await d;assert.equal(gone.writableEnded,false);
 held[0](null,Buffer.from('compressed'));await a;await Promise.resolve();assert.equal(held.length,3);held[1](null,Buffer.from('compressed'));held[2](null,Buffer.from('compressed'));await Promise.all([b,c]);assert.equal(third.getHeader('Content-Encoding'),'gzip');assert.equal(third.listenerCount('close'),0);
});
test('queued compression has a finite wait and overflow cannot consume unbounded slots',async()=>{
 const held=[],deliver=createRepresentationDelivery({compress:(input,options,done)=>held.push(done),maxWaitMs:15}),responses=Array.from({length:7},()=>new Response()),pending=responses.map(r=>deliver(request(),r,payload));assert.equal(held.length,2);await Promise.all(pending.slice(2));assert.equal(held.length,2);for(const r of responses.slice(2)){assert.equal(r.body,payload);assert.equal(r.listenerCount('close'),0);}held.forEach(done=>done(null,Buffer.from('compressed')));await Promise.all(pending.slice(0,2));
});
