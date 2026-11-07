import {requireCommunityRole} from './community-platform.mjs';
// Author: Bishop Crockett
// Owner: Argellan.com
// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {privateDirectory,readJSONFile,atomicJSON,appendAudit,digest,failure} from './installation-storage.mjs';
import {destination,protectedRequest,listenProtected,selectInstallationAddress} from './installation-transport.mjs';
import {InstallationDiscovery} from './installation-discovery.mjs';
import {installationName} from '../public/installation-identity.mjs';
const roles=new Set(['standalone','hub','node']);
const roleOf=value=>value==='collector'?'node':roles.has(value)?value:'standalone';
const nowISO=ms=>new Date(ms).toISOString();
const nameOf=value=>{try{return installationName(value);}catch(error){throw failure(error.message);}};
const idValid=value=>typeof value==='string'&&/^[-a-zA-Z0-9_]{1,80}$/.test(value);
const hostValid=value=>typeof value==='string'&&/^[-a-z0-9]{1,64}$/.test(value);
const publicIdentity=s=>({id:s.id,hostId:s.hostId,name:s.name,role:s.role});
function peerIdentity(value){if(!value||!idValid(value.id)||!hostValid(value.hostId)||!roles.has(value.role))throw failure('Invalid installation identity');return {...publicIdentity(value),name:nameOf(value.name)};}
function receiptIdentity(ack,q,peer,nodeId){
 if(!ack||ack.version!==1||ack.hubId!==peer.id||ack.nodeId!==nodeId||ack.relationshipId!==peer.relationshipId||ack.batchId!==q.payload.batchId||ack.sha256!==q.sha256||ack.recordCount!==q.recordCount||!Number.isSafeInteger(ack.journalSequence)||ack.journalSequence<0)throw failure('Exact authenticated receipt mismatch',409);
 const reported=peerIdentity(ack.installation);
 if(reported.id!==peer.id||reported.hostId!==peer.hostId||reported.role!=='hub')throw failure('Receipt installation identity mismatch',403);
 return reported;
}
const complementary=(a,b)=>a==='hub'&&b==='node'||a==='node'&&b==='hub';
export class Installation {
 #serialWork=Promise.resolve();#s;#pairs=new Map();#plans=new Map();#queue=new Map();#captures=new Map();#attempts=new Map();#server;#discovery;#closed=false;#flushing=false;#outbound=new Set();#discoveryOptions;#storage={state:'unknown',freeBytes:null};
 static async open({directory,hostId,name='Codex Control',instanceId,legacyRole,network={},now=Date.now,applyRole=async()=>{},onPeersChanged=async()=>{},onNameChanged=async()=>{},validatePeer=async()=>{},ingest,discoveryTransport}={}){
  requireCommunityRole(roleOf(legacyRole));if(!hostValid(hostId))throw failure('Stable local host identity is required');await privateDirectory(directory);await privateDirectory(path.join(directory,'outbox'));await privateDirectory(path.join(directory,'captures'));
  const app=new Installation();Object.assign(app,{directory,network,now,applyAdapter:applyRole,onPeersChanged,onNameChanged,validatePeer,ingest});app.file=path.join(directory,'installation.json');app.outbox=path.join(directory,'outbox');app.captures=path.join(directory,'captures');
  try{app.#s=await readJSONFile(app.file);}catch(error){if(error.code!=='ENOENT')throw error;app.#s={version:1,id:instanceId||crypto.randomUUID(),hostId,name:nameOf(name),role:roleOf(legacyRole),revision:1,phase:'active',requestedRole:roleOf(legacyRole),transition:null,peers:[],destination:null};await atomicJSON(app.file,app.#s);}
  const s=app.#s;requireCommunityRole(s.role);if(s.version!==1||!idValid(s.id)||s.hostId!==hostId||!roles.has(s.role)||!Number.isSafeInteger(s.revision)||s.revision<1||!Array.isArray(s.peers)||s.peers.length>128)throw failure('Installation identity/state mismatch; preserve files for recovery',503);nameOf(s.name);
  for(const peer of s.peers){peerIdentity(peer);if(!idValid(peer.relationshipId)||!/^[-_a-zA-Z0-9]{43}$/.test(peer.key)||!hostValid(peer.hostId))throw failure('Invalid persisted trust binding',503);destination(peer.address);}
  for(const saved of s.pairingTransactions||[]){
   if(!saved||!/^[a-f0-9]{16}$/.test(saved.id)||!/^[-_a-zA-Z0-9]{43}$/.test(saved.key)||!Number.isSafeInteger(saved.expiresAt))throw failure('Invalid pairing recovery state; preserve files',503);
   peerIdentity(saved.peer);destination(saved.address);
   if(saved.expiresAt<=now()&&(saved.status!=='canceled'||saved.remoteCancellationConfirmed))continue;
   const committed=saved.status==='paired'&&s.peers.some(p=>!p.revoked&&p.id===saved.peer.id&&p.key===saved.key);
   app.#pairs.set(saved.id,{...saved,owner:null,verify:null,recovered:!committed,confirmedLocal:committed&&saved.confirmedLocal===true,status:committed?'paired':saved.status==='canceled'?'canceled':'reconciling'});
  }
  for(const f of await fs.readdir(app.captures)){
   if(!/^[a-f0-9]{64}\.json$/.test(f))continue;
   const intent=await readJSONFile(path.join(app.captures,f),33554432);
   if(intent.version!==1||intent.id!==f.slice(0,-5)||intent.sha256!==digest(intent.data)||intent.data?.local?.host?.id!==s.hostId)throw failure('Local capture custody mismatch; preserve files',503);
   app.#captures.set(intent.id,{id:intent.id,status:intent.status,localCommitted:intent.localCommitted===true,recordCount:(intent.data.local.events?.length||0)+(intent.data.usageCapture?.usageSamples?.length||0)||1,destinationId:intent.destinationId,relationshipId:intent.relationshipId,error:intent.error??null});
  }
  for(const f of await fs.readdir(app.outbox)){if(!/^[a-f0-9]{64}\.json$/.test(f))continue;const q=await readJSONFile(path.join(app.outbox,f));if(q.version!==1||q.id!==f.slice(0,-5)||q.sha256!==digest(q.payload)||q.payload.hostId!==s.hostId)throw failure('Outbox integrity mismatch; preserve pending records',503);app.#queue.set(q.id,app.#metadata(q));}
  await app.#probeStorage();await app.#recoverName();await app.#reconcileReceipts();await app.#resumeAssignment();
  if(['applying','recovering'].includes(s.phase)){await applyRole(s.role);await app.#save({...s,revision:s.revision+1,phase:'active',requestedRole:s.role,transition:{...s.transition,outcome:'recovered-rollback',stage:'recovered'}},'recover-transition');}
  app.#discoveryOptions={transport:discoveryTransport,enableMulticast:network.discovery===true,now};app.#discovery=new InstallationDiscovery({...app.#discoveryOptions,identity:publicIdentity(app.#s)});
  try{await app.#effective(s.role);await app.onPeersChanged(app.#trusted());}catch(error){await app.close();throw error;}return app;
 }
 #serial(fn){const job=this.#serialWork.then(()=>{if(this.#closed)throw failure('Installation is closed',503);return fn();});this.#serialWork=job.catch(()=>{});return job;}
 #revision(revision){if(revision!==this.#s.revision)throw failure('Installation revision conflict; refresh before continuing',409);}
 #metadata(q){const {payload,...meta}=q;return {...meta,wireBytes:Buffer.byteLength(JSON.stringify(payload))};}
 async #probeStorage(){try{const stat=await fs.statfs(this.directory);const freeBytes=stat.bavail*stat.bsize;this.#storage={state:freeBytes<16777216?'low':'available',freeBytes};}catch{this.#storage={state:'unavailable',freeBytes:null};}}
 #trusted(){return this.#s.peers.filter(p=>!p.revoked).map(p=>({...p}));}
 async #save(next,action,verify=()=>{}){
  verify();next={...next,pairingTransactions:[...this.#pairs.values()].filter(p=>p.key&&p.peer).map(({id,key,peer,address,direction,expiresAt,status,confirmedLocal=false,confirmedRemote=false,remoteCancellationConfirmed=false})=>({id,key,peer,address,direction,expiresAt,status,confirmedLocal,confirmedRemote,remoteCancellationConfirmed}))};
  await appendAudit(path.join(this.directory,'transitions.jsonl'),{at:nowISO(this.now()),action,revision:next.revision,role:next.role,requestedRole:next.requestedRole,phase:next.phase,transition:next.transition?.id??null,stage:next.transition?.stage??null,publication:'intent'});
  await atomicJSON(this.file,next,verify);this.#s=next;
 }
 async #change(action,operation,{revision,verifyAuthority=()=>{}}={}){return this.#serial(async()=>{verifyAuthority();if(revision!==undefined)this.#revision(revision);const next=structuredClone(this.#s),result=await operation(next);if(!['validated-report-ack','delivery-deferred'].includes(action))next.revision++;await this.#save(next,action,verifyAuthority);return result??this.state();});}
 async #effective(role){await this.applyAdapter(role);if(role==='standalone'){await this.#discovery?.close();if(this.#server){this.#server.closeAllConnections?.();await new Promise(resolve=>this.#server.close(resolve));this.#server=undefined;}return;}if(!this.#discovery||this.#discovery.closed)this.#discovery=new InstallationDiscovery({...this.#discoveryOptions,identity:{...publicIdentity(this.#s),role}});if(!this.#server)this.#server=await listenProtected({listen:this.network.listen||'127.0.0.1',port:this.network.port??0,authenticate:(identity,address)=>this.#authenticate(identity,address),handle:(route,body,auth)=>this.#receive(route,body,auth)});await this.#discovery?.update({identity:{...publicIdentity(this.#s),role},pairable:false});if(role==='hub'&&this.network.discovery===true&&!this.#discovery.started)await this.#discovery.start({advertise:true,pairable:false,address:selectInstallationAddress(this.network),port:this.#server.address().port});}
 get address(){if(!this.#server)return null;const host=selectInstallationAddress(this.network);return `https://${host.includes(':')?'['+host+']':host}:${this.#server.address().port}`;}
 state(){const now=this.now();const peers=this.#s.peers.map(({key,...peer})=>{const inbound=peer.role==='node',receipt=inbound?peer.lastReceiptAt:peer.lastAcknowledgedAt;const age=receipt?now-Date.parse(receipt):null;return {...peer,status:peer.revoked?'revoked':!complementary(this.#s.role,peer.role)?'dormant':peer.lastError==='rejected'?'rejected':peer.lastError==='unreachable'?'unreachable':age===null?'awaiting-first-receipt':age>30000?'offline':age>15000?'stale':'reporting',lastReceiptAt:receipt??null,pendingRecords:[...this.#queue.values()].filter(q=>!q.ack&&q.relationshipId===peer.relationshipId).reduce((n,q)=>n+q.recordCount,0)};});const pending=[...this.#queue.values()].filter(q=>!q.ack),active=new Set(this.#s.peers.filter(p=>!p.revoked).map(p=>p.relationshipId));return {...publicIdentity(this.#s),revision:this.#s.revision,phase:this.#s.phase,requestedRole:this.#s.requestedRole,transition:this.#s.transition,nameTransition:this.#s.nameTransition??null,error:this.#s.error??null,address:this.address,capabilities:{localObservation:true,receiveNodes:this.#s.role==='hub',outbound:this.#s.role==='node'},peers,pairing:[...this.#pairs.values()].filter(p=>p.status==='canceled'?!p.remoteCancellationConfirmed:p.expiresAt>now&&p.status!=='paired').map(p=>({id:p.id,direction:p.direction,peer:p.peer??null,expiresAt:nowISO(p.expiresAt),confirmedLocal:p.confirmedLocal===true,confirmedRemote:p.confirmedRemote===true,status:p.status==='canceled'?'canceling':p.status,canceled:p.status==='canceled',recovered:p.recovered===true})),queue:{capturePendingRecords:[...this.#captures.values()].filter(c=>c.status!=='framed').reduce((n,c)=>n+c.recordCount,0),capturePendingBatches:[...this.#captures.values()].filter(c=>c.status!=='framed').length,captureRecoveryRequired:[...this.#captures.values()].some(c=>c.status!=='framed'&&c.error),pendingRecords:pending.reduce((n,q)=>n+q.recordCount,0),pendingBatches:pending.length,dormantRecords:pending.filter(q=>this.#s.role!=='node'||!active.has(q.relationshipId)).reduce((n,q)=>n+q.recordCount,0),retainedRecords:[...this.#queue.values()].reduce((n,q)=>n+q.recordCount,0),retainedBatches:this.#queue.size,retainedBytes:[...this.#queue.values()].reduce((n,q)=>n+q.wireBytes,0),freeBytes:this.#storage.freeBytes,storagePressure:this.#storage.state==='low'?'disk-reserve-pressure':this.#storage.state==='unavailable'?'disk-pressure-unavailable':this.#queue.size>10000?'backlog-pressure':'normal',custody:'Local immutable observations retained; transport ACK is not archive custody'},discovery:{...this.#discovery?.status(),status:this.#discovery?.status().state??'disabled',candidates:(this.#discovery?.candidates()??[]).map(c=>({...c,expiresAt:nowISO(c.expiresAt)}))}};}
 async planRole({revision,role,verifyAuthority=()=>{}}={}){return this.#serial(()=>{verifyAuthority();this.#revision(revision);if(!roles.has(role))throw failure('Unsupported installation role');requireCommunityRole(role);for(const [id,p]of this.#plans)if(p.expiresAt<=this.now())this.#plans.delete(id);if(this.#plans.size>=8)throw failure('Too many pending role plans',429);const plan={planId:crypto.randomUUID(),revision,from:this.#s.role,to:role,expiresAt:this.now()+60000,warnings:['Local observation and retained history continue.',...(this.#s.peers.length?['Trust is retained. Inactive transport backlogs remain bound to their original destination.']:[]),...(role==='node'&&!this.#s.destination?['Node captures locally while awaiting explicit Hub pairing.']:[])]};this.#plans.set(plan.planId,plan);return {...plan};});}
 async applyRole({revision,planId,verifyAuthority=()=>{}}={}){return this.#serial(async()=>{verifyAuthority();this.#revision(revision);const plan=this.#plans.get(planId);if(!plan||plan.revision!==revision||plan.expiresAt<=this.now())throw failure('Role plan is stale or unavailable',409);this.#plans.delete(planId);const previous=structuredClone(this.#s),transition={id:planId,from:plan.from,to:plan.to,stage:'prepared'};await this.#save({...previous,revision:revision+1,requestedRole:plan.to,phase:'applying',transition},'prepare-role',verifyAuthority);this.#pairs.clear();this.#abortOutbound();try{await this.#effective(plan.to);verifyAuthority();await this.#save({...this.#s,role:plan.to,requestedRole:plan.to,phase:'active',revision:this.#s.revision+1,transition:{...transition,stage:'verified',outcome:'active'},error:null},'activate-role',verifyAuthority);await this.onPeersChanged(this.#trusted());return this.state();}catch{let compensated=true;try{await this.#effective(previous.role);}catch{compensated=false;}await this.#save({...previous,revision:this.#s.revision+1,phase:compensated?'failed':'recovering',requestedRole:plan.to,transition:{...transition,stage:'compensated',outcome:compensated?'rolled-back':'recovery-required'},error:'Role transition failed; retained previous role and all data'},'rollback-role');throw failure('Role transition failed; previous role retained; inspect recovery state',503);}});}
 async #recoverName(){
  const intent=this.#s.nameTransition;if(!intent||!['applying','recovering'].includes(intent.phase))return;
  if(nameOf(intent.from)!==this.#s.name||nameOf(intent.to)!==intent.to)throw failure('Name recovery identity mismatch; preserve files',503);
  await this.onNameChanged(this.#s.name);await this.#save({...this.#s,nameTransition:null,revision:this.#s.revision+1,error:null},'recover-name-publication');
 }
 async rename({revision,name,peerId,verifyAuthority=()=>{}}={}){
  const nextName=nameOf(name);
  if(peerId){await this.#change('rename-peer',next=>{const peers=next.peers.filter(p=>p.id===peerId);if(!peers.length)throw failure('Installation unavailable',404);for(const peer of peers){peer.name=nextName;peer.alias=true;}},{revision,verifyAuthority});await this.onPeersChanged(this.#trusted());return this.state();}
  return this.#serial(async()=>{
   verifyAuthority();this.#revision(revision);const previous=structuredClone(this.#s),intent={from:previous.name,to:nextName,phase:'applying'};
   await this.#save({...this.#s,nameTransition:intent,revision:this.#s.revision+1},'prepare-name-publication',verifyAuthority);
   try{
    await this.onNameChanged(nextName);verifyAuthority();await this.#discovery?.update({identity:{...publicIdentity(this.#s),name:nextName}});
    await this.#save({...this.#s,name:nextName,nameTransition:null,revision:this.#s.revision+1,error:null},'publish-name',verifyAuthority);
    await this.onPeersChanged(this.#trusted());return this.state();
   }catch{
    let compensated=true;try{await this.onNameChanged(previous.name);await this.#discovery?.update({identity:publicIdentity(previous)});}catch{compensated=false;}
    await this.#save({...previous,nameTransition:compensated?null:{...intent,phase:'recovering'},revision:this.#s.revision+1,error:compensated?'Name change failed; previous name retained':'Name change recovery required; identity and observations retained'},'compensate-name-publication');
    throw failure('Name change failed; previous published name retained; refresh recovery status',503);
   }
  });
 }
 #rolePairable(){if(!['hub','node'].includes(this.#s.role))throw failure('Choose Hub or Node before pairing',409);}
 async openPairing({revision,owner='TEST_ONLY-system',verifyAuthority=()=>{}}={}){return this.#serial(async()=>{verifyAuthority();this.#revision(revision);this.#rolePairable();this.#expire();if(this.#pairs.size>=8)throw failure('Pairing session limit reached',429);const id=crypto.randomBytes(8).toString('hex'),key=crypto.randomBytes(16).toString('base64url'),pair={id,inviteKey:key,owner,verify:verifyAuthority,direction:'incoming',expiresAt:this.now()+300000,status:'accepting',attempts:0};await this.#save({...this.#s,revision:this.#s.revision+1},'open-pairing',verifyAuthority);this.#pairs.set(id,pair);if(this.#s.role==='node'&&this.network.discovery===true&&!this.#discovery.started)await this.#discovery.start({advertise:true,pairable:true,address:selectInstallationAddress(this.network),port:this.#server.address().port});else await this.#discovery?.update({pairable:true});return {id,code:id+'.'+key,expiresAt:nowISO(pair.expiresAt),address:this.address,installation:publicIdentity(this.#s)};});}
 #expire(){for(const [id,p]of this.#pairs)if(p.expiresAt<=this.now()&&(p.status!=='canceled'||p.remoteCancellationConfirmed))this.#pairs.delete(id);for(const [id,a]of this.#attempts)if(a.until<=this.now())this.#attempts.delete(id);}
 #authenticate(identity,address){this.#expire();if(this.#s.role==='standalone'||typeof identity!=='string'||identity.length>128)return null;const [kind,id]=identity.split(':');if(kind==='peer'){const peer=this.#s.peers.find(p=>p.relationshipId===id&&!p.revoked);return peer?{kind,id,key:peer.key,peerId:peer.id}:null;}if(this.#attempts.size>=128&&!this.#attempts.has(address))return null;const attempts=this.#attempts.get(address)||{count:0,until:this.now()+60000};if(attempts.count>=12)return null;attempts.count++;this.#attempts.set(address,attempts);const pair=this.#pairs.get(id);if(!pair)return null;if(kind==='invite'&&pair.status==='accepting'&&pair.attempts++<5)return {kind,id,key:pair.inviteKey};if(kind==='pair'&&pair.key)return {kind:pair.status==='canceled'?'canceled-pair':kind,id,key:pair.key};return null;}
 async joinPairing({revision,address,code,expectedId,owner='TEST_ONLY-system',verifyAuthority=()=>{}}={}){
  const u=destination(address);if(typeof code!=='string'||!/^[a-f0-9]{16}\.[-_a-zA-Z0-9]{22}$/.test(code))throw failure('Invalid single-use pairing code');const [id,key]=code.split('.');const local=await this.#serial(()=>{verifyAuthority();this.#revision(revision);this.#rolePairable();this.#expire();if(this.#pairs.has(id)||this.#pairs.size>=8)throw failure('Pairing session already exists or limit reached',409);return publicIdentity(this.#s);});
   const nonce=crypto.randomBytes(16).toString('hex');
   const result=await protectedRequest(u.origin,{identity:'invite:'+id,key,route:'/pair/hello',body:{installation:local,expectedId:expectedId??null,address:this.address,nonce},verify:verifyAuthority});
   const peer=peerIdentity(result.installation);if(peer.id===local.id||peer.hostId===local.hostId||!complementary(local.role,peer.role)||expectedId&&peer.id!==expectedId||result.id!==id||result.nonce!==nonce||!Number.isSafeInteger(result.expiresAt)||result.expiresAt<=this.now()||result.expiresAt>this.now()+300000||!/^[-_a-zA-Z0-9]{43}$/.test(result.key))throw failure('Confirmed installation identity mismatch',403);
   return this.#serial(async()=>{verifyAuthority();this.#revision(revision);if(this.#s.role!==local.role)throw failure('Installation changed during pairing',409);this.#pairs.set(id,{id,owner,verify:verifyAuthority,key:result.key,peer,address:u.origin,direction:'outgoing',expiresAt:result.expiresAt,confirmedLocal:false,confirmedRemote:false,status:'awaiting-confirmation'});await this.#save({...this.#s,revision:this.#s.revision+1},'join-pairing',verifyAuthority);return this.state();});
 }
 async confirmPairing({revision,id,owner='TEST_ONLY-system',verifyAuthority=()=>{}}={}){
  const pair=await this.#serial(async()=>{verifyAuthority();this.#revision(revision);this.#expire();const p=this.#pairs.get(id);if(!p?.peer||!p.recovered&&p.owner!==owner||!p.key||['paired','canceled'].includes(p.status))throw failure('Pairing session is stale or belongs to another session',409);if(!complementary(this.#s.role,p.peer.role))throw failure('Pairing role changed',409);const priorVerify=p.verify;p.owner=owner;p.verify=()=>{priorVerify?.();verifyAuthority();};p.recovered=false;p.confirmedLocal=true;p.status='confirming';await this.#save({...this.#s,revision:this.#s.revision+1},'confirm-pairing-intent',verifyAuthority);return {...p};});
  try{
   const result=await protectedRequest(pair.address,{identity:'pair:'+id,key:pair.key,route:'/pair/confirm',body:{id,installationId:this.#s.id,expectedId:pair.peer.id},verify:verifyAuthority});
   return await this.#serial(async()=>{verifyAuthority();const current=this.#pairs.get(id);if(!current||current.owner!==owner||current.peer.id!==result.installationId||current.expiresAt<=this.now()||current.status==='canceled')throw failure('Pairing confirmation changed or expired',409);current.confirmedRemote=result.confirmedLocal===true;current.status='awaiting-confirmation';await this.#finishPair(current,verifyAuthority);if(current.status!=='paired')await this.#save({...this.#s},'await-remote-confirmation',verifyAuthority);return this.state();});
  }catch(error){
   if(!this.#closed)await this.#serial(async()=>{const current=this.#pairs.get(id);if(current&&!['paired','canceled'].includes(current.status)){current.status='reconciling';await this.#save({...this.#s},'pairing-result-uncertain');}});
   throw error;
  }
 }
 async #finishPair(pair,verify=()=>{}){
  pair.verify?.();if(pair.status==='paired'){if(!this.#s.peers.some(p=>p.id===pair.peer.id&&p.key===pair.key&&!p.revoked))throw failure('Pairing grant revoked',403);return;}if(pair.status==='canceled')throw failure('Pairing was canceled',409);if(!pair.confirmedLocal||!pair.confirmedRemote)return;
  const callerVerify=verify;verify=()=>{callerVerify();pair.verify?.();};
  const relationshipId=digest([pair.id,...[this.#s.id,pair.peer.id].sort()]).slice(0,64),existing=this.#s.peers.find(p=>p.id===pair.peer.id&&!p.revoked);
  if(existing&&existing.relationshipId!==relationshipId)throw failure('Installation is already paired; explicitly revoke before reauthorization',409);
  if(this.#s.peers.some(p=>p.hostId===pair.peer.hostId&&p.id!==pair.peer.id))throw failure('Immutable host identity collision',409);
  if(this.#s.peers.length>=128&&!existing)throw failure('Trust history requires review before adding another relationship',413);
  const peer={...pair.peer,relationshipId,key:pair.key,address:pair.address,revoked:false,pairedAt:nowISO(this.now()),firstReceiptAt:null,lastReceiptAt:null,lastAcknowledgedAt:null,grant:{hostId:pair.peer.hostId,sourceRole:'codex-source'}};
  await this.validatePeer(peer);verify();const next=structuredClone(this.#s);if(!existing)next.peers.push(peer);
  if(next.role==='node'){next.destination={id:peer.id,relationshipId};next.pendingAssignment={destinationId:peer.id,relationshipId,queueIds:[...this.#queue.values()].filter(q=>q.destinationId===null&&!q.ack).map(q=>q.id),captureIds:[...this.#captures.values()].filter(c=>c.destinationId===null&&c.status!=='framed').map(c=>c.id)};}
  next.revision++;pair.status='paired';pair.expiresAt=this.now()+300000;await this.#save(next,'establish-trust-and-assignment-intent',verify);
  await this.onPeersChanged(this.#trusted());await this.#resumeAssignment(verify);
  await this.#discovery?.update({pairable:false});
 }
 async #resumeAssignment(verify=()=>{}){
  const intent=this.#s.pendingAssignment;if(!intent)return;
  if(!this.#s.peers.some(p=>p.id===intent.destinationId&&p.relationshipId===intent.relationshipId)||!Array.isArray(intent.queueIds))throw failure('Backlog assignment recovery requires its original trust history',503);
  for(const id of intent.queueIds){if(!/^[a-f0-9]{64}$/.test(id)||!this.#queue.has(id))throw failure('Backlog assignment record unavailable; preserve intent',503);const file=path.join(this.outbox,id+'.json'),q=await readJSONFile(file);
   if(q.destinationId!==null&&(q.destinationId!==intent.destinationId||q.relationshipId!==intent.relationshipId))throw failure('Backlog assignment identity conflict',503);
   if(q.destinationId===null){q.destinationId=intent.destinationId;q.relationshipId=intent.relationshipId;q.assignment={at:nowISO(this.now()),by:'explicit-pairing-confirmation',originalDestination:null};await atomicJSON(file,q,verify);this.#queue.set(id,this.#metadata(q));}
  }
  for(const id of intent.captureIds||[]){const meta=this.#captures.get(id);if(!meta)throw failure('Capture assignment custody unavailable',503);const file=path.join(this.captures,id+'.json'),capture=await readJSONFile(file,33554432);if(capture.destinationId!==null&&(capture.destinationId!==intent.destinationId||capture.relationshipId!==intent.relationshipId))throw failure('Capture destination conflict',503);if(capture.destinationId===null){capture.destinationId=intent.destinationId;capture.relationshipId=intent.relationshipId;capture.assignment={by:'explicit-pairing-confirmation',at:nowISO(this.now())};await atomicJSON(file,capture,verify,33554432);meta.destinationId=intent.destinationId;meta.relationshipId=intent.relationshipId;}}
  await this.#save({...this.#s,pendingAssignment:null,revision:this.#s.revision+1},'complete-backlog-assignment',verify);
 }
 async cancelPairing({revision,id,owner='TEST_ONLY-system',verifyAuthority=()=>{}}={}){
  const pair=await this.#serial(async()=>{verifyAuthority();this.#revision(revision);const p=this.#pairs.get(id);if(p&&!p.recovered&&p.owner!==owner)throw failure('Pairing belongs to another session',403);if(!p)return null;await this.#cancelTransaction(p,verifyAuthority);return {...p};});
  if(pair?.peer&&pair.key)try{const result=await protectedRequest(pair.address,{identity:'pair:'+id,key:pair.key,route:'/pair/cancel',body:{id,installationId:this.#s.id},verify:verifyAuthority});if(result.canceled!==true)throw failure('Cancellation not confirmed',409);await this.#serial(async()=>{verifyAuthority();const current=this.#pairs.get(id);if(current?.status==='canceled'){current.remoteCancellationConfirmed=true;await this.#save({...this.#s},'confirm-remote-cancellation',verifyAuthority);}});}catch{}return this.state();
 }
 async #cancelTransaction(pair,verify=()=>{},remoteRequest=false){const next=structuredClone(this.#s),relationshipId=digest([pair.id,...[this.#s.id,pair.peer?.id].sort()]).slice(0,64);for(const peer of next.peers)if(peer.relationshipId===relationshipId){peer.revoked=true;peer.revokedAt=nowISO(this.now());peer.revocationReason='pairing-canceled';}pair.status='canceled';pair.confirmedLocal=false;pair.remoteCancellationConfirmed=remoteRequest||pair.remoteCancellationConfirmed===true;this.#abortOutbound();next.revision++;await this.#save(next,'cancel-pairing',verify);await this.#discovery?.update({pairable:false});await this.onPeersChanged(this.#trusted());}
 async #receive(route,body,auth){if(route==='/pair/hello')return this.#serial(async()=>{if(auth.kind!=='invite')throw failure('Invitation required',403);const pair=this.#pairs.get(auth.id);if(!pair||pair.status!=='accepting'||pair.expiresAt<=this.now())throw failure('Pairing invitation consumed or expired',409);const peer=peerIdentity(body.installation);if(peer.id===this.#s.id||peer.hostId===this.#s.hostId||!complementary(this.#s.role,peer.role)||body.expectedId&&body.expectedId!==this.#s.id)throw failure('Installation identity mismatch',403);if(!/^[a-f0-9]{32}$/.test(body.nonce))throw failure('Invalid pairing nonce');destination(body.address);pair.key=crypto.randomBytes(32).toString('base64url');pair.peer=peer;pair.address=body.address;pair.status='awaiting-confirmation';delete pair.inviteKey;await this.#save({...this.#s,revision:this.#s.revision+1},'receive-pairing');return {id:pair.id,installation:publicIdentity(this.#s),key:pair.key,expiresAt:pair.expiresAt,nonce:body.nonce};});
  if(route==='/pair/confirm')return this.#serial(async()=>{const pair=this.#pairs.get(auth.id);if(auth.kind!=='pair'||!pair||pair.expiresAt<=this.now()||pair.peer?.id!==body.installationId||body.expectedId!==this.#s.id||body.id!==pair.id||!complementary(this.#s.role,pair.peer.role))throw failure('Pairing confirmation identity mismatch',403);if(pair.status==='canceled')throw failure('Pairing was canceled',409);pair.confirmedRemote=true;await this.#finishPair(pair);if(pair.status!=='paired')await this.#save({...this.#s},'receive-confirmation');return {installationId:this.#s.id,confirmedLocal:pair.confirmedLocal===true};});
   if(route==='/pair/cancel')return this.#serial(async()=>{const pair=this.#pairs.get(auth.id);if(!['pair','canceled-pair'].includes(auth.kind)||pair?.peer?.id!==body.installationId)throw failure('Pairing identity mismatch',403);await this.#cancelTransaction(pair,()=>{},true);return {canceled:true};});
  const peer=this.#s.peers.find(p=>p.relationshipId===auth.id&&!p.revoked);if(auth.kind!=='peer'||!peer||peer.id!==body.installationId||body.expectedId!==this.#s.id)throw failure('Trusted installation identity required',403);
  if(route==='/identity')return {installation:publicIdentity(this.#s),relationshipId:peer.relationshipId};
  if(route==='/report')return this.#serial(async()=>{
   // The serialized grant lease spans durable journal acceptance. Revocation and
   // role changes cannot complete while an already authorized commit is in flight.
   const verifyGrant=()=>{if(this.#s.role!=='hub'||!this.#s.peers.some(p=>p.relationshipId===peer.relationshipId&&!p.revoked))throw failure('Reporting grant changed',403);};verifyGrant();
   if(peer.role!=='node'||typeof this.ingest!=='function')throw failure('This installation is not accepting Node observations',409);
   const {payload,sha256}=body;if(payload?.hostId!==peer.hostId||digest(payload)!==sha256||!Number.isSafeInteger(body.recordCount)||body.recordCount!==(payload.events?.length+payload.usageSamples?.length||1))throw failure('Report identity/fingerprint/count mismatch',403);
   const reported=peerIdentity(body.installation);if(reported.id!==peer.id||reported.hostId!==peer.hostId||reported.role!=='node')throw failure('Reporting installation identity mismatch',403);const receipt=await this.ingest(peer,payload,sha256,{verifyGrant});verifyGrant();
   if(!receipt||receipt.hostId!==peer.hostId||receipt.batchId!==payload.batchId||!Number.isSafeInteger(receipt.journalSequence))throw failure('Durable receiver receipt unavailable',503);
   const next=structuredClone(this.#s),current=next.peers.find(p=>p.relationshipId===peer.relationshipId);current.firstReceiptAt??=nowISO(this.now());current.lastReceiptAt=nowISO(this.now());const renamed=current.reportedName!==reported.name;current.reportedName=reported.name;if(!current.alias)current.name=reported.name;await this.#save(next,'authenticated-receipt',verifyGrant);if(renamed)await this.onPeersChanged(this.#trusted());
   return {version:1,installation:publicIdentity(this.#s),hubId:this.#s.id,nodeId:peer.id,relationshipId:peer.relationshipId,batchId:payload.batchId,sha256,recordCount:body.recordCount,journalSequence:receipt.journalSequence};
  });
  throw failure('Unsupported protected route',404);
 }
 async revoke({revision,peerId,verifyAuthority=()=>{}}={}){await this.#change('revoke-trust',next=>{const peers=next.peers.filter(p=>p.id===peerId);if(!peers.length)throw failure('Installation unavailable',404);this.#abortOutbound();for(const p of peers){p.revoked=true;p.revokedAt=nowISO(this.now());}for(const pair of this.#pairs.values())if(pair.peer?.id===peerId)pair.status='canceled';},{revision,verifyAuthority});await this.onPeersChanged(this.#trusted());return this.state();}
 async updateAddress({revision,peerId,address,verifyAuthority=()=>{}}={}){destination(address);const peer=await this.#serial(()=>{verifyAuthority();this.#revision(revision);const p=this.#s.peers.find(p=>p.id===peerId&&!p.revoked);if(!p)throw failure('Trusted installation unavailable',404);return {...p};});const proof=await protectedRequest(address,{identity:'peer:'+peer.relationshipId,key:peer.key,route:'/identity',body:{installationId:this.#s.id,expectedId:peer.id},verify:verifyAuthority});if(proof.installation?.id!==peer.id||proof.relationshipId!==peer.relationshipId)throw failure('Address identity mismatch',403);return this.#change('verified-address-update',next=>{const p=next.peers.find(p=>p.relationshipId===peer.relationshipId&&!p.revoked);if(!p)throw failure('Trust changed',409);p.address=new URL(address).origin;},{revision,verifyAuthority});}
 async #reconcileReceipts(){
  const next=structuredClone(this.#s);let changed=false;
  for(const [id,meta]of this.#queue){if(!meta.ack)continue;const q=await readJSONFile(path.join(this.outbox,id+'.json')),peer=next.peers.find(p=>p.id===q.destinationId&&p.relationshipId===q.relationshipId);
   try{if(!peer)throw failure('Receipt trust history missing',409);const reported=receiptIdentity(q.ack,q,peer,this.#s.id);if(!Number.isFinite(Date.parse(q.ack.at)))throw failure('Receipt time invalid',409);peer.firstReceiptAt=peer.firstReceiptAt&&peer.firstReceiptAt<q.ack.at?peer.firstReceiptAt:q.ack.at;peer.lastAcknowledgedAt=peer.lastAcknowledgedAt&&peer.lastAcknowledgedAt>q.ack.at?peer.lastAcknowledgedAt:q.ack.at;peer.reportedName=reported.name;if(!peer.alias)peer.name=reported.name;changed=true;
   }catch{q.receiptRecovery={state:'revalidation-required',rejected:q.ack};q.ack=null;await atomicJSON(path.join(this.outbox,id+'.json'),q);this.#queue.set(id,this.#metadata(q));}
  }
  if(changed)await this.#save(next,'recover-validated-receipt');
 }
 async stageCapture(local,{usageCapture}={}){return this.#serial(async()=>{
  if(this.#s.role!=='node')return null;await this.#probeStorage();if(this.#storage.state==='low')throw failure('Local storage pressure: source custody retained for retry',503);
  if(local?.host?.id!==this.#s.hostId||!Array.isArray(local.events||[])||!Array.isArray(local.sessions||[])||!Array.isArray(usageCapture?.usageSamples||[])||!Number.isFinite(Date.parse(local.observedAt)))throw failure('Invalid local capture identity/observation',403);
  const data=structuredClone({local,...(usageCapture?{usageCapture}:{})}),sha256=digest(data),id=digest([this.#s.hostId,sha256]);
  if(!this.#captures.has(id)){const destination=this.#s.destination,intent={version:1,id,sha256,data,status:'staged',localCommitted:false,createdAt:nowISO(this.now()),destinationId:destination?.id??null,relationshipId:destination?.relationshipId??null};await atomicJSON(path.join(this.captures,id+'.json'),intent,()=>{},33554432);this.#captures.set(id,{id,status:'staged',localCommitted:false,recordCount:data.local.events.length+(data.usageCapture?.usageSamples?.length||0)||1,destinationId:intent.destinationId,relationshipId:intent.relationshipId,error:null});}
  return {id};
 });}
 async commitCapture(id){return this.#serial(async()=>{const meta=this.#captures.get(id);if(!meta)throw failure('Capture custody unavailable',503);if(meta.status==='framed')return {queued:true,batches:0};const file=path.join(this.captures,id+'.json'),intent=await readJSONFile(file,33554432);intent.localCommitted=true;await atomicJSON(file,intent,()=>{},33554432);meta.localCommitted=true;try{const batches=await this.#frameCapture(intent);intent.status='framed';intent.error=null;await atomicJSON(file,intent,()=>{},33554432);meta.status='framed';meta.error=null;return {queued:true,batches};}catch(error){intent.error='transport-framing-deferred';await atomicJSON(file,intent,()=>{},33554432);meta.error=intent.error;throw error;}});}
 async recoverCaptures(commitLocal){for(const meta of [...this.#captures.values()].filter(m=>m.status!=='framed').slice(0,8)){const intent=await readJSONFile(path.join(this.captures,meta.id+'.json'),33554432);if(!intent.localCommitted)await commitLocal(intent.data.local,{usageCapture:intent.data.usageCapture});try{await this.commitCapture(meta.id);}catch{break;}}}
 async #frameCapture(intent){
  const {local,usageCapture}=intent.data,events=local.events||[],samples=usageCapture?.usageSamples??[],sessions=(local.sessions||[]).map(({events,...session})=>session);
  const chunks=Math.max(1,Math.ceil(events.length/500),Math.ceil(samples.length/1000),Math.ceil(sessions.length/128));
  const parts=Array.from({length:chunks},(_,i)=>({sessions:sessions.slice(i*128,(i+1)*128),events:events.slice(i*500,(i+1)*500),usageSamples:samples.slice(i*1000,(i+1)*1000)}));
  const payloadFor=(part,index,count)=>({hostId:this.#s.hostId,batchId:digest([intent.id,index]),observedAt:local.observedAt,host:local.host,...part,...(count>1?{sessionFrame:{id:intent.id,index,count}}:{}),coverage:local.coverage||{},...(local.accountUsage?{accountUsage:local.accountUsage}:{}),...(local.desktopCompanion?{desktopCompanion:local.desktopCompanion}:{})});
  // Partition by both record counts and encoded bytes; never drop a source row.
  for(let i=0;i<parts.length;i++){
   if(parts.length>4096)throw failure('Observation retained for explicit framing recovery',413);
   const part=parts[i];if(Buffer.byteLength(JSON.stringify(payloadFor(part,4095,4096)))<=1899000)continue;
   const key=['sessions','events','usageSamples'].filter(k=>part[k].length>1).sort((a,b)=>Buffer.byteLength(JSON.stringify(part[b]))-Buffer.byteLength(JSON.stringify(part[a])))[0];
   if(!key)throw failure('Oversized indivisible source row retained for delivery recovery',413);
   const split=Math.ceil(part[key].length/2),first={...part,[key]:part[key].slice(0,split)},second={sessions:[],events:[],usageSamples:[],[key]:part[key].slice(split)};
   parts.splice(i,1,first,second);i--;
  }
  let queued=0;for(let i=0;i<parts.length;i++){
   const payload=payloadFor(parts[i],i,parts.length),sha256=digest(payload),id=digest([payload.batchId,sha256]);if(this.#queue.has(id))continue;
   const q={version:1,id,createdAt:intent.createdAt,destinationId:intent.destinationId,relationshipId:intent.relationshipId,payload,sha256,recordCount:payload.events.length+payload.usageSamples.length||1,ack:null};await atomicJSON(path.join(this.outbox,id+'.json'),q);this.#queue.set(id,this.#metadata(q));queued++;
  }return queued;
 }
 async capture(local,{usageCapture}={}){const ticket=await this.stageCapture(local,{usageCapture});return ticket?this.commitCapture(ticket.id):{queued:false};}
 #abortOutbound(){for(const controller of this.#outbound)controller.abort();}
 async flush({maxBatches=8,request=protectedRequest}={}){
  if(this.#flushing||this.#s.role!=='node'||this.#closed)return {sent:0};this.#flushing=true;let sent=0;
  try{for(const [id,meta]of this.#queue){if(sent>=Math.min(32,maxBatches)||this.#s.role!=='node')break;if(meta.ack||meta.retryAt>this.now())continue;
   const peer=this.#s.peers.find(p=>p.id===meta.destinationId&&p.relationshipId===meta.relationshipId&&!p.revoked);if(!peer)continue;
   const controller=new AbortController();this.#outbound.add(controller);
   const verify=()=>{if(this.#closed||controller.signal.aborted||this.#s.role!=='node'||['applying','recovering'].includes(this.#s.phase)||!this.#s.peers.some(p=>p.id===peer.id&&p.relationshipId===peer.relationshipId&&p.key===peer.key&&!p.revoked))throw failure('Reporting authority changed',409);};
   try{const q=await readJSONFile(path.join(this.outbox,id+'.json'));verify();
    const ack=await request(peer.address,{identity:'peer:'+peer.relationshipId,key:peer.key,route:'/report',verify,signal:controller.signal,body:{installation:publicIdentity(this.#s),installationId:this.#s.id,expectedId:peer.id,payload:q.payload,sha256:q.sha256,recordCount:q.recordCount}});verify();
     const reported=receiptIdentity(ack,q,peer,this.#s.id);
     await this.#serial(async()=>{verify();q.ack={...ack,at:nowISO(this.now()),archiveCustody:false};await atomicJSON(path.join(this.outbox,id+'.json'),q,verify);this.#queue.set(id,this.#metadata(q));const next=structuredClone(this.#s),p=next.peers.find(p=>p.relationshipId===peer.relationshipId);p.firstReceiptAt??=q.ack.at;p.lastAcknowledgedAt=q.ack.at;p.lastError=null;p.reportedName=reported.name;if(!p.alias)p.name=reported.name;await this.#save(next,'validated-report-ack',verify);});sent++;

   }catch(error){meta.attempts=(meta.attempts||0)+1;meta.retryAt=this.now()+Math.min(60000,1000*2**Math.min(6,meta.attempts));if(!this.#closed)await this.#change('delivery-deferred',next=>{const p=next.peers.find(p=>p.relationshipId===peer.relationshipId);if(p)p.lastError=[400,401,403,409,413].includes(error.status)?'rejected':'unreachable';});break;}
   finally{this.#outbound.delete(controller);}
  }return {sent};}finally{this.#flushing=false;}
 }
 async discover({revision,enabled,verifyAuthority=()=>{},signal}={}){verifyAuthority();this.#revision(revision);this.#rolePairable();if(!enabled){await this.#discovery.close();return this.state();}if(!this.#discovery||this.#discovery.closed)this.#discovery=new InstallationDiscovery({...this.#discoveryOptions,identity:publicIdentity(this.#s)});const host=selectInstallationAddress(this.network);if(!this.#discovery.started)await this.#discovery.start({advertise:true,pairable:this.#s.role==='node'&&[...this.#pairs.values()].some(p=>p.status==='accepting'),address:host,port:this.#server.address().port});await this.#discovery.browse({role:this.#s.role==='hub'?'node':'hub',signal,timeoutMs:1000});verifyAuthority();for(const candidate of this.#discovery.candidates().slice(0,8)){const peer=this.#s.peers.find(p=>p.id===candidate.id&&!p.revoked);if(peer&&!candidate.collision&&peer.address!==candidate.address)try{await this.updateAddress({revision:this.#s.revision,peerId:peer.id,address:candidate.address,verifyAuthority});}catch{}}return this.state();}
 async close(){if(this.#closed)return;this.#closed=true;this.#abortOutbound();await this.#serialWork;await this.#discovery?.close();if(this.#server){this.#server.closeAllConnections?.();await new Promise(resolve=>this.#server.close(resolve));this.#server=undefined;}this.#pairs.clear();}
}
