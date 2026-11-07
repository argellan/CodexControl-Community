// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {historyFixture} from './helpers/history-workspace-fixture.mjs';
process.env.TZ='America/New_York';
const requestBefore=f=>new URL(f.pending.at(-1).url,'http://test').searchParams.get('before');
async function ready(){const f=historyFixture();f.open();f.pending[0].resolve(f.page('alpha'));await f.settle();return f;}
for(const [label,instant,want] of [
 ['winter','2001-01-01T05:00:00.123Z','2001-01-01T00:00:00.123'],
 ['summer','2026-07-15T16:30:45.789Z','2026-07-15T12:30:45.789']
])test(label+' cursor display and unchanged Load preserve the selected instant and milliseconds',async()=>{
 const f=await ready();f.s.historyBefore=instant;f.s.showHistoryPage();assert.equal(f.node('history-before').value,want);
 const loading=f.s.loadHistory();assert.equal(requestBefore(f),instant);f.pending.at(-1).resolve(f.page('alpha'));await loading;assert.equal(f.node('history-before').value,want);
});
test('UTC cursor presentation does not apply the browser local offset',async()=>{
 const f=await ready();f.s.historyTimezone='utc';f.s.historyBefore='2026-01-15T05:30:00.250Z';f.s.showHistoryPage();assert.equal(f.node('history-before').value,'2026-01-15T05:30:00.250');
 const loading=f.s.loadHistory();assert.equal(requestBefore(f),'2026-01-15T05:30:00.250Z');f.pending.at(-1).resolve(f.page('alpha'));await loading;
});
for(const [label,value,error]of [['nonexistent spring-forward','2026-03-08T02:30','does not exist'],['ambiguous fall-back','2026-11-01T01:30','occurs twice']])test(label+' local edit is rejected rather than silently shifted or chosen',async()=>{
 const f=await ready();f.node('history-before').value=value;f.s.editHistoryCursor?.(value);const count=f.pending.length;void f.s.loadHistory();assert.equal(f.pending.length,count,'invalid local time must not query the archive');assert.ok(f.html().includes(error));assert.match(f.html(),/aria-invalid="true"/);assert.equal(f.node('history-before').value,value);
});

for(const [value,instant]of [
 ['2026-03-08T01:59:59.999','2026-03-08T06:59:59.999Z'],
 ['2026-03-08T03:00','2026-03-08T07:00:00.000Z'],
 ['2026-11-01T00:59:59.999','2026-11-01T04:59:59.999Z'],
 ['2026-11-01T02:00','2026-11-01T07:00:00.000Z'],
 ['2024-02-29T00:00','2024-02-29T05:00:00.000Z']
])test('local boundary '+value+' queries its exact intended UTC instant',async()=>{
 const f=await ready();f.node('history-before').value=value;f.s.editHistoryCursor(value);const loading=f.s.loadHistory();assert.equal(requestBefore(f),instant);f.pending.at(-1).resolve(f.page('alpha'));await loading;
});
for(const instant of ['2026-11-01T05:30:00.123Z','2026-11-01T06:30:00.123Z'])test('unchanged known fall-back instant '+instant+' survives local display and reload',async()=>{
 const f=await ready();f.s.historyBefore=instant;f.s.showHistoryPage();assert.equal(f.node('history-before').value,'2026-11-01T01:30:00.123');const loading=f.s.loadHistory();assert.equal(requestBefore(f),instant);f.pending.at(-1).resolve(f.page('alpha'));await loading;assert.equal(f.s.historyBefore,instant);
});
test('new ambiguous edit of a known repeated time still needs an explicit instant',async()=>{
 const f=await ready();f.s.historyBefore='2026-11-01T06:30:00.000Z';f.s.showHistoryPage();f.s.editHistoryCursor(f.node('history-before').value);const count=f.pending.length;void f.s.loadHistory();assert.equal(f.pending.length,count);assert.match(f.html(),/occurs twice/);
});
test('switching valid local and UTC presentation changes no instant and sends no request',async()=>{
 const f=await ready();f.node('history-before').value='2026-07-15T12:30:45.789';f.s.editHistoryCursor(f.node('history-before').value);const count=f.pending.length;f.s.changeHistoryTimezone('utc');assert.equal(f.pending.length,count);assert.equal(f.node('history-before').value,'2026-07-15T16:30:45.789');assert.equal(f.s.historyBefore,'2026-07-15T16:30:45.789Z');f.s.changeHistoryTimezone('local');assert.equal(f.node('history-before').value,'2026-07-15T12:30:45.789');assert.equal(f.s.historyBefore,'2026-07-15T16:30:45.789Z');
});
test('ambiguous local edit switches to explicit empty UTC entry without selecting an occurrence',async()=>{
 const f=await ready(),count=f.pending.length;f.node('history-before').value='2026-11-01T01:30';f.s.editHistoryCursor(f.node('history-before').value);f.s.changeHistoryTimezone('utc');assert.equal(f.node('history-before').value,'');assert.equal(f.pending.length,count);assert.match(f.html(),/occurs twice/);f.node('history-before').value='2026-11-01T06:30';f.s.editHistoryCursor(f.node('history-before').value);const loading=f.s.loadHistory();assert.equal(requestBefore(f),'2026-11-01T06:30:00.000Z');f.pending.at(-1).resolve(f.page('alpha'));await loading;
});
test('invalid calendar dates and blank edits never query using normalized or current time',async()=>{
 for(const value of ['2026-02-30T10:00','']){const f=await ready(),count=f.pending.length;f.node('history-before').value=value;f.s.editHistoryCursor(value);void f.s.loadHistory();assert.equal(f.pending.length,count);assert.match(f.html(),/valid calendar date/);}
});
test('repeated unchanged winter Loads preserve milliseconds and do not drift',async()=>{
 const f=await ready();f.s.historyBefore='2001-01-01T05:00:00.123Z';f.s.showHistoryPage();for(let i=0;i<3;i++){const loading=f.s.loadHistory();assert.equal(requestBefore(f),'2001-01-01T05:00:00.123Z');f.pending.at(-1).resolve(f.page('alpha'));await loading;assert.equal(f.node('history-before').value,'2001-01-01T00:00:00.123');}
});
