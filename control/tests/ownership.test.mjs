import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {OwnershipLease} from '../host/ownership.mjs';
import {ProjectRoot} from '../host/project-root.mjs';
import {ControlError} from '../lib/errors.mjs';
import {canonicalJson} from '../lib/privacy.mjs';

const fixture = fileURLToPath(new URL('./fixtures/ownership-child.mjs', import.meta.url));
const cleanups = new WeakMap();
const refused = (operation, code) => assert.throws(operation, error =>
  error instanceof ControlError && (!code || error.code === code) &&
  error.message === 'Control foundation request refused' && !Object.hasOwn(error, 'cause'));
const options = directory => ({directory, resourceId: randomUUID(), ownerId: randomUUID(), connectionEpoch: randomUUID()});
const register = (t, cleanup) => cleanups.get(t).push(cleanup);

function temporary(t) {
  const temp = fs.realpathSync.native(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temp, 'TEST_ONLY-control-ownership-'));
  cleanups.set(t, []);
  t.after(async () => {
    for (const cleanup of cleanups.get(t).reverse()) await cleanup();
    const resolved = fs.realpathSync.native(directory);
    assert.equal(resolved, directory);
    assert.equal(path.dirname(resolved), temp);
    assert.ok(path.basename(resolved).startsWith('TEST_ONLY-control-ownership-'));
    assert.ok(!fs.lstatSync(directory).isSymbolicLink());
    fs.rmSync(resolved, {recursive: true, force: true, maxRetries: 5, retryDelay: 40});
  });
  return directory;
}

function acquire(t, input) {
  const lease = OwnershipLease.acquire(input);
  register(t, () => lease.release());
  return lease;
}
function rootAt(t, directory) {
  const held = ProjectRoot.open({directory});
  register(t, () => held.close());
  return held;
}

function childAt(t, input, waitForGo = false) {
  const child = fork(fixture, [], {execArgv: ['--max-old-space-size=64'], windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
  const queued = [], waiters = [];
  let completed = false;
  const finish = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => { completed = true; resolve({code, signal}); });
  });
  child.on('message', message => {
    const index = waiters.findIndex(waiter => waiter.kind === message.kind || message.kind === 'fatal');
    if (index < 0) { queued.push(message); return; }
    const waiter = waiters.splice(index, 1)[0]; clearTimeout(waiter.timer);
    if (message.kind === 'fatal') waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message);
  });
  const next = kind => {
    const index = queued.findIndex(message => message.kind === kind || message.kind === 'fatal');
    if (index >= 0) {
      const message = queued.splice(index, 1)[0];
      return message.kind === 'fatal' ? Promise.reject(new Error(JSON.stringify(message.error))) : Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      const waiter = {kind, resolve, reject};
      waiter.timer = setTimeout(() => reject(new Error('TEST_ONLY fixture timeout: ' + kind)), 15_000);
      waiters.push(waiter);
    });
  };
  const stop = async () => { if (!completed) child.kill('SIGKILL'); return finish; };
  register(t, async () => { for (const waiter of waiters) clearTimeout(waiter.timer); await stop(); });
  child.send({kind: 'configure', options: input, waitForGo});
  return {child, next, finish, stop};
}

test('two actual Node contenders hold exactly one kernel lease, then crash recovery advances its durable fence', {timeout: 30_000}, async t => {
  const directory = temporary(t), input = options(directory);
  // Initialize once so the race concerns acquisition rather than creation.
  const initial = acquire(t, input); const first = initial.snapshot(); initial.release();
  const contenders = [childAt(t, {...input, ownerId: randomUUID(), connectionEpoch: randomUUID(), busyTimeoutMs: 120}, true),
    childAt(t, {...input, ownerId: randomUUID(), connectionEpoch: randomUUID(), busyTimeoutMs: 120}, true)];
  await Promise.all(contenders.map(child => child.next('ready')));
  for (const contender of contenders) contender.child.send({kind: 'go'});
  const results = await Promise.all(contenders.map(child => child.next('result')));
  assert.equal(results.filter(result => result.snapshot).length, 1);
  assert.equal(results.filter(result => result.error?.code === 'CONFLICT').length, 1);
  const winnerIndex = results.findIndex(result => result.snapshot);
  const winner = contenders[winnerIndex], held = results[winnerIndex].snapshot;
  assert.equal(held.fence, first.fence + 1);
  const files = ['ownership', 'fence'].map(kind => path.join(directory, input.resourceId + '.' + kind + '.sqlite'));
  const identities = files.map(filename => fs.statSync(filename, {bigint: true}).ino);
  refused(() => OwnershipLease.acquire({...input, busyTimeoutMs: 30}), 'CONFLICT');
  winner.child.send({kind: 'assert'});
  assert.deepEqual((await winner.next('asserted')).snapshot, held);
  await winner.stop(); // Actual ungraceful process death, no release() path.
  assert.deepEqual(files.map(filename => fs.statSync(filename, {bigint: true}).ino), identities);
  const next = acquire(t, {...input, ownerId: randomUUID(), connectionEpoch: randomUUID()});
  assert.equal(next.snapshot().fence, held.fence + 1);
  refused(() => next.assertCurrent(held), 'STALE_CONTEXT');
  next.release();
  assert.deepEqual(files.map(filename => fs.statSync(filename, {bigint: true}).ino), identities);
});

