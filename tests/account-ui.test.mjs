// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSettingsDraft,canUseCapability} from '../public/settings-view-model.mjs';
import * as viewModel from '../public/settings-view-model.mjs';
import * as workspaceModule from '../public/settings-workspace.mjs';
const login=await import('../public/login.js').catch(()=>({}));
const password='TEST_ONLY secret phrase 7!';
const state=(extra={})=>createSettingsDraft({role:'admin',personalRevision:1,revision:1,viewer:{id:'owner',label:'Owner',username:'owner',passwordEnabled:true},capabilities:{userManagement:true,passwordAccounts:true,passwordChange:true,usersRead:true},...extra});
function workspace(request,extra={}){
 const value=Object.create(workspaceModule.SettingsWorkspace.prototype);Object.assign(value,{state:state(),request,resources:{users:{data:{revision:3,users:[{id:'owner',label:'Owner',username:'owner',passwordEnabled:true,role:'admin',hostIds:null,projectIds:null},{id:'reviewer',label:'Reviewer',username:'reviewer',passwordEnabled:true,role:'viewer',hostIds:['edge'],projectIds:null}]}}},adminDrafts:{},adminDraftDirty:new Set(),sensitiveDrafts:new Map(),issued:[],getSnapshot:()=>null,chrome(){},navigate(){},...extra});value.render=()=>{value.lastHTML=workspaceModule.renderAccountControls?.(value.state,value.context());};return value;
}
const button=(action,id)=>({dataset:{adminAction:action,id},disabled:false});

test('own access-key rotation has visible guidance while other-account and initial issuance stay available',()=>{
 const s=state(),render=d=>workspaceModule.renderAccountControls(s,{resources:{users:{data:{revision:3,users:[]}}},adminDrafts:{users:d}});
 const own=render({id:'owner',editing:true,passwordEnabled:true,username:'owner'});
 assert.doesNotMatch(own,/data-admin-field="rotateKey"/);assert.match(own,/Ask another administrator to replace your access key/);assert.match(own,/change-own-password/);
 assert.match(render({id:'reviewer',editing:true}),/rotateKey/);assert.match(render({id:'new-reviewer'}),/Create user/);
});

test('a stale rotation checkbox targeting the current user sends no request and preserves the draft',async()=>{
 let calls=0;const value=workspace(async()=>{calls++;return {};});value.adminDrafts.users={id:'owner',label:'Owner',username:'owner',role:'admin',allHosts:true,allProjects:true,rotateKey:true,editing:true};
 await value.adminAction(button('save-user'));assert.equal(calls,0);assert.equal(value.error,true);assert.match(value.status,/Ask another administrator/);assert.equal(value.adminDrafts.users.rotateKey,true);
});

test('settings identity keeps safe username/password-method metadata without admitting API secrets',()=>{
 const value=state({viewer:{id:'owner',label:'Owner',username:'owner',passwordEnabled:true,password:'PRIVATE',passwordHash:'PRIVATE'}});assert.equal(value.viewer.username,'owner');assert.equal(value.viewer.passwordEnabled,true);assert.ok(!JSON.stringify(value).includes('PRIVATE'));
 assert.equal(canUseCapability(state({role:'viewer'}),'passwordAccounts'),false);assert.equal(canUseCapability(state({role:'viewer'}),'passwordChange'),true);
});

test('account request builder preserves exact password whitespace and excludes confirmation and UI-only fields',()=>{
 assert.equal(typeof viewModel.buildAccountUser,'function');const user=viewModel.buildAccountUser({id:'reviewer',label:'Review',username:' Reviewer ',role:'viewer',allHosts:false,hostsIds:'edge\nlaptop',allProjects:true},{password:'  '+password+'  ',passwordConfirmation:'  '+password+'  ',viewerId:'owner'});
 assert.equal(user.username,'reviewer');assert.equal(user.password,'  '+password+'  ');assert.deepEqual(user.hostIds,['edge','laptop']);assert.equal(user.projectIds,null);assert.ok(!Object.hasOwn(user,'passwordConfirmation'));assert.ok(!Object.hasOwn(user,'allHosts'));
 assert.throws(()=>viewModel.buildAccountUser({id:'reviewer',username:'reviewer'},{password,passwordConfirmation:'different'}),/match/i);
});

