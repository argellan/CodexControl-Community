// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {getTokenPalette} from './token-palette.mjs';

// This module builds a new allowlisted document; it never serializes source
// payloads, reads storage, fetches data, downloads, or posts on the user's behalf.
const models=new WeakSet(),MAX_ROWS=1000,MAX_INPUT=5000;
const counters=Object.freeze({input:'input_tokens',cached:'cached_input_tokens',cacheWrite:'cache_write_input_tokens',output:'output_tokens',reasoning:'reasoning_output_tokens',total:'total_tokens'});
const scopes=new Set(['thread-total','last-response','response','turn-total']);
const classes=new Set(['candidate','fork-excluded','execution-excluded','unknown']);
const roles=new Set(['codex-source','execution-target','execution-job','unknown']);
const identityFields=Object.freeze({host:'host_id',session:'session_id',project:'project',thread:'native_thread_id',nativeSession:'native_session_id',turn:'native_turn_id',rootTurn:'native_root_turn_id',response:'native_response_id'});
export const USAGE_EXPORT_CAVEATS=Object.freeze([
 'Captured source observations are incomplete; this export does not establish complete account usage or billing.',
 'Input includes cached input. Reasoning is a subset of output. Do not add these subsets twice.',
 'Thread totals, last-response readings, response readings and turn totals are different scopes; do not sum them together.',
 'Response summaries use the source analytics selection; visible sample rows may include repeated snapshots, excluded sources or conflicting versions.',
 'Ratios use comparable known numerator/denominator pairs and a ratio of sums; a missing or zero denominator is unavailable.',
 'Counts are source observations; provider measurement, synthesized values and missing values remain distinct. Configured context does not establish producing attribution.',
 'Cache-write semantics are source/provider dependent. Tokens, native estimates, credits, source-unit balances and subscription invoices are different units; no conversion is inferred.',
 'Identities are aliases by default, not a guarantee of anonymization. Counts, dates and activity patterns can remain identifying.'
]);
const fail=message=>{throw new Error(message);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const boundedText=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(value)&&!/^(?:[a-z]:[\\/]|\\\\|\/|~[\\/]|file:)/i.test(value)?value:null;
const timestamp=value=>{const n=typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;return Number.isSafeInteger(n)&&n>=0&&n<=8640000000000000?n:null;};
const stamp=(value,precise)=>{const n=timestamp(value);return n===null?null:new Date(n).toISOString().slice(0,precise?undefined:10);};
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function checked(model){if(!models.has(model))fail('Build a usage export before serializing it');return model;}
function ratio(value){
 const numerator=count(value?.numerator),denominator=count(value?.denominator),comparableRows=count(value?.comparableRows),excludedRows=count(value?.excludedRows);
 return {value:numerator!==null&&denominator!==null&&denominator>0&&numerator<=denominator?numerator/denominator:null,numerator,denominator,comparableRows,excludedRows,classification:'derived',method:'ratio-of-sums'};
}

export function buildUsageExport(payload={},options={}){
 const includeIdentities=options.includeIdentities===true,includePreciseTimes=options.includePreciseTimes===true,maxRows=options.maxRows??MAX_ROWS;
 if(!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>MAX_ROWS)fail('Export row limit must be 1–1000');
 const analytics=object(payload?.sampleAnalytics)?payload.sampleAnalytics:{},coverage=object(analytics.coverage)?analytics.coverage:{},summary=object(analytics.responses)?analytics.responses:{};
 const input=Array.isArray(analytics.recent)?analytics.recent:[],aliases=new Map();
 // Sort each identity family so aliases stay stable across polls and source-row
 // order changes within the same selected dataset. No reversible IDs are stored.
 for(const [label,key] of Object.entries(identityFields)){
  const values=[...new Set(input.slice(0,MAX_INPUT).map(row=>boundedText(row?.[key])).filter(Boolean))].sort();
  aliases.set(label,new Map(values.map((value,i)=>[value,label+'-'+String(i+1).padStart(3,'0')])));
 }
 const rows=input.slice(0,Math.min(maxRows,MAX_INPUT)).filter(object).map(row=>{
  const identities=Object.fromEntries(Object.entries(identityFields).map(([label,key])=>{const value=boundedText(row[key]);return [label,value===null?null:includeIdentities?value:aliases.get(label).get(value)??null];}));
  return {identities,day:stamp(row.source_ms??row.received_ms,false),...(includePreciseTimes?{sourceAt:stamp(row.source_ms,true),receivedAt:stamp(row.received_ms,true)}:{}),scope:scopes.has(row.usage_scope)?row.usage_scope:'unknown',accountingClass:classes.has(row.accounting_class)?row.accounting_class:'unknown',sourceRole:roles.has(row.source_role)?row.source_role:'unknown',tokens:Object.fromEntries(Object.entries(counters).map(([label,key])=>[label,count(row[key])])),reportedMask:count(row.reported_mask)<=63?count(row.reported_mask):null,providerReportedMask:count(row.provider_reported_mask)<=63?count(row.provider_reported_mask):null,synthesizedMask:count(row.synthesized_mask)<=63?count(row.synthesized_mask):null,classification:'source-observation'};
 });
 const exportedRows=rows.length,matchingRows=count(coverage.matchingRows),returnedRows=count(coverage.returnedRows);
 const model={format:'ARGELLAN-CodexControl-usage',version:1,synthetic:payload?.synthetic===true||payload?.mode==='TEST_ONLY',accountComplete:false,identityMode:includeIdentities?'included-by-explicit-choice':'stable-aliases',timeResolution:includePreciseTimes?'precise-by-explicit-choice':'day',scope:{kind:'captured-source-observations',from:stamp(analytics.scope?.from,includePreciseTimes),to:stamp(analytics.scope?.to,includePreciseTimes)},coverage:{retainedRows:count(coverage.retainedRows),matchingRows,returnedRows,exportedRows,truncated:coverage.truncated===true||input.length>exportedRows||matchingRows!==null&&matchingRows>exportedRows,excludedRows:count(coverage.excludedRows),identityMissing:count(coverage.identityMissing),conflictingResponses:count(coverage.conflictingResponses)},responses:{status:['available','partial','unavailable'].includes(summary.status)?summary.status:'unavailable',responseCount:count(summary.responseCount),totals:Object.fromEntries(Object.keys(counters).map(key=>[key,count(summary.totals?.[key])])),ratios:{cacheHit:ratio(summary.ratios?.cacheHit),reasoningShare:ratio(summary.ratios?.reasoningShare),newInputFraction:ratio(summary.ratios?.newInputFraction)},classification:'derived-source-selection'},rows,caveats:[...USAGE_EXPORT_CAVEATS]};
 freeze(model);models.add(model);return model;
}

export function usageExportPreview(model){checked(model);return freeze({identityMode:model.identityMode,timeResolution:model.timeResolution,synthetic:model.synthetic,accountComplete:false,exportedRows:model.rows.length,truncated:model.coverage.truncated,warning:model.identityMode==='stable-aliases'?'Review before sharing: activity patterns may remain identifying.':'Raw selected identities are included. Review every identity before sharing.',sampleRows:model.rows.slice(0,3),caveats:model.caveats});}
export function usageExportJSON(model){return JSON.stringify(checked(model),null,2)+'\n';}
const cell=value=>{if(value===null||value===undefined)return '""';let text=String(value);if(typeof value==='string'&&/^[\s\u0000-\u001f]*[=+\-@]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
export function usageExportCSV(model){
 checked(model);const headers=['kind','synthetic','accountComplete','identityMode','timeResolution','day',...Object.keys(identityFields),'scope','accountingClass','sourceRole',...Object.keys(counters),'reportedMask','providerReportedMask','synthesizedMask',...(model.timeResolution==='precise-by-explicit-choice'?['sourceAt','receivedAt']:[]),'caveats'];
 headers.push('matchingRows','returnedRows','exportedRows','truncated','cacheHitNumerator','cacheHitDenominator','reasoningNumerator','reasoningDenominator');
 const line=value=>headers.map(key=>cell(value[key])).join(','),common={synthetic:model.synthetic,accountComplete:false,identityMode:model.identityMode,timeResolution:model.timeResolution},cache=model.responses.ratios.cacheHit,reasoning=model.responses.ratios.reasoningShare;
 return [headers.map(cell).join(','),line({...common,kind:'metadata',...model.coverage,cacheHitNumerator:cache.numerator,cacheHitDenominator:cache.denominator,reasoningNumerator:reasoning.numerator,reasoningDenominator:reasoning.denominator,caveats:model.caveats.join(' ')}),...model.rows.map(row=>line({...common,kind:'sample',...row,...row.identities,...row.tokens,caveats:''}))].join('\r\n')+'\r\n';
}
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
function size(options={}){const width=options.width??1200,height=options.height??800;if(!Number.isSafeInteger(width)||width<640||width>1600||!Number.isSafeInteger(height)||height<640||height>1200)fail('Export image dimensions must be 640–1600 × 640–1200');return {width,height};}
function wrap(text,width=110){const lines=[];let line='';for(const word of text.split(' ')){if(line&&line.length+word.length+1>width){lines.push(line);line='';}line+=(line?' ':'')+word;}if(line)lines.push(line);return lines;}
export function usageExportSVG(model,options={}){
 checked(model);const {width,height}=size(options),palette=getTokenPalette(options.palette,options.theme),light=palette.theme==='light',ink=light?'#101722':'#E3EDF8',muted=light?'#475569':'#ACBED2';
 const total=model.responses.totals,input=total.input,cached=total.cached,newInput=input!==null&&cached!==null&&cached<=input?input-cached:null;
 const bars=[{label:'I · New input',value:newInput,color:palette.series.input.color},{label:'O · Inclusive output',value:total.output,color:palette.series.output.color},{label:'C · Cached input',value:cached,color:palette.series.cached.color}],max=Math.max(1,...bars.map(bar=>bar.value??0));
 const text=(x,y,value,fontSize=16,color=ink)=>`<text x="${x}" y="${y}" font-family="monospace" font-size="${fontSize}" fill="${color}">${escape(value)}</text>`;
 const wrapped=(x,y,value,fontSize,color)=>wrap(value,Math.floor((width-64)/(fontSize*.62))).map((line,i)=>text(x,y+i*(fontSize+3),line,fontSize,color)).join('');
 const content=[`<rect width="${width}" height="${height}" fill="${palette.face}"/>`,text(32,43,'ARGELLAN · CODEX CONTROL',24),text(32,75,model.synthetic?'TEST_ONLY · SYNTHETIC DEMO':'Captured usage · partial source coverage',17,muted),wrapped(32,103,`${model.identityMode} · ${model.timeResolution} · ${model.rows.length} exported samples`,14,muted)];
 bars.forEach((bar,i)=>{const y=151+i*69;content.push(text(32,y,bar.label,17,bar.color),text(width-210,y,bar.value===null?'Unavailable':String(bar.value),17,bar.color),`<rect x="32" y="${y+12}" width="${Math.round((width-64)*(bar.value??0)/max)}" height="13" rx="4" fill="${bar.color}"/>`);});
 const pct=value=>value===null?'Unavailable':(value*100).toFixed(1)+'%';
 content.push(wrapped(32,374,`Cache hit: ${pct(model.responses.ratios.cacheHit.value)} · Reasoning share: ${pct(model.responses.ratios.reasoningShare.value)}`,16,ink),wrapped(32,403,`Reasoning subset: ${total.reasoning??'Unavailable'} · Cache-write source component: ${total.cacheWrite??'Unavailable'}`,15,muted),wrapped(32,441,`Response selection: ${model.responses.status} · Account completeness: NOT ESTABLISHED`,15,muted));
 const caveats=model.caveats.join(' '),visible='Partial captured coverage; no complete account usage or invoice is established. Input includes cache; output includes reasoning. Never add subsets twice. Snapshots and responses have separate scopes. Ratios need comparable denominators. Credits, source balances and estimates have separate units. Full caveats are embedded in this SVG description.',lines=wrap(visible,Math.floor((width-64)/8));
 lines.forEach((line,i)=>content.push(text(32,493+i*17,line,13,muted)));
 // Fixed text, known palette values and escaped labels only: no references,
 // scripts, style blocks, foreignObject, embedded images or caller SVG content.
 return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc"><title id="title">ARGELLAN CodexControl usage export</title><desc id="desc">${escape(caveats)}</desc>${content.join('')}</svg>`;
}

export async function usageExportPNG(model,options={}){
 checked(model);const {width,height}=size(options),environment=options.environment??globalThis,{document,Image,Blob}=environment,bitmapAvailable=typeof environment.createImageBitmap==='function';
 if(!document?.createElement||typeof Blob!=='function'||!bitmapAvailable&&typeof Image!=='function')fail('Local browser rasterization is unavailable');
 const svg=usageExportSVG(model,{...options,width,height});if(svg.length>262144)fail('Export image exceeds its bound');
 const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d');if(!context)fail('Local canvas is unavailable');
 const svgBlob=new Blob([svg],{type:'image/svg+xml'});let image,bitmap,timer;
 try{
  if(bitmapAvailable){
   // Decode the in-memory Blob directly. This does not require img-src blob:
   // and keeps the application's existing CSP and network policy intact.
   try{bitmap=await new Promise((resolve,reject)=>{let expired=false;timer=setTimeout(()=>{expired=true;reject(new Error('Local image conversion timed out'));},5000);Promise.resolve(environment.createImageBitmap(svgBlob)).then(value=>{if(expired)value?.close?.();else resolve(value);},()=>reject(new Error('Local image conversion failed')));});}catch(error){if(typeof Image!=='function')throw error;}finally{clearTimeout(timer);}
  }
  if(!bitmap){
   // Some engines expose createImageBitmap but refuse SVG Blobs. The bounded,
   // self-contained data image fallback is allowed by the existing img-src.
   image=new Image();
   await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Local image conversion timed out')),5000);image.onload=resolve;image.onerror=()=>reject(new Error('Local image conversion failed'));image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);});
  }
  clearTimeout(timer);
  context.drawImage(bitmap??image,0,0,width,height);
  return await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Local PNG conversion timed out')),5000);canvas.toBlob(blob=>blob&&blob.type==='image/png'&&blob.size<=8*1024*1024?resolve(blob):reject(new Error('Local PNG conversion failed')),'image/png');});
 }finally{clearTimeout(timer);bitmap?.close?.();if(image){image.onload=null;image.onerror=null;}canvas.width=0;canvas.height=0;}
}
