import {performance} from 'node:perf_hooks';
import {types} from 'node:util';
import {ControlError} from './errors.mjs';
import {strictRecord, uuid, integer, enumValue, arrayValues} from './privacy.mjs';

export const TRANSIENT_CONTENT_KINDS = Object.freeze(['transport', 'turn-consent', 'approval-consent']);
const byteLengthOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const setBytes = Uint8Array.prototype.set;

/**
 * RAM-only content, with separate lifetimes selected by the trusted caller.
 * No timers, serialization, hashes, logs or native calls. Owned Buffer copies
 * are overwritten before removal; caller copies, strings, runtime/OS copies
 * cannot be zeroized by this store. Clearing RAM is not secure zeroization.
 *
 * Tombstones prevent rehydration for this instance. On restart the durable
 * journal must admit only a new reservation; retiredIds may preload its known
 * IDs. This store alone cannot prove first reservation across process death.
 */
export function createTransientContentStore(options = {}) {
  strictRecord(options, ['maxBytes', 'maxEntries', 'maxReservations', 'maxTtlMs', 'clock', 'retiredIds'], []);
  const maxBytes = integer(options.maxBytes ?? 1_048_576, 1, 4_194_304);
  const maxEntries = integer(options.maxEntries ?? 64, 1, 256);
  const maxReservations = integer(options.maxReservations ?? 4096, maxEntries, 16384);
  const maxTtlMs = integer(options.maxTtlMs ?? 300_000, 1, 86_400_000);
  const clock = options.clock ?? (() => performance.now());
  if (typeof clock !== 'function' || types.isProxy(clock)) throw new ControlError('INVALID_INPUT');
  const retired = arrayValues(options.retiredIds ?? [], 0, maxReservations).map(value => uuid(value));
  if (new Set(retired).size !== retired.length) throw new ControlError('INVALID_INPUT');
  const seen = new Set(retired), entries = new Map();
  let byteCount = 0, closed = false, lastNow = 0;
  function erase(id) {
    const entry = entries.get(id);
    if (!entry) return false;
    entry.bytes.fill(0);
    byteCount -= entry.bytes.length;
    entries.delete(id);
    return true;
  }
  function wipe() { for (const id of entries.keys()) erase(id); }
  function now() {
    if (closed) throw new ControlError('CLOSED');
    let value;
    try { value = clock(); } catch { wipe(); closed = true; throw new ControlError('CLOCK_INVALID'); }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < lastNow || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      wipe(); closed = true; throw new ControlError('CLOCK_INVALID');
    }
    lastNow = value;
    return value;
  }
  function expire(at) {
    let expired = 0;
    for (const [id, entry] of entries) if (entry.expiresAt <= at) { erase(id); expired++; }
    return expired;
  }
  function current(id) {
    const key = uuid(id);
    expire(now());
    const entry = entries.get(key);
    if (!entry) throw new ControlError('REPLAY_UNAVAILABLE');
    return [key, entry];
  }
  now();
  return Object.freeze({
    reserve(value) {
      strictRecord(value, ['id', 'scopeId', 'kind', 'ttlMs', 'bytes']);
      const id = uuid(value.id), scopeId = uuid(value.scopeId);
      const kind = enumValue(value.kind, TRANSIENT_CONTENT_KINDS);
      const ttlMs = integer(value.ttlMs, 1, maxTtlMs);
      const source = value.bytes;
      if (types.isProxy(source) || !types.isUint8Array(source) || Object.getPrototypeOf(source) !== Buffer.prototype) throw new ControlError('INVALID_INPUT');
      // Read/copy the typed-array storage, never caller-supplied length/valueOf/iterator hooks.
      const byteLength = byteLengthOf.call(source);
      if (byteLength < 1 || byteLength > maxBytes) throw new ControlError('INVALID_INPUT');
      const at = now();
      expire(at);
      if (seen.has(id)) return Object.freeze({created: false, id, available: entries.has(id)});
      if (entries.size >= maxEntries || seen.size >= maxReservations || byteCount + byteLength > maxBytes) throw new ControlError('CAPACITY');
      if (at + ttlMs > Number.MAX_SAFE_INTEGER) throw new ControlError('CLOCK_INVALID');
      const bytes = Buffer.alloc(byteLength);
      setBytes.call(bytes, source);
      entries.set(id, {scopeId, kind, bytes, expiresAt: at + ttlMs});
      seen.add(id);
      byteCount += bytes.length;
      return Object.freeze({created: true, id, available: true});
    },
    read(id) { return Buffer.from(current(id)[1].bytes); },
    consumeBound(input) {
      strictRecord(input,['id','scopeId','kind']);
      const [key,entry]=current(input.id);
      if(entry.scopeId!==uuid(input.scopeId)||entry.kind!==enumValue(input.kind,TRANSIENT_CONTENT_KINDS))throw new ControlError('STALE_CONTEXT');
      const copy=Buffer.from(entry.bytes);erase(key);return copy;
    },
    consume(id) {
      const [key, entry] = current(id), copy = Buffer.from(entry.bytes);
      erase(key);
      return copy;
    },
    remove(id) { const key = uuid(id); expire(now()); return erase(key); },
    invalidateScope(scopeId) {
      const scope = uuid(scopeId);
      expire(now());
      let removed = 0;
      for (const [id, entry] of entries) if (entry.scopeId === scope) { erase(id); removed++; }
      return removed;
    },
    sweep() { return expire(now()); },
    close() { if (!closed) { wipe(); closed = true; } },
    stats() {
      if (!closed) expire(now());
      return Object.freeze({closed, entries: entries.size, bytes: byteCount, reservations: seen.size,
        maxBytes, maxEntries, maxReservations, maxTtlMs});
    }
  });
}
