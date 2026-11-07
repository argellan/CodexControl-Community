import {randomUUID} from 'node:crypto';
import {ControlError} from '../lib/errors.mjs';
import {uuid,integer,strictRecord} from '../lib/privacy.mjs';
import {validateHostFrame} from '../contracts/channel.mjs';
import {publicKey} from '../contracts/authority.mjs';
import {validateOperation} from '../contracts/operations.mjs';
import {BoundedFrameChannel} from '../transport/framing.mjs';
import {acceptHostRequest} from '../transport/https-host.mjs';
const fail=code=>{throw new ControlError(code??'CONTROL_DISABLED');};
/** Broker protocol endpoint: inherited pipes, or an explicitly attached authoritative
 * HTTPS facade. Owns no listener, provider, terminal, reconnect loop or service. */
export class ControlBroker {
  #store;#connections;#key;#peers=new Set();#byHost=new Map();#limit;#closed=false;
  constructor({store,connections,brokerPublicKey,maxConnections=32}){this.#store=store;this.#connections=connections;this.#key=publicKey(brokerPublicKey);this.#limit=integer(maxConnections,1,128);}
  #attach(factory){
    if(this.#closed)fail('CLOSED');if(this.#peers.size>=this.#limit)fail('CAPACITY');
    const peer={channel:null,handle:null,hostId:null,state:'HELLO',receive:0,send:0,pending:new Map(),timer:null};
    peer.timer=setTimeout(()=>peer.channel?.close(),5000);peer.timer.unref?.();
    const onClose=()=>{clearTimeout(peer.timer);if(peer.handle)this.#connections.disconnect(peer.handle);for(const entry of peer.pending.values()){clearTimeout(entry.timer);entry.signal?.removeEventListener('abort',entry.abort);entry.reject(new ControlError('CONTROL_DISABLED'));}peer.pending.clear();this.#peers.delete(peer);if(this.#byHost.get(peer.hostId)===peer)this.#byHost.delete(peer.hostId);};
    try{peer.channel=factory({validate:validateHostFrame,onMessage:frame=>this.#receive(peer,frame),onClose});}
    catch(error){clearTimeout(peer.timer);throw error;}
    if(!peer.channel){clearTimeout(peer.timer);return null;}
    this.#peers.add(peer);return peer.channel;
  }
  acceptHttp(req,res){
    // Saturating an untrusted HTTP endpoint must not throw into the observer's
    // request event handler. The caller retains its independently owned server.
    if(this.#closed||this.#peers.size>=this.#limit){try{req.pause();res.writeHead(503,{'Content-Length':'0','Connection':'close','Cache-Control':'no-store'});res.end();}catch{req.destroy();res.destroy();}return null;}
    return this.#attach(options=>acceptHostRequest(req,res,options));
  }
  attachInheritedPipe(input){strictRecord(input,['readable','writable']);return this.#attach(options=>new BoundedFrameChannel({...input,...options}));}
  #send(peer,type,body){return peer.channel.send(validateHostFrame({version:1,sequence:++peer.send,type,body}));}
  async #receive(peer,frame){
    if(frame.sequence!==++peer.receive)fail('STALE_CONTEXT');
    if(peer.state==='HELLO'){
      if(frame.type!=='HELLO')fail();
      const challenge=this.#connections.challenge(frame.body);peer.hostId=challenge.hostId;peer.challengeId=challenge.challengeId;peer.state='AUTH';await this.#send(peer,'CHALLENGE',challenge);return;
    }
    if(peer.state==='AUTH'){
      if(frame.type!=='AUTH'||frame.body.challengeId!==peer.challengeId)fail();
      const handle=this.#connections.authenticate(frame.body);peer.handle=handle;this.#connections.bindTransport(handle,()=>peer.channel.close());
      const snapshot=this.#connections.check(handle);peer.state='READY';clearTimeout(peer.timer);this.#byHost.set(snapshot.hostId,peer);
      await this.#send(peer,'READY',{...snapshot,brokerPublicKey:this.#key,authorityGeneration:this.#store.state().generation});return;
    }
    if(peer.state==='REVOKING'){
      if(frame.type!=='REVOKED'||frame.body.hostId!==peer.hostId)fail();
      this.#connections.acknowledgeRevocation(peer.handle,frame.body.generation);peer.state='REVOKED';return;
    }
    if(peer.state!=='READY'||frame.type!=='VALIDATED')fail();
    this.#connections.check(peer.handle);
    const response=frame.body,entry=peer.pending.get(response.requestId);
    if(!entry||response.operationId!==entry.operationId||response.assertionId!==entry.assertionId)fail('STALE_CONTEXT');
    peer.pending.delete(response.requestId);clearTimeout(entry.timer);entry.signal?.removeEventListener('abort',entry.abort);entry.resolve(response);
  }
  connectionFor(hostId){const peer=this.#byHost.get(uuid(hostId));if(!peer||peer.state!=='READY')fail();this.#connections.check(peer.handle);return peer.handle;}
  checkHost(input){
    strictRecord(input,['assertion','operation','stage','signal'],['assertion','operation','stage']);
    const operation=validateOperation(input.operation),peer=this.#byHost.get(operation.target.hostId);
    if(!peer||peer.state!=='READY')return Promise.reject(new ControlError('CONTROL_DISABLED'));
    const current=this.#connections.check(peer.handle);if(current.connectionEpoch!==operation.context.connectionEpoch)fail('STALE_CONTEXT');
    if(peer.pending.size>=32)fail('CAPACITY');
    const requestId=randomUUID();
    const frame=validateHostFrame({version:1,sequence:peer.send+1,type:'VALIDATE',body:{requestId,assertion:input.assertion,operation,stage:input.stage}});
    return new Promise((resolve,reject)=>{
      const entry={resolve,reject,operationId:operation.operationId,assertionId:frame.body.assertion.body.assertionId,signal:input.signal,timer:null,abort:null};
      const stop=()=>{if(!peer.pending.has(requestId))return;peer.pending.delete(requestId);clearTimeout(entry.timer);entry.signal?.removeEventListener('abort',entry.abort);reject(new ControlError('CONTROL_DISABLED'));peer.channel.close();};
      entry.abort=stop;entry.timer=setTimeout(stop,5000);entry.timer.unref?.();peer.pending.set(requestId,entry);
      if(entry.signal){if(entry.signal.aborted){stop();return;}entry.signal.addEventListener('abort',stop,{once:true});}
      this.#send(peer,'VALIDATE',frame.body).catch(stop);
    });
  }
  async notifyRevocation(hostId){
    hostId=uuid(hostId);const host=this.#store.host(hostId);if(!host||host.state!=='REVOKED')fail();
    const peer=this.#byHost.get(hostId);this.#connections.revoke(hostId);if(!peer)return this.#connections.enforcement(hostId);
    for(const entry of peer.pending.values()){clearTimeout(entry.timer);entry.signal?.removeEventListener('abort',entry.abort);entry.reject(new ControlError('CONTROL_DISABLED'));}peer.pending.clear();
    peer.state='REVOKING';await this.#send(peer,'REVOKE',{hostId,generation:host.generation,authorityGeneration:this.#store.state().generation});
    return this.#connections.enforcement(hostId);
  }
  close(){if(this.#closed)return;this.#closed=true;for(const peer of [...this.#peers])peer.channel.close();this.#connections.close();}
  status(){return {connections:this.#peers.size,authenticated:this.#byHost.size,connectionLimit:this.#limit,nativeExecutionAllowed:false};}
}
