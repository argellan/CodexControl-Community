// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {APPLICATION_VERSION} from './build-info.mjs';
export const DIAGNOSTICS_SCHEMA = 1;
export const LIMITS = Object.freeze({events:100, localBytes:65536, localAgeMs:604800000, eventBytes:1024, queue:20, queueBytes:16384, queueAgeMs:86400000, requestBytes:2048, receiverReports:100, receiverBytes:65536, receiverAgeMs:86400000, requestsPerMinute:30, attempts:5, timeoutMs:2000});
export const CATEGORIES = Object.freeze(['unexpected','request-failed','collection-failed','unhandled-rejection','unclean-shutdown']);
const sites = new Set(['client:event','client:rejection','backend:request','backend:collection','backend:analytics','client:poll','runtime:startup','unknown']);
const kinds = new Set(['client-js','backend','unclean-shutdown']);
export function sanitizedEvent(input={}, now=Date.now()) {
  // Never read error.message, error.stack, event.reason, filenames or arbitrary strings.
  // Stack identifiers come from code-selected call sites, never the exception text.
  return {kind:kinds.has(input.kind)?input.kind:'backend', category:CATEGORIES.includes(input.category)?input.category:'unexpected', stack:[sites.has(input.site)?input.site:'unknown'], hour:Math.floor(now/3600000)};
}
export function validLocalEvent(e) {
  return exact(e,['kind','category','stack','hour']) && kinds.has(e.kind) && CATEGORIES.includes(e.category) && Array.isArray(e.stack) && e.stack.length===1 && sites.has(e.stack[0]) && Number.isSafeInteger(e.hour) && e.hour>=0;
}
export function exact(value, keys) {
  return !!value && typeof value==='object' && !Array.isArray(value) && Object.getPrototypeOf(value)===Object.prototype && Object.keys(value).length===keys.length && keys.every(k=>Object.hasOwn(value,k));
}
export function localExport(events) {
  return JSON.stringify({schemaVersion:DIAGNOSTICS_SCHEMA, applicationVersion:APPLICATION_VERSION, events:events.filter(validLocalEvent)},null,2)+'\n';
}
export function validateSyntheticReport(value) {
  if(value?.schemaVersion!==1 || value?.consentSchemaVersion!==1) throw Object.assign(new Error('Unsupported schema; renew consent'),{status:426});
  if(!exact(value,['schemaVersion','consentSchemaVersion','reportId','origin','applicationVersion','class','category','count','latencyBucket','memoryBucket']) || typeof value.reportId!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.reportId) || value.origin!=='synthetic' || value.applicationVersion!==APPLICATION_VERSION || !['browser','backend'].includes(value.class) || !CATEGORIES.includes(value.category) || !Number.isSafeInteger(value.count) || value.count<1 || value.count>100 || !['unknown','under-100ms','100-1000ms','over-1000ms'].includes(value.latencyBucket) || !['unknown','under-128MiB','128-512MiB','over-512MiB'].includes(value.memoryBucket)) throw Object.assign(new Error('Invalid diagnostic report'),{status:400});
  return Object.fromEntries(['schemaVersion','consentSchemaVersion','reportId','origin','applicationVersion','class','category','count','latencyBucket','memoryBucket'].map(key=>[key,value[key]]));
}