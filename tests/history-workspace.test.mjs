// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {historyFixture as fixture} from './helpers/history-workspace-fixture.mjs';
test('pending Alpha History cannot publish under a reopened Beta scope even if cancellation is ignored',async()=>{
 const f=fixture();f.open();const alpha=f.pending[0];f.close();f.state.hostId='beta';f.state.project='Beta';f.open();alpha.resolve(f.page('alpha'));await f.settle();assert.doesNotMatch(f.html(),/TEST_ONLY alpha/);assert.equal(f.s.historyPage,null);
});
test('newer Beta completion wins when earlier Alpha completes last',async()=>{
 const f=fixture();f.open();const alpha=f.pending[0];f.close();f.state.hostId='beta';f.state.project='Beta';f.open();const beta=f.pending.find(p=>new URL(p.url,'http://test').searchParams.get('hostId')==='beta');assert.ok(beta,'new scope must issue its own History query');beta.resolve(f.page('beta'));await f.settle();alpha.resolve(f.page('alpha'));await f.settle();assert.match(f.html(),/TEST_ONLY beta/);assert.doesNotMatch(f.html(),/TEST_ONLY alpha/);assert.equal(f.s.historyPage.events[0].id,'beta');
});
test('same-scope close/reopen also fences the previous request generation',async()=>{
 const f=fixture();f.open();const first=f.pending[0];f.close();f.open();assert.ok(f.pending[1],'reopened History needs a new generation');f.pending[1].resolve(f.page('alpha','new-generation'));await f.settle();first.resolve(f.page('alpha','old-generation'));await f.settle();assert.match(f.html(),/new-generation/);assert.doesNotMatch(f.html(),/old-generation/);
});
test('reversed project completions do not cross project scope',async()=>{
 const f=fixture();f.open();const first=f.pending[0];f.close();f.state.project='Beta';f.open();const next=f.pending.find(p=>new URL(p.url,'http://test').searchParams.get('project')==='Beta');assert.ok(next,'project scope must start a new request');next.resolve(f.page('alpha','beta-project','Beta'));await f.settle();first.resolve(f.page('alpha','alpha-project','Alpha'));await f.settle();assert.equal(f.s.historyPage.events[0].project,'Beta');
});
test('a stale History error cannot replace a newer successful page',async()=>{
 const f=fixture();f.open();const first=f.pending[0];f.close();f.open();assert.ok(f.pending[1]);f.pending[1].resolve(f.page('alpha','new-success'));await f.settle();first.reject(Object.assign(Error('old read failed'),{status:503}));await f.settle();assert.match(f.html(),/new-success/);assert.doesNotMatch(f.html(),/unavailable from this source/);
});
test('current read error is explicit and a deliberate retry loads current records',async()=>{
 const f=fixture();f.open();f.pending[0].reject(Object.assign(Error('synthetic unavailable'),{status:503}));await f.settle();assert.match(f.html(),/unavailable from this source/);const retry=f.s.loadHistory();assert.equal(new URL(f.pending[1].url,'http://test').searchParams.get('hostId'),'alpha');f.pending[1].resolve(f.page('alpha','retry-success'));await retry;assert.match(f.html(),/retry-success/);assert.doesNotMatch(f.html(),/unavailable from this source/);
});
test('known authority change prevents an old History response from publishing or replaying',async()=>{
 const f=fixture();f.open();f.s.snapshot.viewer.permissionStamp='b'.repeat(64);f.pending[0].resolve(f.page('alpha','old-authority'));await f.settle();assert.equal(f.s.historyPage,null);assert.doesNotMatch(f.html(),/old-authority/);f.s.replayHistoryRecord(0);assert.equal(f.s.store.replayed,undefined);
});
test('lost authorization clears a cached History page before replay',async()=>{
 const f=fixture();f.open();f.pending[0].resolve(f.page('alpha'));await f.settle();f.s.snapshotAuthorized=false;f.s.replayHistoryRecord(0);assert.equal(f.s.store.replayed,undefined);assert.equal(f.s.historyPage,null);
});
test('History cannot overwrite an unrelated details dialog after a close or replacement',async()=>{
 const f=fixture();f.open();f.s.openDetails('Other evidence','<p>Other record</p>');f.pending[0].resolve(f.page('alpha'));await f.settle();assert.equal(f.node('detail-title').textContent,'Other evidence');assert.match(f.html(),/Other record/);assert.doesNotMatch(f.html(),/TEST_ONLY alpha/);
});

for(const status of [401,403])test('current History '+status+' invalidates cached records, closes the view and prevents replay',async()=>{
 const f=fixture();f.open();f.pending[0].reject(Object.assign(Error('denied'),{status}));await f.settle();assert.equal(f.node('detail-dialog').open,false);assert.equal(f.s.historyPage,null);assert.equal(f.s.snapshotAuthorized,false);f.s.replayHistoryRecord(0);assert.equal(f.s.store.replayed,undefined);assert.equal(f.s.investigation.invalidated,true);
});
test('Alpha/Beta/Alpha rapid generations ignore every stale completion and late denial',async()=>{
 const f=fixture();f.open();const first=f.pending[0];f.close();f.state.hostId='beta';f.open();const beta=f.pending[1];f.close();f.state.hostId='alpha';f.open();f.pending[2].resolve(f.page('alpha','last-alpha'));await f.settle();beta.reject(Object.assign(Error('old denial'),{status:403}));first.resolve(f.page('alpha','first-alpha'));await f.settle();assert.match(f.html(),/last-alpha/);assert.doesNotMatch(f.html(),/first-alpha/);assert.equal(f.s.snapshotAuthorized,true);assert.equal(f.s.historyBusy,false);
});
