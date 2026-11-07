// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// View-only, bounded references. No capture, background requests or archive prefetch.
import {eventTime} from './event-model.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const failed=e=>e.kind==='error'||['failed','interrupted'].includes(e.outcome);
const date=v=>typeof v==='number'?v:Date.parse(v);
const timestamp=v=>Number.isFinite(date(v))?new Date(date(v)).toLocaleString():'Unavailable';
const dimensions=c=>JSON.stringify([c.host||'',c.project||'',c.session||'',c.category||'',c.search||'',c.windowMs]);
const identity=c=>JSON.stringify([dimensions(c),c.mode,c.mode==='replay'?c.at:0,c.event||'']);
export const authorityChanged=(previous,next)=>typeof previous==='string'&&previous.length>0&&next!==previous;

export function scopeCaption(c={},hosts=[],sessions=[]){
 const host=c.host||c.session?.split('/')[0],source=hosts.find(h=>h.id===host),worker=sessions.find(s=>(s.hostId||'local')+'/'+s.id===c.session);
 return [source?.name||host||'All hosts',c.project||worker?.project||'All projects',c.session?(worker?.nickname||c.session.split('/').at(-1).slice(0,8)):'All workers',c.category||'',c.search?'Search: '+c.search:''].filter(Boolean).join(' · ');
}
export function temporalLabel(host={},now=Date.now()){
 const at=date(host.sourceObservedAt||host.receivedAt),past=host.status!=='online';
 if(!Number.isFinite(at))return 'Source time unavailable';
 if(at>now+30000)return 'Source clock ahead · '+timestamp(at);
 const seconds=Math.max(0,Math.floor((now-at)/1000)),age=seconds<60?seconds+'s':seconds<3600?Math.floor(seconds/60)+'m':Math.floor(seconds/3600)+'h';
 return (past?'Last recorded':'Observed')+' '+age+' ago';
}
export class ContextTrail {
 constructor(limit=8){this.limit=limit;this.items=[];this.authority=null;this.anchor=null;}
 authorize(stamp){if(stamp!==this.authority){this.clear();this.authority=stamp;return true;}return false;}
 clear(){this.items=[];this.anchor=null;}
 push(context){const c=structuredClone(context);if(identity(this.items.at(-1)||{})===identity(c))return;this.items.push(c);if(this.items.length>this.limit)this.items.shift();}
 pop(){return this.items.pop()||null;}
 pin(context){this.anchor=structuredClone(context);}
}
export function groupAlertEvidence(items){
 const groups=new Map();
 for(const e of items){
  // Exact scoped identities only. Similar text is never a relationship.
  const correlation=e.callId?'call:'+e.callId:e.turnId?'turn:'+e.turnId:'record:'+e.id;
  const id=JSON.stringify([e.hostId||'',e.sessionId||e.sourceSessionId||'',e.sourceId||'',e.kind,correlation]);
  let group=groups.get(id);if(!group){group={id,item:e,members:[],lastAt:0,historical:e.kind==='error'||failed(e)};groups.set(id,group);}
  group.members.push(e);group.lastAt=Math.max(group.lastAt,date(e.at)||0);
 }
 return [...groups.values()];
}
export function windowSummary(events,context,{gaps=[],usage=null}={}){
 const start=context.at-context.windowMs,records=events.filter(e=>eventTime(e)>=start&&eventTime(e)<=context.at),mix={};
 for(const e of records){const category=failed(e)?'failure':e.category||e.kind;mix[category]=(mix[category]||0)+1;}
 const models=[...new Set(records.map(e=>e.model).filter(Boolean))].sort();
 return {context:structuredClone(context),count:records.length,failures:records.filter(failed).length,input:records.filter(e=>e.kind==='approval').length,completed:records.filter(e=>e.kind==='complete').length,mix,models,gaps:gaps.length,usage:usage?structuredClone(usage):null,ids:records.slice(-5000).map(e=>e.id),bounded:records.length>5000};
}
export function compareSummaries(a,b){
 if(!a||!b)return {comparable:false,reason:'Pin an earlier window first.'};
 if(dimensions(a.context)!==dimensions(b.context))return {comparable:false,reason:'Source, worker, project, category, search or duration differs. Restore the pinned scope before comparing.'};
 if(a.gaps||b.gaps||a.bounded||b.bounded)return {comparable:false,reason:'One window has missing capture or a bounded projection. Counts are shown, but the windows are not qualified for comparison.'};
 if(JSON.stringify(a.models)!==JSON.stringify(b.models))return {comparable:false,reason:'Observed model dimensions differ.'};
 if(!a.models.length||!b.models.length)return {comparable:false,reason:'Historical model coverage is unavailable. Event counts remain inspectable, but full comparability is not established.'};
 return {comparable:true,reason:'Same selected dimensions and duration. Counts describe captured observations; they do not establish causality, a regression, or complete provider usage.',delta:b.count-a.count};
}
export function reviewBrief(events,mark,{gaps=[],hosts=[]}={}){
 if(!mark)return null;
 const after=events.filter(e=>Number.isSafeInteger(e.journalSequence)&&mark.sequence!==null?e.journalSequence>mark.sequence:eventTime(e)>mark.at);
 const earliest=Math.min(...events.map(eventTime).filter(Number.isFinite)),incomplete=!events.length||earliest>mark.at||gaps.some(g=>g.end>=mark.at);
 const categories=[['Failures',after.filter(failed)],['Input requests',after.filter(e=>e.kind==='approval')],['Completion records',after.filter(e=>e.kind==='complete')]];
 const transitions=hosts.filter(h=>mark.hosts[h.id]&&mark.hosts[h.id]!==h.status).map(h=>({id:h.id,name:h.name||h.id,before:mark.hosts[h.id],after:h.status,at:h.sourceObservedAt||h.receivedAt}));
 return {after,categories,incomplete,transitions};
}

