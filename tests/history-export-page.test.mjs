import test from 'node:test';
import assert from 'node:assert/strict';
import {historyFixture} from './helpers/history-workspace-fixture.mjs';
test('History Export freezes exactly the loaded page before dialog invalidation',async()=>{
 const f=historyFixture(),exports=[];f.s.structuredClone=structuredClone;f.s.handoffWorkspace={open:async options=>{exports.push(options);f.close();}};
 f.open();f.pending[0].resolve(f.page('alpha','history-record','Alpha'));await f.settle();assert.match(f.html(),/id="history-export"/);const original=f.s.historyPage.events;f.s.exportHistoryPage();assert.equal(exports.length,1);assert.equal(exports[0].selection.events[0].id,'history-record');assert.equal(exports[0].selection.mode,'replay');assert.equal(exports[0].returnFocus,f.node('history-open'));assert.equal(f.s.historyPage,null);original[0].outcome='changed';assert.notEqual(exports[0].selection.events[0].outcome,'changed');f.s.exportHistoryPage();assert.equal(exports.length,1);
});
