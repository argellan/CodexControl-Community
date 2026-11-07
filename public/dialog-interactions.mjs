// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// One dismissal contract for static and dynamically mounted dialogs. A drag
// beginning inside a dialog never becomes a backdrop click on release.
export function outsideBounds(dialog,x,y){const r=dialog.getBoundingClientRect();return x<r.left||x>r.right||y<r.top||y>r.bottom;}
export function installDialogDismissal(document){
 let pending=[];
 const down=e=>{pending=[];if(e.button!==0)return;for(const dialog of document.querySelectorAll('dialog[open]'))if(outsideBounds(dialog,e.clientX,e.clientY))pending.push({dialog,pointerId:e.pointerId});};
 const up=e=>{const candidates=pending;pending=[];for(const {dialog,pointerId} of candidates){if(pointerId!==e.pointerId||!dialog.open||!outsideBounds(dialog,e.clientX,e.clientY))continue;const cancel=new Event('cancel',{cancelable:true});if(dialog.dispatchEvent(cancel))dialog.close();}};
 const clear=()=>{pending=[];};document.addEventListener('pointerdown',down,true);document.addEventListener('pointerup',up,true);document.addEventListener('pointercancel',clear,true);
 return ()=>{document.removeEventListener('pointerdown',down,true);document.removeEventListener('pointerup',up,true);document.removeEventListener('pointercancel',clear,true);};
}
