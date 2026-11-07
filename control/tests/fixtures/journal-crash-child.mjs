// TEST_ONLY disposable SQLite/process fixture. No provider, shell, host or network.
import {randomUUID} from 'node:crypto';
import {openSync, writeSync, fsyncSync, closeSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {ControlJournal} from '../../lib/journal.mjs';

const receive = () => new Promise(resolve => process.once('message', resolve));
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
const hold = () => new Promise(() => { process.on('message', () => {}); });
const safeError = error => ({name: error?.name, code: error?.code || 'CONTROL_ERROR', message: String(error?.message || '')});

try {
  const configuration = await receive();
  if (configuration.mode === 'write-lock') {
    const database = new DatabaseSync(configuration.file);
    database.exec('BEGIN IMMEDIATE');
    await send({kind: 'ready'});
    await hold();
  }

  const journal = ControlJournal.open({directory: configuration.directory, busyTimeoutMs: 3000});
  if (configuration.mode === 'admit-race' || configuration.mode === 'transition-race') {
    await send({kind: 'ready'});
    await receive();
    try {
      const result = configuration.mode === 'admit-race' ? journal.admit(configuration.envelope) : journal.transition(configuration.event);
      await send({kind: 'result', result});
    } catch (error) {
      await send({kind: 'result', error: safeError(error)});
    }
    journal.close();
    process.disconnect();
  } else if (configuration.mode === 'crash') {
    let operation = journal.admit(configuration.envelope).operation;
    const stopAt = async stage => {
      if (configuration.stage !== stage) return;
      await send({kind: 'boundary', stage, operation});
      await hold();
    };
    const transition = type => {
      operation = journal.transition({operationId: operation.envelope.operationId, eventId: randomUUID(),
        expectedRevision: operation.revision, type, atMs: Date.now(), context: operation.envelope.context}).operation;
    };
    await stopAt('afteradmission');
    transition('DISPATCH_INTENT');
    await stopAt('intent');
    // The marker stands for a nontransactional effect only. It is not native acceptance.
    const effect = openSync(configuration.effectFile, 'wx', 0o600);
    try { writeSync(effect, 'TEST_ONLY_EFFECT\n'); fsyncSync(effect); } finally { closeSync(effect); }
    await stopAt('fakeeffect');
    if (configuration.stage === 'ack') {
      transition('NATIVE_ACCEPTED');
      await stopAt('ack');
    }
    transition('COMPLETED');
    await stopAt('final');
    throw new Error('Unsupported TEST_ONLY crash stage');
  } else {
    throw new Error('Unsupported TEST_ONLY fixture mode');
  }
} catch (error) {
  if (process.connected) await send({kind: 'fatal', error: safeError(error)}).catch(() => {});
  process.exitCode = 1;
  process.disconnect?.();
}
