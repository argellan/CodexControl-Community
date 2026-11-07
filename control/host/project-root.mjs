import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ControlError, isControlError} from '../lib/errors.mjs';
import {canonicalJson, deepFreeze, strictRecord} from '../lib/privacy.mjs';

const fail = code => { throw new ControlError(code); };
const key = Symbol('held project root');
const POINTER_BYTES = 4096;
// Known remote/distributed filesystem magic numbers, normalized to unsigned 32 bits.
const remoteTypes = new Set([
  0x6969n, 0x517bn, 0xff534d42n, 0xfe534d42n, 0x564cn, 0x73757245n,
  0x5346414fn, 0x65735546n, 0x00c36400n, 0x01021997n, 0x47504653n,
  0x013111a8n, 0x19830326n, 0x2fc12fc1n, 0xabba1974n, 0x16507463n
]);
const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (a, b) => normalized(a) === normalized(b);
const safe = (callback, code = 'STORAGE_UNAVAILABLE') => {
  try { return callback(); }
  catch (error) { if (isControlError(error)) throw error; fail(code); }
};

/** Internal host filesystem helpers; no filesystem work is performed at import. */
export function localDirectoryPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32768 ||
      value.includes('\0') || !path.isAbsolute(value) || /^(?:\\\\|\/\/)/.test(value) ||
      (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(value))) fail('INVALID_INPUT');
  return path.resolve(value);
}

