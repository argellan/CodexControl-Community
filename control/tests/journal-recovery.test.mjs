import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {ControlJournal} from '../lib/journal.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/journal-crash-child.mjs', import.meta.url));
const MiB = 1024 * 1024;
const cleanups = new WeakMap();
const onCleanup = (t, callback) => { assert.ok(cleanups.has(t)); cleanups.get(t).push(callback); };
const makeEnvelope = () => {
  const createdAtMs = Date.now();
  return {version: 1, operationId: randomUUID(), requestKey: randomUUID(), actorId: randomUUID(), action: 'turn.start',
    target: {hostId: randomUUID(), projectId: randomUUID(), providerProfileId: randomUUID(), runtimeId: randomUUID(),
      sessionId: randomUUID(), turnId: null, terminalId: null, requestId: null},
    context: {entityRevision: 0, policyRevision: 1, grantRevision: 1, authorityGeneration: 1,
      ownershipFence: 1, connectionEpoch: randomUUID()}, createdAtMs, deadlineAtMs: createdAtMs + 600_000, timeoutMs: 600_000};
};
const eventFor = (operation, type, extra = {}) => ({operationId: operation.envelope.operationId,
  eventId: randomUUID(), expectedRevision: operation.revision, type, atMs: Date.now(),
  context: structuredClone(operation.envelope.context), ...extra});
const refused = (operation, code) => assert.throws(operation, error =>
  error?.name === 'ControlError' && error.code === code && error.message === 'Control foundation request refused');

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'TEST_ONLY-control-journal-recovery-'));
  cleanups.set(t, []);
  t.after(async () => {
    for (const cleanup of cleanups.get(t).reverse()) await cleanup();
    // A known mkdtemp child, never an arbitrary configured directory.
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('TEST_ONLY-control-journal-recovery-'));
    await rm(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 40});
  });
  return directory;
}

function journalAt(t, directory, options = {}) {
  const journal = ControlJournal.open({directory, ...options});
  onCleanup(t, () => journal.close());
  return journal;
}

function childFixture(t, configuration) {
  const child = fork(fixturePath, [], {execArgv: ['--max-old-space-size=64'], windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
  const messages = [], waiters = [];
  let stdout = '', stderr = '', completed = false;
  const finish = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => { completed = true; resolve({code, signal}); });
  });
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('message', message => {
    messages.push(message);
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index];
      if (message.kind === waiter.kind || message.kind === 'fatal') {
        waiters.splice(index, 1); clearTimeout(waiter.timer);
        message.kind === 'fatal' ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message);
      }
    }
  });
  const next = kind => {
    const found = messages.find(message => message.kind === kind || message.kind === 'fatal');
    if (found) return found.kind === 'fatal' ? Promise.reject(new Error(JSON.stringify(found.error))) : Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = {kind, resolve, reject, timer: setTimeout(() => reject(new Error('TEST_ONLY fixture boundary timeout: ' + kind)), 15_000)};
      waiters.push(waiter);
    });
  };
  onCleanup(t, async () => {
    for (const waiter of waiters) clearTimeout(waiter.timer);
    if (!completed) child.kill('SIGKILL');
    await finish;
  });
  child.send(configuration);
  return {child, next, finish, get output() { return stdout + stderr; },
    async kill() { if (!completed) child.kill('SIGKILL'); return finish; }};
}

