// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// Shared presentation schema and draft logic. No collection or worker state is changed here.
import {ALARM_DEFAULTS,ALARM_FIELDS} from './quota-alarms.mjs';
import {TOKEN_PALETTE_OPTIONS} from './token-palette.mjs';
export const SETTINGS_SECTIONS=Object.freeze([
 {id:'general',label:'General',icon:'◎',description:'Identity, clocks and this viewer'},
 {id:'appearance',label:'Appearance & layouts',icon:'◐',description:'Type, density, panels and saved views'},
 {id:'plane',label:'Observation plane',icon:'⌁',description:'Flow, evidence, grouping and motion'},
 {id:'fleet',label:'Fleet & network',icon:'▤',description:'Machine identity, address preference and network'},
 {id:'sources',label:'Sources & collectors',icon:'⇣',description:'Source profiles and observed collection state'},
 {id:'history',label:'History & storage',icon:'◷',description:'Retention, event limits and disk budgets'},
 {id:'alerts',label:'Alerts',icon:'△',description:'Viewer attention and hub thresholds'},
 {id:'access',label:'Users & access',icon:'♙',description:'Viewer identity and administrative access'},
 {id:'maintenance',label:'Maintenance & about',icon:'⌘',description:'Diagnostics, audit, recovery and release information'}
]);
const field=(key,label,type,section,extra={})=>({key,label,type,section,...extra});
const overviewModes=Object.freeze({
 full:Object.freeze({mode:'full',workers:true,map:true,timeline:true,inspector:true,secondary:true}),
 compact:Object.freeze({mode:'compact',workers:false,map:true,timeline:false,inspector:false,secondary:false}),
 mini:Object.freeze({mode:'mini',workers:false,map:false,timeline:false,inspector:false,secondary:false})
});
export function overviewPresentation(mode='full'){return overviewModes[mode]||overviewModes.full;}
const framePlans=Object.freeze({none:Object.freeze({kind:'none',delayMs:0}),raf:Object.freeze({kind:'raf',delayMs:0}),clock:Object.freeze({kind:'timer',delayMs:50}),slow:Object.freeze({kind:'timer',delayMs:1000})});
export function overviewFramePlan({mode='full',clockMilliseconds=true,mapMoving=false,timelineMoving=false,replayPlaying=false,reduced=false,paused=false,hidden=false}={}){
 if(hidden)return framePlans.none;const view=overviewPresentation(mode);
 if(!paused&&!reduced&&(view.map&&mapMoving||view.timeline&&timelineMoving||view.map&&replayPlaying))return framePlans.raf;
 return view.mode==='full'&&clockMilliseconds?framePlans.clock:framePlans.slow;
}
export const PERSONAL_FIELDS=Object.freeze([
 ...ALARM_FIELDS,
 field('theme','Color theme','select','appearance',{options:['system','dark','light']}),
 field('font','Typeface','select','appearance',{options:['jetbrains','system','consolas']}),
 field('fontSize','Text size','number','appearance',{min:12,max:20,step:1,unit:'px'}),
 field('density','Interface density','select','appearance',{options:['dense','comfortable']}),
 field('overviewMode','Overview mode','select','appearance',{options:['full','compact','mini'],optionLabels:{full:'Full workspace',compact:'Compact map',mini:'Mini usage & attention'},help:'Browser presentation only. Compact hides secondary panels; mini hides map, workers and timeline while collection continues. Full view and workspace tools are available in Settings. Controls in the live workspace apply immediately; fields here are a draft until Save.'}),
 field('leftWidth','Worker panel width','number','appearance',{min:200,max:420,step:10,unit:'px'}),
 field('rightWidth','Details panel width','number','appearance',{min:220,max:460,step:10,unit:'px',retired:true}),
 field('waterfallRatio','Observation plane share','number','appearance',{min:32,max:88,step:1,unit:'%',help:'Default 72%. Choose 32–88% of the observation plane / timeline workspace.'}),
 ...['fleetHeight','inspectorHeight','attentionHeight'].map((key,i)=>field(key,['Fleet pulse height','Inspector height','Attention panel height'][i],'number','appearance',{min:110,max:800,step:1,unit:'px',nullable:true,retired:key!=='inspectorHeight',help:'Empty uses the automatic panel height.'})),
 field('wallMode','Wall display','boolean','general',{help:'Emphasize the observation surface on a dedicated display.'}),
 field('clockMode','Clocks to display','select','general',{options:['both','local','utc']}),
 field('clockTimezone','Local clock time zone','text','general',{help:'Use local for this browser, or an IANA zone such as America/New_York.'}),
 field('clockFormat','Clock format','select','general',{options:['24h','12h']}),
 field('clockMilliseconds','Show clock milliseconds','boolean','general'),
 field('flowView','Starting visualization','select','plane',{options:['map','curtain'],optionLabels:{map:'Observation plane',curtain:'Ribbon'}}),
 field('motionMode','Motion preference','select','plane',{options:['system','reduced','paused'],help:'System follows the device preference. Reduced and paused suppress moving event markers.'}),
 field('vivid','Event glow and trails','boolean','plane',{help:'Glow follows real new records. It does not generate activity.'}),
 field('tokenPalette','Token colors','select','plane',{options:Object.keys(TOKEN_PALETTE_OPTIONS),optionLabels:TOKEN_PALETTE_OPTIONS,help:'Shared across token meters, tables and model-usage routes. I = new input (solid), O = output (dashed), C = cached input (dotted). Tokens are observed batches, not money.'}),
 field('planeWorkers','Worker context limit','select','plane',{options:[6,8],numeric:true,help:'Recent and focused workers first; retained context fills the remaining slots.'}),
 field('planeChannels','Channels per worker','select','plane',{options:[1,2,3],numeric:true}),
 field('planeGrouping','Group the plane by','select','plane',{options:['worker','host','project']}),
 field('planeDensity','Show linked-record density','boolean','plane'),
 field('planeLabels','Evidence labels','select','plane',{options:['compact','detailed'],help:'Compact omits the activity/status line. Detailed shows it at close zoom or when a station is hovered, keyboard-focused or selected. Names and role/project remain available; the inspector keeps full evidence in either mode.'}),
 field('planeBranches','Show explicit parent branches','boolean','plane',{help:'Branches require captured parent metadata.'}),
 field('planeHosts','Show fleet source rail','boolean','plane'),
 field('planeTools','Show tool endpoint rail','boolean','plane'),
 field('tickerMotion','Rotate and scroll ticker','boolean','alerts'),
 field('alertTicker','Show attention ticker','boolean','alerts'),
 field('alertGlow','Highlight attention requiring review','boolean','alerts',{help:'Visual attention only; no worker action or automatic approval.'})
]);
export const DEFAULT_PLANE_COLORS=Object.freeze({remote:'#7cff4d',command:'#20cfff',edit:'#ff9b18',research:'#00f5c8',agent:'#c675ff',tool:'#5cecff',turn:'#ff59ce',complete:'#78ff9b',message:'#a18bff',approval:'#ffdb27',resolution:'#78ff9b',error:'#ff3b64'});
export const DEFAULT_PERSONAL_SETTINGS=Object.freeze({...ALARM_DEFAULTS,theme:'system',font:'system',fontSize:14,density:'dense',overviewMode:'full',leftWidth:260,rightWidth:290,waterfallRatio:72,fleetHeight:null,inspectorHeight:null,attentionHeight:null,wallMode:false,clockMode:'both',clockTimezone:'local',clockFormat:'24h',clockMilliseconds:true,flowView:'map',motionMode:'system',vivid:true,tokenPalette:'semantic',planeWorkers:6,planeChannels:3,planeGrouping:'worker',planeDensity:true,planeLabels:'detailed',planeBranches:true,planeHosts:true,planeTools:true,planeColors:{},tickerMotion:true,alertTicker:true,alertGlow:true,acknowledgedAlerts:[],layouts:[],activeLayoutId:null});
export const PERSONAL_KEYS=Object.freeze(Object.keys(DEFAULT_PERSONAL_SETTINGS));
export const LAYOUT_KEYS=Object.freeze(PERSONAL_KEYS.filter(k=>!['layouts','activeLayoutId','acknowledgedAlerts'].includes(k)&&!k.startsWith('alarm')&&!k.startsWith('quota')));
const clone=v=>v===undefined?undefined:structuredClone(v);
export function sameValue(a,b){return JSON.stringify(a)===JSON.stringify(b);}
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const invalid=(errors,path,message)=>errors.push({path,message});
function normalize(input,strict,scope='personal',layout=false){
 const errors=[],v=plain(input)?input:{};if(!plain(input)&&input!==undefined)invalid(errors,scope,'Must be an object.');
 const allowed=layout?LAYOUT_KEYS:PERSONAL_KEYS;
 for(const key of Object.keys(v))if(!allowed.includes(key))invalid(errors,scope+'.'+key,'Unknown presentation setting.');
 const out=layout?{}:clone(DEFAULT_PERSONAL_SETTINGS);
 for(const f of PERSONAL_FIELDS){if(!Object.hasOwn(v,f.key))continue;let value=v[f.key],valid;
  if(f.type==='boolean')valid=typeof value==='boolean';
  else if(f.type==='select')valid=f.options.includes(value);
  else if(f.type==='number')valid=value===null&&f.nullable||typeof value==='number'&&Number.isFinite(value)&&value>=f.min&&value<=f.max&&(f.key!=='fontSize'||Number.isInteger(value));
  else if(f.key==='clockTimezone'){valid=typeof value==='string'&&value.length<=100;if(valid&&value!=='local'){try{new Intl.DateTimeFormat('en',{timeZone:value});}catch{valid=false;}}}
  else valid=typeof value==='string'&&value.length<=200;
  if(valid)out[f.key]=value;else invalid(errors,scope+'.'+f.key,f.key==='clockTimezone'?'Use local or a valid IANA time zone.':f.type==='number'?`Use ${f.min}–${f.max}${f.nullable?', or leave empty':''}.`:'Choose a supported value.');
 }
 if(Object.hasOwn(v,'planeColors')){if(!plain(v.planeColors))invalid(errors,scope+'.planeColors','Must be a category color object.');else{out.planeColors={};for(const [key,value] of Object.entries(v.planeColors)){if(Object.hasOwn(DEFAULT_PLANE_COLORS,key)&&typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value))out.planeColors[key]=value.toLowerCase();else invalid(errors,scope+'.planeColors.'+key,'Choose a known category and a six-digit hexadecimal color.');}}}
 if(!layout){
  if(Object.hasOwn(v,'acknowledgedAlerts')){if(!Array.isArray(v.acknowledgedAlerts)||v.acknowledgedAlerts.length>64)invalid(errors,scope+'.acknowledgedAlerts','Up to 64 quieted alerts are supported.');else{out.acknowledgedAlerts=[];const seen=new Set();for(const [i,a] of v.acknowledgedAlerts.entries()){const path=scope+'.acknowledgedAlerts.'+i,time=Date.parse(a?.until);if(!plain(a)||Object.keys(a).some(k=>!['id','until'].includes(k))||typeof a.id!=='string'||!a.id.length||a.id.length>240||seen.has(a.id)||typeof a.until!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(a.until)||!Number.isFinite(time)||time<0||time>Date.now()+86400000){invalid(errors,path,'Use a unique alert ID and an ISO expiry no more than 24 hours ahead.');continue;}seen.add(a.id);out.acknowledgedAlerts.push({id:a.id,until:new Date(time).toISOString()});}}}
  if(Object.hasOwn(v,'layouts')){if(!Array.isArray(v.layouts)||v.layouts.length>8)invalid(errors,scope+'.layouts','Up to eight named layouts are supported.');else{out.layouts=[];const ids=new Set(),names=new Set();for(const [i,saved] of v.layouts.entries()){
   const path=scope+'.layouts.'+i;if(!plain(saved)){invalid(errors,path,'Must be a layout object.');continue;}
   for(const key of Object.keys(saved))if(!['id','name','createdAt','updatedAt','preferences'].includes(key))invalid(errors,path+'.'+key,'Unknown layout field.');
   if(typeof saved.id!=='string'||!/^[a-z0-9_-]{1,100}$/i.test(saved.id)||ids.has(saved.id)){invalid(errors,path+'.id','Use a unique layout identity.');continue;}
   if(typeof saved.name!=='string'||!saved.name.trim()||saved.name.trim().length>48||names.has(saved.name.trim().toLowerCase())){invalid(errors,path+'.name','Use a unique name of 1–48 characters.');continue;}
   if(!['createdAt','updatedAt'].every(key=>typeof saved[key]==='string'&&Number.isFinite(Date.parse(saved[key])))){invalid(errors,path,'Layout timestamps must be valid dates.');continue;}
   const nested=normalize(saved.preferences,true,path+'.preferences',true);errors.push(...nested.errors);ids.add(saved.id);names.add(saved.name.trim().toLowerCase());out.layouts.push({id:saved.id,name:saved.name.trim(),createdAt:saved.createdAt,updatedAt:saved.updatedAt,preferences:nested.value});
  }}}
  if(Object.hasOwn(v,'activeLayoutId')){if(v.activeLayoutId===null||typeof v.activeLayoutId==='string'&&out.layouts.some(l=>l.id===v.activeLayoutId))out.activeLayoutId=v.activeLayoutId;else invalid(errors,scope+'.activeLayoutId','Choose an existing named layout.');}
 }
 return {value:out,errors};
}
export function normalizePersonalSettings(input,options={}){const result=normalize(input,Boolean(options.strict));if(options.strict&&result.errors.length){const error=new Error('Presentation settings are invalid.');error.status=400;error.errors=result.errors;throw error;}return result.value;}
export const validatePersonalSettings=input=>normalizePersonalSettings(input,{strict:true});
export const personalValidationErrors=input=>normalize(input,true).errors;
export function captureLayout(preferences,{id,name,now=new Date().toISOString()}={}){const normalized=validatePersonalSettings(preferences),existing=normalized.layouts.find(l=>l.id===id);const layout={id:id||'layout-'+crypto.randomUUID(),name:String(name||'').trim(),createdAt:existing?.createdAt||now,updatedAt:now,preferences:Object.fromEntries(LAYOUT_KEYS.map(key=>[key,clone(normalized[key])]))};const layouts=existing?normalized.layouts.map(l=>l.id===layout.id?layout:l):[...normalized.layouts,layout];return validatePersonalSettings({...normalized,layouts,activeLayoutId:layout.id});}
// Restore the existing shared display defaults without deleting saved layouts or alarm state.
export function resetDisplayPreferences(input){return {...clone(input),...Object.fromEntries(LAYOUT_KEYS.map(key=>[key,clone(DEFAULT_PERSONAL_SETTINGS[key])])),activeLayoutId:null};}
export function applyLayout(preferences,id){const normalized=validatePersonalSettings(preferences),layout=normalized.layouts.find(l=>l.id===id);if(!layout)throw new Error('That named layout is unavailable.');return validatePersonalSettings({...normalized,...layout.preferences,activeLayoutId:id});}
export function removeLayout(preferences,id){const normalized=validatePersonalSettings(preferences);return {...normalized,layouts:normalized.layouts.filter(l=>l.id!==id),activeLayoutId:normalized.activeLayoutId===id?null:normalized.activeLayoutId};}
export function canUseCapability(state,key){return state?.capabilities?.[key]===true&&(!['configurationWrite','configurationRollback','userManagement','passwordAccounts','sourceEnrollment','backup'].includes(key)||state.role==='admin');}
export function validateNewPassword(password,confirmation){if(typeof password!=='string'||[...password].length<12||[...password].length>128||new TextEncoder().encode(password).length>512)throw new Error('Use a password of 12–128 characters. Spaces and case are preserved.');if(password!==confirmation)throw new Error('The new password and confirmation must match.');return password;}
export function buildAccountUser(draft={}, {password='',passwordConfirmation='',viewerId}={}){
 const scope=key=>draft['all'+key]===false?String(draft[key.toLowerCase()+'Ids']||'').split(/\r?\n/).map(value=>value.trim()).filter(Boolean):null;
 const user={id:draft.id||'',label:draft.label||'',role:draft.role||'viewer',hostIds:scope('Hosts'),projectIds:scope('Projects'),expiresAt:draft.expiresAt?new Date(draft.expiresAt).toISOString():null,...(draft.rotateKey?{rotateKey:true}:{})};
 const username=typeof draft.username==='string'?draft.username.trim().toLowerCase():'';
 if(draft.removePassword){if(user.id===viewerId)throw new Error('Use your current password to change your own password.');user.username=null;}
 else if(username){if(!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username))throw new Error('Use a username of 3–64 letters, numbers, periods, underscores or hyphens.');user.username=username;}
 else if(draft.passwordEnabled)throw new Error('Keep a username, or explicitly disable password sign-in.');
 if(password||passwordConfirmation){if(!user.username)throw new Error('Set a username before assigning a password.');if(user.id===viewerId&&draft.passwordEnabled)throw new Error('Use your current password to change your own password.');user.password=validateNewPassword(password,passwordConfirmation);}
 return user;
}
export function getPath(value,path){return String(path).split('.').reduce((current,key)=>current?.[key],value);}
export function setPath(value,path,next){if(path==='')return clone(next);const parts=String(path).split('.');if(parts.some(p=>['__proto__','prototype','constructor'].includes(p)))throw new Error('Invalid settings path.');const out=clone(value)||{};let cursor=out;for(const part of parts.slice(0,-1)){if(!plain(cursor[part]))cursor[part]={};cursor=cursor[part];}cursor[parts.at(-1)]=clone(next);return out;}
export function changedPaths(base,draft,prefix=''){if(sameValue(base,draft))return [];if(plain(base)&&plain(draft)){return [...new Set([...Object.keys(base),...Object.keys(draft)])].flatMap(key=>changedPaths(base[key],draft[key],prefix?prefix+'.'+key:key));}return [prefix];}
export function createSettingsDraft(response,personalFallback={}){const personal=normalizePersonalSettings(response?.personal??personalFallback);const configuration=response?.role==='admin'?clone(response.configuration??null):null,identity=response?.viewer||{},viewer={id:typeof identity.id==='string'?identity.id:null,label:typeof identity.label==='string'?identity.label:null,username:typeof identity.username==='string'?identity.username:null,passwordEnabled:identity.passwordEnabled===true};return {role:response?.role||'viewer',viewer,capabilities:clone(response?.capabilities||{}),personalRevision:response?.personalRevision??null,revision:response?.revision??null,baseline:{personal:clone(personal),configuration:clone(configuration)},draft:{personal:clone(personal),configuration:clone(configuration)},conflicts:[]};}
export function settingsChanges(state){return {personal:changedPaths(state.baseline.personal,state.draft.personal),configuration:changedPaths(state.baseline.configuration,state.draft.configuration)};}
export function mergeSettingsDraft(state,response){const remote=createSettingsDraft(response,state.draft.personal),conflicts=[];
 const merge=(base,local,hub,scope,path='')=>{if(sameValue(local,base))return clone(hub);if(sameValue(hub,base)||sameValue(hub,local))return clone(local);if(plain(base)&&plain(local)&&plain(hub)){const out={};for(const key of new Set([...Object.keys(base),...Object.keys(local),...Object.keys(hub)]))out[key]=merge(base[key],local[key],hub[key],scope,path?path+'.'+key:key);return out;}conflicts.push({scope,path,local:clone(local),remote:clone(hub),baseline:clone(base)});return clone(local);};
 remote.draft.personal=merge(state.baseline.personal,state.draft.personal,remote.baseline.personal,'personal');
 remote.draft.configuration=remote.role==='admin'?merge(state.baseline.configuration,state.draft.configuration,remote.baseline.configuration,'configuration'):null;remote.conflicts=conflicts;return remote;
}
export function searchSettingsFields(query,fields=PERSONAL_FIELDS){const words=String(query||'').trim().toLowerCase().split(/\s+/).filter(Boolean);return fields.filter(f=>words.every(word=>(f.label+' '+(f.help||'')+' '+f.key+' '+f.section+' '+(f.options||[]).join(' ')+' '+Object.values(f.optionLabels||{}).join(' ')).toLowerCase().includes(word)));}
export function buildSettingsSavePlan(state){if(state.conflicts?.length)throw new Error('Resolve concurrent changes before saving.');const changes=settingsChanges(state),plan=[];if(changes.personal.length){if(!canUseCapability(state,'personalWrite'))throw new Error('Personal settings are read-only.');plan.push({scope:'personal',path:'/api/settings/personal',method:'PUT',body:{revision:state.personalRevision,preferences:validatePersonalSettings(state.draft.personal)}});}if(changes.configuration.length){if(!canUseCapability(state,'configurationWrite'))throw new Error('Administrator configuration permission is required.');plan.push({scope:'configuration',path:'/api/admin/config',method:'PUT',body:{revision:state.revision,configuration:clone(state.draft.configuration)}});}return plan;}
export function setupChecklist(state,{snapshot=null,sources=null}={}){
 const configuration=state.baseline?.configuration,role=configuration?.general?.installationRole||snapshot?.application?.installationRole;
 const admin=state.role==='admin',network=configuration?.networking,origin=network?.publicOrigin;
 let originReady=false;if(network){try{const url=new URL(origin);originReady=url.protocol==='https:'&&network.expectedTls===true||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&['127.0.0.1','::1','localhost'].includes(network.listen);}catch{originReady=!origin&&['127.0.0.1','::1','localhost'].includes(network.listen);}}
 const registered=Array.isArray(sources)?sources:Array.isArray(sources?.sources)?sources.sources:[],enrolled=registered.some(s=>s.revoked!==true&&!s.revokedAt&&s.enabled!==false&&s.status!=='revoked'&&s.status!=='expired'&&s.disabled!==true),native=Boolean(snapshot?.host?.id&&(snapshot.hosts||[]).some(h=>h.id===snapshot.host.id&&h.role==='codex-source'));
 const events=Array.isArray(snapshot?.events)?snapshot.events.length:0,retained=Number(snapshot?.history?.retainedEvents)||0;
 const history=configuration?.history,budget=history?Number.isFinite(history.maxEvents)&&history.maxEvents>0&&Number.isFinite(history.maxMiB)&&history.maxMiB>0&&Number.isFinite(history.diskBudgetMiB)&&history.diskBudgetMiB>0:Number.isFinite(snapshot?.history?.maxEvents)&&snapshot.history.maxEvents>0&&Number.isFinite(snapshot?.history?.maxBytes)&&snapshot.history.maxBytes>0;
 return [
  {id:'role',label:'Installation role configured',state:role?'ready':'unknown',detail:role||'Role has not been exposed by this installation.',section:'general'},
  {id:'administrator',label:'Administrator authenticated',state:admin?'ready':'waiting',detail:admin?'Administrator role confirmed by the settings service.':'Sign in with the owner access package to manage shared settings.',section:'access'},
  {id:'origin',label:'Local or fixed HTTPS origin configured',state:network?originReady?'ready':'waiting':'unknown',detail:network?originReady?'Configuration declares a local listener or fixed TLS origin. TLS health is a separate check.':'Review the origin, listener and expected TLS settings.':'Network configuration is private to administrators.',section:'fleet'},
  {id:'source',label:'Source identity enrolled',state:enrolled||native?'ready':sources?'waiting':'unknown',detail:enrolled?'Registered collector identity present; installation and freshness remain separate.':native?'Native source identity is present on this computer.':'Read the source inventory or enroll the intended machine.',section:'sources'},
  {id:'records',label:'Source records received',state:events>0||retained>0?'ready':'waiting',detail:events>0?events+' records in this snapshot.':retained>0?retained+' retained journal records; current source freshness is separate.':'Waiting for an actual source event. Online host health alone does not establish receipt.',section:'sources'},
  {id:'history',label:'History budgets configured',state:budget?'ready':'unknown',detail:budget?'Event and storage limits are present. Actual disk headroom is shown in diagnostics.':'Read or configure the history and storage budgets.',section:'history'}
 ];
}
