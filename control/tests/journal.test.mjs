import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {ControlJournal} from '../lib/journal.mjs';

const now = 1_700_000_000_000;
const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-control-journal-unit-'));
  t.after(() => {
    assert.equal(fs.realpathSync(path.dirname(directory)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('codex-control-journal-unit-'));
    fs.rmSync(directory, {recursive: true, force: true});
  });
  return directory;
}
function envelope() {
  return {version: 1, operationId: randomUUID(), requestKey: randomUUID(), actorId: randomUUID(),
    action: 'turn.start',
    target: {hostId: randomUUID(), projectId: randomUUID(), providerProfileId: randomUUID(),
      runtimeId: randomUUID(), sessionId: randomUUID(), turnId: null, terminalId: null, requestId: null},
    context: {entityRevision: 0, policyRevision: 1, grantRevision: 1, authorityGeneration: 1,
      ownershipFence: 1, connectionEpoch: randomUUID()},
    createdAtMs: now, deadlineAtMs: now + 60_000, timeoutMs: 60_000};
}
function transition(operation, type, extra = {}) {
  return {operationId: operation.envelope.operationId, eventId: randomUUID(), expectedRevision: operation.revision,
    type, atMs: now, context: operation.envelope.context, ...extra};
}

test('foreign and newer schemas are refused without changing original database bytes', t => {
  const directory = temporary(t), file = path.join(directory, 'control.sqlite');
  let db = new DatabaseSync(file);
  db.exec('CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES(' + "'preserved'" + ');');
  db.close();
  const before = hashFile(file);
  assert.throws(() => ControlJournal.open({directory}), error => error.code === 'SCHEMA_MISMATCH');
  assert.equal(hashFile(file), before);
  db = new DatabaseSync(file);
  db.exec('PRAGMA user_version=42');
  db.close();
  const newer = hashFile(file);
  assert.throws(() => ControlJournal.open({directory}), error => error.code === 'SCHEMA_MISMATCH');
  assert.equal(hashFile(file), newer);
});

test('expired dispatch, ambiguous expiry and explicit reconciliation retain truthful distinct states', t => {
  const directory = temporary(t);
  let time = now;
  const journal = ControlJournal.open({directory, now: () => time});
  try {
    const first = journal.admit(envelope()).operation;
    time += 60_000;
    assert.throws(() => journal.transition(transition(first, 'DISPATCH_INTENT')), error => error.code === 'EXPIRED');
    assert.equal(journal.get(first.envelope.operationId).state, 'ADMITTED');
    assert.equal(journal.transition(transition(first, 'EXPIRED')).operation.state, 'EXPIRED');
    time = now;
    const other = journal.admit(envelope()).operation;
    const intent = journal.transition(transition(other, 'DISPATCH_INTENT')).operation;
    const unknown = journal.transition(transition(intent, 'EXPIRED')).operation;
    assert.equal(unknown.state, 'UNKNOWN');
    assert.throws(() => journal.transition(transition(unknown, 'DISPATCH_INTENT')),
      error => error.code === 'INVALID_TRANSITION');
    assert.throws(() => journal.transition(transition(unknown, 'RECONCILED_COMPLETED')),
      error => error.code === 'INVALID_INPUT');
    const reconciled = journal.transition(transition(unknown, 'RECONCILED_COMPLETED',
      {reasonCode: 'RECONCILED', evidenceId: randomUUID()}));
    assert.equal(reconciled.operation.state, 'COMPLETED');
    assert.equal(journal.status().records, journal.status().pendingRecords);
  } finally {journal.close();}
});

test('logical pending pressure refuses new work without pruning and emergency reconciliation still appends', t => {
  const directory = temporary(t);
  let journal = ControlJournal.open({directory, now: () => now});
  const first = journal.admit(envelope()).operation;
  const before = journal.read();
  journal.close();
  journal = ControlJournal.open({directory, now: () => now, maxPendingBytes: 1});
  try {
    assert.throws(() => journal.admit(envelope()), error => error.code === 'CAPACITY');
    assert.deepEqual(journal.read(), before);
    assert.equal(journal.recover({connectionEpoch: first.envelope.context.connectionEpoch, atMs: now}).count, 1);
    assert.equal(journal.get(first.envelope.operationId).state, 'NOT_DISPATCHED');
    assert.equal(journal.read().records.length, 2);
    assert.equal(journal.status().pendingRecords, 2);
  } finally {journal.close();}
});

test('snapshot high-water pagination excludes later commits while retaining the same journal identity', t => {
  const journal = ControlJournal.open({directory: temporary(t), now: () => now});
  try {
    for (let i = 0; i < 3; i++) journal.admit(envelope());
    const first = journal.read({limit: 1});
    journal.admit(envelope());
    const rest = journal.read({after: first.nextCursor, through: first.through, journalId: first.journalId});
    assert.equal(rest.records.length, 2);
    assert.equal(rest.caughtUp, true);
    assert.equal(rest.through, 3);
    assert.equal(journal.read({after: rest.nextCursor}).records.length, 1);
    assert.throws(() => journal.read({journalId: randomUUID()}), error => error.code === 'STALE_CONTEXT');
    assert.throws(() => journal.read({through: 99}), error => error.code === 'INVALID_INPUT');
  } finally {journal.close();}
});

test('terminal observation duplicates preserve current projection and original receipt', t => {
  const journal = ControlJournal.open({directory: temporary(t), now: () => now});
  try {
    let current = journal.admit(envelope()).operation;
    current = journal.transition(transition(current, 'DISPATCH_INTENT')).operation;
    const ackEvent = transition(current, 'NATIVE_ACCEPTED', {native: {requestId: {type: 'number', value: 7}}});
    const ack = journal.transition(ackEvent);
    const complete = journal.transition(transition(ack.operation, 'COMPLETED'));
    const duplicate = journal.transition(ackEvent);
    assert.deepEqual(duplicate.receipt, ack.receipt);
    assert.deepEqual(duplicate.operation, complete.operation);
    assert.equal(duplicate.duplicate, true);
    assert.equal(journal.status().records, 4);
    const stringId = {...ackEvent, native: {requestId: {type: 'string', value: '7'}}};
    assert.throws(() => journal.transition(stringId), error => error.code === 'CONFLICT');
  } finally {journal.close();}
});

test('unexpected storage exceptions remain fixed errors without running thrown-object traps', t => {
  let trapped = false;
  const thrown = new Proxy({}, {get() {trapped = true; throw new Error('TEST_ONLY_STORAGE_SENTINEL');},
    getPrototypeOf() {trapped = true; throw new Error('TEST_ONLY_STORAGE_SENTINEL');}});
  const journal = ControlJournal.open({directory: temporary(t), now: () => now, storageProbe() {throw thrown;}});
  try {
    assert.throws(() => journal.admit(envelope()), error => error.code === 'STORAGE_UNAVAILABLE' &&
      !error.message.includes('SENTINEL'));
    assert.equal(trapped, false);
    assert.equal(journal.status().records, 0);
  } finally {journal.close();}
});
