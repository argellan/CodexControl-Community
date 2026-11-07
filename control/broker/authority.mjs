import {randomUUID} from 'node:crypto';
import {ControlError} from '../lib/errors.mjs';
import {strictRecord,uuid,integer,deepFreeze,canonicalJson,enumValue} from '../lib/privacy.mjs';
import {validateOperation} from '../contracts/operations.mjs';
import {validateHost,validatePrincipal,metadataDigest,enrollmentMessage} from '../contracts/authority.mjs';
import {signMetadata,verifyMetadata,signatureBytes} from '../host/enrollment.mjs';
const fail=code=>{throw new ControlError(code??'CONTROL_DISABLED');};
export function assertionBody(input){
  strictRecord(input,['version','domain','assertionId','stage','operation','operationSha256','actorSessionId','principalRevision','grantId','hostGeneration','projectIdentitySha256','issuedAtMs','expiresAtMs']);
  const operation=validateOperation(input.operation),issuedAtMs=integer(input.issuedAtMs),expiresAtMs=integer(input.expiresAtMs);
  if(input.version!==1||input.domain!=='codexcontrol-authority-v1'||input.operationSha256!==metadataDigest(operation)||expiresAtMs<=issuedAtMs||expiresAtMs-issuedAtMs>5000||typeof input.projectIdentitySha256!=='string'||!/^[a-f0-9]{64}$/.test(input.projectIdentitySha256))fail('INVALID_INPUT');
  return deepFreeze({version:1,domain:input.domain,assertionId:uuid(input.assertionId),stage:enumValue(input.stage,['ADMISSION','DISPATCH','PUBLICATION']),operation,operationSha256:input.operationSha256,actorSessionId:uuid(input.actorSessionId),principalRevision:integer(input.principalRevision,1),grantId:uuid(input.grantId),hostGeneration:integer(input.hostGeneration,1),projectIdentitySha256:input.projectIdentitySha256,issuedAtMs,expiresAtMs});
}
export class ControlAuthority {
  #store;#identities;#connections;#key;#now;#limit;#ttl;#pending=new Map();
  constructor({store,identities,connections,privateKey,now=Date.now,assertionTtlMs=3000,maxAssertions=64}){this.#store=store;this.#identities=identities;this.#connections=connections;this.#key=privateKey;this.#now=now;this.#ttl=integer(assertionTtlMs,1,5000);this.#limit=integer(maxAssertions,1,256);}
  #actor(credential,recent=false){
    const session=this.#identities.authenticate(credential,{recent}),principal=this.#store.principalForViewer(session.viewerId);
    if(!principal?.enabled||principal.viewerId!==session.viewerId)fail();return {session,principal};
  }
  #manager(credential){const actor=this.#actor(credential,true);if(!this.#store.isManager(actor.principal.actorId))fail();return actor;}
  #managerMutation(credential){
    const actor=this.#manager(credential),state=this.#store.state();
    return {principal:actor.principal,authorize:()=>{
      const current=this.#manager(credential),latest=this.#store.state();
      if(current.session.sessionId!==actor.session.sessionId||current.principal.actorId!==actor.principal.actorId||current.principal.revision!==actor.principal.revision||latest.generation!==state.generation||latest.policyRevision!==state.policyRevision)fail('STALE_CONTEXT');
    }};
  }
  bootstrap(credential,input){
    strictRecord(input,['requestId','actorId','owner','recover'],['requestId','actorId','owner']);
    if(input.recover!==undefined&&typeof input.recover!=='boolean')fail('INVALID_INPUT');
    const session=this.#identities.authenticate(credential,{recent:true}),state=this.#store.state();
    const existing=this.#store.principalForViewer(session.viewerId);
    const principal=validatePrincipal({actorId:uuid(input.actorId),viewerId:session.viewerId,revision:existing?.revision??1,enabled:true});
    return this.#store.bootstrap({requestId:uuid(input.requestId),principal,owner:input.owner,recover:input.recover??false,authorize:()=>{const current=this.#identities.authenticate(credential,{recent:true});if(current.sessionId!==session.sessionId||current.viewerId!==session.viewerId||this.#store.state().generation!==state.generation)fail('STALE_CONTEXT');}});
  }
  putPrincipal(credential,input){strictRecord(input,['requestId','principal','expectedRevision']);const {principal,authorize}=this.#managerMutation(credential);return this.#store.putPrincipal({...input,managerId:principal.actorId,authorize});}
  putGrant(credential,input){strictRecord(input,['requestId','value','expectedRevision']);const {principal,authorize}=this.#managerMutation(credential);return this.#store.putGrant({...input,managerId:principal.actorId,authorize});}
  putProject(credential,input){strictRecord(input,['requestId','value','expectedRevision']);const {principal,authorize}=this.#managerMutation(credential);return this.#store.putProject({...input,managerId:principal.actorId,authorize});}
  beginEnrollment(credential,input){
    strictRecord(input,['requestId','hostId','expectedGeneration','publicKey','endpoint','serverCertificateSha256','osAccountId','inventorySha256']);
    const {principal,authorize}=this.#managerMutation(credential),requestId=uuid(input.requestId),hostId=uuid(input.hostId),old=this.#store.pendingHost(hostId)??this.#store.host(hostId),now=integer(this.#now());
    const previous=old?.requestId===requestId?old:null;
    const value=validateHost({hostId,hubId:this.#store.state().hubId,requestId,generation:integer(input.expectedGeneration)+1,state:'PENDING',nonce:previous?.nonce??randomUUID(),publicKey:input.publicKey,endpoint:input.endpoint,serverCertificateSha256:input.serverCertificateSha256,osAccountId:input.osAccountId,inventorySha256:input.inventorySha256,protocolVersion:1,createdAtMs:previous?.createdAtMs??now,expiresAtMs:previous?.expiresAtMs??now+120_000});
    const result=this.#store.beginEnrollment({requestId,managerId:principal.actorId,value,authorize});
    return deepFreeze({...result,current:this.#store.pendingHost(hostId)??this.#store.host(hostId)});
  }
  activateEnrollment(credential,input){
    strictRecord(input,['requestId','hostId','enrollmentRequestId','signature']);const {principal,authorize}=this.#managerMutation(credential);
    const host=this.#store.pendingHost(uuid(input.hostId))??this.#store.host(input.hostId);
    if(!host||host.requestId!==uuid(input.enrollmentRequestId)||!verifyMetadata(enrollmentMessage(host),input.signature,host.publicKey))fail();
    const result=this.#store.activateEnrollment({requestId:uuid(input.requestId),managerId:principal.actorId,hostId:host.hostId,enrollmentRequestId:host.requestId,authorize});
    this.#connections.retireSuperseded(host.hostId);return result;
  }
  revokeHost(credential,input){strictRecord(input,['requestId','hostId','expectedGeneration']);const {principal,authorize}=this.#managerMutation(credential);const result=this.#store.revokeHost({...input,managerId:principal.actorId,authorize});return deepFreeze({...result,enforcement:this.#connections.revoke(input.hostId)});}
  #check(credential,operation,handle,grantId=null){
    const now=integer(this.#now()),{session,principal}=this.#actor(credential),state=this.#store.state(),host=this.#connections.check(handle),project=this.#store.project(operation.target.projectId);
    if(operation.actorId!==principal.actorId||operation.target.hostId!==host.hostId||operation.context.connectionEpoch!==host.connectionEpoch||operation.deadlineAtMs<=now||operation.createdAtMs>now+300_000)fail('STALE_CONTEXT');
    if(session.hostIds!==null&&!session.hostIds.includes(host.hostId)||session.projectIds!==null&&!session.projectIds.includes(operation.target.projectId))fail();
    if(!project?.enabled||project.hostId!==host.hostId||project.revision!==operation.context.entityRevision||operation.target.providerProfileId!==null&&!project.providerProfileIds.includes(operation.target.providerProfileId))fail('STALE_CONTEXT');
    if(operation.context.authorityGeneration!==state.generation||operation.context.policyRevision!==state.policyRevision)fail('STALE_CONTEXT');
    const grants=grantId?[this.#store.getGrant(grantId)]:this.#store.grantsFor(principal.actorId,host.hostId,project.projectId);
    const selected=grants.find(g=>g&&g.enabled&&g.actorId===principal.actorId&&g.hostId===host.hostId&&g.projectId===project.projectId&&g.actions.includes(operation.action)&&g.grantRevision===operation.context.grantRevision&&g.authorityGeneration===state.generation&&g.policyRevision===state.policyRevision&&g.createdAtMs<=now&&g.expiresAtMs>now&&(g.providerProfileId===null||g.providerProfileId===operation.target.providerProfileId)&&(g.sessionId===null||g.sessionId===operation.target.sessionId));
    if(!selected)fail();return {now,session,principal,state,host,project,grant:selected};
  }
  issue(credential,input){
    strictRecord(input,['operation','stage','connection']);const operation=validateOperation(input.operation),stage=enumValue(input.stage,['ADMISSION','DISPATCH','PUBLICATION']);
    const checked=this.#check(credential,operation,input.connection);
    for(const [id,entry]of this.#pending)if(entry.body.expiresAtMs<=checked.now)this.#pending.delete(id);
    if(this.#pending.size>=this.#limit)fail('CAPACITY');
    const body=assertionBody({version:1,domain:'codexcontrol-authority-v1',assertionId:randomUUID(),stage,operation,operationSha256:metadataDigest(operation),actorSessionId:checked.session.sessionId,principalRevision:checked.principal.revision,grantId:checked.grant.grantId,hostGeneration:checked.host.hostGeneration,projectIdentitySha256:checked.project.identitySha256,issuedAtMs:checked.now,expiresAtMs:Math.min(operation.deadlineAtMs,checked.now+this.#ttl)});
    const packet=deepFreeze({body,signature:signMetadata(body,this.#key)});
    this.#pending.set(body.assertionId,{body,credential,connection:input.connection,packet});return packet;
  }
  consume(packet){
    strictRecord(packet,['body','signature']);signatureBytes(packet.signature);const body=assertionBody(packet.body),entry=this.#pending.get(body.assertionId);
    if(!entry||canonicalJson(entry.packet)!==canonicalJson(packet))fail();
    // The write transaction is the consumption/revocation linearization point.
    // Synchronous JavaScript alone cannot exclude a second owner-local process.
    let current;
    const authorize=()=>{
      current=this.#check(entry.credential,body.operation,entry.connection,body.grantId);
      if(body.expiresAtMs<=current.now||current.now<body.issuedAtMs||body.actorSessionId!==current.session.sessionId||body.principalRevision!==current.principal.revision||body.hostGeneration!==current.host.hostGeneration||body.projectIdentitySha256!==current.project.identitySha256)fail('STALE_CONTEXT');
    };
    const receipt=this.#store.consume({assertionId:body.assertionId,actorId:body.operation.actorId,operationId:body.operation.operationId,stage:body.stage,action:body.operation.action,authorize,binding:{operationSha256:body.operationSha256,hostGeneration:body.hostGeneration,grantRevision:body.operation.context.grantRevision,policyRevision:body.operation.context.policyRevision,authorityGeneration:body.operation.context.authorityGeneration,ownershipFence:body.operation.context.ownershipFence,connectionEpoch:body.operation.context.connectionEpoch,sessionId:body.actorSessionId}});
    this.#pending.delete(body.assertionId);if(receipt.duplicate)fail('CONFLICT');
    const permitBody={version:1,domain:'codexcontrol-consumed-v1',assertionId:body.assertionId,operationSha256:body.operationSha256,stage:body.stage,connectionEpoch:body.operation.context.connectionEpoch,ownershipFence:body.operation.context.ownershipFence,hostGeneration:body.hostGeneration,consumedAtMs:current.now,expiresAtMs:body.expiresAtMs,eventId:receipt.receipt.eventId};
    return deepFreeze({body:permitBody,signature:signMetadata(permitBody,this.#key)});
  }
  close(){this.#pending.clear();}
}
