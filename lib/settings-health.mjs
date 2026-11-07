// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {archiveStatus} from './usage-archive.mjs';

const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;
const states=new Set(['online','stale','disconnected','disabled','expired','not connected']);

// Requested only by the authenticated administrator's diagnostics flow. Never
// scan source files, launch a runtime, copy event bodies, or add background work.
export function collectionHealth(snapshot){
 const hosts=Array.isArray(snapshot?.hosts)?snapshot.hosts:[];
 return {observedAt:timestamp(snapshot?.observedAt),scope:'enrolled sources only',accountWideCoverage:false,
  hosts:hosts.slice(0,64).map(h=>({id:h.id,label:h.name||h.label||h.id,role:h.role||'unknown',
   state:states.has(h.status)?h.status:'unknown',receivedAt:timestamp(h.receivedAt),sourceObservedAt:timestamp(h.sourceObservedAt),
   gapCount:Array.isArray(h.gaps)?h.gaps.length:null,
   coverage:h.coverage?{completeHistory:h.coverage.completeHistory===true,limit:count(h.coverage.limit),
    invalidRecords:count(h.coverage.invalidRecords),inventoryLimited:h.coverage.inventoryLimited===true,
    numericUsage:h.coverage.numericUsage?{backlogged:h.coverage.numericUsage.backlogged===true,inventoryLimited:h.coverage.numericUsage.inventoryLimited===true}:null}:null,
   runtimeVersion:null,compatibility:'not reported'})),
  note:'A heartbeat establishes collector contact, not an active job or complete account coverage. Unreported compatibility and coverage remain unknown.'};
}

export function preservationHealth(journal){
 if(!journal?.database)return {status:'unavailable',scope:'captured usage versions',reason:'No durable journal is configured.'};
 const archive=journal.database(db=>archiveStatus(db));
 return {status:'observed',scope:'captured usage versions',observedAt:new Date().toISOString(),
  retentionMode:'verified-archive-only',archive,notes:[
   'Usage cache limits never authorize eviction of a version without its verified durable receipt.',
   'Event journal retention and permanent usage archiving are separate policies.',
   'Receipt counts describe captured versions; they do not establish complete account-wide collection.',
   'This view reads custody metadata only; it does not verify archive segment bytes or initiate a restore.'
  ]};
}