test('admin account creation sends the protected password contract and clears successful secret drafts',async()=>{
 let sent;const value=workspace(async(path,options)=>{sent={path,...options};return {revision:4,users:[]};});value.adminDrafts.users={id:'newviewer',label:'New viewer',username:'newviewer',role:'viewer',allHosts:true,allProjects:true};value.sensitiveDrafts.set('users.password',password);value.sensitiveDrafts.set('users.passwordConfirmation',password);value.adminDraftDirty.add('users');
 await value.adminAction(button('save-user'));assert.equal(sent.path,'/api/admin/users');assert.equal(sent.body.revision,3);assert.equal(sent.body.user.username,'newviewer');assert.equal(sent.body.user.password,password);assert.ok(!Object.hasOwn(sent.body.user,'passwordConfirmation'));assert.equal(value.sensitiveDrafts.has('users.password'),false);assert.equal(value.adminDraftDirty.has('users'),false);assert.ok(!JSON.stringify(value.state).includes(password));assert.ok(!value.lastHTML.includes(password));
});

test('failed password account requests preserve the typed draft without echoing backend secrets',async()=>{
 const value=workspace(async()=>{throw Object.assign(new Error('Rejected '+password),{status:400});});value.adminDrafts.users={id:'newviewer',username:'newviewer',allHosts:true,allProjects:true};value.sensitiveDrafts.set('users.password',password);value.sensitiveDrafts.set('users.passwordConfirmation',password);value.adminDraftDirty.add('users');
 await value.adminAction(button('save-user'));assert.equal(value.sensitiveDrafts.get('users.password'),password);assert.equal(value.adminDrafts.users.username,'newviewer');assert.ok(!value.status.includes(password));assert.ok(!value.lastHTML.includes(password));assert.equal(value.error,true);
});

test('explicit reset uses the selected other account and inventory revision without replacing unrelated users',async()=>{
 let sent;const value=workspace(async(path,options)=>{sent={path,...options};return {revision:4,user:{id:'reviewer',label:'Reviewer',username:'reviewer',passwordEnabled:true,role:'viewer',hostIds:['edge'],projectIds:null}};});value.adminDrafts.passwordReset={id:'reviewer',label:'Reviewer',username:'reviewer'};value.sensitiveDrafts.set('passwordReset.password',password);value.sensitiveDrafts.set('passwordReset.passwordConfirmation',password);
 await value.adminAction(button('save-user-password'));assert.equal(sent.path,'/api/admin/users/reviewer/password');assert.deepEqual(sent.body,{revision:3,password});assert.equal(value.resources.users.data.revision,4);assert.equal(value.resources.users.data.users.length,2);assert.equal(value.sensitiveDrafts.has('passwordReset.password'),false);
});

test('administrator reset cannot be used to replace the current users own password',async()=>{
 let calls=0;const value=workspace(async()=>{calls++;return {};});value.adminDrafts.passwordReset={id:'owner',username:'owner'};value.sensitiveDrafts.set('passwordReset.password',password);value.sensitiveDrafts.set('passwordReset.passwordConfirmation',password);await value.adminAction(button('save-user-password'));assert.equal(calls,0);assert.equal(value.error,true);assert.match(value.status,/own|current password/i);
});

test('own password change sends current/new secrets only and requires a fresh sign-in after success',async()=>{
 let sent,navigation;const value=workspace(async(path,options)=>{sent={path,...options};return {changed:true,signInRequired:true};},{navigate:path=>{navigation=path;}});value.sensitiveDrafts.set('ownPassword.currentPassword','TEST_ONLY old password');value.sensitiveDrafts.set('ownPassword.newPassword',password);value.sensitiveDrafts.set('ownPassword.passwordConfirmation',password);
 await value.adminAction(button('change-own-password'));assert.equal(sent.path,'/api/settings/password');assert.deepEqual(sent.body,{currentPassword:'TEST_ONLY old password',newPassword:password});assert.equal(value.sensitiveDrafts.size,0);assert.equal(navigation,'/');
});

