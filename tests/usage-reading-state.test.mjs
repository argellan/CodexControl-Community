// SPDX-License-Identifier: MIT
// Author: Bishop Crockett; Owner: Argellan.com
import test from 'node:test';import assert from 'node:assert/strict';
import {captureUsageReading,restoreUsageReading} from '../public/account-usage.mjs';
function fixture(names){
 let active=null;
 const root={nodes:[],querySelectorAll(selector){return this.nodes.filter(n=>n.matches(selector));},contains(n){return this.nodes.includes(n);}};
 const dialog={scrollTop:400},fallback={focus(){active=this;}};
 for(const [name,sectionId] of names){
  const section={id:sectionId},detail={open:false,tagName:'DETAILS',name,closest:s=>s==='section[id]'?section:null,querySelector:s=>s==='summary'?summary:null,querySelectorAll:s=>s==='.usage-table-scroll'?[scroll]:[],matches:s=>s==='details'};
  const summary={tagName:'SUMMARY',textContent:name,id:'',dataset:{},getAttribute:()=>null,closest:s=>s==='details'?detail:null,matches:()=>false,focus(){active=this;},getBoundingClientRect:()=>({top:100})};
  const scroll={tagName:'DIV',id:'',dataset:{},scrollTop:0,scrollLeft:0,getAttribute:()=>null,closest:s=>s==='details'?detail:s==='section[id]'?section:null,matches:s=>s==='.usage-table-scroll',focus(){active=this;},getBoundingClientRect:()=>({top:150})};
  root.nodes.push(detail,summary,scroll);
 }
 return {root,dialog,fallback,get active(){return active;},detail:name=>root.nodes.find(n=>n.name===name),summary:name=>root.nodes.find(n=>n.textContent===name),scroll:name=>root.nodes.find(n=>n.name===name)?.querySelectorAll('.usage-table-scroll')[0]};
}
for(const mode of ['summary','inside','collapsed'])test('expiry preserves retained identity, '+mode+' focus and scroll when a preceding burn disclosure disappears',()=>{
 const before=fixture([['Burn by worker (2)','usage-active'],['Previous active-session counter view','usage-active'],['Retained daily worker deltas (2)','usage-storage']]),name='Retained daily worker deltas (2)';
 before.detail(name).open=mode!=='collapsed';before.scroll(name).scrollTop=137;before.scroll(name).scrollLeft=29;const focused=mode==='inside'?before.scroll(name):before.summary(name);focused.focus();
 const state=captureUsageReading(before.root,focused,before.dialog);
 const after=fixture([['Previous active-session counter view','usage-active'],['Retained daily worker deltas (3)','usage-storage']]),next='Retained daily worker deltas (3)';
 restoreUsageReading(after.root,state,after.dialog,after.fallback);
 assert.equal(after.detail(next).open,mode!=='collapsed');assert.equal(after.scroll(next).scrollTop,137);assert.equal(after.scroll(next).scrollLeft,29);assert.equal(after.active,mode==='inside'?after.scroll(next):after.summary(next));assert.equal(after.dialog.scrollTop,400);
 assert.equal(after.detail('Previous active-session counter view').open,false);
 // Repeated updates preserve state; they do not turn a collapse into expansion.
 const again=captureUsageReading(after.root,after.active,after.dialog);restoreUsageReading(after.root,again,after.dialog,after.fallback);assert.equal(after.detail(next).open,mode!=='collapsed');
});
test('a truly removed burn summary moves focus to surviving Refresh without retaining a vanished reading',()=>{
 const before=fixture([['Burn by worker (2)','usage-active']]);before.summary('Burn by worker (2)').focus();const state=captureUsageReading(before.root,before.active,before.dialog),after=fixture([['Previous active-session counter view','usage-active']]);restoreUsageReading(after.root,state,after.dialog,after.fallback);assert.equal(after.active,after.fallback);assert.equal(after.dialog.scrollTop,400);
});
test('focus outside the reading is never stolen',()=>{
 const f=fixture([['Retained daily worker deltas (2)','usage-storage']]),outside={};const state=captureUsageReading(f.root,outside,f.dialog);restoreUsageReading(f.root,state,f.dialog,f.fallback);assert.equal(f.active,null);
});
