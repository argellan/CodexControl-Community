import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {ControlError, isControlError} from '../lib/errors.mjs';
import {deepFreeze, integer, strictRecord, uuid} from '../lib/privacy.mjs';
import {ProjectRoot, holdLocalFile, inspectLocalDirectory, localDirectoryPath,
  verifyLocalFile} from './project-root.mjs';

const key = Symbol('ownership lease');
const fail = code => { throw new ControlError(code); };
// Also prevent same-process duplicate opens/closes: POSIX closing an unrelated fd
// for a locked inode can release that process's SQLite fcntl locks. All access to
// these dedicated files must go through this module, once per host process.
const reservations = new Set();
const anchorSchema = 'CREATE TABLE anchor (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), resourceId TEXT NOT NULL, instanceId TEXT NOT NULL) STRICT';
const fenceSchema = 'CREATE TABLE fence (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), resourceId TEXT NOT NULL, instanceId TEXT NOT NULL, fence INTEGER NOT NULL CHECK(fence>=0), ownerId TEXT, connectionEpoch TEXT) STRICT';

const translate = error => {
  if (isControlError(error)) return error;
  if (Number.isInteger(error?.errcode) && [5, 6].includes(error.errcode & 255)) return new ControlError('CONFLICT');
  return new ControlError('STORAGE_UNAVAILABLE');
};
function exists(filename) {
  try { fs.lstatSync(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function ensureDirectory(value) {
  const directory = localDirectoryPath(value);
  let ancestor = directory;
  const missing = [];
  while (!exists(ancestor)) {
    missing.push(ancestor);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) fail('STORAGE_UNAVAILABLE');
    ancestor = parent;
  }
  inspectLocalDirectory(ancestor);
  for (const next of missing.reverse()) {
    try { fs.mkdirSync(next, {mode: 0o700}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    inspectLocalDirectory(next);
  }
  // POSIX reject existing directories accessible to another uid/group; Windows
  // mode bits are not ACL evidence. Deployment must qualify Windows ACLs.
  if (process.platform !== 'win32') {
    const stat = fs.statSync(directory);
    if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) fail('INVALID_INPUT');
  }
  return directory;
}

function checkSidecars(filename) {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const sidecar = filename + suffix;
    if (!exists(sidecar)) continue;
    const stat = fs.lstatSync(sidecar, {bigint: true});
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) fail('INVALID_INPUT');
    // WAL is never part of this protocol. Even leftover WAL/SHM is uncertainty.
    if (suffix !== '-journal') fail('STORAGE_UNAVAILABLE');
  }
}

function schemaState(db, table, sql) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const schema = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 2").all();
  if (version === 0 && schema.length === 0) return 'empty';
  if (version !== 1 || schema.length !== 1 || schema[0].type !== 'table' ||
      schema[0].name !== table || schema[0].sql !== sql) fail('STORAGE_UNAVAILABLE');
  if (db.prepare('PRAGMA quick_check(1)').get().quick_check !== 'ok') fail('STORAGE_UNAVAILABLE');
  return 'ready';
}

function readAnchor(db, resourceId) {
  if (schemaState(db, 'anchor', anchorSchema) !== 'ready') fail('STORAGE_UNAVAILABLE');
  const rows = db.prepare('SELECT * FROM anchor LIMIT 2').all();
  if (rows.length !== 1 || rows[0].id !== 1 || rows[0].version !== 1 ||
      rows[0].resourceId !== resourceId) fail('STORAGE_UNAVAILABLE');
  uuid(rows[0].instanceId);
  return rows[0];
}

function readFence(db, resourceId, instanceId) {
  if (schemaState(db, 'fence', fenceSchema) !== 'ready') fail('STORAGE_UNAVAILABLE');
  const rows = db.prepare('SELECT * FROM fence LIMIT 2').all();
  if (rows.length !== 1 || rows[0].id !== 1 || rows[0].version !== 1 ||
      rows[0].resourceId !== resourceId || rows[0].instanceId !== instanceId) fail('STORAGE_UNAVAILABLE');
  const row = rows[0];
  integer(row.fence, 0);
  if (row.fence === 0) {
    if (row.ownerId !== null || row.connectionEpoch !== null) fail('STORAGE_UNAVAILABLE');
  } else { uuid(row.ownerId); uuid(row.connectionEpoch); }
  return row;
}

