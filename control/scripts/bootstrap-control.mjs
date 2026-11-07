import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {generateKeyPairSync} from 'node:crypto';
import {ViewerAccess} from '../../lib/viewer-access.mjs';
import {ControlError,safeControlError} from '../lib/errors.mjs';
import {strictRecord,uuid} from '../lib/privacy.mjs';
import {LocalOwnerBoundary} from '../broker/local-owner.mjs';
import {ControlIdentities} from '../broker/identity.mjs';
import {AuthorityStore} from '../broker/store.mjs';
import {HostConnections} from '../broker/host-channel.mjs';
import {ControlAuthority} from '../broker/authority.mjs';
const fail=()=>{throw new ControlError('INVALID_INPUT');};
export function parseBootstrapArguments(argv){
  if(!Array.isArray(argv)||argv.length>13)fail();const result={};
  for(let i=0;i<argv.length;i++){
    const key=argv[i];if(key==='--recover'){if(result.recover)fail();result.recover=true;continue;}
    const name={'--directory':'directory','--account':'account','--viewer-config':'viewerConfig','--hub-id':'hubId','--actor-id':'actorId','--request-id':'requestId'}[key];
    if(!name||Object.hasOwn(result,name)||typeof argv[i+1]!=='string'||argv[i+1].length>32768)fail();result[name]=argv[++i];
  }
  if(!['directory','account','viewerConfig','hubId','actorId','requestId'].every(key=>Object.hasOwn(result,key)))fail();
  if(!path.isAbsolute(result.directory)||!path.isAbsolute(result.viewerConfig)||result.account.length>128)fail();
  for(const key of ['hubId','actorId','requestId'])result[key]=uuid(result[key]);return result;
}
/** Owner-local bootstrap only. Credentials enter stdin, never arguments/environment/logs. */
export async function bootstrapControl(options,input){
  strictRecord(options,['directory','account','viewerConfig','hubId','actorId','requestId','recover'],['directory','account','viewerConfig','hubId','actorId','requestId']);
  strictRecord(input,['username','password']);
  if(typeof input.username!=='string'||input.username.length>64||typeof input.password!=='string'||Buffer.byteLength(input.password)>512)fail();
  const owner=LocalOwnerBoundary.open({directory:options.directory,account:options.account});
  const configOwner=LocalOwnerBoundary.open({directory:path.dirname(options.viewerConfig),account:options.account});
  const bytes=configOwner.readPrivateFile(options.viewerConfig);
  let config;try{config=JSON.parse(bytes.toString('utf8'));}catch{fail();}finally{bytes.fill(0);}
  // The operator explicitly selects the existing installation's named accounts;
  // no provider config, account login or credential import is performed.
  if(!Array.isArray(config.viewers))fail();
  const access=new ViewerAccess({viewers:config.viewers}),viewer=await access.authenticatePassword(input.username,input.password);
  if(!viewer?.username||viewer.passwordEnabled!==true)throw new ControlError('CONTROL_DISABLED');
  const identities=new ControlIdentities({getViewerAccess:()=>access});let store,connections,authority;
  try{
    const session=await identities.reauthenticate({cookie:access.issueCookie(viewer),username:input.username,password:input.password});
    store=AuthorityStore.open({directory:options.directory,owner,hubId:uuid(options.hubId)});connections=new HostConnections({store});
    authority=new ControlAuthority({store,identities,connections,privateKey:generateKeyPairSync('ed25519').privateKey});
    return authority.bootstrap(session.credential,{requestId:uuid(options.requestId),actorId:uuid(options.actorId),owner,recover:options.recover??false});
  }finally{authority?.close();connections?.close();identities.close();store?.close();}
}
async function stdin(){const chunks=[];let total=0;for await(const chunk of process.stdin){total+=chunk.length;if(total>2048){for(const bytes of chunks)bytes.fill(0);fail();}chunks.push(chunk);}const bytes=Buffer.concat(chunks);for(const chunk of chunks)chunk.fill(0);try{return JSON.parse(bytes.toString('utf8'));}finally{bytes.fill(0);}}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{const options=parseBootstrapArguments(process.argv.slice(2)),result=await bootstrapControl(options,await stdin());console.log(JSON.stringify(result));}
  catch(error){console.error(JSON.stringify(safeControlError(error)));process.exitCode=1;}
}
