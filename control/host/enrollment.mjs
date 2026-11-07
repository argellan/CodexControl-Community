import {createPublicKey,sign,verify} from 'node:crypto';
import {ControlError} from '../lib/errors.mjs';
import {strictRecord,canonicalJson,deepFreeze,uuid,integer} from '../lib/privacy.mjs';
import {publicKey,enrollmentMessage} from '../contracts/authority.mjs';
export function signatureBytes(value) {
  if(typeof value!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(value))throw new ControlError('INVALID_INPUT');
  const bytes=Buffer.from(value,'base64');
  if(bytes.length!==64||bytes.toString('base64')!==value)throw new ControlError('INVALID_INPUT');
  return bytes;
}
export function signMetadata(body,key) {
  try{return sign(null,Buffer.from(canonicalJson(body)),key).toString('base64');}
  catch{throw new ControlError('CONTROL_DISABLED');}
}
export function verifyMetadata(body,signature,key) {
  try{return verify(null,Buffer.from(canonicalJson(body)),createPublicKey({key:Buffer.from(publicKey(key),'base64'),format:'der',type:'spki'}),signatureBytes(signature));}
  catch{throw new ControlError('CONTROL_DISABLED');}
}
export function enrollmentProof(host,privateKey) {return signMetadata(enrollmentMessage(host),privateKey);}
export function challengeBody(value) {
  strictRecord(value,['version','domain','challengeId','hubId','hostId','generation','connectionEpoch','nonce','issuedAtMs','expiresAtMs']);
  const issuedAtMs=integer(value.issuedAtMs),expiresAtMs=integer(value.expiresAtMs);
  if(value.version!==1||value.domain!=='codexcontrol-host-channel-v1'||expiresAtMs<=issuedAtMs||expiresAtMs-issuedAtMs>5000)throw new ControlError('INVALID_INPUT');
  return deepFreeze({version:1,domain:value.domain,challengeId:uuid(value.challengeId),hubId:uuid(value.hubId),hostId:uuid(value.hostId),generation:integer(value.generation,1),connectionEpoch:uuid(value.connectionEpoch),nonce:uuid(value.nonce),issuedAtMs,expiresAtMs});
}
/** Host generated key stays local; only this short proof crosses authenticated TLS. */
export function channelProof(challenge,privateKey){return signMetadata(challengeBody(challenge),privateKey);}
