// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {TokenMotion,TOKEN_KINDS,projectTokenChannels,drawTokenCoin} from '../public/token-motion.mjs';

const now=Date.parse('2026-10-20T20:00:00Z');
const row=(sequence,extra={})=>({sequence,id:'u:'+sequence,hostId:'source',sessionId:'worker',project:'Project',provider:'openai',sourceAt:new Date(now).toISOString(),receivedAt:new Date(now).toISOString(),intervalMs:2000,status:'delta',inputTokens:1100,cachedInputTokens:1000,uncachedInputTokens:100,outputTokens:25,...extra});
const payload=(sequence,rows=[row(sequence)])=>({burnUsage:{epoch:'journal-epoch',lastSequence:sequence,inputTokens:1100,cachedInputTokens:1000,uncachedInputTokens:100,outputTokens:25,windowMs:60000},usageHistory:{observations:rows}});
const storage=()=>{const values=new Map();return {values,get length(){return values.size;},key:index=>[...values.keys()][index]??null,getItem:key=>values.get(String(key))??null,setItem:(key,value)=>values.set(String(key),String(value)),removeItem:key=>values.delete(String(key))};};
const primed=()=>{const motion=new TokenMotion();motion.feed(payload(1),{now});return motion;};

test('initial response and browser refresh prime the durable watermark instead of replaying retained deltas',()=>{
 const saved=storage(),motion=new TokenMotion({storage:saved});motion.feed(payload(10),{now});assert.equal(motion.frame(now+500).length,0);
 motion.feed(payload(11),{now:now+1000});assert.ok(motion.frame(now+1500).length>0);assert.equal(saved.values.size,1);assert.ok([...saved.values.values()].every(value=>/^\d+$/.test(value)));
 const refreshed=new TokenMotion({storage:saved});refreshed.feed(payload(11),{now:now+1500});assert.equal(refreshed.frame(now+2000).length,0);
 refreshed.feed(payload(12),{now:now+2000});assert.ok(refreshed.frame(now+2500).length>0);
});

test('one committed observation emits weighted input, output and cached batches once across repeated polls',()=>{
 const motion=primed();motion.feed(payload(2),{now:now+100});const before=motion.packets.map(packet=>packet.id);assert.ok(before.length>0);assert.deepEqual(new Set(motion.packets.map(packet=>packet.kind)),new Set(['input','output','cached']));
 assert.equal(motion.packets.find(packet=>packet.kind==='input').amount,100);assert.equal(TOKEN_KINDS.input.field,'uncachedInputTokens');assert.notEqual(TOKEN_KINDS.input.color,TOKEN_KINDS.cached.color);
 motion.feed(payload(2),{now:now+600});assert.deepEqual(motion.packets.map(packet=>packet.id),before);assert.ok(motion.frame(now+700).every(packet=>packet.progress>0));assert.equal(motion.frame(now+4000).length,0);
 motion.feed(payload(2),{now:now+4100});assert.equal(motion.frame(now+4300).length,0);
});

test('out-of-order, stale, future, reset, baseline and unknown-provider records never create traffic',()=>{
 const motion=primed(),rows=[row(2,{status:'baseline'}),row(3,{status:'reset'}),row(4,{status:'gap'}),row(5,{status:'out-of-order'}),row(6,{status:'future'}),row(7,{status:'stale'}),row(8,{provider:'unknown'}),row(9,{receivedAt:new Date(now-16000).toISOString()}),row(10,{sourceAt:new Date(now-121000).toISOString()}),row(11,{receivedAt:new Date(now+3000).toISOString()}),row(12,{sourceAt:new Date(now+3000).toISOString()})];
 motion.feed(payload(12,rows),{now});assert.equal(motion.frame(now+500).length,0);motion.feed(payload(2),{now});assert.equal(motion.frame(now+600).length,0);assert.equal(motion.cursor,12);assert.equal(motion.sequence,12);assert.equal(motion.rows.at(-1).sequence,12);
});

test('partial observations animate only known nonnegative exact fields and never invent missing amounts',()=>{
 const motion=primed();motion.feed(payload(2,[row(2,{status:'partial',uncachedInputTokens:null,cachedInputTokens:20,outputTokens:-4})]),{now});assert.deepEqual(new Set(motion.packets.map(packet=>packet.kind)),new Set(['cached']));
});

