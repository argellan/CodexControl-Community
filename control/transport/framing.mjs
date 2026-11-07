import {Readable, Writable} from 'node:stream';
import {OutgoingMessage} from 'node:http';
import {types} from 'node:util';
import {ControlError, isControlError, safeControlError} from '../lib/errors.mjs';
import {strictRecord, integer} from '../lib/privacy.mjs';

const DEADLINE_MS = 5_000;
const FRAME_KEYS = ['readable', 'writable', 'validate', 'onMessage', 'onClose',
  'maxFrameBytes', 'maxBufferedBytes', 'maxMessages'];
const fail = code => new ControlError(code);
const increment = value => Math.min(Number.MAX_SAFE_INTEGER, value + 1);

// The validator is trusted to project independent metadata. Inspect its result
// as data too: never invoke toJSON, accessors or proxies during serialization.
// These hard shape/work limits are additional to the byte limit.
function encodeMetadata(value, limit) {
  const parts = [], ancestors = new Set();
  let bytes = 0, nodes = 0;
  function append(part) {
    bytes += Buffer.byteLength(part);
    if (bytes > limit) throw fail('CAPACITY');
    parts.push(part);
  }
  function visit(current, depth) {
    if (++nodes > 8192 || depth > 32) throw fail('CAPACITY');
    if (current === null || typeof current === 'boolean') { append(String(current)); return; }
    if (typeof current === 'string') {
      if (current.length > limit) throw fail('CAPACITY');
      append(JSON.stringify(current)); return;
    }
    if (typeof current === 'number' && Number.isFinite(current) && !Object.is(current, -0)) {
      append(String(current)); return;
    }
    if (typeof current !== 'object' || types.isProxy(current) || ancestors.has(current)) throw fail('INVALID_INPUT');
    const array = Array.isArray(current);
    if (Object.getPrototypeOf(current) !== (array ? Array.prototype : Object.prototype)) throw fail('INVALID_INPUT');
    const keys = Reflect.ownKeys(current);
    if (keys.length > 8192) throw fail('CAPACITY');
    const descriptors = Object.getOwnPropertyDescriptors(current);
    ancestors.add(current);
    append(array ? '[' : '{');
    if (array) {
      const length = descriptors.length.value;
      if (keys.length !== length + 1) throw fail('INVALID_INPUT');
      for (let i = 0; i < length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw fail('INVALID_INPUT');
        if (i) append(',');
        visit(descriptor.value, depth + 1);
      }
    } else {
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i], descriptor = descriptors[key];
        if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable ||
            ['__proto__', 'constructor', 'prototype'].includes(key)) throw fail('INVALID_INPUT');
        if (i) append(',');
        if (key.length > limit) throw fail('CAPACITY');
        append(JSON.stringify(key)); append(':'); visit(descriptor.value, depth + 1);
      }
    }
    append(array ? ']' : '}');
    ancestors.delete(current);
  }
  if (!value || typeof value !== 'object') throw fail('INVALID_INPUT');
  visit(value, 0);
  return parts.join('');
}

function project(validator, value) {
  const safe = validator(value);
  // A plain function can still accidentally return a native rejected Promise.
  // Observe its rejection without executing a caller-defined .then getter.
  if (types.isPromise(safe)) {
    try { Promise.prototype.then.call(safe, ignoreError, ignoreError); } catch { /* invalid validator result */ }
    throw fail('INVALID_INPUT');
  }
  if (safe === value) throw fail('INVALID_INPUT');
  return safe;
}

/**
 * RAM-only, no replay. Limits cover owned wire buffers plus a wire-size
 * reservation for the single validated callback in flight. JS objects, trusted
 * stream high-water marks and OS/TLS buffers have their own bounded overhead.
 * Each partial frame, callback and write/drain has an absolute 5s deadline.
 * Only construction installs listeners/timers; importing this module is inert.
 */
