// Author: Bishop Crockett
// Owner: Argellan.com
// SPDX-License-Identifier: MIT
import {failure} from './installation-storage.mjs';
const methods={
 '/role/plan':['revision','role'], '/role/apply':['revision','planId'], '/rename':['revision','name','peerId'],
 '/pairing/open':['revision'], '/pairing/join':['revision','address','code','expectedId'], '/pairing/confirm':['revision','id'], '/pairing/cancel':['revision','id'], '/discovery':['revision','enabled']
};
export function createInstallationHandler({installation,administration,readJSON}={}){
 return async(req,res,url,viewer,{verifyAuthority=()=>viewer,clientKey}={})=>{
  if(!url.pathname.startsWith('/api/installation'))return false;
  const authorize=()=>{const current=verifyAuthority();if(!current||current.role!=='admin'||current.hostIds!==null||current.projectIds!==null)throw failure('Full-scope installation administrator required',403);if(!installation||!administration)throw failure('Local installation workflow unavailable',503);return current;};
  authorize();if(url.search)throw failure('Installation actions accept no query');
  const json=value=>{authorize();res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));};
  if(url.pathname==='/api/installation'&&req.method==='GET'){json(installation.state());return true;}
  if(req.method!=='POST')throw failure('Installation actions require POST',405);
  const route=url.pathname.slice('/api/installation'.length),revoke=/^\/peers\/([-a-zA-Z0-9_]{1,80})\/revoke$/.exec(route),address=/^\/peers\/([-a-zA-Z0-9_]{1,80})\/address$/.exec(route),allowed=methods[route]||(revoke?['revision']:address?['revision','address']:null);
  if(!allowed)throw failure('Unsupported installation action',404);const body=await readJSON(req,4096);if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k))||!Number.isSafeInteger(body.revision))throw failure('Invalid installation action');authorize();
  const controller=new AbortController(),disconnect=()=>{if(!res.writableEnded)controller.abort();};res.once('close',disconnect);
  try{const current=authorize(),owner=JSON.stringify([current.id,clientKey]),verify=()=>{authorize();if(controller.signal.aborted)throw failure('Installation action canceled',409);};const options={...body,owner,verifyAuthority:verify,signal:controller.signal};
   const operation=route==='/role/plan'?'planRole':route==='/role/apply'?'applyRole':route==='/rename'?'rename':route==='/pairing/open'?'openPairing':route==='/pairing/join'?'joinPairing':route==='/pairing/confirm'?'confirmPairing':route==='/pairing/cancel'?'cancelPairing':route==='/discovery'?'discover':revoke?'revoke':'updateAddress';if(revoke||address)options.peerId=(revoke||address)[1];
   let result;
   try{result=await administration.withAdministratorAuthority({actor:{id:current.id,role:current.role},verifyAuthority:authorize},()=>installation[operation](options));}
   catch(error){
    if(['joinPairing','confirmPairing','updateAddress'].includes(operation)&&[401,403].includes(error.status)){
     const refreshed=authorize();await administration.withAdministratorAuthority({actor:{id:refreshed.id,role:refreshed.role},verifyAuthority:authorize},()=>{throw failure('Protected peer authentication or identity rejected; check address, code and expiry',422);});
    }
    throw error;
   }
   json(result);return true;
  }finally{res.removeListener('close',disconnect);}
 };
}
