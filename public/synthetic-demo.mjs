// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// Deterministic, pure presentation fixtures. No timers, storage, live clients,
// database writes, notifications, real cursors or collector credentials.
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export function createSyntheticDemo({seed=7,workers=6,now=Date.UTC(2026,9,20,12)}={}){
 if(!Number.isSafeInteger(seed)||seed<0||seed>4294967295||!Number.isSafeInteger(workers)||workers<1||workers>32||!Number.isSafeInteger(now)||now<60000||now>8640000000000000)throw new Error('Invalid synthetic demo bounds');
 let value=seed||1;const random=()=>{value^=value<<13;value^=value>>>17;value^=value<<5;return (value>>>0)/4294967296;};
 const hosts=[{id:'TEST_ONLY_workstation',name:'TEST_ONLY · Workstation',deviceClass:'workstation'},{id:'TEST_ONLY_rack',name:'TEST_ONLY · Rack server',deviceClass:'server'},{id:'TEST_ONLY_edge',name:'TEST_ONLY · Pi edge',deviceClass:'raspberry-pi'}].map(host=>({...host,status:'online',synthetic:true}));
 const sessions=[],events=[],recent=[];let input=0,cached=0,cacheWrite=0,output=0,reasoning=0;
 for(let i=0;i<workers;i++){
  const host=hosts[i%hosts.length],sessionId='TEST_ONLY_worker_'+(i+1),turnId='TEST_ONLY_turn_'+(i+1),source_ms=now-1000*(i+1),tokens=500+Math.floor(random()*4500),reused=Math.floor(tokens*(.2+random()*.6)),generated=40+Math.floor(random()*600),reasoned=Math.floor(generated*random()*.7),write=Math.floor(tokens*random()*.05);
  input+=tokens;cached+=reused;cacheWrite+=write;output+=generated;reasoning+=reasoned;
  sessions.push({id:sessionId,hostId:host.id,project:'TEST_ONLY_demo',nickname:'TEST_ONLY · Worker '+(i+1),state:'Turn started',taskLabel:'TEST_ONLY · Synthetic observation '+(i+1),model:'TEST_ONLY_configured_model',synthetic:true});
  recent.push({host_id:host.id,session_id:sessionId,project:'TEST_ONLY_demo',native_thread_id:sessionId,native_turn_id:turnId,native_response_id:'TEST_ONLY_response_'+(i+1),native_session_id:null,native_root_turn_id:turnId,source_ms,received_ms:source_ms+50,usage_scope:'response',accounting_class:'candidate',source_role:'codex-source',input_tokens:tokens,cached_input_tokens:reused,cache_write_input_tokens:write,output_tokens:generated,reasoning_output_tokens:reasoned,total_tokens:tokens+generated,reported_mask:63,provider_reported_mask:0,synthesized_mask:63});
  const callId='TEST_ONLY_call_'+i;
  events.push({id:callId+'_start',sessionId,hostId:host.id,project:'TEST_ONLY_demo',turnId,callId,at:new Date(source_ms-1000).toISOString(),kind:'tool.start',label:'TEST_ONLY · Synthetic tool',category:i%2?'research':'command',outcome:'observed',synthetic:true},{id:callId+'_end',sessionId,hostId:host.id,project:'TEST_ONLY_demo',turnId,callId,at:new Date(source_ms).toISOString(),kind:'tool.end',label:'TEST_ONLY · Synthetic result',category:i%2?'research':'command',outcome:'recorded',synthetic:true});
 }
 const derived=(n,d)=>({value:d?n/d:null,numerator:n,denominator:d,comparableRows:workers,excludedRows:0,classification:'derived',method:'ratio-of-sums'});
 return freeze({mode:'TEST_ONLY',synthetic:true,label:'TEST_ONLY · SYNTHETIC DEMO — no live work or account usage',integration:{presentationOnly:true,liveIngestion:false,persistCursors:false,notifications:false},snapshot:{mode:'TEST_ONLY',synthetic:true,observedAt:new Date(now).toISOString(),host:hosts[0],hosts,sessions,events,coverage:{synthetic:true,complete:false}},accountUsageResponse:{mode:'TEST_ONLY',synthetic:true,sampleAnalytics:{version:2,scope:{kind:'synthetic-source-observations',from:new Date(now-60000).toISOString(),to:new Date(now).toISOString()},coverage:{retainedRows:workers,matchingRows:workers,returnedRows:workers,truncated:false,excludedRows:0,identityMissing:0,conflictingResponses:0},responses:{status:'available',responseCount:workers,totals:{input,cached,cacheWrite,output,reasoning,total:input+output},ratios:{cacheHit:derived(cached,input),reasoningShare:derived(reasoning,output),newInputFraction:derived(input-cached,input)}},recent}}});
}