test('only source and receipt observations at most 15 seconds old can launch a live batch',()=>{
 for(const field of ['sourceAt','receivedAt']){
  const fresh=primed();fresh.feed(payload(2,[row(2,{[field]:new Date(now-15000).toISOString()})]),{now});assert.ok(fresh.packets.length>0,field+' at the freshness boundary is valid');
  const stale=primed();stale.feed(payload(2,[row(2,{[field]:new Date(now-15001).toISOString()})]),{now});assert.equal(stale.packets.length,0,field+' one millisecond beyond the boundary is retained only');
 }
 const backfill=primed();backfill.feed(payload(2,[row(2,{sourceAt:new Date(now-75000).toISOString(),receivedAt:new Date(now).toISOString()})]),{now});assert.equal(backfill.packets.length,0);
});

test('replay and resuming live discard live traffic; source replay never uses current usage batches',()=>{
 const motion=primed();motion.feed(payload(2),{now});assert.ok(motion.frame(now+500).length);assert.equal(motion.frame(now+600,{mode:'replay'}).length,0);
 motion.feed(payload(3),{now:now+700,mode:'replay'});assert.equal(motion.frame(now+900,{mode:'replay'}).length,0);assert.equal(motion.frame(now+1000,{mode:'live'}).length,0);
 motion.feed(payload(4),{now:now+1100});assert.equal(motion.frame(now+1500).length,0);motion.feed(payload(5),{now:now+1600});assert.ok(motion.frame(now+2000).length);
});

test('scope and epoch changes prime separately; malformed payload and reconnect cannot replay an old batch',()=>{
 const motion=primed();motion.feed(payload(2),{now});assert.ok(motion.packets.length);motion.feed(payload(3),{now,scope:'filtered'});assert.equal(motion.packets.length,0);
 motion.feed({...payload(1),burnUsage:{...payload(1).burnUsage,epoch:'new-epoch'}},{now,scope:'filtered'});assert.equal(motion.packets.length,0);assert.equal(motion.cursor,1);
 motion.feed({}, {now});assert.equal(motion.rows.length,0);motion.feed(payload(10),{now});assert.equal(motion.packets.length,0);
});

test('reduced motion and pause consume observations and resume from a fresh baseline',()=>{
 for(const flag of ['reduced','paused']){const motion=primed();motion.feed(payload(2),{now,[flag]:true});assert.equal(motion.frame(now+500,{[flag]:true}).length,0);motion.feed(payload(3),{now:now+1000});assert.equal(motion.packets.length,0);motion.feed(payload(4),{now:now+1500});assert.ok(motion.frame(now+2000).length);
  motion.frame(now+2100,{[flag]:true});motion.frame(now+2200);motion.feed(payload(5),{now:now+2300});assert.equal(motion.packets.length,0);
 }
});

test('a burst and duplicate rows remain bounded to 48 packets without expanding token counts',()=>{
 const motion=primed(),rows=Array.from({length:1000},(_,i)=>row(i+2,{uncachedInputTokens:1000000,cachedInputTokens:20000000,outputTokens:100000000}));motion.feed(payload(1001,[...rows,...rows]),{now});assert.ok(motion.packets.length<=48);assert.ok(motion.rows.length<=512);assert.equal(new Set(motion.packets.map(packet=>packet.id)).size,motion.packets.length);assert.ok(motion.frame(now+1000).length<=48);
});

test('unavailable storage does not break the observation feed',()=>{
 const motion=new TokenMotion({storage:{getItem(){throw Error('unavailable');},setItem(){throw Error('unavailable');}}});motion.feed(payload(1),{now});motion.feed(payload(2),{now});assert.ok(motion.packets.length>0);
});

test('session storage remains capped at 32 numeric watermarks across many scopes while unrelated credentials survive',()=>{
 const saved=storage(),prefix='codexcontrol-token-cursor-v1:';saved.setItem('credential','private-access-value');saved.setItem('argellan-codex-display-v1','private-settings');saved.setItem('codexcontrol-token-other','unrelated');
 for(let i=0;i<40;i++)saved.setItem(prefix+'legacy-'+i,String(i));const motion=new TokenMotion({storage:saved});
 for(let i=0;i<80;i++){motion.feed(payload(i+1),{now,scope:'host/session/'+i});assert.equal([...saved.values.keys()].filter(key=>key.startsWith(prefix)).length,32);assert.equal(saved.getItem(motion.key),String(i+1));}
 assert.equal(saved.getItem('credential'),'private-access-value');assert.equal(saved.getItem('argellan-codex-display-v1'),'private-settings');assert.equal(saved.getItem('codexcontrol-token-other'),'unrelated');assert.ok([...saved.values].filter(([key])=>key.startsWith(prefix)).every(([key,value])=>/^\d+$/.test(value)&&!key.includes('host/session')));
});