test('busy timeout is bounded and same-process refusal preserves the original kernel lock', {timeout: 20_000}, async t => {
  const input = options(temporary(t)), held = acquire(t, input);
  for (let i = 0; i < 3; i++) refused(() => OwnershipLease.acquire({...input, busyTimeoutMs: 20}), 'CONFLICT');
  const child = childAt(t, {...input, ownerId: randomUUID(), busyTimeoutMs: 100});
  const result = await child.next('result');
  assert.equal(result.error?.code, 'CONFLICT');
  assert.ok(result.elapsedMs >= 60, String(result.elapsedMs));
  assert.ok(result.elapsedMs < 1500, String(result.elapsedMs));
  assert.deepEqual(held.assertCurrent(), held.snapshot());
  t.diagnostic('busyTimeoutMs=100; actual contender elapsedMs=' + result.elapsedMs.toFixed(3));
});

test('snapshots bind resource, owner, epoch and fence; release is terminal and never deletes DBs', t => {
  const input = options(temporary(t)), held = acquire(t, input), snapshot = held.snapshot();
  assert.ok(Object.isFrozen(snapshot));
  assert.equal(snapshot.fence, 1);
  for (const change of [{resourceId: randomUUID()}, {ownerId: randomUUID()},
    {connectionEpoch: randomUUID()}, {fence: snapshot.fence + 1}]) {
    refused(() => held.assertCurrent({...snapshot, ...change}), 'STALE_CONTEXT');
  }
  assert.equal(held.assertCurrent(), snapshot);
  held.release(); held.release();
  refused(() => held.assertCurrent(), 'CLOSED');
  refused(() => held.snapshot(), 'CLOSED');
  const next = acquire(t, input);
  assert.equal(next.snapshot().fence, 2);
  refused(() => next.assertCurrent(snapshot), 'STALE_CONTEXT');
  refused(() => held.assertCurrent(next.snapshot()), 'CLOSED');
  next.release();
  const db = new DatabaseSync(path.join(input.directory, input.resourceId + '.fence.sqlite'));
  try { assert.equal(db.prepare('SELECT fence FROM fence').get().fence, 2); }
  finally { db.close(); }
});

test('root and database identity handles remain open until release', t => {
  const directory = temporary(t), input = options(directory), opened = [];
  const original = fs.openSync;
  fs.openSync = (...args) => { const fd = original(...args); opened.push({fd, filename: String(args[0])}); return fd; };
  let held;
  try { held = acquire(t, input); } finally { fs.openSync = original; }
  const dbHandles = opened.filter(entry => entry.filename.endsWith('.sqlite'));
  const rootHandles = opened.filter(entry => entry.filename === directory);
  assert.equal(dbHandles.length, 2); assert.ok(rootHandles.length >= 1);
  for (const entry of [...dbHandles, ...rootHandles]) assert.ok(fs.fstatSync(entry.fd).ino > 0);
  held.assertCurrent(); held.release();
  for (const entry of [...dbHandles, ...rootHandles]) assert.throws(() => fs.fstatSync(entry.fd), {code: 'EBADF'});
});

test('fence corruption is refused and permanently invalidates a held lease', t => {
  const input = options(temporary(t)), held = acquire(t, input);
  const db = new DatabaseSync(path.join(input.directory, input.resourceId + '.fence.sqlite'));
  try {
    db.exec('PRAGMA journal_mode=PERSIST');
    db.prepare('UPDATE fence SET ownerId=?').run(randomUUID());
  } finally { db.close(); }
  refused(() => held.assertCurrent(), 'STALE_CONTEXT');
  refused(() => held.snapshot(), 'STALE_CONTEXT');
});

