// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {APPLICATION_VERSION} from './build-info.mjs';
// A bounded, allowlisted projection. No source text, filesystem, network or vault access.
const MAX_EVENTS=1000,MAX_CANDIDATES=5000,packets=new WeakSet(),selections=new WeakSet();
const kinds=new Set(['tool.start','tool.end','turn','complete','message','approval','resolution','error','job.start','job.end','job.report','operation','remote.start','remote.end','remote.progress']);
const categories=new Set(['command','edit','research','agent','tool','turn','complete','message','approval','resolution','error','remote']);
const outcomes=new Set(['recorded','failed','interrupted','unknown','success','completed']);
const str=v=>typeof v==='string'&&v.length<=256?v:'';
const day=v=>{const ms=typeof v==='number'?v:Date.parse(v);return Number.isFinite(ms)&&ms>=0?new Date(ms).toISOString().slice(0,10):null;};
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const encoded=s=>new TextEncoder().encode(s);
export async function sha256(value){const bytes=typeof value==='string'?encoded(value):value;return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');}
const markdown=v=>String(v).replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g,'\\$&').replace(/\r/g,'');
export const HANDOFF_LIMIT=MAX_EVENTS;
export function captureHandoffSelection(selection={}){
 const input=Array.isArray(selection.events)?selection.events:[],candidates=input.slice(0,MAX_CANDIDATES).filter(v=>v&&typeof v==='object'&&!Array.isArray(v));
 // Copy only explicitly allowed metadata. Raw results, labels, prompts, arguments,
 // usernames, account data and arbitrary properties never enter the packet.
 const copied=candidates.map(e=>({host:str(e.hostId),session:str(e.sessionId),id:str(e.id),source:str(e.sourceId),call:str(e.callId),turn:str(e.turnId),at:Number.isFinite(Date.parse(e.at))?Date.parse(e.at):null,kind:kinds.has(e.kind)?e.kind:'unknown',category:categories.has(e.category)?e.category:'unknown',outcome:outcomes.has(e.outcome)?e.outcome:'unknown',durationMs:Number.isFinite(e.durationMs)&&e.durationMs>=0?Math.min(e.durationMs,86400000):null}));
 const captured=freeze({events:copied,selectedCandidates:input.length,mode:selection.mode==='replay'?'replay':'live',knownGaps:Number.isSafeInteger(selection.knownGaps)&&selection.knownGaps>=0?Math.min(selection.knownGaps,100000):null});selections.add(captured);return captured;
}
export async function prepareHandoff(selection={}){
 const captured=selections.has(selection)?selection:captureHandoffSelection(selection),copied=captured.events.slice();
 copied.sort((a,b)=>(a.at??0)-(b.at??0)||JSON.stringify(a).localeCompare(JSON.stringify(b)));
 const selected=copied.slice(-MAX_EVENTS),alias=(values,prefix)=>new Map([...new Set(values)].sort().map((v,i)=>[v,prefix+'-'+String(i+1).padStart(3,'0')]));
 const hosts=alias(selected.map(e=>e.host),'host'),workers=alias(selected.map(e=>e.host+'\0'+e.session),'worker');
 const observations=await Promise.all(selected.map(async(e,i)=>({reference:'event-'+String(i+1).padStart(4,'0'),sourceFingerprint:await sha256(JSON.stringify(e)),host:hosts.get(e.host),worker:workers.get(e.host+'\0'+e.session),day:e.at===null?null:day(e.at),kind:e.kind,category:e.category,outcome:e.outcome,durationMs:e.durationMs})));
 const snapshot={schemaVersion:1,format:'CodexControl-reviewed-handoff',mode:captured.mode,coverage:{selectedCandidates:captured.selectedCandidates,exported:observations.length,truncated:captured.selectedCandidates>observations.length,completeHistory:false,knownGaps:captured.knownGaps},identityMode:'packet-local-aliases',timeResolution:'day',observations};
 const json=JSON.stringify(snapshot,null,2)+'\n',fingerprint=await sha256(json),packet=freeze({snapshot,json,fingerprint});packets.add(packet);return packet;
}
function checked(packet){if(!packets.has(packet))throw new Error('Prepare a handoff before reviewing it');return packet;}
export async function reviewedHandoff(packet,{reviewed=false,summary=''}={}){
 checked(packet);if(reviewed!==true)throw new Error('Explicit preview review is required');if(!packet.snapshot.observations.length)throw new Error('Select captured events before exporting');
 if(typeof summary!=='string'||summary.length>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(summary))throw new Error('Summary must be at most 2000 plain-text characters');
 const s=packet.snapshot,counts={};for(const e of s.observations)counts[e.category]=(counts[e.category]||0)+1;
 const md=['---','type: codexcontrol-handoff','schema_version: 1','tags: [codexcontrol, reviewed-handoff]','snapshot_sha256: '+packet.fingerprint,'---','','# CodexControl handoff','','## Scope',`Captured ${s.mode} selection: ${s.coverage.exported} events across ${new Set(s.observations.map(e=>e.worker)).size} worker aliases.`,`Coverage: ${s.coverage.truncated?'PARTIAL / bounded selection':'selected captured records only'}; known gap count: ${s.coverage.knownGaps??'unavailable'}. Full-history completeness is not established.`,'','## Reviewer summary',summary?markdown(summary):'No reviewer narrative supplied. The recorded observations below are the handoff.','','## Recorded activity',...Object.entries(counts).map(([k,v])=>`- ${k}: ${v}`),'','## Evidence and outcome limits','The user reviewed this export for release. That is not independent verification of worker outcomes. A recorded result or completed turn does not prove acceptance. No source prompts, arguments, outputs, reasoning text or file contents are included.','','## Observations','| Reference | Worker | Day | Kind | Category | Source outcome |','| --- | --- | --- | --- | --- | --- |',...s.observations.map(e=>`| ${e.reference} | ${e.worker} | ${e.day??'unknown'} | ${e.kind} | ${e.category} | ${e.outcome} |`),'','## Provenance and reuse','See observations.json for the selected metadata and per-event fingerprints; manifest.json hashes both exported files. Fingerprints cover the captured allowlisted metadata, not excluded source content. Aliases are local to this packet and are not a guarantee of anonymity. Dates, counts and activity patterns may remain identifying.','','## Obsidian handoff','Extract this packet into a new, uniquely named folder. Review all three files, then copy that folder into your chosen vault and open CodexControl-Handoff.md. Do not overwrite an earlier handoff folder. Import does not dispatch work or modify the source journal. No vault is contacted or changed automatically.',''].join('\n');
 const files=[{name:'CodexControl-Handoff.md',bytes:encoded(md)},{name:'observations.json',bytes:encoded(packet.json)}];
 const manifest={format:'CodexControl-handoff-manifest',schemaVersion:1,applicationVersion:APPLICATION_VERSION,snapshotSha256:packet.fingerprint,review:{previewConfirmed:true,outcomesIndependentlyVerified:false},coverage:s.coverage,files:await Promise.all(files.map(async f=>({path:f.name,bytes:f.bytes.length,sha256:await sha256(f.bytes)})))};
 files.push({name:'manifest.json',bytes:encoded(JSON.stringify(manifest,null,2)+'\n')});return {files,manifest,filename:'codexcontrol-handoff-'+packet.fingerprint.slice(0,12)+'.zip'};
}
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc32=b=>{let c=0xffffffff;for(const v of b)c=crcTable[(c^v)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
// Stored ZIP entries avoid a compression dependency and run only on explicit export.
export function handoffZip(files){
 if(!Array.isArray(files)||files.length!==3||new Set(files.map(f=>f.name)).size!==3||files.some(f=>!['CodexControl-Handoff.md','observations.json','manifest.json'].includes(f.name)||!(f.bytes instanceof Uint8Array)||f.bytes.length>2097152))throw new Error('Invalid bounded handoff files');
 const chunks=[],central=[];let offset=0,centralBytes=0;
 for(const f of files){const name=encoded(f.name),crc=crc32(f.bytes),local=new Uint8Array(30+name.length),l=new DataView(local.buffer);l.setUint32(0,0x04034b50,true);l.setUint16(4,20,true);l.setUint16(6,0x800,true);l.setUint16(12,33,true);l.setUint32(14,crc,true);l.setUint32(18,f.bytes.length,true);l.setUint32(22,f.bytes.length,true);l.setUint16(26,name.length,true);local.set(name,30);
  const entry=new Uint8Array(46+name.length),d=new DataView(entry.buffer);d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x800,true);d.setUint16(14,33,true);d.setUint32(16,crc,true);d.setUint32(20,f.bytes.length,true);d.setUint32(24,f.bytes.length,true);d.setUint16(28,name.length,true);d.setUint32(42,offset,true);entry.set(name,46);chunks.push(local,f.bytes);central.push(entry);offset+=local.length+f.bytes.length;centralBytes+=entry.length;
 }
 const end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,centralBytes,true);e.setUint32(16,offset,true);const zip=new Uint8Array(offset+centralBytes+22);let cursor=0;for(const b of [...chunks,...central,end]){zip.set(b,cursor);cursor+=b.length;}return zip;
}