test('real child crashes preserve committed boundaries and never recover a dispatch automatically', {timeout: 90_000}, async t => {
  for (const stage of ['afteradmission', 'intent', 'fakeeffect', 'ack', 'final']) {
    await t.test(stage, async subtest => {
      const directory = await temporary(subtest), envelope = makeEnvelope(), effectFile = path.join(directory, 'TEST_ONLY-effect');
      const child = childFixture(subtest, {mode: 'crash', directory, envelope, effectFile, stage});
      const boundary = await child.next('boundary');
      assert.equal(boundary.stage, stage);
      await child.kill();
      const effectBefore = existsSync(effectFile);
      assert.equal(effectBefore, ['fakeeffect', 'ack', 'final'].includes(stage));
      const journal = journalAt(subtest, directory);
      const saved = journal.get(envelope.operationId), beforeRecords = journal.status().records;
      assert.equal(saved.state, ({afteradmission: 'ADMITTED', intent: 'DISPATCH_INTENT', fakeeffect: 'DISPATCH_INTENT',
        ack: 'NATIVE_ACCEPTED', final: 'COMPLETED'})[stage]);
      const recovered = journal.recover({connectionEpoch: envelope.context.connectionEpoch, atMs: Date.now()});
      const after = journal.get(envelope.operationId);
      assert.equal(after.state, stage === 'afteradmission' ? 'NOT_DISPATCHED' : stage === 'final' ? 'COMPLETED' : 'UNKNOWN');
      assert.equal(recovered.count, stage === 'final' ? 0 : 1);
      assert.equal(journal.status().records, beforeRecords + (stage === 'final' ? 0 : 1));
      const duplicate = journal.admit(envelope);
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.operation.state, after.state);
      assert.equal(journal.recover({connectionEpoch: envelope.context.connectionEpoch, atMs: Date.now()}).count, 0);
      assert.equal(existsSync(effectFile), effectBefore);
      if (effectBefore) assert.equal(await readFile(effectFile, 'utf8'), 'TEST_ONLY_EFFECT\n');
      assert.equal(journal.status().archive.status === 'verified', false);
      assert.equal(journal.status().pendingRecords, journal.status().records);
      subtest.diagnostic('Real owned Node child terminated; SQLite reopened. Effect marker is TEST_ONLY, not native-provider evidence.');
    });
  }
});

test('completion before native ACK remains terminal; duplicate event returns current state and its original durable receipt', async t => {
  const journal = journalAt(t, await temporary(t)), envelope = makeEnvelope();
  let operation = journal.admit(envelope).operation;
  operation = journal.transition(eventFor(operation, 'DISPATCH_INTENT')).operation;
  const completion = eventFor(operation, 'COMPLETED'), finalReceipt = journal.transition(completion);
  const ack = journal.transition(eventFor(finalReceipt.operation, 'NATIVE_ACCEPTED'));
  assert.equal(ack.late, true);
  assert.equal(ack.operation.state, 'COMPLETED');
  const count = journal.status().records, duplicate = journal.transition(completion);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.operation, ack.operation);
  assert.deepEqual(duplicate.receipt, finalReceipt.receipt);
  assert.deepEqual(duplicate.receipt, {eventId: completion.eventId, revision: finalReceipt.operation.revision, state: 'COMPLETED'});
  assert.equal(journal.get(envelope.operationId).revision, ack.operation.revision);
  assert.equal(journal.status().records, count);
  refused(() => journal.transition({...completion, reasonCode: 'NATIVE_RESULT'}), 'CONFLICT');
  refused(() => journal.transition(eventFor(ack.operation, 'FAILED')), 'INVALID_TRANSITION');
  assert.equal(journal.get(envelope.operationId).state, 'COMPLETED');
  assert.equal(journal.status().records, count);
});

test('immutable request identity rejects changed actor, target, operation ID and context without rewriting custody', async t => {
  const journal = journalAt(t, await temporary(t)), envelope = makeEnvelope();
  const original = journal.admit(envelope), records = journal.status().records;
  for (const mutate of [value => { value.actorId = randomUUID(); }, value => { value.target.projectId = randomUUID(); },
    value => { value.target.providerProfileId = randomUUID(); }, value => { value.context.ownershipFence++; },
    value => { value.operationId = randomUUID(); }, value => { value.requestKey = randomUUID(); }]) {
    const changed = structuredClone(envelope); mutate(changed);
    refused(() => journal.admit(changed), 'CONFLICT');
  }
  assert.deepEqual(journal.get(envelope.operationId), original.operation);
  assert.equal(journal.status().records, records);
});

