// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {SpendingLedger, SPENDING_CAPABILITY} from '../lib/spending-ledger.mjs';

const initialNow = 1000000;
const telemetry = (now = initialNow, usedPercent = 2, resetAt = 2000) => ({observedAtMs: now, usedPercent, resetAt});
const manifest = (overrides = {}) => ({
  familyId: 'family', taskId: 'root', ownerAuthority: {id: 'authority', statement: 'TEST_ONLY explicit finite allowance'},
  scope: 'Deterministic accounting records only', definitionOfDone: 'Verify admissions without provider calls',
  admittedAtMs: initialNow, deadlineMs: initialNow + 600000, tokenBudget: 100, closeoutTokens: 10,
  closeoutReserveMs: 10000, telemetryMaxAgeMs: 60000, reservationTtlMs: 30000, maxAttempts: 2,
  weeklyBaseline: {usedPercent: 2, resetAt: 2000}, weeklyPointBudget: 5, closeoutWeeklyPoints: 1,
  requested: {model: 'TEST_ONLY', reasoning: 'high', tier: 'standard', fast: false},
  observed: {model: null, reasoning: null, tier: null, fast: null}, ...overrides
});
const request = (overrides = {}) => ({taskId: 'root', actionId: 'action', reservationId: 'reservation',
  estimatedTokens: 40, ...overrides});
const usage = (overrides = {}) => ({receiptId: 'receipt', responseId: 'response', reservationId: 'reservation',
  inputTokens: 20, cachedInputTokens: 15, outputTokens: 5, reasoningOutputTokens: 3, ...overrides});
