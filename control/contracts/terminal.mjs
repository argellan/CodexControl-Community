import {ControlError} from '../lib/errors.mjs';
import {strictRecord, uuid, integer, enumValue, deepFreeze} from '../lib/privacy.mjs';

export const TERMINAL_STATES = Object.freeze([
  'CREATING', 'ATTACHED', 'DETACHED', 'INPUT_REVOKED', 'EXITING', 'EXITED', 'UNKNOWN'
]);
export const TERMINAL_FRAME_TYPES = Object.freeze(['INPUT', 'OUTPUT', 'ACK', 'RESIZE', 'DETACH', 'EXIT']);
export const MAX_TERMINAL_FRAME_BYTES = 16_384;

export function validateTerminalReference(value) {
  strictRecord(value, ['version', 'terminalId', 'hostId', 'projectId', 'runtimeId',
    'ownerId', 'epoch', 'ownershipFence', 'state']);
  if (value.version !== 1) throw new ControlError('SCHEMA_MISMATCH');
  return deepFreeze({version: 1, terminalId: uuid(value.terminalId), hostId: uuid(value.hostId),
    projectId: uuid(value.projectId), runtimeId: uuid(value.runtimeId, true), ownerId: uuid(value.ownerId),
    epoch: uuid(value.epoch), ownershipFence: integer(value.ownershipFence, 1), state: enumValue(value.state, TERMINAL_STATES)});
}

/** Only frame metadata. Byte handling, grants, lease/sequence enforcement are absent. */
export function validateTerminalFrameMetadata(value) {
  strictRecord(value, ['version', 'terminalId', 'epoch', 'attachmentId', 'sequence', 'type',
    'inputLeaseId', 'byteLength', 'columns', 'rows', 'acknowledgedSequence']);
  if (value.version !== 1) throw new ControlError('SCHEMA_MISMATCH');
  const normalized = {version: 1, terminalId: uuid(value.terminalId), epoch: uuid(value.epoch),
    attachmentId: uuid(value.attachmentId), sequence: integer(value.sequence),
    type: enumValue(value.type, TERMINAL_FRAME_TYPES), inputLeaseId: uuid(value.inputLeaseId, true),
    byteLength: integer(value.byteLength, 0, MAX_TERMINAL_FRAME_BYTES),
    columns: value.columns === null ? null : integer(value.columns, 1, 1000),
    rows: value.rows === null ? null : integer(value.rows, 1, 1000),
    acknowledgedSequence: value.acknowledgedSequence === null ? null : integer(value.acknowledgedSequence)};
  const bad = () => { throw new ControlError('INVALID_INPUT'); };
  if (['INPUT', 'OUTPUT'].includes(normalized.type)) {
    if (!normalized.byteLength || normalized.columns !== null || normalized.rows !== null || normalized.acknowledgedSequence !== null) bad();
    if (normalized.type === 'INPUT' ? normalized.inputLeaseId === null : normalized.inputLeaseId !== null) bad();
  } else {
    if (normalized.byteLength !== 0) bad();
    if (normalized.type === 'RESIZE') {
      if (normalized.inputLeaseId === null || normalized.columns === null || normalized.rows === null || normalized.acknowledgedSequence !== null) bad();
    } else {
      if (normalized.columns !== null || normalized.rows !== null || normalized.inputLeaseId !== null) bad();
      if (normalized.type === 'ACK' ? normalized.acknowledgedSequence === null : normalized.acknowledgedSequence !== null) bad();
    }
  }
  return deepFreeze(normalized);
}