test('two real SQLite writers reserve one request and race one revision without duplicate transitions', {timeout: 45_000}, async t => {
  const directory = await temporary(t), envelope = makeEnvelope();
  const initial = ControlJournal.open({directory}); initial.close();
  const writers = [childFixture(t, {mode: 'admit-race', directory, envelope}), childFixture(t, {mode: 'admit-race', directory, envelope})];
  await Promise.all(writers.map(writer => writer.next('ready')));
  for (const writer of writers) writer.child.send({go: true});
  const admitted = await Promise.all(writers.map(writer => writer.next('result')));
  await Promise.all(writers.map(writer => writer.finish));
  assert.equal(admitted.some(item => item.error), false, JSON.stringify(admitted));
  assert.deepEqual(admitted.map(item => item.result.duplicate).sort(), [false, true]);
  const journal = journalAt(t, directory), operation = journal.get(envelope.operationId), before = journal.status().records;
  const contenders = [childFixture(t, {mode: 'transition-race', directory, event: eventFor(operation, 'DISPATCH_INTENT')}),
    childFixture(t, {mode: 'transition-race', directory, event: eventFor(operation, 'DISPATCH_INTENT')})];
  await Promise.all(contenders.map(writer => writer.next('ready')));
  for (const writer of contenders) writer.child.send({go: true});
  const transitions = await Promise.all(contenders.map(writer => writer.next('result')));
  await Promise.all(contenders.map(writer => writer.finish));
  assert.equal(transitions.filter(item => item.result).length, 1);
  assert.equal(transitions.find(item => item.error)?.error.code, 'STALE_REVISION');
  assert.equal(journal.status().records, before + 1);
  assert.equal(journal.get(envelope.operationId).revision, operation.revision + 1);
});

test('each stale immutable context field and stale revision is refused without a partial append', async t => {
  const journal = journalAt(t, await temporary(t)), operation = journal.admit(makeEnvelope()).operation;
  const before = journal.status().records;
  for (const field of Object.keys(operation.envelope.context)) {
    const changed = structuredClone(operation.envelope.context);
    changed[field] = field === 'connectionEpoch' ? randomUUID() : changed[field] + 1;
    refused(() => journal.transition(eventFor(operation, 'DISPATCH_INTENT', {context: changed})), 'STALE_CONTEXT');
  }
  refused(() => journal.transition(eventFor(operation, 'DISPATCH_INTENT', {expectedRevision: operation.revision + 1})), 'STALE_REVISION');
  assert.deepEqual(journal.get(operation.envelope.operationId), operation);
  assert.equal(journal.status().records, before);
});

test('expired new admission is refused before durable reservation', async t => {
  const envelope = makeEnvelope(), journal = journalAt(t, await temporary(t), {now: () => envelope.deadlineAtMs});
  const before = journal.status();
  refused(() => journal.admit(envelope), 'EXPIRED');
  assert.equal(journal.get(envelope.operationId), null);
  assert.equal(journal.status().records, before.records);
});

test('recovery affects only the explicitly retired epoch and preserves terminal history', async t => {
  const journal = journalAt(t, await temporary(t)), first = makeEnvelope(), second = makeEnvelope();
  const one = journal.admit(first).operation, two = journal.admit(second).operation;
  const result = journal.recover({connectionEpoch: first.context.connectionEpoch, atMs: Date.now()});
  assert.equal(result.count, 1);
  assert.equal(journal.get(first.operationId).state, 'NOT_DISPATCHED');
  assert.deepEqual(journal.get(second.operationId), two);
  const before = journal.status().records;
  assert.equal(journal.recover({connectionEpoch: first.context.connectionEpoch, atMs: Date.now()}).count, 0);
  assert.equal(journal.status().records, before);
  assert.equal(one.revision, 1);
});

