import {types} from 'node:util';
import {ControlError, isControlError} from '../../lib/errors.mjs';

const METHODS = new Set(['initialize', 'account/read', 'config/read', 'model/list',
  'thread/start', 'thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt']);
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor', 'toJSON']);
const fail = code => { throw new ControlError(code); };
const noop = () => {};

// Descriptor inspection precedes every value read. Neither proxies nor custom
// serialization hooks are executed. Limits apply to inbound and outbound JSON.
function copyJson(value, byteLimit) {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set();
  const charge = n => { bytes += n; if (bytes > byteLimit) fail('CAPACITY'); };
  function copy(item, depth) {
    if (++nodes > 8192 || depth > 32) fail('INVALID_INPUT');
    if (item === null || typeof item === 'boolean') { charge(5); return item; }
    if (typeof item === 'string') {
      if (item.length > byteLimit) fail('CAPACITY');
      charge(Buffer.byteLength(JSON.stringify(item))); return item;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0)) fail('INVALID_INPUT');
      charge(24); return item;
    }
    if (!item || typeof item !== 'object' || types.isProxy(item) || ancestors.has(item)) fail('INVALID_INPUT');
    const array = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype)) fail('INVALID_INPUT');
    const keys = Reflect.ownKeys(item);
    if (keys.length > (array ? 1025 : 128)) fail('CAPACITY');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (array && (item.length > 1024 || keys.length !== item.length + 1)) fail('INVALID_INPUT');
    const result = array ? [] : {};
    ancestors.add(item);
    charge(2);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || key.length > 256 || FORBIDDEN.has(key)) fail('INVALID_INPUT');
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) fail('INVALID_INPUT');
      const d = descriptors[key];
      if (!Object.hasOwn(d, 'value') || !d.enumerable) fail('INVALID_INPUT');
      charge(Buffer.byteLength(JSON.stringify(key)) + 2);
      result[key] = copy(d.value, depth + 1);
    }
    ancestors.delete(item);
    return result;
  }
  return copy(value, 0);
}

function shape(value, allowed, required) {
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) fail('SCHEMA_MISMATCH');
}
function validId(id) {
  return (typeof id === 'number' && Number.isSafeInteger(id) && !Object.is(id, -0)) ||
    (typeof id === 'string' && id.length > 0 && Buffer.byteLength(id) <= 256);
}
function synchronous(result) {
  // Observe rejected native promises without assimilating arbitrary thenables.
  if (types.isPromise(result)) {
    Promise.prototype.then.call(result, noop, noop);
    fail('INVALID_INPUT');
  }
  if (result !== null && (typeof result === 'object' || typeof result === 'function')) fail('INVALID_INPUT');
}

/** Owned, newline-delimited app-server stdio. Payloads are never logged or retained as history. */
export class CodexStdioTransport {
  #readable; #writable; #notification; #serverRequest; #onClose;
  #timeout; #frameLimit; #pendingLimit; #bufferLimit;
  #closed = false; #lastId = 0; #pending = new Map(); #records = new Set();
  #serverIds = new Set(); #queue = []; #outputBytes = 0;
  #input = Buffer.alloc(0); #writing = false; #blocked = false; #pumping = false;
  #listeners;

