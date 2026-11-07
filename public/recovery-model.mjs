// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
export function bootstrapCursor(history){return history?.epoch?{epoch:history.epoch,after:history.latestSequence,recovering:false}:null;}
// Return a proposed state. The caller commits it only after EventStore ingestion
// succeeds, so a failed render/application cannot skip the undelivered page.
export function recoverPage(state,page){
 if(!state||!page||typeof page.epoch!=='string'||!Array.isArray(page.events))throw new Error('Invalid recovery page');
 if(!Number.isSafeInteger(page.nextCursor)||page.nextCursor<0||!Number.isSafeInteger(page.latestSequence)||page.latestSequence<page.nextCursor)throw new Error('Invalid recovery cursor');
 if(!page.gap&&(page.epoch!==state.epoch||page.nextCursor<state.after))throw new Error('Recovery cursor mismatch');
 let previous=page.gap?0:state.after;
 for(const e of page.events){if(!Number.isSafeInteger(e.journalSequence)||e.journalSequence<=previous||e.journalSequence>page.nextCursor)throw new Error('Invalid recovery sequence');previous=e.journalSequence;}
 const recovery=state.recovering||!!page.gap||!page.caughtUp;
 return {state:{epoch:page.epoch,after:page.nextCursor,recovering:!page.caughtUp},events:page.events.map(e=>recovery?{...e,delivery:'backfill'}:e),gap:page.gap||null};
}