test('missing durable counter never silently resets an initialized resource', t => {
  const input = options(temporary(t)), held = acquire(t, input); held.release();
  fs.renameSync(path.join(input.directory, input.resourceId + '.fence.sqlite'), path.join(input.directory, 'TEST_ONLY-preserved-counter'));
  refused(() => OwnershipLease.acquire(input), 'STORAGE_UNAVAILABLE');
  assert.equal(fs.existsSync(path.join(input.directory, input.resourceId + '.fence.sqlite')), false);
});

test('preexisting empty or corrupt files never initialize a new counter, and overflow never wraps', t => {
  const directory = temporary(t), empty = options(directory);
  for (const kind of ['ownership', 'fence']) fs.writeFileSync(path.join(directory, empty.resourceId + '.' + kind + '.sqlite'), '', {mode: 0o600});
  refused(() => OwnershipLease.acquire(empty), 'STORAGE_UNAVAILABLE');
  const corrupt = options(directory);
  for (const kind of ['ownership', 'fence']) fs.writeFileSync(path.join(directory, corrupt.resourceId + '.' + kind + '.sqlite'), 'TEST_ONLY_CORRUPT', {mode: 0o600});
  refused(() => OwnershipLease.acquire(corrupt), 'STORAGE_UNAVAILABLE');
  const input = options(directory), held = acquire(t, input); held.release();
  const db = new DatabaseSync(path.join(directory, input.resourceId + '.fence.sqlite'));
  try {
    db.exec('PRAGMA journal_mode=PERSIST');
    db.prepare('UPDATE fence SET fence=?').run(Number.MAX_SAFE_INTEGER);
  } finally { db.close(); }
  refused(() => OwnershipLease.acquire(input), 'STORAGE_UNAVAILABLE');
});

test('database replacement is refused by identity verification or the native held-file lock', t => {
  const input = options(temporary(t)), held = acquire(t, input);
  const filename = path.join(input.directory, input.resourceId + '.fence.sqlite');
  try { fs.renameSync(filename, filename + '.TEST_ONLY-original'); }
  catch (error) {
    assert.equal(process.platform, 'win32');
    assert.ok(['EBUSY', 'EPERM', 'EACCES'].includes(error.code));
    held.assertCurrent();
    t.diagnostic('Windows native open-file sharing denied replacement; original ownership remains current.');
    return;
  }
  fs.writeFileSync(filename, '', {mode: 0o600});
  refused(() => held.assertCurrent(), 'STALE_CONTEXT');
});

test('ProjectRoot identity is frozen, stable, metadata-only and changes on root replacement', t => {
  const directory = temporary(t), project = path.join(directory, 'project'); fs.mkdirSync(project);
  const root = rootAt(t, project), identity = root.identity();
  assert.ok(Object.isFrozen(identity));
  assert.equal(identity.git, null);
  assert.match(identity.sha256, /^[a-f0-9]{64}$/);
  const {sha256, ...metadata} = identity;
  assert.equal(createHash('sha256').update(canonicalJson(metadata)).digest('hex'), sha256);
  fs.writeFileSync(path.join(project, 'TEST_ONLY-private-content'), 'This must never be hashed or read.');
  assert.deepEqual(root.assertCurrent(), identity);
  assert.equal(root.directory, fs.realpathSync.native(project));
  const other = rootAt(t, project); assert.deepEqual(other.identity(), identity); other.close();
  fs.renameSync(project, project + '-original'); fs.mkdirSync(project);
  refused(() => root.assertCurrent(), 'STALE_CONTEXT');
  assert.notEqual(rootAt(t, project).identity().sha256, identity.sha256);
  root.close(); root.close();
  refused(() => root.assertCurrent(), 'CLOSED');
  refused(() => root.identity(), 'CLOSED');
  refused(() => root.directory, 'CLOSED');
});

function worktreeFixture(directory) {
  const project = path.join(directory, 'project'), git = path.join(directory, 'admin'), common = path.join(directory, 'common');
  fs.mkdirSync(project); fs.mkdirSync(git); fs.mkdirSync(common);
  fs.writeFileSync(path.join(project, '.git'), 'gitdir: ../admin\n');
  fs.writeFileSync(path.join(git, 'commondir'), '../common\n');
  fs.writeFileSync(path.join(git, 'gitdir'), '../project/.git\n');
  return {project, git, common};
}

