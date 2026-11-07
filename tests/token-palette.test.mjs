// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {DEFAULT_TOKEN_PALETTE,TOKEN_PALETTE_OPTIONS,getTokenPalette,applyTokenPalette} from '../public/token-palette.mjs';
import {drawTokenCoin} from '../public/token-motion.mjs';

const luminance=hex=>{const rgb=hex.match(/[a-f0-9]{2}/ig).map(value=>parseInt(value,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};

test('token identity uses one immutable theme-aware mapping with input/cache subset semantics and redundant encodings',()=>{
 assert.deepEqual(Object.keys(TOKEN_PALETTE_OPTIONS),['semantic','coins']);assert.equal(DEFAULT_TOKEN_PALETTE,getTokenPalette());
 for(const [theme,colors] of Object.entries({dark:['#60A5FA','#C084FC','#2DD4BF'],light:['#1D4ED8','#7E22CE','#0F766E']})){
  const palette=getTokenPalette('semantic',theme);assert.equal(palette,getTokenPalette('semantic',theme));assert.deepEqual(palette.legend.map(series=>series.color),colors);
  assert.deepEqual(palette.legend.map(series=>series.glyph),['I','O','C']);assert.deepEqual(palette.legend.map(series=>series.pattern),['solid','dashed','dotted']);
  assert.equal(palette.series.input.field,'uncachedInputTokens');assert.equal(palette.series.cached.field,'cachedInputTokens');assert.ok(Object.isFrozen(palette)&&Object.isFrozen(palette.series)&&Object.isFrozen(palette.series.input));
 }
 assert.deepEqual(getTokenPalette('coins','dark').legend.map(series=>series.colorName),['Gold','Silver','Magenta']);assert.equal(getTokenPalette('invalid','unknown'),DEFAULT_TOKEN_PALETTE);
});

test('every token foreground clears 4.5:1 on its actual panel, hover/raised surface and marker face in both themes',async()=>{
 const css=await fs.readFile(new URL('../public/app.css',import.meta.url),'utf8');
 for(const theme of ['dark','light']){
  const block=theme==='dark'?css.match(/^:root\{([^}]+)\}/m)?.[1]:css.match(/:root\[data-theme=light\]\{([^}]+)\}/)?.[1];assert.ok(block);
  const surfaces=['panel','raised'].map(name=>block.match(new RegExp('--'+name+':(#[a-f0-9]{6})','i'))?.[1]);assert.ok(surfaces.every(Boolean));
  for(const name of ['semantic','coins']){const palette=getTokenPalette(name,theme);for(const series of palette.legend)for(const background of [...surfaces,palette.face])assert.ok(contrast(series.color,background)>=4.5,`${palette.id} ${series.label} on ${background}`);}
 }
 for(const [kind,variable] of [['input','input'],['output','output'],['cache','cached']])assert.match(css,new RegExp('\\.burn-'+kind+',\\.burn-'+kind+'>b\\{color:var\\(--token-'+variable));
 assert.match(css,/\.token-line\.token-output\{border-top-style:dashed\}/);assert.match(css,/\.token-line\.token-cached\{border-top-style:dotted\}/);
});

test('applying a token palette updates only its semantic CSS variables and avoids redundant writes',()=>{
 const writes=[],root={dataset:{theme:'dark'},style:{setProperty(name,value){writes.push([name,value]);}}};
 assert.equal(applyTokenPalette(root),DEFAULT_TOKEN_PALETTE);assert.equal(writes.length,4);assert.equal(root.dataset.tokenPalette,'semantic');applyTokenPalette(root);assert.equal(writes.length,4);
 const light=applyTokenPalette(root,'coins','light');assert.equal(root.dataset.tokenPalette,'coins');assert.deepEqual(writes.slice(-4),[['--token-input',light.series.input.color],['--token-output',light.series.output.color],['--token-cached',light.series.cached.color],['--token-face',light.face]]);
 assert.ok(writes.every(([name])=>name.startsWith('--token-')));assert.equal(root.dataset.theme,'dark');
});

test('coin sprites are keyed by actual palette and theme while repeated frames reuse the matching raster',t=>{
 const original=globalThis.OffscreenCanvas,created=[];
 globalThis.OffscreenCanvas=class{constructor(){this.inks=[];created.push(this);}getContext(){const inks=this.inks;return {scale(){},save(){},restore(){},translate(){},beginPath(){},ellipse(){},fill(){},fillText(){},set strokeStyle(value){inks.push(value);}};}};
 t.after(()=>{if(original===undefined)delete globalThis.OffscreenCanvas;else globalThis.OffscreenCanvas=original;});
 const images=[],ctx={drawImage(sprite){images.push(sprite);}};
 for(const name of ['semantic','coins'])for(const theme of ['dark','light']){const palette=getTokenPalette(name,theme);drawTokenCoin(ctx,10,20,'input',0,{vivid:false,palette});assert.ok(images.at(-1).inks.includes(palette.series.input.color));}
 assert.equal(created.length,4);assert.equal(new Set(images).size,4);drawTokenCoin(ctx,10.25,20.75,'input',0,{vivid:false,palette:DEFAULT_TOKEN_PALETTE});assert.equal(created.length,4);assert.equal(images.at(-1),images[0]);
});

test('warming several appearances evicts inactive sprite poses while the current appearance remains reusable',t=>{
 const original=globalThis.OffscreenCanvas;let created=0;
 globalThis.OffscreenCanvas=class{constructor(){created++;}getContext(){return {scale(){},save(){},restore(){},translate(){},beginPath(){},ellipse(){},fill(){},fillText(){}};}};
 t.after(()=>{if(original===undefined)delete globalThis.OffscreenCanvas;else globalThis.OffscreenCanvas=original;});
 const ctx={drawImage(){}};
 for(const name of ['semantic','coins'])for(const theme of ['dark','light'])for(const kind of ['input','output','cached'])for(let pose=0;pose<24;pose++)drawTokenCoin(ctx,0,0,kind,pose/72,{vivid:true,palette:getTokenPalette(name,theme)});
 const warmed=created;drawTokenCoin(ctx,0,0,'cached',23/72,{vivid:true,palette:getTokenPalette('coins','light')});assert.equal(created,warmed);
 drawTokenCoin(ctx,0,0,'input',0,{vivid:true,palette:getTokenPalette('semantic','dark')});assert.equal(created,warmed+1,'The oldest appearance was evicted instead of accumulating indefinitely');
});
