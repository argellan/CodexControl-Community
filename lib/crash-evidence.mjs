// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {APPLICATION_VERSION} from '../public/build-info.mjs';

const safeTypes = new Map([[Error, 'Error'], [TypeError, 'TypeError'], [RangeError, 'RangeError'],
  [ReferenceError, 'ReferenceError'], [SyntaxError, 'SyntaxError'], [URIError, 'URIError'], [EvalError, 'EvalError']]);
const safeCodes = new Set(['EACCES', 'ENOSPC', 'EPIPE', 'EMFILE', 'ENOMEM', 'ERR_OUT_OF_MEMORY',
  'ERR_WORKER_OUT_OF_MEMORY', 'ERR_INVALID_ARG_TYPE', 'ERR_STREAM_WRITE_AFTER_END']);
const safeSites = new Set(['server.mjs', 'windows-community.mjs', 'fleet.mjs', 'history.mjs',
  'journal-writer.mjs', 'journal-worker.mjs', 'usage-archive.mjs', 'account-usage.mjs']);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function exceptionFields(error) {
  let errorType = 'unknown', code = null, stackSites = [];
  try {
    for (const [type, name] of safeTypes) if (error instanceof type) {
      errorType = name;
      if (type !== Error) break;
    }
    const candidate = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    if (safeCodes.has(candidate)) code = candidate;
    const stack = typeof error?.stack === 'string' ? error.stack.slice(0, 32768) : '';
    for (const line of stack.split('\n').slice(1, 24)) {
      const match = /(?:^|[\\/])(server\.mjs|windows-community\.mjs|fleet\.mjs|history\.mjs|journal-writer\.mjs|journal-worker\.mjs|usage-archive\.mjs|account-usage\.mjs):(\d{1,7}):(\d{1,5})(?:\)?\s*)$/.exec(line);
      if (match && safeSites.has(match[1])) stackSites.push({site: match[1], line: Number(match[2]), column: Number(match[3])});
      if (stackSites.length === 8) break;
    }
  } catch { /* Error objects and their stack properties may be hostile. */ }
  return {errorType, code, stackSites};
}

export function createCrashEvidence({directory, correlationId, buildId, rotateBytes = 65536, maxFiles = 4} = {}) {
  if (!path.isAbsolute(directory || '') || !uuidPattern.test(correlationId || '')) throw new Error('Invalid local diagnostic destination');
  if (!Number.isSafeInteger(rotateBytes) || rotateBytes < 1024 || rotateBytes > 65536 ||
      !Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 4) throw new Error('Invalid diagnostic bounds');
  const build = /^[a-f0-9]{64}$/.test(buildId || '') ? buildId : 'unavailable';
  const file = path.join(directory, 'runtime.jsonl');
  const emit = details => {
    try {
      const entry = {timestamp: new Date().toISOString(), applicationVersion: APPLICATION_VERSION,
        buildId: build, correlationId, ...details};
      const bytes = Buffer.from(JSON.stringify(entry) + '\n');
      if (bytes.length > rotateBytes) return false;
      fs.mkdirSync(directory, {recursive: true, mode: 0o700});
      if (fs.lstatSync(directory).isSymbolicLink()) return false;
      let size = 0;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) return false;
        size = stat.size;
      } catch (error) { if (error.code !== 'ENOENT') return false; }
      if (size + bytes.length > rotateBytes) {
        const oldest = file + '.' + (maxFiles - 1);
        if (maxFiles === 1) fs.unlinkSync(file);
        else {
          try { fs.unlinkSync(oldest); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          for (let index = maxFiles - 2; index >= 1; index--) {
            try { fs.renameSync(file + '.' + index, file + '.' + (index + 1)); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          fs.renameSync(file, file + '.1');
        }
      }
      fs.appendFileSync(file, bytes, {mode: 0o600});
      return true;
    } catch { return false; }
  };
  return Object.freeze({
    fatal(error, origin) { return emit({kind: 'fatal', category: origin === 'unhandledRejection' ? 'unhandled-rejection' : 'uncaught-exception', ...exceptionFields(error)}); },
    startup(error) { return emit({kind: 'startup-failure', ...exceptionFields(error)}); },
    signal(value) { return emit({kind: 'signal', signal: value === 'SIGINT' ? 'SIGINT' : 'SIGTERM'}); },
    exit(code) { return emit({kind: 'exit', exitCode: Number.isInteger(code) ? code : null}); },
    output(stream) { return emit({kind: 'output', stream: stream === 'stderr' ? 'stderr' : 'stdout', category: 'output-suppressed'}); }
  });
}

export function installCrashEvidence(options = {}) {
  const correlationId = uuidPattern.test(options.correlationId || '') ? options.correlationId : crypto.randomUUID();
  const recorder = createCrashEvidence({...options, correlationId});
  // Monitoring preserves Node's ordinary fatal behavior; it is not a recovery handler.
  process.on('uncaughtExceptionMonitor', (error, origin) => { recorder.fatal(error, origin); });
  process.on('exit', code => { recorder.exit(code); });
  return recorder;
}
