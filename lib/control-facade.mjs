import {ControlError} from '../control/lib/errors.mjs';
import {strictRecord,deepFreeze} from '../control/lib/privacy.mjs';
import {foundationCapabilities} from '../control/contracts/capabilities.mjs';
import {validateOperation} from '../control/contracts/operations.mjs';
import {types} from 'node:util';
const disabled=Object.freeze({enabled:false,stage:'DISABLED',nativeExecutionAllowed:false,capabilities:foundationCapabilities()});
/** Explicit installation seam only. server.mjs and the observer do not import it. */
export function createControlFacade(options={}){
  strictRecord(options,['enabled','authority','journal','identities','hostCheck'],[]);
  if(options.enabled===undefined||options.enabled===false)return Object.freeze({identity:()=>disabled});
  if(options.enabled!==true||!options.authority||!options.journal||!options.identities||typeof options.hostCheck!=='function')throw new ControlError('INVALID_INPUT');
  const {authority,journal,identities,hostCheck}=options;
  const promised=value=>value&&typeof value.then==='function';
  function checkPublicationActor(credential,assertion){
    const actor=identities.authenticate(credential),operation=assertion.body.operation;
    if(actor.sessionId!==assertion.body.actorSessionId||actor.hostIds!==null&&!actor.hostIds.includes(operation.target.hostId)||actor.projectIds!==null&&!actor.projectIds.includes(operation.target.projectId))throw new ControlError('CONTROL_DISABLED');
  }
  let active=0;
  async function checkHost(input){
    if(active>=32)throw new ControlError('CAPACITY');active++;
    const controller=new AbortController();
    let timer;
    // A hung trusted handler retains its slot until it settles; repeated timeouts
    // cannot create an unbounded collection of abandoned callback promises.
    const pending=Promise.resolve().then(()=>hostCheck({...input,signal:controller.signal}));
    pending.finally(()=>{active--;clearTimeout(timer);}).catch(()=>{});
    try{return await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ControlError('EXPIRED'));},5000);timer.unref?.();})]);}
    catch{throw new ControlError('CONTROL_DISABLED');}
  }
  return Object.freeze({
    identity(){return deepFreeze({enabled:true,controlProtocolVersion:1,stage:'AUTHORITY_TRANSPORT_ONLY',nativeExecutionAllowed:false,providerRuntime:'UNAVAILABLE',terminal:'UNAVAILABLE'});},
    reauthenticate(input){return identities.reauthenticate(input);},
    logout(credential){return identities.logout(credential);},
    async authorize(input){
      strictRecord(input,['credential','operation','connection','stage']);const {credential,connection,stage}=input,operation=validateOperation(input.operation);
      let assertion=authority.issue(credential,{operation,connection,stage});if(promised(assertion))assertion=await assertion;
      await checkHost({assertion,operation,stage});
      // Rechecks named login/logout/scope/grant/enrollment after the awaited host hop.
      let permit=authority.consume(assertion);if(promised(permit))permit=await permit;
      return Object.freeze({assertion,permit});
    },
    async admit(input){
      strictRecord(input,['credential','operation','connection']);const {credential,connection}=input,operation=validateOperation(input.operation);
      let assertion=authority.issue(credential,{operation,connection,stage:'ADMISSION'});if(promised(assertion))assertion=await assertion;
      await checkHost({assertion,operation,stage:'ADMISSION'});
      const consumed=authority.consume(assertion);if(promised(consumed))await consumed;
      return journal.admit(operation);
    },
    async publish(input){
      strictRecord(input,['credential','operation','connection','write']);
      const {credential,connection,write}=input,operation=validateOperation(input.operation);
      if(typeof write!=='function'||types.isProxy(write)||types.isAsyncFunction(write))throw new ControlError('INVALID_INPUT');
      let assertion=authority.issue(credential,{operation,connection,stage:'PUBLICATION'});if(promised(assertion))assertion=await assertion;
      await checkHost({assertion,operation,stage:'PUBLICATION'});
      let permit=authority.consume(assertion);if(promised(permit))permit=await permit;
      checkPublicationActor(credential,assertion);
      // The owned HTTP/stream writer is synchronous. No awaited work separates
      // current authority consumption from publication of sensitive bytes.
      const result=write({operationId:operation.operationId,permit});
      if(result&&typeof result.then==='function')throw new ControlError('INVALID_INPUT');
      return Object.freeze({operationId:operation.operationId,published:true});
    },
    status(){return Object.freeze({activeHostChecks:active,maxHostChecks:32,nativeExecutionAllowed:false});
    }
  });
}
