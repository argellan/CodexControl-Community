// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('local error capture persists only fixed categories and bounded stack identifiers', async () => {
  const moduleURL = new URL('../lib/diagnostics-privacy.mjs', import.meta.url);
  assert.equal(await fs.access(moduleURL).then(() => true, () => false), true,
    'bounded pre-persistence diagnostics capture must be implemented');
  const {LocalDiagnostics} = await import(moduleURL);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-private-diagnostics-'));
  try {
    const diagnostics = await LocalDiagnostics.open({directory});
    const canary = 'CANARY_SECRET person@example.invalid C:\\Synthetic\\private.txt https://example.invalid/?token=secret';
    await diagnostics.capture({kind: 'backend', category: 'unexpected', error: new Error(canary), stack: canary, prompt: canary});
    const preview = diagnostics.preview();
    assert.equal(preview.includes(canary), false);
    assert.equal(preview.includes('example.invalid'), false);
    assert.equal(preview.includes('Synthetic'), false);
    assert.equal(JSON.parse(preview).events[0].category, 'unexpected');
    const saved = await fs.readFile(path.join(directory, 'diagnostics.json'), 'utf8');
    assert.equal(saved.includes('example.invalid'), false);
    assert.equal(saved.includes('private.txt'), false);
    await diagnostics.close();
  } finally {
    await fs.rm(directory, {recursive: true, force: true});
  }
});
test('local retention bounds count and bytes, physically expires saved events, and marks only unclean close',async()=>{
  const {LocalDiagnostics}=await import('../lib/diagnostics-privacy.mjs');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-diagnostics-retention-'));let d;let now=0;
  try{
    d=await LocalDiagnostics.open({directory,now:()=>now});
    for(let batch=0;batch<6;batch++){now+=1000;await Promise.all(Array.from({length:20},()=>d.capture({kind:'backend',category:'unexpected',site:'backend:request'})));}
    assert.equal(JSON.parse(d.preview()).events.length,100);
    assert.ok((await fs.stat(path.join(directory,'diagnostics.json'))).size<=65536);
    await d.close();now+=8*86400000;
    d=await LocalDiagnostics.open({directory,now:()=>now});await d.flush();
    assert.equal(JSON.parse(await fs.readFile(path.join(directory,'diagnostics.json'),'utf8')).events.length,0,'expired local diagnostics must leave saved files');
    const unclean=await LocalDiagnostics.open({directory,now:()=>now});
    const events=JSON.parse(unclean.preview()).events;assert.equal(events.length,1);assert.equal(events[0].kind,'unclean-shutdown');assert.equal(events[0].category,'unclean-shutdown');
    await unclean.close();await d.close();
  }finally{await d?.close();await fs.rm(directory,{recursive:true,force:true});}
});