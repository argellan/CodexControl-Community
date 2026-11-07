// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// Load optional workspaces on demand; never fetch provider data in the loader.
// An authority change invalidates an outstanding open before it can display data.
export function lazyWorkspace({load,create,onReady=()=>{},onPending=()=>{},onError=()=>{},invalidate=workspace=>workspace.invalidate?.()}){
 let instance=null,loading=null,epoch=0,operation=0,pending=false;
 const setPending=value=>{pending=value;onPending(value);};
 return {
  get isOpen(){return pending||Boolean(instance?.isOpen);},
  async open(...args){
   const stamp=epoch,request=++operation;setPending(true);
   try{
    if(!instance){
     loading ||= Promise.resolve().then(load).catch(error=>{loading=null;throw error;});
     const module=await loading;
     if(stamp!==epoch||request!==operation)return;
     if(!instance){instance=create(module);onReady(instance);}
    }
    if(stamp!==epoch||request!==operation)return;
    return await instance.open(...args);
   }catch(error){if(stamp===epoch&&request===operation)onError(error);}
   finally{if(request===operation)setPending(false);}
  },
  invalidate(){epoch++;operation++;setPending(false);if(instance)invalidate(instance);},
 };
}
