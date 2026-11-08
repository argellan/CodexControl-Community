// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {mountUsageWorkspace} from '../public/usage-workspace.mjs';

function fixture(){
 const handlers=new Map(),elements=new Map(),pending=[];
 const make=id=>({id,value:'',textContent:'',innerHTML:'',open:false,hidden:false,dataset:{},classList:{add(){},remove(){},contains(){return false;}},setAttribute(){},removeAttribute(){},focus(){},scrollIntoView(){}});
 for(const id of ['usage-workspace-title','usage-context','usage-contributors','usage-period','usage-dimension','usage-analysis-status','usage-current-quota','usage-scope','usage-current-burn','usage-provider-windows','usage-chart','usage-groups','usage-records','usage-inspector','usage-interval-select','usage-record-title'])elements.set('#'+id,make(id));
 const root={...make('usage-workspace'),querySelector:selector=>elements.get(selector),querySelectorAll:()=>[],contains:()=>true,addEventListener:(type,fn)=>handlers.set(type,fn),removeEventListener(){}};
 const main=make('main'),nav=make('usage-open'),live=make('live'),document={documentElement:{dataset:{}},getElementById:id=>({'usage-workspace':root,main,'usage-open':nav,live})[id],querySelectorAll:()=>[],addEventListener(){},removeEventListener(){}};
 const location={pathname:'/',search:'',hash:''},history={state:null,pushState(value,_unused,url){this.state=value;location.hash=url.startsWith('#')?url:'';}},media={matches:false,addEventListener(){},removeEventListener(){}};
 const window={location,history,matchMedia:()=>media,addEventListener(){},removeEventListener(){}};
 const request=(url,{signal}={})=>new Promise((resolve,reject)=>pending.push({url,signal,resolve,reject}));
 const workspace=mountUsageWorkspace({document,window,request});
 return {workspace,pending,elements,change:target=>handlers.get('change')({target}),click:action=>handlers.get('click')({target:{dataset:{usageAction:action},closest(){return this;}}})};
}
function report(id){const from='2026-11-06T00:00:00.000Z',to='2026-11-07T00:00:00.000Z';return {sampleAnalytics:{scope:{from,to},coverage:{retainedRows:1,matchingRows:1,returnedRows:1},responses:{records:[{sampleKey:id,hostId:'TEST_ONLY-host',sessionId:'TEST_ONLY-worker',project:id,sourceAt:'2026-11-06T12:00:00.000Z',receivedAt:'2026-11-06T12:00:01.000Z',timeBasis:'source',input:100,cached:20,output:30,reasoning:10,total:130}]}}};}
const settle=async()=>{await Promise.resolve();await Promise.resolve();};

test('newer period wins even if an aborted older request completes late',async()=>{
 const f=fixture();f.workspace.open();assert.equal(f.pending.length,1);assert.match(f.elements.get('#usage-chart').innerHTML,/Loading/);assert.doesNotMatch(f.elements.get('#usage-chart').innerHTML,/No comparable/);const period=f.elements.get('#usage-period');period.value='6h';f.change(period);assert.equal(f.pending.length,2);assert.equal(f.pending[0].signal.aborted,true);
 f.pending[1].resolve(report('NEW'));await settle();assert.match(f.elements.get('#usage-analysis-status').textContent,/Last 6 hours/);assert.match(f.elements.get('#usage-groups').innerHTML,/NEW/);
 f.pending[0].resolve(report('OLD'));await settle();assert.match(f.elements.get('#usage-groups').innerHTML,/NEW/);assert.doesNotMatch(f.elements.get('#usage-groups').innerHTML,/OLD/);f.workspace.destroy();
});

test('a failed initial request shows an error instead of a false empty result',async()=>{
 const f=fixture();f.workspace.open();f.pending[0].reject(new Error('TEST_ONLY disconnected'));await settle();assert.match(f.elements.get('#usage-chart').innerHTML,/could not be loaded/i);assert.doesNotMatch(f.elements.get('#usage-chart').innerHTML,/No comparable/);f.workspace.destroy();
});

test('a connection without the analysis projection is explicitly unavailable',async()=>{
 const f=fixture();f.workspace.open();f.pending[0].resolve({});await settle();assert.match(f.elements.get('#usage-analysis-status').textContent,/unavailable on this connection/i);assert.match(f.elements.get('#usage-chart').innerHTML,/unavailable on this connection/i);f.workspace.destroy();
});

test('refresh failure marks retained evidence stale and invalidation removes it',async()=>{
 const f=fixture();f.workspace.open();f.pending[0].resolve(report('RETAINED'));await settle();f.click('refresh');f.pending[1].reject(new Error('TEST_ONLY disconnected'));await settle();assert.match(f.elements.get('#usage-analysis-status').textContent,/stale/i);assert.match(f.elements.get('#usage-groups').innerHTML,/RETAINED/);
 f.click('refresh');const late=f.pending[2];f.workspace.invalidate();assert.match(f.elements.get('#usage-analysis-status').textContent,/unavailable/i);late.resolve(report('LATE'));await settle();assert.doesNotMatch(f.elements.get('#usage-groups').innerHTML,/LATE|RETAINED/);f.workspace.destroy();
});

test('workspace requests compact response evidence and keeps exact source fields inspectable',async()=>{
 const f=fixture();f.workspace.open();assert.match(f.pending[0].url,/seriesFormat=columns-v1/);
 const payload=report('COMPACT');const row={sampleKey:'sample-1',hostId:'host-1',sessionId:'worker-1',project:'Project λ',sourceId:'source-1',sourceRecordKey:'record-1',sourceOffset:42,sourceKind:'token_usage_record',sourceVersion:'v1',turnId:'turn-1',responseId:'response-1',sourceAt:'2026-11-06T12:00:00.000Z',receivedAt:'2026-11-06T12:00:01.000Z',timeBasis:'source',accountAttribution:'unknown',configuredModel:'model-1',configuredEffort:'high',input:100,cached:20,cacheWrite:null,output:30,reasoning:10,total:130,reportedMask:59,providerReportedMask:59,synthesizedMask:0};
 const columns=Object.keys(row);payload.sampleAnalytics.responses.records={schema:'usage-response-columns-v1',columns,rows:[columns.map(key=>row[key])]};
 f.pending[0].resolve(payload);await settle();assert.match(f.elements.get('#usage-analysis-status').textContent,/1 exact responses/);assert.match(f.elements.get('#usage-groups').innerHTML,/Project λ/);assert.match(f.elements.get('#usage-records').innerHTML,/worker-1/);f.workspace.destroy();
});

test('malformed compact data does not replace an earlier same-scope analysis',async()=>{
 const f=fixture();f.workspace.open();f.pending[0].resolve(report('RETAINED'));await settle();f.click('refresh');
 const invalid=report('INVALID');invalid.sampleAnalytics.responses.records={schema:'usage-response-columns-v1',columns:['sampleKey'],rows:[['forged']]};
 f.pending[1].resolve(invalid);await settle();assert.match(f.elements.get('#usage-analysis-status').textContent,/stale/i);assert.match(f.elements.get('#usage-groups').innerHTML,/RETAINED/);assert.doesNotMatch(f.elements.get('#usage-groups').innerHTML,/INVALID/);f.workspace.destroy();
});
