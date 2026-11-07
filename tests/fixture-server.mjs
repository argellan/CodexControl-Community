// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {createServer as createObserverServer} from '../server.mjs';

// HTTP fixtures never inherit a developer's local observation sources.
export async function readSyntheticSnapshot(){
 return {observedAt:new Date().toISOString(),mode:'read-only-log-observer',host:{id:'test-only-hub',name:'TEST_ONLY synthetic hub'},hosts:[],sessions:[],events:[],coverage:{limit:128,completeHistory:false,liveRuntimeAttached:false}};
}

export function createServer({readSnapshot=readSyntheticSnapshot,...options}={}){
 return createObserverServer({...options,readSnapshot});
}