async function fixture(fn, overrides = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'argellan-spending-TEST_ONLY-'));
  const file = path.join(directory, 'ledger.sqlite');
  let now = initialNow, ledger = new SpendingLedger(file, {clock: () => now});
  const context = {file, ledger, setNow: value => {now = value;}, reopen: () => {
    ledger.close(); ledger = new SpendingLedger(file, {clock: () => now}); context.ledger = ledger; return ledger;
  }};
  try { ledger.createFamily(manifest(overrides), telemetry()); await fn(context); }
  finally { ledger.close(); rmSync(directory, {recursive: true, force: true}); }
}
test('immutable manifest, explicit authority, identity rejection and linked renewal retain receipts', () => fixture(({ledger}) => {
  assert.throws(() => ledger.createFamily(manifest(), telemetry()), {code: 'FAMILY_EXISTS'});
  assert.throws(() => ledger.createFamily(manifest({familyId: 'other', taskId: 'other'}), telemetry()), {code: 'NEW_AUTHORITY_REQUIRED'});
  ledger.stop('family');
  assert.throws(() => ledger.createFamily(manifest({familyId: 'renewed', ownerAuthority: {id: 'new', statement: 'new grant'}}), telemetry()), {code: 'PREDECESSOR_REQUIRED'});
  ledger.createFamily(manifest({familyId: 'renewed', previousFamilyId: 'family',
    ownerAuthority: {id: 'new', statement: 'Explicit renewed TEST_ONLY grant'}}), telemetry());
  assert.equal(ledger.status('family').stopped, true);
  assert.equal(ledger.status('renewed').stopped, false);
  assert.ok(ledger.receipts('family').some(row => row.kind === 'admission-manifest'));
  assert.throws(() => ledger.status('__proto__'), {code: 'INVALID_IDENTITY'});
  assert.equal(ledger.reserve('family', request({taskId: 'missing'})).reason, 'INVALID_IDENTITY');
}));
test('descendant records inherit family, parent budget and deadline without child dispatch', () => fixture(({ledger}) => {
  assert.throws(() => ledger.registerTask('family', {taskId: 'bad', parentId: 'root', tokenBudget: 101, deadlineMs: initialNow + 1000}), {code: 'INHERITED_BOUND'});
  assert.throws(() => ledger.registerTask('family', {taskId: 'bad', parentId: 'root', tokenBudget: 50, deadlineMs: initialNow + 700000}), {code: 'INHERITED_BOUND'});
  assert.equal(ledger.registerTask('family', {taskId: 'child', parentId: 'root', tokenBudget: 50, deadlineMs: initialNow + 10000}).dispatch, 'NONE');
  ledger.registerTask('family', {taskId: 'grandchild', parentId: 'child', tokenBudget: 40, deadlineMs: initialNow + 5000});
  assert.equal(ledger.reserve('family', request({taskId: 'grandchild'})).allowed, true);
  assert.equal(ledger.reserve('family', request({taskId: 'child', actionId: 'second', reservationId: 'second', estimatedTokens: 11})).allowed, false);
  assert.equal(ledger.status('family').reserved, 40);
}));
test('usage deduplicates response aliases and preserves included cached and reasoning subsets', () => fixture(({ledger}) => {
  ledger.reserve('family', request());
  ledger.markStarted('family', 'reservation');
  assert.equal(ledger.recordUsage('family', usage()).spent, 25);
  assert.equal(ledger.recordUsage('family', usage({receiptId: 'different-event'})).duplicate, true);
  assert.deepEqual(Object.fromEntries(['spent', 'reserved', 'remaining'].map(key => [key, ledger.status('family')[key]])),
    {spent: 25, reserved: 0, remaining: 75});
  assert.equal(ledger.recordUsage('family', usage({inputTokens: 21})).reason, 'USAGE_CONFLICT');
  assert.equal(ledger.status('family').stop.reason, 'USAGE_CONFLICT');
}));
test('null total telemetry stays unknown, holds reservations and refuses new admissions', () => fixture(({ledger}) => {
  ledger.reserve('family', request());
  ledger.markStarted('family', 'reservation');
  const result = ledger.recordUsage('family', usage({inputTokens: null, cachedInputTokens: null}));
  assert.equal(result.unknown, true);
  assert.equal(result.reserved, 40);
  assert.equal(ledger.status('family').remaining, null);
  assert.equal(ledger.reserve('family', request({actionId: 'next', reservationId: 'next'})).allowed, false);
}));
test('atomic concurrent connections admit only one competing reservation', () => fixture(async ({ledger, file}) => {
  const gate = new SharedArrayBuffer(4), workers = [];
  const run = n => new Promise((resolve, reject) => {
    const worker = new Worker(`
      const {parentPort, workerData} = require('node:worker_threads');
      (async () => {
        const {SpendingLedger} = await import(workerData.moduleUrl);
        const ledger = new SpendingLedger(workerData.file, {clock: () => 1000000});
        parentPort.postMessage({ready: true});
        Atomics.wait(new Int32Array(workerData.gate), 0, 0);
        const result = ledger.reserve('family', {taskId:'root', actionId:'a'+workerData.n,
          reservationId:'r'+workerData.n, estimatedTokens:60});
        ledger.close(); parentPort.postMessage({result});
      })().catch(error => {throw error;});
    `, {eval: true, workerData: {file, n, gate, moduleUrl: new URL('../lib/spending-ledger.mjs', import.meta.url).href}});
    workers.push(worker);
    worker.on('error', reject);
    worker.on('message', message => {
      if (message.ready) {worker.ready = true; if (workers.length === 2 && workers.every(item => item.ready)) {
        Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
      }}
      if (message.result) resolve(message.result);
    });
    worker.on('exit', code => {if (code !== 0) reject(new Error('Worker failed: ' + code));});
  });
  const outcomes = await Promise.all([run(1), run(2)]);
  assert.equal(outcomes.filter(item => item.allowed).length, 1);
  assert.equal(ledger.status('family').reserved, 60);
}));
test('latched owner stop persists across restart and fresh telemetry', () => fixture(({ledger, reopen}) => {
  ledger.stop('family', 'OWNER_STOP');
  const reopened = reopen();
  reopened.observe('family', telemetry());
  assert.equal(reopened.status('family').stop.reason, 'OWNER_STOP');
  assert.equal(reopened.reserve('family', request()).allowed, false);
}));
test('reset and replenishment latch stop permanently', async () => {
  for (const next of [telemetry(initialNow, 1), telemetry(initialNow, 2, 3000)]) {
    await fixture(({ledger, reopen}) => {
      ledger.observe('family', next);
      assert.equal(reopen().status('family').stop.reason, 'TELEMETRY_RESET_OR_REPLENISHMENT');
    });
  }
});
test('stale, missing and future telemetry fail closed; fresh values cannot erase stop', async () => {
  for (const next of [null, telemetry(initialNow - 60001), telemetry(initialNow + 1)]) {
    await fixture(({ledger}) => {
      ledger.observe('family', next);
      ledger.observe('family', telemetry());
      assert.equal(ledger.reserve('family', request()).allowed, false);
    });
  }
  await fixture(({ledger, setNow}) => {
    setNow(initialNow + 60001);
    assert.equal(ledger.reserve('family', request()).reason, 'FAMILY_STOPPED');
  });
});
test('bounded retries, cancellation and expiry release only unstarted reservations', () => fixture(({ledger, setNow}) => {
  ledger.reserve('family', request());
  assert.equal(ledger.cancel('family', 'reservation').reserved, 0);
  assert.equal(ledger.reserve('family', request({reservationId: 'retry'})).allowed, true);
  ledger.cancel('family', 'retry');
  assert.equal(ledger.reserve('family', request({reservationId: 'third'})).reason, 'RETRY_LIMIT');
  ledger.reserve('family', request({actionId: 'expiring', reservationId: 'expiring'}));
  setNow(initialNow + 30000);
  assert.equal(ledger.status('family').reserved, 0);
  assert.equal(ledger.status('family').stopped, false);
}));
test('started cancellation or expiry preserves liability and allows late usage bookkeeping', async () => {
  for (const cancellation of [true, false]) await fixture(({ledger, setNow}) => {
    ledger.reserve('family', request());
    ledger.markStarted('family', 'reservation');
    if (cancellation) ledger.cancel('family', 'reservation'); else setNow(initialNow + 30000);
    assert.equal(ledger.status('family').reserved, 40);
    assert.equal(ledger.status('family').unknown, true);
    ledger.recordUsage('family', usage());
    assert.equal(ledger.status('family').spent, 25);
    assert.equal(ledger.status('family').reserved, 0);
    assert.equal(ledger.status('family').stopped, true);
  });
});
test('denial cannot bypass via another interface, descendant or restart', () => fixture(({ledger, reopen}) => {
  ledger.registerTask('family', {taskId: 'child', parentId: 'root', tokenBudget: 100, deadlineMs: initialNow + 600000});
  assert.equal(ledger.reserve('family', request({estimatedTokens: 91, interfaceId: 'first'})).allowed, false);
  assert.equal(reopen().reserve('family', request({taskId: 'child', estimatedTokens: 1, interfaceId: 'other'})).reason, 'ACTION_DENIAL_LATCHED');
}));
test('closeout-only admission is local, zero-token and available after stop; no dispatch permission', () => fixture(({ledger}) => {
  ledger.stop('family');
  assert.equal(ledger.reserve('family', request({kind: 'closeout', operation: 'write-receipt', estimatedTokens: 0})).dispatch, 'NONE');
  assert.equal(ledger.reserve('family', request({actionId: 'model-closeout', kind: 'closeout', operation: 'model-request', estimatedTokens: 1})).allowed, false);
  assert.equal(ledger.status('family').reserved, 0);
  assert.equal(SPENDING_CAPABILITY.nativeCodexTurns, 'UNSUPPORTED');
}));
test('monitors consume the same allowance; reserve and start boundaries preserve closeout room', async () => {
  await fixture(({ledger}) => {
    ledger.reserve('family', request({kind: 'monitor'}));
    ledger.recordUsage('family', usage());
    assert.equal(ledger.status('family').spent, 25);
    assert.equal(ledger.reserve('family', request({actionId: 'more', reservationId: 'more', kind: 'monitor', estimatedTokens: 66})).allowed, false);
  });
  await fixture(({ledger}) => {
    ledger.reserve('family', request());
    ledger.observe('family', telemetry(initialNow, 6));
    assert.equal(ledger.markStarted('family', 'reservation').allowed, false);
    assert.equal(ledger.reserve('family', request({actionId: 'more', reservationId: 'more'})).reason, 'CLOSEOUT_WEEKLY_RESERVED');
  });
  await fixture(({ledger, setNow}) => {
    setNow(initialNow + 590000);
    ledger.observe('family', telemetry(initialNow + 590000));
    assert.equal(ledger.reserve('family', request()).allowed, false);
  }, {telemetryMaxAgeMs: 600000});
});
test('deadline, weekly limit, overrun and clock rollback latch; cleanup still works', async () => {
  await fixture(({ledger}) => {
    ledger.observe('family', telemetry(initialNow, 7));
    assert.equal(ledger.status('family').stop.reason, 'WEEKLY_LIMIT');
  });
  await fixture(({ledger, setNow}) => {
    setNow(initialNow + 600000);
    assert.equal(ledger.status('family').stop.reason, 'DEADLINE');
  });
  await fixture(({ledger}) => {
    ledger.reserve('family', request({estimatedTokens: 10}));
    ledger.recordUsage('family', usage());
    assert.equal(ledger.status('family').stop.reason, 'RESERVATION_OVERRUN');
  });
  await fixture(({ledger, setNow}) => {
    ledger.reserve('family', request()); setNow(initialNow - 1);
    assert.equal(ledger.status('family').stop.reason, 'CLOCK_ROLLBACK');
    assert.equal(ledger.cancel('family', 'reservation').reserved, 0);
  });
});
