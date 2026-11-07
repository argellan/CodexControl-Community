import {randomUUID} from 'node:crypto';
import {ControlError} from '../lib/errors.mjs';
import {strictRecord,uuid,integer,opaqueToken,enumValue,arrayValues,deepFreeze,canonicalJson} from '../lib/privacy.mjs';
import {validateOperation} from '../contracts/operations.mjs';
import {hex,publicKey,metadataDigest} from '../contracts/authority.mjs';
import {signMetadata,verifyMetadata,signatureBytes} from '../host/enrollment.mjs';
import {BoundedFrameChannel} from '../transport/framing.mjs';
import {assertionBody} from './authority.mjs';
const fail=code=>{throw new ControlError(code??'CONTROL_DISABLED');};
const stages=['ADMISSION','DISPATCH','PUBLICATION'];
function scope(value){if(value===null)return null;return arrayValues(value,0,64).map(item=>{if(typeof item!=='string'||!item.length||item.length>160||/[\x00-\x1f\x7f]/.test(item))fail('INVALID_INPUT');return item;});}
function actorBody(value){
  strictRecord(value,['version','domain','assertionId','challengeId','hubId','audienceId','brokerEpoch','actorSessionId','viewerId','hostIds','projectIds','authenticatedAtMs','checkedAtMs','expiresAtMs','operationSha256','stage']);
  const checkedAtMs=integer(value.checkedAtMs),expiresAtMs=integer(value.expiresAtMs),authenticatedAtMs=integer(value.authenticatedAtMs);
  if(value.version!==1||value.domain!=='codexcontrol-hub-actor-v1'||expiresAtMs<=checkedAtMs||expiresAtMs-checkedAtMs>3000||authenticatedAtMs>checkedAtMs)fail('INVALID_INPUT');
  return deepFreeze({version:1,domain:value.domain,assertionId:uuid(value.assertionId),challengeId:uuid(value.challengeId),hubId:uuid(value.hubId),audienceId:uuid(value.audienceId),brokerEpoch:uuid(value.brokerEpoch),actorSessionId:uuid(value.actorSessionId),viewerId:opaqueToken(value.viewerId),hostIds:scope(value.hostIds),projectIds:scope(value.projectIds),authenticatedAtMs,checkedAtMs,expiresAtMs,operationSha256:hex(value.operationSha256),stage:enumValue(value.stage,stages)});
}
function packet(value){strictRecord(value,['body','signature']);signatureBytes(value.signature);return deepFreeze({body:actorBody(value.body),signature:value.signature});}
function validateActorFrame(value){
  strictRecord(value,['version','sequence','type','body']);if(value.version!==1)fail('SCHEMA_MISMATCH');
  const type=enumValue(value.type,['CHECK_ACTOR','ACTOR','DENIED']);let body;
  if(type==='CHECK_ACTOR'){
    const b=value.body;strictRecord(b,['requestId','credential','hubId','audienceId','brokerEpoch','operation','stage']);
    if(typeof b.credential!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(b.credential))fail('INVALID_INPUT');
    body={requestId:uuid(b.requestId),credential:b.credential,hubId:uuid(b.hubId),audienceId:uuid(b.audienceId),brokerEpoch:uuid(b.brokerEpoch),operation:validateOperation(b.operation),stage:enumValue(b.stage,stages)};
  }else if(type==='ACTOR'){strictRecord(value.body,['requestId','packet']);body={requestId:uuid(value.body.requestId),packet:packet(value.body.packet)};}
  else{strictRecord(value.body,['requestId']);body={requestId:uuid(value.body.requestId)};}
  return deepFreeze({version:1,sequence:integer(value.sequence,1),type,body});
}
/** Hub side of a private inherited pipe. Fresh live-cookie checks occur for
 * each operation phase. Tokens cross only this RAM-only owned pipe, never TLS
 * host frames, operation metadata, errors, logs, hashes or archive records. */