test('account controls label initial passwords and reset operations while never filling password values from state',()=>{
 assert.equal(typeof workspaceModule.renderAccountControls,'function');const s=state(),html=workspaceModule.renderAccountControls(s,{resources:{users:{data:{revision:3,users:[{id:'reviewer',username:'reviewer',passwordEnabled:true,role:'viewer'}]}}},adminDrafts:{users:{id:'newviewer',username:'newviewer',password:'SHOULD_NOT_RENDER',passwordHash:'SHOULD_NOT_RENDER'}}});
 assert.match(html,/Create user/);assert.match(html,/Username/);assert.match(html,/type="password"/);assert.match(html,/autocomplete="new-password"/);const selected=workspaceModule.renderAccountControls(s,{adminDrafts:{users:{id:'reviewer',username:'reviewer',passwordEnabled:true,editing:true}},resources:{users:{data:{revision:3,users:[]}}}});assert.match(selected,/Reset password/);assert.match(html,/Edit user reviewer/);assert.match(html,/current-password/);assert.ok(!html.includes('SHOULD_NOT_RENDER'));
 const viewer=workspaceModule.renderAccountControls(state({role:'viewer',capabilities:{passwordChange:true}}),{});assert.doesNotMatch(viewer,/data-admin-action="save-user"|data-admin-action="save-user-password"/);assert.match(viewer,/change-own-password/);
});

function loginFixture(request){
 const nodes=new Map(),element=id=>({id,value:'',hidden:false,disabled:false,textContent:'',dataset:{},listeners:{},addEventListener(type,listener){this.listeners[type]=listener;},querySelector(){return this.submit||={disabled:false};},setAttribute(){}});
 for(const id of ['account-login-form','username','account-password','account-login-status','password-login-panel','password-login-note','hub-login-link','hub-login-address','login-form','access-key','login-status','key-login-panel'])nodes.set(id,element(id));
 let destination;return {nodes,get destination(){return destination;},options:{document:{getElementById:id=>nodes.get(id)},request,navigate:path=>{destination=path;}}};
}
test('username/password sign-in clears a successful password and preserves access-key sign-in',async()=>{
 assert.equal(typeof login.mountLogin,'function');const requests=[],f=loginFixture(async(path,options)=>{requests.push({path,...options});return {ok:true,status:200,json:async()=>({accessKey:true,passwordLogin:true,passwordChange:true})};}),controller=login.mountLogin(f.options);await controller.ready;
 f.nodes.get('username').value='Owner';f.nodes.get('account-password').value=password;await f.nodes.get('account-login-form').listeners.submit({preventDefault(){}});assert.deepEqual(JSON.parse(requests.at(-1).body),{username:'Owner',password});assert.equal(f.nodes.get('account-password').value,'');assert.equal(f.destination,'/');
 f.nodes.get('access-key').value='TEST_ONLY access key';await f.nodes.get('login-form').listeners.submit({preventDefault(){}});assert.deepEqual(JSON.parse(requests.at(-1).body),{token:'TEST_ONLY access key'});assert.equal(f.nodes.get('access-key').value,'');
});

test('failed password login keeps the reviewable typed values and displays only a fixed generic error',async()=>{
 const f=loginFixture(async(path)=>path==='/api/auth/capabilities'?{ok:true,status:200,json:async()=>({accessKey:true,passwordLogin:true})}:{ok:false,status:401,json:async()=>({error:password})}),controller=login.mountLogin(f.options);await controller.ready;f.nodes.get('username').value='owner';f.nodes.get('account-password').value=password;
 await f.nodes.get('account-login-form').listeners.submit({preventDefault(){}});assert.equal(f.nodes.get('account-password').value,password);assert.equal(f.nodes.get('username').value,'owner');assert.ok(!f.nodes.get('account-login-status').textContent.includes(password));assert.match(f.nodes.get('account-login-status').textContent,/sign.in failed/i);assert.equal(f.destination,undefined);
});

test('a fixed-token gateway clearly disables unsupported password login while keeping key entry available',async()=>{
 const f=loginFixture(async()=>({ok:true,status:200,json:async()=>({accessKey:true,passwordLogin:false,passwordUnavailableReason:'Use the authoritative hub'})})),controller=login.mountLogin(f.options);await controller.ready;
 assert.equal(f.nodes.get('account-login-form').querySelector('button').disabled,true);assert.match(f.nodes.get('password-login-note').textContent,/hub|unavailable/i);assert.equal(f.nodes.get('login-form').querySelector('button').disabled,false);
});

test('typed and autofilled password drafts stay outside settings state and clear from both DOM and memory',()=>{
 const value=workspace(async()=>({})),input={id:'password',type:'password',value:password,dataset:{secretField:'users.password'}},inputs=[input];value.content={querySelectorAll:()=>inputs,querySelector:()=>input};
 value.handleInput({target:input});assert.equal(value.sensitiveDrafts.get('users.password'),password);assert.equal(value.adminDrafts.users,undefined);assert.ok(!JSON.stringify(value.context()).includes(password));
 input.value='';value.restoreSecretInputs();assert.equal(input.value,password);input.value='TEST_ONLY autofilled password';value.captureSecretInputs();assert.equal(value.sensitiveDrafts.get('users.password'),input.value);
 value.clearSecrets('users');assert.equal(input.value,'');assert.equal(value.sensitiveDrafts.size,0);
});

