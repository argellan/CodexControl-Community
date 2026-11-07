// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {deviceVisual} from './ui-model.mjs';

// These are presentation identities, never generated worker names or live state.
// Labels are plain text: the calling renderer must use textContent or escape them.
const accents=Object.freeze(['#55d7ff','#bd94ff','#ffbf63','#67edbb','#ff86bb','#9fdb68','#8daeff','#e9adff','#6ce0dc','#f1d66b','#fc9c85','#92d5a4']);
const semanticColors=Object.freeze({terminal:'#55d7ff',file:'#ffb05d',browser:'#73bfff',search:'#67edbb',github:'#c9b4ff',branch:'#bd94ff',tool:'#79bfff',service:'#79bfff',unknown:'#9eafc8'});
const serviceNames=Object.freeze({terminal:'Command interface',file:'File interface',browser:'Browser interface',search:'Research interface',github:'GitHub connector',branch:'Agent tools',tool:'Tool interface',service:'Tool interface'});
const aliases=Object.freeze({command:'terminal',files:'file',research:'search',git:'branch',gitbranch:'branch',agent:'branch',agents:'branch'});
const text=value=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,160):'';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hex=value=>typeof value==='string'&&/^#[a-f0-9]{6}$/i.test(value)?value.toLowerCase():null;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
function hash(value){let result=2166136261;for(const char of value){result^=char.codePointAt(0);result=Math.imul(result,16777619);}return result>>>0;}
function sourceId(node){
 const explicit=text(node.sessionId)||(node.type==='host'?text(node.hostId):'');
 if(explicit)return explicit;
 return text(node.id).split('/').at(-1).replace(/^(?:worker|host|service|person):/,'');
}
function serviceIcon(node){
 const icon=text(node.icon),mapped=aliases[icon]||icon;
 return Object.hasOwn(serviceNames,mapped)?mapped:'tool';
}
function device(node){
 // The map's icon field comes from deviceClass, not from a hostname classifier.
 return deviceVisual({deviceClass:node.deviceClass===undefined?node.icon:node.deviceClass});
}
function initials(value){const words=value.match(/[\p{L}\p{N}]+/gu)||[];return words.slice(0,2).map(word=>[...word][0]).join('').toUpperCase()||'?';}

export function stationIdentity(value){
 const node=object(value),role=node.type,id=sourceId(node),shortId=id.replace(/[^\p{L}\p{N}]/gu,'').slice(-6),rawLabel=text(node.nickname)||text(node.label);
 const worker=role==='worker'||role==='subagent';
 if(worker){
  const originalFallback=id?'Codex · '+id.slice(0,8):'';
  const label=rawLabel&&rawLabel!==originalFallback?rawLabel:shortId?'Codex · '+shortId:'Unidentified worker';
  const named=Boolean(rawLabel&&rawLabel!==originalFallback);
  return {monogram:named?initials(label):shortId?shortId.slice(-4).toUpperCase():'?',color:accents[hash(text(node.hostId)+'/'+id)%accents.length],label,roleLabel:role==='subagent'?'Subagent':'Worker',shortId};
 }
 if(role==='host'){
  const d=device(node),label=rawLabel||text(node.hostId)||'Unidentified device';
  return {monogram:initials(label),color:d.color,label,roleLabel:d.label,shortId};
 }
 if(role==='human'){
  const label=rawLabel||'Human reviewer';
  return {monogram:initials(label),color:hex(node.color)||'#ffda55',label,roleLabel:'Human reviewer',shortId};
 }
 if(role==='service'){
  const icon=serviceIcon(node),label=rawLabel||serviceNames[icon];
  return {monogram:icon==='github'?'GH':initials(label),color:hex(node.color)||semanticColors[icon],label,roleLabel:serviceNames[icon],shortId};
 }
 const label=rawLabel||'Unclassified station';
 return {monogram:initials(label),color:'#9eafc8',label,roleLabel:'Unclassified station',shortId};
}

