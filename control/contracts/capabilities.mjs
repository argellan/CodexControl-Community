import {ControlError} from '../lib/errors.mjs';
import {strictRecord, uuid, integer, enumValue, arrayValues, deepFreeze} from '../lib/privacy.mjs';
import {OPERATION_ACTIONS} from './operations.mjs';

/** A grant record is not an authority decision; no enforcement exists in P1. */
export function validateControlGrant(value) {
  strictRecord(value, ['version', 'grantId', 'actorId', 'hostId', 'projectId',
    'providerProfileId', 'sessionId', 'actions', 'grantRevision', 'policyRevision',
    'authorityGeneration', 'createdAtMs', 'expiresAtMs', 'enabled']);
  if (value.version !== 1) throw new ControlError('SCHEMA_MISMATCH');
  if (typeof value.enabled !== 'boolean') throw new ControlError('INVALID_INPUT');
  const actions = arrayValues(value.actions, 1, OPERATION_ACTIONS.length).map(action => enumValue(action, OPERATION_ACTIONS));
  if (new Set(actions).size !== actions.length) throw new ControlError('INVALID_INPUT');
  const createdAtMs = integer(value.createdAtMs), expiresAtMs = integer(value.expiresAtMs);
  if (expiresAtMs <= createdAtMs) throw new ControlError('INVALID_INPUT');
  return deepFreeze({version: 1, grantId: uuid(value.grantId), actorId: uuid(value.actorId),
    hostId: uuid(value.hostId), projectId: uuid(value.projectId),
    providerProfileId: uuid(value.providerProfileId, true), sessionId: uuid(value.sessionId, true),
    actions, grantRevision: integer(value.grantRevision, 1), policyRevision: integer(value.policyRevision, 1),
    authorityGeneration: integer(value.authorityGeneration, 1), createdAtMs, expiresAtMs, enabled: value.enabled});
}

const foundation = deepFreeze({version: 1, stage: 'FOUNDATION_ONLY', enabled: false,
  authorizationEnforced: false, nativeQualified: false, terminalQualified: false,
  providerRuntime: 'UNAVAILABLE', operations: OPERATION_ACTIONS.map(action =>
    ({action, implemented: false, enabled: false, status: 'UNAVAILABLE'}))});

/** There is intentionally no configuration parameter which can enable control. */
export function foundationCapabilities() { return foundation; }
