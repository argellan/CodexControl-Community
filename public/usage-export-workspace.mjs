// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {buildUsageExport,usageExportPreview,usageExportJSON,usageExportCSV,usageExportSVG,usageExportPNG} from './usage-export.mjs';
import {createSyntheticDemo} from './synthetic-demo.mjs';
import {DEFAULT_TOKEN_PALETTE} from './token-palette.mjs';

// Explicit local presentation only. No fetch, storage, ingestion or live-state
// callbacks belong here. Every export is frozen until the user opens a new one.
const formats={json:['application/json','json'],csv:['text/csv;charset=utf-8','csv'],svg:['image/svg+xml','svg'],png:['image/png','png']};
function element(document,tag,klass,text){const node=document.createElement(tag);if(klass)node.className=klass;if(text!==undefined)node.textContent=text;return node;}
export function mountUsageExportWorkspace({document,window=globalThis,getPalette=()=>DEFAULT_TOKEN_PALETTE,saveBlob=null,makePNG=usageExportPNG}={}){
 const listeners=[],urls=new Set(),timers=new Set(),urlTimers=new Map(),on=(node,type,handler)=>{node.addEventListener(type,handler);listeners.push([node,type,handler]);};
 let destroyed=false,generation=0,busy=false,source=null,model=null,preview=null,palette=DEFAULT_TOKEN_PALETTE,returnFocus=null,demoReturnFocus=null,demo=null;
 const createDialog=(id,title)=>{const dialog=element(document,'dialog','account-dialog usage-export-dialog');dialog.id=id;dialog.setAttribute('aria-labelledby',id+'-title');const heading=element(document,'div','panel-heading'),name=element(document,'h2','',title);name.id=id+'-title';const close=element(document,'button','','×');close.type='button';close.setAttribute('aria-label','Close '+title);heading.append(name,close);const body=element(document,'div','account-dialog-content');dialog.append(heading,body);document.body.append(dialog);on(close,'click',()=>dialog.close());return {dialog,body,heading,close};};
 const exported=createDialog('usage-export-dialog','Preview local usage export'),demonstration=createDialog('usage-demo-dialog','TEST_ONLY · Synthetic demo');
 const note=element(document,'p','note','Local snapshot only · nothing is posted or downloaded automatically. This is a bounded selected view, not the full long-term archive. Close and reopen to select newer readings.'),disclosures=element(document,'div','usage-export-disclosures');
 const checkbox=(id,label)=>{const row=element(document,'label','switch'),input=element(document,'input');input.type='checkbox';input.id=id;row.htmlFor=id;row.append(input,element(document,'span','',label));disclosures.append(row);return input;};
 const identities=checkbox('usage-export-identities','Include selected raw identities (separate explicit disclosure)'),precise=checkbox('usage-export-times','Include precise source and receipt timestamps (separate explicit disclosure)');
 const warning=element(document,'p','account-status-warning'),facts=element(document,'p','note'),image=element(document,'img','usage-export-image');image.alt='Usage export preview. Exact data and limitations are available below and in JSON, CSV or SVG.';
 const raw=element(document,'details','usage-history-table'),summary=element(document,'summary','','Preview first three allowlisted rows and caveats'),rawText=element(document,'pre','usage-export-preview');raw.append(summary,rawText);
 const actions=element(document,'div','profile-actions'),buttons={};for(const format of Object.keys(formats)){const button=element(document,'button','','Download '+format.toUpperCase());button.type='button';button.dataset.exportFormat=format;buttons[format]=button;actions.append(button);on(button,'click',()=>download(format));}
 const status=element(document,'p','note');status.setAttribute('role','status');const closePreview=element(document,'button','','Close export preview');closePreview.type='button';on(closePreview,'click',()=>exported.dialog.close());
 exported.body.append(note,disclosures,warning,facts,image,raw,actions,status,closePreview);
 const demoBadge=element(document,'p','account-status-warning','TEST_ONLY · SYNTHETIC · no live workers, account usage, notifications or retained events'),demoNote=element(document,'p','note','A deterministic presentation fixture in separate memory. Returning to live keeps the real view, filters, history and motion cursors unchanged.'),demoImage=element(document,'img','usage-export-image');demoImage.alt='Synthetic input, output and cached token chart. No live usage.';
 const demoWorkers=element(document,'div','usage-demo-workers'),demoActions=element(document,'div','profile-actions'),demoExport=element(document,'button','','Preview synthetic export'),returnLive=element(document,'button','','Return to live');demoExport.type=returnLive.type='button';demoActions.append(demoExport,returnLive);demonstration.body.append(demoBadge,demoNote,demoImage,demoWorkers,demoActions);
 on(returnLive,'click',()=>demonstration.dialog.close());on(demoExport,'click',()=>{if(demo)openExport(demo.accountUsageResponse);});
 const focusBack=(preferred,fallback)=>{if(preferred?.isConnected)preferred.focus({preventScroll:true});else document.getElementById(fallback)?.focus({preventScroll:true});};
 function clearExport(){generation++;source=null;model=null;preview=null;identities.checked=precise.checked=false;image.removeAttribute('src');rawText.textContent='';facts.textContent='';warning.textContent='';status.textContent='';setBusy(false);}
 on(exported.dialog,'close',()=>{clearExport();focusBack(returnFocus,demonstration.dialog.open?'usage-demo-dialog':'usage-open');});
 on(demonstration.dialog,'close',()=>{demo=null;demoWorkers.replaceChildren();demoImage.removeAttribute('src');focusBack(demoReturnFocus,'usage-open');});
 function paint(){
  if(!source||destroyed)return;model=buildUsageExport(source,{includeIdentities:identities.checked,includePreciseTimes:precise.checked,maxRows:1000});preview=usageExportPreview(model);
  warning.textContent=(preview.synthetic?'TEST_ONLY · SYNTHETIC EXPORT. ':'')+preview.warning+' '+(precise.checked?'Precise timestamps are included.':'Time resolution is day only.');
  facts.textContent=`Scope ${model.scope.from??'unavailable'} — ${model.scope.to??'unavailable'} · ${preview.exportedRows} exported rows · ${model.coverage.matchingRows??'unknown'} matching source rows · ${model.coverage.truncated?'PARTIAL / BOUNDED':'captured coverage only'} · account completeness NOT ESTABLISHED`;
  rawText.textContent=JSON.stringify(preview,null,2);image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(usageExportSVG(model,{palette:palette.name,theme:palette.theme}));status.textContent='Review the preview, then choose a local download format.';setBusy(false);
 }
 function setBusy(value){busy=value;identities.disabled=precise.disabled=value;for(const button of Object.values(buttons))button.disabled=value||!model;}
 function openExport(payload){
  if(destroyed)return;generation++;returnFocus=document.activeElement;source=structuredClone({sampleAnalytics:payload?.sampleAnalytics??null,mode:payload?.mode,synthetic:payload?.synthetic===true});palette=getPalette()||DEFAULT_TOKEN_PALETTE;identities.checked=false;precise.checked=false;raw.open=false;paint();if(!exported.dialog.open)exported.dialog.showModal();exported.close.focus();
 }
 function openDemo(){
  if(destroyed)return;demoReturnFocus=document.activeElement;demo=createSyntheticDemo();const syntheticModel=buildUsageExport(demo.accountUsageResponse),appearance=getPalette()||DEFAULT_TOKEN_PALETTE;demoImage.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(usageExportSVG(syntheticModel,{palette:appearance.name,theme:appearance.theme}));
  const hosts=new Map(demo.snapshot.hosts.map(host=>[host.id,host])),cards=demo.snapshot.sessions.map(worker=>{const card=element(document,'div','usage-demo-worker'),host=hosts.get(worker.hostId),icon=host?.deviceClass==='raspberry-pi'?'◈':host?.deviceClass==='server'?'▤':'⌘';card.append(element(document,'b','',icon+' '+worker.nickname),element(document,'small','',host?.name||'TEST_ONLY source'),element(document,'span','',worker.taskLabel),element(document,'small','',worker.model+' · configured · SYNTHETIC'));return card;});demoWorkers.replaceChildren(...cards);if(!demonstration.dialog.open)demonstration.dialog.showModal();returnLive.focus();
 }
 on(identities,'change',paint);on(precise,'change',paint);
 async function localSave(blob,name){
  if(saveBlob){await saveBlob(blob,name);return;}
  if(urls.size>=4){const oldest=urls.values().next().value,oldTimer=urlTimers.get(oldest);window.URL.revokeObjectURL(oldest);urls.delete(oldest);window.clearTimeout(oldTimer);timers.delete(oldTimer);urlTimers.delete(oldest);}
  const url=window.URL.createObjectURL(blob);urls.add(url);const anchor=element(document,'a');anchor.href=url;anchor.download=name;anchor.hidden=true;document.body.append(anchor);anchor.click();anchor.remove();const timer=window.setTimeout(()=>{window.URL.revokeObjectURL(url);urls.delete(url);timers.delete(timer);urlTimers.delete(url);},1000);timers.add(timer);urlTimers.set(url,timer);
 }
 async function download(format){
  if(destroyed||busy||!model||!exported.dialog.open||!Object.hasOwn(formats,format))return;const selected=model,selectedGeneration=generation;setBusy(true);status.textContent='Preparing local '+format.toUpperCase()+'…';
  try{
   const options={palette:palette.name,theme:palette.theme,width:1200,height:800},value=format==='png'?await makePNG(selected,{...options,environment:window}):format==='json'?usageExportJSON(selected):format==='csv'?usageExportCSV(selected):usageExportSVG(selected,options);
   if(destroyed||!exported.dialog.open||generation!==selectedGeneration)return;
   const blob=format==='png'?value:new window.Blob([value],{type:formats[format][0]});if(!blob||!Number.isSafeInteger(blob.size)||blob.size<0||blob.size>8388608)throw new Error('Export bound');
   const day=/^\d{4}-\d{2}-\d{2}/.exec(selected.scope.to||'')?.[0]||'selection';await localSave(blob,`${selected.synthetic?'TEST_ONLY-':''}argellan-codexcontrol-usage-${day}.${formats[format][1]}`);if(!destroyed&&generation===selectedGeneration)status.textContent='Local '+format.toUpperCase()+' download requested. No data was posted.';
  }catch{if(!destroyed&&generation===selectedGeneration)status.textContent='Local export could not be generated. JSON, CSV and SVG remain available.';}
  finally{if(!destroyed&&generation===selectedGeneration)setBusy(false);}
 }
 return {openExport,openDemo,invalidate(){if(destroyed||source?.synthetic===true)return;clearExport();if(exported.dialog.open)exported.dialog.close();},destroy(){destroyed=true;generation++;source=null;model=null;preview=null;demo=null;for(const [node,type,handler] of listeners)node.removeEventListener(type,handler);for(const timer of timers)window.clearTimeout(timer);for(const url of urls)window.URL.revokeObjectURL(url);timers.clear();urls.clear();urlTimers.clear();exported.dialog.remove();demonstration.dialog.remove();}};
}
