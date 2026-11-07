// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {EventStore} from '../public/event-model.mjs';
const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
const fn=name=>source.match(new RegExp('^function '+name+'\\(.*$','m'))[0];
test('one control returns replay to live, retains buffered records and preserves motion pause',()=>{
 const store=new EventStore(),at=new Date().toISOString();store.ingest({observedAt:at,events:[{id:'first',sessionId:'worker',kind:'message',at}],sessions:[],hosts:[]});
 let renders=0,remembered=0;const button={textContent:'',attrs:{},getAttribute(k){return this.attrs[k];},setAttribute(k,v){this.attrs[k]=v;},classList:{toggle(){}}};
 const c=vm.createContext({store,$:()=>button,investigation:{remember(){remembered++;}},motionPaused:true,pausedAt:0,render(){renders++;},replay(){store.enterReplay();},Date});
 for(const n of ['syncReplayControl','returnToLive','toggleReplay'])vm.runInContext(fn(n),c);
 c.syncReplayControl();assert.equal(button.attrs['aria-label'],'Replay');
 c.toggleReplay();c.syncReplayControl();assert.equal(store.mode,'replay');assert.equal(button.textContent,'Return to live');
 store.ingest({observedAt:at,events:[{id:'buffered',sessionId:'worker',kind:'message',at}],sessions:[],hosts:[]});assert.equal(store.frozen.length,1);
 c.toggleReplay();c.syncReplayControl();assert.equal(store.mode,'live');assert.equal(button.attrs['aria-label'],'Replay');assert.ok(store.events.has('buffered'));assert.equal(store.frozen,null);assert.equal(c.motionPaused,true);assert.ok(c.pausedAt>0);assert.equal(remembered,1);assert.equal(renders,1);
});
test('Flow omits the timeline while Ribbon and the separate mobile Activity view retain it',()=>{
 const c=vm.createContext({preferences:{flowView:'map'},adaptiveViewport:{matches:false},document:{documentElement:{dataset:{mobileView:'activity'}}}});vm.runInContext(fn('timelineForCurrentView'),c);
 assert.equal(c.timelineForCurrentView(),false);c.preferences.flowView='curtain';assert.equal(c.timelineForCurrentView(),true);c.preferences.flowView='map';c.adaptiveViewport.matches=true;assert.equal(c.timelineForCurrentView(),true);c.document.documentElement.dataset.mobileView='overview';assert.equal(c.timelineForCurrentView(),false);
});
test('Inspector refresh keeps disclosure, scroll and keyboard focus only for the same worker',()=>{
 const document={activeElement:null};let details=null,summary=null,writes=0;
 const element={scrollTop:0,querySelector(selector){return selector.endsWith('summary')?summary:details;},set innerHTML(value){writes++;details={open:false};summary={focus(){document.activeElement=summary;}};}};
 const c=vm.createContext({$:()=>element,document,workerInspectorIdentity:null,workerInspectorHTML:null});vm.runInContext(fn('updateWorkerInspector'),c);
 c.updateWorkerInspector('first','host/worker');details.open=true;element.scrollTop=96;document.activeElement=summary;
 c.updateWorkerInspector('updated','host/worker');assert.equal(details.open,true);assert.equal(element.scrollTop,96);assert.equal(document.activeElement,summary);
 const rendered=writes;c.updateWorkerInspector('updated','host/worker');assert.equal(writes,rendered);
 c.updateWorkerInspector('other','host/different-worker');assert.equal(details.open,false);assert.equal(element.scrollTop,0);
});
test('metric updates retain button identity and selection focus across count and palette changes',()=>{
 function node(){const props=new Map();return {children:[],dataset:{},attrs:{},textContent:'',style:{getPropertyValue:k=>props.get(k),setProperty:(k,v)=>props.set(k,v)},append(...nodes){this.children.push(...nodes);},get firstElementChild(){return this.children[0];},get lastElementChild(){return this.children.at(-1);},get firstChild(){return this.children[0]??null;},get previousElementSibling(){return this.parentElement?.children[this.parentElement.children.indexOf(this)-1]??null;},get nextSibling(){return this.parentElement?.children[this.parentElement.children.indexOf(this)+1]??null;},insertBefore(child,before){child.remove();const i=before?this.children.indexOf(before):this.children.length;this.children.splice(i,0,child);child.parentElement=this;},remove(){if(this.parentElement){this.parentElement.children.splice(this.parentElement.children.indexOf(this),1);this.parentElement=null;}},getAttribute(k){return this.attrs[k];},setAttribute(k,v){this.attrs[k]=v;}};}
 const container=node(),c=vm.createContext({metricNodes:new Map(),$:()=>container,document:{createElement:node},compact:String,Map,Set});vm.runInContext(fn('updateMetricStrip'),c);
 const values=[['sessions',9,'Recorded sessions','retained inventory','#fff'],['rate',99,'Events / min','source records','#abc']];c.updateMetricStrip(values);const buttons=[...container.children],focused=buttons[1];
 for(let i=0;i<30;i++)c.updateMetricStrip([values[0],['rate',100+i,'Events / min','source records','#def']]);
 assert.equal(container.children[0],buttons[0]);assert.equal(container.children[1],focused);assert.equal(focused.firstElementChild.textContent,'129');assert.equal(focused.dataset.metric,'rate');assert.equal(focused.attrs['aria-label'],'Inspect Events / min: 129. source records');assert.equal(focused.style.getPropertyValue('--accent'),'#def');
});
