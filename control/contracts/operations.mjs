import {ControlError} from '../lib/errors.mjs';
import {strictRecord, uuid, integer, enumValue, deepFreeze} from '../lib/privacy.mjs';

export const MAX_OPERATION_TIMEOUT_MS = 86_400_000;
export const OPERATION_ACTIONS = Object.freeze([
  'control.inspect', 'control.grants.manage', 'content.view',
  'runtime.launch', 'runtime.stop', 'session.create', 'session.resume',
  'turn.start', 'turn.steer', 'turn.interrupt', 'approval.respond', 'request.respond',
  'terminal.open', 'terminal.view', 'terminal.input', 'terminal.resize', 'terminal.terminate'
]);

const targetKeys = ['hostId', 'projectId', 'providerProfileId', 'runtimeId',
  'sessionId', 'turnId', 'terminalId', 'requestId'];
const contextKeys = ['entityRevision', 'policyRevision', 'grantRevision',
  'authorityGeneration', 'ownershipFence', 'connectionEpoch'];

// Creation actions may use broker IDs allocated before the native resource exists.
// These are minimum structural targets; existence, ownership and authority are P2+.
export const OPERATION_REQUIRED_TARGETS = deepFreeze({
  'control.inspect': [], 'control.grants.manage': [], 'content.view': [],
  'runtime.launch': ['providerProfileId', 'runtimeId'],
  'runtime.stop': ['providerProfileId', 'runtimeId'],
  'session.create': ['providerProfileId', 'runtimeId', 'sessionId'],
  'session.resume': ['providerProfileId', 'runtimeId', 'sessionId'],
  'turn.start': ['providerProfileId', 'runtimeId', 'sessionId'],
  'turn.steer': ['providerProfileId', 'runtimeId', 'sessionId', 'turnId'],
  'turn.interrupt': ['providerProfileId', 'runtimeId', 'sessionId', 'turnId'],
  'approval.respond': ['providerProfileId', 'runtimeId', 'sessionId', 'requestId'],
  'request.respond': ['providerProfileId', 'runtimeId', 'sessionId', 'requestId'],
  'terminal.open': ['terminalId'], 'terminal.view': ['terminalId'],
  'terminal.input': ['terminalId'], 'terminal.resize': ['terminalId'],
  'terminal.terminate': ['terminalId']
});

export function validateOperationTarget(value) {
  strictRecord(value, targetKeys);
  return deepFreeze(Object.fromEntries(targetKeys.map(key =>
    [key, uuid(value[key], !['hostId', 'projectId'].includes(key))])));
}

export function validateOperationContext(value) {
  strictRecord(value, contextKeys);
  return deepFreeze({entityRevision: integer(value.entityRevision),
    policyRevision: integer(value.policyRevision, 1), grantRevision: integer(value.grantRevision, 1),
    authorityGeneration: integer(value.authorityGeneration, 1),
    ownershipFence: integer(value.ownershipFence, 1), connectionEpoch: uuid(value.connectionEpoch)});
}

/** Metadata-only schema; this neither grants authority nor dispatches actions. */
export function validateOperation(value) {
  strictRecord(value, ['version', 'operationId', 'requestKey', 'actorId', 'action',
    'target', 'context', 'createdAtMs', 'deadlineAtMs', 'timeoutMs']);
  if (value.version !== 1) throw new ControlError('SCHEMA_MISMATCH');
  const createdAtMs = integer(value.createdAtMs);
  const deadlineAtMs = integer(value.deadlineAtMs);
  const timeoutMs = integer(value.timeoutMs, 1, MAX_OPERATION_TIMEOUT_MS);
  const duration = deadlineAtMs - createdAtMs;
  if (duration < timeoutMs || duration > MAX_OPERATION_TIMEOUT_MS) throw new ControlError('INVALID_INPUT');
  const action = enumValue(value.action, OPERATION_ACTIONS);
  const target = validateOperationTarget(value.target);
  if (OPERATION_REQUIRED_TARGETS[action].some(key => target[key] === null)) throw new ControlError('INVALID_INPUT');
  return deepFreeze({version: 1, operationId: uuid(value.operationId), requestKey: uuid(value.requestKey),
    actorId: uuid(value.actorId), action, target, context: validateOperationContext(value.context),
    createdAtMs, deadlineAtMs, timeoutMs});
}