// Purpose-built silhouettes use the same coordinate system and inherited color.
// No user-controlled label, path, style, or identity is interpolated into the SVG.
const drawings=Object.freeze({
 robot:'<path d="M12 2.5v3.7 M3.8 11H2v4h1.8 M20.2 11H22v4h-1.8"/><circle cx="12" cy="2.5" r="1" fill="currentColor" stroke="none"/><rect x="4.5" y="6.2" width="15" height="14" rx="4" fill="currentColor" fill-opacity=".18"/><rect x="7" y="9" width="10" height="6" rx="2" fill="currentColor" fill-opacity=".2"/><circle cx="9.3" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="14.7" cy="12" r="1.1" fill="currentColor" stroke="none"/><path d="M9 17.3h6"/>',
 subagent:'<path d="M9.5 2v2 M2.5 9H1 M16.5 9H18"/><rect x="3" y="4" width="13" height="11.5" rx="3" fill="currentColor" fill-opacity=".2"/><circle cx="7" cy="9.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="9.5" r="1.1" fill="currentColor" stroke="none"/><path d="M7.3 12.5h4.4 M9.5 15.5v5h9v-3"/><circle cx="19" cy="16" r="2" fill="currentColor" fill-opacity=".25"/><circle cx="9.5" cy="20.5" r="1.2" fill="currentColor" stroke="none"/>',
 human:'<circle cx="12" cy="6" r="3.4" fill="currentColor" fill-opacity=".24"/><path d="M5.2 21v-2.3a6.8 6.8 0 0 1 13.6 0V21z" fill="currentColor" fill-opacity=".18"/><path d="M9.5 14.2 12 17l2.5-2.8"/>',
 terminal:'<rect x="2.5" y="4" width="19" height="16" rx="2.5" fill="currentColor" fill-opacity=".12"/><path d="m6 9 3.5 3L6 15 M12.5 15H18"/>',
 file:'<path d="M5 2.5h9l5 5V22H5z" fill="currentColor" fill-opacity=".13"/><path d="M14 2.5v5h5 M8 12h8 M8 16h6 M8 19h4"/>',
 browser:'<rect x="2" y="3.5" width="20" height="17" rx="2.5" fill="currentColor" fill-opacity=".13"/><path d="M2 8.5h20"/><circle cx="5" cy="6" r=".6" fill="currentColor" stroke="none"/><circle cx="8" cy="6" r=".6" fill="currentColor" stroke="none"/><path d="m8 12-3 2.5L8 17 M16 12l3 2.5-3 2.5 M13.5 11.5l-3 6"/>',
 search:'<circle cx="10.5" cy="10.5" r="7" fill="currentColor" fill-opacity=".16"/><path d="m16 16 5 5 M6.5 10.5h8 M10.5 6.5v8"/>',
 github:'<rect x="2" y="3" width="20" height="18" rx="5" fill="currentColor" fill-opacity=".16"/><text x="12" y="13.5" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" font-weight="800" stroke="none" fill="currentColor">GH</text><path d="M7 17h4c5 0 6-1 6-4"/><circle cx="7" cy="17" r="1.2" fill="currentColor" stroke="none"/>',
 branch:'<path d="M6 5v14 M7.5 16c8 0 10-5 10-10"/><circle cx="6" cy="4" r="2.3" fill="currentColor" fill-opacity=".24"/><circle cx="6" cy="20" r="2.3" fill="currentColor" fill-opacity=".24"/><circle cx="17.5" cy="4" r="2.3" fill="currentColor" fill-opacity=".24"/>',
 tool:'<path d="M14 4a5 5 0 0 0-5.8 6.7l-5.5 5.5a3 3 0 0 0 4.2 4.2l5.5-5.5A5 5 0 0 0 19.8 9L16 12l-4-4z" fill="currentColor" fill-opacity=".16"/><circle cx="5.5" cy="18" r=".8" fill="currentColor" stroke="none"/>',
 unknown:'<path d="m12 2 9 5v10l-9 5-9-5V7z" fill="currentColor" fill-opacity=".12"/><path d="M9.8 9a2.3 2.3 0 0 1 4.5.5c0 2-2.3 2-2.3 3.7 M12 17h.01"/>'
});

export function stationSymbol(value,{size=30}={}){
 const node=object(value),numeric=Number(size),dimension=Number.isFinite(numeric)?Math.min(96,Math.max(12,numeric)):30;
 let key=node.type==='worker'?'robot':node.type==='subagent'?'subagent':node.type==='human'?'human':node.type==='service'?serviceIcon(node):'unknown',drawing;
 if(node.type==='host'){
  const d=device(node);key='device-'+d.kind;
  drawing='<path d="'+escape(d.path)+'" fill="currentColor" fill-opacity=".1"/>';
 }else drawing=drawings[key]||drawings.tool;
 return '<svg xmlns="http://www.w3.org/2000/svg" class="station-symbol" data-symbol="'+escape(key)+'" width="'+escape(dimension)+'" height="'+escape(dimension)+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'+drawing+'</svg>';
}