export function inspectLocalDirectory(value) {
  const resolved = localDirectoryPath(value);
  let current = resolved;
  for (;;) {
    const stat = fs.lstatSync(current, {bigint: true});
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('INVALID_INPUT');
    const filesystem = fs.statfsSync(current, {bigint: true});
    if (remoteTypes.has(BigInt.asUintN(32, filesystem.type))) fail('INVALID_INPUT');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const canonical = fs.realpathSync.native(resolved);
  localDirectoryPath(canonical); // Native Windows resolution must not resolve to UNC/device paths.
  if (!samePath(canonical, resolved)) fail('INVALID_INPUT');
  return canonical;
}

const fileIdentity = stat => {
  if (stat.dev <= 0n || stat.ino <= 0n) fail('STORAGE_UNAVAILABLE');
  return {device: String(stat.dev), inode: String(stat.ino), birth: String(stat.birthtimeNs)};
};
const sameIdentity = (a, b) => a.device === b.device && a.inode === b.inode && a.birth === b.birth;
const identityOf = handle => fileIdentity(fs.fstatSync(handle.fd, {bigint: true}));

function holdDirectory(directory) {
  const canonical = inspectLocalDirectory(directory);
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const held = {fd, directory: canonical};
  try {
    const stat = fs.fstatSync(fd, {bigint: true});
    if (!stat.isDirectory()) fail('INVALID_INPUT');
    held.identity = fileIdentity(stat);
    verifyDirectory(held);
    return held;
  } catch (error) { fs.closeSync(fd); throw error; }
}

function verifyDirectory(held) {
  const current = inspectLocalDirectory(held.directory);
  const stat = fs.lstatSync(current, {bigint: true});
  if (!samePath(current, held.directory) || !sameIdentity(fileIdentity(stat), held.identity) ||
      !sameIdentity(identityOf(held), held.identity)) fail('STALE_CONTEXT');
}

export function holdLocalFile(filename, create = false) {
  inspectLocalDirectory(path.dirname(filename));
  let fd;
  if (create) {
    try { fd = fs.openSync(filename, fs.constants.O_RDWR | fs.constants.O_CREAT |
      fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (fd === undefined) {
    const stat = fs.lstatSync(filename, {bigint: true});
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) fail('INVALID_INPUT');
    fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  }
  const held = {fd, filename};
  try {
    const stat = fs.fstatSync(fd, {bigint: true});
    if (!stat.isFile() || stat.nlink !== 1n) fail('INVALID_INPUT');
    held.identity = fileIdentity(stat);
    verifyLocalFile(held);
    return held;
  } catch (error) { fs.closeSync(fd); throw error; }
}

export function verifyLocalFile(held) {
  inspectLocalDirectory(path.dirname(held.filename));
  const stat = fs.lstatSync(held.filename, {bigint: true});
  const handleStat = fs.fstatSync(held.fd, {bigint: true});
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n || !handleStat.isFile() ||
      handleStat.nlink !== 1n || !sameIdentity(fileIdentity(stat), held.identity) ||
      !sameIdentity(fileIdentity(handleStat), held.identity)) fail('STALE_CONTEXT');
}

function optionalStat(filename) {
  try { return fs.lstatSync(filename, {bigint: true}); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function pointer(held) {
  verifyLocalFile(held);
  const before = fs.fstatSync(held.fd, {bigint: true});
  if (before.size < 1n || before.size > BigInt(POINTER_BYTES)) fail('INVALID_INPUT');
  const buffer = Buffer.alloc(POINTER_BYTES + 1);
  const length = fs.readSync(held.fd, buffer, 0, buffer.length, 0);
  const after = fs.fstatSync(held.fd, {bigint: true});
  if (BigInt(length) !== before.size || after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) fail('STALE_CONTEXT');
  verifyLocalFile(held);
  return new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(0, length));
}

function targetPath(base, text, prefix = '') {
  const expression = prefix ? /^gitdir: ([^\r\n\0]+)\r?\n?$/ : /^([^\r\n\0]+)\r?\n?$/;
  const match = expression.exec(text);
  if (!match || match[1].trim() !== match[1] || /^(?:\\\\|\/\/)/.test(match[1]) ||
      (process.platform === 'win32' && /^[a-z]:[^\\/]/i.test(match[1]))) fail('INVALID_INPUT');
  return localDirectoryPath(path.resolve(base, match[1]));
}

function captureGit(root) {
  const handles = [];
  const pointers = [];
  const directory = filename => { const held = holdDirectory(filename); handles.push(held); return held; };
  const read = filename => {
    const held = holdLocalFile(filename); handles.push(held);
    const text = pointer(held);
    pointers.push({filename: normalized(filename), identity: held.identity, text});
    return text;
  };
  try {
    const dotgit = path.join(root, '.git');
    const stat = optionalStat(dotgit);
    if (!stat) return {metadata: null, signature: 'null', handles};
    if (stat.isSymbolicLink()) fail('INVALID_INPUT');
    let kind, git;
    if (stat.isDirectory()) { kind = 'directory'; git = directory(dotgit); }
    else if (stat.isFile()) { kind = 'worktree'; git = directory(targetPath(root, read(dotgit), 'gitdir: ')); }
    else fail('INVALID_INPUT');

    let common = git;
    const commonFile = path.join(git.directory, 'commondir');
    if (optionalStat(commonFile)) common = directory(targetPath(git.directory, read(commonFile)));
    const reverseFile = path.join(git.directory, 'gitdir');
    if (optionalStat(reverseFile)) {
      const reverse = targetPath(git.directory, read(reverseFile));
      inspectLocalDirectory(path.dirname(reverse));
      if (!samePath(fs.realpathSync.native(reverse), dotgit)) fail('INVALID_INPUT');
      const reverseStat = fs.lstatSync(reverse, {bigint: true});
      if (!reverseStat.isFile() || reverseStat.isSymbolicLink()) fail('INVALID_INPUT');
    } else if (common !== git) fail('INVALID_INPUT');

    const metadata = {kind, directory: normalized(git.directory), device: git.identity.device,
      inode: git.identity.inode, birthtimeNs: git.identity.birth, commonDirectory: normalized(common.directory),
      commonDevice: common.identity.device, commonInode: common.identity.inode, commonBirthtimeNs: common.identity.birth};
    const signature = canonicalJson({metadata, pointers,
      directories: handles.filter(handle => handle.directory).map(handle => handle.identity)});
    return {metadata, signature, handles};
  } catch (error) { for (const handle of handles.reverse()) try { fs.closeSync(handle.fd); } catch {} throw error; }
}

/** A host-local identity capability. Paths in identity() are configuration, never operation telemetry.
 * Same-user malicious filesystem mutation is outside this capability's trust boundary.
 * Windows mode bits do not establish ACL privacy; installation must qualify volume/ACL policy.
 */
export class ProjectRoot {
  #root;
  #git;
  #identity;
  #closed = false;
  #lost = false;

  static open(options) {
    return safe(() => {
      strictRecord(options, ['directory']);
      return new ProjectRoot(key, options.directory);
    });
  }

  constructor(token, directory) {
    if (token !== key) fail('INVALID_INPUT');
    try {
      this.#root = holdDirectory(directory);
      this.#git = captureGit(this.#root.directory);
      const metadata = {version: 1, canonicalDirectory: normalized(this.#root.directory),
        device: this.#root.identity.device, inode: this.#root.identity.inode,
        birthtimeNs: this.#root.identity.birth, git: this.#git.metadata};
      this.#identity = deepFreeze({...metadata,
        sha256: createHash('sha256').update(canonicalJson(metadata)).digest('hex')});
      this.assertCurrent();
    } catch (error) { this.close(); throw error; }
  }

  #assertOpen() {
    if (this.#closed) fail('CLOSED');
    if (this.#lost) fail('STALE_CONTEXT');
  }
  get directory() { this.#assertOpen(); return this.#root.directory; }
  identity() { this.#assertOpen(); return this.#identity; }

  assertCurrent() {
    this.#assertOpen();
    try { return safe(() => {
      verifyDirectory(this.#root);
      for (const held of this.#git.handles) {
        if (held.directory) verifyDirectory(held); else verifyLocalFile(held);
      }
      const current = captureGit(this.#root.directory);
      try { if (current.signature !== this.#git.signature) fail('STALE_CONTEXT'); }
      finally { for (const held of current.handles.reverse()) fs.closeSync(held.fd); }
      verifyDirectory(this.#root);
      return this.#identity;
    }, 'STALE_CONTEXT'); }
    catch (error) { this.#lost = true; throw error; }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    let failed = false;
    for (const held of [...(this.#git?.handles ?? []), ...(this.#root ? [this.#root] : [])].reverse()) {
      try { fs.closeSync(held.fd); } catch { failed = true; }
    }
    if (failed) fail('STORAGE_UNAVAILABLE');
  }
}
