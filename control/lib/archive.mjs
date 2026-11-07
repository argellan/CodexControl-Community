import {createHash, verify} from 'node:crypto';
import {ControlError, isControlError} from './errors.mjs';
import {canonicalJson, deepFreeze, integer, strictRecord, uuid} from './privacy.mjs';

export const MAX_ARCHIVE_RECORDS = 1000;
export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const invalid = () => { throw new ControlError('ARCHIVE_INVALID'); };
const digest = value => createHash('sha256').update(value).digest('hex');
function hex(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid();
  return value;
}

/** Only call with records freshly read from the validated metadata journal. */
export function buildArchiveBatch(journalId, records) {
  uuid(journalId);
  if (!Array.isArray(records) || records.length > MAX_ARCHIVE_RECORDS) invalid();
  const descriptors = records.map(row => ({
    sequence: integer(row.sequence, 1),
    eventId: uuid(row.record.event.eventId),
    sha256: hex(row.sha256),
    bytes: Buffer.byteLength(canonicalJson(row.record))
  }));
  if (descriptors.some((row, i) => i && row.sequence <= descriptors[i - 1].sequence)) invalid();
  const bytes = descriptors.reduce((sum, row) => sum + row.bytes, 0);
  if (bytes > MAX_ARCHIVE_BYTES) invalid();
  const descriptor = {version: 1, journalId, records: descriptors};
  return deepFreeze({version: 1, journalId, records, recordCount: records.length,
    recordBytes: bytes, batchSha256: digest(canonicalJson(descriptor))});
}

export function validateArchiveReceipt(value) {
  try {
    strictRecord(value, ['version', 'receiptId', 'receiverId', 'journalId', 'segmentId',
      'segmentSha256', 'batchSha256', 'recordCount', 'recordBytes', 'durable', 'storedAtMs', 'signature']);
    if (value.version !== 1 || value.durable !== true ||
        typeof value.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value.signature)) invalid();
    const signature = Buffer.from(value.signature, 'base64');
    if (signature.length !== 64 || signature.toString('base64') !== value.signature) invalid();
    return deepFreeze({version: 1, receiptId: uuid(value.receiptId), receiverId: uuid(value.receiverId),
      journalId: uuid(value.journalId), segmentId: uuid(value.segmentId),
      segmentSha256: hex(value.segmentSha256), batchSha256: hex(value.batchSha256),
      recordCount: integer(value.recordCount, 1, MAX_ARCHIVE_RECORDS),
      recordBytes: integer(value.recordBytes, 1, MAX_ARCHIVE_BYTES),
      durable: true, storedAtMs: integer(value.storedAtMs), signature: value.signature});
  } catch (error) {
    if (isControlError(error) && error.code === 'ARCHIVE_INVALID') throw error;
    invalid();
  }
}

/** Signing bytes contain metadata only. Never sign excluded source content. */
export function receiptSigningBytes(receipt) {
  const {signature, ...signed} = receipt;
  return Buffer.from(canonicalJson(signed));
}

export function validateArchiveTrust(value) {
  try {
    strictRecord(value, ['receiverId', 'publicKey']);
    const receiverId = uuid(value.receiverId);
    const publicKey = value.publicKey;
    if (!publicKey || publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') invalid();
    const spki = publicKey.export({type: 'spki', format: 'der'});
    return {receiverId, publicKey, keySha256: digest(spki)};
  } catch { invalid(); }
}

/**
 * Verifies a pinned receiver signature and the exact immutable metadata batch.
 * This does not independently prove the receiver wrote its storage correctly.
 * P1 has no receiver/transport and never evicts locally retained records.
 */
export function verifyArchiveReceipt(receipt, batch, trust) {
  const checked = validateArchiveReceipt(receipt);
  if (!trust || checked.receiverId !== trust.receiverId || checked.journalId !== batch.journalId ||
      checked.batchSha256 !== batch.batchSha256 || checked.recordCount !== batch.recordCount ||
      checked.recordBytes !== batch.recordBytes) invalid();
  if (!verify(null, receiptSigningBytes(checked), trust.publicKey, Buffer.from(checked.signature, 'base64'))) invalid();
  return checked;
}
