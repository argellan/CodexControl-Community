// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWorkerSummary,buildUsageSummary} from '../public/worker-model.mjs';
const view=await import('../public/worker-view.mjs').catch(()=>({}));
const now=Date.parse('2026-10-20T08:00:00Z');
const at=n=>new Date(now+n).toISOString();
const host={id:'lenovo',name:'Example workstation',status:'online'};
const worker=(id,extra={})=>({id,hostId:'lenovo',project:'Codex-Control',lastEventAt:at(-1000),...extra});
const quota=(value=25,extra={})=>({limitId:'codex',accountKey:null,observedAt:at(-1000),primary:{usedPercent:value,resetsAt:(now+60000)/1000},...extra});
const summary=sessions=>buildWorkerSummary({sessions,events:[],hosts:[host],sessionId:'parent',hostId:'lenovo',now});

test('worker fragment provides explicit unknown states and never presents missing context or token data as zero',()=>{
 assert.equal(typeof view.renderWorkerDetails,'function');
 const html=view.renderWorkerDetails(summary([worker('parent')]));
 assert.match(html,/Model unavailable/);assert.match(html,/Context unavailable/);assert.match(html,/Token reading unavailable/);assert.doesNotMatch(html,/NaN|Infinity|0%/);
 assert.match(view.renderWorkerDetails(null),/Select a worker/);
});

test('worker identity, relation attributes and labels are escaped and navigation remains host scoped',()=>{
 const html=view.renderWorkerDetails(summary([worker('parent',{nickname:'<script>PRIVATE</script>',model:'"><img src=x onerror=alert(1)>'}),worker('child" onclick="evil',{parentId:'parent',nickname:'<b>child</b>'})]));
 assert.doesNotMatch(html,/<script>|<img|onclick="evil/);assert.match(html,/&lt;script&gt;/);assert.match(html,/data-session="lenovo\/child&quot; onclick=&quot;evil"/);
 assert.match(html,/Explicit subagents/);assert.match(html,/type="button"/);
});

test('observed context is an accessible bounded meter and fork totals are visibly qualified',()=>{
 const html=view.renderWorkerDetails(summary([worker('parent',{forkedFrom:'source',tokens:{total_tokens:90000},lastTokens:{total_tokens:4500},contextWindow:10000,usageObservedAt:at(-1000)})]));
 assert.match(html,/<meter[^>]*value="45"/);assert.match(html,/aria-label="Last reported model context/);assert.match(html,/Inherited fork counter/);assert.match(html,/not subscription billing/);
});

test('unlinked quota sightings are separate evidence and expired readings do not imply a fresh allowance',()=>{
 const usage=buildUsageSummary({sessions:[worker('one',{usageLimits:[quota()]}),worker('two',{usageLimits:[quota(80,{primary:{usedPercent:80,resetsAt:(now-1000)/1000}})]})],hosts:[host],now});
 const html=view.renderUsageDetails(usage);
 assert.equal((html.match(/class="usage-sighting/g)||[]).length,2);assert.match(html,/Account-unlinked/);assert.match(html,/Do not add these allowances/);assert.match(html,/Reset time passed/);assert.match(html,/Subscription billing unavailable/);
 assert.doesNotMatch(html,/\$|NaN|Infinity/);
});

test('usage rendering escapes model and quota labels and bounds source/model rows',()=>{
 const usage=buildUsageSummary({sessions:Array.from({length:100},(_,i)=>worker('w'+i,{model:'<img src=x onerror=evil>'+i,tokens:{total_tokens:i},usageLimits:[quota(10,{limitName:'<script>evil</script>'})]})),hosts:[host],now});
 const html=view.renderUsageDetails(usage);
 assert.doesNotMatch(html,/<img|<script/);assert.match(html,/&lt;script&gt;/);
 assert.equal((html.match(/class="usage-sighting/g)||[]).length,32);assert.match(html,/32 of 100 source readings/);assert.equal((html.match(/class="usage-model-row/g)||[]).length,20);
});

test('linked account reports describe observed account pools and no estimate is turned into a subscription bill',()=>{
 const usage=buildUsageSummary({sessions:[worker('one',{usageLimits:[quota(0,{accountKey:'a'.repeat(64)})]})],hosts:[host],now});
 const html=view.renderUsageDetails(usage);assert.match(html,/Explicit account quota/);assert.match(html,/100% last reported remaining/);assert.match(html,/Subscription billing unavailable/);assert.doesNotMatch(html,/Account-unlinked/);
});

test('host contribution bars carry numeric labels and distinguish missing readings from zero',()=>{
 const usage=buildUsageSummary({sessions:[worker('one',{tokens:{total_tokens:250}}),worker('two',{hostId:'rack',tokens:{total_tokens:750}}),worker('zero',{hostId:'zero',tokens:{total_tokens:0}})],hosts:[host,{id:'rack',name:'Rack server',status:'disconnected'},{id:'zero',name:'Zero source',status:'online'},{id:'missing',name:'Missing source',status:'online'}],now});
 const html=view.renderUsageDetails(usage);
 assert.match(html,/Observed tokens by machine/);assert.match(html,/Rack server/);assert.match(html,/Source disconnected/);assert.match(html,/aria-label="Rack server share of observed session tokens"/);assert.match(html,/<meter[^>]*value="75"/);
 assert.match(html,/0 observed tokens/);assert.match(html,/Token reading unavailable/);assert.match(html,/copied between machines/);assert.doesNotMatch(html,/NaN|Infinity/);
 assert.equal((html.match(/class="usage-host-row/g)||[]).length,4);
});

test('host contribution rendering bounds machine rows and escapes source identity and status',()=>{
 const hosts=Array.from({length:40},(_,i)=>({id:'h'+i,name:'<img src=x onerror=evil>'+i,status:'<script>evil</script>'}));
 const usage=buildUsageSummary({sessions:hosts.map((h,i)=>worker('one',{hostId:h.id,tokens:{total_tokens:i}})),hosts,now});
 const html=view.renderUsageDetails(usage);
 assert.doesNotMatch(html,/<img|<script/);assert.match(html,/&lt;img/);assert.equal((html.match(/class="usage-host-row/g)||[]).length,20);assert.match(html,/Top 20 of 40 machines shown/);
});
