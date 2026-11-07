// TEST_ONLY owned recovery/revocation writer; pauses only inside its real write transaction.
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {AuthorityStore} from '../../broker/store.mjs';
import {LocalOwnerBoundary} from '../../broker/local-owner.mjs';
process.once('message',config=>{
  const original=fs.statfsSync;let store;
  try{
    const owner=LocalOwnerBoundary.open({directory:config.directory,account:config.account});
    store=AuthorityStore.open({directory:config.directory,owner,hubId:config.hubId,now:()=>config.atMs});
    let held=false;
    fs.statfsSync=(...args)=>{if(!held&&args[1]?.bigint===true){held=true;process.send({type:'WRITE_LOCK_HELD'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,600);}return original(...args);};
    if(config.kind==='RECOVER')store.bootstrap({requestId:randomUUID(),principal:{actorId:config.managerId,viewerId:'owner',revision:1,enabled:true},owner,recover:true});
    else if(config.kind==='REVOKE_GRANT')store.putGrant({requestId:randomUUID(),managerId:config.managerId,value:{...config.grant,enabled:false,grantRevision:config.grant.grantRevision+1},expectedRevision:config.grant.grantRevision});
    else throw 0;
    process.send({type:'COMMITTED',generation:store.state().generation});
  }catch{process.send?.({type:'FAILED'});process.exitCode=1;}
  finally{fs.statfsSync=original;store?.close();process.disconnect();}
});
