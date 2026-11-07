// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
// Row positions are derived only from delivered border boxes and DOM order.
// No animation frame reads layout, and no source row is removed or virtualized.
export class TimelineVisibility {
 constructor(root,onChange,{ResizeObserver=globalThis.ResizeObserver,margin=40}={}){
  this.root=root;this.onChange=onChange;this.margin=margin;this.rows=[];this.heights=new Map();this.height=0;this.scrollTop=0;
  this.observer=new ResizeObserver(entries=>{for(const entry of entries){if(entry.target===root){this.height=entry.contentRect.height;this.scrollTop=root.scrollTop;}else{const box=entry.borderBoxSize?.[0]??entry.borderBoxSize;if(Number.isFinite(box?.blockSize))this.heights.set(entry.target,box.blockSize);else this.heights.set(entry.target,Infinity);}}this.update();});
  this.observer.observe(root);this.scroll=()=>{this.scrollTop=root.scrollTop;this.update();};root.addEventListener('scroll',this.scroll,{passive:true});
 }
 observe(){} // Registration is batched after the complete ordered projection.
 unobserve(element){this.observer.unobserve(element);this.heights.delete(element);}
 setRows(rows){const previous=new Set(this.rows.map(row=>row.element));this.rows=rows;for(const row of rows)if(!previous.has(row.element))this.observer.observe(row.element,{box:'border-box'});this.update();}
 update(){let top=0,maximumTop=0,changed=false;const start=this.scrollTop-this.margin,end=this.scrollTop+this.height+this.margin;
  // A just-inserted row may already be on screen before ResizeObserver delivers
  // its border box. Unknown geometry stays drawable until the next observation.
  for(const row of this.rows){const measured=this.heights.has(row.element),height=this.heights.get(row.element)??Infinity,visible=!this.height||!Number.isFinite(top)||(!Number.isFinite(maximumTop)||!Number.isFinite(height)||maximumTop+height>=start)&&top<=end;top+=measured?height:0;maximumTop+=height;if(row.visible!==visible){row.visible=visible;row.element.classList.toggle('in-view',visible);changed=true;}}
  if(changed)this.onChange();
 }
 disconnect(){this.observer.disconnect();this.root.removeEventListener('scroll',this.scroll);this.rows=[];this.heights.clear();}
}
