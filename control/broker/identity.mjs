import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {ControlError,isControlError} from '../lib/errors.mjs';
import {strictRecord,integer,deepFreeze} from '../lib/privacy.mjs';
const fail=()=>{throw new ControlError('CONTROL_DISABLED');};
const digest=value=>createHash('sha256').update(value).digest('hex');
/** Separate bounded, RAM-only credential, bound to the original live observer cookie. */
export class ControlIdentities {
  #access;#now;#ttl;#recent;#limit;#sessions=new Map();
  constructor(options) {
    strictRecord(options,['getViewerAccess','now','ttlMs','recentMs','maxSessions'],['getViewerAccess']);
    const {getViewerAccess,now=Date.now,ttlMs=900_000,recentMs=300_000,maxSessions=128}=options;
    if(typeof getViewerAccess!=='function'||typeof now!=='function')throw new ControlError('INVALID_INPUT');
    this.#access=getViewerAccess;this.#now=now;this.#ttl=integer(ttlMs,1000,900_000);this.#recent=integer(recentMs,1000,300_000);this.#limit=integer(maxSessions,1,1024);
  }
  #time(){return integer(this.#now());}
  async reauthenticate(input) {try{return await this.#reauthenticate(input);}catch(error){if(isControlError(error))throw error;fail();}}
  async #reauthenticate(input) {
    strictRecord(input,['cookie','username','password']);
    if(typeof input.cookie!=='string'||input.cookie.length>512||typeof input.username!=='string'||input.username.length>64||typeof input.password!=='string'||Buffer.byteLength(input.password)>512)fail();
    const access=this.#access(),before=access.authenticateCookie(input.cookie);
    if(!before?.username||before.passwordEnabled!==true||before.id==='legacy'||before.id==='local')fail();
    const verified=await access.authenticatePassword(input.username,input.password);
    if(access!==this.#access()||!verified||access.authenticateCookie(input.cookie)!==before||verified!==before)fail();
    const now=this.#time();
    for(const [key,value]of this.#sessions)if(value.expiresAtMs<=now||!this.#viewer(value))this.#sessions.delete(key);
    if(this.#sessions.size>=this.#limit)throw new ControlError('CAPACITY');
    const credential=randomBytes(32).toString('base64url'),sessionId=randomUUID();
    this.#sessions.set(digest(credential),{sessionId,cookie:input.cookie,viewer:before,authenticatedAtMs:now,expiresAtMs:now+this.#ttl});
    return Object.freeze({credential,sessionId,expiresAtMs:now+this.#ttl});
  }
  #viewer(session){const current=this.#access().authenticateCookie(session.cookie);return current===session.viewer?current:null;}
  authenticate(credential,options={}) {try{return this.#authenticate(credential,options);}catch(error){if(isControlError(error))throw error;fail();}}
  #authenticate(credential,{recent=false}={}) {
    if(typeof credential!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(credential))fail();
    const key=digest(credential),session=this.#sessions.get(key),now=this.#time();
    if(!session||session.expiresAtMs<=now||now<session.authenticatedAtMs||(recent&&now-session.authenticatedAtMs>this.#recent))fail();
    const viewer=this.#viewer(session);if(!viewer){this.#sessions.delete(key);fail();}
    return deepFreeze({viewerId:viewer.id,sessionId:session.sessionId,authenticatedAtMs:session.authenticatedAtMs,expiresAtMs:session.expiresAtMs,hostIds:viewer.hostIds===null?null:[...viewer.hostIds],projectIds:viewer.projectIds===null?null:[...viewer.projectIds]});
  }
  logout(credential) {if(typeof credential!=='string'||credential.length>128)return false;return this.#sessions.delete(digest(credential));}
  close(){this.#sessions.clear();}
  get size(){return this.#sessions.size;}
}
