// TEST_ONLY real isolated hub actor issuer; private key/password/cookie stay in RAM.
import {generateKeyPairSync} from 'node:crypto';
import {ViewerAccess} from '../../../lib/viewer-access.mjs';
import {ControlIdentities} from '../../broker/identity.mjs';
import {ActorAssertionIssuer} from '../../broker/actor-channel.mjs';
import {password} from './authority-fixture.mjs';
let issuer,identities,access,cookie;
process.once('message',async config=>{
  try{
    access=new ViewerAccess({viewers:config.users});const viewer=await access.authenticatePassword('alice',password);cookie=access.issueCookie(viewer);
    identities=new ControlIdentities({getViewerAccess:()=>access});const session=await identities.reauthenticate({cookie,username:'alice',password});
    const key=generateKeyPairSync('ed25519');issuer=new ActorAssertionIssuer({identities,privateKey:key.privateKey,hubId:config.hubId});
    issuer.attachInheritedPipe({readable:process.stdin,writable:process.stdout});
    process.send({type:'READY',credential:session.credential,publicKey:key.publicKey.export({format:'der',type:'spki'}).toString('base64')});
    process.on('message',message=>{if(message.type==='LOGOUT'){access.revokeCookie(cookie);process.send({type:'LOGGED_OUT'});}if(message.type==='CLOSE'){issuer.close();identities.close();process.disconnect();}});
  }catch{process.send?.({type:'FAILED'});process.exitCode=1;process.disconnect?.();}
});
