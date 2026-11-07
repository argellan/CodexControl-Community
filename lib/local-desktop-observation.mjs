// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
import path from 'node:path';
import {createCodexAccountObserver} from './codex-account-observer.mjs';
import {createDesktopCompanionObserver,saveCompanion} from './desktop-companion.mjs';

// The desktop Hub observes its own account and selected Dot directly. It does
// not require a second collector or a server-side copy of the user's account.
export function createLocalDesktopObservation(configuration,{directory,hostId,storageAdmission,accountFactory=createCodexAccountObserver,companionFactory=createDesktopCompanionObserver,publishCompanion=saveCompanion}={}){
 const account=accountFactory(configuration.accountObserver),companion=companionFactory(configuration.desktopCompanion,{directory:path.join(directory,'local-companion-cache')});
 let closed=false,pollWork=null,closeWork=null;
 const metadata=()=>companion?.sample()??null;
 return {
  hostId,metadata,
  async read(source){
   const local=await source();
   if(closed)return local;
   const accountUsage=account?.sample();
   if(companion&&!pollWork)pollWork=Promise.resolve(companion.poll((value,artwork)=>publishCompanion(path.join(directory,'desktop-companions',hostId),value,artwork,{storageAdmission}))).catch(()=>{}).finally(()=>{pollWork=null;});
   const desktopCompanion=metadata();
   return {...local,...(accountUsage?{accountUsage}:{}),...(desktopCompanion?{desktopCompanion}:{})};
  },
  committed(local){if(local.accountUsage?.nativeAnalytics?.digest)account?.acknowledgeAnalytics(local.accountUsage.nativeAnalytics.digest);},
  close(){if(closeWork)return closeWork;closed=true;account?.stop();closeWork=Promise.allSettled([account?.inFlight,pollWork]);return closeWork;}
 };
}
