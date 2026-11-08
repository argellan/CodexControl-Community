// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
/**
 * Adaptive navigation shares the existing panels, handlers and authorized data.
 * No second data store, polling loop or persisted desktop preference is created.
 */
export const MOBILE_VIEWS = Object.freeze(['overview','fleet','activity','more']);
export function adaptiveOverviewMode(savedMode,adaptive){return adaptive?'full':savedMode;}
export function mobileViewFromHash(hash='') {
 const view=String(hash).replace(/^#view-/,'');
 return MOBILE_VIEWS.includes(view)?view:'overview';
}
// Match the responsive CSS without forcing a layout read during an update.
export function adaptivePanels({adaptive=false,width=0,height=0,view='overview',mapOpen=false}={}) {
 if(!adaptive)return {workers:true,timeline:true,map:true,inspector:true};
 if(view==='fleet')return {workers:true,timeline:false,map:false,inspector:false};
 if(view==='activity')return {workers:false,timeline:true,map:false,inspector:false};
 if(view==='more')return {workers:false,timeline:false,map:false,inspector:false};
 const single=width<=700||height<=500;
 return {workers:!single,timeline:!single||!mapOpen,map:!single||mapOpen,inspector:false};
}
export function mountMobileWorkspace({document,window,onViewChange=()=>{}}) {
 const root=document.documentElement,nav=document.getElementById('mobile-navigation'),
 heading=document.getElementById('mobile-page-title'),filters=document.getElementById('mobile-filters');
 if(!nav||!heading||!filters)return {syncScope(){},destroy(){}};
 const media=window.matchMedia('(max-width:1100px)'),saved=[];
 let view=mobileViewFromHash(window.location.hash),eventsInitialized=false;
 const scope=document.getElementById('mobile-scope'),alertCount=document.getElementById('mobile-alert-count'),alertSource=document.getElementById('alerts-total');
 const syncScope=()=>{if(!scope)return;const selected=id=>{const e=document.getElementById(id);return e?.selectedOptions?.[0]?.textContent||'';};scope.textContent=[selected('window'),selected('host-filter'),document.getElementById('project-filter')?.value?selected('project-filter'):'',document.getElementById('category-filter')?.value?selected('category-filter'):''].filter(Boolean).join(' · ');};
 const syncAlerts=()=>{if(!alertCount)return;const count=Number(alertSource?.textContent)||0;alertCount.hidden=count===0;const text=count+' alert'+(count===1?'':'s');if(alertCount.textContent!==text)alertCount.textContent=text;};
 const observer=new window.MutationObserver(syncAlerts);if(alertSource)observer.observe(alertSource,{childList:true,characterData:true,subtree:true});syncAlerts();
 const move=(id,destination)=>{
  const node=document.getElementById(id),slot=document.getElementById(destination);
  if(!node||!slot)return;
  const marker=document.createComment('adaptive placement: '+id);node.before(marker);saved.push([node,marker,slot]);
 };
 move('connection','mobile-source-status');move('header-view-menu','mobile-appearance');
 function paint({focus=false}={}) {
  root.dataset.mobileView=view;
  heading.textContent=view[0].toUpperCase()+view.slice(1);
  for(const button of nav.querySelectorAll('[data-mobile-view]')) {
   if(window.location.hash!=='#usage'&&button.dataset.mobileView===view)button.setAttribute('aria-current','page');
   else button.removeAttribute('aria-current');
  }
  filters.hidden=view==='more';if(scope)scope.hidden=view==='more';syncScope();
  root.dataset.mobileFilters='closed';filters.setAttribute('aria-expanded','false');
  if(media.matches&&!eventsInitialized){
   eventsInitialized=true;document.getElementById('events-tab')?.click();
  }
  if(focus&&media.matches){heading.focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}onViewChange();
 }
 function select(next) {
  if(!MOBILE_VIEWS.includes(next))return;
  if(next!==view){view=next;window.history.pushState(null,'','#view-'+view);}
  paint({focus:true});
 }
 function click(event){
  const destination=event.target.closest('button[data-mobile-view]');if(destination){select(destination.dataset.mobileView);return;}
  const action=event.target.closest('[data-mobile-action]');
  if(action){const target=document.getElementById(action.dataset.mobileAction);if(target&&!target.disabled){target.click();if(action.dataset.mobileAction==='live')select('overview');}}
 }
 const mapButton=document.getElementById('mobile-map-toggle');
 const mapToggle=()=>{const open=mapButton.getAttribute('aria-pressed')!=='true';mapButton.setAttribute('aria-pressed',String(open));mapButton.setAttribute('aria-label',open?'Show activity list':'Show observation map');mapButton.textContent=open?'Activity':'Map';root.dataset.mobileMap=open?'open':'closed';onViewChange();};
 mapButton?.addEventListener('click',mapToggle);
 const toggle=()=>{const open=filters.getAttribute('aria-expanded')!=='true';filters.setAttribute('aria-expanded',String(open));root.dataset.mobileFilters=open?'open':'closed';};
 const pop=()=>{view=mobileViewFromHash(window.location.hash);paint({focus:media.matches});};
 const responsive=()=>{
  for(const [node,marker,slot] of saved){if(media.matches)slot.append(node);else marker.after(node);}
  paint();
 };
 document.addEventListener('click',click);document.addEventListener('change',syncScope);filters.addEventListener('click',toggle);
 window.addEventListener('popstate',pop);media.addEventListener('change',responsive);responsive();
 return {syncScope,destroy(){
  document.removeEventListener('click',click);document.removeEventListener('change',syncScope);observer.disconnect();filters.removeEventListener('click',toggle);
  window.removeEventListener('popstate',pop);media.removeEventListener('change',responsive);
  for(const [node,marker] of saved){marker.after(node);marker.remove();}
  mapButton?.removeEventListener('click',mapToggle);delete root.dataset.mobileMap;
  delete root.dataset.mobileView;delete root.dataset.mobileFilters;
 }};
}
