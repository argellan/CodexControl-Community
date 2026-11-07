/** Fixed error vocabulary: never include input values, paths, payloads or causes. */
export const CONTROL_ERROR_CODES = Object.freeze([
  'INVALID_INPUT', 'CONFLICT', 'NOT_FOUND', 'STALE_CONTEXT', 'STALE_REVISION',
  'INVALID_TRANSITION', 'EXPIRED', 'CAPACITY', 'STORAGE_UNAVAILABLE', 'CLOSED',
  'SCHEMA_MISMATCH', 'ARCHIVE_INVALID', 'REPLAY_UNAVAILABLE', 'CLOCK_INVALID',
  'CONTROL_DISABLED', 'CONTROL_ERROR'
]);

export const CONTROL_REASON_CODES = Object.freeze([
  'NONE', 'NATIVE_RESULT', 'TRANSPORT_LOST', 'LOST_ON_RESTART',
  'DEADLINE_EXPIRED', 'OPERATOR_CANCELLED', 'RECONCILED',
  'AUTHORITY_REVOKED', 'STORAGE_PRESSURE'
]);

const knownErrors = new WeakMap();

export class ControlError extends Error {
  constructor(code = 'CONTROL_ERROR') {
    super('Control foundation request refused');
    this.name = 'ControlError';
    this.code = CONTROL_ERROR_CODES.includes(code) ? code : 'CONTROL_ERROR';
    knownErrors.set(this, this.code);
    Object.freeze(this);
  }
}

export function controlError(code) { return new ControlError(code); }

export function isControlError(error) { return knownErrors.has(error); }

export function safeControlError(error) {
  return Object.freeze({
    // Weak identity lookup never invokes an untrusted getter/prototype trap.
    code: knownErrors.get(error) ?? 'CONTROL_ERROR',
    message: 'Control foundation request refused'
  });
}
