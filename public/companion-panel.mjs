// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.

// Presentation contract: no remote action is inferred from fleet observation.
// A future authenticated adapter can provide state; controls stay inert until wired.
export function buildDotPanelModel({desktop=null,hosts=[],recent=[]}={}){
 return {name:typeof desktop?.name==='string'&&desktop.name.trim()?desktop.name.trim().slice(0,64):'Dot',selected:!!desktop,devices:hosts.slice(0,12).map(h=>({name:h.name||h.label||h.id,status:h.status==='online'?'Reporting':h.status==='offline'?'Offline':'Unknown'})),recent:recent.slice(0,8)};
}
export function renderDotPanel(model){
 const unavailable='Not connected';
 return `<div class="dot-panel"><div class="dot-identity"><span class="companion-large" aria-hidden="true">Dot</span><div><h3>${esc(model.name)}</h3><span class="dot-status">${model.selected?'Desktop Dot':'Not connected'}</span></div><details class="dot-options"><summary aria-label="Dot options">•••</summary><div>${['Rename','Pause','Reboot','Delete'].map(label=>`<button type="button" disabled data-dot-action="${label.toLowerCase()}" title="${unavailable}">${label}</button>`).join('')}</div></details></div>
 <div class="dot-actions"><button type="button" disabled data-dot-action="call" title="${unavailable}">Call</button><button type="button" disabled data-dot-action="slack" title="${unavailable}">Slack</button></div>
 <details class="dot-call-controls"><summary>Call controls <small>Not connected</small></summary><div class="dot-actions"><button type="button" disabled data-dot-action="mute">Mute microphone</button><button type="button" disabled data-dot-action="end-call">End call</button></div></details>
 <button type="button" class="dot-computer" data-dot-action="computer" disabled title="${unavailable}"><b>${esc(model.name)}’s computer</b><small>Not connected</small></button>
 <section class="dot-section"><h4>Devices</h4>${model.devices.length?model.devices.map(d=>`<div class="dot-device"><span>${esc(d.name)}</span><small data-state="${d.status}">${d.status}</small></div>`).join(''):'<p>No devices</p>'}</section>
 <section class="dot-section"><h4>Recent activity</h4><p class="dot-empty">No connected Dot activity</p></section>
 <section class="dot-section"><h4>Outputs</h4><p class="dot-empty">No outputs</p></section>
 <details class="dot-secondary" data-dot-fleet><summary>Fleet activity <small>${model.recent.length} recent</small></summary>${model.recent.map(s=>`<button data-session="${esc(s.hostId+'/'+s.id)}" class="companion-worker"><b>${esc(s.nickname||s.id.slice(0,8))}</b><span>${esc(s.state||'Activity recorded')}</span><small>${esc(s.project)} · ${esc(s.hostName||s.hostId)}</small></button>`).join('')||'<p>No recent activity</p>'}</details>
 <details class="dot-secondary"><summary>Appearance</summary><label for="companion-sprite-file">Import spritesheet</label><input id="companion-sprite-file" type="file" accept="image/png,image/webp"><button type="button" id="companion-remove">Remove saved sprite</button><p id="companion-save-status" role="status" aria-live="polite"></p></details></div>`;
}
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function companionObservation(sessions=[],hosts=[],now=Date.now(),mode='live'){
 const online=new Set(hosts.filter(h=>h.status==='online').map(h=>h.id));
 const recent=sessions.filter(s=>online.has(s.hostId)&&Number.isFinite(Date.parse(s.lastEventAt))&&now-Date.parse(s.lastEventAt)>=0&&now-Date.parse(s.lastEventAt)<30000);
 return {state:mode==='replay'?'replay':recent.length?'activity':'quiet',label:mode==='replay'?'Replay view':recent.length?recent.length+' recent workers':'No recent activity',recent:recent.slice(0,8),voice:'unavailable'};
}
// Sprite images stay in this browser's IndexedDB, keyed to the authenticated
// viewer and deployment. They are never shipped in a release or broadcast.
async function imageStore(key,value){const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('codexcontrol-companion',1);r.onupgradeneeded=()=>r.result.createObjectStore('sprites');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{return await new Promise((resolve,reject)=>{const tx=db.transaction('sprites',value===undefined?'readonly':'readwrite'),store=tx.objectStore('sprites');const r=value===undefined?store.get(key):value===null?store.delete(key):store.put(value,key);tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(tx.error);});}finally{db.close();}}
export function mountCompanion({button,openDetails,getSessions=()=>[],getSnapshot=()=>null,getMode=()=>'live',getScope=()=>null,getMotion=()=>({}),request=route=>fetch(route).then(async r=>{if(!r.ok)throw new Error('Desktop artwork unavailable');return r.json();})}){
 let displayedBlob=null,localRows=9,sprite=null,identity=null,url=null,html='',observation=null,desktop=null,autoSprite=null,loading=null,attemptedKey=null,attemptedAt=0;

 let dialog=null,ownedPanel=null,returnFocus=null,fleetRevision='';
 const visible=node=>node&&node.isConnected!==false&&!node.disabled&&!node.closest?.('[hidden],[inert]')&&(!node.getClientRects||node.getClientRects().length>0)&&document.defaultView?.getComputedStyle?.(node)?.visibility!=='hidden';
 function restoreFocus(){
  if(!dialog||dialog.open||!ownedPanel?.isConnected)return;
  const active=document.activeElement;if(active&&active!==document.body&&!dialog.contains(active)&&visible(active))return;
  [returnFocus,button,document.querySelector?.('[data-mobile-action="jona-presence"]'),document.querySelector?.('[data-mobile-view="more"]')].find(visible)?.focus({preventScroll:true});
 }
 function updateFleet(next){
  if(!dialog?.open||!ownedPanel?.isConnected)return;
  const root=document.getElementById('detail-content'),fleet=ownedPanel.querySelector('[data-dot-fleet]'),caption=getScope();
  const note=root?.querySelector('.scope-note');if(typeof caption==='string'&&note&&note.textContent!==caption)note.textContent=caption;
  if(!fleet)return;
  const records=next.recent,key=JSON.stringify(records.map(s=>[s.hostId,s.id,s.nickname,s.state,s.project,s.hostName]));
  if(key===fleetRevision)return;fleetRevision=key;
  const active=document.activeElement,focused=fleet.contains(active),old=new Map([...fleet.querySelectorAll('[data-session]')].map(n=>[n.dataset.session,n])),keep=new Set(records.map(s=>s.hostId+'/'+s.id));
  for(const [id,node]of old)if(!keep.has(id))node.remove();
  if(records.length)fleet.querySelector('p')?.remove();
  for(const [i,s]of records.entries()){
   const id=s.hostId+'/'+s.id;let node=old.get(id);
   if(!node){node=document.createElement('button');node.type='button';node.className='companion-worker';node.dataset.session=id;for(const tag of ['b','span','small'])node.append(document.createElement(tag));}
   const values=[s.nickname||s.id.slice(0,8),s.state||'Activity recorded',(s.project||'')+' · '+(s.hostName||s.hostId)];
   for(const [j,tag]of ['b','span','small'].entries()){const child=node.querySelector(tag);if(child.textContent!==values[j])child.textContent=values[j];}
   if(fleet.children[i+1]!==node)fleet.insertBefore(node,fleet.children[i+1]||null);
  }
  if(!records.length&&!fleet.querySelector('p')){const empty=document.createElement('p');empty.textContent='No recent activity';fleet.append(empty);}
  fleet.querySelector('summary small').textContent=records.length+' recent';
  if(focused&&!active.isConnected)fleet.querySelector('summary')?.focus({preventScroll:true});
  else if(focused&&document.activeElement!==active&&visible(active))active.focus({preventScroll:true});
 }

 const sourceLabel=()=>desktop?.name?.trim()||'Dot';
 const revoke=()=>{if(url)URL.revokeObjectURL(url);url=null;};
 function applySprite(){const node=button.querySelector('.jona-placeholder');if(!node)return;const displayed=autoSprite||sprite;node.style.setProperty('--companion-rows',String(autoSprite?desktop.rows:localRows));if(displayed){if(displayedBlob!==displayed){revoke();displayedBlob=displayed;url=URL.createObjectURL(displayed);}node.textContent='';node.classList.add('companion-sprite');node.style.backgroundImage=`url("${url}")`;}else{revoke();displayedBlob=null;node.classList.remove('companion-sprite');node.style.backgroundImage='';node.textContent='Dot';}}
 async function scope(account){const viewer=account?.capabilities?.authenticated===true?account.viewer?.id:null,key=viewer?location.origin+'|'+viewer:null;
  if(key!==identity){identity=key;sprite=null;autoSprite=null;desktop=null;loading=null;attemptedKey=null;applySprite();if(key)try{const saved=await imageStore(key);if(key!==identity)return;sprite=saved?.blob||saved||null;localRows=saved?.rows||9;applySprite();}catch{/* A local override is optional. */}}
  if(!key)return;
  const choices=Array.isArray(account.desktopCompanions)?account.desktopCompanions:[],next=choices.filter(d=>typeof d?.hostId==='string'&&/^[-a-z0-9]{1,64}$/.test(d.hostId)&&/^[a-f0-9]{64}$/.test(d.artworkSha256)&&[9,11].includes(d.rows)).sort((a,b)=>String(b.observedAt).localeCompare(String(a.observedAt)))[0]||null;
  const wanted=next?next.hostId+'|'+next.artworkSha256:null,previous=desktop?desktop.hostId+'|'+desktop.artworkSha256:null;
  if(wanted!==previous){desktop=next;autoSprite=null;html='';applySprite();}
  desktop=next;
  if(!next||autoSprite||loading===wanted||attemptedKey===wanted&&Date.now()-attemptedAt<30000)return;
  loading=wanted;attemptedKey=wanted;attemptedAt=Date.now();
  try{const response=await request('/api/desktop/companion/artwork?hostId='+encodeURIComponent(next.hostId)+'&sha256='+next.artworkSha256);if(key!==identity||desktop?.artworkSha256!==next.artworkSha256||desktop?.hostId!==next.hostId)return;if(response.metadata?.artworkSha256!==next.artworkSha256||typeof response.artwork!=='string'||response.artwork.length>11184840||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(response.artwork))throw new Error('Invalid desktop artwork');const binary=atob(response.artwork.slice(22)),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0)),digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');if(digest!==next.artworkSha256)throw new Error('Desktop artwork checksum mismatch');const blob=new Blob([bytes],{type:'image/png'}),image=await createImageBitmap(blob);try{if(image.width!==1536||image.height!==next.rows*208)throw new Error('Invalid desktop sprite dimensions');}finally{image.close();}if(key!==identity||desktop?.hostId!==next.hostId||desktop?.artworkSha256!==next.artworkSha256)return;autoSprite=blob;applySprite();html='';update();}catch{/* Keep selection visible; retry on a later existing account refresh. */}finally{if(loading===wanted)loading=null;}
 }


 function update(){const next=companionObservation(getSessions(),getSnapshot()?.hosts||[],Date.now(),getMode());observation=next;updateFleet(next);const motion=getMotion(),suspended=!!(document.hidden||motion.reduced||motion.paused);
  if(suspended){if(button.dataset.suspended!=='true')button.dataset.suspended='true';}else delete button.dataset.suspended;
  // Publish state only on change; unrelated live DOM edits need no root :has scan.
  const rootState=document.documentElement?.dataset;if(rootState){if(rootState.dotActivity!==next.state)rootState.dotActivity=next.state;if(rootState.dotSuspended!==String(suspended))rootState.dotSuspended=String(suspended);}
  const key=next.state+'|'+next.label+'|'+sourceLabel()+'|'+!!autoSprite;if(key===html)return;html=key;button.dataset.presence=next.state;button.querySelector('.presence-unavailable').textContent=next.label;const label=button.querySelector('b');if(label)label.textContent=sourceLabel();button.setAttribute('aria-label','Open '+sourceLabel()+' controls');}
 function open(){const opener=document.activeElement;update();const model=buildDotPanelModel({desktop,hosts:getSnapshot()?.hosts||[],recent:observation.recent});openDetails(sourceLabel(),renderDotPanel(model));
  const root=document.getElementById('detail-content'),large=root.querySelector('.companion-large'),nextDialog=root.closest('dialog');ownedPanel=root.querySelector('.dot-panel');returnFocus=opener;fleetRevision='';if(nextDialog!==dialog){dialog?.removeEventListener('close',restoreFocus);dialog=nextDialog;dialog?.addEventListener('close',restoreFocus);}updateFleet(observation);if(url){large.style.setProperty('--companion-rows',String(autoSprite?desktop.rows:localRows));large.classList.add('companion-sprite');large.style.backgroundImage=`url("${url}")`;large.textContent='';}
  const status=root.querySelector('#companion-save-status');root.querySelector('#companion-sprite-file').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;if(!identity){status.textContent='Sign in to save a personal sprite.';return;}const key=identity;try{if(!['image/png','image/webp'].includes(file.type)||file.size>8*1024*1024)throw new Error('Choose a PNG or WebP spritesheet up to 8 MiB.');const image=await createImageBitmap(file);try{if(image.width!==1536||![1872,2288].includes(image.height))throw new Error('Choose a 1536 × 1872 or 1536 × 2288 spritesheet.');const canvas=document.createElement('canvas');canvas.width=1536;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.9));if(!blob||blob.size>8*1024*1024)throw new Error('Prepared sprite is too large.');if(key!==identity)return;await imageStore(key,{blob,rows:image.height/208});localRows=image.height/208;sprite=blob;applySprite();large.style.setProperty('--companion-rows',String(autoSprite?desktop.rows:localRows));large.classList.add('companion-sprite');large.style.backgroundImage=`url("${url}")`;large.textContent='';status.textContent='Sprite saved for this browser and account.';}finally{image.close();}}catch(error){status.textContent=error.message;}finally{e.target.value='';}});
  root.querySelector('#companion-remove').addEventListener('click',async()=>{try{if(identity)await imageStore(identity,null);sprite=null;applySprite();if(url){large.classList.add('companion-sprite');large.style.backgroundImage=`url("${url}")`;large.style.setProperty('--companion-rows',String(autoSprite?desktop.rows:localRows));large.textContent='';}else{large.classList.remove('companion-sprite');large.style.backgroundImage='';large.textContent='Dot';}status.textContent='Saved sprite removed.';}catch{status.textContent='Sprite removal could not be confirmed.';}});
 }
 button.addEventListener('click',open);document.addEventListener('visibilitychange',update);update();return {update,setAccount:account=>{void scope(account).then(update);} };
}
