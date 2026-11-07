import {randomUUID} from 'node:crypto';
import {ControlError} from '../lib/errors.mjs';
import {strictRecord,uuid,integer,deepFreeze} from '../lib/privacy.mjs';
import {challengeBody,verifyMetadata} from '../host/enrollment.mjs';
const fail=()=>{throw new ControlError('CONTROL_DISABLED');};
/** Broker-owned connection handles; browser supplied identity objects are never handles. */
export class HostConnections {
  #store;#now;#limit;#pending=new Map();#active=new Map();#handles=new WeakMap();#enforcement=new Map();
  constructor({store,now=Date.now,maxConnections=32}){this.#store=store;this.#now=now;this.#limit=integer(maxConnections,1,128);}
  challenge(input){
    strictRecord(input,['hostId','generation','connectionEpoch']);
    const host=this.#store.host(uuid(input.hostId)),now=integer(this.#now());
    if(!host||host.state!=='ACTIVE'||host.generation!==integer(input.generation,1))fail();
    this.retireSuperseded(host.hostId);
    for(const [id,c]of this.#pending)if(c.expiresAtMs<=now)this.#pending.delete(id);
    if(this.#pending.size+this.#active.size>=this.#limit)throw new ControlError('CAPACITY');
    const challenge=challengeBody({version:1,domain:'codexcontrol-host-channel-v1',challengeId:randomUUID(),hubId:host.hubId,hostId:host.hostId,generation:host.generation,connectionEpoch:uuid(input.connectionEpoch),nonce:randomUUID(),issuedAtMs:now,expiresAtMs:now+5000});
    this.#pending.set(challenge.challengeId,challenge);return challenge;
  }
  authenticate(input){
    strictRecord(input,['challengeId','signature']);
    const id=uuid(input.challengeId),challenge=this.#pending.get(id);this.#pending.delete(id);
    const now=integer(this.#now());if(!challenge||now<challenge.issuedAtMs||now>=challenge.expiresAtMs)fail();
    const host=this.#store.host(challenge.hostId);
    if(!host||host.state!=='ACTIVE'||host.generation!==challenge.generation||!verifyMetadata(challenge,input.signature,host.publicKey))fail();
    // Same-generation owners cannot replace one another. A durable rotation
    // has already invalidated the old credential and retires only that peer.
    this.retireSuperseded(host.hostId);
    if(this.#active.has(host.hostId))throw new ControlError('CONFLICT');
    const handle=Object.freeze({id:randomUUID()}),record={...challenge,connected:true};
    this.#handles.set(handle,record);this.#active.set(host.hostId,handle);return handle;
  }
  check(handle){
    const record=this.#handles.get(handle);if(!record?.connected)fail();
    const host=this.#store.host(record.hostId);
    if(!host||host.state!=='ACTIVE'||host.generation!==record.generation)fail();
    return deepFreeze({hostId:host.hostId,hostGeneration:host.generation,connectionEpoch:record.connectionEpoch,hubId:host.hubId});
  }
  bindTransport(handle,retire){const record=this.#handles.get(handle);if(!record?.connected||typeof retire!=='function')fail();record.retire=retire;}
  retireSuperseded(hostId){
    hostId=uuid(hostId);const host=this.#store.host(hostId),handle=this.#active.get(hostId),record=handle&&this.#handles.get(handle);
    if(host?.state==='ACTIVE'&&record&&record.generation<host.generation){const retire=record.retire;record.retire=null;this.disconnect(handle);try{retire?.();}catch{}return true;}return false;
  }
  disconnect(handle){const record=this.#handles.get(handle);if(!record)return;record.connected=false;if(this.#active.get(record.hostId)===handle)this.#active.delete(record.hostId);const state=this.#enforcement.get(record.hostId);if(state?.status==='PENDING')state.status='UNREACHABLE';}
  revoke(hostId){hostId=uuid(hostId);const host=this.#store.host(hostId);if(!host||host.state!=='REVOKED')fail();this.#enforcement.set(hostId,{generation:host.generation,status:this.#active.has(hostId)?'PENDING':'UNREACHABLE'});return this.enforcement(hostId);}
  acknowledgeRevocation(handle,generation){const record=this.#handles.get(handle),host=record&&this.#store.host(record.hostId);if(!record?.connected||!host||host.state!=='REVOKED'||host.generation!==integer(generation,1)||host.generation!==record.generation+1)fail();this.#enforcement.set(host.hostId,{generation,status:'ACKNOWLEDGED_NEW_INPUT_DISABLED'});return this.enforcement(host.hostId);}
  enforcement(hostId){const host=this.#store.host(uuid(hostId));if(!host)fail();const current=this.#enforcement.get(hostId);return deepFreeze({hostId,generation:host.generation,status:current?.generation===host.generation?current.status:host.state==='REVOKED'?'UNKNOWN_AFTER_RESTART':'NO_REVOCATION_PENDING',nativeStopConfirmed:false});}
  close(){for(const handle of this.#active.values())this.disconnect(handle);this.#pending.clear();}
}
