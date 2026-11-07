// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';

const symbols=await import('../public/map-symbols.mjs').catch(()=>({}));
const worker=(id,extra={})=>({id:'worker:source/'+id,sessionId:id,hostId:'source',type:'worker',label:'Codex · '+id.slice(0,8),...extra});
const identity=node=>{assert.equal(typeof symbols.stationIdentity,'function','station identity projection is available');return symbols.stationIdentity(node);};
const symbol=(node,options)=>{assert.equal(typeof symbols.stationSymbol,'function','station symbols are available');return symbols.stationSymbol(node,options);};

test('workers with the same timestamp prefix show their distinguishing source identity suffix',()=>{
 const a=identity(worker('11111111-2222-4333-8444-555555abcdef'));
 const b=identity(worker('11111111-2222-4333-8444-555555654321'));
 assert.equal(a.shortId,'abcdef');assert.equal(b.shortId,'654321');
 assert.equal(a.label,'Codex · abcdef');assert.equal(b.label,'Codex · 654321');
 assert.equal(a.monogram,'CDEF');assert.equal(b.monogram,'4321');assert.equal(a.roleLabel,'Worker');
});

test('actual worker nicknames are preserved and stable identity colors ignore transient activity',()=>{
 const node=worker('11111111-2222-4333-8444-555555abcdef',{type:'subagent',label:'Ada Lovelace'}),a=identity(node);
 assert.equal(a.label,'Ada Lovelace');assert.equal(a.monogram,'AL');assert.equal(a.roleLabel,'Subagent');
 assert.equal(identity({...node,label:'Different nickname',status:'failed',lastAt:1234}).color,a.color);
 assert.match(a.color,/^#[a-f0-9]{6}$/i);
});

test('the same session on different hosts has a source-qualified stable accent',()=>{
 const a=identity(worker('same-session',{hostId:'host-a',id:'worker:host-a/same-session'}));
 const b=identity(worker('same-session',{hostId:'host-b',id:'worker:host-b/same-session'}));
 assert.notEqual(a.color,b.color);assert.deepEqual(a,identity(worker('same-session',{hostId:'host-a',id:'worker:host-a/same-session'})));
});

test('worker, subagent and human stations have distinct recognizable silhouettes',()=>{
 const bot=symbol(worker('abcdef')),child=symbol(worker('abcdef',{type:'subagent'})),human=symbol({type:'human',label:'Human review'});
 assert.match(bot,/data-symbol="robot"/);assert.match(child,/data-symbol="subagent"/);assert.match(human,/data-symbol="human"/);
 assert.notEqual(bot,child);assert.notEqual(child,human);
 for(const svg of [bot,child,human]){assert.match(svg,/viewBox="0 0 24 24"/);assert.match(svg,/aria-hidden="true"/);assert.match(svg,/stroke-width="1\.65"/);assert.match(svg,/currentColor/);}
});

test('explicit fleet device classes retain their category shapes and category colors',()=>{
 const classes=['laptop','workstation','rack-server','raspberry-pi','edge','cloud'];
 const shapes=classes.map(deviceClass=>symbol({id:'host:x',type:'host',deviceClass,label:'Example'}));
 assert.equal(new Set(shapes).size,classes.length);
 assert.equal(identity({type:'host',icon:'raspberry-pi',label:'Example'}).roleLabel,'Raspberry Pi');
 assert.notEqual(identity({type:'host',icon:'laptop'}).color,identity({type:'host',icon:'rack-server'}).color);
});

test('unclassified hosts stay unclassified even when their names suggest a Pi or rack',()=>{
 const unknown={id:'host:pi-rack-ubuntu',type:'host',label:'Raspberry Pi rack server',icon:'invented-class'};
 assert.equal(identity(unknown).roleLabel,'Unclassified device');assert.match(symbol(unknown),/data-symbol="device-unknown"/);
 assert.equal(identity({...unknown,deviceClass:'unknown',icon:'laptop'}).roleLabel,'Unclassified device');
});

test('tool interfaces have different semantic symbols without inferring services from arbitrary labels',()=>{
 const roles=['terminal','file','browser','search','github','branch','tool'];
 const shapes=roles.map(icon=>symbol({id:'service:'+icon,type:'service',icon,label:'Observed interface'}));
 assert.equal(new Set(shapes).size,roles.length);
 assert.match(shapes[4],/>GH<\/text>/);assert.match(shapes[5],/data-symbol="branch"/);
 assert.equal(identity({type:'service',icon:'tool',label:'github inside arbitrary command'}).roleLabel,'Tool interface');
});

test('untrusted identity strings and color values cannot inject SVG attributes or markup',()=>{
 const node=worker('abc"><script>alert(1)</script>',{label:'<img src=x onerror="alert(1)">',color:'red" onload="alert(1)'}),svg=symbol(node,{size:'30" onload="alert(2)'});
 assert.ok(!svg.includes('<script'));assert.ok(!svg.includes('<img'));assert.ok(!svg.includes('onload'));assert.ok(!svg.includes('onerror'));
 assert.match(identity(node).color,/^#[a-f0-9]{6}$/i);assert.match(svg,/width="30" height="30"/);
 assert.equal(identity(node).label,'<img src=x onerror="alert(1)">');
});

test('missing source identity is explicit and icon dimensions are bounded',()=>{
 const value=identity({type:'worker'});assert.equal(value.label,'Unidentified worker');assert.equal(value.shortId,'');assert.equal(value.monogram,'?');
 assert.match(symbol(null,{size:1}),/width="12" height="12"/);assert.match(symbol(null,{size:10000}),/width="96" height="96"/);
 assert.equal(identity(null).roleLabel,'Unclassified station');
});
