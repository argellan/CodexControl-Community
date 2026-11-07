// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readableHandoff} from '../public/handoff-workspace.mjs';
import {prepareHandoff} from '../public/handoff-export.mjs';
import {renderSettingsImpact,sourceDossiers,renderSettingsSection} from '../public/settings-workspace.mjs';
import {createSettingsDraft,DEFAULT_PERSONAL_SETTINGS} from '../public/settings-view-model.mjs';
import {DEFAULT_CONFIGURATION} from '../public/settings-schema.mjs';
import {buildAccountUsageView,renderAccountStrip} from '../public/account-usage.mjs';
test('readable handoff uses only the exact sanitized frozen payload and bounds table pages',async()=>{
 const source=Array.from({length:125},(_,i)=>({id:'private-'+i,hostId:'PRIVATE_HOST',sessionId:'PRIVATE_WORKER',label:'PRIVATE_LABEL',rawOutput:'PRIVATE_OUTPUT',at:new Date(1000+i*1000).toISOString(),kind:'tool.end',category:'command',outcome:'recorded'})),packet=await prepareHandoff({events:source}),before=packet.json;
 const page=readableHandoff(packet),last=readableHandoff(packet,2);assert.equal((page.match(/<tr>/g)||[]).length,51);assert.ok(page.includes(packet.snapshot.observations[0].sourceFingerprint));assert.ok(!page.includes('PRIVATE_'));assert.match(last,/101–125 of 125/);assert.equal(packet.json,before);assert.ok(page.includes('day-level'));
});
test('settings impact distinguishes saved, applied, shared and unobserved state without changing exact values',()=>{
 const state=createSettingsDraft({role:'admin',personal:{...DEFAULT_PERSONAL_SETTINGS,leftWidth:301.234567},personalRevision:4,configuration:structuredClone(DEFAULT_CONFIGURATION),revision:8,capabilities:{personalWrite:true,configurationRead:true,configurationWrite:true}});state.draft.personal.leftWidth=320.123456;
 const html=renderSettingsImpact(state,{personal:state.baseline.personal,requiresRestart:true});assert.match(html,/301.23/);assert.match(html,/320.12/);assert.match(html,/Awaiting managed restart/);assert.match(html,/source acknowledgment not observed/);assert.equal(state.draft.personal.leftWidth,320.123456);const form=renderSettingsSection(state,'layouts',{});assert.ok(!form.includes('value="320.123456"'));assert.equal(state.baseline.personal.leftWidth,301.234567);
});
test('source dossiers do not equate enrollment with authentication, capture, acknowledgment or archival',()=>{
 const viewer=createSettingsDraft({role:'viewer',capabilities:{}}),context={resources:{sources:{data:{sources:[{id:'private-source',label:'<b>source</b>',status:'active',observed:{status:'online'}}]}}}};assert.equal(sourceDossiers(viewer,context),'');const admin=createSettingsDraft({role:'admin',capabilities:{sourcesRead:true}}),html=sourceDossiers(admin,context);assert.ok(html.includes('&lt;b&gt;source&lt;/b&gt;'));assert.match(html,/Successful authentication time not exposed/);assert.match(html,/No event time in this view/);assert.match(html,/Exact-version source coverage not exposed/);
});
test('account failure reason is visible and escaped instead of a warm-up claim',()=>{
 const html=renderAccountStrip(buildAccountUsageView({accountUsage:{status:'unavailable',reason:'Collector executable missing <private>'}}));assert.ok(html.includes('Collector executable missing &lt;private&gt;'));assert.ok(!html.includes('Awaiting account source'));
});
