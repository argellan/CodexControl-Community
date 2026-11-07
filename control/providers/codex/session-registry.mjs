import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {ControlError} from '../../lib/errors.mjs';
import {strictRecord,uuid,opaqueToken,integer,deepFreeze,canonicalJson,enumValue} from '../../lib/privacy.mjs';
import {validateOperation} from '../../contracts/operations.mjs';
import {assertLocalOwner} from '../../broker/local-owner.mjs';
const fail=code=>{throw new ControlError(code??'STORAGE_UNAVAILABLE');};
const MiB=1048576,applicationId=0x43535033;
const schema=String.raw`
CREATE TABLE registry_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,registry_id TEXT NOT NULL);
CREATE TABLE runtimes(runtime_id TEXT PRIMARY KEY,metadata TEXT NOT NULL);
CREATE TABLE sessions(session_id TEXT PRIMARY KEY,native_thread_id TEXT,profile_id TEXT NOT NULL,current_runtime_id TEXT NOT NULL,metadata TEXT NOT NULL,UNIQUE(profile_id,native_thread_id));
CREATE INDEX sessions_by_runtime ON sessions(current_runtime_id);
CREATE TABLE registry_counts(id INTEGER PRIMARY KEY CHECK(id=1),bytes INTEGER NOT NULL,events INTEGER NOT NULL);
INSERT INTO registry_counts VALUES(1,0,0);
CREATE TABLE lifecycle_events(sequence INTEGER PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,metadata TEXT NOT NULL);
CREATE TRIGGER count_events AFTER INSERT ON lifecycle_events BEGIN UPDATE registry_counts SET bytes=bytes+length(CAST(NEW.metadata AS BLOB)),events=events+1 WHERE id=1; END;
CREATE TRIGGER immutable_events_update BEFORE UPDATE ON lifecycle_events BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER immutable_events_delete BEFORE DELETE ON lifecycle_events BEGIN SELECT RAISE(ABORT,'immutable'); END;
INSERT INTO registry_meta VALUES(1,1,'REGISTRY_ID');
`;
function binding(operation,profile,rootSha){return {hostId:operation.target.hostId,projectId:operation.target.projectId,profileId:profile.profileId,accountRef:profile.accountRef,accountBinding:profile.accountBinding,instructionBinding:profile.instructionBinding??null,rootSha,executableSha256:profile.executableSha256,schemaSha256:profile.schemaSha256,model:profile.model,effort:profile.effort,serviceTier:profile.serviceTier};}
function sameBinding(a,b){for(const key of ['hostId','projectId','profileId','accountRef','accountBinding','instructionBinding','rootSha','executableSha256','schemaSha256','model','effort','serviceTier'])if(a[key]!==b[key])fail('STALE_CONTEXT');}
export class CodexSessionRegistry {
  #db;#directory;#file;#identity;#owner;#guard;#now;#limit;#writing=false;#closed=false;
  static open(options){return new CodexSessionRegistry(options);}
  constructor(options){
    strictRecord(options,['directory','owner','guard','now','maxBytes'],['directory','owner','guard']);
    if(typeof options.guard!=='function')fail('INVALID_INPUT');assertLocalOwner(options.owner,options.directory);
    this.#directory=path.resolve(options.directory);this.#owner=options.owner;this.#guard=options.guard;this.#now=options.now??Date.now;this.#limit=integer(options.maxBytes??64*MiB,MiB,256*MiB);
    this.#file=path.join(this.#directory,'codex-lineage.sqlite');
    const existed=fs.existsSync(this.#file);
    try{if(existed){const s=fs.lstatSync(this.#file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)fail();}
      this.#db=new DatabaseSync(this.#file);this.#db.exec('PRAGMA busy_timeout=1000;');
      if(!existed){this.#db.exec('BEGIN IMMEDIATE;');try{this.#db.exec(schema.replace('REGISTRY_ID',randomUUID()));this.#db.exec('PRAGMA application_id='+applicationId+'; PRAGMA user_version=1; COMMIT;');}catch{this.#db.exec('ROLLBACK;');fail();}}
      if(this.#db.prepare('PRAGMA application_id').get().application_id!==applicationId||this.#db.prepare('PRAGMA user_version').get().user_version!==1||this.#db.prepare('SELECT version FROM registry_meta WHERE id=1').get()?.version!==1)fail('SCHEMA_MISMATCH');
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');this.#identity=fs.lstatSync(this.#file,{bigint:true});
    }catch(error){this.#db?.close();if(error instanceof ControlError)throw error;fail();}
  }
  #current(){
    try{
    if(this.#closed)fail('CLOSED');if(!this.#writing)assertLocalOwner(this.#owner,this.#directory);this.#guard();
    const stat=fs.lstatSync(this.#file,{bigint:true});if(stat.isSymbolicLink()||stat.nlink!==1n||stat.ino!==this.#identity.ino||stat.dev!==this.#identity.dev)fail('STALE_CONTEXT');
    }catch(error){if(error instanceof ControlError)throw error;fail();}
  }
  #read(read){try{this.#current();return read();}catch(error){if(error instanceof ControlError)throw error;fail();}}
  #write(kind,subject,change){
    this.#current();let begun=false;
    try{this.#db.exec('BEGIN IMMEDIATE;');begun=true;this.#writing=true;
      this.#current();const s=fs.statfsSync(this.#directory,{bigint:true});if(s.bavail*s.bsize<BigInt(kind.includes('INTENT')?64:4)*BigInt(MiB))fail('CAPACITY');
      const bytes=this.#db.prepare('SELECT bytes AS n FROM registry_counts WHERE id=1').get().n;if(kind.includes('INTENT')&&bytes+4096>this.#limit)fail('CAPACITY');
      const result=change();assertLocalOwner(this.#owner,this.#directory);this.#current();
      this.#db.prepare('INSERT INTO lifecycle_events(event_id,metadata) VALUES(?,?)').run(randomUUID(),canonicalJson({version:1,kind,subject:uuid(subject),atMs:integer(this.#now()),record:result}));
      this.#db.exec('COMMIT;');return deepFreeze(result);
    }catch(error){if(begun)try{this.#db.exec('ROLLBACK;');}catch{}if(error instanceof ControlError)throw error;fail();}finally{this.#writing=false;}
  }
  #saveRuntime(value){this.#db.prepare('UPDATE runtimes SET metadata=? WHERE runtime_id=?').run(canonicalJson(value),value.runtimeId);return value;}
  #saveSession(value){this.#db.prepare('UPDATE sessions SET native_thread_id=?,current_runtime_id=?,metadata=? WHERE session_id=?').run(value.nativeThreadId,value.currentRuntimeId,canonicalJson(value),value.sessionId);return value;}
  runtime(id){return this.#read(()=>{const r=this.#db.prepare('SELECT metadata FROM runtimes WHERE runtime_id=?').get(uuid(id));return r?deepFreeze(JSON.parse(r.metadata)):null;});}
  session(id){return this.#read(()=>{const r=this.#db.prepare('SELECT metadata FROM sessions WHERE session_id=?').get(uuid(id));return r?deepFreeze(JSON.parse(r.metadata)):null;});}
  reserveRuntime(input,profile,rootSha){
    const op=validateOperation(input);if(op.action!=='runtime.launch'||op.target.providerProfileId!==profile.profileId||typeof rootSha!=='string'||!/^[a-f0-9]{64}$/.test(rootSha))fail('INVALID_INPUT');
    return this.#write('RUNTIME_INTENT',op.target.runtimeId,()=>{
      if(this.runtime(op.target.runtimeId))fail('CONFLICT');
      const value={version:1,runtimeId:op.target.runtimeId,...binding(op,profile,rootSha),launchOperationId:op.operationId,connectionEpoch:op.context.connectionEpoch,ownershipFence:op.context.ownershipFence,state:'LAUNCH_INTENT',processBinding:null,pid:null};
      this.#db.prepare('INSERT INTO runtimes VALUES(?,?)').run(value.runtimeId,canonicalJson(value));return value;
    });
  }
  spawnedRuntime(id,process){
    strictRecord(process,['processBinding','pid']);uuid(process.processBinding);integer(process.pid,1);
    return this.#write('RUNTIME_SPAWNED',id,()=>{const r=this.runtime(id);if(r?.state!=='LAUNCH_INTENT'||r.processBinding!==null)fail('CONFLICT');return this.#saveRuntime({...r,...process});});
  }
  readyRuntime(id,process){
    strictRecord(process,['processBinding','pid']);uuid(process.processBinding);integer(process.pid,1);
    return this.#write('RUNTIME_READY',id,()=>{const r=this.runtime(id);if(r?.state!=='LAUNCH_INTENT')fail('CONFLICT');return this.#saveRuntime({...r,...process,state:'READY'});});
  }
  reserveSession(input){
    const op=validateOperation(input);if(op.action!=='session.create')fail('INVALID_INPUT');
    return this.#write('SESSION_CREATE_INTENT',op.target.sessionId,()=>{
      if(this.session(op.target.sessionId))fail('CONFLICT');const r=this.runtime(op.target.runtimeId);this.assertRuntime(op);
      if(this.#db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE current_runtime_id=?').get(r.runtimeId).n>=32)fail('CAPACITY');
      const value={version:1,sessionId:op.target.sessionId,nativeThreadId:null,...binding(op,r,r.rootSha),createdRuntimeId:r.runtimeId,currentRuntimeId:r.runtimeId,creationOperationId:op.operationId,pendingOperationId:op.operationId,connectionEpoch:op.context.connectionEpoch,ownershipFence:op.context.ownershipFence,state:'CREATE_INTENT',activeTurnId:null,activeOperationId:null,lastTurnStatus:null};
      this.#db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(value.sessionId,null,value.profileId,value.currentRuntimeId,canonicalJson(value));return value;
    });
  }
  createdSession(id,operationId,nativeThreadId){
    opaqueToken(nativeThreadId);uuid(operationId);
    return this.#write('SESSION_CREATED',id,()=>{const s=this.session(id);if(s?.state!=='CREATE_INTENT'||s.creationOperationId!==operationId)fail('CONFLICT');return this.#saveSession({...s,nativeThreadId,state:'READY',pendingOperationId:null});});
  }
  assertRuntime(input){
    const op=validateOperation(input),r=this.runtime(op.target.runtimeId);
    if(!r||r.state!=='READY'||r.hostId!==op.target.hostId||r.projectId!==op.target.projectId||r.profileId!==op.target.providerProfileId||r.connectionEpoch!==op.context.connectionEpoch||r.ownershipFence!==op.context.ownershipFence)fail('STALE_CONTEXT');return r;
  }
  assertSession(input,{active=false}={}){
    const op=validateOperation(input),r=this.assertRuntime(op),s=this.session(op.target.sessionId);
    if(!s||s.state!=='READY'||s.currentRuntimeId!==r.runtimeId||s.connectionEpoch!==op.context.connectionEpoch||s.ownershipFence!==op.context.ownershipFence||!s.nativeThreadId)fail('STALE_CONTEXT');sameBinding(s,r);
    if(active&&(s.activeTurnId===null||s.activeTurnId!==op.target.turnId))fail('STALE_CONTEXT');return s;
  }
  reserveResume(input){
    const op=validateOperation(input);if(op.action!=='session.resume')fail('INVALID_INPUT');
    return this.#write('SESSION_RESUME_INTENT',op.target.sessionId,()=>{
      const r=this.assertRuntime(op),s=this.session(op.target.sessionId),old=s?this.runtime(s.currentRuntimeId):null;
      if(!s||s.state!=='READY'||!s.nativeThreadId||s.activeTurnId!==null||old?.state!=='EXITED'||s.currentRuntimeId===r.runtimeId)fail('STALE_CONTEXT');sameBinding(s,r);
      return this.#saveSession({...s,currentRuntimeId:r.runtimeId,state:'RESUME_INTENT',pendingOperationId:op.operationId,connectionEpoch:op.context.connectionEpoch,ownershipFence:op.context.ownershipFence});
    });
  }
  resumedSession(id,operationId,nativeThreadId){
    return this.#write('SESSION_RESUMED',id,()=>{const s=this.session(id);if(s?.state!=='RESUME_INTENT'||s.pendingOperationId!==uuid(operationId)||s.nativeThreadId!==opaqueToken(nativeThreadId))fail('STALE_CONTEXT');return this.#saveSession({...s,state:'READY',pendingOperationId:null});});
  }
  reserveTurn(input){
    const op=validateOperation(input);if(op.action!=='turn.start')fail('INVALID_INPUT');
    return this.#write('TURN_INTENT',op.target.sessionId,()=>{const s=this.assertSession(op);if(s.activeTurnId!==null||s.pendingOperationId!==null)fail('CONFLICT');return this.#saveSession({...s,pendingOperationId:op.operationId});});
  }
  startedTurn(input,nativeTurnId){
    const op=validateOperation(input);opaqueToken(nativeTurnId);uuid(nativeTurnId);
    return this.#write('TURN_STARTED',op.target.sessionId,()=>{const s=this.assertSession(op);if(s.pendingOperationId!==op.operationId||s.activeTurnId!==null)fail('CONFLICT');return this.#saveSession({...s,pendingOperationId:null,activeTurnId:nativeTurnId,activeOperationId:op.operationId,lastTurnStatus:'inProgress'});});
  }
  finalTurn(sessionId,nativeTurnId,status){
    enumValue(status,['completed','failed','interrupted']);
    return this.#write('TURN_FINAL',sessionId,()=>{const s=this.session(sessionId);if(!s||!['READY','UNKNOWN'].includes(s.state)||s.activeTurnId!==opaqueToken(nativeTurnId))fail('STALE_CONTEXT');return this.#saveSession({...s,activeTurnId:null,activeOperationId:null,lastTurnStatus:status});});
  }
  exitedRuntime(id,processBinding){
    return this.#write('RUNTIME_EXITED',id,()=>{
      const r=this.runtime(id);if(!r||r.processBinding!==uuid(processBinding))fail('STALE_CONTEXT');
      for(const row of this.#db.prepare('SELECT metadata FROM sessions WHERE current_runtime_id=?').iterate(id)){const s=JSON.parse(row.metadata);if(s.currentRuntimeId===id&&(s.activeTurnId!==null||s.pendingOperationId!==null))this.#saveSession({...s,state:'UNKNOWN'});}
      return this.#saveRuntime({...r,state:'EXITED'});
    });
  }
  unknownRuntime(id){
    return this.#write('RUNTIME_UNKNOWN',id,()=>{const r=this.runtime(id);if(!r)fail('NOT_FOUND');
      for(const row of this.#db.prepare('SELECT metadata FROM sessions WHERE current_runtime_id=?').iterate(id)){const s=JSON.parse(row.metadata);if(s.currentRuntimeId===id)this.#saveSession({...s,state:'UNKNOWN'});}
      return this.#saveRuntime({...r,state:'UNKNOWN'});});
  }
  status(){return this.#read(()=>deepFreeze({schemaVersion:1,runtimes:this.#db.prepare('SELECT COUNT(*) AS n FROM runtimes').get().n,sessions:this.#db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,events:this.#db.prepare('SELECT COUNT(*) AS n FROM lifecycle_events').get().n,archive:'ALL_RETAINED_NO_EVICTION',nativeHistoryCollected:false}));}
  close(){if(this.#closed)return;this.#closed=true;try{this.#db.close();}catch{fail();}}
}
