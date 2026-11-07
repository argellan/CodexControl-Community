// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import crypto from 'node:crypto';
import {normalizeUsername,validPasswordHash,verifyPassword} from './password-auth.mjs';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const idPattern=/^[a-z0-9][a-z0-9_-]{0,63}$/;
const hostPattern=/^[-a-z0-9]{1,64}$/;
const tokenHashPattern=/^[a-f0-9]{64}$/i;
const fail=message=>{throw new Error(message);};
const clone=value=>structuredClone(value);
const fields=(value,names)=>Object.fromEntries(names.filter(k=>value&&Object.hasOwn(value,k)).map(k=>[k,clone(value[k])]));
const validHash=value=>typeof value==='string'&&tokenHashPattern.test(value);
const immutableViewer=(id,label,hostIds,projectIds=null,role='viewer',expiresAt=null,username=null,passwordEnabled=false,passwordChangeRequired=false)=>Object.freeze({id,label,role,expiresAt,username,passwordEnabled,passwordChangeRequired,hostIds:hostIds===null?null:Object.freeze([...hostIds]),projectIds:projectIds===null?null:Object.freeze([...projectIds]),profileKey:hash('codex-control/display-profile/v1/'+id)});
const authorized=(viewer,hostId)=>typeof hostId==='string'&&hostId.length>0&&!!viewer&&(viewer.hostIds===null||Array.isArray(viewer.hostIds)&&viewer.hostIds.includes(hostId));
const authorizedProject=(viewer,project)=>!!viewer&&(viewer.projectIds===null||Array.isArray(viewer.projectIds)&&viewer.projectIds.includes(project));

