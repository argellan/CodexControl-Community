// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// SPDX-License-Identifier: MIT
// Author: Bishop Crockett; Owner: Argellan.com
export function mountLogin({document:page=globalThis.document,request=globalThis.fetch,navigate=path=>globalThis.location.assign(path)}={}){
 const field=id=>page.getElementById(id),account=field('account-login-form'),keys=field('login-form'),panel=field('key-login-panel'),hubLink=field('hub-login-link'),hubAddress=field('hub-login-address');
 let passwordLogin=false,busy=false,live=true,generation=0,pending=null;
 const usable=node=>node&&node.isConnected!==false&&!node.disabled&&!node.closest?.('[hidden],[inert]')&&(!node.getClientRects||node.getClientRects().length>0)&&page.defaultView?.getComputedStyle?.(node)?.visibility!=='hidden';
 const owns=(form,node)=>node===form||form.contains?.(node);
 function invalidate(){generation++;if(pending){pending.valid=false;if(live)pending.status.textContent='Sign-in changed. Wait for the current request to finish, then retry.';}}
 function movement(event){if(!pending||!event.target||event.target===page.body)return;pending.moved=true;const other=pending.form===account?keys:account;if(owns(other,event.target))invalidate();}
 function input(event){if(pending&&owns(pending.form,event.target))invalidate();}
 function keydown(event){if(!pending)return;if(event.key==='Tab')pending.moved=true;if(event.key==='Escape'&&pending.form===keys)invalidate();}
 const toggle=()=>{if(!panel.open&&pending?.form===keys)invalidate();},pagehide=()=>{live=false;invalidate();},pageshow=()=>{live=true;};
 page.addEventListener?.('focusin',movement);page.addEventListener?.('pointerdown',movement);page.addEventListener?.('input',input);page.addEventListener?.('keydown',keydown);
 panel?.addEventListener('toggle',toggle);page.defaultView?.addEventListener?.('pagehide',pagehide);page.defaultView?.addEventListener?.('pageshow',pageshow);
 async function submit(event,method){
  event.preventDefault();if(!live||busy||method==='password'&&!passwordLogin)return;
  const form=method==='password'?account:keys,status=field(method==='password'?'account-login-status':'login-status'),secret=field(method==='password'?'account-password':'access-key'),button=form.querySelector('button');
  const active=page.activeElement,transaction={id:++generation,form,status,valid:true,moved:false,focus:owns(form,active)?active:null};
  const current=()=>live&&pending===transaction&&transaction.valid&&transaction.id===generation;
  pending=transaction;busy=true;button.disabled=true;status.textContent='Checking accessâ€¦';let rejected=false;
  try{
   const body=method==='password'?{username:field('username').value,password:secret.value}:{token:secret.value};
   const response=await request('/api/session',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify(body)});
   if(!current())return;
   if(!response.ok){rejected=true;status.textContent=response.status===429?'Too many attempts. Wait before trying again.':response.status===503?(method==='key'?'Sign-in service is temporarily unavailable. Wait a moment, then retry this access key.':'Password sign-in is unavailable here. Use the authoritative hub or an access key.'):'Sign-in failed. Check your credentials and try again.';return;}
   secret.value='';status.textContent='Signed in.';navigate('/');
  }catch{if(current()){rejected=true;status.textContent='Sign-in could not be confirmed. Check the connection before trying again.';}}
  finally{
   button.disabled=method==='password'&&!passwordLogin;
   if(rejected&&current()&&!transaction.moved&&transaction.focus){const target=usable(transaction.focus)?transaction.focus:usable(secret)?secret:null;target?.focus({preventScroll:true});}
   if(pending===transaction){pending=null;busy=false;}
  }
 }
 const accountSubmit=event=>submit(event,'password'),keySubmit=event=>submit(event,'key');
 account.addEventListener('submit',accountSubmit);keys.addEventListener('submit',keySubmit);
 const ready=(async()=>{try{const response=await request('/api/auth/capabilities',{credentials:'same-origin'});if(!response.ok)throw new Error();const capabilities=await response.json();if(!live)return {passwordLogin};passwordLogin=capabilities.passwordLogin===true;field('password-login-note').textContent=passwordLogin?'Enter your username and password.':'This local gateway uses access keys. Your username and password are checked by the secure fleet hub.';
  if(!passwordLogin&&hubLink){try{const url=new URL(capabilities.passwordLoginUrl);if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error();hubLink.href=url.href;hubLink.hidden=false;if(hubAddress){hubAddress.textContent=url.host;hubAddress.hidden=false;}}catch{}}
  }catch{if(live)field('password-login-note').textContent='Account sign-in availability could not be verified. You can still use an access key.';}
  if(live){account.hidden=!passwordLogin;if(!passwordLogin)field('account-password').value='';account.querySelector('button').disabled=!passwordLogin;}return {passwordLogin};})();
 return {ready,destroy(){live=false;invalidate();account.removeEventListener?.('submit',accountSubmit);keys.removeEventListener?.('submit',keySubmit);page.removeEventListener?.('focusin',movement);page.removeEventListener?.('pointerdown',movement);page.removeEventListener?.('input',input);page.removeEventListener?.('keydown',keydown);panel?.removeEventListener?.('toggle',toggle);page.defaultView?.removeEventListener?.('pagehide',pagehide);page.defaultView?.removeEventListener?.('pageshow',pageshow);}};
}
if(typeof document!=='undefined')mountLogin();
