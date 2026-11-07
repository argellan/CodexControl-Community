import {ControlError,CONTROL_ERROR_CODES} from '../lib/errors.mjs';
import {strictRecord,uuid,integer,enumValue,deepFreeze} from '../lib/privacy.mjs';
import {publicKey} from './authority.mjs';
import {validateOperation} from './operations.mjs';
import {assertionBody} from '../broker/authority.mjs';
import {challengeBody,signatureBytes} from '../host/enrollment.mjs';
export function validateHostFrame(value){
  strictRecord(value,['version','sequence','type','body']);
  if(value.version!==1)throw new ControlError('SCHEMA_MISMATCH');
  const type=enumValue(value.type,['HELLO','CHALLENGE','AUTH','READY','VALIDATE','VALIDATED','REVOKE','REVOKED','ERROR']);
  const b=value.body;let body;
  switch(type){
    case 'HELLO':strictRecord(b,['hostId','generation','connectionEpoch']);body={hostId:uuid(b.hostId),generation:integer(b.generation,1),connectionEpoch:uuid(b.connectionEpoch)};break;
    case 'CHALLENGE':body=challengeBody(b);break;
    case 'AUTH':strictRecord(b,['challengeId','signature']);signatureBytes(b.signature);body={challengeId:uuid(b.challengeId),signature:b.signature};break;
    case 'READY':strictRecord(b,['hostId','hostGeneration','connectionEpoch','hubId','brokerPublicKey','authorityGeneration']);body={hostId:uuid(b.hostId),hostGeneration:integer(b.hostGeneration,1),connectionEpoch:uuid(b.connectionEpoch),hubId:uuid(b.hubId),brokerPublicKey:publicKey(b.brokerPublicKey),authorityGeneration:integer(b.authorityGeneration,1)};break;
    case 'VALIDATE':strictRecord(b,['requestId','assertion','operation','stage']);strictRecord(b.assertion,['body','signature']);signatureBytes(b.assertion.signature);body={requestId:uuid(b.requestId),assertion:{body:assertionBody(b.assertion.body),signature:b.assertion.signature},operation:validateOperation(b.operation),stage:enumValue(b.stage,['ADMISSION','DISPATCH','PUBLICATION'])};break;
    case 'VALIDATED':strictRecord(b,['requestId','operationId','assertionId','status']);if(b.status!=='VALIDATED_ONLY')throw new ControlError('INVALID_INPUT');body={requestId:uuid(b.requestId),operationId:uuid(b.operationId),assertionId:uuid(b.assertionId),status:b.status};break;
    case 'REVOKE':strictRecord(b,['hostId','generation','authorityGeneration']);body={hostId:uuid(b.hostId),generation:integer(b.generation,1),authorityGeneration:integer(b.authorityGeneration,1)};break;
    case 'REVOKED':strictRecord(b,['hostId','generation','newInputDisabled','nativeStopConfirmed']);if(b.newInputDisabled!==true||b.nativeStopConfirmed!==false)throw new ControlError('INVALID_INPUT');body={hostId:uuid(b.hostId),generation:integer(b.generation,1),newInputDisabled:true,nativeStopConfirmed:false};break;
    case 'ERROR':strictRecord(b,['code']);body={code:enumValue(b.code,CONTROL_ERROR_CODES)};break;
  }
  return deepFreeze({version:1,sequence:integer(value.sequence,1),type,body});
}
