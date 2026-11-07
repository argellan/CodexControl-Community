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
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {SpendingLedger} from '../lib/spending-ledger.mjs';
import {SpendingAdvisory, readSpendingUsagePage} from '../lib/spending-advisory.mjs';
import {installUsageSamples, captureUsageSamples, normalizeUsageSample} from '../lib/usage-samples.mjs';
import {createServer} from './fixture-server.mjs';

const now = 1000000, key = 'a'.repeat(64), foreign = 'b'.repeat(64);
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const admin = {role: 'admin', hostIds: null, projectIds: null};
const telemetry = {observedAtMs: now, usedPercent: 4, resetAt: 2000};
const manifest = overrides => ({familyId: 'advisory', taskId: 'task',
  ownerAuthority: {id: 'authority', statement: 'TEST_ONLY explicit account/host/thread advisory binding'},
  scope: 'TEST_ONLY replay', definitionOfDone: 'Advisory status without provider calls',
  mode: 'advisory', accountKey: key, binding: {hostIds: ['hub'], threadIds: ['thread']},
  weeklySelection: {limitId: 'codex', slot: 'primary'},
  admittedAtMs: now, deadlineMs: now + 600000, tokenBudget: null, closeoutTokens: 0,
  closeoutReserveMs: 10000, telemetryMaxAgeMs: 60000, reservationTtlMs: 30000, maxAttempts: 1,
  weeklyBaseline: {usedPercent: 4, resetAt: 2000}, weeklyPointBudget: 5, closeoutWeeklyPoints: 1,
  requested: {model: 'TEST_ONLY', reasoning: 'high', tier: 'standard', fast: false},
  observed: {model: null, reasoning: null, tier: null, fast: null}, ...overrides});
const account = (overrides = {}) => ({version: 1, source: 'codex-app-server', status: 'available',
  observedAt: new Date(now).toISOString(), lastAttemptAt: new Date(now).toISOString(),
  limitsObservedAt: new Date(now).toISOString(), usageObservedAt: new Date(now).toISOString(),
  accountKey: key, planType: 'pro', limits: [{limitId: 'codex',
    primary: {usedPercent: 4, windowDurationMins: 10080, resetsAt: 2000}, secondary: null}],
  summary: {lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null},
  dailyUsageBuckets: null, errorCode: null, ...overrides});
const sample = (n = 1, overrides = {}) => ({sample_key: hash('sample-' + n), host_id: 'hub', session_id: 'session',
  source_id: hash('source'), source_record_key: hash('record-' + n), source_ms: now, received_ms: now,
  native_thread_id: 'thread', native_response_id: 'response-' + n, provider_account_key: null,
  usage_scope: 'response', accounting_class: 'candidate', input_tokens: 20, cached_input_tokens: 15,
  output_tokens: 5, reasoning_output_tokens: 3, ...overrides});