test('bounded recovery pages retire each matching operation once without skipping pending records', async t => {
  const journal = journalAt(t, await temporary(t)), connectionEpoch = randomUUID(), envelopes = [];
  for (let index = 0; index < 5; index++) {
    const envelope = makeEnvelope();
    envelope.context.connectionEpoch = connectionEpoch;
    envelopes.push(envelope);
    const operation = journal.admit(envelope).operation;
    if (index % 2) journal.transition(eventFor(operation, 'DISPATCH_INTENT'));
  }
  const before = journal.status().records, recovered = [];
  for (const expected of [{count: 2, hasMore: true}, {count: 2, hasMore: true}, {count: 1, hasMore: false}]) {
    const page = journal.recover({connectionEpoch, atMs: Date.now(), limit: 2});
    assert.equal(page.count, expected.count);
    assert.equal(page.hasMore, expected.hasMore);
    recovered.push(...page.recovered);
  }
  assert.equal(new Set(recovered.map(record => record.operationId)).size, envelopes.length);
  envelopes.forEach((envelope, index) => assert.equal(journal.get(envelope.operationId).state, index % 2 ? 'UNKNOWN' : 'NOT_DISPATCHED'));
  assert.equal(journal.status().records, before + envelopes.length);
  assert.equal(journal.status().pendingRecords, journal.status().records);
  assert.equal(journal.recover({connectionEpoch, atMs: Date.now(), limit: 2}).count, 0);
});

test('late observations from a retired epoch remain uncertain until explicit metadata reconciliation', async t => {
  const journal = journalAt(t, await temporary(t)), envelope = makeEnvelope();
  const admitted = journal.admit(envelope).operation;
  journal.transition(eventFor(admitted, 'DISPATCH_INTENT'));
  journal.recover({connectionEpoch: envelope.context.connectionEpoch, atMs: Date.now()});
  let operation = journal.get(envelope.operationId);
  assert.equal(operation.state, 'UNKNOWN');
  for (const type of ['NATIVE_ACCEPTED', 'COMPLETED']) {
    const observed = journal.transition(eventFor(operation, type));
    assert.equal(observed.late, true);
    assert.equal(observed.operation.state, 'UNKNOWN');
    operation = observed.operation;
  }
  refused(() => journal.transition(eventFor(operation, 'RECONCILED_COMPLETED')), 'INVALID_INPUT');
  const foreignEpoch = {...operation.envelope.context, connectionEpoch: randomUUID()};
  refused(() => journal.transition(eventFor(operation, 'RECONCILED_COMPLETED', {
    context: foreignEpoch, evidenceId: randomUUID(), reasonCode: 'RECONCILED'})), 'STALE_CONTEXT');
  assert.deepEqual(journal.get(envelope.operationId), operation);
  const reconciled = journal.transition(eventFor(operation, 'RECONCILED_COMPLETED', {
    evidenceId: randomUUID(), reasonCode: 'RECONCILED'}));
  assert.equal(reconciled.operation.state, 'COMPLETED');
  assert.equal(journal.status().pendingRecords, journal.status().records);
  t.diagnostic('Evidence UUID is TEST_ONLY metadata; P2+ must authenticate actual reconciliation evidence and current authority.');
});

