import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {validateOperation, validateOperationContext} from '../contracts/operations.mjs';
import {validateNativeReference} from '../contracts/requests.mjs';
import {ControlError, isControlError, CONTROL_REASON_CODES} from './errors.mjs';
import {arrayValues, canonicalJson, deepFreeze, enumValue, integer, strictRecord, uuid} from './privacy.mjs';
import {OPERATION_EVENTS, OPERATION_STATES, transitionOperationState} from './state-machine.mjs';
import {buildArchiveBatch, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_RECORDS,
  validateArchiveTrust, verifyArchiveReceipt} from './archive.mjs';

const migration = fs.readFileSync(fileURLToPath(new URL('../migrations/001-foundation.sql', import.meta.url)), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const schemaHash = hash(migration);
const MiB = 1024 * 1024;
const fail = code => { throw new ControlError(code); };
const emergencyActions = new Set(['turn.interrupt', 'runtime.stop', 'terminal.terminate']);

function checkedDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) ||
      /^(?:\\\\|\/\/)/.test(directory)) fail('INVALID_INPUT');
  const resolved = path.resolve(directory);
  // Refuse symlinks/junctions in existing ancestors. Host-local mount identity
  // and ACL qualification remain installation responsibilities, not a P1 claim.
  let current = resolved;
  while (true) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('INVALID_INPUT');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  fs.mkdirSync(resolved, {recursive: true, mode: 0o700});
  const canonical = fs.realpathSync.native(resolved);
  if (/^(?:\\\\|\/\/)/.test(canonical)) fail('INVALID_INPUT');
  const filesystem = fs.statfsSync(canonical);
  if ([0x6969, 0x517b, 0xff534d42].includes(filesystem.type)) fail('INVALID_INPUT');
  return canonical;
}

function availableBytes(directory) {
  const stat = fs.statfsSync(directory, {bigint: true});
  const available = stat.bavail * stat.bsize;
  return Number(available > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : available);
}

function validateTransition(input) {
  const required = ['operationId','eventId','expectedRevision','type','atMs','context'];
  strictRecord(input, [...required, 'native','reasonCode','evidenceId'], required);
  const event = {
    operationId: uuid(input.operationId), eventId: uuid(input.eventId),
    expectedRevision: integer(input.expectedRevision, 1), type: enumValue(input.type, OPERATION_EVENTS),
    atMs: integer(input.atMs), context: validateOperationContext(input.context),
    native: input.native === undefined || input.native === null ? null : validateNativeReference(input.native),
    reasonCode: enumValue(input.reasonCode ?? 'NONE', CONTROL_REASON_CODES),
    evidenceId: input.evidenceId === undefined || input.evidenceId === null ? null : uuid(input.evidenceId)
  };
  if (event.type.startsWith('RECONCILED_') && (!event.evidenceId || event.reasonCode !== 'RECONCILED')) {
    fail('INVALID_INPUT');
  }
  return deepFreeze(event);
}

function validateRecord(input) {
  strictRecord(input, ['version','journalId','envelope','event','state','revision','late']);
  if (input.version !== 1 || typeof input.late !== 'boolean') fail('INVALID_INPUT');
  const envelope = validateOperation(input.envelope);
  strictRecord(input.event, ['operationId','eventId','expectedRevision','type','atMs','context','native','reasonCode','evidenceId']);
  let event;
  if (input.event.type === 'ADMITTED') {
    if (input.event.expectedRevision !== 0 || input.event.native !== null ||
        input.event.reasonCode !== 'NONE' || input.event.evidenceId !== null) fail('INVALID_INPUT');
    event = {operationId: uuid(input.event.operationId), eventId: uuid(input.event.eventId),
      expectedRevision: 0, type: 'ADMITTED', atMs: integer(input.event.atMs),
      context: validateOperationContext(input.event.context), native: null, reasonCode: 'NONE', evidenceId: null};
  } else {
    event = validateTransition(input.event);
  }
  if (event.operationId !== envelope.operationId ||
      canonicalJson(event.context) !== canonicalJson(envelope.context)) fail('INVALID_INPUT');
  return deepFreeze({version: 1, journalId: uuid(input.journalId), envelope, event,
    state: enumValue(input.state, OPERATION_STATES), revision: integer(input.revision, 1), late: input.late});
}

/**
 * Optional, local metadata storage only. Importing this module creates no DB,
 * timer, child process or network connection. It performs no native dispatch.
 * The later broker must enforce current authority and kernel-held ownership.
 */
