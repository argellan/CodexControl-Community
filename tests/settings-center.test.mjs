// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SettingsWorkspace,renderAccountControls,SETTINGS_GROUPS,availableSettingsGroups,renderSettingsSection,settingsTaskMatches,normalizeAuditRows,scopeChoiceModel,mergeAdministrationInventory} from '../public/settings-workspace.mjs';
import {createSettingsDraft,DEFAULT_PERSONAL_SETTINGS} from '../public/settings-view-model.mjs';
import {DEFAULT_CONFIGURATION} from '../public/settings-schema.mjs';
const caps={personalWrite:true,configurationWrite:true,configurationRead:true,usersRead:true,sourcesRead:true,diagnosticsRead:true,auditRead:true,userManagement:true,sourceEnrollment:true,backup:true};
const draft=(extra={})=>createSettingsDraft({personal:structuredClone(DEFAULT_PERSONAL_SETTINGS),personalRevision:3,configuration:structuredClone(DEFAULT_CONFIGURATION),revision:5,viewer:{id:'owner',label:'Owner'},role:'admin',capabilities:caps,...extra});

test('grouped destinations are unique and render supported personal and administration tasks',()=>{
 const ids=SETTINGS_GROUPS.flatMap(g=>g.sections.map(s=>s[0]));assert.equal(new Set(ids).size,ids.length);
 for(const id of ids)assert.ok((renderSettingsSection(draft(),id)+(id==='access'?renderAccountControls(draft()):'')).length>20,id);
 assert.deepEqual(SETTINGS_GROUPS.find(g=>g.label==='Your workspace').sections.map(s=>s[0]),['appearance','layouts','plane','clocks','alerts','privacy']);
 assert.match(renderSettingsSection(draft(),'layouts'),/Named layouts/);
 assert.match(renderSettingsSection(draft(),'general'),/TLS certificate files/);
});
test('task search finds operational destinations and applies every query word locally',()=>{
 for(const [query,id] of [['enroll machine','fleet'],['password','access'],['support bundle','maintenance'],['runtime memory','diagnostics'],['named layout','layouts']])assert.ok(settingsTaskMatches(query).some(t=>t.section===id),query);
 assert.equal(settingsTaskMatches('password nonexistent').length,0);
});
test('audit combines both source streams, sorts by time, preserves actor and paths without mutating input',()=>{
 const data={configuration:[{at:'2026-10-20T01:00:00Z',actor:{id:'cfg-admin'},changedPaths:['general.instanceName']}],administration:[{at:'2026-10-20T02:00:00Z',actor:'user-admin',changedPaths:['users']}]},before=structuredClone(data),rows=normalizeAuditRows(data);
 assert.deepEqual(rows.map(x=>x.stream),['administration','configuration']);assert.equal(rows[0].actor,'user-admin');assert.deepEqual(rows[1].changedPaths,['general.instanceName']);assert.deepEqual(data,before);
 const html=renderSettingsSection(draft(),'audit',{resources:{audit:{data}}});assert.match(html,/cfg-admin/);assert.match(html,/general.instanceName/);assert.match(html,/administration/);
});
test('audit keeps deterministic tie order and escapes rendered source values',()=>{
 const rows=normalizeAuditRows({configuration:[{at:'invalid',actor:'first'},{at:'invalid',actor:'second'}],administration:[{actor:'<script>bad</script>'}]});
 assert.deepEqual(rows.map(r=>r.actor),['<script>bad</script>','first','second']);
 const html=renderSettingsSection(draft(),'audit',{resources:{audit:{data:{administration:rows}}}});assert.ok(!html.includes('<script>bad'));assert.match(html,/&lt;script&gt;/);
});
test('scope choices retain selected identities absent from bounded observations and deduplicate sources',()=>{
 const c={snapshot:{hosts:[{id:'a',name:'Workstation'}],sessions:[{project:'Project A'}]},resources:{sources:{data:{sources:[{id:'a',label:'Registered workstation'},{id:'b',label:'Pi'}]}}}};
 const choices=scopeChoiceModel({hostsIds:'a\nmissing\na'},c);assert.deepEqual(choices.map(x=>x.id),['a','b','missing']);assert.equal(choices.find(x=>x.id==='missing').selected,true);assert.equal(choices.find(x=>x.id==='missing').observed,false);
 assert.deepEqual(scopeChoiceModel({projectsIds:'Old project'},c,'projectsIds').map(x=>x.id),['Project A','Old project']);
});
test('archive metadata absence does not imply healthy or empty custody and policy requires exact receipts',()=>{
 const html=renderSettingsSection(draft(),'history');assert.match(html,/Absence here does not establish a healthy or failed archive/);assert.match(html,/Exact-version receipts/);assert.match(html,/Active SQLite remains on local disk/);
 assert.ok(!html.includes('0 pending'));
});
test('archive summary renders exact root health fields with units and preserves unknowns',()=>{
 const html=renderSettingsSection(draft(),'history',{resources:{diagnostics:{data:{preservation:{archive:{status:'retry',pendingRecords:17,inflightRecords:4,receipts:9,errorCode:'DESTINATION_UNAVAILABLE'},notes:['Captured usage versions only']},storage:{databaseBytes:1048576,walBytes:0,totalBytes:1048576,planningBudgetBytes:2097152}}}}});
 assert.match(html,/Pending record versions/);assert.match(html,/>17</);assert.match(html,/DESTINATION_UNAVAILABLE/);assert.match(html,/1.0 MiB/);assert.match(html,/Not reported/);assert.match(html,/Captured usage versions only/);
});
test('viewer rendering cannot leak cached protected health or audit data',()=>{
 const viewer=draft({role:'viewer',configuration:null,capabilities:{personalWrite:true}}),context={resources:{diagnostics:{data:{runtime:{node:'PRIVATE-CANARY'},preservation:{archive:{status:'PRIVATE-CANARY'}}}},audit:{data:{configuration:[{actor:'PRIVATE-CANARY'}]}}}};
 for(const section of ['history','diagnostics','audit','sources'])assert.ok(!renderSettingsSection(viewer,section,context).includes('PRIVATE-CANARY'),section);
});
test('source checklist distinguishes not loaded, loading, failed and observed enrollment',()=>{
 const base={snapshot:{hosts:[{id:'online',status:'online'}],events:[]}};
 for(const [resource,expected] of [[undefined,/not loaded/i],[{loading:true},/Reading the enrollment inventory/i],[{error:'Fixture offline'},/could not be read/],[{data:{sources:[{id:'enrolled',enabled:true}]}},/registered|enrolled/i]]){
  const html=renderSettingsSection(draft(),'overview',{...base,resources:resource?{sources:resource}:{}});assert.match(html,expected);
 }
});
test('section resources load once on demand rather than creating a new poll on reentry',()=>{
 const calls=[],w=Object.create(SettingsWorkspace.prototype);Object.assign(w,{section:'sources',resources:{},fetchResource:key=>{calls.push(key);w.resources[key]={data:{}};}});w.sectionResource();w.sectionResource();w.section='history';w.sectionResource();assert.deepEqual(calls,['sources','diagnostics']);
});
test('a late protected resource response is discarded after role or identity changes',async()=>{
 let resolve;const w=Object.create(SettingsWorkspace.prototype);Object.assign(w,{state:draft(),resources:{},render:()=>{},isOpen:true,request:()=>new Promise(r=>{resolve=r;})});const pending=w.fetchResource('diagnostics');w.state=draft({role:'viewer',capabilities:{personalWrite:true},viewer:{id:'viewer'}});w.resources={};resolve({runtime:{node:'PRIVATE-CANARY'}});await pending;assert.deepEqual(w.resources,{});
});
test('Control placeholder exposes no simulated operation or misleading configured state',()=>{
 const html=renderSettingsSection(draft(),'control');assert.match(html,/not configured/);assert.match(html,/No operation is initiated here/);assert.ok(!/data-admin-action=|data-action="(?:start|approve|dispatch)/.test(html));
});
test('viewer desktop navigation, mobile choices and task search share personal role boundaries',()=>{
 const viewer=draft({role:'viewer',configuration:null,capabilities:{personalWrite:true,signOut:true}}),groups=availableSettingsGroups(viewer),sections=groups.flatMap(g=>g.sections),ids=sections.map(s=>s[0]);
 assert.deepEqual(ids,['overview','appearance','layouts','plane','clocks','alerts','privacy','access','history']);assert.equal(sections.find(s=>s[0]==='access')[1],'Your account');
 assert.equal(settingsTaskMatches('Create user',viewer).length,0);assert.equal(settingsTaskMatches('runtime memory',viewer).length,0);assert.ok(settingsTaskMatches('password',viewer).some(t=>t.section==='access'));
 assert.ok(settingsTaskMatches('privacy diagnostics',viewer).some(t=>t.section==='privacy'));assert.match(renderSettingsSection(viewer,'privacy'),/Preview browser diagnostics/);assert.doesNotMatch(renderSettingsSection(viewer,'privacy'),/Preview backend diagnostics/);
 assert.ok(!renderSettingsSection(viewer,'overview').includes('Connect a machine'));assert.match(renderSettingsSection(viewer,'access'),/Your account/);
});
test('a rejected protected request cannot repopulate private error text after downgrade',async()=>{
 let reject;const w=Object.create(SettingsWorkspace.prototype);Object.assign(w,{state:draft(),resources:{},render:()=>{},isOpen:true,request:()=>new Promise((_,r)=>{reject=r;})});const pending=w.fetchResource('audit');w.state=draft({role:'viewer',capabilities:{personalWrite:true},viewer:{id:'viewer'}});w.resources={};reject(new Error('PRIVATE-CANARY'));await pending;assert.deepEqual(w.resources,{});
});
test('singular administration mutation responses preserve other inventory rows and advance the shared revision',()=>{
 const previous={revision:4,users:[{id:'owner',role:'admin'},{id:'reviewer',label:'Before'}]},before=structuredClone(previous);
 const next=mergeAdministrationInventory(previous,{revision:5,user:{id:'reviewer',label:'After'}},'users');assert.equal(next.users.length,2);assert.equal(next.users[0].id,'owner');assert.equal(next.users[1].label,'After');assert.equal(next.revision,5);assert.deepEqual(previous,before);
 const enrolled=mergeAdministrationInventory({revision:5,sources:[{id:'old'}]},{revision:6,source:{id:'new'}},'sources');assert.deepEqual(enrolled.sources.map(x=>x.id),['old','new']);
 const revoked=mergeAdministrationInventory({users:[{id:'legacy'},{id:'owner'}]},{revision:7},'users',{removeId:'legacy'});assert.deepEqual(revoked.users.map(x=>x.id),['owner']);
});
test('administration mutations invalidate shared-revision caches and discard their late responses',async()=>{
 let resolve;const w=Object.create(SettingsWorkspace.prototype);Object.assign(w,{state:draft(),resources:{users:{data:{revision:1,users:[{id:'owner'}]}},backups:{data:{revision:1}}},render:()=>{},isOpen:true,request:()=>new Promise(r=>{resolve=r;})});const pending=w.fetchResource('sources');w.rememberAdministrationResult('users',{revision:2,user:{id:'new'}});assert.equal(w.resources.users.data.users.length,2);assert.equal(w.resources.backups,undefined);resolve({revision:1,sources:[{id:'stale'}]});await pending;assert.equal(w.resources.sources,undefined);
});
test('bounded audit rendering explicitly states visible and loaded counts',()=>{
 const data={configuration:Array.from({length:256},(_,i)=>({actor:'cfg-'+i})),administration:[{actor:'admin'}]};const html=renderSettingsSection(draft(),'audit',{resources:{audit:{data}}});assert.match(html,/Showing 256 of 257 returned entries/);assert.equal((html.match(/<tbody>/g)||[]).length,1);
});
