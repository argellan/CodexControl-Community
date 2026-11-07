// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Observation evidence only. Never confers installation or execution authority.
export function deviceEnrollmentState(source={},now=Date.now()){
 const active=source.status==='active'&&!source.disabled&&(!source.expiresAt||Date.parse(source.expiresAt)>now),o=source.observed||{};
 const same=Number.isSafeInteger(source.credentialGeneration)&&o.credentialGeneration===source.credentialGeneration;
 const reporting=!active?'blocked':same&&o.status==='online'?'reporting':same&&['stale','disconnected'].includes(o.status)?o.status:'waiting';
 const capture=reporting==='reporting'&&o.reportedSessionCount>0?'session metadata observed':reporting==='reporting'&&source.role==='execution-target'&&o.telemetry?'machine telemetry reported':'not verified';
 return {checkedAt:new Date(now).toISOString(),access:active?'authorized':source.status||'unknown',reporting,capture,lastAcceptedReport:same?o.receivedAt||null:null,installation:'not independently verified',startup:'not verified',control:'unavailable',archive:'not verified',generation:source.credentialGeneration??null};
}
export function mergeDeviceHosts(hosts=[],metadata=[]){
 const byId=new Map(metadata.map(h=>[h.id,h]));
 return hosts.map(h=>({...h,...(byId.get(h.id)||{}),id:h.id,tokenHash:h.tokenHash,disabled:h.disabled,expiresAt:h.expiresAt,role:h.role,credentialGeneration:h.credentialGeneration??1,expectedHostname:h.expectedHostname??null,enrollmentRequestId:h.enrollmentRequestId??null}));
}
export function buildDeviceEnrollmentRequest(d={},revision,requestId){
 const id=d.id||String(d.label||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64);
 if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)||!String(d.label||'').trim())throw new Error('Enter a device name and lowercase stable ID.');
 if(!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(d.expectedHostname||'')||(d.expectedHostname||'').includes('..'))throw new Error('Enter the independently confirmed expected hostname.');
 if(d.replace&&!d.confirmReplacement)throw new Error('Confirm that replacing this credential disconnects the existing collector.');
 if(!['codex-source','execution-target'].includes(d.role||'codex-source'))throw new Error('Choose a reporting purpose.');
 const host={id,label:d.label,expectedHostname:d.expectedHostname,role:d.role||'codex-source',deviceClass:d.deviceClass||'workstation',preferredAddress:d.preferredAddress||null,alternateAddresses:Array.isArray(d.alternateAddresses)?[...d.alternateAddresses]:String(d.alternateAddresses||'').split(/\r?\n/).map(v=>v.trim()).filter(Boolean)};
 return {path:d.replace?'/api/admin/sources/'+encodeURIComponent(d.id)+'/replace':'/api/admin/sources/enroll',body:{revision,requestId,host,...(d.replace?{expectedGeneration:d.expectedGeneration}:{})}};
}


const pendingSetupKey='argellan-device-setup-pending-v1';
const setupUuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function clearPendingDeviceSetup(storage){try{(storage??globalThis.sessionStorage)?.removeItem(pendingSetupKey);}catch{}}
export function savePendingDeviceSetup(value,storage,now=Date.now()){
 try{if(!setupUuid.test(value?.requestId)||!setupUuid.test(value?.instanceId)||!/^[-a-z0-9_]{1,64}$/.test(value?.actorId)||!/^[-a-z0-9]{1,64}$/.test(value?.hostId))return;
  (storage??globalThis.sessionStorage)?.setItem(pendingSetupKey,JSON.stringify({requestId:value.requestId,actorId:value.actorId,instanceId:value.instanceId,hostId:value.hostId,expiresAt:now+900000}));
 }catch{}
}
export function readPendingDeviceSetup(storage,now=Date.now(),identity){
 try{const raw=(storage??globalThis.sessionStorage)?.getItem(pendingSetupKey);if(!raw)return null;
  const value=raw.length<=1024?JSON.parse(raw):null;
  if(!value||Object.keys(value).some(k=>!['requestId','actorId','instanceId','hostId','expiresAt'].includes(k))||!setupUuid.test(value.requestId)||!setupUuid.test(value.instanceId)||!/^[-a-z0-9_]{1,64}$/.test(value.actorId)||!/^[-a-z0-9]{1,64}$/.test(value.hostId)||!Number.isFinite(value.expiresAt)||value.expiresAt<=now||value.expiresAt>now+900000||identity&&(identity.actorId!==value.actorId||identity.instanceId!==value.instanceId)){clearPendingDeviceSetup(storage);return null;}return value;
 }catch{clearPendingDeviceSetup(storage);return null;}
}