test('simulated reserve pressure refuses admission but retains emergency reconciliation and all pending metadata', async t => {
  let available = 128 * MiB;
  const journal = journalAt(t, await temporary(t), {storageProbe: () => available});
  const envelope = makeEnvelope(), admitted = journal.admit(envelope).operation, rejected = makeEnvelope();
  available = 8 * MiB;
  const before = journal.status().records;
  refused(() => journal.admit(rejected), 'CAPACITY');
  assert.equal(journal.get(rejected.operationId), null);
  assert.equal(journal.status().records, before);
  refused(() => journal.transition(eventFor(admitted, 'DISPATCH_INTENT')), 'CAPACITY');
  assert.deepEqual(journal.get(envelope.operationId), admitted);
  assert.equal(journal.status().records, before);
  available = 128 * MiB;
  const intent = journal.transition(eventFor(admitted, 'DISPATCH_INTENT')).operation;
  available = 0;
  const refusedCount = journal.status().records;
  refused(() => journal.transition(eventFor(intent, 'NATIVE_ACCEPTED')), 'CAPACITY');
  assert.deepEqual(journal.get(envelope.operationId), intent);
  assert.equal(journal.status().records, refusedCount);
  available = 8 * MiB;
  assert.equal(journal.recover({connectionEpoch: envelope.context.connectionEpoch, atMs: Date.now()}).count, 1);
  assert.equal(journal.get(envelope.operationId).state, 'UNKNOWN');
  assert.equal(journal.status().pendingRecords, journal.status().records);
  t.diagnostic('SIMULATED_PRESSURE through deterministic storageProbe; actual OS-full-disk behavior NOT_RUN.');
});

test('emergency interruption admission and intent retain reserved capacity while ordinary work is refused', async t => {
  const journal = journalAt(t, await temporary(t), {storageProbe: () => 8 * MiB});
  refused(() => journal.admit(makeEnvelope()), 'CAPACITY');
  const envelope = makeEnvelope();
  envelope.action = 'turn.interrupt';
  envelope.target.turnId = randomUUID();
  const admitted = journal.admit(envelope).operation;
  const intent = journal.transition(eventFor(admitted, 'DISPATCH_INTENT')).operation;
  const final = journal.transition(eventFor(intent, 'COMPLETED')).operation;
  assert.equal(final.state, 'COMPLETED');
  assert.equal(journal.status().records, 3);
  assert.equal(journal.status().pendingRecords, 3);
  refused(() => journal.admit(makeEnvelope()), 'CAPACITY');
  t.diagnostic('Metadata-only emergency operation under SIMULATED_PRESSURE; no native interruption was executed.');
});

test('a real SQLite writer lock refuses an append without partial custody and later recovers', {timeout: 25_000}, async t => {
  const directory = await temporary(t), journal = journalAt(t, directory, {busyTimeoutMs: 25}), envelope = makeEnvelope();
  const before = journal.status().records, lock = childFixture(t, {mode: 'write-lock', file: journal.file});
  await lock.next('ready');
  refused(() => journal.admit(envelope), 'STORAGE_UNAVAILABLE');
  await lock.kill();
  assert.equal(journal.get(envelope.operationId), null);
  assert.equal(journal.status().records, before);
  assert.equal(journal.admit(envelope).duplicate, false);
});

test('real SQLite statement failures roll back operation reservations, journal appends and custody counters together', async t => {
  const directory = await temporary(t), journal = journalAt(t, directory), envelope = makeEnvelope();
  const alterFixture = sql => {
    const database = new DatabaseSync(journal.file);
    try { database.exec(sql); } finally { database.close(); }
  };
  const beforeAdmission = journal.status();
  // Fixture-only SQL abort, after the operation row has been inserted by admit().
  alterFixture("CREATE TRIGGER TEST_ONLY_abort_append BEFORE INSERT ON operation_transitions BEGIN SELECT RAISE(ABORT,'TEST_ONLY_ROLLBACK'); END;");
  refused(() => journal.admit(envelope), 'STORAGE_UNAVAILABLE');
  assert.equal(journal.get(envelope.operationId), null);
  assert.deepEqual(journal.status(), beforeAdmission);
  alterFixture('DROP TRIGGER TEST_ONLY_abort_append;');
  const admitted = journal.admit(envelope).operation, beforeTransition = journal.status();
  // The record and its custody counters were written before the projection update.
  alterFixture("CREATE TRIGGER TEST_ONLY_abort_projection BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'TEST_ONLY_ROLLBACK'); END;");
  const intent = eventFor(admitted, 'DISPATCH_INTENT');
  refused(() => journal.transition(intent), 'STORAGE_UNAVAILABLE');
  assert.deepEqual(journal.get(envelope.operationId), admitted);
  assert.deepEqual(journal.status(), beforeTransition);
  assert.equal(journal.read().records.some(item => item.record.event.eventId === intent.eventId), false);
  alterFixture('DROP TRIGGER TEST_ONLY_abort_projection;');
  assert.equal(journal.transition(intent).duplicate, false);
  assert.equal(journal.status().records, beforeTransition.records + 1);
  t.diagnostic('Real SQLite transactional rollback under fixture-installed statement aborts; not an OS-full-disk qualification.');
});

