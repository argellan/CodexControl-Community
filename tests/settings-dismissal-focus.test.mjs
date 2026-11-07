// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {SettingsWorkspace} from '../public/settings-workspace.mjs';

// Narrow DOM boundary: the production close path chooses the surviving target.
// Actual native dialog, breakpoint, pointer and keyboard behavior is browser-tested.
function environment(){
 const page={defaultView:{getComputedStyle:n=>({visibility:n.visibility||'visible'})}};
 const node=(id,visible=true)=>({id,ownerDocument:page,isConnected:true,disabled:false,hidden:false,visible,closest(){return this.inert?{}:null;},getClientRects(){return this.visible&&!this.hidden?[{}]:[];},focus(){if(this.isConnected&&this.visible&&!this.disabled&&!this.inert)page.activeElement=this;}});
 const body=node('body'),desktop=node('settings'),mobile=node('mobile-settings',false),more=node('more',false),inside=node('inside'),other=node('other'),custom=node('custom');
 page.body=body;page.activeElement=inside;page.querySelector=s=>s==='#settings'?desktop:s==='button[data-mobile-action="settings"]'?mobile:s==='button[data-mobile-view="more"]'?more:null;
 const dialog={ownerDocument:page,open:true,contains:n=>n===inside,close(){this.open=false;if(page.activeElement===inside)page.activeElement=body;}};
 const w=Object.create(SettingsWorkspace.prototype);Object.assign(w,{isOpen:true,state:null,dialog,returnFocus:desktop,resources:{},content:{querySelector:()=>null,querySelectorAll:()=>[]}});
 return{w,page,dialog,desktop,mobile,more,inside,other,custom};
}

test('desktop-open to phone Escape returns focus to More when Settings is outside the current view',()=>{
 const e=environment();e.desktop.visible=false;e.more.visible=true;e.w.close();assert.equal(e.page.activeElement,e.more);assert.equal(e.dialog.open,false);
});
test('desktop-open to compact More view returns focus to the visible Settings action',()=>{
 const e=environment();e.desktop.visible=false;e.mobile.visible=e.more.visible=true;e.w.close();assert.equal(e.page.activeElement,e.mobile);
});
test('phone-open to desktop Close returns focus to the corresponding visible desktop opener',()=>{
 const e=environment();e.w.returnFocus=e.mobile;e.w.close();assert.equal(e.page.activeElement,e.desktop);
});
test('an unchanged visible initiating control remains the preferred return target',()=>{
 const e=environment();e.w.returnFocus=e.custom;e.w.close();assert.equal(e.page.activeElement,e.custom);
});
for(const invalid of ['disabled','inert','disconnected','visibility'])test('dismissal rejects an '+invalid+' original opener',()=>{
 const e=environment();e.w.returnFocus=e.custom;if(invalid==='disconnected')e.custom.isConnected=false;else if(invalid==='visibility')e.custom.visibility='hidden';else e.custom[invalid]=true;e.w.close();assert.equal(e.page.activeElement,e.desktop);
});
test('closing an old workspace does not take focus from an independently focused visible control',()=>{
 const e=environment();e.page.activeElement=e.other;e.w.close({force:true});assert.equal(e.page.activeElement,e.other);
});
test('repeated close after another context gains focus cannot reclaim the old opener',()=>{
 const e=environment();e.w.close();e.page.activeElement=e.other;e.w.close({force:true});assert.equal(e.page.activeElement,e.other);
});