export class BoundedFrameChannel {
  #readable; #writable; #validate; #onMessage; #onClose;
  #maxFrame; #maxBytes; #maxMessages;
  #closed = false; #reason = 'NONE'; #bytes = 4; #messages = 0;
  #received = 0; #sent = 0;
  #header = Buffer.alloc(4); #headerAt = 0; #body = null; #bodyAt = 0;
  #input = null; #inputAt = 0; #incoming = []; #outgoing = [];
  #active = null; #writing = null;
  #parseJob = null; #dispatchJob = null; #writeJob = null; #partialTimer = null;
  #listeners;

  constructor(options) {
    strictRecord(options, FRAME_KEYS, ['readable', 'writable', 'validate', 'onMessage']);
    for (const value of Object.values(options)) if (types.isProxy(value)) throw fail('INVALID_INPUT');
    const {readable, writable, validate, onMessage, onClose} = options;
    if (!(readable instanceof Readable) || (!(writable instanceof Writable) && !(writable instanceof OutgoingMessage)) ||
        typeof validate !== 'function' || types.isAsyncFunction(validate) || types.isGeneratorFunction(validate) ||
        typeof onMessage !== 'function' ||
        (onClose !== undefined && typeof onClose !== 'function')) throw fail('INVALID_INPUT');
    this.#maxFrame = integer(options.maxFrameBytes === undefined ? 65_536 : options.maxFrameBytes, 1, 1_048_576);
    this.#maxBytes = integer(options.maxBufferedBytes === undefined ? 262_144 : options.maxBufferedBytes, this.#maxFrame + 8, 4_194_304);
    this.#maxMessages = integer(options.maxMessages === undefined ? 8 : options.maxMessages, 1, 64);
    if (readable.destroyed || readable.readableEnded || writable.destroyed || writable.writableEnded ||
        !readable.readable || !writable.writable || readable.readableEncoding) throw fail('CLOSED');
    this.#readable = readable; this.#writable = writable;
    this.#validate = validate; this.#onMessage = onMessage; this.#onClose = onClose;
    this.#listeners = {
      data: chunk => this.#receive(chunk), end: () => this.#stop('TRANSPORT_LOST'),
      close: () => this.#stop('TRANSPORT_LOST'), error: () => this.#stop('TRANSPORT_LOST'),
      finish: () => this.#stop('TRANSPORT_LOST'), drain: () => this.#drained()
    };
    readable.pause();
    for (const name of ['data', 'end', 'close', 'error']) readable.on(name, this.#listeners[name]);
    for (const name of ['close', 'error', 'finish', 'drain']) writable.on(name, this.#listeners[name]);
    readable.resume();
  }

  status() {
    return Object.freeze({closed: this.#closed, reasonCode: this.#reason,
      bufferedBytes: this.#bytes, pendingMessages: this.#messages,
      receivedMessages: this.#received, sentMessages: this.#sent});
  }

  close() { this.#stop('CLOSED'); }

  send(value) {
    if (this.#closed) return Promise.reject(fail('CLOSED'));
    if (this.#messages >= this.#maxMessages) {
      this.#stop('CAPACITY'); return Promise.reject(fail('CAPACITY'));
    }
    let text, length;
    try {
      const safe = project(this.#validate, value);
      if (this.#closed) throw fail('CLOSED');
      text = encodeMetadata(safe, this.#maxFrame);
      length = Buffer.byteLength(text);
    } catch (error) {
      const code = this.#closed ? 'CLOSED' : (isControlError(error) ? safeControlError(error).code : 'INVALID_INPUT');
      this.#stop(code); return Promise.reject(fail(code));
    }
    if (this.#messages >= this.#maxMessages || this.#bytes + length + 4 > this.#maxBytes) {
      this.#stop('CAPACITY'); return Promise.reject(fail('CAPACITY'));
    }
    const packet = Buffer.allocUnsafeSlow(length + 4);
    packet.writeUInt32BE(length); packet.write(text, 4, length, 'utf8');
    this.#bytes += packet.length; this.#messages++;
    return new Promise((resolve, reject) => {
      const entry = {packet, resolve, reject, timer: null, callback: false, drained: false, writing: false};
      // Queue waiting time is bounded too, even behind another blocked write.
      entry.timer = setTimeout(() => this.#stop('EXPIRED'), DEADLINE_MS);
      this.#outgoing.push(entry); this.#scheduleWrite();
    });
  }

  #receive(chunk) {
    if (this.#closed) return;
    this.#readable.pause();
    if (!Buffer.isBuffer(chunk)) { this.#stop('INVALID_INPUT'); return; }
    if (!chunk.length) { this.#resume(); return; }
    if (this.#input || this.#bytes + chunk.length > this.#maxBytes) { this.#stop('CAPACITY'); return; }
    this.#input = Buffer.allocUnsafeSlow(chunk.length); chunk.copy(this.#input);
    this.#inputAt = 0; this.#bytes += chunk.length;
    this.#scheduleParse();
  }

  #scheduleParse() {
    if (!this.#closed && this.#input && !this.#parseJob)
      this.#parseJob = setImmediate(() => { this.#parseJob = null; this.#parse(); });
  }

  #parse() {
    let frames = 0, work = 0;
    while (!this.#closed && this.#input && frames < 8 && work < 65_536) {
      const remaining = this.#input.length - this.#inputAt;
      if (!remaining) {
        this.#bytes -= this.#input.length; this.#input.fill(0); this.#input = null;
        this.#inputAt = 0; break;
      }
      if (!this.#body) {
        if (!this.#headerAt) {
          if (this.#messages >= this.#maxMessages) { this.#stop('CAPACITY'); break; }
          this.#messages++;
          this.#partialTimer = setTimeout(() => this.#stop('EXPIRED'), DEADLINE_MS);
        }
        const count = Math.min(4 - this.#headerAt, remaining);
        this.#input.copy(this.#header, this.#headerAt, this.#inputAt, this.#inputAt + count);
        this.#headerAt += count; this.#inputAt += count; work += count;
        if (this.#headerAt !== 4) continue;
        const length = this.#header.readUInt32BE(0);
        if (!length || length > this.#maxFrame) { this.#stop('INVALID_INPUT'); break; }
        if (this.#bytes + length + 4 > this.#maxBytes) { this.#stop('CAPACITY'); break; }
        this.#body = Buffer.allocUnsafeSlow(length); this.#bodyAt = 0;
        this.#bytes += length + 4;
      } else {
        const count = Math.min(this.#body.length - this.#bodyAt, remaining, 65_536 - work);
        this.#input.copy(this.#body, this.#bodyAt, this.#inputAt, this.#inputAt + count);
        this.#bodyAt += count; this.#inputAt += count; work += count;
        if (this.#bodyAt !== this.#body.length) continue;
        clearTimeout(this.#partialTimer); this.#partialTimer = null;
        this.#incoming.push(this.#body); this.#body = null; this.#bodyAt = 0;
        this.#header.fill(0); this.#headerAt = 0; frames++;
      }
    }
    if (this.#closed) return;
    if (this.#input && this.#inputAt === this.#input.length) {
      this.#bytes -= this.#input.length; this.#input.fill(0); this.#input = null; this.#inputAt = 0;
    }
    this.#scheduleDispatch(); this.#scheduleParse();
    if (!this.#input) this.#resume();
  }

  #resume() {
    if (!this.#closed && !this.#input && (this.#headerAt || this.#messages < this.#maxMessages)) this.#readable.resume();
  }

  #scheduleDispatch() {
    if (!this.#closed && !this.#active && this.#incoming.length && !this.#dispatchJob)
      this.#dispatchJob = setImmediate(() => { this.#dispatchJob = null; this.#dispatch(); });
  }

  #dispatch() {
    if (this.#closed || this.#active || !this.#incoming.length) return;
    const packet = this.#incoming.shift(); let size = packet.length + 4;
    let safe;
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(packet));
      safe = project(this.#validate, parsed);
      // Ensure the validator returned synchronous, bounded plain metadata.
      const encodedSize = Buffer.byteLength(encodeMetadata(safe, this.#maxFrame)) + 4;
      if (encodedSize > size) {
        if (this.#bytes + encodedSize - size > this.#maxBytes) throw fail('CAPACITY');
        this.#bytes += encodedSize - size; size = encodedSize;
      }
    } catch { packet.fill(0); this.#stop('INVALID_INPUT'); return; }
    packet.fill(0);
    if (this.#closed) return;
    const active = {size, timer: setTimeout(() => this.#stop('EXPIRED'), DEADLINE_MS)};
    this.#active = active; this.#received = increment(this.#received);
    let result;
    try { result = this.#onMessage(safe); }
    catch { this.#stop('CONTROL_ERROR'); return; }
    Promise.resolve(result).then(() => {
      if (this.#closed || this.#active !== active) return;
      clearTimeout(active.timer); this.#active = null;
      this.#bytes -= size; this.#messages--;
      this.#scheduleDispatch(); this.#resume();
    }, () => this.#stop('CONTROL_ERROR'));
  }

  #scheduleWrite() {
    if (!this.#closed && !this.#writing && this.#outgoing.length && !this.#writeJob)
      this.#writeJob = setImmediate(() => { this.#writeJob = null; this.#write(); });
  }

  #write() {
    if (this.#closed || this.#writing || !this.#outgoing.length) return;
    const entry = this.#outgoing.shift(); this.#writing = entry; entry.writing = true;
    try {
      const accepted = this.#writable.write(entry.packet, error => {
        if (this.#closed || this.#writing !== entry) return;
        if (error) { this.#stop('TRANSPORT_LOST'); return; }
        entry.callback = true; this.#finishWrite(entry);
      });
      if (accepted) entry.drained = true;
      entry.writing = false; this.#finishWrite(entry);
    } catch { this.#stop('TRANSPORT_LOST'); }
  }

  #drained() {
    if (this.#writing) { this.#writing.drained = true; this.#finishWrite(this.#writing); }
  }

  #finishWrite(entry) {
    if (this.#closed || entry !== this.#writing || entry.writing || !entry.callback || !entry.drained) return;
    clearTimeout(entry.timer); entry.packet.fill(0);
    this.#bytes -= entry.packet.length; this.#messages--; this.#sent = increment(this.#sent);
    this.#writing = null; entry.resolve(); this.#scheduleWrite(); this.#resume();
  }

  #stop(reason) {
    if (this.#closed) return;
    this.#closed = true; this.#reason = reason;
    for (const job of [this.#parseJob, this.#dispatchJob, this.#writeJob]) if (job) clearImmediate(job);
    this.#parseJob = this.#dispatchJob = this.#writeJob = null;
    clearTimeout(this.#partialTimer); clearTimeout(this.#active?.timer);
    this.#partialTimer = this.#active = null;
    for (const buffer of [this.#header, this.#body, this.#input, ...this.#incoming]) buffer?.fill(0);
    this.#header = this.#body = this.#input = null; this.#incoming.length = 0;
    const entries = this.#writing ? [this.#writing, ...this.#outgoing] : this.#outgoing;
    for (const entry of entries) {
      clearTimeout(entry.timer); entry.packet.fill(0); entry.reject(fail(reason === 'CLOSED' ? 'CLOSED' : reason));
    }
    this.#writing = null; this.#outgoing = []; this.#bytes = 0; this.#messages = 0;
    this.#readable.pause();
    // Retain only the fixed, noncapturing error sink until stream destruction
    // has delivered possible late errors. No ignored stream error is exposed.
    for (const name of ['data', 'end', 'close', 'error']) this.#readable.off(name, this.#listeners[name]);
    for (const name of ['close', 'error', 'finish', 'drain']) this.#writable.off(name, this.#listeners[name]);
    for (const stream of new Set([this.#readable, this.#writable])) {
      stream.on('error', ignoreError);
      try { stream.destroy(); } catch { /* trusted streams; fixed failure only */ }
    }
    const notify = this.#onClose;
    this.#validate = this.#onMessage = this.#onClose = null;
    this.#readable = this.#writable = this.#listeners = null;
    if (notify) {
      try { Promise.resolve(notify(reason)).catch(ignoreError); } catch { /* notification cannot reopen the channel */ }
    }
  }
}

function ignoreError() {}