  constructor({readable, writable, onNotification = noop, onServerRequest = noop,
    onClose = noop, timeoutMs = 5000, maxFrameBytes = 262144,
    maxPending = 16, maxBufferedBytes = 1048576}) {
    for (const [value, max] of [[timeoutMs, 2147483647], [maxFrameBytes, 16777216],
      [maxPending, 1024], [maxBufferedBytes, 67108864]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > max) fail('INVALID_INPUT');
    }
    if (!readable || !writable || typeof readable.on !== 'function' ||
        typeof readable.pause !== 'function' || typeof writable.on !== 'function' ||
        typeof writable.write !== 'function' ||
        [onNotification, onServerRequest, onClose].some(fn => typeof fn !== 'function')) fail('INVALID_INPUT');
    this.#readable = readable; this.#writable = writable;
    this.#notification = onNotification; this.#serverRequest = onServerRequest; this.#onClose = onClose;
    this.#timeout = timeoutMs; this.#frameLimit = maxFrameBytes;
    this.#pendingLimit = maxPending; this.#bufferLimit = maxBufferedBytes;
    this.#listeners = {
      data: chunk => this.#read(chunk), end: () => this.#shutdown('CLOSED'),
      close: () => this.#shutdown('CLOSED'), error: () => this.#shutdown('CLOSED'),
      drain: () => { this.#blocked = false; this.#pump(); }
    };
    for (const event of ['data', 'end', 'close', 'error']) readable.on(event, this.#listeners[event]);
    for (const event of ['close', 'error', 'drain']) writable.on(event, this.#listeners[event]);
    if (readable.destroyed || readable.readableEnded || writable.destroyed || writable.writableEnded) this.#shutdown('CLOSED');
  }

  get closed() { return this.#closed; }

  request(method, params, options = {}) {
    try {
      if (this.#closed) fail('CLOSED');
      if (!METHODS.has(method)) fail('INVALID_INPUT');
      const copied = copyJson(params, this.#frameLimit);
      if (this.#lastId === Number.MAX_SAFE_INTEGER) fail('CAPACITY');
      const id = ++this.#lastId;
      return this.#enqueue({id, method, params: copied}, options.beforeWrite, id);
    } catch (error) { return Promise.reject(isControlError(error) ? error : new ControlError()); }
  }

  initialized(options = {}) {
    try {
      if (this.#closed) fail('CLOSED');
      return this.#enqueue({method: 'initialized'}, options.beforeWrite);
    } catch (error) { return Promise.reject(isControlError(error) ? error : new ControlError()); }
  }

  close() { this.#shutdown('CLOSED'); }

  #enqueue(message, guard, id) {
    if (typeof guard !== 'function') fail('INVALID_INPUT');
    if (this.#records.size >= this.#pendingLimit) fail('CAPACITY');
    const frame = Buffer.from(JSON.stringify(message) + '\n');
    if (frame.length - 1 > this.#frameLimit ||
        frame.length + this.#outputBytes + this.#input.length > this.#bufferLimit) fail('CAPACITY');
    return new Promise((resolve, reject) => {
      const entry = {id, guard, frame, bytes: frame.length, resolve, reject,
        written: false, callbackDone: false, settled: false, timer: null};
      this.#records.add(entry); this.#outputBytes += entry.bytes;
      if (id !== undefined) this.#pending.set(id, entry);
      entry.timer = setTimeout(() => this.#settle(entry, new ControlError('EXPIRED')), this.#timeout);
      this.#queue.push(entry); this.#pump();
    });
  }

  #settle(entry, error, value) {
    if (entry.settled) return;
    entry.settled = true; clearTimeout(entry.timer); entry.timer = null;
    if (entry.id !== undefined) this.#pending.delete(entry.id);
    entry.guard = null;
    if (!entry.written) {
      this.#queue = this.#queue.filter(item => item !== entry);
      this.#releaseBytes(entry); entry.callbackDone = true;
    }
    if (entry.callbackDone) this.#records.delete(entry);
    const resolve = entry.resolve, reject = entry.reject;
    entry.resolve = entry.reject = null;
    if (error) reject(error); else resolve(value);
  }

  #releaseBytes(entry) {
    this.#outputBytes -= entry.bytes; entry.bytes = 0; entry.frame = null;
  }

  #pump() {
    if (this.#pumping || this.#closed) return;
    this.#pumping = true;
    try {
      while (!this.#closed && !this.#writing && !this.#blocked && this.#queue.length) {
        const entry = this.#queue.shift();
        const frame = entry.frame;
        try {
          // No asynchronous boundary between authority check and the single write.
          synchronous(entry.guard());
        } catch (error) {
          this.#settle(entry, isControlError(error) ? error : new ControlError());
          continue;
        }
        if (this.#closed) break; // A synchronous guard may explicitly close us.
        entry.guard = null; entry.frame = null; entry.written = true; this.#writing = true;
        try {
          const ready = this.#writable.write(frame, error => {
            if (this.#closed || entry.callbackDone) return;
            entry.callbackDone = true; this.#writing = false; this.#releaseBytes(entry);
            if (error) { this.#shutdown('CLOSED'); return; }
            if (entry.settled) this.#records.delete(entry);
            else if (entry.id === undefined) this.#settle(entry);
            this.#pump();
          });
          if (!ready) this.#blocked = true;
        } catch { this.#shutdown('CLOSED'); }
      }
    } finally { this.#pumping = false; }
  }

  #read(chunk) {
    if (this.#closed) return;
    try {
      if (!(chunk instanceof Uint8Array) || chunk.byteLength + this.#input.length + this.#outputBytes > this.#bufferLimit) fail('CAPACITY');
      let bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      while (bytes.length && !this.#closed) {
        const newline = bytes.indexOf(10);
        const length = newline < 0 ? bytes.length : newline;
        if (this.#input.length + length > this.#frameLimit) fail('CAPACITY');
        if (newline < 0) {
          this.#input = Buffer.concat([this.#input, bytes]); return;
        }
        let line = Buffer.concat([this.#input, bytes.subarray(0, newline)]);
        this.#input = Buffer.alloc(0);
        if (line.at(-1) === 13) line = line.subarray(0, -1);
        if (!line.length) fail('SCHEMA_MISMATCH');
        const value = copyJson(JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(line)), this.#frameLimit);
        this.#message(value);
        bytes = bytes.subarray(newline + 1);
      }
    } catch (error) { this.#shutdown(isControlError(error) ? error.code : 'SCHEMA_MISMATCH'); }
  }

  #message(value) {
    if (value && Object.hasOwn(value, 'method')) {
      // The pinned ServerNotification schema adds an optional int64 timestamp.
      // Keep exact JS integers; this native event time is never an authority clock.
      shape(value, ['method', 'id', 'params', 'emittedAtMs'], ['method']);
      if (Object.hasOwn(value, 'emittedAtMs') &&
          (Object.hasOwn(value, 'id') || !Number.isSafeInteger(value.emittedAtMs))) fail('SCHEMA_MISMATCH');
      if (typeof value.method !== 'string' || !value.method.length || Buffer.byteLength(value.method) > 256) fail('SCHEMA_MISMATCH');
      if (Object.hasOwn(value, 'id')) {
        if (!validId(value.id)) fail('SCHEMA_MISMATCH');
        // Set preserves numeric/string ID distinction. P4 owns future replies.
        if (this.#serverIds.size >= 8 || this.#serverIds.has(value.id)) fail('CAPACITY');
        this.#serverIds.add(value.id);
        synchronous(this.#serverRequest(Object.freeze({method: value.method, id: value.id})));
      } else synchronous(this.#notification(value));
      return;
    }
    shape(value, ['id', 'result', 'error'], ['id']);
    if (!validId(value.id) || Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error')) fail('SCHEMA_MISMATCH');
    const entry = this.#pending.get(value.id);
    if (!entry || !entry.written) fail('SCHEMA_MISMATCH');
    if (Object.hasOwn(value, 'error')) {
      shape(value.error, ['code', 'message', 'data'], ['code', 'message']);
      if (!Number.isSafeInteger(value.error.code) || typeof value.error.message !== 'string') fail('SCHEMA_MISMATCH');
      this.#settle(entry, new ControlError('CONTROL_ERROR'));
    } else this.#settle(entry, null, value.result);
  }

  #shutdown(code) {
    if (this.#closed) return;
    this.#closed = true;
    const error = new ControlError(code);
    for (const entry of this.#records) this.#settle(entry, error);
    this.#records.clear(); this.#pending.clear(); this.#serverIds.clear(); this.#queue = [];
    this.#input = Buffer.alloc(0); this.#outputBytes = 0;
    this.#readable.pause();
    for (const event of ['data', 'end', 'close', 'error']) this.#readable.removeListener(event, this.#listeners[event]);
    for (const event of ['close', 'error', 'drain']) this.#writable.removeListener(event, this.#listeners[event]);
    // A Node write callback can precede its scheduled error event. Keep only an
    // error sink until destruction completes, never a data reader or timer.
    for (const stream of new Set([this.#readable, this.#writable])) {
      stream.on('error', noop);
      stream.once('close', () => stream.removeListener('error', noop));
    }
    // No error argument: shutdown never exports native error text.
    this.#readable.destroy?.(); this.#writable.destroy?.();
    const callback = this.#onClose;
    this.#notification = this.#serverRequest = this.#onClose = noop;
    try { synchronous(callback(error)); } catch { /* Already closed; fixed error only. */ }
  }
}