test('forbidden content and accessor payloads never enter SQLite sidecars or error messages', async t => {
  const directory = await temporary(t), journal = journalAt(t, directory), envelope = makeEnvelope();
  const sentinel = 'TEST_ONLY_PRIVATE_CONTENT_' + randomUUID();
  const operation = journal.admit(envelope).operation, before = journal.status().records;
  for (const key of ['prompt', 'arguments', 'rawOutput', 'privateReasoning', 'contentHash', 'contentHmac', 'credential']) {
    const input = {...makeEnvelope(), [key]: sentinel};
    assert.throws(() => journal.admit(input), error => error.name === 'ControlError' && !String(error).includes(sentinel));
    assert.throws(() => journal.transition({...eventFor(operation, 'DISPATCH_INTENT'), [key]: sentinel}),
      error => error.name === 'ControlError' && !String(error).includes(sentinel));
  }
  let getterCalls = 0;
  const accessor = {...makeEnvelope()};
  Object.defineProperty(accessor, 'prompt', {enumerable: true, get() { getterCalls++; return sentinel; }});
  assert.throws(() => journal.admit(accessor), error => error.name === 'ControlError');
  assert.equal(getterCalls, 0);
  assert.equal(journal.status().records, before);
  for (const filename of await readdir(directory)) {
    if (!/\.sqlite(?:-wal|-shm)?$/.test(filename)) continue;
    assert.equal((await readFile(path.join(directory, filename))).includes(Buffer.from(sentinel)), false, filename);
  }
  const database = new DatabaseSync(journal.file);
  try { assert.equal(Object.values(database.prepare('PRAGMA quick_check').get())[0], 'ok'); } finally { database.close(); }
});

test('bounded cursor pages and immutable record hashes survive close/reopen with pending archive custody', async t => {
  const directory = await temporary(t), journal = ControlJournal.open({directory});
  let originalClosed = false;
  onCleanup(t, () => { if (!originalClosed) journal.close(); });
  for (let index = 0; index < 6; index++) {
    const operation = journal.admit(makeEnvelope()).operation;
    journal.transition(eventFor(operation, 'DISPATCH_INTENT'));
  }
  const status = journal.status(), records = [];
  let after = 0, through;
  for (let pages = 0; pages < 20; pages++) {
    const page = journal.read({after, ...(through === undefined ? {} : {through}), limit: 2});
    through ??= page.through;
    assert.equal(page.journalId, status.journalId);
    for (const record of page.records) {
      assert.ok(record.sequence > after);
      assert.match(record.sha256, /^[a-f0-9]{64}$/);
      records.push(record);
    }
    after = page.nextCursor;
    if (page.caughtUp) break;
  }
  assert.equal(records.length, status.records);
  journal.close();
  originalClosed = true;
  const reopened = journalAt(t, directory), restored = reopened.read({limit: 100, through});
  assert.equal(reopened.status().journalId, status.journalId);
  assert.deepEqual(restored.records, records);
  assert.equal(reopened.status().pendingRecords, status.pendingRecords);
  assert.equal(reopened.status().pendingBytes, status.pendingBytes);
});
