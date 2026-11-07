// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
// Only visible panel chrome contributes to the workspace minimum. Retained
// records inside scroll containers must never determine the page's height.
export function workspaceMinimum({stage=0,mapChrome=0,timelineChrome=0,timelineContent=0,timelineFloor=0,divider=0,flowOnly=false}={}){
 const safe=n=>typeof n==='number'&&Number.isFinite(n)?Math.max(0,n):0;
 const map=Math.ceil(safe(stage)+safe(mapChrome)),timeline=flowOnly?0:Math.ceil(Math.max(safe(timelineFloor),safe(timelineChrome)+safe(timelineContent)));
 return {map,timeline,total:map+timeline+(flowOnly?0:safe(divider))};
}
export function mountWorkspaceSizing({document,window}){
 const cockpit=document.getElementById('cockpit'),stack=cockpit?.querySelector('.center-stack'),panel=stack?.querySelector('.waterfall-panel'),timeline=stack?.querySelector('.timeline-panel'),stage=panel?.querySelector('.waterfall-stage'),divider=document.getElementById('waterfall-splitter');
 if(!cockpit||!stack||!panel||!timeline||!stage)return {destroy(){}};
 let pending=null,closed=false,last='';
 const height=node=>{if(!node)return 0;const style=window.getComputedStyle(node);return style.display==='none'?0:node.getBoundingClientRect().height+(parseFloat(style.marginTop)||0)+(parseFloat(style.marginBottom)||0);};
 const chrome=(node,exclude)=>Array.from(node.children).filter(child=>!exclude(child)).reduce((sum,child)=>sum+height(child),0);
 function update(){pending=null;if(closed)return;
  // Batch all geometry reads before changing any constraint. This runs only
  // after resize/font/chrome changes, never in the token animation loop.
  const stageStyle=window.getComputedStyle(stage),panelStyle=window.getComputedStyle(panel),timelineStyle=window.getComputedStyle(timeline),flowOnly=stack.classList.contains('flow-only');
  const border=(parseFloat(panelStyle.borderTopWidth)||0)+(parseFloat(panelStyle.borderBottomWidth)||0)+(parseFloat(panelStyle.paddingTop)||0)+(parseFloat(panelStyle.paddingBottom)||0);
  const value=workspaceMinimum({stage:parseFloat(stageStyle.minHeight)||196,mapChrome:chrome(panel,child=>child===stage)+border,timelineChrome:chrome(timeline,child=>child.matches('.span-list,.event-feed,.turn-groups'))+(parseFloat(timelineStyle.borderTopWidth)||0)+(parseFloat(timelineStyle.borderBottomWidth)||0),timelineFloor:(parseFloat(window.getComputedStyle(document.documentElement).fontSize)||14)*12,timelineContent:(parseFloat(timelineStyle.fontSize)||14)*4,divider:height(divider),flowOnly});
  const signature=JSON.stringify(value);if(signature===last)return;last=signature;
  cockpit.style.setProperty('--map-pane-min-height',value.map+'px');cockpit.style.setProperty('--timeline-pane-min-height',value.timeline+'px');cockpit.style.setProperty('--workspace-min-height',value.total+'px');
 }
 const schedule=()=>{if(pending===null&&!closed)pending=window.requestAnimationFrame(update);};
 const observer=new window.ResizeObserver(schedule);for(const element of [cockpit,panel,stage,timeline,divider,...panel.children,...timeline.children])if(element)observer.observe(element);
 window.addEventListener('resize',schedule);document.fonts?.addEventListener?.('loadingdone',schedule);schedule();
 return {destroy(){closed=true;observer.disconnect();if(pending!==null)window.cancelAnimationFrame(pending);window.removeEventListener('resize',schedule);document.fonts?.removeEventListener?.('loadingdone',schedule);}};
}
