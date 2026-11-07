// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import vm from 'node:vm';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{parse}=require('espree'),source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8'),ast=parse(source,{ecmaVersion:'latest',sourceType:'module',range:true});
const definitions=ast.body.filter(n=>n.type==='FunctionDeclaration'&&['clearInspectedEvent','openInspector'].includes(n.id.name)).map(n=>source.slice(...n.range)).join('\n');
const handler=source.match(/\$\('clear-event'\)\.addEventListener\('click',[\s\S]*?;(?=\r?\n|$)/)?.[0];
function fixture({visibleEvent=true}={}){
 const focus=[],nodes=Object.fromEntries(['clear-event','inspector-dialog','announcer','clear-selection'].map(id=>[id,{id,open:true,handlers:{},addEventListener(t,f){this.handlers[t]=f;},close(){this.open=false;},show(){this.open=true;},contains(){return false;},getClientRects:()=>[{}],focus(){focus.push(id);}}]));
 const event={dataset:{event:'source-event'},getClientRects:()=>visibleEvent?[{}]:[],focus:()=>focus.push('source-event')},mobile={getClientRects:()=>[{}],focus:()=>focus.push('mobile-activity')};
 const s={selectedEvent:'source-event',selectedSession:'alpha/worker',selectedAggregate:{members:['source-event','other']},mapInspection:{title:'evidence'},mapInspectionRendered:{title:'evidence'},activityMap:{selection:'station'},records:Object.freeze([{id:'source-event'}]),preferences:Object.freeze({planeLabels:'compact'}),scope:Object.freeze({host:'alpha',project:'Alpha',search:'needle'}),replayClock:123456,pins:Object.freeze(['pin']),basket:Object.freeze(['source-event']),history:Object.freeze([{event:'earlier'}]),renders:0,$:id=>nodes[id],document:{querySelectorAll:selector=>selector==='[data-event]'?[event]:[mobile,nodes['clear-selection']],querySelector:()=>mobile},render(){s.renders++;}};
 vm.createContext(s);vm.runInContext(definitions+'\n'+handler,s);return {s,nodes,focus,click:()=>nodes['clear-event'].handlers.click()};
}
test('Clear inspected event clears event, aggregate and map inspection while retaining the lane scope',()=>{
 const f=fixture();f.click();assert.equal(f.s.selectedEvent,'');assert.equal(f.s.selectedAggregate,null);assert.equal(f.s.mapInspection,null);assert.equal(f.s.activityMap.selection,null);assert.equal(f.s.selectedSession,'alpha/worker');assert.equal(f.nodes['inspector-dialog'].open,false);assert.equal(f.s.renders,1);
});
test('clearing preserves source records, pins, basket, history, preferences, scope and replay clock',()=>{
 const f=fixture(),before=JSON.stringify([f.s.records,f.s.pins,f.s.basket,f.s.history,f.s.preferences,f.s.scope,f.s.replayClock]);f.click();assert.equal(JSON.stringify([f.s.records,f.s.pins,f.s.basket,f.s.history,f.s.preferences,f.s.scope,f.s.replayClock]),before);assert.match(f.nodes.announcer.textContent,/inspection cleared/i);
});
test('keyboard focus returns to the originating visible event and reopening does not resurrect its selection',()=>{
 const f=fixture();f.click();assert.deepEqual(f.focus,['source-event']);f.s.openInspector();assert.equal(f.nodes['inspector-dialog'].open,true);assert.equal(f.s.selectedEvent,'');f.click();assert.equal(f.s.selectedEvent,'');
});
test('a no-longer-visible inspected event returns focus to current visible navigation',()=>{
 const f=fixture({visibleEvent:false});f.click();assert.deepEqual(f.focus,['mobile-activity']);assert.equal(f.s.selectedSession,'alpha/worker');
});