export class ActorAssertionIssuer {
  #identities;#key;#hubId;#now;#channels=new Set();
  constructor({identities,privateKey,hubId,now=Date.now}){this.#identities=identities;this.#key=privateKey;this.#hubId=uuid(hubId);this.#now=now;}
  attachInheritedPipe(input){
    strictRecord(input,['readable','writable']);if(this.#channels.size>=32)fail('CAPACITY');
    let receive=0,send=0,channel;
    channel=new BoundedFrameChannel({...input,validate:validateActorFrame,onClose:()=>this.#channels.delete(channel),onMessage:async frame=>{
      if(frame.sequence!==++receive||frame.type!=='CHECK_ACTOR'||frame.body.hubId!==this.#hubId)fail();
      const b=frame.body;
      try{
        const session=this.#identities.authenticate(b.credential),now=integer(this.#now());
        const body=actorBody({version:1,domain:'codexcontrol-hub-actor-v1',assertionId:randomUUID(),challengeId:b.requestId,hubId:this.#hubId,audienceId:b.audienceId,brokerEpoch:b.brokerEpoch,actorSessionId:session.sessionId,viewerId:session.viewerId,hostIds:session.hostIds,projectIds:session.projectIds,authenticatedAtMs:session.authenticatedAtMs,checkedAtMs:now,expiresAtMs:Math.min(session.expiresAtMs,now+3000),operationSha256:metadataDigest(b.operation),stage:b.stage});
        await channel.send({version:1,sequence:++send,type:'ACTOR',body:{requestId:b.requestId,packet:{body,signature:signMetadata(body,this.#key)}}});
      }catch{await channel.send({version:1,sequence:++send,type:'DENIED',body:{requestId:b.requestId}});}
    }});this.#channels.add(channel);return channel;
  }
  close(){for(const channel of [...this.#channels])channel.close();}
}
/** Broker side: exact audience/epoch/challenge/operation/phase; no cache renewal. */
export class FreshActorChecks {
  #channel;#hubId;#audience;#epoch;#key;#now;#send=0;#receive=0;#pending=new Map();#closed=false;
  constructor(options){
    strictRecord(options,['readable','writable','hubId','audienceId','brokerEpoch','hubPublicKey','now'],['readable','writable','hubId','audienceId','brokerEpoch','hubPublicKey']);
    this.#hubId=uuid(options.hubId);this.#audience=uuid(options.audienceId);this.#epoch=uuid(options.brokerEpoch);this.#key=publicKey(options.hubPublicKey);this.#now=options.now??Date.now;
    this.#channel=new BoundedFrameChannel({readable:options.readable,writable:options.writable,validate:validateActorFrame,onClose:()=>this.#stop(),onMessage:frame=>{
      if(frame.sequence!==++this.#receive||!['ACTOR','DENIED'].includes(frame.type))fail();
      const entry=this.#pending.get(frame.body.requestId);if(!entry)fail('STALE_CONTEXT');this.#pending.delete(frame.body.requestId);clearTimeout(entry.timer);
      if(frame.type==='DENIED'){entry.reject(new ControlError('CONTROL_DISABLED'));return;}
      try{const checked=this.verify(frame.body.packet,{...entry.expected,challengeId:frame.body.requestId});entry.resolve(checked);}catch(error){entry.reject(error);this.#channel.close();}
    }});
  }
  verify(value,expected){
    if(this.#closed)fail('CLOSED');
    const checked=packet(value),b=checked.body,now=integer(this.#now());
    if(!verifyMetadata(b,checked.signature,this.#key)||b.hubId!==this.#hubId||b.audienceId!==this.#audience||b.brokerEpoch!==this.#epoch||b.operationSha256!==metadataDigest(validateOperation(expected.operation))||b.stage!==expected.stage||expected.challengeId!==undefined&&b.challengeId!==expected.challengeId||b.checkedAtMs>now||b.expiresAtMs<=now)fail('STALE_CONTEXT');return checked;
  }
  check(credential,input){
    if(this.#closed)fail('CLOSED');
    strictRecord(input,['operation','stage']);const operation=validateOperation(input.operation),stage=enumValue(input.stage,stages);if(this.#pending.size>=32)fail('CAPACITY');
    const requestId=randomUUID(),frame=validateActorFrame({version:1,sequence:this.#send+1,type:'CHECK_ACTOR',body:{requestId,credential,hubId:this.#hubId,audienceId:this.#audience,brokerEpoch:this.#epoch,operation,stage}});this.#send++;
    return new Promise((resolve,reject)=>{
      const settle=()=>{const current=this.#pending.get(requestId);if(current){this.#pending.delete(requestId);clearTimeout(current.timer);current.reject(new ControlError('CONTROL_DISABLED'));}this.close();};
      const entry={resolve,reject,expected:{operation,stage},timer:setTimeout(settle,5000)};entry.timer.unref?.();this.#pending.set(requestId,entry);this.#channel.send(frame).catch(settle);
    });
  }
  #stop(){this.#closed=true;for(const entry of this.#pending.values()){clearTimeout(entry.timer);entry.reject(new ControlError('CONTROL_DISABLED'));}this.#pending.clear();}
  close(){this.#stop();this.#channel.close();}
}
/** A broker transaction may use a fresh signed actor only synchronously. */
export class BrokerActorIdentities {
  #checks;#active=null;#used=new Map();#now;
  constructor({checks,now=Date.now}){this.#checks=checks;this.#now=now;}
  run(credential,proof,expected,callback){
    if(this.#active||typeof callback!=='function')fail();const checked=this.#checks.verify(proof,expected),body=checked.body,now=integer(this.#now());
    for(const [id,until]of this.#used)if(until<=now)this.#used.delete(id);
    if(this.#used.has(body.assertionId))fail('CONFLICT');if(this.#used.size>=256)fail('CAPACITY');
    this.#used.set(body.assertionId,body.expiresAtMs);this.#active={credential,body};
    try{const result=callback();if(result&&typeof result.then==='function')fail('INVALID_INPUT');return result;}finally{this.#active=null;}
  }
  authenticate(credential,{recent=false}={}){
    const active=this.#active,now=integer(this.#now());if(!active||credential!==active.credential||active.body.checkedAtMs>now||active.body.expiresAtMs<=now||recent&&now-active.body.authenticatedAtMs>300_000)fail();
    const b=active.body;return deepFreeze({viewerId:b.viewerId,sessionId:b.actorSessionId,authenticatedAtMs:b.authenticatedAtMs,expiresAtMs:b.expiresAtMs,hostIds:b.hostIds,projectIds:b.projectIds});
  }
  close(){this.#active=null;this.#used.clear();}
}
/** Optional broker adapter. Every issue/consume awaits a NEW hub assertion,
 * then performs its local grant/host/journal-authority checks synchronously. */
export class ActorCheckedAuthority {
  #authority;#identities;#checks;#pending=new Map();#now;#issuing=0;
  constructor({authority,identities,checks,now=Date.now}){this.#authority=authority;this.#identities=identities;this.#checks=checks;this.#now=now;}
  async issue(credential,input){
    strictRecord(input,['operation','stage','connection']);const operation=validateOperation(input.operation),stage=enumValue(input.stage,stages),expected={operation,stage};
    const connection=input.connection;for(const [id,p]of this.#pending)if(p.expiresAtMs<=integer(this.#now()))this.#pending.delete(id);if(this.#pending.size+this.#issuing>=64)fail('CAPACITY');this.#issuing++;
    try{const proof=await this.#checks.check(credential,expected);
      const result=this.#identities.run(credential,proof,expected,()=>this.#authority.issue(credential,{operation,stage,connection}));
      this.#pending.set(result.body.assertionId,{credential,packet:canonicalJson(result),expiresAtMs:result.body.expiresAtMs});return result;
    }finally{this.#issuing--;}
  }
  async consume(value){
    strictRecord(value,['body','signature']);signatureBytes(value.signature);
    const body=assertionBody(value.body),metadata=body.operation,id=body.assertionId,entry=this.#pending.get(id);if(!entry||canonicalJson(value)!==entry.packet)fail();
    const normalized=JSON.parse(entry.packet),expected={operation:metadata,stage:normalized.body.stage};
    const proof=await this.#checks.check(entry.credential,expected);
    const result=this.#identities.run(entry.credential,proof,expected,()=>this.#authority.consume(normalized));this.#pending.delete(id);return result;
  }
  close(){this.#pending.clear();this.#identities.close();this.#checks.close();}
}