export class ViewerAccess {
 #secret;
 #sessions;
 #entries=new Map();
 #handles=new Map();
 #requiredLogin=false;
 #local=immutableViewer('local','Local viewer',null);
 constructor({viewTokenHash,viewers=[],secret,sessions=new Map()}={}){
  if(viewTokenHash!==undefined&&viewTokenHash!==null&&!validHash(viewTokenHash))fail('Invalid shared viewer credential hash');
  if(!Array.isArray(viewers)||viewers.length>64)fail('Invalid viewer configuration');
  const key=secret===undefined?crypto.randomBytes(32):typeof secret==='string'?Buffer.from(secret,'utf8'):Buffer.isBuffer(secret)?Buffer.from(secret):null;
  if(!key||key.length<32||key.length>256)fail('Invalid viewer signing secret');
  this.#secret=key;this.#sessions=sessions;
  const seenCredentials=new Set(),seenUsernames=new Set();
  const add=(viewer,tokenHash,passwordHash=null)=>{
   const digest=tokenHash?.toLowerCase()||null;
   if(digest&&seenCredentials.has(digest))fail('Ambiguous duplicate viewer credential');
   if(digest)seenCredentials.add(digest);
   const handle=crypto.createHmac('sha256',this.#secret).update(JSON.stringify(['viewer-handle/v3',viewer.id,digest,viewer.hostIds,viewer.projectIds,viewer.role,viewer.expiresAt,viewer.username,passwordHash,viewer.passwordChangeRequired])).digest('hex');
   const entry={viewer,tokenHash:digest,passwordHash,handle};this.#entries.set(viewer.id,entry);this.#handles.set(handle,entry);
  };
  for(const v of viewers){
   if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['id','label','tokenHash','hostIds','projectIds','role','expiresAt','disabled','username','passwordHash','passwordChangeRequired'].includes(k)))fail('Unsupported viewer configuration');
   if(typeof v.id!=='string'||!idPattern.test(v.id)||['local','legacy'].includes(v.id))fail('Invalid viewer identity');
   if(this.#entries.has(v.id))fail('Duplicate viewer identity');
   if(typeof v.label!=='string'||!v.label.trim()||v.label.length>120||/[\x00-\x1f\x7f]/.test(v.label))fail('Invalid viewer label');
   if(!validHash(v.tokenHash))fail('Invalid viewer credential hash');
   if(v.hostIds!==null&&(!Array.isArray(v.hostIds)||v.hostIds.length>64||v.hostIds.some(h=>typeof h!=='string'||!hostPattern.test(h))))fail('Invalid viewer host scope');
   if(Array.isArray(v.hostIds)&&new Set(v.hostIds).size!==v.hostIds.length)fail('Duplicate viewer host scope');
   if(v.projectIds!==undefined&&v.projectIds!==null&&(!Array.isArray(v.projectIds)||v.projectIds.length>64||v.projectIds.some(p=>typeof p!=='string'||!p||p.length>160||/[\x00-\x1f\x7f]/.test(p))||new Set(v.projectIds).size!==v.projectIds.length))fail('Invalid viewer project scope');
   if(v.role!==undefined&&!['viewer','admin'].includes(v.role))fail('Invalid viewer role');
   if(v.role==='admin'&&(v.hostIds!==null||v.projectIds!==undefined&&v.projectIds!==null))fail('Administrator requires fleet scope');
   if(v.expiresAt!==undefined&&v.expiresAt!==null&&!Number.isFinite(Date.parse(v.expiresAt)))fail('Invalid viewer expiry');
   if(v.disabled!==undefined&&typeof v.disabled!=='boolean')fail('Invalid viewer status');
   let username=null;if(v.username!==undefined&&v.username!==null){try{username=normalizeUsername(v.username);}catch{fail('Invalid viewer username');}if(seenUsernames.has(username))fail('Duplicate viewer username');seenUsernames.add(username);}
   const passwordHash=v.passwordHash??null;if(passwordHash!==null&&(!username||!validPasswordHash(passwordHash)))fail('Invalid viewer password verifier');
   if(v.passwordChangeRequired!==undefined&&(typeof v.passwordChangeRequired!=='boolean'||v.passwordChangeRequired&&!passwordHash))fail('Invalid initial password state');
   add(immutableViewer(v.id,v.label.trim(),v.hostIds,v.projectIds??null,v.role||'viewer',v.disabled?'1970-01-01T00:00:00.000Z':v.expiresAt||null,username,!!passwordHash,v.passwordChangeRequired===true),v.tokenHash,passwordHash);
  }
  if(viewTokenHash)add(immutableViewer('legacy','Shared viewer',null),viewTokenHash);
  this.#requiredLogin=!!viewTokenHash||viewers.length>0;
  if(!this.#requiredLogin)add(this.#local,null);
 }
 get requiredLogin(){return this.#requiredLogin;}
 get localViewer(){return this.#local;}
 authenticateBearer(token){
  if(typeof token!=='string'||!token||token.length>4096||/[\x00-\x1f\x7f]/.test(token))return null;
  const digest=crypto.createHash('sha256').update(token).digest();let match=null;
  for(const entry of this.#entries.values())if(entry.tokenHash&&(!entry.viewer.expiresAt||Date.parse(entry.viewer.expiresAt)>Date.now())&&crypto.timingSafeEqual(digest,Buffer.from(entry.tokenHash,'hex')))match=entry.viewer;
  return match;
 }
 async authenticatePassword(username,password){
  let normalized=null;try{normalized=normalizeUsername(username);}catch{}
  const entry=normalized?[...this.#entries.values()].find(value=>value.viewer.username===normalized):null;
  const accepted=await verifyPassword(password,entry?.passwordHash);
  return accepted&&entry?.viewer.passwordEnabled&&(!entry.viewer.expiresAt||Date.parse(entry.viewer.expiresAt)>Date.now())?entry.viewer:null;
 }
 passwordAccount(username){let normalized;try{normalized=normalizeUsername(username);}catch{return 'unknown-password';}return [...this.#entries.values()].find(e=>e.viewer.username===normalized)?.viewer.id||'unknown-password';}
 issueCookie(viewer){
  const entry=this.#entries.get(viewer?.id);
  if(!entry||entry.viewer!==viewer)fail('Authenticated viewer required; local bootstrap is disabled when login is required');
  const now=Date.now();for(const [nonce,record] of this.#sessions)if(record.expires<=now)this.#sessions.delete(nonce);
  if(this.#sessions.size>=4096)throw Object.assign(new Error('Session capacity reached; try again later'),{status:429,retryAfter:60});
  const expires=now+12*3600000;
  const prefix=['v1',entry.handle,expires.toString(36),crypto.randomBytes(16).toString('base64url')].join('.');
  this.#sessions.set(prefix.split('.')[3],{handle:entry.handle,expires});
  return prefix+'.'+crypto.createHmac('sha256',this.#secret).update(prefix).digest('base64url');
 }
 authenticateCookie(value){
  if(typeof value!=='string'||value.length>512)return null;
  const parts=value.split('.');
  if(parts.length!==5||parts[0]!=='v1'||!tokenHashPattern.test(parts[1])||!/^[a-z0-9]{1,12}$/.test(parts[2])||!/^[A-Za-z0-9_-]{22}$/.test(parts[3])||!/^[A-Za-z0-9_-]{43}$/.test(parts[4]))return null;
  const signed=parts.slice(0,4).join('.'),expected=crypto.createHmac('sha256',this.#secret).update(signed).digest();
  const supplied=Buffer.from(parts[4],'base64url');if(supplied.length!==expected.length||supplied.toString('base64url')!==parts[4]||!crypto.timingSafeEqual(supplied,expected))return null;
  const expiry=Number.parseInt(parts[2],36);if(!Number.isSafeInteger(expiry)||expiry<=Date.now())return null;
  const record=this.#sessions.get(parts[3]);if(!record||record.handle!==parts[1]||record.expires!==expiry)return null;
  const viewer=this.#handles.get(parts[1])?.viewer;
  return viewer&&(!viewer.expiresAt||Date.parse(viewer.expiresAt)>Date.now())?viewer:null;
 }
 revokeCookie(value){if(!this.authenticateCookie(value))return false;return this.#sessions.delete(value.split('.')[3]);}
}

function redactRelationship(value,viewer){
 const result=clone(value);
 if(viewer?.projectIds!==null){delete result.childId;delete result.forkedFrom;}
 if(viewer?.projectIds!==null||viewer?.hostIds!==null&&!authorized(viewer,result.workerHostId))for(const key of ['workerHostId','workerSessionId','workerCallId'])delete result[key];
 return result;
}

// A recorded job on an allowed target is inspectable. A record from a denied
// source is never admitted because its worker happens to be on an allowed host.
export function projectEvent(event,viewer){
 if(!event||typeof event!=='object'||Array.isArray(event)||!authorized(viewer,event.hostId)||!authorizedProject(viewer,event.project))return null;
 // Older collectors could relabel an event with a later session project. Keep
 // that evidence for fleet/host viewers; never infer historical project scope.
 if(viewer.projectIds!==null&&event.projectBasis!=='source-context')return null;
 return redactRelationship(event,viewer);
}

function projectSession(session,viewer){
 if(!session||typeof session!=='object'||Array.isArray(session)||!authorized(viewer,session.hostId)||!authorizedProject(viewer,session.project))return null;
 const result=redactRelationship(session,viewer);
 if(viewer?.role!=='admin'||viewer.hostIds!==null||viewer.projectIds!==null)delete result.usageLimits;
 if(Array.isArray(result.events))result.events=result.events.map(e=>projectEvent(e,viewer)).filter(Boolean);
 return result;
}

function projectSnapshot(snapshot,viewer){
 const data=snapshot&&typeof snapshot==='object'?snapshot:{},scoped=!viewer||viewer.hostIds!==null||viewer.projectIds!==null;
 const hosts=(Array.isArray(data.hosts)?data.hosts:[]).filter(h=>h&&authorized(viewer,h.id)).map(clone);
 const sessions=(Array.isArray(data.sessions)?data.sessions:[]).map(s=>projectSession(s,viewer)).filter(Boolean);
 const events=(Array.isArray(data.events)?data.events:[]).map(e=>projectEvent(e,viewer)).filter(Boolean);
 const host=data.host&&authorized(viewer,data.host.id)?clone(data.host):null;
 const result={...fields(data,['observedAt','mode']),host,hosts,sessions,events};
 if(data.application)result.application=fields(data.application,['instanceName','organization','timezone','timeFormat','installationRole','alerts']);
 if(viewer?.projectIds!==null){const visible=new Set(sessions.map(s=>s.hostId+'/'+s.id));for(const s of sessions)if(s.parentId&&!visible.has(s.hostId+'/'+s.parentId))delete s.parentId;for(const e of events)if(e.childId&&!visible.has(e.hostId+'/'+e.childId))delete e.childId;}
 if(!scoped){
  result.coverage=clone(data.coverage||{});
  if(data.history)result.history=clone(data.history);
 }else{
  result.coverage={...fields(data.coverage,['completeHistory','persistentRemoteHistory','durableJournal','pollMs','captureDeferred']),scope:'authorized-hosts',...(viewer?.projectIds!==null?{projectAttribution:'source-context-only; legacy events retained outside project-scoped views'}:{}),completeHistory:false,liveRuntimeAttached:!!host&&data.coverage?.liveRuntimeAttached===true,enrolledHosts:hosts.length,connectedHosts:hosts.filter(h=>h.status==='online').length,loaded:sessions.length};
  if(data.history)result.history={...fields(data.history,['schemaVersion','epoch','latestSequence','retentionFloor','gapThrough','maxAgeMs']),scope:'authorized-hosts',cursorSemantics:'global-ingestion-order',completeHistory:false};
 }
 return result;
}

function capabilitiesFor(snapshot,viewer){
 const sessions=snapshot.sessions||[],hosts=snapshot.hosts||[];
 const observedNumber=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
 const hostMetrics=value=>!!value&&['cpu','cores','totalMemory','freeMemory','uptime'].some(k=>observedNumber(value[k]));
 const quotaReading=q=>!!q&&['primary','secondary'].some(k=>observedNumber(q[k]?.usedPercent));
 return {schemaVersion:1,readOnly:true,scope:viewer?.hostIds===null&&viewer?.projectIds===null?'all-hosts':'authorized-sources',observed:{hostHealth:hostMetrics(snapshot.host)||hosts.some(h=>hostMetrics(h.telemetry)),workers:sessions.length>0,subagentRelationships:sessions.some(s=>!!s.parentId),tokenCounters:sessions.some(s=>s.tokens&&['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'].some(k=>observedNumber(s.tokens[k]))),quotaReadings:sessions.some(s=>Array.isArray(s.usageLimits)&&s.usageLimits.some(quotaReading)),durableHistory:!!snapshot.history?.epoch||snapshot.coverage?.durableJournal===true,nativeRuntimeAttached:snapshot.coverage?.liveRuntimeAttached===true},controls:{execute:false,steer:false,approvals:false,providerLifecycle:false,accountManagement:false,sourceEnrollment:false,viewerManagement:false,fileWrites:false,collectorIngestion:false}};
}

export function filterSnapshot(snapshot,viewer){const result=projectSnapshot(snapshot,viewer);result.capabilities=capabilitiesFor(result,viewer);return result;}
export function readOnlyCapabilities(viewer,snapshot){return capabilitiesFor(projectSnapshot(snapshot,viewer),viewer);}
