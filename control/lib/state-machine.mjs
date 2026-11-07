import {ControlError} from './errors.mjs';

export const OPERATION_STATES = Object.freeze([
  'ADMITTED', 'DISPATCH_INTENT', 'NATIVE_ACCEPTED', 'RUNNING', 'INTERRUPT_REQUESTED',
  'COMPLETED', 'FAILED', 'INTERRUPTED', 'CANCELLED', 'EXPIRED', 'NOT_DISPATCHED', 'UNKNOWN'
]);
export const OPERATION_EVENTS = Object.freeze([
  ...OPERATION_STATES.filter(value => value !== 'ADMITTED'),
  'RECONCILED_COMPLETED', 'RECONCILED_FAILED', 'RECONCILED_INTERRUPTED', 'RECONCILED_NOT_DISPATCHED'
]);
export const TERMINAL_OPERATION_STATES = Object.freeze([
  'COMPLETED', 'FAILED', 'INTERRUPTED', 'CANCELLED', 'EXPIRED', 'NOT_DISPATCHED'
]);
const nativeFinal = ['COMPLETED', 'FAILED', 'INTERRUPTED'];
const observations = ['NATIVE_ACCEPTED', 'RUNNING', 'INTERRUPT_REQUESTED', ...nativeFinal];
const result = (state, late = false) => Object.freeze({state, late});
const invalid = () => { throw new ControlError('INVALID_TRANSITION'); };

/**
 * Pure state projection only. The journal must separately validate immutable
 * context, event identity/revision and authentic evidence for RECONCILED_*.
 * No state transition here performs or authorizes a side effect.
 */
export function transitionOperationState(current, type) {
  if (!OPERATION_STATES.includes(current) || !OPERATION_EVENTS.includes(type)) invalid();
  if (TERMINAL_OPERATION_STATES.includes(current)) {
    if (type === current || type === 'RECONCILED_' + current) return result(current, true);
    if (nativeFinal.includes(current) && ['NATIVE_ACCEPTED', 'RUNNING', 'INTERRUPT_REQUESTED'].includes(type)) {
      return result(current, true);
    }
    invalid();
  }
  if (current === 'UNKNOWN') {
    if (type.startsWith('RECONCILED_')) return result(type.slice('RECONCILED_'.length));
    if ([...observations, 'CANCELLED', 'EXPIRED', 'UNKNOWN'].includes(type)) return result('UNKNOWN', true);
    invalid();
  }
  if (type.startsWith('RECONCILED_')) invalid();
  if (current === 'ADMITTED') {
    if (['DISPATCH_INTENT', 'CANCELLED', 'EXPIRED', 'NOT_DISPATCHED', 'UNKNOWN'].includes(type)) return result(type);
    invalid();
  }
  if (['CANCELLED', 'EXPIRED', 'UNKNOWN'].includes(type)) return result('UNKNOWN', current === 'UNKNOWN');
  if (nativeFinal.includes(type)) return result(type);
  if (current === 'DISPATCH_INTENT' && ['NATIVE_ACCEPTED', 'RUNNING', 'INTERRUPT_REQUESTED'].includes(type)) return result(type);
  if (current === 'NATIVE_ACCEPTED' && ['RUNNING', 'INTERRUPT_REQUESTED'].includes(type)) return result(type);
  if (current === 'RUNNING' && type === 'INTERRUPT_REQUESTED') return result(type);
  if (type === current || type === 'NATIVE_ACCEPTED' && ['RUNNING', 'INTERRUPT_REQUESTED'].includes(current) ||
      type === 'RUNNING' && current === 'INTERRUPT_REQUESTED') return result(current, true);
  invalid();
}