/** Dedicated rollback-mode SQLite connection holds BEGIN EXCLUSIVE for the
 * entire lease; a separate synchronous=EXTRA database commits the monotonic
 * fence before acquisition is returned. There are no expiry/steal timers.
 * Files are never unlinked/replaced by this module, including crash recovery.
 * Same-user malicious mutation, direct access to these private DB files, native
 * SQLite VFS/OS bugs and storage that lies about fsync are residual trust limits.
 */
export class OwnershipLease {
  #root;
  #files = [];
  #lock;
  #counter;
  #reservation;
  #snapshot;
  #instance;
  #closed = false;
  #lost = false;

  static acquire(options) {
    try {
      strictRecord(options, ['directory', 'resourceId', 'ownerId', 'connectionEpoch', 'busyTimeoutMs'],
        ['directory', 'resourceId', 'ownerId', 'connectionEpoch']);
      const input = {directory: localDirectoryPath(options.directory), resourceId: uuid(options.resourceId),
        ownerId: uuid(options.ownerId), connectionEpoch: uuid(options.connectionEpoch),
        busyTimeoutMs: options.busyTimeoutMs === undefined ? 250 : integer(options.busyTimeoutMs, 0, 30_000)};
      return new OwnershipLease(key, input);
    } catch (error) { throw translate(error); }
  }

