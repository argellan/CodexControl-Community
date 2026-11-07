// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SettingsWorkspace} from '../public/settings-workspace.mjs';
import {createSettingsDraft,DEFAULT_PERSONAL_SETTINGS,settingsChanges} from '../public/settings-view-model.mjs';
import {DEFAULT_CONFIGURATION} from '../public/settings-schema.mjs';

const clone=value=>structuredClone(value);
const caps={personalWrite:true,configurationRead:true,configurationWrite:true,configurationRollback:true,usersRead:true,userManagement:true,sourcesRead:true,sourceEnrollment:true,diagnosticsRead:true,auditRead:true,backup:true,passwordAccounts:true};
const response=(id='owner',role='admin',extra={})=>({personal:clone(DEFAULT_PERSONAL_SETTINGS),personalRevision:1,configuration:role==='admin'?clone(DEFAULT_CONFIGURATION):null,revision:1,role,viewer:{id,label:id},capabilities:role==='admin'?clone(caps):{personalWrite:true},...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const button=(action,id)=>({dataset:{adminAction:action,id},disabled:false});
function workspace(){
 const w=Object.create(SettingsWorkspace.prototype),nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',value:'',disabled:false,focus(){}});return nodes.get(id);};
 Object.assign(w,{state:createSettingsDraft(response()),resources:{},adminDrafts:{},adminDraftDirty:new Set(),sensitiveDrafts:new Map(),issued:[],errors:[],isOpen:true,requiresRestart:false,section:'appearance',status:'Initial',chrome(){},render(){},getPersonal:()=>clone(DEFAULT_PERSONAL_SETTINGS),onPersonalChange(){},sectionResource(){},navigate(path){this.destination=path;},content:{innerHTML:'PRIVATE old content',querySelectorAll:()=>[]},dialog:{querySelector:node,close(){},showModal(){}}});
 return w;
}
const changeIdentity=(w,id='viewer',role='viewer')=>{w.state=createSettingsDraft(response(id,role));w.resources={};w.issued=[];w.adminDrafts={};w.sensitiveDrafts.clear();};

test('a late administrator load cannot replace a newer viewer identity or private configuration',async()=>{
 const w=workspace(),old=deferred(),fresh=deferred();let reads=0;w.request=()=>++reads===1?old.promise:fresh.promise;
 const a=w.load(),b=w.load();fresh.resolve(response('viewer','viewer'));await b;
 old.resolve(response('old-admin','admin',{configuration:{...clone(DEFAULT_CONFIGURATION),general:{...DEFAULT_CONFIGURATION.general,instanceName:'PRIVATE old admin'}}}));await a;
 assert.equal(w.state.viewer.id,'viewer');assert.equal(w.state.role,'viewer');assert.equal(w.state.draft.configuration,null);
});

test('a late load error cannot clear a newer load busy flag or replace its status',async()=>{
 const w=workspace(),old=deferred(),fresh=deferred();let reads=0;w.request=()=>++reads===1?old.promise:fresh.promise;
 const a=w.load(),b=w.load(),status=w.status;old.reject(new Error('PRIVATE old load error'));await a;
 assert.equal(w.loading,true);assert.equal(w.status,status);fresh.resolve(response('viewer','viewer'));await b;assert.equal(w.loading,false);
});

test('closing and reopening invalidates an unfinished load even when the identity stays the same',async()=>{
 const w=workspace(),old=deferred(),fresh=deferred();let reads=0;w.request=()=>++reads===1?old.promise:fresh.promise;
 const a=w.load();w.close({force:true});
 const previousDocument=globalThis.document;globalThis.document={activeElement:null};let b;try{b=w.open();}finally{if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;}
 fresh.resolve(response('owner','admin',{personal:{...DEFAULT_PERSONAL_SETTINGS,fontSize:16}}));await b;
 old.resolve(response('owner','admin',{personal:{...DEFAULT_PERSONAL_SETTINGS,fontSize:20}}));await a;
 assert.equal(w.state.draft.personal.fontSize,16);assert.equal(w.isOpen,true);
});

test('merge reload never carries another identity personal or configuration draft forward',async()=>{
 const w=workspace();w.state.draft.personal.fontSize=20;w.state.draft.configuration.general.instanceName='PRIVATE draft';w.adminDrafts.users={id:'PRIVATE user'};w.sensitiveDrafts.set('users.password','PRIVATE secret');
 w.request=async()=>response('other-admin','admin',{personal:{...DEFAULT_PERSONAL_SETTINGS,fontSize:12}});await w.load({merge:true});
 assert.equal(w.state.draft.personal.fontSize,12);assert.equal(w.state.draft.configuration.general.instanceName,DEFAULT_CONFIGURATION.general.instanceName);assert.equal(w.state.conflicts.length,0);assert.deepEqual(w.adminDrafts,{});assert.equal(w.sensitiveDrafts.size,0);
});

test('a 401 settings load scrubs cached private state, secrets, confirmation and page content',async()=>{
 const w=workspace();w.resources.audit={data:{configuration:[{actor:'PRIVATE'}]}};w.issued=[{downloadId:'PRIVATE'}];w.sensitiveDrafts.set('users.password','PRIVATE');w.pendingOperation={kind:'revoke-user',id:'PRIVATE'};
 w.request=async()=>{throw Object.assign(new Error('PRIVATE backend text'),{status:401});};await w.load({merge:true});
 assert.equal(w.state,null);assert.deepEqual(w.resources,{});assert.deepEqual(w.issued,[]);assert.equal(w.sensitiveDrafts.size,0);assert.equal(w.pendingOperation,null);assert.ok(!w.content.innerHTML.includes('PRIVATE'));assert.ok(!w.status.includes('PRIVATE'));assert.equal(w.loading,false);
});

test('same-ID role or capability changes discard a late protected read and enrollment result',async()=>{
 for(const mode of ['role','capability']){
  const w=workspace(),pending=deferred();w.request=()=>pending.promise;w.resources.sources={data:{revision:1,sources:[]}};w.adminDrafts.sources={id:'test-host',label:'TEST_ONLY host',expectedHostname:'test-host'};
  const action=w.adminAction(button('enroll-source'));if(mode==='role')w.state.role='viewer';else w.state.capabilities.sourceEnrollment=false;
  pending.resolve({revision:2,source:{id:'PRIVATE source'},issuedCredential:{downloadId:'PRIVATE issued',id:'PRIVATE source',kind:'collector'}});await action;
  assert.deepEqual(w.resources.sources.data.sources,[]);assert.deepEqual(w.issued,[]);
 }
 const w=workspace(),pending=deferred();w.request=()=>pending.promise;const read=w.fetchResource('audit');w.state.capabilities.auditRead=false;pending.resolve({administration:[{actor:'PRIVATE'}]});await read;assert.equal(w.resources.audit?.data,undefined);
});

test('late enrollment cannot repopulate protected state after an identity reload',async()=>{
 const w=workspace(),pending=deferred();w.resources.sources={data:{revision:1,sources:[]}};w.adminDrafts.sources={id:'test-host',label:'TEST_ONLY host',expectedHostname:'test-host'};
 w.request=path=>path==='/api/settings'?Promise.resolve(response('viewer','viewer')):pending.promise;
 const action=w.adminAction(button('enroll-source'));await w.load();const status=w.status;
 pending.resolve({revision:2,source:{id:'PRIVATE source'},issuedCredential:{downloadId:'PRIVATE issued',id:'PRIVATE source',kind:'collector'}});await action;
 assert.deepEqual(w.resources,{});assert.deepEqual(w.issued,[]);assert.equal(w.status,status);
});

test('late credential and support responses never start a download after the principal changes',async()=>{
 for(const action of ['download-credential','support']){
  const w=workspace(),pending=deferred(),downloads=[];w.request=()=>pending.promise;w.downloadJSON=value=>downloads.push(value);
  const operation=w.adminAction(button(action,'test-download'));changeIdentity(w);w.status='New viewer';pending.resolve({token:'PRIVATE secret'});await operation;
  assert.deepEqual(downloads,[]);assert.equal(w.status,'New viewer');
 }
});

test('authority changes queued between request resolution and caller continuation discard every late result',async()=>{
 for(const action of ['load','save','enroll-source','download-credential','support']){
  const w=workspace(),pending=deferred(),downloads=[];w.request=()=>pending.promise;w.downloadJSON=value=>downloads.push(value);w.state.draft.personal.fontSize=18;w.resources.sources={data:{revision:1,sources:[]}};w.adminDrafts.sources={id:'test-host',label:'TEST_ONLY host',expectedHostname:'test-host'};
  const operation=action==='load'?w.load():action==='save'?w.save():w.adminAction(button(action,'test-download'));
  pending.resolve(action==='load'?response('old-admin'):action==='save'?{preferences:{...DEFAULT_PERSONAL_SETTINGS,fontSize:18},revision:2}:{revision:2,source:{id:'PRIVATE source'},issuedCredential:{downloadId:'PRIVATE issued'},token:'PRIVATE token'});
  queueMicrotask(()=>{changeIdentity(w,'new-owner','admin');w.status='New principal';});await operation;
  assert.equal(w.state.viewer.id,'new-owner',action);assert.equal(w.state.draft.personal.fontSize,14,action);assert.deepEqual(w.resources,{},action);assert.deepEqual(w.issued,[],action);assert.deepEqual(downloads,[],action);assert.equal(w.status,'New principal',action);
 }
});

test('late action errors and finally blocks do not overwrite a newer operation',async()=>{
 const w=workspace(),old=deferred(),fresh=deferred();let calls=0;w.request=()=>++calls===1?old.promise:fresh.promise;w.downloadJSON=()=>{};
 const a=w.adminAction(button('support'));changeIdentity(w,'new-owner','admin');const b=w.adminAction(button('support'));w.status='New operation';
 old.reject(new Error('PRIVATE old error'));await a;assert.equal(w.operationBusy,true);assert.equal(w.status,'New operation');
 fresh.resolve({safe:true});await b;assert.equal(w.operationBusy,false);
});

test('a stale personal-save response cannot overwrite a newly loaded draft or clear its new save flag',async()=>{
 const w=workspace(),old=deferred(),fresh=deferred();let writes=0;w.state.draft.personal.fontSize=18;
 w.request=path=>path==='/api/settings'?Promise.resolve(response('owner','admin',{personal:{...DEFAULT_PERSONAL_SETTINGS,fontSize:16}})):++writes===1?old.promise:fresh.promise;
 const a=w.save();await w.load();w.state.draft.personal.fontSize=19;const b=w.save();w.status='New save';old.resolve({preferences:{...DEFAULT_PERSONAL_SETTINGS,fontSize:18},revision:2});await a;
 assert.equal(w.state.draft.personal.fontSize,19);assert.equal(w.saving,true);assert.equal(w.status,'New save');
 fresh.resolve({preferences:{...DEFAULT_PERSONAL_SETTINGS,fontSize:19},revision:3});await b;assert.equal(w.saving,false);assert.equal(w.state.personalRevision,3);
});

test('a personal apply callback settling after a new load cannot start the old shared save',async()=>{
 const w=workspace(),applied=deferred(),paths=[];w.state.draft.personal.fontSize=18;w.state.draft.configuration.general.instanceName='PRIVATE old draft';
 w.request=async(path,options)=>{paths.push(path);return path==='/api/settings'?response('viewer','viewer'):{preferences:options.body.preferences,revision:2};};w.onPersonalChange=()=>applied.promise;
 const save=w.save();await Promise.resolve();await w.load();applied.resolve();await save;
 assert.deepEqual(paths,['/api/settings/personal','/api/settings']);assert.equal(w.state.role,'viewer');assert.equal(w.state.draft.configuration,null);
});

test('a late save error cannot replace a new identity status or private-state cleanup',async()=>{
 const w=workspace(),pending=deferred();w.state.draft.personal.fontSize=18;w.request=()=>pending.promise;const save=w.save();changeIdentity(w);w.status='Viewer loaded';pending.reject(new Error('PRIVATE old save'));await save;assert.equal(w.status,'Viewer loaded');assert.equal(w.state.role,'viewer');
});

test('a late rollback cannot replace configuration after a new identity load',async()=>{
 const w=workspace(),pending=deferred();w.pendingOperation={kind:'rollback'};w.request=()=>pending.promise;const operation=w.confirmedOperation();changeIdentity(w);w.status='Viewer loaded';
 pending.resolve({revision:2,configuration:clone(DEFAULT_CONFIGURATION),requiresRestart:true});await operation;
 assert.equal(w.state.draft.configuration,null);assert.equal(w.requiresRestart,false);assert.equal(w.status,'Viewer loaded');
});

test('replaced and cancelled confirmations ignore old completions and keep the new confirmation busy',async()=>{
 const w=workspace(),old=deferred(),fresh=deferred();let calls=0;w.request=()=>++calls===1?old.promise:fresh.promise;w.resources.users={data:{revision:1,users:[{id:'first'},{id:'second'}]}};
 w.confirmOperation('revoke-user','First','first');const a=w.confirmedOperation();w.confirmOperation('revoke-user','Second','second');const b=w.confirmedOperation();
 old.resolve({revision:2,user:{id:'first',disabled:true}});await a;assert.equal(w.confirming,true);assert.equal(w.pendingOperation.id,'second');assert.equal(w.resources.users.data.users[0].disabled,undefined);
 fresh.resolve({revision:3,user:{id:'second',disabled:true}});await b;assert.equal(w.confirming,false);assert.equal(w.pendingOperation,null);assert.equal(w.resources.users.data.users[1].disabled,true);
 const p=deferred();w.request=()=>p.promise;w.confirmOperation('revoke-user','First again','first');const c=w.confirmedOperation();
 await w.handleClick({target:{closest:()=>({dataset:{action:'cancel-operation'}})}});const status=w.status;p.resolve({revision:4,user:{id:'first',disabled:true}});await c;
 assert.equal(w.pendingOperation,null);assert.equal(w.status,status);assert.equal(w.resources.users.data.users[0].disabled,undefined);assert.match(status,/may|submitted|refresh/i);
});

test('late confirmation errors do not overwrite a replacement confirmation',async()=>{
 const w=workspace(),pending=deferred();w.request=()=>pending.promise;w.confirmOperation('rollback','Old');const operation=w.confirmedOperation();w.confirmOperation('revoke-source','New','test-source');w.status='Replacement';pending.reject(new Error('PRIVATE old confirmation'));await operation;
 assert.equal(w.status,'Replacement');assert.equal(w.pendingOperation.id,'test-source');
});

test('shared configuration save and rollback invalidate on-demand audit data',async()=>{
 for(const kind of ['save','rollback']){
  const w=workspace();w.resources.audit={data:{configuration:[{action:'OLD'}]}};w.state.draft.configuration.general.instanceName='Changed';w.request=async(path,options)=>({configuration:options.body.configuration||clone(DEFAULT_CONFIGURATION),revision:2});
  if(kind==='save')await w.save();else{w.pendingOperation={kind:'rollback'};await w.confirmedOperation();}
  assert.equal(w.resources.audit,undefined);const calls=[];w.section='audit';w.fetchResource=key=>calls.push(key);SettingsWorkspace.prototype.sectionResource.call(w);assert.deepEqual(calls,['audit']);
 }
});

test('committed personal acknowledgement survives an apply failure and remaining configuration draft is retained',async()=>{
 const w=workspace();w.state.draft.personal.fontSize=18;w.state.draft.configuration.general.instanceName='Changed';let calls=0;w.request=async()=>{calls++;return {preferences:{...DEFAULT_PERSONAL_SETTINGS,fontSize:18},revision:2};};w.onPersonalChange=()=>{throw new Error('Apply failed');};await w.save();
 assert.equal(calls,1);assert.equal(w.state.baseline.personal.fontSize,18);assert.equal(w.state.personalRevision,2);assert.equal(settingsChanges(w.state).personal.length,0);assert.equal(w.state.draft.configuration.general.instanceName,'Changed');assert.match(w.status,/Saved personal/);
});

test('current-account demotion and revocation clear protected state and require authoritative sign-in',async()=>{
 for(const kind of ['demote','revoke']){
  const w=workspace();w.resources.users={data:{revision:1,users:[{id:'owner',role:'admin'},{id:'second-owner',role:'admin'}]}};w.resources.audit={data:{configuration:[{actor:'PRIVATE'}]}};let calls=0;
  w.request=async()=>{calls++;return {revision:2,user:{id:'owner',role:kind==='demote'?'viewer':'admin',hostIds:null,projectIds:null,disabled:kind==='revoke'}};};
  if(kind==='demote'){w.adminDrafts.users={id:'owner',label:'Owner',role:'viewer',allHosts:true,allProjects:true};await w.adminAction(button('save-user'));}else{w.pendingOperation={kind:'revoke-user',id:'owner'};await w.confirmedOperation();}
  assert.equal(calls,1);assert.equal(w.state,null);assert.deepEqual(w.resources,{});assert.equal(w.destination,'/');assert.equal(w.pendingOperation,null);
 }
});