test('closing a discarded account form clears its password inputs and secret drafts',()=>{
 const value=workspace(async()=>({})),input={value:password,dataset:{secretField:'users.password'}},inputs=[input];let closed=false;value.content={querySelectorAll:()=>inputs};value.dialog={close(){closed=true;}};value.sensitiveDrafts.set('users.password',password);value.adminDraftDirty.add('users');
 assert.equal(value.close({force:true}),true);assert.equal(closed,true);assert.equal(input.value,'');assert.equal(value.sensitiveDrafts.size,0);assert.equal(value.adminDraftDirty.size,0);
});

test('switching edited users cannot carry an initial password into another account',async()=>{
 const value=workspace(async()=>({}));value.sensitiveDrafts.set('users.password',password);value.sensitiveDrafts.set('ownPassword.currentPassword','TEST_ONLY current password');await value.adminAction(button('edit-user','reviewer'));
 assert.equal(value.adminDrafts.users.id,'reviewer');assert.equal(value.adminDrafts.users.username,'reviewer');assert.equal(value.sensitiveDrafts.has('users.password'),false);assert.equal(value.sensitiveDrafts.get('ownPassword.currentPassword'),'TEST_ONLY current password');
});

test('initial own password setup navigates on the confirmed response without another protected request',async()=>{
 let calls=0,destination;const value=workspace(async()=>{calls++;return {revision:4,users:[],signInRequired:true};},{navigate:path=>{destination=path;}});value.state.viewer.passwordEnabled=false;value.adminDrafts.users={id:'owner',username:'owner',label:'Owner',role:'admin',allHosts:true,allProjects:true,passwordEnabled:false};value.sensitiveDrafts.set('users.password',password);value.sensitiveDrafts.set('users.passwordConfirmation',password);
 await value.adminAction(button('save-user'));assert.equal(calls,1);assert.equal(destination,'/');assert.equal(value.sensitiveDrafts.size,0);
});

test('unknown password request errors cannot reflect secret text into the workspace',async()=>{
 const value=workspace(async()=>{throw new Error('Connection failed with '+password);});value.adminDrafts.users={id:'reviewer',username:'reviewer',allHosts:true,allProjects:true};value.sensitiveDrafts.set('users.password',password);value.sensitiveDrafts.set('users.passwordConfirmation',password);await value.adminAction(button('save-user'));assert.ok(!value.status.includes(password));assert.match(value.status,/could not be confirmed/i);assert.equal(value.sensitiveDrafts.get('users.password'),password);
});


test('local key gateway offers the actual safe account sign-in instead of disabled password fields',async()=>{
 const f=loginFixture(async()=>({ok:true,status:200,json:async()=>({passwordLogin:false,passwordLoginUrl:'https://observer.example.invalid:4317/'})}));f.nodes.get('hub-login-link').hidden=true;f.nodes.get('account-password').value=password;await login.mountLogin(f.options).ready;
 assert.equal(f.nodes.get('account-login-form').hidden,true);assert.equal(f.nodes.get('account-password').value,'');assert.equal(f.nodes.get('hub-login-link').hidden,false);assert.equal(f.nodes.get('hub-login-link').href,'https://observer.example.invalid:4317/');assert.equal(f.nodes.get('hub-login-address').textContent,'observer.example.invalid:4317');assert.equal(f.nodes.get('login-form').querySelector('button').disabled,false);
});

test('login handoff rejects unsafe or credential-bearing destinations',async()=>{
 for(const passwordLoginUrl of ['javascript:alert(1)','http://observer.example.invalid/','https://name:secret@example.invalid/','https://example.invalid/?key=secret','https://example.invalid/#secret','https://example.invalid/nested']){const f=loginFixture(async()=>({ok:true,status:200,json:async()=>({passwordLogin:false,passwordLoginUrl})}));f.nodes.get('hub-login-link').hidden=true;await login.mountLogin(f.options).ready;assert.equal(f.nodes.get('hub-login-link').hidden,true);assert.equal(f.nodes.get('hub-login-link').href,undefined);}
});
