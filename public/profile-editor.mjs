// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const PHOTO_POLICY=Object.freeze({maxBytes:5*1024*1024,maxPixels:16000000,maxDimension:8192,storedDimension:256,types:['image/jpeg','image/png','image/webp']});
export async function prepareProfilePhoto(file){
 if(!file||!PHOTO_POLICY.types.includes(file.type)||file.size>PHOTO_POLICY.maxBytes)throw new Error('Choose a JPEG, PNG or WebP image up to 5 MiB.');
 const bitmap=await createImageBitmap(file);try{if(!bitmap.width||!bitmap.height||bitmap.width>8192||bitmap.height>8192||bitmap.width*bitmap.height>16000000)throw new Error('Choose an image up to 16 megapixels and 8192 pixels per side.');const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const ctx=canvas.getContext('2d'),size=Math.min(bitmap.width,bitmap.height);ctx.drawImage(bitmap,(bitmap.width-size)/2,(bitmap.height-size)/2,size,size,0,0,256,256);return canvas.toDataURL('image/png');}finally{bitmap.close();}
}
export function mountProfileEditor(slot,{request,onSaved=()=>{}}){
 let state=null,photo=null,operation=0,busy=false,dirty=false;
 const current=()=>slot.isConnected;
 const status=(message,error=false)=>{const node=slot.querySelector('[role=status]');if(node){node.textContent=message;node.dataset.error=String(error);}};
 function paint(){slot.innerHTML=`<form class="personal-profile-form"><div class="profile-photo-editor"><img alt="Your profile photo" ${photo?`src="${esc(photo)}"`:'hidden'}><span class="profile-photo-fallback" ${photo?'hidden':''} aria-hidden="true">◎</span><div><label for="profile-photo-file">Profile photo</label><input id="profile-photo-file" type="file" accept="image/jpeg,image/png,image/webp"><button type="button" data-remove-photo ${photo?'':'disabled'}>Remove photo</button></div></div><p class="field-help">JPEG, PNG or WebP · up to 5 MiB / 16 MP. Center-cropped to 256 × 256; metadata removed. Stored privately on your hub.</p><div class="profile-name-fields"><label>Your name<input name="name" autocomplete="name" maxlength="100" value="${esc(state.name)}"></label><label>Nickname<input name="nickname" autocomplete="nickname" maxlength="48" value="${esc(state.nickname)}"></label></div><p class="field-help">Nickname is used in the header. Your sign-in username and permissions stay separate.</p><div class="profile-save-row"><span role="status" aria-live="polite">Saved on your hub</span><button type="button" data-profile-reload>Reload</button><button type="submit" disabled>Save profile</button></div></form>`;}
 function changed(){dirty=true;slot.dataset.dirty='true';const button=slot.querySelector('[type=submit]');if(button)button.disabled=busy;status('Unsaved profile changes');}
 async function load(){
  const id=++operation,page=slot.ownerDocument,dialog=slot.closest?.('dialog'),active=page?.activeElement;
  const scrollTop=dialog?.scrollTop,scrollLeft=dialog?.scrollLeft,focused=slot.contains?.(active),open=()=>current()&&dialog?.open===true;
  const usable=node=>node&&node.isConnected!==false&&!node.disabled&&!node.closest?.('[hidden],[inert]')&&(!node.getClientRects||node.getClientRects().length>0);
  let moved=false,closed=false,moving=false,fallback=null;
  const movement=event=>{if(!moving&&event.target!==page?.body)moved=true;},key=event=>{if(['Tab','PageUp','PageDown','Home','End','ArrowUp','ArrowDown',' '].includes(event.key))moved=true;},close=()=>{closed=true;};
  if(focused){page?.addEventListener?.('focusin',movement);page?.addEventListener?.('pointerdown',movement);dialog?.addEventListener('wheel',movement);dialog?.addEventListener('touchmove',movement);page?.addEventListener?.('keydown',key);dialog?.addEventListener('close',close);dialog?.addEventListener('cancel',close);}
  slot.innerHTML='<p role="status">Loading your personal profile…</p>';
  if(focused&&open()){fallback=dialog.querySelector('[data-account-close]');if(usable(fallback)){moving=true;fallback.focus({preventScroll:true});moving=false;}}
  try{const value=await request('/api/profile');if(!current()||id!==operation)return;state=value;photo=value.photo;dirty=false;slot.dataset.dirty='false';paint();}
  catch{if(current()&&id===operation)slot.innerHTML='<p role="status">Your profile could not be loaded.</p><button type="button" data-profile-reload>Retry</button>';}
  finally{
   if(focused&&open()&&id===operation&&!moved&&!closed&&page.activeElement===fallback){const target=slot.querySelector('[data-profile-reload]');if(usable(target)){moving=true;dialog.scrollTop=scrollTop;dialog.scrollLeft=scrollLeft;target.focus();moving=false;}}
   if(focused){page?.removeEventListener?.('focusin',movement);page?.removeEventListener?.('pointerdown',movement);dialog?.removeEventListener('wheel',movement);dialog?.removeEventListener('touchmove',movement);page?.removeEventListener?.('keydown',key);dialog?.removeEventListener('close',close);dialog?.removeEventListener('cancel',close);}
  }
 }
 slot.addEventListener('input',e=>{if(['name','nickname'].includes(e.target.name))changed();});
 slot.addEventListener('change',async e=>{if(e.target.id!=='profile-photo-file'||!e.target.files?.[0])return;const id=++operation;busy=true;status('Preparing photo in this browser…');slot.querySelector('[type=submit]').disabled=true;try{const value=await prepareProfilePhoto(e.target.files[0]);if(!current()||id!==operation)return;photo=value;const image=slot.querySelector('img');image.src=photo;image.hidden=false;slot.querySelector('.profile-photo-fallback').hidden=true;slot.querySelector('[data-remove-photo]').disabled=false;dirty=true;}catch(error){if(current())status(error.message,true);}finally{busy=false;if(current()&&id===operation){slot.querySelector('[type=submit]').disabled=!dirty;if(dirty)changed();e.target.value='';}}});
 slot.addEventListener('click',e=>{if(e.target.closest('[data-profile-reload]')){if(busy)return;void load();}if(e.target.closest('[data-remove-photo]')&&!busy){operation++;photo=null;slot.querySelector('img').hidden=true;slot.querySelector('.profile-photo-fallback').hidden=false;e.target.disabled=true;changed();}});
 slot.addEventListener('submit',async e=>{e.preventDefault();if(!state||busy||!dirty)return;busy=true;const id=++operation,form=e.target;for(const input of form.querySelectorAll('input,button'))input.disabled=true;status('Saving profile…');try{const result=await request('/api/profile',{method:'PUT',body:{viewerId:state.viewerId,revision:state.revision,name:form.elements.name.value,nickname:form.elements.nickname.value,photo}});if(!current()||id!==operation)return;state=result;dirty=false;slot.dataset.dirty='false';status('Profile saved');onSaved(result);}catch(error){if(current()&&id===operation)status(error.status===409?'Another tab changed this profile. Reload before saving.':'Save could not be confirmed. Reload to check the hub before retrying.',true);}finally{busy=false;if(current()){for(const input of form.querySelectorAll('input,button'))input.disabled=false;form.querySelector('[type=submit]').disabled=!dirty;}}});
 void load();return {isDirty:()=>dirty};
}
