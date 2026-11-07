import {createHash, createPublicKey} from 'node:crypto';
import {ControlError} from '../lib/errors.mjs';
import {strictRecord, uuid, integer, enumValue, opaqueToken, arrayValues, deepFreeze, canonicalJson} from '../lib/privacy.mjs';
import {validateControlGrant} from './capabilities.mjs';
export const metadataDigest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function hex(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ControlError('INVALID_INPUT');
  return value;
}
export function publicKey(value) {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new ControlError('INVALID_INPUT');
  try {
    const bytes = Buffer.from(value,'base64');
    const key = createPublicKey({key:bytes,format:'der',type:'spki'});
    if (key.asymmetricKeyType !== 'ed25519' || key.export({format:'der',type:'spki'}).toString('base64') !== value) throw 0;
    return value;
  } catch { throw new ControlError('INVALID_INPUT'); }
}
export function endpoint(value) {
  if (typeof value !== 'string' || value.length > 512) throw new ControlError('INVALID_INPUT');
  let url; try { url = new URL(value); } catch { throw new ControlError('INVALID_INPUT'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/api/control/v1/host-channel') throw new ControlError('INVALID_INPUT');
  return url.href;
}
export function validatePrincipal(value) {
  strictRecord(value,['actorId','viewerId','revision','enabled']);
  if (typeof value.enabled !== 'boolean') throw new ControlError('INVALID_INPUT');
  return deepFreeze({actorId:uuid(value.actorId),viewerId:opaqueToken(value.viewerId),revision:integer(value.revision,1),enabled:value.enabled});
}
export function validateProject(value) {
  strictRecord(value,['projectId','hostId','identitySha256','providerProfileIds','revision','enabled']);
  if (typeof value.enabled !== 'boolean') throw new ControlError('INVALID_INPUT');
  const ids = arrayValues(value.providerProfileIds,0,64).map(item=>uuid(item));
  if (new Set(ids).size !== ids.length) throw new ControlError('INVALID_INPUT');
  return deepFreeze({projectId:uuid(value.projectId),hostId:uuid(value.hostId),identitySha256:hex(value.identitySha256),providerProfileIds:ids,revision:integer(value.revision,1),enabled:value.enabled});
}
export function validateHost(value) {
  strictRecord(value,['hostId','hubId','requestId','generation','state','nonce','publicKey','endpoint','serverCertificateSha256','osAccountId','inventorySha256','protocolVersion','createdAtMs','expiresAtMs']);
  if (value.protocolVersion !== 1) throw new ControlError('SCHEMA_MISMATCH');
  const createdAtMs=integer(value.createdAtMs),expiresAtMs=integer(value.expiresAtMs);
  if (expiresAtMs<=createdAtMs || expiresAtMs-createdAtMs>300_000) throw new ControlError('INVALID_INPUT');
  return deepFreeze({hostId:uuid(value.hostId),hubId:uuid(value.hubId),requestId:uuid(value.requestId),generation:integer(value.generation,1),state:enumValue(value.state,['PENDING','ACTIVE','REVOKED']),nonce:uuid(value.nonce),publicKey:publicKey(value.publicKey),endpoint:endpoint(value.endpoint),serverCertificateSha256:hex(value.serverCertificateSha256),osAccountId:uuid(value.osAccountId),inventorySha256:hex(value.inventorySha256),protocolVersion:1,createdAtMs,expiresAtMs});
}
export const grant = validateControlGrant;
export function enrollmentMessage(host) {
  host=validateHost(host);
  return deepFreeze({domain:'codexcontrol-host-enrollment-v1',hostId:host.hostId,hubId:host.hubId,requestId:host.requestId,generation:host.generation,nonce:host.nonce,publicKey:host.publicKey,endpoint:host.endpoint,serverCertificateSha256:host.serverCertificateSha256,osAccountId:host.osAccountId,inventorySha256:host.inventorySha256,protocolVersion:host.protocolVersion});
}
