import {ControlError} from '../lib/errors.mjs';
import {strictRecord,uuid,integer,deepFreeze,enumValue,canonicalJson} from '../lib/privacy.mjs';
import {publicKey,hex,metadataDigest} from '../contracts/authority.mjs';
import {validateOperation} from '../contracts/operations.mjs';
import {assertionBody} from '../broker/authority.mjs';
import {signatureBytes,verifyMetadata} from './enrollment.mjs';
import {OwnershipLease} from './ownership.mjs';
import {ProjectRoot} from './project-root.mjs';
const fail=code=>{throw new ControlError(code??'CONTROL_DISABLED');};
export function permitBody(value){
  strictRecord(value,['version','domain','assertionId','operationSha256','stage','connectionEpoch','ownershipFence','hostGeneration','consumedAtMs','expiresAtMs','eventId']);
  const consumedAtMs=integer(value.consumedAtMs),expiresAtMs=integer(value.expiresAtMs);
  if(value.version!==1||value.domain!=='codexcontrol-consumed-v1'||expiresAtMs<=consumedAtMs||expiresAtMs-consumedAtMs>5000)fail('INVALID_INPUT');
  return deepFreeze({version:1,domain:value.domain,assertionId:uuid(value.assertionId),operationSha256:hex(value.operationSha256),stage:enumValue(value.stage,['ADMISSION','DISPATCH','PUBLICATION']),connectionEpoch:uuid(value.connectionEpoch),ownershipFence:integer(value.ownershipFence,1),hostGeneration:integer(value.hostGeneration,1),consumedAtMs,expiresAtMs,eventId:uuid(value.eventId)});
}
/** Current connection + held project/ownership handles; this stage has no native dispatcher. */
export class HostPolicy {
  #hostId;#generation;#projectId;#revision;#key;#root;#lease;#connection;#now;#limit;#used=new Map();#closed=false;
  constructor(options){
    strictRecord(options,['hostId','hostGeneration','projectId','entityRevision','brokerPublicKey','root','lease','connection','now','maxConsumed'],['hostId','hostGeneration','projectId','entityRevision','brokerPublicKey','root','lease','connection']);
    const {hostId,hostGeneration,projectId,entityRevision,brokerPublicKey,root,lease,connection,now=Date.now,maxConsumed=256}=options;
    if(!(root instanceof ProjectRoot)||!(lease instanceof OwnershipLease)||typeof connection!=='function'||typeof now!=='function')fail('INVALID_INPUT');
    this.#hostId=uuid(hostId);this.#generation=integer(hostGeneration,1);this.#projectId=uuid(projectId);this.#revision=integer(entityRevision,1);this.#key=publicKey(brokerPublicKey);this.#root=root;this.#lease=lease;this.#connection=connection;this.#now=now;this.#limit=integer(maxConsumed,1,1024);
  }
  #check(operation){
    if(this.#closed)fail('CLOSED');
    const connection=this.#connection();strictRecord(connection,['connected','hostId','hostGeneration','connectionEpoch']);
    if(connection.connected!==true||connection.hostId!==this.#hostId||connection.hostGeneration!==this.#generation||connection.connectionEpoch!==operation.context.connectionEpoch||operation.target.hostId!==this.#hostId||operation.target.projectId!==this.#projectId||operation.context.entityRevision!==this.#revision)fail('STALE_CONTEXT');
    const lease=this.#lease.assertCurrent(),root=this.#root.assertCurrent();
    if(lease.resourceId!==this.#projectId||lease.connectionEpoch!==connection.connectionEpoch||lease.fence!==operation.context.ownershipFence)fail('STALE_CONTEXT');
    return {root,now:integer(this.#now())};
  }
  verifyAssertion(input){
    strictRecord(input,['assertion','operation','stage']);strictRecord(input.assertion,['body','signature']);signatureBytes(input.assertion.signature);
    const operation=validateOperation(input.operation),body=assertionBody(input.assertion.body),stage=enumValue(input.stage,['ADMISSION','DISPATCH','PUBLICATION']);
    const {root,now}=this.#check(operation);
    if(!verifyMetadata(body,input.assertion.signature,this.#key)||body.stage!==stage||body.operationSha256!==metadataDigest(operation)||canonicalJson(body.operation)!==canonicalJson(operation)||body.hostGeneration!==this.#generation||body.projectIdentitySha256!==root.sha256||body.expiresAtMs<=now||body.issuedAtMs>now||operation.deadlineAtMs<=now)fail('STALE_CONTEXT');
    return body;
  }
  acceptPermit(input){
    strictRecord(input,['assertion','permit','operation','stage']);
    const body=this.verifyAssertion({assertion:input.assertion,operation:input.operation,stage:input.stage});
    strictRecord(input.permit,['body','signature']);signatureBytes(input.permit.signature);
    const permit=permitBody(input.permit.body),{now}=this.#check(body.operation);
    if(!verifyMetadata(permit,input.permit.signature,this.#key)||permit.assertionId!==body.assertionId||permit.stage!==body.stage||permit.operationSha256!==body.operationSha256||permit.connectionEpoch!==body.operation.context.connectionEpoch||permit.ownershipFence!==body.operation.context.ownershipFence||permit.hostGeneration!==body.hostGeneration||permit.expiresAtMs!==body.expiresAtMs||permit.consumedAtMs<body.issuedAtMs||permit.consumedAtMs>now||permit.expiresAtMs<=now)fail('STALE_CONTEXT');
    for(const [id,until]of this.#used)if(until<=now)this.#used.delete(id);
    if(this.#used.has(body.assertionId))fail('CONFLICT');if(this.#used.size>=this.#limit)fail('CAPACITY');
    // Final synchronous host gate; later native adapters must consume here with no intervening await.
    this.#check(body.operation);this.#used.set(body.assertionId,permit.expiresAtMs);
    return deepFreeze({operationId:body.operation.operationId,assertionId:body.assertionId,eventId:permit.eventId,stage:body.stage,authorized:true,nativeExecutionAllowed:false,ownershipFence:permit.ownershipFence,connectionEpoch:permit.connectionEpoch});
  }
  dispatchLifecycle(input){
    strictRecord(input,['assertion','permit','operation','stage']);
    const operation=validateOperation(input.operation);
    if(input.stage!=='DISPATCH'||!['runtime.launch','runtime.stop','session.create','session.resume','turn.start','turn.steer','turn.interrupt'].includes(operation.action))fail('CONTROL_DISABLED');
    this.acceptPermit(input);this.#check(operation);
  }
  close(){this.#closed=true;this.#used.clear();}
}
