// Author: Bishop Crockett | Owner: Argellan.com | SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDotPanelModel,renderDotPanel} from '../public/companion-panel.mjs';
import {renderAccountHighlights} from '../public/account-usage.mjs';
test('Dot imports selected identity and defaults neutrally',()=>{assert.equal(buildDotPanelModel().name,'Dot');assert.equal(buildDotPanelModel({desktop:{name:' Mira '}}).name,'Mira');assert.equal(buildDotPanelModel({desktop:{name:' '}}).name,'Dot');assert.doesNotMatch(renderDotPanel(buildDotPanelModel({desktop:{name:'<script>unsafe</script>'}})),/<script>/);});
test('unconnected Dot controls stay inert without invented readiness',()=>{const html=renderDotPanel(buildDotPanelModel());for(const label of ['Call','Slack','Rename','Pause','Reboot','Delete','Mute microphone','End call'])assert.match(html,new RegExp('<button[^>]*disabled[^>]*>'+label+'</button>'));assert.match(html,/Not connected/);assert.doesNotMatch(html,/internal voice coordinator|Integration boundary|Jona/);});
test('fleet records retain their source links and stay distinct from Dot activity',()=>{const html=renderDotPanel(buildDotPanelModel({hosts:[{id:'laptop',name:'Laptop',status:'online'}],recent:[{hostId:'laptop',id:'worker',state:'Running',project:'Test'}]}));assert.match(html,/Reporting/);assert.match(html,/Fleet activity/);assert.match(html,/data-session="laptop\/worker"/);assert.match(html,/No connected Dot activity/);});
test('highlights preserve missing readings and exact reported streaks',()=>{assert.doesNotMatch(renderAccountHighlights(null),/>0(?:d)?</);assert.doesNotMatch(renderAccountHighlights({usageState:'available',summary:{}}),/NaN|undefined/);const html=renderAccountHighlights({usageState:'available',summary:{lifetimeTokens:66000000000,longestRunningTurnSec:87180,currentStreakDays:64,longestStreakDays:80}});for(const value of ['66B','24h 13m','64d','80d'])assert.ok(html.includes(value));});

test('mounted identity follows same-artwork rename and clears on sign-out',async()=>{
 const {mountCompanion}=await import('../public/companion-panel.mjs');
 const saved={document:globalThis.document,location:globalThis.location};
 const label={textContent:''},presence={textContent:''},sprite={style:{setProperty(){},backgroundImage:''},classList:{add(){},remove(){}},textContent:''};
 const button={dataset:{},querySelector:s=>s==='b'?label:s==='.jona-placeholder'?sprite:presence,setAttribute(){},addEventListener(){}};
 globalThis.document={hidden:false,addEventListener(){}};globalThis.location={origin:'https://example.test'};
 try{
  const mount=mountCompanion({button,openDetails(){},request:async()=>{throw Error('No artwork transport in identity test');}});
  const account={capabilities:{authenticated:true},viewer:{id:'viewer'},desktopCompanions:[{hostId:'desktop',name:'Mira',artworkSha256:'a'.repeat(64),rows:11,observedAt:'2026-01-01T00:00:00Z'}]};
  mount.setAccount(account);await new Promise(resolve=>setImmediate(resolve));assert.equal(label.textContent,'Mira');
  mount.setAccount({...account,desktopCompanions:[{...account.desktopCompanions[0],name:'Luna'}]});await new Promise(resolve=>setImmediate(resolve));assert.equal(label.textContent,'Luna');
  mount.setAccount({});await new Promise(resolve=>setImmediate(resolve));assert.equal(label.textContent,'Dot');
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