  constructor(token, input) {
    if (token !== key) fail('INVALID_INPUT');
    const deadline = performance.now() + input.busyTimeoutMs;
    const budget = db => db.exec('PRAGMA busy_timeout=' + Math.max(0, Math.ceil(deadline - performance.now())));
    const exec = (db, sql) => { budget(db); return db.exec(sql); };
    try {
      this.#root = ProjectRoot.open({directory: ensureDirectory(input.directory)});
      const stem = path.join(this.#root.directory, input.resourceId);
      this.#reservation = path.join(this.#root.identity().canonicalDirectory, input.resourceId);
      if (reservations.has(this.#reservation)) { this.#reservation = undefined; fail('CONFLICT'); }
      reservations.add(this.#reservation);
      const filenames = [stem + '.ownership.sqlite', stem + '.fence.sqlite'];
      const present = filenames.map(exists);
      if (present[0] !== present[1]) fail('STORAGE_UNAVAILABLE');
      for (const filename of filenames) {
        checkSidecars(filename);
        const held = holdLocalFile(filename, !present[0]);
        this.#files.push(held);
        if (fs.fstatSync(held.fd).size > 1024 * 1024) fail('STORAGE_UNAVAILABLE');
        if (process.platform !== 'win32') {
          const stat = fs.fstatSync(held.fd);
          if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) fail('INVALID_INPUT');
        }
      }
      const connect = filename => {
        const db = new DatabaseSync(filename, {enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false});
        try {
          exec(db, 'PRAGMA trusted_schema=OFF');
          exec(db, 'PRAGMA synchronous=EXTRA');
          // Refuse a preexisting WAL database instead of migrating it.
          budget(db);
          if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') fail('STORAGE_UNAVAILABLE');
          budget(db);
          if (db.prepare('PRAGMA journal_mode=PERSIST').get().journal_mode !== 'persist') fail('STORAGE_UNAVAILABLE');
          return db;
        } catch (error) { db.close(); throw error; }
      };
      this.#lock = connect(filenames[0]);
      exec(this.#lock, 'BEGIN EXCLUSIVE');
      this.#checkFiles();
      this.#counter = connect(filenames[1]);
      if (schemaState(this.#lock, 'anchor', anchorSchema) === 'empty') {
        // Preexisting empty files may be corruption or an interrupted first
        // initialization. Never reinterpret those as a fresh fence history.
        if (present[0]) fail('STORAGE_UNAVAILABLE');
        exec(this.#counter, 'BEGIN EXCLUSIVE');
        if (schemaState(this.#counter, 'fence', fenceSchema) !== 'empty') fail('STORAGE_UNAVAILABLE');
        this.#instance = randomUUID();
        exec(this.#lock, anchorSchema);
        this.#lock.prepare('INSERT INTO anchor VALUES(1,1,?,?)').run(input.resourceId, this.#instance);
        exec(this.#lock, 'PRAGMA user_version=1');
        exec(this.#counter, fenceSchema);
        this.#counter.prepare('INSERT INTO fence VALUES(1,1,?,?,0,NULL,NULL)').run(input.resourceId, this.#instance);
        exec(this.#counter, 'PRAGMA user_version=1; COMMIT');
        exec(this.#lock, 'COMMIT');
        // Initialization commits an immutable anchor, then reenters the lifetime
        // lock. A contender winning this gap obtains its own higher fence first.
        exec(this.#lock, 'BEGIN EXCLUSIVE');
      }
      const anchor = readAnchor(this.#lock, input.resourceId);
      this.#instance = anchor.instanceId;
      exec(this.#counter, 'BEGIN EXCLUSIVE');
      const previous = readFence(this.#counter, input.resourceId, this.#instance);
      if (previous.fence >= Number.MAX_SAFE_INTEGER) fail('STORAGE_UNAVAILABLE');
      const fence = previous.fence + 1;
      this.#counter.prepare('UPDATE fence SET fence=?,ownerId=?,connectionEpoch=? WHERE id=1').run(
        fence, input.ownerId, input.connectionEpoch);
      this.#checkFiles();
      exec(this.#counter, 'COMMIT');
      // Future assertions never wait for another process to release a DB lock.
      this.#counter.exec('PRAGMA busy_timeout=0');
      this.#lock.exec('PRAGMA busy_timeout=0');
      this.#snapshot = deepFreeze({version: 1, resourceId: input.resourceId,
        ownerId: input.ownerId, connectionEpoch: input.connectionEpoch, fence});
      this.assertCurrent();
    } catch (error) {
      try { this.release(); } catch {}
      throw translate(error);
    }
  }

  #checkFiles() {
    this.#root.assertCurrent();
    for (const held of this.#files) {
      verifyLocalFile(held);
      if (fs.fstatSync(held.fd).size > 1024 * 1024) fail('STORAGE_UNAVAILABLE');
      checkSidecars(held.filename);
    }
  }

  #assertOpen() {
    if (this.#closed) fail('CLOSED');
    if (this.#lost) fail('STALE_CONTEXT');
  }

  snapshot() { this.#assertOpen(); return this.#snapshot; }

  assertCurrent(expected = this.#snapshot) {
    this.#assertOpen();
    // Validate caller metadata before touching any filesystem/SQLite state.
    strictRecord(expected, ['version', 'resourceId', 'ownerId', 'connectionEpoch', 'fence']);
    if (expected.version !== 1) fail('INVALID_INPUT');
    const candidate = {version: 1, resourceId: uuid(expected.resourceId), ownerId: uuid(expected.ownerId),
      connectionEpoch: uuid(expected.connectionEpoch), fence: integer(expected.fence, 1)};
    for (const field of Object.keys(candidate)) if (candidate[field] !== this.#snapshot[field]) fail('STALE_CONTEXT');
    try {
      if (!this.#lock.isOpen || !this.#lock.isTransaction || !this.#counter.isOpen || this.#counter.isTransaction) fail('STALE_CONTEXT');
      this.#checkFiles();
      const anchor = readAnchor(this.#lock, candidate.resourceId);
      if (anchor.instanceId !== this.#instance) fail('STALE_CONTEXT');
      const current = readFence(this.#counter, candidate.resourceId, this.#instance);
      if (current.fence !== candidate.fence || current.ownerId !== candidate.ownerId ||
          current.connectionEpoch !== candidate.connectionEpoch) fail('STALE_CONTEXT');
      this.#checkFiles();
      return this.#snapshot;
    } catch (error) { this.#lost = true; throw translate(error); }
  }

  release() {
    if (this.#closed) return;
    this.#closed = true;
    let failed = false;
    for (const db of [this.#counter, this.#lock]) {
      try { db?.close(); } catch { failed = true; }
    }
    // Close external inode handles only after closing SQLite's lock connection.
    for (const held of this.#files.reverse()) try { fs.closeSync(held.fd); } catch { failed = true; }
    try { this.#root?.close(); } catch { failed = true; }
    if (!failed && this.#reservation) reservations.delete(this.#reservation);
    if (failed) fail('STORAGE_UNAVAILABLE');
  }
}
