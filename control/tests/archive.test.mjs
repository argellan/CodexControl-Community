import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, generateKeyPairSync, randomUUID, sign} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {ControlJournal} from '../lib/journal.mjs';
import {canonicalJson} from '../lib/privacy.mjs';
import {receiptSigningBytes} from '../lib/archive.mjs';

const now = 1_700_000_000_000;
const hash = value => createHash('sha256').update(value).digest('hex');
function envelope() {
  return {version: 1, operationId: randomUUID(), requestKey: randomUUID(), actorId: randomUUID(),
    action: 'turn.start',
    target: {hostId: randomUUID(), projectId: randomUUID(), providerProfileId: randomUUID(),
      runtimeId: randomUUID(), sessionId: randomUUID(), turnId: null, terminalId: null, requestId: null},
    context: {entityRevision: 0, policyRevision: 1, grantRevision: 1, authorityGeneration: 1,
      ownershipFence: 1, connectionEpoch: randomUUID()},
    createdAtMs: now, deadlineAtMs: now + 60_000, timeoutMs: 60_000};
}
function fixture(fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-control-archive-test-'));
  const keys = generateKeyPairSync('ed25519');
  const trust = {receiverId: randomUUID(), publicKey: keys.publicKey};
  let journal = ControlJournal.open({directory, now: () => now, archiveTrust: trust});
  const signed = (batch, changes = {}, signingKey = keys.privateKey) => {
    const segment = Buffer.from(canonicalJson(batch));
    const receipt = {version: 1, receiptId: randomUUID(), receiverId: trust.receiverId,
      journalId: batch.journalId, segmentId: randomUUID(), segmentSha256: hash(segment),
      batchSha256: batch.batchSha256, recordCount: batch.recordCount, recordBytes: batch.recordBytes,
      durable: true, storedAtMs: now, ...changes};
    return {...receipt, signature: sign(null, receiptSigningBytes(receipt), signingKey).toString('base64')};
  };
  try {
    return fn({directory, journal, trust, signed,
      reopen: () => {journal.close(); journal = ControlJournal.open({directory, now: () => now, archiveTrust: trust}); return journal;}});
  } finally {
    journal.close();
    // Test-only directory created by this fixture; no source or captured data.
    assert.equal(fs.realpathSync(path.dirname(directory)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('codex-control-archive-test-'));
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

test('exact signed closed metadata segment, lost receipt retry and later versions retain custody', () => fixture(ctx => {
  const operation = envelope();
  ctx.journal.admit(operation);
  const batch = ctx.journal.selectArchiveBatch();
  const receipt = ctx.signed(batch);
  const segmentFile = path.join(ctx.directory, receipt.segmentId + '.json');
  const bytes = Buffer.from(canonicalJson(batch));
  const fd = fs.openSync(segmentFile, 'wx', 0o600);
  try {fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  assert.equal(hash(fs.readFileSync(segmentFile)), receipt.segmentSha256);
  assert.equal(ctx.journal.status().pendingRecords, 1);
  // Receiver has written, sender has not acknowledged: exact record stays pending.
  let journal = ctx.reopen();
  assert.equal(journal.status().pendingRecords, 1);
  assert.deepEqual(journal.selectArchiveBatch(), batch);
  assert.equal(journal.recordArchiveReceipt({batch, receipt}).acknowledged, 1);
  journal = ctx.reopen();
  assert.equal(journal.recordArchiveReceipt({batch, receipt}).duplicate, true);
  journal.transition({operationId: operation.operationId, eventId: randomUUID(), expectedRevision: 1,
    type: 'DISPATCH_INTENT', atMs: now, context: operation.context});
  assert.equal(journal.status().records, 2);
  assert.equal(journal.status().pendingRecords, 1);
  assert.equal(journal.selectArchiveBatch().records[0].record.revision, 2);
  assert.equal(journal.read().records.length, 2);
  assert.equal(journal.status().archive.evictionImplemented, false);
}));

test('wrong receiver, unsigned/false durability and content/version tampering never acknowledge', () => fixture(({journal, signed}) => {
  journal.admit(envelope());
  const batch = journal.selectArchiveBatch();
  const baseline = journal.status();
  const stranger = generateKeyPairSync('ed25519');
  for (const receipt of [
    signed(batch, {receiverId: randomUUID()}),
    signed(batch, {journalId: randomUUID()}),
    signed(batch, {batchSha256: '0'.repeat(64)}),
    signed(batch, {recordCount: 2}),
    signed(batch, {durable: false}),
    signed(batch, {}, stranger.privateKey),
    {...signed(batch), signature: 'A'.repeat(86) + '=='}
  ]) {
    assert.throws(() => journal.recordArchiveReceipt({batch, receipt}), error => error.code === 'ARCHIVE_INVALID');
    assert.deepEqual(journal.status(), baseline);
  }
  const altered = structuredClone(batch);
  altered.records[0].record.envelope.context.policyRevision++;
  assert.throws(() => journal.recordArchiveReceipt({batch: altered, receipt: signed(batch)}));
  const injected = structuredClone(batch);
  injected.records[0].record.prompt = 'TEST_ONLY_EXCLUDED_CONTENT_SENTINEL';
  assert.throws(() => journal.recordArchiveReceipt({batch: injected, receipt: signed(batch)}));
  assert.deepEqual(journal.status(), baseline);
}));

test('receipt identity conflicts, key replacement and direct deletion are refused', () => fixture(({journal, directory, signed, trust}) => {
  journal.admit(envelope());
  const batch = journal.selectArchiveBatch(), receipt = signed(batch);
  journal.recordArchiveReceipt({batch, receipt});
  assert.throws(() => journal.recordArchiveReceipt({batch, receipt: signed(batch, {receiptId: receipt.receiptId})}),
    error => error.code === 'CONFLICT');
  const stranger = generateKeyPairSync('ed25519');
  assert.throws(() => ControlJournal.open({directory, archiveTrust: {...trust, publicKey: stranger.publicKey}}),
    error => error.code === 'ARCHIVE_INVALID');
  const db = new DatabaseSync(journal.file);
  try {
    assert.throws(() => db.exec('DELETE FROM operation_transitions'));
    assert.throws(() => db.exec('UPDATE operation_transitions SET record_sha256=' + "'0'"));
    assert.throws(() => db.exec('DELETE FROM archive_receipts'));
    assert.throws(() => db.exec('DELETE FROM archived_record_versions'));
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  } finally {db.close();}
  assert.equal(journal.read().records.length, 1);
}));

test('unconfigured archive and bounded batches keep every record pending', () => fixture(({journal, directory}) => {
  for (let i = 0; i < 4; i++) journal.admit(envelope());
  const batch = journal.selectArchiveBatch({limit: 2});
  assert.equal(batch.recordCount, 2);
  assert.throws(() => journal.selectArchiveBatch({maxBytes: 1}), error => error.code === 'CAPACITY');
  const other = ControlJournal.open({directory, now: () => now});
  try {
    assert.equal(other.status().archive.status, 'NOT_CONFIGURED');
    assert.throws(() => other.recordArchiveReceipt({batch, receipt: {}}), error => error.code === 'ARCHIVE_INVALID');
    assert.equal(other.status().pendingRecords, 4);
  } finally {other.close();}
}));

test('metadata API accessors and decorated arrays cannot execute or escape safe validation', () => fixture(({journal, signed}) => {
  journal.admit(envelope());
  const batch = journal.selectArchiveBatch(), receipt = signed(batch);
  let ran = false;
  const hostile = {};
  Object.defineProperty(hostile, 'receipt', {enumerable: true, get() {ran = true; throw new Error('TEST_ONLY_SECRET');}});
  Object.defineProperty(hostile, 'batch', {enumerable: true, value: batch});
  assert.throws(() => journal.recordArchiveReceipt(hostile), error => error.code === 'INVALID_INPUT' && !error.message.includes('SECRET'));
  assert.equal(ran, false);
  const decorated = [...batch.records];
  decorated.map = () => {ran = true; throw new Error('TEST_ONLY_SECRET');};
  assert.throws(() => journal.recordArchiveReceipt({batch: {...batch, records: decorated}, receipt}), error => error.code === 'INVALID_INPUT');
  assert.equal(ran, false);
  for (const method of ['read','selectArchiveBatch']) {
    const options = {};
    Object.defineProperty(options, 'limit', {enumerable: true, get() {ran = true; return 1;}});
    assert.throws(() => journal[method](options), error => error.code === 'INVALID_INPUT');
  }
  assert.equal(ran, false);
  assert.equal(journal.status().pendingRecords, 1);
}));
