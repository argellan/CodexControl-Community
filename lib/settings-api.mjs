// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {deviceEnrollmentState} from '../public/device-enrollment.mjs';
import crypto from 'node:crypto';
import {runtimeDiagnostics} from './runtime-diagnostics.mjs';
import {PasswordRateLimiter} from './password-auth.mjs';
import {collectionHealth,preservationHealth} from './settings-health.mjs';
import {CATEGORIES} from '../public/diagnostics-schema.mjs';
import {APPLICATION_VERSION,SETTINGS_PROTOCOL_VERSION} from '../public/build-info.mjs';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const keys=(value,allowed)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail('Unsupported settings field');};
const hostname=v=>typeof v==='string'&&v.length<=253&&/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(v)&&!v.includes('..');
const actor=viewer=>({id:viewer.id,role:viewer.role});
export function createSettingsHandler({installation,applicationDiagnostics,localDiagnostics,hub,upstream,remoteJSON,readJSON,profileFor,configuration,administration,onSecurityChanged=()=>{},onConfigurationChanged=()=>{},clearSession=()=>{},validateRuntime=()=>{},publicOrigin,certificate,instanceId='unconfigured',getSnapshot}={}){
 const downloads=new Map(),passwordAttempts=new PasswordRateLimiter({maxAttempts:5});let credentialQueue=Promise.resolve();
 const credentialMutation=operation=>{const job=credentialQueue.then(async()=>{for(const [id,d] of downloads)if(d.expiresAt<Date.now())downloads.delete(id);if(downloads.size>=64)fail('Too many undownloaded credentials; wait for expiry',429);return operation();});credentialQueue=job.catch(()=>{});return job;};
 const sendJSON=(res,value,validate)=>{const encoded=JSON.stringify(value);validate?.();res.setHeader('Content-Type','application/json; charset=utf-8');res.end(encoded);};
 const admin=viewer=>{if(viewer.role!=='admin'||viewer.hostIds!==null||viewer.projectIds!==null)fail('Administrator permission required',403);if(!administration||!configuration)fail('Administration is not configured on this instance',503);};
 const capabilities=viewer=>{const a=viewer.role==='admin'&&viewer.hostIds===null&&viewer.projectIds===null;return {personalWrite:!!profileFor(viewer),configurationRead:a&&!!configuration,configurationWrite:a&&!!configuration,configurationRollback:a&&!!configuration,usersRead:a&&!!administration,sourcesRead:a&&!!administration,auditRead:a&&!!administration,diagnosticsRead:a,userManagement:a&&!!administration,passwordAccounts:a&&!!administration,passwordChange:!!administration&&viewer.passwordEnabled===true,sourceEnrollment:a&&!!administration,credentialRecovery:a&&!!administration,backup:a&&typeof administration?.createBackup==='function',updates:false,installationRole:a&&!!installation&&!upstream,installationManage:a&&!!installation&&!upstream,codexWorkReadOnly:true};};
 const ticketCurrent=(ticket,viewer,state)=>{
  if(ticket.owner!==viewer.id||ticket.clientKey!==(viewer.diagnosticClientKey??null)||ticket.expiresAt<=Date.now())return false;
  const active=value=>value&&!value.disabled&&(!value.expiresAt||Date.parse(value.expiresAt)>Date.now());
  const issuer=state.viewers.find(v=>v.id===ticket.owner),target=(ticket.credential.kind==='viewer'?state.viewers:state.hosts).find(v=>v.id===ticket.credential.id);
  return active(issuer)&&issuer.role==='admin'&&issuer.hostIds===null&&issuer.projectIds===null&&issuer.tokenHash===ticket.issuerKeyHash&&active(target)&&target.tokenHash.toLowerCase()===crypto.createHash('sha256').update(ticket.credential.token).digest('hex');
 };
 const securityChanged=async state=>{for(const [id,ticket]of downloads)if(!ticketCurrent(ticket,{id:ticket.owner,diagnosticClientKey:ticket.clientKey},state))downloads.delete(id);await onSecurityChanged(state);};
 const ticketMetadata=(id,ticket)=>({downloadId:id,kind:ticket.credential.kind,id:ticket.credential.id,expiresAt:new Date(ticket.expiresAt).toISOString()});
 const issue=(viewer,credential,extra={})=>{for(const [id,d] of downloads)if(d.expiresAt<Date.now())downloads.delete(id);if(downloads.size>=64)fail('Too many undownloaded credentials; wait for expiry',429);const id=crypto.randomBytes(24).toString('hex'),expiresAt=Date.now()+300000;downloads.set(id,{owner:viewer.id,clientKey:viewer.diagnosticClientKey??null,expiresAt,credential,...extra});return {downloadId:id,kind:credential.kind,id:credential.id,expiresAt:new Date(expiresAt).toISOString()};};
 const issuedResult=async(viewer,result,extra={},refreshSecurity=true)=>{const currentState=await administration.state();await securityChanged(currentState);extra={...extra,issuerKeyHash:currentState.viewers.find(v=>v.id===viewer.id)?.tokenHash};
  const requestId=result.enrollment?.requestId,generation=result.enrollment?.generation;
  if(!result.issuedCredential){const found=[...downloads].find(([,d])=>ticketCurrent(d,viewer,currentState)&&d.requestId===requestId&&d.generation===result.source?.credentialGeneration&&d.expiresAt>Date.now()&&result.source?.status==='active');return found?{...result,issuedCredential:{downloadId:found[0],kind:found[1].credential.kind,id:found[1].credential.id,expiresAt:new Date(found[1].expiresAt).toISOString()}}:result;}
  const {issuedCredential,...safe}=result;return {...safe,issuedCredential:issue(viewer,issuedCredential,{...extra,requestId,generation})};
 };
 return async function handle(req,res,url,viewer,{verifyAuthority=()=>viewer}={}){
  const json=(res,value)=>sendJSON(res,value,verifyAuthority);
  const configurationMutation=operation=>administration.withAdministratorAuthority({actor:actor(viewer),verifyAuthority},operation);
  if(!url.pathname.startsWith('/api/settings')&&!url.pathname.startsWith('/api/admin/'))return false;
  if(!viewer)fail('Authentication required',401);
  if(url.pathname==='/api/admin/diagnostics/export-preview'){if(req.method!=='GET')fail('Diagnostic preview is read only',405);if(url.search)fail('Diagnostic preview accepts no query',400);}
  if(upstream){
   if(url.pathname==='/api/admin/credentials')fail('Pending package recovery requires the authoritative hub session',503);
   if(url.pathname==='/api/settings/password')fail('Password changes are available on the authoritative hub',503);
   if(url.pathname.startsWith('/api/admin/')&&!viewer._gatewayAuthenticated)fail('An authenticated administrator gateway is required',403);
   const allowed=/^\/api\/(?:settings(?:\/personal)?|admin\/(?:config(?:\/rollback)?|audit|diagnostics(?:\/export-preview)?|users(?:\/[a-z0-9_-]+\/(?:revoke|password))?|sources(?:\/enroll|\/enrollments\/[a-f0-9-]{36}|\/[a-z0-9_-]+\/(?:revoke|replace))?|credentials\/[a-f0-9]{48}|backups(?:\/backup-[0-9]{10,16}-[a-f0-9]{12}\/restore)?|support))$/;
   if(!allowed.test(url.pathname)||!['GET','PUT','POST'].includes(req.method))fail('Unsupported administration route',404);
   const body=['PUT','POST'].includes(req.method)?await readJSON(req,2097152):undefined;
   if(!viewer._gatewayAuthenticated&&url.pathname==='/api/settings/personal'){verifyAuthority();const identity=await remoteJSON(upstream,'/api/settings','GET',undefined,{validate:verifyAuthority});if(identity.role==='admin')fail('Administrator gateway requires local authentication',403);}
   verifyAuthority();const result=await remoteJSON(upstream,url.pathname+url.search,req.method,body,{validate:verifyAuthority});
   if(url.pathname==='/api/settings'&&result.role==='admin'&&!viewer._gatewayAuthenticated)fail('Administrator gateway requires local authentication',403);
   if(url.pathname==='/api/settings')result.capabilities={...result.capabilities,installationRole:false,installationManage:false,passwordChange:false,credentialRecovery:false,signOut:viewer._gatewayAuthenticated};if(result.signInRequired)clearSession(req,res);json(res,result);return true;
  }
  if(url.pathname==='/api/settings/diagnostics'){
   if(url.search)fail('Diagnostics accepts no query');
   if(req.method==='GET'){json(res,applicationDiagnostics.state(viewer));return true;}
   if(req.method!=='PUT')fail('Unsupported diagnostics method',405);
   const body=await readJSON(req,2048);keys(body,['revision','schemaVersion','recipientRevision','browser']);if(!Number.isSafeInteger(body.revision)||!Number.isSafeInteger(body.schemaVersion)||typeof body.recipientRevision!=='string'||body.recipientRevision.length>64||typeof body.browser!=='boolean')fail('Invalid browser consent');
   verifyAuthority();json(res,applicationDiagnostics.choose(viewer,body));return true;
  }
  if(url.pathname==='/api/settings/diagnostics/synthetic'){
   if(url.search)fail('Diagnostics accepts no query');if(req.method!=='POST')fail('Synthetic test report requires POST',405);
   const body=await readJSON(req,2048);keys(body,['schemaVersion','recipientRevision','class','revision','category','count']);if(['revision','category','count'].some(k=>Object.hasOwn(body,k))&&(!Number.isSafeInteger(body.revision)||!CATEGORIES.includes(body.category)||!Number.isSafeInteger(body.count)||body.count<1||body.count>100||body.class!=='browser'))fail('Invalid fixed browser aggregate');if(!Number.isSafeInteger(body.schemaVersion)||typeof body.recipientRevision!=='string'||body.recipientRevision.length>64||!['browser','backend'].includes(body.class))fail('Invalid synthetic test report');
   verifyAuthority();const result=applicationDiagnostics.enqueue(viewer,body);verifyAuthority();res.statusCode=202;json(res,result);return true;
  }
  if(url.pathname==='/api/admin/diagnostics/sharing'){
   admin(viewer);if(url.search)fail('Diagnostics accepts no query');if(req.method!=='PUT')fail('Administrator consent requires PUT',405);
   const body=await readJSON(req,2048);keys(body,['revision','schemaVersion','receiver','backend']);if(!Number.isSafeInteger(body.revision)||!Number.isSafeInteger(body.schemaVersion)||typeof body.receiver!=='boolean'||typeof body.backend!=='boolean')fail('Invalid administrator consent');
   verifyAuthority();json(res,applicationDiagnostics.authorize(viewer,body));return true;
  }
  if(url.pathname==='/api/settings'&&req.method==='GET'){
   const p=await profileFor(viewer)?.read({verifyAuthority});if(!p)fail('Presentation profile unavailable',503);
   const deployment=configuration?await configuration.read():null;
   json(res,{...(installation?{installationAuthority:{instanceId,viewerId:viewer.id,scopeRevision:JSON.stringify([viewer.role,viewer.hostIds,viewer.projectIds]),clientKey:viewer.diagnosticClientKey??null}}:{}),personal:p.preferences,personalRevision:p.revision,profileRecovered:p.recovered===true,recovered:p.recovered===true||deployment?.recovered===true,configuration:viewer.role==='admin'?deployment?.configuration??null:null,revision:viewer.role==='admin'?deployment?.revision??null:null,requiresRestart:deployment?.requiresRestart===true,role:viewer.role||'viewer',viewer:{id:viewer.id,label:viewer.label,username:viewer.username??null,passwordEnabled:viewer.passwordEnabled===true,hostIds:viewer.hostIds,projectIds:viewer.projectIds},deployment:deployment?.configuration.general||null,capabilities:{...capabilities(viewer),signOut:viewer._gatewayAuthenticated},version:APPLICATION_VERSION,applicationVersion:APPLICATION_VERSION,settingsProtocolVersion:SETTINGS_PROTOCOL_VERSION,instanceId});return true;
  }
  if(url.pathname==='/api/settings/personal'&&req.method==='PUT'){
   const body=await readJSON(req,65536);keys(body,['revision','preferences']);if(!Number.isSafeInteger(body.revision))fail('A presentation revision is required');const profile=profileFor(viewer);if(!profile)fail('Presentation profile unavailable',503);verifyAuthority();json(res,await profile.write(body.preferences,{revision:body.revision,actor:actor(viewer),verifyAuthority}));return true;
  }
  if(url.pathname==='/api/settings/password'&&req.method==='POST'){
   if(!administration||!viewer.passwordEnabled)fail('Password change unavailable for this account',403);
   passwordAttempts.consume(req.socket?.remoteAddress||'unknown',viewer.id);const body=await readJSON(req,4096);keys(body,['currentPassword','newPassword']);
   verifyAuthority();const result=await administration.changePassword({...body,id:viewer.id,actor:actor(viewer),verifyAuthority});await securityChanged(await administration.state());clearSession(req,res);sendJSON(res,{changed:result.changed===true,signInRequired:true});return true;
  }
  if(!url.pathname.startsWith('/api/admin/'))fail('Settings are read only except explicit profile saves',405);
  admin(viewer);
  if(url.pathname==='/api/admin/config'){
   if(req.method==='GET'){json(res,await configuration.read());return true;}
   if(req.method==='PUT'){const body=await readJSON(req,2097152);keys(body,['revision','configuration']);if(installation&&body.configuration?.general?.installationRole!==installation.state().role)fail('Installation role changed; refresh and use the Installation workflow',409);configuration.validate(body.configuration);await validateRuntime(body.configuration);const result=await configurationMutation(async authorize=>{const saved=await configuration.save({...body,actor:actor(viewer),authorize,verifyAuthority});if(installation&&saved.changedPaths.includes('general.instanceName'))await installation.rename({revision:installation.state().revision,name:saved.configuration.general.instanceName,verifyAuthority});return saved;});await onConfigurationChanged(result);json(res,result);return true;}
  }
  if(url.pathname==='/api/admin/config/rollback'&&req.method==='POST'){const body=await readJSON(req,2048);keys(body,['revision']);const result=await configurationMutation(authorize=>configuration.rollback({...body,actor:actor(viewer),authorize,verifyAuthority,...(installation?{preserveGeneral:{installationRole:installation.state().role,instanceName:installation.state().name}}:{})}));await onConfigurationChanged(result);json(res,result);return true;}
  if(url.pathname==='/api/admin/users'){
   if(req.method==='GET'){json(res,await administration.publicUsers());return true;}
   if(req.method==='POST'){
    const body=await readJSON(req,16384);keys(body,['revision','user']);const result=await credentialMutation(async()=>issuedResult(viewer,await administration.saveUser({...body,actor:actor(viewer),verifyAuthority})));
    // This authorized self-change intentionally invalidates the starting grant.
    // Only its own public acknowledgment bypasses delivery reauthentication;
    // issued credential downloads and all other sensitive results still check it.
    const ownTransition=body.user.id===viewer.id&&!result.issuedCredential&&(result.signInRequired||result.user.role!==viewer.role||result.user.disabled||result.user.expiresAt!==viewer.expiresAt||JSON.stringify([result.user.hostIds,result.user.projectIds])!==JSON.stringify([viewer.hostIds,viewer.projectIds]));
    if(result.signInRequired||ownTransition)clearSession(req,res);if(ownTransition)sendJSON(res,{revision:result.revision,user:result.user,changedPaths:result.changedPaths,signInRequired:true});else json(res,result);return true;
   }
  }
  const userRevoke=/^\/api\/admin\/users\/([a-z0-9_-]+)\/revoke$/.exec(url.pathname);
  if(userRevoke&&req.method==='POST'){const body=await readJSON(req,2048);keys(body,['revision']);const result=await administration.revokeUser({...body,id:userRevoke[1],actor:actor(viewer),verifyAuthority});await securityChanged(await administration.state());if(userRevoke[1]===viewer.id){clearSession(req,res);sendJSON(res,{revision:result.revision,user:result.user,changedPaths:result.changedPaths,signInRequired:true});}else json(res,result);return true;}
  const userPassword=/^\/api\/admin\/users\/([a-z0-9_-]+)\/password$/.exec(url.pathname);
  if(userPassword&&req.method==='POST'){const body=await readJSON(req,4096);keys(body,['revision','password']);const result=await administration.resetPassword({...body,id:userPassword[1],actor:actor(viewer),verifyAuthority});await securityChanged(await administration.state());json(res,result);return true;}
  if(url.pathname==='/api/admin/sources'&&req.method==='GET'){const inventory=await administration.publicSources(),s=getSnapshot?await getSnapshot():null;json(res,{...inventory,sources:inventory.sources.map(source=>{const observed=s?.hosts?.find(h=>h.id===source.id)??null;return {...source,observed,setup:deviceEnrollmentState({...source,observed})};})});return true;}
  const receiptRoute=/^\/api\/admin\/sources\/enrollments\/([a-f0-9-]{36})$/.exec(url.pathname);
  if(receiptRoute&&req.method==='GET'){json(res,await issuedResult(viewer,await administration.enrollmentReceipt({requestId:receiptRoute[1],actor:actor(viewer),verifyAuthority}),{},false));return true;}
  const replaceRoute=/^\/api\/admin\/sources\/([-a-z0-9]{1,64})\/replace$/.exec(url.pathname);
  if((url.pathname==='/api/admin/sources/enroll'||replaceRoute)&&req.method==='POST'){
   const body=await readJSON(req,16384);keys(body,['revision','host','requestId',...(replaceRoute?['expectedGeneration']:[])]);
   if(!hostname(body.host?.expectedHostname))fail('Expected machine hostname is required before enrollment');
   if(replaceRoute&&body.host.id!==replaceRoute[1])fail('Replacement device identity mismatch');
   const {expectedHostname,...host}=body.host;
   const result=await credentialMutation(async()=>issuedResult(viewer,await administration.enrollSource({revision:body.revision,host,requestId:body.requestId,expectedHostname,replace:!!replaceRoute,expectedGeneration:body.expectedGeneration,actor:actor(viewer),verifyAuthority}),{expectedHostname,role:host.role||'codex-source'}));
   json(res,result);return true;
  }
  const sourceRevoke=/^\/api\/admin\/sources\/([a-z0-9_-]+)\/revoke$/.exec(url.pathname);
  if(sourceRevoke&&req.method==='POST'){const body=await readJSON(req,2048);keys(body,['revision']);const result=await administration.revokeSource({...body,id:sourceRevoke[1],actor:actor(viewer),verifyAuthority});await securityChanged(await administration.state());json(res,result);return true;}
  if(url.pathname==='/api/admin/credentials'&&req.method==='GET'){
   if(url.search)fail('Pending packages accept no query');const state=await administration.state();verifyAuthority();
   const issuedCredentials=[];for(const [id,ticket]of downloads)if(ticketCurrent(ticket,viewer,state))issuedCredentials.push(ticketMetadata(id,ticket));json(res,{issuedCredentials});return true;
  }
  const credential=/^\/api\/admin\/credentials\/([a-f0-9]{48})$/.exec(url.pathname);
  if(credential&&req.method==='GET'){
   const state=await administration.state();verifyAuthority();const issued=downloads.get(credential[1]);if(!issued||!ticketCurrent(issued,viewer,state))fail('One-time credential download expired or unavailable',404);downloads.delete(credential[1]);
   const {kind,id,token}=issued.credential,origin=publicOrigin||(certificate?'https://':'http://')+req.headers.host,common={classification:'PRIVATE; contains an access credential',instanceId,kind,id};
   const payload=kind==='viewer'?{...common,accessKey:token,url:origin,instructions:['Keep this file private. Sign in to this instance with the access key. Codex provider credentials remain on the user computer.']}:{...common,hostId:id,token,url:origin,expectedInstanceId:instanceId,expectedHostname:issued.expectedHostname,role:issued.role,...(certificate?{caPem:String(certificate)}:{}),instructions:['Install the generic Codex-Control collector on the expected machine using this private configuration.','Verify the HTTPS certificate and /api/identity deployment before sending this collector credential. One physical machine keeps one host ID across interfaces.']};
   res.setHeader('Content-Disposition',`attachment; filename="codex-control-${kind}-${id}.json"`);json(res,payload);return true;
  }
  if(url.pathname==='/api/admin/audit'&&req.method==='GET'){json(res,{configuration:await configuration.audit(),administration:await administration.audit()});return true;}
  if(url.pathname==='/api/admin/diagnostics/export-preview'&&req.method==='GET'){
   if(!localDiagnostics)fail('Local diagnostics storage unavailable',503);
   json(res,{preview:localDiagnostics.preview(),status:localDiagnostics.status()});return true;
  }
  if(url.pathname==='/api/admin/diagnostics'&&req.method==='GET'){
   const diagnostics=await runtimeDiagnostics(hub?.journal,{diskBudgetMiB:hub?.diskBudgetMiB});
   // On demand only. Keep the live metadata/usage transport and ingest path intact.
   diagnostics.collection=collectionHealth(getSnapshot?await getSnapshot():null);
   diagnostics.preservation=preservationHealth(hub?.journal);
   json(res,diagnostics);return true;
  }
  if(url.pathname==='/api/admin/backups'){
   if(typeof administration.createBackup!=='function')fail('Backup capability unavailable',503);
   if(req.method==='GET'){json(res,await administration.listBackups());return true;}
   if(req.method==='POST'){const body=await readJSON(req,2048);keys(body,['revision']);json(res,await administration.createBackup({revision:body.revision,journal:hub?.journal,configuration:await configuration.read(),actor:actor(viewer),verifyAuthority}));return true;}
  }
  const restore=/^\/api\/admin\/backups\/(backup-[0-9]{10,16}-[a-f0-9]{12})\/restore$/.exec(url.pathname);
  if(restore&&req.method==='POST'){if(typeof administration.stageRestore!=='function')fail('Restore staging unavailable',503);const body=await readJSON(req,2048);keys(body,['revision']);json(res,await administration.stageRestore({id:restore[1],revision:body.revision,actor:actor(viewer),verifyAuthority}));return true;}
  if(url.pathname==='/api/admin/support'&&req.method==='GET'){if(typeof administration.supportBundle!=='function')fail('Support export unavailable',503);json(res,await administration.supportBundle({snapshot:getSnapshot?await getSnapshot():null,configuration:await configuration.read(),diagnostics:await runtimeDiagnostics(hub?.journal,{diskBudgetMiB:hub?.diskBudgetMiB}),actor:actor(viewer)}));return true;}
  fail('Unsupported administration operation',405);
 };
}
