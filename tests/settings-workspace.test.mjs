// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_PERSONAL_SETTINGS,LAYOUT_KEYS,resetDisplayPreferences,normalizePersonalSettings,validatePersonalSettings,captureLayout,applyLayout,removeLayout,createSettingsDraft,settingsChanges,mergeSettingsDraft,buildSettingsSavePlan,setPath,canUseCapability,searchSettingsFields,setupChecklist} from '../public/settings-view-model.mjs';
import {DEFAULT_CONFIGURATION} from '../public/settings-schema.mjs';
import {SettingsWorkspace,renderSettingsSection} from '../public/settings-workspace.mjs';
const clone=v=>structuredClone(v),caps={personalWrite:true,configurationWrite:true,configurationRead:true,configurationRollback:true,usersRead:true,sourcesRead:true,diagnosticsRead:true,auditRead:true,userManagement:true,sourceEnrollment:true,backup:true};
const response=(extra={})=>({personal:clone(DEFAULT_PERSONAL_SETTINGS),personalRevision:7,configuration:clone(DEFAULT_CONFIGURATION),revision:12,role:'admin',capabilities:caps,...extra});
const draft=extra=>createSettingsDraft(response(extra));

test('migration preserves exact fractional divider positions in strict and normalizing paths',()=>{
 const legacy={rightWidth:431.60009765625,leftWidth:399.70001220703125,waterfallRatio:62.13048491019795,fleetHeight:232.60000610351563};
 for(const p of [normalizePersonalSettings(legacy),validatePersonalSettings(legacy)])for(const [key,value] of Object.entries(legacy))assert.equal(p[key],value);
 assert.equal(validatePersonalSettings(legacy).fontSize,14);
});
test('strict personal settings reject invalid ranges, unknown fields and coercion instead of silently changing intent',()=>{
 for(const input of [{fontSize:14.5},{fontSize:500},{planeWorkers:300},{clockTimezone:'No/Such_Zone'},{motionMode:'invented'},{hostFilter:'secret'},{fontSize:'16'}])assert.throws(()=>validatePersonalSettings(input),e=>e.status===400&&e.errors.length>0);
 assert.equal(normalizePersonalSettings({fontSize:500}).fontSize,14);assert.equal(validatePersonalSettings({clockTimezone:'America/New_York'}).clockTimezone,'America/New_York');
});
test('palette overrides accept only known event categories and six-digit colors',()=>{
 assert.deepEqual(validatePersonalSettings({planeColors:{command:'#AABBCC'}}).planeColors,{command:'#aabbcc'});
 for(const planeColors of [{unknown:'#123456'},{error:'url(javascript:bad)'},{tool:'#123'}])assert.throws(()=>validatePersonalSettings({planeColors}));
});
test('token palette defaults migrate older profiles and persist in named layouts without changing event colors',()=>{
 const old={fontSize:16,waterfallRatio:62.13048491019795,planeColors:{command:'#aabbcc'}};
 assert.equal(normalizePersonalSettings(old).tokenPalette,'semantic');assert.equal(validatePersonalSettings(old).tokenPalette,'semantic');
 assert.equal(validatePersonalSettings({tokenPalette:'coins'}).tokenPalette,'coins');assert.throws(()=>validatePersonalSettings({tokenPalette:'unknown'}),e=>e.status===400);assert.equal(normalizePersonalSettings({tokenPalette:'unknown'}).tokenPalette,'semantic');
 const saved=captureLayout({...DEFAULT_PERSONAL_SETTINGS,...old,tokenPalette:'coins'},{id:'coins',name:'Original token colors',now:'2026-10-20T12:00:00Z'}),restored=applyLayout({...saved,tokenPalette:'semantic'},'coins');
 assert.equal(restored.tokenPalette,'coins');assert.equal(restored.waterfallRatio,old.waterfallRatio);assert.deepEqual(restored.planeColors,old.planeColors);
 const state=draft({personal:{...DEFAULT_PERSONAL_SETTINGS,tokenPalette:'coins'}}),html=renderSettingsSection(state,'plane',{errors:[],personal:[],configuration:[]});
 assert.match(html,/Token colors/);assert.match(html,/value="coins" selected/);assert.match(html,/blue \/ violet \/ teal/);assert.match(html,/I = new input \(solid\)/);assert.match(html,/not money/);
});
test('quieted alerts are bounded presentation metadata and never become part of a named layout',()=>{
 const until=new Date(Date.now()+15*60000).toISOString(),acknowledgedAlerts=[{id:'record:123',until}],personal=validatePersonalSettings({acknowledgedAlerts});
 assert.deepEqual(personal.acknowledgedAlerts,acknowledgedAlerts);
 const saved=captureLayout(personal,{id:'quiet-layout',name:'Quiet layout'});assert.ok(!Object.hasOwn(saved.layouts[0].preferences,'acknowledgedAlerts'));
 const html=renderSettingsSection(draft({personal}),'alerts');assert.ok(html.includes('1 currently quieted'));assert.ok(html.includes('never an approval'));
 for(const invalid of [[{id:'x',until:'not-a-date'}],[{id:'x',until:new Date(Date.now()+48*3600000).toISOString()}],[{id:'x'.repeat(241),until}],Array.from({length:65},(_,i)=>({id:String(i),until}))])assert.throws(()=>validatePersonalSettings({acknowledgedAlerts:invalid}));
});
test('named layouts capture presentation, apply atomically to a draft and never contain session filters or recursive layouts',()=>{
 const now='2026-10-20T12:00:00Z',saved=captureLayout({...DEFAULT_PERSONAL_SETTINGS,fontSize:19,leftWidth:240},{id:'wall',name:'Wall display',now});
 assert.equal(saved.layouts.length,1);assert.equal(saved.activeLayoutId,'wall');assert.ok(!Object.hasOwn(saved.layouts[0].preferences,'layouts'));assert.ok(!Object.hasOwn(saved.layouts[0].preferences,'activeLayoutId'));
 const applied=applyLayout({...saved,fontSize:14,leftWidth:420},'wall');assert.equal(applied.fontSize,19);assert.equal(applied.leftWidth,240);
 assert.equal(removeLayout(applied,'wall').activeLayoutId,null);
 assert.throws(()=>validatePersonalSettings({...saved,layouts:[{...saved.layouts[0],preferences:{hostFilter:'private'}}]}));
});
test('layout limits and unique names are validated before replacing saved state',()=>{
 let p=clone(DEFAULT_PERSONAL_SETTINGS);for(let i=0;i<8;i++)p=captureLayout(p,{id:'layout'+i,name:'View '+i,now:'2026-10-20T12:00:00Z'});
 assert.throws(()=>captureLayout(p,{id:'ninth',name:'Ninth'}));assert.throws(()=>captureLayout(p,{id:'other',name:'View 0'}));assert.equal(p.layouts.length,8);
});
test('three-way recovery merges disjoint hub changes and surfaces only actual conflicts',()=>{
 const s=draft();s.draft.personal.fontSize=18;s.draft.configuration.general.instanceName='My instance';
 const remote=response();remote.personal.theme='light';remote.personalRevision=8;remote.configuration.alerts.minimumSeverity='critical';remote.revision=13;
 const merged=mergeSettingsDraft(s,remote);assert.equal(merged.conflicts.length,0);assert.equal(merged.draft.personal.fontSize,18);assert.equal(merged.draft.personal.theme,'light');assert.equal(merged.draft.configuration.general.instanceName,'My instance');assert.equal(merged.draft.configuration.alerts.minimumSeverity,'critical');assert.equal(merged.personalRevision,8);
 remote.personal.fontSize=20;const conflict=mergeSettingsDraft(s,remote);assert.deepEqual(conflict.conflicts.map(c=>c.scope+'.'+c.path),['personal.fontSize']);assert.throws(()=>buildSettingsSavePlan(conflict));
});
test('a role downgrade scrubs private configuration even when cached or included by mistake',()=>{
 const s=draft();s.draft.configuration.general.organization='Private';const viewer=mergeSettingsDraft(s,response({role:'viewer',configuration:{secretPath:'C:/PRIVATE'}}));assert.equal(viewer.draft.configuration,null);assert.equal(viewer.baseline.configuration,null);
});
test('save plans preserve separate revisions and require exact write capabilities',()=>{
 const s=draft();s.draft.personal.fontSize=17;s.draft.configuration.general.instanceName='New label';const plan=buildSettingsSavePlan(s);assert.deepEqual(plan.map(p=>[p.path,p.body.revision]),[['/api/settings/personal',7],['/api/admin/config',12]]);
 s.role='viewer';assert.equal(canUseCapability(s,'configurationWrite'),false);assert.throws(()=>buildSettingsSavePlan(s));assert.throws(()=>setPath({},'__proto__.polluted',true));
});
test('settings search matches meaningful descriptions and requires every query word',()=>{
 assert.ok(searchSettingsFields('clock').length>=4);assert.equal(searchSettingsFields('worker limit')[0].key,'planeWorkers');assert.equal(searchSettingsFields('font nonexistent').length,0);
 assert.equal(searchSettingsFields('dark')[0].key,'theme');
});
test('setup checklist uses actual event evidence instead of online host status and keeps unknown private state explicit',()=>{
 const online={hosts:[{id:'pi',status:'online',role:'execution-target'}],events:[]};
 const viewer=draft({role:'viewer',capabilities:{personalWrite:true}}),waiting=setupChecklist(viewer,{snapshot:online});
 assert.equal(waiting.find(c=>c.id==='records').state,'waiting');assert.equal(waiting.find(c=>c.id==='origin').state,'unknown');assert.equal(waiting.find(c=>c.id==='administrator').state,'waiting');
 const observed=setupChecklist(draft(),{snapshot:{...online,history:{retainedEvents:27}},sources:{sources:[{id:'collector',enabled:true}]}});
 assert.equal(observed.find(c=>c.id==='records').state,'ready');assert.match(observed.find(c=>c.id==='records').detail,/27 retained/);assert.equal(observed.find(c=>c.id==='source').state,'ready');assert.equal(observed.find(c=>c.id==='history').state,'ready');
 const revoked=setupChecklist(draft(),{snapshot:online,sources:{sources:[{id:'collector',revokedAt:'2026-10-20T12:00:00Z'}]}});assert.equal(revoked.find(c=>c.id==='source').state,'waiting');
});
test('viewer render never exposes admin paths or configuration values',()=>{
 const s=createSettingsDraft(response({role:'viewer',configuration:{sources:[{path:'C:/TOP-SECRET'}]},capabilities:{personalWrite:true}}));const html=renderSettingsSection(s,'sources',{resources:{sources:{data:{sources:[{path:'C:/TOP-SECRET'}]}}}});assert.ok(!html.includes('TOP-SECRET'));assert.ok(html.includes('Administrator'));assert.ok(!html.includes('data-add-row'));
});
test('source inventory keeps credential validity separate from observed collector connectivity',()=>{
 const html=renderSettingsSection(draft(),'sources',{resources:{sources:{data:{revision:4,sources:[{id:'pi-source',label:'Enrolled Pi',role:'codex-source',status:'active',observed:{name:'Observed Pi',status:'disconnected'}},{id:'unseen',label:'No observations',role:'execution-target',status:'active'}]}}}});
 assert.match(html,/<th scope="col">Collection<\/th><th scope="col">Credential<\/th>/);assert.match(html,/<td>pi-source<\/td><td>Observed Pi<\/td><td>codex-source<\/td><td>disconnected<\/td><td>active<\/td>/);assert.match(html,/<td>unseen<\/td><td>No observations<\/td><td>execution-target<\/td><td>not observed<\/td><td>active<\/td>/);assert.ok(!html.includes('<td>online</td>'));
});
test('form render binds labels, validation descriptions and explicit disabled operational capabilities',()=>{
 const s=draft(),html=renderSettingsSection(s,'appearance',{errors:[{path:'personal.fontSize',message:'Use 12–20.'}]});assert.ok(html.includes('for="cfg-personal-fontSize"'));assert.ok(html.includes('aria-describedby="cfg-personal-fontSize-help cfg-personal-fontSize-error"'));assert.ok(html.includes('aria-invalid="true"'));assert.ok(html.includes('Use 12–20.'));
 const viewer=draft({role:'viewer',capabilities:{personalWrite:true}});const maintenance=renderSettingsSection(viewer,'maintenance');assert.match(maintenance,/data-action="rollback" disabled/);assert.ok(maintenance.includes('UNAVAILABLE'));assert.ok(!maintenance.includes('data-action="restart"'));
});
test('runtime installation role is read-only without a dedicated role-change capability',()=>{
 const s=draft(),html=renderSettingsSection(s,'general');
 const field=html.match(/<select[^>]*id="cfg-configuration-general-installationRole"[^>]*>/)?.[0];assert.ok(field);assert.match(field,/disabled/);assert.match(field,/data-writable="false"/);assert.match(html,/Dedicated setup is required to change this runtime role/i);
 s.capabilities.installationRole=true;const enabled=renderSettingsSection(s,'general').match(/<select[^>]*id="cfg-configuration-general-installationRole"[^>]*>/)?.[0];assert.ok(!enabled.includes('disabled'));assert.match(enabled,/data-writable="true"/);
});
test('admin collection rows have distinct paths and escaped host labels',()=>{
 const s=draft();s.draft.configuration.fleet.hosts=[{id:'a',label:'<img src=x onerror=alert(1)>',deviceClass:'laptop',alternateAddresses:[]},{id:'b',label:'Second',deviceClass:'edge',alternateAddresses:[]}];const html=renderSettingsSection(s,'fleet');assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img src=x'));assert.ok(html.includes('cfg-configuration-fleet-hosts-0-id'));assert.ok(html.includes('cfg-configuration-fleet-hosts-1-id'));
 assert.ok(html.includes('data-value-type="machine-id"'));assert.ok(html.includes('cfg-configuration-fleet-hosts-0-managedSources'));assert.ok(html.includes('empty set disables collection'));assert.ok(html.includes('preserve the collector'));
});
test('history disk budget is labelled as a planning budget rather than a hard filesystem quota',()=>{
 const html=renderSettingsSection(draft(),'history');assert.match(html,/planning and alert budget/i);assert.match(html,/does not impose a filesystem quota/i);assert.match(html,/Database and WAL/i);
});
function workspace(state,request){const w=Object.create(SettingsWorkspace.prototype);Object.assign(w,{state,request,onPersonalChange:()=>{},resources:{},issued:[],render:()=>{},chrome:()=>{},requiresRestart:false});return w;}
test('partial save acknowledges committed personal changes while retaining an admin conflict draft',async()=>{
 const s=draft();s.draft.personal.fontSize=18;s.draft.configuration.general.instanceName='Edited';let calls=0;const w=workspace(s,async()=>{if(++calls===1)return {preferences:clone(s.draft.personal),revision:8};throw Object.assign(new Error('Conflict'),{status:409});});await w.save();assert.equal(w.state.baseline.personal.fontSize,18);assert.equal(w.state.personalRevision,8);assert.equal(w.state.baseline.configuration.general.instanceName,'Codex Control');assert.equal(w.state.draft.configuration.general.instanceName,'Edited');assert.equal(w.conflict,true);assert.match(w.status,/Saved personal/);assert.ok(settingsChanges(w.state).configuration.length>0);
});
test('a viewer apply error cannot turn a confirmed personal save into an unsaved or repeatable mutation',async()=>{
 const s=draft();s.draft.personal.fontSize=18;const w=workspace(s,async()=>({preferences:clone(s.draft.personal),revision:8}));w.onPersonalChange=()=>{throw new Error('Viewer refresh failed');};await w.save();assert.equal(w.state.baseline.personal.fontSize,18);assert.equal(settingsChanges(w.state).personal.length,0);assert.match(w.status,/Saved personal/);
});
test('credential packages are downloaded without storing or rendering their token in workspace state',async()=>{
 const w=workspace(draft(),async()=>({token:'NEVER-IN-DOM',instructions:'private package'}));w.issued=[{downloadId:'D',kind:'viewer',id:'user',downloaded:false}];let downloaded;w.downloadJSON=value=>downloaded=value;await w.adminAction({dataset:{adminAction:'download-credential',id:'D',kind:'viewer'},disabled:false});assert.equal(downloaded.token,'NEVER-IN-DOM');assert.equal(w.issued[0].downloaded,true);assert.ok(!JSON.stringify(w.state).includes('NEVER-IN-DOM'));assert.ok(!JSON.stringify(w.issued).includes('NEVER-IN-DOM'));assert.ok(!w.status.includes('NEVER-IN-DOM'));
});
test('account action sends scoped IDs and its inventory revision without mutating the settings draft',async()=>{
 let sent;const w=workspace(draft(),async(path,options)=>{sent={path,...options};return {revision:4,users:[]};});w.resources.users={data:{revision:3,users:[]}};w.adminDrafts={users:{id:'viewer1',label:'Review',role:'viewer',allHosts:false,allProjects:false,hostsIds:'pi\nlaptop',projectsIds:'Control',rotateKey:false}};w.adminDraftDirty=new Set(['users']);await w.adminAction({dataset:{adminAction:'save-user'},disabled:false});assert.equal(sent.body.revision,3);assert.deepEqual(sent.body.user.hostIds,['pi','laptop']);assert.deepEqual(sent.body.user.projectIds,['Control']);assert.equal(sent.body.user.expiresAt,null);assert.equal(w.adminDraftDirty.size,0);assert.equal(settingsChanges(w.state).personal.length,0);
});
test('staged backup restore uses only the backup inventory revision, never configuration revision',async()=>{
 for(const revision of [5,undefined]){let sent;const w=workspace(draft(),async(path,options)=>{sent={path,...options};return {requiresRestart:true,instructions:'Managed offline recovery'};});w.pendingOperation={kind:'restore-backup',id:'backup1'};w.resources.backups={data:{revision,backups:[]}};w.dialog={querySelector:()=>({disabled:false})};await w.confirmedOperation();assert.equal(sent.path,'/api/admin/backups/backup1/restore');assert.deepEqual(sent.body,revision===undefined?{}:{revision});assert.equal(w.requiresRestart,true);assert.equal(w.pendingOperation,null);}
});