const pageReader = (rows = [], generation = 'epoch') => criteria => {
  const ordered = rows.map((row, index) => ({...row, ingestSequence: index + 1}))
    .filter(row => !criteria.after || row.ingestSequence > criteria.after.sequence);
  return {available: true, generation, rows: ordered.slice(0, 128), hasMore: ordered.length > 128};
};
async function fixture(fn, overrides, initialObservation = telemetry) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'argellan-advisory-TEST_ONLY-'));
  const file = path.join(directory, 'advisory.sqlite');
  let ledger = new SpendingLedger(file, {clock: () => now});
  ledger.createFamily(manifest(overrides), initialObservation);
  const context = {ledger, adapter: new SpendingAdvisory({ledger, familyId: 'advisory'}),
    reopen() {ledger.close(); ledger = new SpendingLedger(file, {clock: () => now}); context.ledger = ledger;
      context.adapter = new SpendingAdvisory({ledger, familyId: 'advisory'});},
    status(options = {}) {return context.adapter.readStatus({viewer: admin,
      sources: [{hostId: 'hub', accountUsage: account()}], ...options});}};
  try {await fn(context);} finally {ledger.close(); rmSync(directory, {recursive: true, force: true});}
}
test('weekly-only family has no invented token cap and cannot grant dispatch admission', () => fixture(async c => {
  const status = await c.status();
  assert.equal(status.mode, 'ADVISORY'); assert.equal(status.tokenBudget, null);
  assert.equal(status.spent, null); assert.equal(status.remaining, null); assert.equal(status.nativeReserved, null);
  assert.equal(status.nativeDispatchEnforcement, 'UNSUPPORTED'); assert.equal(status.coverage.complete, false);
  assert.equal(c.ledger.reserve('advisory', {taskId: 'task', actionId: 'a', reservationId: 'r', estimatedTokens: 1}).reason, 'ADVISORY_ONLY_NO_DISPATCH');
}));
test('account projection selects only the immutable bound account and actual limits timestamp', () => fixture(async c => {
  const at = new Date(now - 1000).toISOString();
  const status = await c.status({sources: [{hostId: 'hub', accountUsage: account({limitsObservedAt: at})},
    {hostId: 'other', accountUsage: account({accountKey: foreign})}]});
  assert.equal(status.state, 'OBSERVING'); assert.equal(status.limitsObservedAt, at);
  assert.equal(status.weeklyIncreasePoints, 0); assert.equal(JSON.stringify(status).includes(foreign), false);
}, undefined, {...telemetry, observedAtMs: now - 1000}));
test('fresh response timestamp cannot refresh stale, missing or future limits telemetry', async () => {
  for (const at of [null, new Date(now - 60001).toISOString(), new Date(now + 1).toISOString()])
    await fixture(async c => {
      const status = await c.status({sources: [{hostId: 'hub', accountUsage: account({limitsObservedAt: at})}]});
      assert.equal(status.state, 'STOP_RECOMMENDED');
      assert.equal((await c.status()).stopped, true);
    });
});
test('account mismatch, unavailable source and fixed weekly-window identity fail closed', async () => {
  for (const sources of [[], [{hostId: 'hub', accountUsage: account({accountKey: foreign})}],
    [{hostId: 'hub', accountUsage: account({limits: [{limitId: 'other', primary: {usedPercent: 4, windowDurationMins: 10080, resetsAt: 2000}, secondary: null}]})}]])
    await fixture(async c => assert.equal((await c.status({sources})).state, 'STOP_RECOMMENDED'));
});
test('weekly threshold, reset and replenishment persist across restart', async () => {
  for (const window of [{usedPercent: 9, windowDurationMins: 10080, resetsAt: 2000},
    {usedPercent: 4, windowDurationMins: 10080, resetsAt: 3000},
    {usedPercent: 3, windowDurationMins: 10080, resetsAt: 2000}])
    await fixture(async c => {
      assert.equal((await c.status({sources: [{hostId: 'hub', accountUsage: account({limits: [{limitId: 'codex', primary: window, secondary: null}]})}]})).state, 'STOP_RECOMMENDED');
      c.reopen(); assert.equal((await c.status()).stopped, true);
    });
});
test('external response imports deduplicate aliases, preserve provenance and create no reservations', () => fixture(async c => {
  const rows = [sample(1), sample(2, {native_response_id: 'response-1'})];
  const status = await c.status({readPage: pageReader(rows)});
  assert.equal(status.spent, 25); assert.equal(status.reserved, 0);
  assert.equal(status.coverage.observedResponses, 1); assert.equal(status.coverage.duplicates, 1);
  const receipts = c.ledger.receipts('advisory').filter(row => row.kind === 'external-observed-usage');
  assert.equal(receipts.length, 2);
  for (const row of receipts) {
    assert.equal(row.payload.result.observation.inputTokens, 20);
    assert.equal(row.payload.result.observation.cachedInputTokens, 15);
    assert.equal(row.payload.result.observation.provenance.accountBinding, 'OWNER_BOUND_THREAD');
  }
  c.reopen(); assert.equal((await c.status({readPage: pageReader(rows)})).spent, 25);
}));
test('conflicting and unknown external counters latch stop without overwriting the original', async () => {
  await fixture(async c => {
    const rows = [sample(1), sample(2, {native_response_id: 'response-1', input_tokens: 21})];
    const status = await c.status({readPage: pageReader(rows)});
    assert.equal(status.state, 'STOP_RECOMMENDED'); assert.equal(status.spent, 25);
    assert.equal(status.reason, 'OBSERVED_USAGE_CONFLICT');
  });
  await fixture(async c => {
    const status = await c.status({readPage: pageReader([sample(1, {input_tokens: null, cached_input_tokens: null})])});
    assert.equal(status.reason, 'OBSERVED_USAGE_UNKNOWN'); assert.equal(status.remaining, null);
  });
});
test('foreign, forked, cumulative, old and unbound records stay excluded', () => fixture(async c => {
  const rows = [sample(1, {provider_account_key: foreign}), sample(2, {host_id: 'other'}),
    sample(3, {native_thread_id: 'other'}), sample(4, {usage_scope: 'thread-total'}),
    sample(5, {accounting_class: 'fork-excluded'}), sample(6, {source_ms: now - 1})];
  const status = await c.status({readPage: pageReader(rows)});
  assert.equal(status.spent, null); assert.equal(status.coverage.excluded, 6);
  assert.equal(status.coverage.complete, false);
}));
test('bounded real journal replay advances durable cursor without changing source rows; epoch change stops', () => fixture(async c => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);INSERT INTO metadata VALUES('epoch','epoch');");
    installUsageSamples(db);
    const rows = Array.from({length: 129}, (_, n) => ({session_id: 'session', source_record_key: hash(n),
      source_kind: 'token_usage_record', usage_scope: 'response', source_ms: now, time_basis: 'source',
      native_thread_id: 'thread', native_response_id: 'response-' + n,
      input_tokens: 20, cached_input_tokens: 15, cache_write_input_tokens: 0, output_tokens: 5,
      reasoning_output_tokens: 3, total_tokens: 25, reported_mask: 63, provider_reported_mask: 0, synthesized_mask: 0}));
    captureUsageSamples(db, rows, {hostId: 'hub', receivedMs: now, sourceRole: 'codex-source'});
    const before = db.prepare('SELECT COUNT(*) n FROM usage_samples_v2').get().n;
    const readPage = options => readSpendingUsagePage({database: fn => fn(db)}, options);
    let status = await c.status({readPage});
    assert.equal(status.coverage.backlog, true); assert.equal(status.coverage.observedResponses, 128);
    c.reopen(); status = await c.status({readPage});
    assert.equal(status.coverage.observedResponses, 129); assert.equal(status.spent, 3225);
    assert.equal(status.coverage.backlog, false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_samples_v2').get().n, before);
    // A later commit may carry the same received millisecond and a smaller hash.
    const anchor = c.ledger.advisoryContext('advisory').cursor.sampleKey;
    let lateInput = null;
    for (let n = 0; n < 16; n++) {
      const candidate = {...rows[0], source_record_key: hash('late-' + n), native_response_id: 'late-response'};
      const normalized = normalizeUsageSample(candidate, {hostId: 'hub', receivedMs: now, sourceRole: 'codex-source'});
      if (normalized.sample_key < anchor) {lateInput = candidate; break;}
    }
    assert.ok(lateInput, 'Fixture must insert behind the old timestamp/hash cursor');
    captureUsageSamples(db, [lateInput], {hostId: 'hub', receivedMs: now, sourceRole: 'codex-source'});
    status = await c.status({readPage});
    assert.equal(status.coverage.observedResponses, 130, 'Later same-millisecond insertion must not be skipped');
    assert.equal(status.spent, 3250);

    db.exec("UPDATE metadata SET value='changed' WHERE key='epoch'");
    assert.equal((await c.status({readPage})).reason, 'USAGE_SOURCE_CHANGED');
  } finally {db.close();}
}));
test('advisory reports closeout reserve before the immutable hard weekly limit', () => fixture(async c => {
  const status = await c.status({sources: [{hostId: 'hub', accountUsage: account({limits: [{limitId: 'codex',
    primary: {usedPercent: 8, windowDurationMins: 10080, resetsAt: 2000}, secondary: null}]})}]});
  assert.equal(status.state, 'CLOSEOUT_RECOMMENDED'); assert.equal(status.stopped, false);
}));
const viewerConfig = [
  {id: 'admin', label: 'TEST_ONLY admin', tokenHash: hash('fixture-admin'), hostIds: null, role: 'admin'},
  {id: 'scoped', label: 'TEST_ONLY scoped', tokenHash: hash('fixture-scoped'), hostIds: ['hub'], role: 'viewer'}
];
async function httpFixture(c, fn, options = {}) {
  let reads = 0;
  const server = createServer({viewers: viewerConfig, spendingAdvisory: c.adapter,
    readSnapshot: async () => {reads++; return {host: {id: 'hub'}, accountUsage: account(), sessions: [], events: []};},
    ...options});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/account/spending-status';
  const get = (suffix = '', init = {}) => fetch(url + suffix, {headers: {Authorization: 'Bearer fixture-admin'}, ...init});
  try {await fn({get, url, reads: () => reads});}
  finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
}
test('local HTTP endpoint returns advisory JSON; HEAD skips ingestion and scope overrides/mutations are refused', () => fixture(c =>
  httpFixture(c, async ({get, reads}) => {
    const head = await get('', {method: 'HEAD'});
    assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(reads(), 0);
    const response = await get(); assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.mode, 'ADVISORY'); assert.equal(body.nativeDispatchEnforcement, 'UNSUPPORTED');
    assert.equal((await get('?account=other')).status, 400);
    assert.equal((await get('', {method: 'POST'})).status, 405);
  })));
