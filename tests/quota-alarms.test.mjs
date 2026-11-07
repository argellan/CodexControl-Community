// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {WeeklyQuotaTracker,weeklyReading,ALARM_DEFAULTS,AlarmAudio,BrowserAlarms,configureAlarmItems} from '../public/quota-alarms.mjs';
import {buildAccountUsageView,renderAccountStrip} from '../public/account-usage.mjs';
import {validatePersonalSettings,captureLayout,applyLayout} from '../public/settings-view-model.mjs';
import {PersonalPreferences} from '../lib/personal-preferences.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const epoch=Date.parse('2026-10-23T15:00:00Z'),key='a'.repeat(64),reset=Math.floor((epoch+604800000)/1000);
const payload=(at,used=3,{accountKey=key,resetsAt=reset,status='available',limitsAt=at}={})=>({observedAt:new Date(at+500).toISOString(),accountUsage:{status,accounts:[{accountKey,status,limitsObservedAt:new Date(limitsAt).toISOString(),usageObservedAt:new Date(at).toISOString(),limits:[{limitId:'codex',primary:{usedPercent:used,windowDurationMins:10080,resetsAt}}]}]}});
const scenario=(tracker,p={},minutes=55)=>{let value;for(let i=0;i<=minutes;i++)value=tracker.observe(payload(epoch+i*60000,3+i*20/55),p,epoch+i*60000);return value;};
test('owner regression: 20 percentage-point loss in 55 minutes crosses a lower configured pp/hour threshold',()=>{
 const q=new WeeklyQuotaTracker(),r=scenario(q,{quotaBurnThreshold:20});
 assert.equal(r.state,'exceeded');assert.ok(Math.abs(r.rate-21.8181818)<.00001);assert.equal(r.sampleCount,56);
 const higher=scenario(new WeeklyQuotaTracker(),{quotaBurnThreshold:22});assert.equal(higher.state,'normal');
});
test('debounce uses distinct source readings; duplicate browser polls never count as new samples',()=>{
 const q=new WeeklyQuotaTracker(),p={quotaBurnThreshold:20};scenario(q,p,48);
 assert.equal(q.result.state,'normal');const duplicate=payload(epoch+48*60000,3+48*20/55);
 for(let i=0;i<5;i++)assert.equal(q.observe(duplicate,p,epoch+48*60000+i*500).state,'normal');
 assert.equal(q.observe(payload(epoch+49*60000,3+49*20/55),p,epoch+49*60000).state,'exceeded');
});
test('reset, account change, source gap, stale, out-of-order and unknown identity cannot fabricate quota burn',()=>{
 for(const change of [
  {resetsAt:reset+604800},{accountKey:'b'.repeat(64)}, {accountKey:null}, {status:'stale'}
 ]){
  const q=new WeeklyQuotaTracker();scenario(q);const r=q.observe(payload(epoch+56*60000,24,change),{},epoch+56*60000);assert.notEqual(r.state,'exceeded');assert.equal(r.rate,null);
 }
 const q=new WeeklyQuotaTracker();scenario(q);
 assert.equal(q.observe(payload(epoch+60*60000,25),{},epoch+60*60000).state,'warming');
 assert.equal(q.observe(payload(epoch+59*60000,26),{},epoch+60*60000).reason,'Out-of-order source sample');
 const old=scenario(new WeeklyQuotaTracker());assert.equal(old.state,'exceeded');
 const stale=new WeeklyQuotaTracker();scenario(stale);assert.equal(stale.current(epoch+58*60000).state,'stale');
 assert.equal(weeklyReading(payload(epoch,2),epoch+604800001).state,'expired');
 assert.equal(weeklyReading(payload(epoch+1000,2),epoch).state,'unknown');
});
test('hysteresis recovers after covered low rates; threshold and lookback changes require new coverage',()=>{
 const q=new WeeklyQuotaTracker(),p={quotaBurnThreshold:15,quotaBurnLookbackMinutes:5};
 for(let i=0;i<=6;i++)q.observe(payload(epoch+i*60000,3+i),p,epoch+i*60000);
 assert.equal(q.result.state,'exceeded');
 for(let i=7;i<=14;i++)q.observe(payload(epoch+i*60000,9),p,epoch+i*60000);
 assert.equal(q.result.state,'normal');
 assert.equal(q.observe(payload(epoch+15*60000,9),{...p,quotaBurnThreshold:10},epoch+15*60000).state,'warming');
});
test('stale quota is primary, 97% remains secondary and network failure overrides cached available section status',()=>{
 const p=payload(epoch,3,{status:'stale'}),view=buildAccountUsageView(p,{now:epoch+3600000});
 assert.match(renderAccountStrip(view),/>Quota stale<\/b>/);assert.match(renderAccountStrip(view),/Last known 97%/);
 const fresh=payload(epoch,23);fresh.accountUsage.accounts[0].limitsStatus='available';
 assert.match(renderAccountStrip(buildAccountUsageView(fresh,{now:epoch,failed:true})),/>Quota stale<\/b>/);
 assert.match(renderAccountStrip(buildAccountUsageView(fresh,{now:epoch})),/>77%<\/b>/);
});
test('alarm preferences validate, round-trip through existing revisioned storage, isolate profiles and stay out of named layouts',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'TEST_ONLY-quota-alarms-'));
 try{
  const a=new PersonalPreferences(dir,'TEST_ONLY-a'),b=new PersonalPreferences(dir,'TEST_ONLY-b');
  const saved=await a.write({quotaBurnThreshold:20,quotaBurnLookbackMinutes:60,alarmAudioEnabled:true,alarmweeklyBurnAudible:true},{revision:0});
  assert.equal((await a.read()).preferences.quotaBurnThreshold,20);assert.equal(saved.revision,1);
  assert.equal((await b.read()).preferences.alarmAudioEnabled,false);
  await assert.rejects(a.write({quotaBurnThreshold:25},{revision:0}),e=>e.status===409);
  assert.throws(()=>validatePersonalSettings({quotaBurnLookbackMinutes:0}));
  assert.throws(()=>validatePersonalSettings({alarmVolume:101}));
  const layout=captureLayout(saved.preferences,{name:'TEST_ONLY layout'});assert.equal(Object.hasOwn(layout.layouts[0].preferences,'alarmAudioEnabled'),false);
  assert.equal(applyLayout({...layout,alarmAudioEnabled:false},layout.activeLayoutId).alarmAudioEnabled,false);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
function fakeAudio(state='running'){
 const calls={tones:0},ctx={state,currentTime:0,destination:{},resume:async()=>{},createOscillator:()=>({frequency:{},connect(){},disconnect(){},start(){calls.tones++;},stop(){}}),createGain:()=>({gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}})};
 return {ctx,calls};
}
test('audio requires gesture, enabled per-condition sound, respects mute/visibility and one shared cooldown; blocked audio stays explicit',async()=>{
 const f=fakeAudio(),audio=new AlarmAudio({createContext:()=>f.ctx,hidden:()=>false}),p={...ALARM_DEFAULTS,alarmAudioEnabled:true,alarmweeklyBurnAudible:true},items=[{kind:'weekly-quota-burn'}];
 assert.equal(audio.notify(items,p,epoch),false);assert.match(audio.status(p),/gesture/);
 await audio.enable(10);assert.equal(f.calls.tones,1);
 assert.equal(audio.notify(items,p,epoch),true);assert.equal(audio.notify(items,p,epoch+1000),false);
 assert.equal(audio.notify(items,{...p,alarmAudioMuted:true},epoch+200000),false);
 assert.equal(audio.notify(items,{...p,alarmweeklyBurnAudible:false},epoch+200000),false);
 assert.equal(audio.notify(items,p,epoch+200000),true);
 const blocked=new AlarmAudio({createContext:()=>fakeAudio('suspended').ctx});await blocked.enable();assert.match(blocked.status(p),/blocked/);assert.equal(blocked.notify(items,p,epoch),false);
 const hidden=new AlarmAudio({createContext:()=>f.ctx,hidden:()=>true});await hidden.enable();assert.equal(hidden.notify(items,p,epoch),false);
});
test('enabled/visual/audible choices are independent and weekly low alert replaces rather than duplicates the prior account alert',()=>{
 const p={...ALARM_DEFAULTS,alarmweeklyBurnVisual:false};
 assert.equal(configureAlarmItems([{kind:'weekly-quota-burn'}],p)[0].visualAlarm,false);
 assert.equal(configureAlarmItems([{kind:'weekly-quota-burn'}],{...p,alarmweeklyBurnEnabled:false}).length,0);
 const b=new BrowserAlarms(),v=payload(epoch,95);b.observeQuota(v,p,epoch);
 const items=b.items({items:[{id:'old',kind:'account-quota-alert',window:'primary',label:'Account allowance codex primary'}],payload:v,preferences:p,now:epoch});
 assert.equal(items.filter(i=>i.kind==='account-quota-alert').length,1);
 const secondary=b.items({items:[{id:'shorter',kind:'account-quota-alert',window:'secondary',label:'Account allowance codex secondary'}],payload:v,preferences:p,now:epoch});assert.ok(secondary.some(i=>i.id==='shorter'),'Independent native windows remain inspectable');
 assert.equal(b.audio.notify([{kind:'weekly-quota-burn'}],{...p,alarmVolume:0},epoch),false);
});


test('configured shorter stale age also demotes the allowance headline and future source time stays unavailable',()=>{
 assert.match(renderAccountStrip(buildAccountUsageView(payload(epoch,23),{now:epoch+100000,quotaStaleSeconds:90})),/>Quota stale<\/b>/);
 assert.match(renderAccountStrip(buildAccountUsageView(payload(epoch+1000,23),{now:epoch})),/>Quota unavailable<\/b>/);
});

test('fresh allowance remains current when the independent token-history section is stale',()=>{
 const p=payload(epoch,23);Object.assign(p.accountUsage.accounts[0],{status:'stale',limitsStatus:'available',usageStatus:'stale',usageObservedAt:new Date(epoch-300000).toISOString()});
 const view=buildAccountUsageView(p,{now:epoch});assert.equal(view.accounts[0].weekly.state,'available');assert.equal(view.accounts[0].usageState,'stale');
});