export class ControlJournal {
  #db;
  #now;
  #probe;
  #reserve;
  #emergency;
  #maxPending;
  #trust;
  #journalId;
  #closed = false;

  static open(options) { return new ControlJournal(options); }

  constructor(options = {}) {
    strictRecord(options, ['directory','now','storageProbe','reserveBytes','emergencyReserveBytes',
      'maxPendingBytes','busyTimeoutMs','archiveTrust'], ['directory']);
    const {directory, now = Date.now, storageProbe = availableBytes,
      reserveBytes = 64 * MiB, emergencyReserveBytes = 4 * MiB,
      maxPendingBytes = 256 * MiB, busyTimeoutMs = 1000, archiveTrust} = options;
    if (typeof now !== 'function' || typeof storageProbe !== 'function') fail('INVALID_INPUT');
    this.#now = now;
    this.#probe = storageProbe;
    this.#reserve = integer(reserveBytes, 1);
    this.#emergency = integer(emergencyReserveBytes, 1, this.#reserve);
    this.#maxPending = integer(maxPendingBytes, 1);
    integer(busyTimeoutMs, 0, 30_000);
    this.#trust = archiveTrust === undefined ? null : validateArchiveTrust(archiveTrust);
    try {
      this.directory = checkedDirectory(directory);
      this.file = path.join(this.directory, 'control.sqlite');
      for (const suffix of ['', '-wal', '-shm']) {
        const filename = this.file + suffix;
        try {
          const stat = fs.lstatSync(filename);
          if (!stat.isFile() || stat.isSymbolicLink()) fail('INVALID_INPUT');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      this.#db = new DatabaseSync(this.file);
      this.#db.exec('PRAGMA busy_timeout=' + busyTimeoutMs + '; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 0 && version !== 1) fail('SCHEMA_MISMATCH');
      const tables = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (version === 0 && tables.length) fail('SCHEMA_MISMATCH');
      if (version === 1 && (!tables.some(row => row.name === 'journal_metadata') ||
          this.#db.prepare("SELECT value FROM journal_metadata WHERE key='schema_sha256'").get()?.value !== schemaHash)) {
        fail('SCHEMA_MISMATCH');
      }
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.#transaction(() => {
        const currentVersion = this.#db.prepare('PRAGMA user_version').get().user_version;
        if (currentVersion === 0) {
          if (this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
            fail('SCHEMA_MISMATCH');
          }
          this.#db.exec(migration);
          const insert = this.#db.prepare('INSERT INTO journal_metadata(key,value) VALUES(?,?)');
          insert.run('journal_id', randomUUID());
          insert.run('schema_sha256', schemaHash);
        }
        const metadata = Object.fromEntries(this.#db.prepare('SELECT key,value FROM journal_metadata').all().map(row => [row.key, row.value]));
        if (currentVersion !== 0 && currentVersion !== 1 || metadata.schema_sha256 !== schemaHash) fail('SCHEMA_MISMATCH');
        this.#journalId = uuid(metadata.journal_id);
        if (this.#trust) {
          const pin = canonicalJson({receiverId: this.#trust.receiverId, keySha256: this.#trust.keySha256});
          if (metadata.archive_pin && metadata.archive_pin !== pin) fail('ARCHIVE_INVALID');
          if (!metadata.archive_pin) this.#db.prepare('INSERT INTO journal_metadata(key,value) VALUES(?,?)').run('archive_pin', pin);
        }
      });
      if (process.platform !== 'win32') fs.chmodSync(this.file, 0o600);
    } catch (error) {
      try { this.#db?.close(); } catch {}
      this.#closed = true;
      if (isControlError(error)) throw error;
      fail('STORAGE_UNAVAILABLE');
    }
  }

  #assertOpen() { if (this.#closed) fail('CLOSED'); }
  #readSafely(callback) {
    this.#assertOpen();
    try { return callback(); }
    catch (error) {
      if (isControlError(error)) throw error;
      fail('STORAGE_UNAVAILABLE');
    }
  }
  #transaction(callback) {
    this.#assertOpen();
    let begun = false;
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      begun = true;
      const result = callback();
      if (result && typeof result.then === 'function') fail('INVALID_INPUT');
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      if (begun) try { this.#db.exec('ROLLBACK'); } catch {}
      if (isControlError(error)) throw error;
      fail('STORAGE_UNAVAILABLE');
    }
  }
  #counts() { return this.#db.prepare('SELECT * FROM journal_counts WHERE id=1').get(); }
  #requireCapacity(bytes, emergency = false) {
    const available = this.#probe(this.directory);
    if (!Number.isSafeInteger(available) || available < 0) fail('STORAGE_UNAVAILABLE');
    // Logical record size is not a physical SQLite allocation estimate.
    // A conservative fixed write allowance leaves WAL/index working space.
    const allowance = Math.max(64 * 1024, bytes * 4);
    if (available < (emergency ? this.#emergency : this.#reserve) + allowance) fail('CAPACITY');
    if (!emergency && this.#counts().pending_bytes + bytes > this.#maxPending) fail('CAPACITY');
  }
  #operation(row) {
    if (!row) return null;
    return deepFreeze({envelope: validateOperation(JSON.parse(row.envelope_json)),
      state: enumValue(row.state, OPERATION_STATES),
      revision: integer(row.revision, 1), lastEventId: uuid(row.last_event_id), lastAtMs: integer(row.last_at_ms)});
  }
  #row(id) { return this.#db.prepare('SELECT * FROM operations WHERE operation_id=?').get(id); }
  #record(envelope, event, state, revision, late) {
    return {version: 1, journalId: this.#journalId, envelope, event, state, revision, late};
  }
  #insert(record) {
    const text = canonicalJson(record);
    const bytes = Buffer.byteLength(text);
    if (bytes > 32 * 1024) fail('CAPACITY');
    this.#db.prepare('INSERT INTO operation_transitions(event_id,operation_id,revision,record_json,record_sha256,record_bytes) VALUES(?,?,?,?,?,?)')
      .run(record.event.eventId, record.envelope.operationId, record.revision, text, hash(text), bytes);
  }

  admit(input) {
    this.#assertOpen();
    const envelope = validateOperation(input);
    const text = canonicalJson(envelope);
    return this.#transaction(() => {
      const byId = this.#row(envelope.operationId);
      const byKey = this.#db.prepare('SELECT * FROM operations WHERE actor_id=? AND request_key=?').get(envelope.actorId, envelope.requestKey);
      const existing = byId || byKey;
      if (existing) {
        if (byId && byKey && byId.operation_id !== byKey.operation_id || existing.envelope_json !== text) fail('CONFLICT');
        return {duplicate: true, operation: this.#operation(existing)};
      }
      const atMs = integer(this.#now());
      if (envelope.deadlineAtMs <= atMs) fail('EXPIRED');
      if (envelope.createdAtMs > atMs + 5 * 60_000) fail('INVALID_INPUT');
      if (this.#db.prepare('SELECT 1 FROM operation_transitions WHERE event_id=?').get(envelope.operationId)) fail('CONFLICT');
      const event = {operationId: envelope.operationId, eventId: envelope.operationId, expectedRevision: 0,
        type: 'ADMITTED', atMs, context: envelope.context, native: null, reasonCode: 'NONE', evidenceId: null};
      const record = this.#record(envelope, event, 'ADMITTED', 1, false);
      this.#requireCapacity(Buffer.byteLength(canonicalJson(record)), emergencyActions.has(envelope.action));
      this.#db.prepare('INSERT INTO operations(operation_id,actor_id,request_key,envelope_json,connection_epoch,state,revision,last_event_id,last_at_ms) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(envelope.operationId, envelope.actorId, envelope.requestKey, text, envelope.context.connectionEpoch,
          'ADMITTED', 1, event.eventId, atMs);
      this.#insert(record);
      return {duplicate: false, operation: this.#operation(this.#row(envelope.operationId))};
    });
  }

  get(operationId) {
    this.#assertOpen();
    const id = uuid(operationId);
    return this.#readSafely(() => this.#operation(this.#row(id)));
  }

  #transition(event) {
    const prior = this.#db.prepare('SELECT record_json FROM operation_transitions WHERE event_id=?').get(event.eventId);
    if (prior) {
      const record = validateRecord(JSON.parse(prior.record_json));
      if (canonicalJson(record.event) !== canonicalJson(event)) fail('CONFLICT');
      return {duplicate: true, late: record.late, operation: this.#operation(this.#row(event.operationId)),
        receipt: deepFreeze({eventId: event.eventId, state: record.state, revision: record.revision})};
    }
    const row = this.#row(event.operationId);
    if (!row) fail('NOT_FOUND');
    const envelope = validateOperation(JSON.parse(row.envelope_json));
    if (canonicalJson(event.context) !== canonicalJson(envelope.context)) fail('STALE_CONTEXT');
    if (event.expectedRevision !== row.revision) fail('STALE_REVISION');
    if (event.type === 'DISPATCH_INTENT' && envelope.deadlineAtMs <= integer(this.#now())) fail('EXPIRED');
    const next = transitionOperationState(row.state, event.type);
    const revision = row.revision + 1;
    integer(revision, 1);
    const record = this.#record(envelope, event, next.state, revision, next.late);
    this.#requireCapacity(Buffer.byteLength(canonicalJson(record)),
      event.type !== 'DISPATCH_INTENT' || emergencyActions.has(envelope.action));
    this.#insert(record);
    this.#db.prepare('UPDATE operations SET state=?,revision=?,last_event_id=?,last_at_ms=? WHERE operation_id=?')
      .run(next.state, revision, event.eventId, event.atMs, event.operationId);
    return {duplicate: false, late: next.late, operation: this.#operation(this.#row(event.operationId)),
      receipt: deepFreeze({eventId: event.eventId, state: next.state, revision})};
  }

  transition(input) {
    this.#assertOpen();
    const event = validateTransition(input);
    return this.#transaction(() => this.#transition(event));
  }

  /**
   * The caller must already have retired this connection epoch under exclusive
   * ownership. Merely opening a second journal connection does NOT recover it.
   * This classification never launches/replays anything or grants authority.
   */
  recover(input) {
    strictRecord(input, ['connectionEpoch','atMs','limit'], ['connectionEpoch','atMs']);
    const connectionEpoch = uuid(input.connectionEpoch), atMs = integer(input.atMs);
    const limit = integer(input.limit ?? 100, 1, 1000);
    return this.#transaction(() => {
      const rows = this.#db.prepare("SELECT * FROM operations WHERE connection_epoch=? AND state NOT IN ('COMPLETED','FAILED','INTERRUPTED','CANCELLED','EXPIRED','NOT_DISPATCHED','UNKNOWN') ORDER BY operation_id LIMIT ?").all(connectionEpoch, limit + 1);
      const recovered = [];
      for (const row of rows.slice(0, limit)) {
        const envelope = validateOperation(JSON.parse(row.envelope_json));
        const event = validateTransition({operationId: row.operation_id, eventId: randomUUID(),
          expectedRevision: row.revision, type: row.state === 'ADMITTED' ? 'NOT_DISPATCHED' : 'UNKNOWN',
          atMs, context: envelope.context, reasonCode: 'LOST_ON_RESTART'});
        const {operation} = this.#transition(event);
        recovered.push({operationId: row.operation_id, state: operation.state, revision: operation.revision});
      }
      return {recovered, count: recovered.length, hasMore: rows.length > limit};
    });
  }

  status() {
    return this.#readSafely(() => {
      const counts = this.#counts();
      return deepFreeze({journalId: this.#journalId, schemaVersion: 1,
        records: counts.records, recordBytes: counts.record_bytes,
        pendingRecords: counts.pending_records, pendingBytes: counts.pending_bytes,
        archive: {status: this.#trust ? 'PINNED_RECEIPT_VERIFIER_ONLY' : 'NOT_CONFIGURED',
          receiverId: this.#trust?.receiverId ?? null, transportImplemented: false, evictionImplemented: false}});
    });
  }

  read(options = {}) {
    strictRecord(options, ['after','through','limit','maxBytes','journalId'], []);
    let {after = 0, through, limit = 100, maxBytes = MiB, journalId} = options;
    return this.#readSafely(() => {
    integer(after);
    integer(limit, 1, 1000);
    integer(maxBytes, 1, MAX_ARCHIVE_BYTES);
    if (journalId !== undefined && uuid(journalId) !== this.#journalId) fail('STALE_CONTEXT');
    const high = this.#db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM operation_transitions').get().n;
    if (through === undefined) through = high;
    integer(through, 0, high);
    if (after > through) fail('INVALID_INPUT');
    const records = [];
    let bytes = 0, nextCursor = after;
    for (const row of this.#db.prepare('SELECT * FROM operation_transitions WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').iterate(after, through, limit + 1)) {
      if (records.length >= limit) break;
      if (bytes + row.record_bytes > maxBytes) {
        if (!records.length) fail('CAPACITY');
        break;
      }
      const actual = hash(row.record_json);
      if (actual !== row.record_sha256 || Buffer.byteLength(row.record_json) !== row.record_bytes) fail('STORAGE_UNAVAILABLE');
      records.push({sequence: row.sequence, sha256: actual, record: validateRecord(JSON.parse(row.record_json))});
      bytes += row.record_bytes;
      nextCursor = row.sequence;
    }
    return deepFreeze({journalId: this.#journalId, through, records, nextCursor,
      caughtUp: nextCursor === through, bytes});
    });
  }

  selectArchiveBatch(options = {}) {
    strictRecord(options, ['limit','maxBytes'], []);
    const {limit = 100, maxBytes = MiB} = options;
    return this.#readSafely(() => {
    integer(limit, 1, MAX_ARCHIVE_RECORDS);
    integer(maxBytes, 1, MAX_ARCHIVE_BYTES);
    const records = [];
    let bytes = 0;
    for (const row of this.#db.prepare('SELECT t.* FROM operation_transitions t LEFT JOIN archived_record_versions a ON a.event_id=t.event_id WHERE a.event_id IS NULL ORDER BY t.sequence LIMIT ?').iterate(limit)) {
      if (bytes + row.record_bytes > maxBytes) {
        if (!records.length) fail('CAPACITY');
        break;
      }
      if (hash(row.record_json) !== row.record_sha256 || Buffer.byteLength(row.record_json) !== row.record_bytes) fail('STORAGE_UNAVAILABLE');
      records.push({sequence: row.sequence, sha256: row.record_sha256, record: validateRecord(JSON.parse(row.record_json))});
      bytes += row.record_bytes;
    }
    return buildArchiveBatch(this.#journalId, records);
    });
  }

  recordArchiveReceipt(input) {
    this.#assertOpen();
    strictRecord(input, ['batch','receipt']);
    const {batch, receipt} = input;
    if (!this.#trust) fail('ARCHIVE_INVALID');
    strictRecord(batch, ['version','journalId','records','recordCount','recordBytes','batchSha256']);
    const suppliedRecords = arrayValues(batch.records, 1, MAX_ARCHIVE_RECORDS);
    if (batch.version !== 1 || batch.journalId !== this.#journalId) fail('ARCHIVE_INVALID');
    // Canonicalize only after strict top-level bounds; each supplied record is
    // compared with its immutable database copy before any archive-state write.
    return this.#transaction(() => {
      const records = suppliedRecords.map(supplied => {
        strictRecord(supplied, ['sequence','sha256','record']);
        const row = this.#db.prepare('SELECT * FROM operation_transitions WHERE sequence=?').get(integer(supplied.sequence, 1));
        if (!row || supplied.sha256 !== row.record_sha256 ||
            hash(row.record_json) !== row.record_sha256 ||
            canonicalJson(validateRecord(supplied.record)) !== row.record_json) fail('ARCHIVE_INVALID');
        return {sequence: row.sequence, sha256: row.record_sha256, record: validateRecord(JSON.parse(row.record_json))};
      });
      const trustedBatch = buildArchiveBatch(this.#journalId, records);
      if (batch.batchSha256 !== trustedBatch.batchSha256 || batch.recordCount !== trustedBatch.recordCount ||
          batch.recordBytes !== trustedBatch.recordBytes) fail('ARCHIVE_INVALID');
      const checked = verifyArchiveReceipt(receipt, trustedBatch, this.#trust);
      const receiptText = canonicalJson(checked);
      const prior = this.#db.prepare('SELECT receipt_json FROM archive_receipts WHERE receipt_id=?').get(checked.receiptId);
      if (prior) {
        if (prior.receipt_json !== receiptText) fail('CONFLICT');
        return {duplicate: true, acknowledged: 0, pendingRecords: this.#counts().pending_records};
      }
      this.#requireCapacity(Buffer.byteLength(receiptText) + records.length * 256, true);
      this.#db.prepare('INSERT INTO archive_receipts(receipt_id,receiver_id,batch_sha256,receipt_json,verified_at_ms) VALUES(?,?,?,?,?)')
        .run(checked.receiptId, checked.receiverId, checked.batchSha256, receiptText, integer(this.#now()));
      let acknowledged = 0;
      const insert = this.#db.prepare('INSERT OR IGNORE INTO archived_record_versions(event_id,record_sha256,receipt_id) VALUES(?,?,?)');
      for (const row of records) acknowledged += Number(insert.run(row.record.event.eventId, row.sha256, checked.receiptId).changes);
      return {duplicate: false, acknowledged, pendingRecords: this.#counts().pending_records};
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#db.close(); } catch { fail('STORAGE_UNAVAILABLE'); }
  }
}