test('HTTP endpoint protects authentication, account scope and same-origin policy', () => fixture(c =>
  httpFixture(c, async ({get}) => {
    assert.equal((await get('', {headers: {}})).status, 401);
    assert.equal((await get('', {headers: {Authorization: 'Bearer fixture-scoped'}})).status, 403);
    assert.equal((await get('', {headers: {Authorization: 'Bearer fixture-admin', Origin: 'https://foreign.invalid'}})).status, 403);
  })));
test('HTTP endpoint stays unavailable unless locally configured and never forwards upstream', () => fixture(c =>
  httpFixture(c, async ({get, reads}) => {
    const response = await get(); assert.equal(response.status, 503);
    assert.equal((await response.json()).reason, 'NOT_CONFIGURED'); assert.equal(reads(), 0);
  }, {spendingAdvisory: undefined})));
test('source disable during asynchronous read is revalidated before HTTP delivery', () => fixture(async c => {
  const hub = {hosts: [{id: 'hub', role: 'codex-source', tokenHash: hash('collector'), disabled: false}], states: new Map()};
  await httpFixture(c, async ({get}) => {
    const response = await get(); assert.equal(response.status, 403);
    assert.equal((await response.text()).includes('weeklyPointBudget'), false);
  }, {hub, readSnapshot: async () => {
    hub.hosts[0].disabled = true; return {host: {id: 'hub'}, accountUsage: account(), sessions: [], events: []};
  }});
}));

test('invalid counters and future source times produce a durable stop recommendation', async () => {
  for (const row of [sample(1, {cached_input_tokens: 21}), sample(2, {source_ms: now + 1})])
    await fixture(async c => {
      const status = await c.status({readPage: pageReader([row])});
      assert.equal(status.state, 'STOP_RECOMMENDED');
      c.reopen(); assert.equal((await c.status()).stopped, true);
    });
});
