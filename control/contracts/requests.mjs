import {ControlError} from '../lib/errors.mjs';
import {strictRecord, uuid, integer, enumValue, opaqueToken, arrayValues, deepFreeze} from '../lib/privacy.mjs';
import {validateOperationContext, MAX_OPERATION_TIMEOUT_MS} from './operations.mjs';

export const NATIVE_REQUEST_KINDS = Object.freeze([
  'COMMAND_APPROVAL', 'FILE_APPROVAL', 'NETWORK_PERMISSION', 'USER_INPUT', 'MCP_ELICITATION'
]);
export const REQUEST_STATES = Object.freeze([
  'PENDING', 'DECISION_INTENT', 'RESPONSE_SENT', 'RESOLVED', 'EXPIRED', 'ABANDONED', 'UNKNOWN'
]);
export const REQUEST_DECISIONS = Object.freeze(['ALLOW_ONCE', 'DENY', 'CANCEL', 'RESPOND']);

/** Native references are metadata tokens, not ownership or authenticity proof. */
export function validateNativeReference(value) {
  strictRecord(value, ['requestId', 'threadId', 'turnId', 'itemId', 'approvalId'], []);
  if (Object.keys(value).length === 0) throw new ControlError('INVALID_INPUT');
  const normalized = {};
  if (Object.hasOwn(value, 'requestId')) {
    strictRecord(value.requestId, ['type', 'value']);
    const type = enumValue(value.requestId.type, ['string', 'number']);
    normalized.requestId = {type, value: type === 'string' ? opaqueToken(value.requestId.value) :
      integer(value.requestId.value, -Number.MAX_SAFE_INTEGER)};
  }
  for (const key of ['threadId', 'turnId', 'itemId', 'approvalId']) {
    if (Object.hasOwn(value, key)) normalized[key] = opaqueToken(value[key]);
  }
  return deepFreeze(normalized);
}

/** No command/diff/form/input text is accepted in this durable request schema. */
export function validateNativeRequest(value) {
  const ids = ['requestId', 'operationId', 'hostId', 'projectId', 'providerProfileId', 'runtimeId', 'sessionId', 'turnId'];
  strictRecord(value, ['version', ...ids, 'context', 'native', 'kind', 'state',
    'createdAtMs', 'expiresAtMs', 'consentRevision', 'availableDecisions']);
  if (value.version !== 1) throw new ControlError('SCHEMA_MISMATCH');
  const normalized = {version: 1};
  for (const key of ids) normalized[key] = uuid(value[key]);
  normalized.context = validateOperationContext(value.context);
  normalized.native = validateNativeReference(value.native);
  if (!Object.hasOwn(normalized.native, 'requestId')) throw new ControlError('INVALID_INPUT');
  normalized.kind = enumValue(value.kind, NATIVE_REQUEST_KINDS);
  normalized.state = enumValue(value.state, REQUEST_STATES);
  normalized.createdAtMs = integer(value.createdAtMs);
  normalized.expiresAtMs = integer(value.expiresAtMs);
  if (normalized.expiresAtMs <= normalized.createdAtMs ||
      normalized.expiresAtMs - normalized.createdAtMs > MAX_OPERATION_TIMEOUT_MS) throw new ControlError('INVALID_INPUT');
  normalized.consentRevision = integer(value.consentRevision);
  normalized.availableDecisions = arrayValues(value.availableDecisions, 1, REQUEST_DECISIONS.length)
    .map(decision => enumValue(decision, REQUEST_DECISIONS));
  if (new Set(normalized.availableDecisions).size !== normalized.availableDecisions.length) throw new ControlError('INVALID_INPUT');
  const isQuestion = ['USER_INPUT', 'MCP_ELICITATION'].includes(normalized.kind);
  if (isQuestion && normalized.availableDecisions.includes('ALLOW_ONCE') ||
      !isQuestion && normalized.availableDecisions.includes('RESPOND')) throw new ControlError('INVALID_INPUT');
  return deepFreeze(normalized);
}

/** Schema only. Actual matching, authority, effect scope and claim are P2+. */
export function validateRequestDecision(value) {
  strictRecord(value, ['version', 'decisionId', 'requestId', 'actorId', 'decision', 'expectedConsentRevision', 'context']);
  if (value.version !== 1) throw new ControlError('SCHEMA_MISMATCH');
  return deepFreeze({version: 1, decisionId: uuid(value.decisionId), requestId: uuid(value.requestId),
    actorId: uuid(value.actorId), decision: enumValue(value.decision, REQUEST_DECISIONS),
    expectedConsentRevision: integer(value.expectedConsentRevision), context: validateOperationContext(value.context)});
}
