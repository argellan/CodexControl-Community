import {ControlError} from '../lib/errors.mjs';
import {strictRecord,uuid,integer} from '../lib/privacy.mjs';
import {validateHostFrame} from '../contracts/channel.mjs';
import {channelProof} from './enrollment.mjs';
import {validateHost} from '../contracts/authority.mjs';
import {BoundedFrameChannel} from '../transport/framing.mjs';
import {connectHostTransport} from '../transport/https-host.mjs';
const fail=()=>{throw new ControlError('CONTROL_DISABLED');};
/** Explicit outbound host channel only. No provider or terminal implementation. */
export class ControlHostAgent {
  #hostId;#generation;#hubId;#epoch;#key;#enrollment;#policyFor;#onReady;#onClose;#channel;#state='NEW';#receive=0;#send=0;#timer;#readyResolve;#readyReject;#ready;
  constructor(options){
    strictRecord(options,['hostId','generation','hubId','connectionEpoch','privateKey','enrollment','policyFor','onReady','onClose'],['hostId','generation','hubId','connectionEpoch','privateKey','enrollment','policyFor']);
    if(typeof options.policyFor!=='function'||options.onReady!==undefined&&typeof options.onReady!=='function'||options.onClose!==undefined&&typeof options.onClose!=='function')throw new ControlError('INVALID_INPUT');
    this.#hostId=uuid(options.hostId);this.#generation=integer(options.generation,1);this.#hubId=uuid(options.hubId);this.#epoch=uuid(options.connectionEpoch);this.#key=options.privateKey;this.#policyFor=options.policyFor;this.#onReady=options.onReady;this.#onClose=options.onClose;
    this.#enrollment=validateHost(options.enrollment);if(this.#enrollment.state!=='ACTIVE'||this.#enrollment.hostId!==this.#hostId||this.#enrollment.generation!==this.#generation||this.#enrollment.hubId!==this.#hubId)fail();
    this.#ready=new Promise((resolve,reject)=>{this.#readyResolve=resolve;this.#readyReject=reject;});this.#ready.catch(()=>{});
  }
  #options(){return {validate:validateHostFrame,onMessage:frame=>this.#receiveFrame(frame),onClose:()=>{clearTimeout(this.#timer);const wasClosed=this.#state==='CLOSED';this.#state='CLOSED';this.#readyReject(new ControlError('CONTROL_DISABLED'));if(!wasClosed)this.#onClose?.();}};}
  async connect(options){
    strictRecord(options,['endpoint','serverCertificateSha256','ca'],['endpoint','serverCertificateSha256']);
    if(options.endpoint!==this.#enrollment.endpoint||options.serverCertificateSha256!==this.#enrollment.serverCertificateSha256)fail();
    if(this.#state!=='NEW')fail();this.#state='CONNECTING';
    try{this.#channel=await connectHostTransport({...options,...this.#options()});return await this.#start();}catch{this.close();fail();}
  }
  async attachInheritedPipe(input){strictRecord(input,['readable','writable']);if(this.#state!=='NEW')fail();this.#state='CONNECTING';try{this.#channel=new BoundedFrameChannel({...input,...this.#options()});return await this.#start();}catch{this.close();fail();}}
  async #start(){
    this.#state='CHALLENGE';this.#timer=setTimeout(()=>this.close(),5000);this.#timer.unref?.();
    await this.#sendFrame('HELLO',{hostId:this.#hostId,generation:this.#generation,connectionEpoch:this.#epoch});return this.#ready;
  }
  #sendFrame(type,body){return this.#channel.send(validateHostFrame({version:1,sequence:++this.#send,type,body}));}
  async #receiveFrame(frame){
    if(frame.sequence!==++this.#receive)fail();
    const b=frame.body;
    if(this.#state==='CHALLENGE'){
      if(frame.type!=='CHALLENGE'||b.hostId!==this.#hostId||b.generation!==this.#generation||b.hubId!==this.#hubId||b.connectionEpoch!==this.#epoch)fail();
      this.#state='READY_PENDING';await this.#sendFrame('AUTH',{challengeId:b.challengeId,signature:channelProof(b,this.#key)});return;
    }
    if(this.#state==='READY_PENDING'){
      if(frame.type!=='READY'||b.hostId!==this.#hostId||b.hostGeneration!==this.#generation||b.hubId!==this.#hubId||b.connectionEpoch!==this.#epoch)fail();
      await this.#onReady?.(b);if(this.#state==='CLOSED')fail();this.#state='READY';clearTimeout(this.#timer);this.#readyResolve(b);return;
    }
    if(this.#state!=='READY')fail();
    if(frame.type==='REVOKE'){
      if(b.hostId!==this.#hostId||b.generation!==this.#generation+1)fail();this.#state='REVOKED';
      await this.#sendFrame('REVOKED',{hostId:this.#hostId,generation:b.generation,newInputDisabled:true,nativeStopConfirmed:false});return;
    }
    if(frame.type!=='VALIDATE'||b.operation.target.hostId!==this.#hostId||b.operation.context.connectionEpoch!==this.#epoch)fail();
    const policy=this.#policyFor(b.operation.target.projectId);
    const body=policy.verifyAssertion({assertion:b.assertion,operation:b.operation,stage:b.stage});
    if(this.#state!=='READY')fail();
    await this.#sendFrame('VALIDATED',{requestId:b.requestId,operationId:body.operation.operationId,assertionId:body.assertionId,status:'VALIDATED_ONLY'});
  }
  connectionState(){return {connected:this.#state==='READY',hostId:this.#hostId,hostGeneration:this.#generation,connectionEpoch:this.#epoch};}
  close(){if(this.#state==='CLOSED')return;this.#state='CLOSED';clearTimeout(this.#timer);this.#readyReject(new ControlError('CONTROL_DISABLED'));this.#channel?.close();this.#onClose?.();}
}
