// TEST_ONLY actual named-password auth and disposable owner-private local stores.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash,generateKeyPairSync} from 'node:crypto';
import {ViewerAccess} from '../../../lib/viewer-access.mjs';
import {hashPassword} from '../../../lib/password-auth.mjs';
import {LocalOwnerBoundary} from '../../broker/local-owner.mjs';
import {AuthorityStore} from '../../broker/store.mjs';
import {ControlIdentities} from '../../broker/identity.mjs';
import {ControlAuthority} from '../../broker/authority.mjs';
import {HostConnections} from '../../broker/host-channel.mjs';
import {enrollmentProof,channelProof} from '../../host/enrollment.mjs';
import {ProjectRoot} from '../../host/project-root.mjs';
import {OwnershipLease} from '../../host/ownership.mjs';
import {HostPolicy} from '../../host/policy.mjs';
import {ControlJournal} from '../../lib/journal.mjs';
export const password='TEST_ONLY-long-private-password-2026';
export const hash=value=>createHash('sha256').update(value).digest('hex');
let passwordHash;
let account;
export async function fixture(t,{clock}={}){
  passwordHash??=await hashPassword(password);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'TEST_ONLY-control-authority-'));
  if(process.platform==='win32'){
    if(!account){const r=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command','[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],{encoding:'utf8',windowsHide:true,timeout:5000});assert.equal(r.status,0);account=r.stdout.trim();}
    const r=spawnSync('icacls.exe',[directory,'/inheritance:r','/grant:r','*'+account+':(OI)(CI)F','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F'],{encoding:'utf8',windowsHide:true,timeout:5000});assert.equal(r.status,0);
  }else{account=String(process.geteuid());fs.chmodSync(directory,0o700);}
  const users=[{id:'owner',label:'Fixture owner',tokenHash:hash('TEST_ONLY-owner'),hostIds:null,role:'admin',username:'owner',passwordHash},{id:'alice',label:'Fixture operator',tokenHash:hash('TEST_ONLY-alice'),hostIds:null,username:'alice',passwordHash}];
  const secret=Buffer.alloc(32,19),sessions=new Map();let access=new ViewerAccess({viewers:users,secret,sessions});
  let time=Date.now();const now=clock??(()=>time);
  const identities=new ControlIdentities({getViewerAccess:()=>access,now});
  const login=async name=>{const cookie=access.issueCookie(access.authenticateBearer('TEST_ONLY-'+name));const session=await identities.reauthenticate({cookie,username:name,password});return {...session,cookie};};
  const ownerSession=await login('owner'),aliceSession=await login('alice');
  const ownerBoundary=LocalOwnerBoundary.open({directory,account}),hubId=randomUUID();
  const store=AuthorityStore.open({directory,owner:ownerBoundary,hubId,now});
  const connections=new HostConnections({store,now}),brokerKey=generateKeyPairSync('ed25519'),hostKey=generateKeyPairSync('ed25519');
  const brokerPublicKey=brokerKey.publicKey.export({format:'der',type:'spki'}).toString('base64');
  const authority=new ControlAuthority({store,identities,connections,privateKey:brokerKey.privateKey,now});
  const ownerId=randomUUID(),actorId=randomUUID(),hostId=randomUUID(),projectId=randomUUID(),profileId=randomUUID(),grantId=randomUUID();
  authority.bootstrap(ownerSession.credential,{requestId:randomUUID(),actorId:ownerId,owner:ownerBoundary});
  authority.putPrincipal(ownerSession.credential,{requestId:randomUUID(),principal:{actorId,viewerId:'alice',revision:1,enabled:true},expectedRevision:0});
  const beginInput={requestId:randomUUID(),hostId,expectedGeneration:0,publicKey:hostKey.publicKey.export({format:'der',type:'spki'}).toString('base64'),endpoint:'https://localhost/api/control/v1/host-channel',serverCertificateSha256:'a'.repeat(64),osAccountId:randomUUID(),inventorySha256:'b'.repeat(64)};
  const pending=authority.beginEnrollment(ownerSession.credential,beginInput).current;
  const activationInput={requestId:randomUUID(),hostId,enrollmentRequestId:pending.requestId,signature:enrollmentProof(pending,hostKey.privateKey)};
  authority.activateEnrollment(ownerSession.credential,activationInput);
  const rootDirectory=path.join(directory,'project');fs.mkdirSync(rootDirectory,{mode:0o700});const root=ProjectRoot.open({directory:rootDirectory});
  authority.putProject(ownerSession.credential,{requestId:randomUUID(),value:{projectId,hostId,identitySha256:root.identity().sha256,providerProfileIds:[profileId],revision:1,enabled:true},expectedRevision:0});
  const connectionEpoch=randomUUID(),lease=OwnershipLease.acquire({directory:path.join(directory,'ownership'),resourceId:projectId,ownerId:randomUUID(),connectionEpoch});
  const challenge=connections.challenge({hostId,generation:1,connectionEpoch});
  const connection=connections.authenticate({challengeId:challenge.challengeId,signature:channelProof(challenge,hostKey.privateKey)});
  let connected=true;
  const policy=new HostPolicy({hostId,hostGeneration:1,projectId,entityRevision:1,brokerPublicKey,root,lease,connection:()=>({connected,hostId,hostGeneration:1,connectionEpoch}),now});
  const grant={version:1,grantId,actorId,hostId,projectId,providerProfileId:profileId,sessionId:null,actions:['turn.start','turn.interrupt','control.inspect','content.view'],grantRevision:1,policyRevision:1,authorityGeneration:1,createdAtMs:time,expiresAtMs:time+600_000,enabled:true};
  authority.putGrant(ownerSession.credential,{requestId:randomUUID(),value:grant,expectedRevision:0});
  const journalDirectory=path.join(directory,'journal');fs.mkdirSync(journalDirectory,{mode:0o700});const journal=ControlJournal.open({directory:journalDirectory,now});
  const operation=(extra={})=>({version:1,operationId:randomUUID(),requestKey:randomUUID(),actorId,action:'turn.start',target:{hostId,projectId,providerProfileId:profileId,runtimeId:randomUUID(),sessionId:randomUUID(),turnId:null,terminalId:null,requestId:null},context:{entityRevision:1,policyRevision:1,grantRevision:1,authorityGeneration:1,ownershipFence:lease.snapshot().fence,connectionEpoch},createdAtMs:time,deadlineAtMs:time+60_000,timeoutMs:60_000,...extra});
  const cleanups=[];
  t.after(async()=>{for(const cleanup of cleanups.reverse())await cleanup();policy.close();connections.close();authority.close();identities.close();journal.close();lease.release();root.close();store.close();assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('TEST_ONLY-control-authority-'));fs.rmSync(directory,{recursive:true,force:true,maxRetries:4,retryDelay:30});});
  return {directory,account,ownerBoundary,store,identities,connections,authority,policy,journal,root,lease,hostKey,brokerKey,brokerPublicKey,connection,connectionEpoch,ownerSession,aliceSession,ownerId,actorId,hostId,projectId,profileId,grantId,grant,beginInput,activationInput,operation,now,addCleanup:callback=>cleanups.push(callback),advance:ms=>{time+=ms;},disconnect:()=>{connected=false;connections.disconnect(connection);},get access(){return access;},changeUsers:values=>{access=new ViewerAccess({viewers:values,secret,sessions});},users,login};
}
