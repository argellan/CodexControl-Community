// TEST_ONLY: local disposable ownership DBs and IPC. No shell/provider/network.
import {performance} from 'node:perf_hooks';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {safeControlError} from '../../lib/errors.mjs';

let lease;
let configuration;
const send = value => new Promise((resolve, reject) => process.send(value,
  error => error ? reject(error) : resolve()));

async function acquire() {
  let started = performance.now();
  try {
    if (configuration.options.importOnly) {
      const changed = [];
      const refuse = () => { throw new Error('TEST_ONLY import side effect'); };
      // Module loading reads source files; permit reads while refusing opens
      // that could create/mutate files, including promise-based filesystem APIs.
      for (const [object, name] of [[fs, 'openSync'], [fs, 'open'], [fs.promises, 'open']]) {
        const original = object[name]; changed.push([object, name, original]);
        object[name] = (...args) => {
          const flags = args[1];
          if (!(['r', 'rs', 'sr'].includes(flags) ||
              (typeof flags === 'number' && (flags & (fs.constants.O_CREAT | fs.constants.O_WRONLY |
                fs.constants.O_RDWR | fs.constants.O_TRUNC | fs.constants.O_APPEND)) === 0))) refuse();
          return Reflect.apply(original, object, args);
        };
      }
      for (const [object, names] of [[fs, ['mkdirSync', 'mkdir', 'writeFileSync', 'writeFile']],
        [fs.promises, ['mkdir', 'writeFile']],
        [childProcess, ['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync']],
        [globalThis, ['setTimeout', 'setInterval', 'setImmediate']]]) {
        for (const name of names) { changed.push([object, name, object[name]]); object[name] = refuse; }
      }
      try {
        syncBuiltinESMExports();
        await import('../../host/ownership.mjs');
        await import('../../host/project-root.mjs');
      } finally {
        for (const [object, name, original] of changed) object[name] = original;
        syncBuiltinESMExports();
      }
      await send({kind: 'result', importClean: true});
      return;
    }
    const {OwnershipLease} = await import('../../host/ownership.mjs');
    started = performance.now();
    lease = OwnershipLease.acquire(configuration.options);
    await send({kind: 'result', snapshot: lease.snapshot(), elapsedMs: performance.now() - started});
  } catch (error) {
    await send({kind: 'result', error: safeControlError(error), elapsedMs: performance.now() - started});
  }
}

process.on('message', async message => {
  try {
    if (message.kind === 'configure') {
      configuration = message;
      await send({kind: 'ready'});
      if (!message.waitForGo) await acquire();
    } else if (message.kind === 'go') await acquire();
    else if (message.kind === 'assert') {
      try { await send({kind: 'asserted', snapshot: lease.assertCurrent(message.expected)}); }
      catch (error) { await send({kind: 'asserted', error: safeControlError(error)}); }
    } else if (message.kind === 'release') {
      lease?.release();
      await send({kind: 'released'});
      process.disconnect();
    } else throw new Error('TEST_ONLY invalid fixture command');
  } catch (error) {
    await send({kind: 'fatal', error: safeControlError(error)}).catch(() => {});
    process.exitCode = 1;
    process.disconnect();
  }
});