test('throwing storage enumeration or removal disables persistence without breaking animation',()=>{
 for(const method of ['length','key','removeItem']){const saved=storage(),prefix='codexcontrol-token-cursor-v1:';for(let i=0;i<40;i++)saved.setItem(prefix+i,String(i));if(method==='length')Object.defineProperty(saved,'length',{get(){throw Error('blocked');}});else saved[method]=()=>{throw Error('blocked');};const motion=new TokenMotion({storage:saved});motion.feed(payload(1),{now});motion.feed(payload(2),{now});assert.ok(motion.packets.length>0);}
});

test('usage channels join only explicit OpenAI/Codex worker identities and never reuse target or tool routes',()=>{
 const layout={width:900,height:480,nodes:[{node:{id:'worker:source/worker',type:'worker'},x:250,y:220,radius:22},{node:{id:'host:target',type:'host'},x:700,y:220,radius:18},{node:{id:'service:github',type:'service'},x:650,y:120,radius:18}],routes:[{id:'unrelated-github',curve:[[1,2],[3,4],[5,6],[7,8]]}]};
 const result=projectTokenChannels(layout,[row(2),row(3,{sessionId:'not-shown'}),row(4,{provider:'unknown'})]);assert.equal(result.channels.length,1);assert.equal(result.mapped,1);assert.equal(result.unmapped,2);assert.ok(result.anchor);assert.notDeepEqual(result.channels[0].input,layout.routes[0].curve);assert.ok(result.channels[0].input[0][0]<400);assert.ok(result.channels[0].output.at(-1)[0]<400);
 assert.equal(projectTokenChannels(layout,[row(2,{provider:'unknown'})]).anchor,null);layout.nodes[0].hidden=true;assert.equal(projectTokenChannels(layout,[row(2)]).channels.length,0);
});

test('coin painter retains distinct letter glyphs as well as color and uses bounded canvas primitives',()=>{
 const calls=[],ctx={save(){},restore(){},translate(...args){calls.push(['translate',...args]);},beginPath(){},ellipse(...args){calls.push(['ellipse',...args]);},fill(){},fillText(text){calls.push(['glyph',text]);}};
 for(const kind of Object.keys(TOKEN_KINDS))drawTokenCoin(ctx,10,20,kind,0);assert.deepEqual(calls.filter(call=>call[0]==='glyph').map(call=>call[1]),['I','O','C']);assert.equal(calls.filter(call=>call[0]==='ellipse').length,6);
});

test('overlay packet visits reuse captured identities while the value-returning frame helper remains isolated',()=>{
 const motion=primed();motion.feed(payload(2),{now:now+100});const identities=[...motion.packets],visited=[];
 assert.equal(motion.hasPending(now+600),true);motion.visitFrame(now+600,{},(packet,progress)=>{visited.push(packet);assert.ok(progress>=0&&progress<1);assert.ok(identities.includes(packet));assert.equal(Object.hasOwn(packet,'progress'),false);});
 assert.ok(visited.length>0);const values=motion.frame(now+600);assert.ok(values.every(value=>!identities.includes(value)&&Number.isFinite(value.progress)));
 assert.equal(motion.hasPending(now+5000),false);assert.equal(motion.packets.length,0);assert.equal(motion.cursor,2);
});

test('a cached coin pose reuses its offscreen raster while position remains continuous and kinds stay distinct',t=>{
 const original=globalThis.OffscreenCanvas,created=[],glyphs=[];
 globalThis.OffscreenCanvas=class{constructor(width,height){this.width=width;this.height=height;created.push(this);}getContext(){return {scale(){},save(){},restore(){},translate(){},beginPath(){},ellipse(){},fill(){},fillText(value){glyphs.push(value);}};}};
 t.after(()=>{if(original===undefined)delete globalThis.OffscreenCanvas;else globalThis.OffscreenCanvas=original;});
 const images=[],ctx={drawImage(...args){images.push(args);}};
 drawTokenCoin(ctx,10,20,'input',0,{vivid:false});drawTokenCoin(ctx,10.25,20.75,'input',.0001,{vivid:false});
 assert.equal(created.length,1);assert.equal(images[0][0],images[1][0]);assert.equal(images[1][1]-images[0][1],.25);assert.equal(images[1][2]-images[0][2],.75);
 drawTokenCoin(ctx,10,20,'input',.5,{vivid:false});assert.equal(created.length,2);drawTokenCoin(ctx,10,20,'cached',0,{vivid:false});assert.equal(created.length,3);assert.deepEqual(glyphs,['I','C']);
 assert.ok(created.every(sprite=>sprite.width===64&&sprite.height===64));
});