test('Git directory and linked worktree pointers resolve using bounded metadata reads', t => {
  const {project, git, common} = worktreeFixture(temporary(t));
  const held = rootAt(t, project), identity = held.identity();
  assert.equal(identity.git.kind, 'worktree');
  assert.ok(Object.isFrozen(identity.git));
  assert.equal(path.basename(identity.git.directory), path.basename(git));
  assert.equal(path.basename(identity.git.commonDirectory), path.basename(common));
  assert.equal(JSON.stringify(identity).includes('gitdir:'), false);
  assert.deepEqual(held.assertCurrent(), identity);
  fs.writeFileSync(path.join(project, '.git'), 'gitdir: ../common\n');
  refused(() => held.assertCurrent(), 'STALE_CONTEXT');
  const ordinary = path.join(path.dirname(project), 'ordinary'); fs.mkdirSync(ordinary); fs.mkdirSync(path.join(ordinary, '.git'));
  assert.equal(rootAt(t, ordinary).identity().git.kind, 'directory');
});

test('commondir, reverse gitdir, newly introduced Git pointers and root ancestor replacement are refused', async t => {
  for (const mutation of ['common', 'reverse', 'new', 'ancestor']) {
    await t.test(mutation, sub => {
      const directory = temporary(sub);
      if (mutation === 'new') {
        const root = rootAt(sub, directory); fs.mkdirSync(path.join(directory, '.git'));
        refused(() => root.assertCurrent(), 'STALE_CONTEXT');
      } else if (mutation === 'ancestor') {
        const parent = path.join(directory, 'parent'), project = path.join(parent, 'project'); fs.mkdirSync(project, {recursive: true});
        const held = rootAt(sub, project);
        try { fs.renameSync(parent, parent + '-original'); }
        catch (error) {
          assert.equal(process.platform, 'win32');
          assert.ok(['EBUSY', 'EPERM', 'EACCES'].includes(error.code));
          held.assertCurrent();
          sub.diagnostic('Windows native held-directory semantics denied ancestor rename.');
          return;
        }
        fs.mkdirSync(project, {recursive: true});
        refused(() => held.assertCurrent(), 'STALE_CONTEXT');
      } else {
        const {project, git} = worktreeFixture(directory), held = rootAt(sub, project);
        fs.writeFileSync(path.join(git, mutation === 'common' ? 'commondir' : 'gitdir'), mutation === 'common' ? '../admin\n' : '../common\n');
        refused(() => held.assertCurrent());
      }
    });
  }
});

