import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {ControlError,isControlError} from '../lib/errors.mjs';
import {strictRecord,uuid,integer,deepFreeze,canonicalJson} from '../lib/privacy.mjs';
import {validatePrincipal,validateHost,validateProject,grant,metadataDigest} from '../contracts/authority.mjs';
import {OPERATION_ACTIONS} from '../contracts/operations.mjs';
import {localDirectory,assertLocalOwner} from './local-owner.mjs';
const ddl=fs.readFileSync(new URL('../migrations/authority-001.sql',import.meta.url),'utf8');
const schemaHash=createHash('sha256').update(ddl).digest('hex');
const MiB=1024*1024;
const fail=code=>{throw new ControlError(code);};
/** Dedicated protected local authorization/configuration state; no secret keys or content. */
export class AuthorityStore {
  #db;#closed=false;#now;#directory;#maxBytes;
  static open(options){return new AuthorityStore(options);}
  constructor(options) {
    strictRecord(options,['directory','owner','hubId','now','maxAuditBytes','busyTimeoutMs'],['directory','owner','hubId']);
    const {directory,owner,hubId,now=Date.now,maxAuditBytes=64*MiB,busyTimeoutMs=1000}=options;
    uuid(hubId);if(typeof now!=='function')fail('INVALID_INPUT');
    this.#now=now;this.#maxBytes=integer(maxAuditBytes,1024,1024*MiB);
    try{
      this.#directory=localDirectory(directory);assertLocalOwner(owner,this.#directory);
      const file=path.join(this.#directory,'control-authority.sqlite');
      for(const suffix of ['','-wal','-shm'])if(fs.existsSync(file+suffix)){const stat=fs.lstatSync(file+suffix);if(!stat.isFile()||stat.isSymbolicLink())fail('INVALID_INPUT');}
      this.#db=new DatabaseSync(file);this.#db.exec('PRAGMA busy_timeout='+integer(busyTimeoutMs,0,5000)+'; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
      const version=this.#db.prepare('PRAGMA user_version').get().user_version;
      const tables=this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if(version!==0&&version!==1||version===0&&tables.length)fail('SCHEMA_MISMATCH');
      if(version===1&&(!tables.some(row=>row.name==='authority_schema')||this.#db.prepare('SELECT sha256 FROM authority_schema WHERE id=1').get()?.sha256!==schemaHash))fail('SCHEMA_MISMATCH');
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.#transaction(()=>{
        if(this.#db.prepare('PRAGMA user_version').get().user_version===0){
          this.#db.exec(ddl);this.#db.exec('CREATE TABLE authority_schema(id INTEGER PRIMARY KEY CHECK(id=1),sha256 TEXT NOT NULL) STRICT;');
          this.#db.prepare('INSERT INTO authority_schema VALUES(1,?)').run(schemaHash);
          this.#db.prepare('INSERT INTO authority_state VALUES(1,?,1,1,NULL,?)').run(hubId,integer(this.#now()));
        }
        if(this.#db.prepare('SELECT hub_id FROM authority_state WHERE id=1').get()?.hub_id!==hubId)fail('CONFLICT');
      });
    }catch(error){try{this.#db?.close();}catch{}this.#closed=true;if(isControlError(error))throw error;fail('STORAGE_UNAVAILABLE');}
  }
  #assert(){if(this.#closed)fail('CLOSED');}
  #transaction(callback){this.#assert();let begun=false;try{this.#db.exec('BEGIN IMMEDIATE');begun=true;const result=callback();if(result&&typeof result.then==='function')fail('INVALID_INPUT');this.#db.exec('COMMIT');return result;}catch(error){if(begun)try{this.#db.exec('ROLLBACK');}catch{}if(isControlError(error))throw error;fail('STORAGE_UNAVAILABLE');}}
  #read(callback){this.#assert();try{return callback();}catch(error){if(isControlError(error))throw error;fail('STORAGE_UNAVAILABLE');}}
  state(){return this.#read(()=>{const r=this.#db.prepare('SELECT * FROM authority_state WHERE id=1').get();return deepFreeze({hubId:uuid(r.hub_id),generation:integer(r.generation,1),policyRevision:integer(r.policy_revision,1),bootstrapped:r.bootstrap_request!==null,lastAtMs:integer(r.last_at_ms)});});}
  #metadata(table,key,id,validator){return this.#read(()=>{const r=this.#db.prepare('SELECT metadata_json FROM '+table+' WHERE '+key+'=?').get(id);return r?validator(JSON.parse(r.metadata_json)):null;});}
  principal(actorId){return this.#metadata('principals','actor_id',uuid(actorId),validatePrincipal);}
  principalForViewer(viewerId){if(typeof viewerId!=='string'||viewerId.length>128)fail('INVALID_INPUT');return this.#read(()=>{const r=this.#db.prepare('SELECT metadata_json FROM principals WHERE viewer_id=?').get(viewerId);return r?validatePrincipal(JSON.parse(r.metadata_json)):null;});}
  isManager(actorId){return this.#read(()=>this.#db.prepare('SELECT enabled FROM managers WHERE actor_id=?').get(uuid(actorId))?.enabled===1&&this.principal(actorId)?.enabled===true);}
  getGrant(id){return this.#metadata('grants','grant_id',uuid(id),grant);}
  host(id){return this.#metadata('hosts','host_id',uuid(id),validateHost);}
  pendingHost(id){return this.#metadata('pending_hosts','host_id',uuid(id),validateHost);}
  project(id){return this.#metadata('projects','project_id',uuid(id),validateProject);}
  grantsFor(actorId,hostId,projectId){return this.#read(()=>{const rows=this.#db.prepare('SELECT metadata_json FROM grants WHERE actor_id=? AND host_id=? AND project_id=? LIMIT 129').all(uuid(actorId),uuid(hostId),uuid(projectId));if(rows.length>128)fail('CAPACITY');return rows.map(row=>grant(JSON.parse(row.metadata_json)));});}
  #writeMetadata(table,key,id,value){const text=canonicalJson(value);this.#db.prepare('INSERT INTO '+table+'('+key+',metadata_json) VALUES(?,?) ON CONFLICT('+key+') DO UPDATE SET metadata_json=excluded.metadata_json').run(id,text);}
  #mutate({requestId,actorId,kind,subjectId,input,emergency=false,authorize=null},write,current){
    uuid(requestId);uuid(actorId);uuid(subjectId);const inputSha256=metadataDigest(input);
    if(authorize!==null&&typeof authorize!=='function')fail('INVALID_INPUT');
    return this.#transaction(()=>{
      authorize?.();
      const old=this.#db.prepare('SELECT * FROM authority_requests WHERE request_id=?').get(requestId);
      if(old){if(old.actor_id!==actorId||old.kind!==kind||old.input_sha256!==inputSha256)fail('CONFLICT');return deepFreeze({duplicate:true,receipt:JSON.parse(old.receipt_json),current:current()});}
      const now=integer(this.#now()),state=this.state();if(now<state.lastAtMs)fail('CLOCK_INVALID');
      const stat=fs.statfsSync(this.#directory,{bigint:true});if(stat.bavail*stat.bsize<BigInt((emergency?4:64)*MiB+64*1024))fail('CAPACITY');
      const auditBytes=this.#db.prepare('SELECT bytes FROM authority_counts WHERE id=1').get().bytes;
      if(!emergency&&auditBytes+4096>this.#maxBytes)fail('CAPACITY');
      authorize?.();
      const revision=integer(write(),1),after=this.state();
      const receipt={version:1,eventId:randomUUID(),requestId,actorId,kind,subjectId,revision,generation:after.generation,atMs:now};
      const text=canonicalJson(receipt);
      this.#db.prepare('INSERT INTO authority_audit(event_id,metadata_json,metadata_bytes) VALUES(?,?,?)').run(receipt.eventId,text,Buffer.byteLength(text));
      this.#db.prepare('INSERT INTO authority_requests VALUES(?,?,?,?,?)').run(requestId,actorId,kind,inputSha256,text);
      this.#db.prepare('UPDATE authority_state SET last_at_ms=? WHERE id=1').run(now);
      return deepFreeze({duplicate:false,receipt,current:current()});
    });
  }
  bootstrap({requestId,principal,owner,recover=false,authorize=null}){
    principal=validatePrincipal(principal);assertLocalOwner(owner,this.#directory);
    if(!principal.enabled)fail('INVALID_INPUT');
    return this.#mutate({requestId,actorId:principal.actorId,kind:recover?'RECOVERED':'BOOTSTRAPPED',subjectId:principal.actorId,input:{actorId:principal.actorId,viewerId:principal.viewerId,recover},authorize},()=>{
      const state=this.state();if(!recover&&state.bootstrapped||recover&&!state.bootstrapped)fail('CONFLICT');
      const previous=this.principalForViewer(principal.viewerId);if(previous&&previous.actorId!==principal.actorId)fail('CONFLICT');
      const existing=this.principal(principal.actorId);if(existing&&existing.viewerId!==principal.viewerId)fail('CONFLICT');if(existing&&existing.revision!==principal.revision)fail('STALE_REVISION');
      this.#db.prepare('INSERT INTO principals VALUES(?,?,?) ON CONFLICT(actor_id) DO UPDATE SET metadata_json=excluded.metadata_json').run(principal.actorId,principal.viewerId,canonicalJson(principal));
      if(recover){this.#db.exec('UPDATE managers SET enabled=0; UPDATE authority_state SET generation=generation+1 WHERE id=1;');}
      this.#db.prepare('INSERT INTO managers VALUES(?,1) ON CONFLICT(actor_id) DO UPDATE SET enabled=1').run(principal.actorId);
      this.#db.prepare('UPDATE authority_state SET bootstrap_request=? WHERE id=1').run(requestId);
      return this.state().generation;
    },()=>({manager:this.isManager(principal.actorId),generation:this.state().generation}));
  }
  putPrincipal({requestId,managerId,principal,expectedRevision,authorize=null}){
    principal=validatePrincipal(principal);integer(expectedRevision);
    return this.#mutate({requestId,actorId:managerId,kind:'PRINCIPAL_WRITTEN',subjectId:principal.actorId,input:{principal,expectedRevision},authorize},()=>{
      if(!this.isManager(managerId))fail('CONTROL_DISABLED');const old=this.principal(principal.actorId);
      if((old?.revision??0)!==expectedRevision||principal.revision!==expectedRevision+1||old&&old.viewerId!==principal.viewerId)fail('STALE_REVISION');
      this.#db.prepare('INSERT INTO principals VALUES(?,?,?) ON CONFLICT(actor_id) DO UPDATE SET metadata_json=excluded.metadata_json').run(principal.actorId,principal.viewerId,canonicalJson(principal));
      return principal.revision;
    },()=>this.principal(principal.actorId));
  }
  putGrant({requestId,managerId,value,expectedRevision,authorize=null}){
    value=grant(value);integer(expectedRevision);
    return this.#mutate({requestId,actorId:managerId,kind:'GRANT_WRITTEN',subjectId:value.grantId,input:{value,expectedRevision},emergency:!value.enabled,authorize},()=>{
      if(!this.isManager(managerId)||!this.principal(value.actorId)?.enabled)fail('CONTROL_DISABLED');
      const state=this.state(),old=this.getGrant(value.grantId),host=this.host(value.hostId),project=this.project(value.projectId);
      if((old?.grantRevision??0)!==expectedRevision||value.grantRevision!==expectedRevision+1)fail('STALE_REVISION');
      if(value.actions.includes('control.grants.manage')||value.authorityGeneration!==state.generation||value.policyRevision!==state.policyRevision||value.createdAtMs>integer(this.#now())||value.expiresAtMs<=integer(this.#now()))fail('STALE_CONTEXT');
      if(!host||host.state!=='ACTIVE'||!project?.enabled||project.hostId!==host.hostId||value.providerProfileId!==null&&!project.providerProfileIds.includes(value.providerProfileId))fail('CONTROL_DISABLED');
      this.#db.prepare('INSERT INTO grants VALUES(?,?,?,?,?) ON CONFLICT(grant_id) DO UPDATE SET actor_id=excluded.actor_id,host_id=excluded.host_id,project_id=excluded.project_id,metadata_json=excluded.metadata_json').run(value.grantId,value.actorId,value.hostId,value.projectId,canonicalJson(value));return value.grantRevision;
    },()=>this.getGrant(value.grantId));
  }
  putProject({requestId,managerId,value,expectedRevision,authorize=null}){
    value=validateProject(value);integer(expectedRevision);
    return this.#mutate({requestId,actorId:managerId,kind:'PROJECT_WRITTEN',subjectId:value.projectId,input:{value,expectedRevision},emergency:!value.enabled,authorize},()=>{
      if(!this.isManager(managerId)||this.host(value.hostId)?.state!=='ACTIVE')fail('CONTROL_DISABLED');
      const old=this.project(value.projectId);if((old?.revision??0)!==expectedRevision||value.revision!==expectedRevision+1)fail('STALE_REVISION');
      if(old&&(old.identitySha256!==value.identitySha256||old.hostId!==value.hostId))fail('CONFLICT');
      this.#db.prepare('INSERT INTO projects VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET metadata_json=excluded.metadata_json').run(value.projectId,value.hostId,canonicalJson(value));return value.revision;
    },()=>this.project(value.projectId));
  }
  beginEnrollment({requestId,managerId,value,authorize=null}){
    value=validateHost(value);if(value.state!=='PENDING'||value.requestId!==requestId||value.hubId!==this.state().hubId)fail('INVALID_INPUT');
    return this.#mutate({requestId,actorId:managerId,kind:'HOST_PENDING',subjectId:value.hostId,input:value,authorize},()=>{
      if(!this.isManager(managerId))fail('CONTROL_DISABLED');const old=this.host(value.hostId),pending=this.pendingHost(value.hostId);
      if(pending&&pending.requestId!==requestId&&pending.expiresAtMs>integer(this.#now()))fail('CONFLICT');
      if(value.generation!==(old?.generation??0)+1||value.expiresAtMs<=integer(this.#now()))fail('STALE_CONTEXT');
      if(old&&old.publicKey===value.publicKey)fail('CONFLICT');
      this.#writeMetadata('pending_hosts','host_id',value.hostId,value);return value.generation;
    },()=>this.pendingHost(value.hostId));
  }
  activateEnrollment({requestId,managerId,hostId,enrollmentRequestId,authorize=null}){
    uuid(hostId);uuid(enrollmentRequestId);
    return this.#mutate({requestId,actorId:managerId,kind:'HOST_ACTIVATED',subjectId:hostId,input:{hostId,enrollmentRequestId},authorize},()=>{
      if(!this.isManager(managerId))fail('CONTROL_DISABLED');const pending=this.pendingHost(hostId);
      if(!pending||pending.requestId!==enrollmentRequestId||pending.expiresAtMs<=integer(this.#now()))fail('EXPIRED');
      this.#writeMetadata('hosts','host_id',hostId,{...pending,state:'ACTIVE'});
      this.#db.prepare('DELETE FROM pending_hosts WHERE host_id=?').run(hostId);return pending.generation;
    },()=>this.host(hostId));
  }
  revokeHost({requestId,managerId,hostId,expectedGeneration,authorize=null}){
    uuid(hostId);integer(expectedGeneration,1);
    return this.#mutate({requestId,actorId:managerId,kind:'HOST_REVOKED',subjectId:hostId,input:{hostId,expectedGeneration},emergency:true,authorize},()=>{
      if(!this.isManager(managerId))fail('CONTROL_DISABLED');const old=this.host(hostId);if(!old||old.generation!==expectedGeneration)fail('STALE_CONTEXT');
      this.#writeMetadata('hosts','host_id',hostId,{...old,generation:old.generation+1,state:'REVOKED'});this.#db.prepare('DELETE FROM pending_hosts WHERE host_id=?').run(hostId);return old.generation+1;
    },()=>this.host(hostId));
  }
  consume({assertionId,actorId,operationId,stage,action,binding,authorize}){
    uuid(assertionId);uuid(actorId);uuid(operationId);
    if(!['ADMISSION','DISPATCH','PUBLICATION'].includes(stage)||!OPERATION_ACTIONS.includes(action)||typeof authorize!=='function')fail('INVALID_INPUT');
    // binding is a closed, already validated assertion-metadata projection.
    strictRecord(binding,['operationSha256','hostGeneration','grantRevision','policyRevision','authorityGeneration','ownershipFence','connectionEpoch','sessionId']);
    // The trusted broker rechecks every current authority binding AFTER BEGIN
    // IMMEDIATE has acquired the writer lock. Another owner process may have
    // committed recovery/revocation while this connection was waiting.
    return this.#mutate({requestId:assertionId,actorId,kind:'ASSERTION_'+stage,subjectId:operationId,input:{action,...binding},emergency:['turn.interrupt','runtime.stop','terminal.terminate'].includes(action),authorize},()=>1,()=>null);
  }
  audit({after=0,limit=100}={}){integer(after);integer(limit,1,1000);return this.#read(()=>this.#db.prepare('SELECT sequence,metadata_json FROM authority_audit WHERE sequence>? ORDER BY sequence LIMIT ?').all(after,limit).map(row=>({sequence:row.sequence,record:JSON.parse(row.metadata_json)})));}
  status(){return this.#read(()=>{const counts=this.#db.prepare('SELECT records,bytes FROM authority_counts WHERE id=1').get();return {...this.state(),retainedRecords:counts.records,retainedBytes:counts.bytes,archive:'UNIMPLEMENTED_ALL_RETAINED'};});}
  close(){if(this.#closed)return;this.#db.close();this.#closed=true;}
}
