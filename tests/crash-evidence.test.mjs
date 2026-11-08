// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const modulePath = path.resolve('lib/crash-evidence.mjs');
const moduleUrl = pathToFileURL(modulePath).href;
const correlationId = '0e6f85ab-74aa-4f02-88b6-cd010d6a6718';
const canary = 'PRIVATE_CANARY_TOKEN_0193 person@example.invalid C:\\Private\\secret.txt';
async function removeFixture(directory) {
  const root = await fs.realpath(os.tmpdir()), target = await fs.realpath(directory);
  assert.ok(target.startsWith(root + path.sep), 'cleanup stays within the fixture root');
  await fs.rm(target, {recursive: true, force: true});
}

test('fatal exceptions and rejected promises leave private, redacted, correlated evidence', async () => {
  assert.equal(await fs.access(modulePath).then(() => true, () => false), true,
    'fatal crash evidence must exist before an isolated runtime can use it');
  for (const origin of ['exception', 'rejection']) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-crash-evidence-'));
    try {
      const code = `import {installCrashEvidence} from ${JSON.stringify(moduleUrl)};\n` +
        `installCrashEvidence({directory:process.env.CASE_DIRECTORY,correlationId:${JSON.stringify(correlationId)},buildId:${JSON.stringify('a'.repeat(64))}});\n` +
        (origin === 'exception' ? `setImmediate(()=>{throw new TypeError(${JSON.stringify(canary)});});` : `Promise.reject(new TypeError(${JSON.stringify(canary)}));`);
      const child = spawnSync(process.execPath, ['--input-type=module', '--unhandled-rejections=throw', '-e', code],
        {env: {...process.env, CASE_DIRECTORY: directory}, encoding: 'utf8', timeout: 5000, windowsHide: true});
      assert.equal(child.status, 1, 'the capture hook must preserve Node fatal-exit behavior');
      const raw = await fs.readFile(path.join(directory, 'runtime.jsonl'), 'utf8');
      assert.equal(raw.includes(canary), false);
      assert.equal(raw.includes('example.invalid'), false);
      assert.equal(raw.includes('secret.txt'), false);
      const events = raw.trim().split('\n').map(JSON.parse);
      const fatal = events.find(event => event.kind === 'fatal');
      assert.equal(fatal?.category, origin === 'exception' ? 'uncaught-exception' : 'unhandled-rejection');
      assert.equal(fatal.correlationId, correlationId);
      assert.equal(fatal.applicationVersion, '0.1.0');
      assert.equal(fatal.buildId, 'a'.repeat(64));
      assert.match(fatal.timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.equal(fatal.errorType, 'TypeError');
      assert.equal(events.find(event => event.kind === 'exit')?.exitCode, 1);
    } finally {
      await removeFixture(directory);
    }
  }
});

test('crash evidence rotates within a fixed budget and does not persist arbitrary output', async () => {
  assert.equal(await fs.access(modulePath).then(() => true, () => false), true,
    'bounded local crash evidence must exist');
  const {createCrashEvidence} = await import(moduleUrl);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-crash-rotation-'));
  try {
    const recorder = createCrashEvidence({directory, correlationId, buildId: 'b'.repeat(64), rotateBytes: 2048, maxFiles: 3});
    for (let index = 0; index < 100; index++) recorder.output('stderr', canary);
    const files = (await fs.readdir(directory)).filter(file => file.startsWith('runtime'));
    assert.ok(files.length <= 3);
    for (const file of files) {
      const raw = await fs.readFile(path.join(directory, file), 'utf8');
      assert.ok(Buffer.byteLength(raw) <= 2048);
      assert.equal(raw.includes('PRIVATE_CANARY'), false);
      assert.equal(raw.includes('secret.txt'), false);
      for (const line of raw.trim().split('\n')) assert.equal(JSON.parse(line).category, 'output-suppressed');
    }
    assert.ok(files.length > 1, 'rotation should actually occur');
  } finally {
    await removeFixture(directory);
  }
});

test('the actual Windows entrypoint records a caught startup failure and exits without leaking its path', async () => {
  const instance = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-private-startup-'));
  try {
    const child = spawnSync(process.execPath, ['scripts/windows-community.mjs', '--run', '--instance=' + instance],
      {env: {...process.env, CODEX_CONTROL_CRASH_RUN_ID: correlationId, CODEX_CONTROL_CRASH_BUILD_ID: 'c'.repeat(64)},
        encoding: 'utf8', timeout: 5000, windowsHide: true});
    assert.equal(child.status, 1);
    const report = path.join(instance, 'data', 'crash-reports', 'runtime.jsonl');
    assert.equal(await fs.access(report).then(() => true, () => false), true, 'startup failure must leave a private report');
    const raw = await fs.readFile(report, 'utf8');
    assert.equal(raw.includes(instance), false);
    const events = raw.trim().split('\n').map(JSON.parse);
    assert.equal(events.find(event => event.kind === 'startup-failure')?.correlationId, correlationId);
    assert.equal(events.find(event => event.kind === 'exit')?.exitCode, 1);
  } finally {
    await removeFixture(instance);
  }
});

test('an unavailable evidence directory does not throw from a fatal callback', async () => {
  const {createCrashEvidence} = await import(moduleUrl);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-evidence-unavailable-'));
  try {
    const file = path.join(directory, 'not-a-directory');
    await fs.writeFile(file, 'fixture');
    const recorder = createCrashEvidence({directory: path.join(file, 'child'), correlationId, buildId: 'd'.repeat(64)});
    assert.equal(recorder.fatal(new Error(canary), 'uncaughtException'), false);
  } finally {
    await removeFixture(directory);
  }
});

test('a shutdown flush error is reported and cannot emit the clean-stop marker', async () => {
  const entry = await import('../scripts/windows-community.mjs');
  assert.equal(typeof entry.shutdownCommunityRuntime, 'function', 'shutdown must expose a verifiable failure boundary');
  const messages = [], successes = [], failures = [];
  const server = {close(callback) { queueMicrotask(()=>callback(new Error(canary))); }, closeAllConnections() {}};
  const result = await entry.shutdownCommunityRuntime(server, {
    info: value => messages.push(value), error: value => messages.push(value),
    onSuccess: code => successes.push(code), onFailure: () => failures.push(true)
  });
  assert.equal(result, false);
  assert.deepEqual(successes, []);
  assert.deepEqual(failures, [true]);
  assert.ok(messages.some(value => value.includes('COMMUNITY_STOP_FAILED')));
  assert.ok(messages.every(value => !value.includes('COMMUNITY_STOPPED_DATA_PRESERVED') && !value.includes(canary)));
});