test('symlink/junction roots, ancestors, Git directories and ownership files are refused', t => {
  const directory = temporary(t), actual = path.join(directory, 'actual'), link = path.join(directory, 'link');
  fs.mkdirSync(actual); fs.mkdirSync(path.join(actual, 'nested'));
  fs.symlinkSync(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
  refused(() => ProjectRoot.open({directory: link}), 'INVALID_INPUT');
  refused(() => ProjectRoot.open({directory: path.join(link, 'nested')}), 'INVALID_INPUT');
  refused(() => OwnershipLease.acquire(options(link)), 'INVALID_INPUT');
  fs.symlinkSync(actual, path.join(directory, '.git'), process.platform === 'win32' ? 'junction' : 'dir');
  refused(() => ProjectRoot.open({directory}), 'INVALID_INPUT');
  // Keep test links in place for boundary-checked mkdtemp cleanup.
  const storage = path.join(actual, 'storage'); fs.mkdirSync(storage, {mode: 0o700});
  const input = options(storage);
  fs.symlinkSync(actual, path.join(storage, input.resourceId + '.ownership.sqlite'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(storage, input.resourceId + '.fence.sqlite'), '', {mode: 0o600});
  refused(() => OwnershipLease.acquire(input), 'INVALID_INPUT');
});

test('oversized, malformed and ambiguous Git pointers fail with fixed errors', t => {
  const directory = temporary(t), project = path.join(directory, 'project'); fs.mkdirSync(project);
  for (const text of ['gitdir: ' + 'x'.repeat(4097), 'not-git: ../admin\n', 'gitdir: ../admin\nextra\n',
    'gitdir: \\server\\share\n', Buffer.from([0xff, 0xfe])]) {
    fs.writeFileSync(path.join(project, '.git'), text);
    refused(() => ProjectRoot.open({directory: project}));
  }
});

test('malformed, proxy, accessor, hidden and unknown inputs never invoke caller behavior', t => {
  const directory = temporary(t), input = options(directory);
  let invoked = 0;
  const accessor = Object.defineProperty({...input}, 'ownerId', {enumerable: true, get() { invoked++; throw new Error('secret'); }});
  const proxy = new Proxy(input, {get() { invoked++; throw new Error('secret'); }, ownKeys() { invoked++; throw new Error('secret'); }});
  const revoked = Proxy.revocable(input, {}); revoked.revoke();
  const hidden = Object.defineProperty({...input}, 'extra', {value: 'secret'});
  for (const value of [undefined, null, [], accessor, proxy, revoked.proxy, hidden, {...input, extra: true},
    {...input, ownerId: 'bad'}, {...input, connectionEpoch: 1}, {...input, resourceId: null},
    {...input, directory: '.'}, {...input, directory: '\\\\server\\share'}, {...input, directory: '//server/share'},
    {...input, busyTimeoutMs: -1}, {...input, busyTimeoutMs: Infinity}, {...input, busyTimeoutMs: 30_001}]) {
    refused(() => OwnershipLease.acquire(value), 'INVALID_INPUT');
  }
  for (const value of [null, proxy, revoked.proxy, Object.defineProperty({}, 'directory', {enumerable: true, get() { invoked++; return undefined; }}),
    {directory: '.'}, {directory: '//server/share'}, {directory, other: true}]) refused(() => ProjectRoot.open(value), 'INVALID_INPUT');
  const held = acquire(t, input);
  for (const value of [null, proxy, revoked.proxy, {...held.snapshot(), fence: 0}, {...held.snapshot(), version: 2},
    Object.defineProperty({...held.snapshot()}, 'fence', {enumerable: true, get() { invoked++; return undefined; }})]) {
    refused(() => held.assertCurrent(value), 'INVALID_INPUT');
  }
  assert.equal(invoked, 0);
  assert.equal(held.assertCurrent(), held.snapshot());
  refused(() => new OwnershipLease(), 'INVALID_INPUT');
  refused(() => new ProjectRoot(), 'INVALID_INPUT');
});

test('Windows native realpath accepts ordinary casing aliases with the same root identity', {skip: process.platform !== 'win32'}, t => {
  const directory = temporary(t), held = rootAt(t, directory);
  const alias = rootAt(t, directory.toUpperCase());
  assert.deepEqual(alias.identity(), held.identity());
  alias.assertCurrent();
});

test('known nonlocal filesystem types and ambiguous filesystem identities fail closed', t => {
  const directory = temporary(t), original = fs.statfsSync;
  try {
    for (const type of [0x6969n, 0xff534d42n, 0xfe534d42n, 0x65735546n, 0x01021997n]) {
      fs.statfsSync = (...args) => ({...original(...args), type});
      refused(() => ProjectRoot.open({directory}), 'INVALID_INPUT');
      refused(() => OwnershipLease.acquire(options(directory)), 'INVALID_INPUT');
    }
  } finally { fs.statfsSync = original; }
  const fstat = fs.fstatSync;
  try {
    fs.fstatSync = (...args) => {
      const stat = fstat(...args); stat.ino = 0n; return stat;
    };
    refused(() => ProjectRoot.open({directory}), 'STORAGE_UNAVAILABLE');
  } finally { fs.fstatSync = fstat; }
});

test('ownership directories can be created privately; sidecars and multiply-linked database files are refused', t => {
  const directory = temporary(t), storage = path.join(directory, 'private', 'nested'), input = options(storage);
  const held = acquire(t, input); held.release();
  if (process.platform !== 'win32') assert.equal(fs.statSync(storage).mode & 0o077, 0);
  const filename = path.join(storage, input.resourceId + '.ownership.sqlite');
  fs.linkSync(filename, path.join(storage, 'TEST_ONLY-hardlink'));
  refused(() => OwnershipLease.acquire(input), 'INVALID_INPUT');
  const another = options(storage), other = acquire(t, another); other.release();
  fs.symlinkSync(directory, path.join(storage, another.resourceId + '.ownership.sqlite-wal'), process.platform === 'win32' ? 'junction' : 'dir');
  refused(() => OwnershipLease.acquire(another), 'INVALID_INPUT');
});

test('import creates no files, processes or timers', {timeout: 20_000}, async t => {
  const directory = temporary(t), child = childAt(t, {directory, importOnly: true});
  const result = await child.next('result');
  assert.equal(result.importClean, true);
  assert.deepEqual(fs.readdirSync(directory), []);
});
