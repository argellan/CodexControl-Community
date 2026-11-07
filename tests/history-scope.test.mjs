// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {historyFixture} from './helpers/history-workspace-fixture.mjs';
test('History scopes the archive and explicitly discloses unapplied workspace search/category',async()=>{
 const f=historyFixture();f.state.search='TEST_ONLY_NO_MATCH';f.state.category='research';f.open();f.pending[0].resolve(f.page('alpha','unrelated-command','Alpha'));await f.settle();
 const caption=f.html().match(/<p class="scope-note">([^<]*)/)[1];assert.doesNotMatch(caption,/TEST_ONLY_NO_MATCH|research/);assert.match(caption,/Archive scope: alpha · Alpha · All workers/);assert.match(f.html(),/Workspace search “TEST_ONLY_NO_MATCH” and category “research” are not applied to retained History/);
 const query=new URL(f.pending[0].url,'http://test');assert.equal(query.searchParams.get('search'),null);assert.equal(query.searchParams.get('category'),null);assert.match(f.html(),/unrelated-command/);assert.equal(f.state.search,'TEST_ONLY_NO_MATCH');assert.equal(f.state.category,'research');
});
test('combined scope/search replacement clears old History and discloses only current unapplied filters',async()=>{
 const f=historyFixture();f.state.search='old-search';f.open();const old=f.pending[0];f.close();Object.assign(f.state,{hostId:'beta',project:'Beta',search:'new-search'});f.open();f.pending[1].resolve(f.page('beta'));await f.settle();old.resolve(f.page('alpha'));await f.settle();
 assert.match(f.html(),/Archive scope: beta · Beta/);assert.match(f.html(),/Workspace search “new-search” is not applied to retained History/);assert.doesNotMatch(f.html(),/old-search|TEST_ONLY alpha/);
});
test('empty archive and filter reset retain truthful captions without changing basket or context trail',async()=>{
 const f=historyFixture();f.s.investigation.basket=['pin-alpha'];f.s.investigation.history=['earlier'];f.state.search='no-match';f.open();f.pending[0].resolve({...f.page('alpha'),events:[],caughtUp:true});await f.settle();assert.match(f.html(),/No records in the selected archive scope/);assert.match(f.html(),/not applied/);
 f.close();Object.assign(f.state,{hostId:'',project:'',search:'',category:''});f.open();f.pending[1].resolve({...f.page('alpha'),events:[],caughtUp:true});await f.settle();assert.match(f.html(),/Archive scope: All hosts · All projects · All workers/);assert.doesNotMatch(f.html(),/Workspace search/);assert.deepEqual(f.s.investigation.basket,['pin-alpha']);assert.deepEqual(f.s.investigation.history,['earlier']);
});
test('unrelated detail captions retain their established workspace search scope',()=>{
 const f=historyFixture();f.state.search='workspace-only';f.s.openDetails('Other evidence','<p>Context</p>');assert.match(f.html(),/workspace-only/);
});