test('system typography defaults preserve explicit saved typeface and layout choices',()=>{
 assert.equal(normalizePersonalSettings({}).font,'system');
 assert.equal(validatePersonalSettings({}).font,'system');
 for(const font of ['jetbrains','consolas','system']){
  assert.equal(normalizePersonalSettings({font}).font,font);
  const saved=captureLayout({...DEFAULT_PERSONAL_SETTINGS,font},{id:'font-choice',name:'Font choice',now:'2026-10-24T05:00:00Z'});
  assert.equal(applyLayout({...saved,font:'system'},'font-choice').font,font);
 }
});

test('display reset shares canonical defaults and preserves named layouts, alarms, quota and quieted alerts',()=>{
 const until=new Date(Date.now()+600000).toISOString(),p=captureLayout({...clone(DEFAULT_PERSONAL_SETTINGS),theme:'dark',font:'consolas',fontSize:19,density:'comfortable',overviewMode:'compact',leftWidth:410,flowView:'curtain',motionMode:'paused',planeColors:{command:'#aabbcc'},quotaBurnThreshold:42,alarmVolume:17,acknowledgedAlerts:[{id:'TEST_ONLY quiet',until}]},{id:'review',name:'TEST_ONLY named review'}),before=clone(p),reset=resetDisplayPreferences(p);
 for(const key of LAYOUT_KEYS)assert.deepEqual(reset[key],DEFAULT_PERSONAL_SETTINGS[key],key);
 for(const key of Object.keys(p).filter(k=>!LAYOUT_KEYS.includes(k)&&k!=='activeLayoutId'))assert.deepEqual(reset[key],p[key],key);
 assert.deepEqual(p,before);assert.deepEqual(reset.layouts,before.layouts);assert.equal(reset.activeLayoutId,null);assert.equal(reset.fontSize,14);assert.equal(reset.flowView,'map');assert.equal(reset.motionMode,'system');
});
test('current appearance workspace exposes a capability-gated reset and exact reset scope disclosure',()=>{
 const html=renderSettingsSection(draft(),'appearance');assert.match(html,/id="settings-reset-display"/);assert.match(html,/data-action="reset-display"/);assert.match(html,/Preferences restored by reset/);assert.match(html,/Named layouts, alarm and quota settings, and quieted alerts are kept/);assert.match(html,/Custom/);assert.match(html,/Discard draft/);
 const readOnly=renderSettingsSection(draft({role:'viewer',capabilities:{personalWrite:false}}),'appearance');assert.match(readOnly,/data-action="reset-display"[^>]*disabled/);
});
test('confirmed display reset changes only personal display draft and saves through existing revision checks',async()=>{
 const p=captureLayout({...clone(DEFAULT_PERSONAL_SETTINGS),fontSize:19,flowView:'curtain',motionMode:'paused',quotaBurnThreshold:42},{id:'keep',name:'TEST_ONLY keep'}),s=draft({personal:p}),calls=[],w=workspace(s,async(path,o)=>{calls.push({path,...clone(o)});return {preferences:clone(o.body.preferences),revision:8};});
 w.adminDrafts={sources:{id:'TEST_ONLY pending enrollment'}};w.issued=[{downloadId:'TEST_ONLY pending package'}];w.sensitiveDrafts=new Map([['users.password','TEST_ONLY secret']]);w.dialog={querySelector:()=>({disabled:false,focus(){}})};const baseline=clone(s.baseline),configuration=clone(s.draft.configuration),resources=clone(w.resources),issued=clone(w.issued),admin=clone(w.adminDrafts);
 w.confirmOperation('reset-display','Confirm reset');assert.deepEqual(s.draft.personal,p);assert.equal(w.cancelConfirmation(),false);assert.deepEqual(s.draft.personal,p);
 w.confirmOperation('reset-display','Confirm reset');await w.confirmedOperation();assert.equal(s.draft.personal.fontSize,14);assert.deepEqual(s.baseline,baseline);assert.deepEqual(s.draft.configuration,configuration);assert.deepEqual(w.resources,resources);assert.deepEqual(w.issued,issued);assert.deepEqual(w.adminDrafts,admin);assert.equal(w.sensitiveDrafts.get('users.password'),'TEST_ONLY secret');assert.equal(calls.length,0);
 await w.save();assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/settings/personal');assert.equal(calls[0].body.revision,7);assert.deepEqual(calls[0].body.preferences.layouts,p.layouts);assert.equal(calls[0].body.preferences.quotaBurnThreshold,42);assert.equal(s.personalRevision,8);assert.equal(settingsChanges(s).personal.length,0);
});
test('display reset remains a discardable draft and a save conflict cannot replace persisted values',async()=>{
 const s=draft({personal:{...clone(DEFAULT_PERSONAL_SETTINGS),fontSize:18}}),w=workspace(s,async()=>{throw Object.assign(new Error('Conflict'),{status:409});});w.dialog={querySelector:()=>({disabled:false,focus(){}})};w.confirmOperation('reset-display','Confirm reset');await w.confirmedOperation();await w.save();assert.equal(s.baseline.personal.fontSize,18);assert.equal(s.draft.personal.fontSize,14);assert.equal(w.conflict,true);
 await w.handleClick({target:{closest:()=>({dataset:{action:'discard'}})}});assert.equal(s.draft.personal.fontSize,18);assert.equal(settingsChanges(s).personal.length,0);
});
test('display reset refuses read-only capability and a stale confirmation after authority changes',async()=>{
 for(const stale of [false,true]){const s=draft({personal:{...clone(DEFAULT_PERSONAL_SETTINGS),fontSize:18}}),w=workspace(s,async()=>{throw Error('No request allowed');});w.dialog={querySelector:()=>({disabled:false,focus(){}})};if(!stale)s.capabilities.personalWrite=false;w.confirmOperation('reset-display','Confirm reset');if(stale)s.capabilities.personalWrite=false;await w.confirmedOperation();assert.equal(s.draft.personal.fontSize,18);assert.equal(s.baseline.personal.fontSize,18);}
});

test('display reset preserves unrelated invalid draft input and configuration/alarm validation feedback',async()=>{
 const input={...clone(DEFAULT_PERSONAL_SETTINGS),fontSize:19,quotaBurnThreshold:'needs review',alarmVolume:'needs review'},reset=resetDisplayPreferences(input);assert.equal(reset.fontSize,14);assert.equal(reset.quotaBurnThreshold,input.quotaBurnThreshold);assert.equal(reset.alarmVolume,input.alarmVolume);
 const s=draft(),w=workspace(s,async()=>{throw Error('Reset cannot write');});s.draft.personal=input;w.errors=[{path:'personal.fontSize',message:'Old display error'},{path:'personal.alarmVolume',message:'Keep alarm error'},{path:'configuration.sources.0.id',message:'Keep enrollment draft error'}];w.dialog={querySelector:()=>({disabled:false,focus(){}})};w.confirmOperation('reset-display','Confirm reset');await w.confirmedOperation();assert.equal(s.draft.personal.quotaBurnThreshold,input.quotaBurnThreshold);assert.deepEqual(w.errors.map(e=>e.path),['personal.alarmVolume','configuration.sources.0.id']);assert.equal(w.validate().some(e=>e.path==='personal.alarmVolume'),true);
});