export function mountInvestigation({document,getData,restore,openDetails,eventHTML,onHandoff,onHistory}){
 const trail=new ContextTrail(),basket=new Map();let current=null,review=null,comparison=null,pinnedInspector=false,ownedDialog=false;
 const capsule=document.createElement('section');capsule.className='investigation-context';capsule.setAttribute('aria-label','Investigation context');
 capsule.innerHTML='<div class="context-reading"><b data-context-clock></b><span data-context-scope></span></div><div class="context-actions"><button data-investigation="live">Return to live</button><button data-investigation="clear">Clear scope</button><button data-investigation="back" disabled>Previous context</button><details><summary>Investigation tools</summary><div class="investigation-menu"><button data-investigation="anchor">Pin this context</button><button data-investigation="restore-anchor" disabled>Return to pinned context</button><button data-investigation="mark">Mark review point</button><button data-investigation="brief" disabled>Since review</button><button data-investigation="add">Pin selected evidence</button><button data-investigation="basket">Evidence basket (0)</button><button data-investigation="dock" aria-pressed="false">Dock inspector</button><button data-investigation="compare-pin">Pin comparison window</button><button data-investigation="compare" disabled>Compare windows</button></div></details></div>';
 document.querySelector('.waterfall-panel .panel-heading').append(capsule);
 const button=id=>capsule.querySelector('[data-investigation="'+id+'"]');
 const announce=text=>{document.getElementById('announcer').textContent=text;};
 const context=()=>({...getData().context,scroll:document.getElementById('span-list')?.scrollTop||0});
 const remember=()=>trail.push(current?{...current.context,scroll:document.getElementById('span-list')?.scrollTop||0}:context());
 function clear(){trail.clear();basket.clear();review=null;comparison=null;current=null;pinnedInspector=false;document.body.classList.remove('inspector-docked');if(ownedDialog&&document.getElementById('detail-dialog')?.open)document.getElementById('detail-dialog').close();ownedDialog=false;for(const b of capsule.querySelectorAll('button'))b.disabled=true;}
 function show(title,body){ownedDialog=true;openDetails(title,body);}
 const scopeNote=()=>'<p class="note">'+esc(scopeCaption(current.context,current.hosts,current.sessions))+' · '+(current.context.mode==='replay'?'Replay source clock':'Live source window')+'</p>';
 function rows(events){return events.slice(0,200).map(eventHTML).join('')||'<p class="empty">No matching records remain in this browser view.</p>';}
 function showBasket(){const available=new Map(current.events.map(e=>[e.id,e]));show('Evidence basket',scopeNote()+'<p class="note">'+basket.size+' pinned references, maximum 64. Collection continues. References do not duplicate or replace retained records.</p>'+[...basket].map(([id,reference])=>'<div class="basket-row">'+(available.has(id)?eventHTML(available.get(id)):'<p>Evidence '+esc(reference.short)+' is outside the browser cache. Load History on demand; no substitute is inferred.</p>')+'<button data-evidence-remove="'+esc(id)+'" aria-label="Remove pinned reference '+esc(reference.short)+'">Remove</button></div>').join('')+'<button data-evidence-handoff '+(!basket.size?'disabled':'')+'>Export available pins</button><button data-evidence-history>Open retained History</button>');}
 function showBrief(){if(dimensions(review.context)!==dimensions(current.context)||current.context.mode!=='live'){show('Since your review point','<p class="note">Return to the live scope and window in which the review point was marked, or mark a new review point. A changed scope is not treated as an absence of activity.</p>');return;}const b=reviewBrief(current.scopeEvents,review,{gaps:current.allGaps,hosts:current.hosts});if(!b)return;show('Since your review point',scopeNote()+'<p class="note">Review marked '+esc(timestamp(review.at))+'. '+(b.incomplete?'INCOMPLETE: the interval extends beyond browser coverage or contains a capture gap.':'Browser observations only; complete archive coverage is not asserted.')+' Completion records do not establish acceptance. Source transitions show the difference between review and now, not every intermediate transition.</p>'+b.categories.map(([label,events])=>'<details open><summary>'+label+' · '+events.length+'</summary>'+rows(events)+(events.length>200?'<p class="note">First 200 shown. Use the timeline or History for further records.</p>':'')+'</details>').join('')+'<h3>Source status changes · '+b.transitions.length+'</h3>'+b.transitions.map(h=>'<p>'+esc(h.name+' · '+h.before+' → '+h.after)+' · '+esc(timestamp(h.at))+'</p>').join('')+'<button data-evidence-history>Inspect retained History</button>');}
 function summarize(){return windowSummary(current.visible,current.context,{gaps:current.gaps,usage:current.usage});}
 function compare(){const next=summarize(),check=compareSummaries(comparison,next);show('Comparable-window lens',scopeNote()+'<p class="note">'+esc(check.reason)+'</p><table class="evidence-table"><thead><tr><th>Observed measure</th><th>Pinned window</th><th>Selected window</th></tr></thead><tbody>'+[['Source-clock end',timestamp(comparison.context.at),timestamp(next.context.at)],['Event records',comparison.count,next.count],['Failures',comparison.failures,next.failures],['Input requests',comparison.input,next.input],['Completion records',comparison.completed,next.completed],['Known capture gaps',comparison.gaps,next.gaps],['Model coverage',comparison.models.join(', ')||'Unavailable',next.models.join(', ')||'Unavailable']].map(r=>'<tr>'+r.map((v,i)=>'<'+(i?'td':'th')+'>'+esc(v)+'</'+(i?'td':'th')+'>').join('')+'</tr>').join('')+'</tbody></table><p class="note">Token-rate comparison is unavailable unless independently matched sampled windows exist. Event density is never substituted for tokens or provider speed.</p><button data-evidence-comparison>Inspect pinned source records</button>');}
 capsule.addEventListener('click',e=>{
  const b=e.target.closest('[data-investigation]');if(!b||b.disabled||!current)return;const action=b.dataset.investigation,c=context(),menu=b.closest('details');if(menu){menu.open=false;menu.querySelector('summary')?.focus();}
  if(action==='live'){remember();restore({...c,mode:'live'});}
  else if(action==='clear'){remember();restore({...c,host:'',project:'',session:'',category:'',search:'',event:''});}
  else if(action==='back'){const previous=trail.pop();if(previous)restore(previous);}
  else if(action==='anchor'){remember();trail.pin({...c,mode:'replay'});restore(trail.anchor);announce('Context pinned. Collection continues.');}
  else if(action==='restore-anchor'){remember();restore(trail.anchor);}
  else if(action==='mark'){review={at:Date.now(),context:c,sequence:Math.max(0,...current.events.map(e=>e.journalSequence).filter(Number.isSafeInteger))||null,hosts:Object.fromEntries(current.hosts.map(h=>[h.id,h.status]))};announce('Review point marked for this tab.');}
  else if(action==='brief')showBrief();
  else if(action==='add'){const selected=current.events.find(e=>e.id===c.event);if(!selected)announce('Select an event in the ribbon, timeline or inspector first.');else if(basket.size>=64&&!basket.has(selected.id))announce('The basket holds 64 references. Remove one before adding another.');else{basket.set(selected.id,{short:selected.id.slice(-12)});announce('Selected evidence pinned.');}}
  else if(action==='basket')showBasket();
  else if(action==='dock'){pinnedInspector=!pinnedInspector;document.body.classList.toggle('inspector-docked',pinnedInspector);const dialog=document.getElementById('inspector-dialog');if(pinnedInspector&&!dialog.open)dialog.show();}
  else if(action==='compare-pin'){comparison=summarize();announce('Comparison window pinned. Original records remain in capture storage.');}
  else if(action==='compare')compare();
  update();
 });
 capsule.addEventListener('keydown',e=>{if(e.key==='Escape'){const menu=capsule.querySelector('details[open]');if(menu){e.preventDefault();menu.open=false;menu.querySelector('summary')?.focus();}}});
 document.addEventListener('click',e=>{if(!capsule.contains(e.target)){const menu=capsule.querySelector('details[open]');if(menu)menu.open=false;}const b=e.target.closest('button');if(!b)return;if(b.hasAttribute('data-evidence-remove')){basket.delete(b.dataset.evidenceRemove);showBasket();update();}if(b.hasAttribute('data-evidence-handoff'))onHandoff(current.events.filter(e=>basket.has(e.id)));if(b.hasAttribute('data-evidence-history'))onHistory();if(b.hasAttribute('data-evidence-comparison')){const ids=new Set(comparison?.ids||[]);show('Pinned comparison evidence','<p class="note">Source records still available in the browser. Missing records require an on-demand History request.</p>'+rows(current.events.filter(e=>ids.has(e.id))));}});
 document.getElementById('detail-dialog')?.addEventListener('close',()=>ownedDialog=false);
 function update(){
  current=getData();if(!current?.context)return;if(current.authorized===false){clear();return;}for(const b of capsule.querySelectorAll('button'))b.disabled=false;
  if(trail.authorize(current.authority)){basket.clear();review=null;comparison=null;pinnedInspector=false;document.body.classList.remove('inspector-docked');if(ownedDialog)document.getElementById('detail-dialog')?.close();}
  const c=current.context,clock=(c.mode==='replay'?'REPLAY · '+new Date(c.at).toLocaleTimeString():c.paused?'VIEW PAUSED':'LIVE')+' · '+Math.round(c.windowMs/1000)+'s window';
  for(const [selector,value] of [['[data-context-clock]',clock],['[data-context-scope]',scopeCaption(c,current.hosts,current.sessions)]]){const n=capsule.querySelector(selector);if(n.textContent!==value)n.textContent=value;}
  button('mark').disabled=c.mode!=='live';button('back').disabled=!trail.items.length;button('restore-anchor').disabled=!trail.anchor;button('brief').disabled=!review;button('compare').disabled=!comparison;button('add').disabled=!c.event;button('dock').setAttribute('aria-pressed',String(pinnedInspector));button('basket').textContent='Evidence basket ('+basket.size+')';button('live').hidden=c.mode==='live'&&!c.paused;button('clear').hidden=!(c.host||c.project||c.session||c.category||c.search);capsule.dataset.mode=c.mode;
 }
 return {update,remember,invalidate:clear,scope:()=>current?scopeCaption(current.context,current.hosts,current.sessions):'Scope loading',get basket(){return [...basket.keys()];}};
}
