import {types} from 'node:util';
import {ControlError, CONTROL_REASON_CODES} from './errors.mjs';

const reject = () => { throw new ControlError('INVALID_INPUT'); };
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);

/** Inspect descriptors before reading values. No getters, proxies or hidden keys. */
export function strictRecord(value, allowed, required = allowed) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) ||
      Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) reject();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || forbiddenKeys.has(key) || !allowed.includes(key)) reject();
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) reject();
  }
  if (required.some(key => !Object.hasOwn(descriptors, key))) reject();
  return value;
}

export function uuid(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) reject();
  return value.toLowerCase();
}

export function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum || Object.is(value, -0)) reject();
  return value;
}

export function enumValue(value, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) reject();
  return value;
}

export function opaqueToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) reject();
  return value;
}

export function arrayValues(value, minimum, maximum) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < minimum || value.length > maximum) reject();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) reject();
  const result = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) reject();
    result.push(descriptor.value);
  }
  return result;
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Deterministic encoding of ALREADY SCHEMA-VALIDATED metadata. This utility is
 * not a privacy classifier and must never receive sensitive content. No hashes
 * or other derived content are computed here. Unsupported JS values fail closed.
 */
export function canonicalJson(value) {
  const ancestors = new Set();
  function normalize(current, depth) {
    if (depth > 32) reject();
    if (current === null || typeof current === 'boolean' || typeof current === 'string') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) reject();
      return current;
    }
    if (typeof current !== 'object' || types.isProxy(current) || ancestors.has(current)) reject();
    ancestors.add(current);
    let result;
    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype) reject();
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (Reflect.ownKeys(descriptors).length !== current.length + 1) reject();
      result = [];
      for (let i = 0; i < current.length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) reject();
        result.push(normalize(descriptor.value, depth + 1));
      }
    } else {
      strictRecord(current, Object.keys(current));
      result = {};
      for (const key of Object.keys(current).sort()) result[key] = normalize(current[key], depth + 1);
    }
    ancestors.delete(current);
    return result;
  }
  return JSON.stringify(normalize(value, 0));
}

/** A deliberately small durable event projection; no free-form event text. */
export function sanitizeMetadataEvent(value) {
  strictRecord(value, ['version', 'eventId', 'operationId', 'code', 'atMs']);
  if (value.version !== 1) reject();
  return deepFreeze({version: 1, eventId: uuid(value.eventId),
    operationId: uuid(value.operationId), code: enumValue(value.code, CONTROL_REASON_CODES),
    atMs: integer(value.atMs)});
}
