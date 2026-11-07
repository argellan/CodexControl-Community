// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {SettingsWorkspace,renderAccountControls} from '../public/settings-workspace.mjs';
import {createSettingsDraft} from '../public/settings-view-model.mjs';
function fixture(){
 const requests=[],w=Object.create(SettingsWorkspace.prototype);
 Object.assign(w,{state:createSettingsDraft({role:'admin',viewer:{id:'owner'},revision:1,capabilities:{userManagement:true,usersRead:true,passwordAccounts:true}}),resources:{users:{data:{revision:4,users:[{id:'reviewer',label:'Reviewer',role:'viewer',hostIds:['a'],projectIds:null}]}}},adminDrafts:{users:{id:'draft',label:'Unsent',hostsIds:'a\nb'},sources:{id:'keep-device'}},adminDraftDirty:new Set(['users','sources']),sensitiveDrafts:new Map([['users.password','TEST_ONLY secret'],['ownPassword.currentPassword','KEEP_TEST_ONLY']]),accountTab:'access',issued:[],getSnapshot:()=>null,request:async(...args)=>{requests.push(args);throw Object.assign(new Error('Conflict'),{status:409});},render(){this.html=renderAccountControls(this.state,this.context());},chrome(){}});
 return {w,requests};
}
const button=(action,id)=>({dataset:{adminAction:action,id},disabled:false});
test('switching accounts keeps a dirty draft and secrets until an explicit scoped discard',async()=>{
 const {w,requests}=fixture();await w.adminAction(button('edit-user','reviewer'));
 assert.equal(w.adminDrafts.users.id,'draft');assert.equal(w.accountTransition.id,'reviewer');assert.match(w.html,/Keep editing/);assert.equal(requests.length,0);
 await w.finishAccountTransition('keep');assert.equal(w.adminDrafts.users.hostsIds,'a\nb');assert.equal(w.sensitiveDrafts.get('users.password'),'TEST_ONLY secret');
 await w.adminAction(button('edit-user','reviewer'));await w.finishAccountTransition('discard');
 assert.equal(w.adminDrafts.users.id,'reviewer');assert.equal(w.adminDrafts.users.hostsIds,'a');assert.equal(w.sensitiveDrafts.has('users.password'),false);
 assert.equal(w.adminDrafts.sources.id,'keep-device');assert.equal(w.adminDraftDirty.has('sources'),true);assert.equal(w.sensitiveDrafts.get('ownPassword.currentPassword'),'KEEP_TEST_ONLY');assert.equal(requests.length,0);
});
test('a stale account-switch confirmation cannot act after authority changes',async()=>{
 const {w,requests}=fixture();await w.adminAction(button('edit-user','reviewer'));w.lifecycleGeneration=1;await w.finishAccountTransition('discard');
 assert.equal(w.adminDrafts.users.id,'draft');assert.equal(requests.length,0);assert.equal(w.sensitiveDrafts.has('users.password'),true);
});
test('an account save conflict retains selected tab, scope, identity and secret drafts',async()=>{
 const {w,requests}=fixture();w.adminDrafts.users={id:'reviewer',label:'Reviewer',role:'viewer',editing:true,allHosts:false,hostsIds:'a\nb',allProjects:true};w.sensitiveDrafts.delete('users.password');
 await w.adminAction(button('save-user'));assert.equal(requests.length,1);assert.equal(requests[0][1].body.revision,4);assert.deepEqual(requests[0][1].body.user.hostIds,['a','b']);assert.equal(w.accountTab,'access');assert.equal(w.adminDrafts.users.hostsIds,'a\nb');assert.equal(w.accountDirty(),true);assert.equal(w.error,true);
});
test('in-flight account requests cannot be interrupted by replacing the editor',async()=>{
 const {w}=fixture();w.operationBusy=true;w.actionToken={context:w.operationContext()};await w.adminAction(button('new-user'));assert.equal(w.accountTransition,undefined);assert.equal(w.adminDrafts.users.id,'draft');
});
test('all identity, scope, credential and recovery actions remain in the selected editor',()=>{
 const {w}=fixture();w.adminDrafts.users={id:'reviewer',label:'<script>',username:'reviewer',passwordEnabled:true,editing:true,allHosts:false,allProjects:false,hostsIds:'old-host',projectsIds:'old-project'};
 const html=renderAccountControls(w.state,{...w.context(),issued:[{id:'reviewer',kind:'viewer',downloadId:'receipt',expiresAt:new Date(Date.now()+30000).toISOString()}]});
 for(const token of ['role="tablist"','role="tabpanel"','Identity','Access','Credentials','Account ID','Display name','Username','Expires at','old-host','old-project','reset-user-password','removePassword','rotateKey','revoke-user','save-user','download-credential','Password, session &amp; packages'])assert.ok(html.includes(token)||token==='Password, session &amp; packages'&&html.includes('Password, session & packages'),token);
 assert.ok(!html.includes('<script>'));assert.ok(!html.includes('TEST_ONLY secret'));
});
test('cancel closes only the account editor after confirmation and sends no mutation',async()=>{
 const {w,requests}=fixture();await w.adminAction(button('cancel-user'));await w.finishAccountTransition('discard');assert.equal(w.accountEditorClosed,true);assert.equal(w.adminDrafts.sources.id,'keep-device');assert.match(w.html,/Choose an account/);assert.equal(requests.length,0);
});
test('switching a clean editor clears an unopened password-reset target from the previous account',async()=>{
 const {w,requests}=fixture();w.adminDraftDirty.delete('users');w.sensitiveDrafts.delete('users.password');w.adminDrafts.passwordReset={id:'previous',label:'Previous account'};
 await w.adminAction(button('edit-user','reviewer'));assert.equal(w.adminDrafts.users.id,'reviewer');assert.deepEqual(w.adminDrafts.passwordReset,{});assert.ok(!w.html.includes('Reset password · Previous account'));assert.equal(requests.length,0);
});
