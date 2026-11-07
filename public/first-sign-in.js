// Author: Bishop Crockett; Owner: Argellan.com; SPDX-License-Identifier: MIT
const field=id=>document.getElementById(id),form=field('first-sign-in-form'),status=field('setup-status'),button=form.querySelector('button'),secrets=['temporary-password','personal-password','confirm-password'].map(field);
let busy=false,live=true;
addEventListener('pagehide',()=>{live=false;for(const input of secrets)input.value='';},{once:true});
addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
field('show-passwords').addEventListener('change',event=>{for(const input of secrets)input.type=event.target.checked?'text':'password';});
field('setup-sign-out').addEventListener('click',async()=>{if(busy)return;busy=true;try{const response=await fetch('/api/session/logout',{method:'POST',credentials:'same-origin'});if(response.ok)location.assign('/');else status.textContent='Sign out could not be confirmed. Try again.';}catch{status.textContent='Check the connection and try again.';}finally{busy=false;}});
form.addEventListener('submit',async event=>{
 event.preventDefault();if(busy||!live)return;
 const [temporary,password,confirmation]=secrets;
 for(const input of secrets)input.removeAttribute('aria-invalid');
 if(password.value!==confirmation.value){confirmation.setAttribute('aria-invalid','true');status.textContent='The new passwords do not match.';confirmation.focus();return;}
 if([...password.value].length<12||[...password.value].length>128){password.setAttribute('aria-invalid','true');status.textContent='Use a password with 12–128 characters.';password.focus();return;}
 if(password.value===temporary.value){password.setAttribute('aria-invalid','true');status.textContent='Choose a password different from the temporary password.';password.focus();return;}
 const usernameValue=field('setup-username').value,currentValue=temporary.value,newValue=password.value;
 busy=true;button.disabled=true;for(const input of secrets)input.disabled=true;status.textContent='Saving your password…';let changed=false;
 try{
  const response=await fetch('/api/settings/password',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({currentPassword:currentValue,newPassword:newValue})});
  if(!live)return;
  if(!response.ok){status.textContent=response.status===401?'Sign in again to finish setup.':response.status===429?'Too many attempts. Wait a moment before trying again.':'Your password was not changed. Check the temporary password and try again.';return;}
  changed=true;
  const signed=await fetch('/api/session',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({username:usernameValue,password:newValue})});
  for(const input of secrets)input.value='';
  if(!live)return;
  if(signed.ok)location.assign('/');else{status.textContent='Password saved. Sign in with your new password.';location.assign('/');}
 }catch{if(live)status.textContent=changed?'Password saved. Sign in with your new password.':'The result could not be confirmed. Try signing in with your new password before submitting again.';}
 finally{if(live){busy=false;button.disabled=false;for(const input of secrets)input.disabled=false;}}
});
try{const response=await fetch('/api/auth/first-sign-in',{credentials:'same-origin'});if(response.status===401)location.assign('/');else if(response.ok){const account=await response.json();if(!account.required)location.assign('/');else field('setup-username').value=account.username||'admin';}else status.textContent='Setup could not be loaded. Refresh to try again.';}catch{status.textContent='Check the connection, then refresh.';}
