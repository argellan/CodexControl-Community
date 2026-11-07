// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createServer} from './fixture-server.mjs';
import {createSettingsHandler} from '../lib/settings-api.mjs';
import {Administration} from '../lib/administration.mjs';
import {ConfigurationStore} from '../lib/configuration.mjs';
import {FleetHub} from '../lib/fleet.mjs';
import {DEFAULT_CONFIGURATION} from '../public/settings-schema.mjs';
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const keys={owner:'TEST_ONLY_owner_credential_for_http_fixture',second:'TEST_ONLY_second_admin_credential_fixture',viewer:'TEST_ONLY_viewer_credential_for_http_fixture',scoped:'TEST_ONLY_scoped_credential_for_http_fixture'};
const viewer=(id,role='viewer',projectIds=null)=>({id,label:'TEST_ONLY '+id,role,hostIds:null,projectIds,tokenHash:digest(keys[id])});
async function fixture(run){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-settings-api-TEST_ONLY-'));let server;
 try{
  const instanceId=crypto.randomUUID(),host={id:'test-source',label:'TEST_ONLY source',tokenHash:digest('TEST_ONLY_source_credential_fixture')},administration=await Administration.open({directory:path.join(directory,'administration'),initial:{instanceId,viewers:[viewer('owner','admin'),viewer('second','admin'),viewer('viewer'),viewer('scoped','viewer',['TEST_ONLY'])],hosts:[host]}}),configuration=await ConfigurationStore.open({directory:path.join(directory,'configuration'),initial:structuredClone(DEFAULT_CONFIGURATION)}),security=await administration.state(),deploymentState=await configuration.read(),hub=await FleetHub.open({directory:path.join(directory,'history'),hosts:security.hosts});
  server=createServer({hub,configuration,administration,securityState:security,viewers:security.viewers,deploymentState,instanceId,preferencesDirectory:path.join(directory,'profiles'),readSnapshot:async()=>({observedAt:new Date().toISOString(),host:{id:'test-hub',name:'TEST_ONLY hub'},sessions:[],events:[],coverage:{completeHistory:false}})});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  const request=async(route,{identity='owner',method='GET',body}={})=>{const headers={authorization:'Bearer '+keys[identity]};if(body!==undefined)headers['content-type']='application/json';const response=await fetch(origin+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),text=await response.text();let data;try{data=JSON.parse(text);}catch{data={text};}return {status:response.status,data,headers:response.headers};};
  await run({request,configuration,administration,hub,instanceId,origin});
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}const resolved=path.resolve(directory);assert.ok(path.dirname(resolved)===path.resolve(os.tmpdir())&&path.basename(resolved).startsWith('cc-settings-api-TEST_ONLY-'));await fs.rm(resolved,{recursive:true,force:true});}
}

test('viewer personal saves are isolated, reject stale revisions, and cannot change instance configuration',()=>fixture(async({request})=>{
 const initial=await request('/api/settings',{identity:'viewer'});assert.equal(initial.status,200);assert.equal(initial.data.role,'viewer');assert.equal(initial.data.configuration,null);assert.equal(initial.data.capabilities.configurationWrite,false);assert.equal(initial.data.personalRevision,0);
 const save=await request('/api/settings/personal',{identity:'viewer',method:'PUT',body:{revision:0,preferences:{fontSize:17}}});assert.equal(save.status,200);assert.equal(save.data.revision,1);assert.equal((await request('/api/settings/personal',{identity:'viewer',method:'PUT',body:{revision:0,preferences:{fontSize:20}}})).status,409);assert.equal((await request('/api/admin/config',{identity:'viewer'})).status,403);const current=await request('/api/settings',{identity:'viewer'});assert.equal(current.data.personal.fontSize,17);assert.equal((await request('/api/settings')).data.personalRevision,0);
}));

test('personal token palette is API-validated, revisioned and isolated across viewers',()=>fixture(async({request})=>{
 const initial=await request('/api/settings',{identity:'viewer'});assert.equal(initial.data.personal.tokenPalette,'semantic');assert.equal(initial.data.personal.overviewMode,'full');
 const saved=await request('/api/settings/personal',{identity:'viewer',method:'PUT',body:{revision:0,preferences:{tokenPalette:'coins',overviewMode:'mini'}}});assert.equal(saved.status,200);assert.equal(saved.data.preferences.tokenPalette,'coins');assert.equal(saved.data.preferences.overviewMode,'mini');assert.equal((await request('/api/settings',{identity:'viewer'})).data.personal.overviewMode,'mini');assert.equal((await request('/api/settings')).data.personal.overviewMode,'full');
 assert.equal((await request('/api/settings',{identity:'viewer'})).data.personal.tokenPalette,'coins');assert.equal((await request('/api/settings')).data.personal.tokenPalette,'semantic');
 const invalid=await request('/api/settings/personal',{identity:'viewer',method:'PUT',body:{revision:1,preferences:{tokenPalette:'arbitrary-css'}}});assert.equal(invalid.status,400);assert.equal((await request('/api/settings',{identity:'viewer'})).data.personalRevision,1);
}));

test('administrator instance saves use the authoritative revision and reject stale conflicting writes',()=>fixture(async({request})=>{
 const initial=await request('/api/admin/config');assert.equal(initial.status,200);const changed=structuredClone(initial.data.configuration);changed.general.instanceName='TEST_ONLY updated instance';const saved=await request('/api/admin/config',{method:'PUT',body:{revision:initial.data.revision,configuration:changed}});assert.equal(saved.status,200);assert.ok(saved.data.revision>initial.data.revision);assert.equal((await request('/api/admin/config',{method:'PUT',body:{revision:initial.data.revision,configuration:initial.data.configuration}})).status,409);assert.equal((await request('/api/admin/config')).data.configuration.general.instanceName,'TEST_ONLY updated instance');
}));

test('project-scoped viewers are denied users, sources, configuration, audit, backups and full diagnostics',()=>fixture(async({request})=>{
 for(const route of ['/api/admin/users','/api/admin/sources','/api/admin/config','/api/admin/audit','/api/admin/backups','/api/admin/support','/api/diagnostics'])assert.equal((await request(route,{identity:'scoped'})).status,403,route);
 const settings=await request('/api/settings',{identity:'scoped'});assert.equal(settings.status,200);assert.equal(settings.data.configuration,null);assert.equal(settings.data.capabilities.userManagement,false);assert.equal(settings.data.capabilities.backup,false);
}));

test('new viewer credentials download once, only for the issuing administrator, and never appear in inventory or audit',()=>fixture(async({request})=>{
 const users=await request('/api/admin/users'),created=await request('/api/admin/users',{method:'POST',body:{revision:users.data.revision,user:{id:'test-new-viewer',label:'TEST_ONLY new viewer',role:'viewer',hostIds:['test-source'],projectIds:['TEST_ONLY']}}});assert.equal(created.status,200);assert.ok(created.data.issuedCredential.downloadId);assert.equal(Object.hasOwn(created.data.issuedCredential,'token'),false);const route='/api/admin/credentials/'+created.data.issuedCredential.downloadId;assert.equal((await request(route,{identity:'second'})).status,404);const download=await request(route);assert.equal(download.status,200);assert.equal(download.data.kind,'viewer');assert.ok(download.data.accessKey.startsWith('ccv_'));assert.equal((await request(route)).status,404);assert.ok(!JSON.stringify((await request('/api/admin/users')).data).includes(download.data.accessKey));assert.ok(!JSON.stringify((await request('/api/admin/audit')).data).includes(download.data.accessKey));
}));

test('source enrollment downloads a flat usable collector configuration with pinned endpoint and machine identity',()=>fixture(async({request,instanceId})=>{
 const before=await request('/api/admin/sources'),created=await request('/api/admin/sources/enroll',{method:'POST',body:{revision:before.data.revision,host:{id:'test-laptop',label:'TEST_ONLY laptop',expectedHostname:'TEST-ONLY-LAPTOP',deviceClass:'laptop',role:'codex-source'}}});assert.equal(created.status,200);const download=await request('/api/admin/credentials/'+created.data.issuedCredential.downloadId);assert.equal(download.status,200);assert.equal(Object.hasOwn(download.data,'collector'),false);assert.equal(download.data.hostId,'test-laptop');assert.ok(download.data.token.startsWith('ccc_'));assert.equal(download.data.expectedInstanceId,instanceId);assert.equal(download.data.expectedHostname,'TEST-ONLY-LAPTOP');assert.equal(download.data.role,'codex-source');assert.ok(download.data.url.startsWith('http://127.0.0.1:'));assert.ok(!JSON.stringify((await request('/api/admin/sources')).data).includes(download.data.token));
}));

test('invalid underscore machine enrollment fails without persisting a host that would break collector or hub restart',()=>fixture(async({request,administration})=>{
 const before=await administration.state(),created=await request('/api/admin/sources/enroll',{method:'POST',body:{revision:before.revision,host:{id:'test_source',label:'TEST_ONLY invalid machine',expectedHostname:'TEST-ONLY-SOURCE'}}});assert.equal(created.status,400);const after=await administration.state();assert.equal(after.revision,before.revision);assert.deepEqual(after.hosts,before.hosts);
}));

test('gateway forwards a real generated backup identity and rejects malformed restore routes',async()=>{
 const forwarded=[],backupId='backup-1760950000000-abcdef123456',handler=createSettingsHandler({upstream:{url:'https://hub.example.com'},remoteJSON:async(config,route,method,body)=>{forwarded.push({route,method,body});return {id:backupId,staged:true,requiresRestart:true};},readJSON:async()=>({revision:3}),profileFor:()=>null}),res={setHeader(){},end(value){this.data=JSON.parse(value);}},identity={id:'owner',role:'admin',hostIds:null,projectIds:null,_gatewayAuthenticated:true};
 const route='/api/admin/backups/'+backupId+'/restore';assert.equal(await handler({method:'POST',headers:{}},res,new URL(route,'https://gateway.example.com'),identity),true);assert.deepEqual(forwarded,[{route,method:'POST',body:{revision:3}}]);assert.equal(res.data.id,backupId);await assert.rejects(handler({method:'POST',headers:{}},res,new URL('/api/admin/backups/not-a-backup/restore','https://gateway.example.com'),identity),e=>e.status===404);assert.equal(forwarded.length,1);
});

test('administrator health and build metadata are on-demand, bounded, and denied to scoped identities',()=>fixture(async({request})=>{
 const settings=await request('/api/settings');assert.equal(settings.data.version,settings.data.applicationVersion);assert.equal(settings.data.settingsProtocolVersion,1);assert.match(settings.data.applicationVersion,/^\d+\.\d+\.\d+$/);
 const health=await request('/api/admin/diagnostics');assert.equal(health.status,200);assert.equal(health.data.collection.scope,'enrolled sources only');assert.equal(health.data.collection.accountWideCoverage,false);assert.equal(health.data.preservation.retentionMode,'verified-archive-only');assert.equal(health.data.preservation.archive.retentionRequiresArchive,true);assert.ok(!Object.hasOwn(health.data,'events'));assert.ok(!JSON.stringify(health.data).includes('tokenHash'));
 assert.equal((await request('/api/admin/diagnostics',{identity:'viewer'})).status,403);assert.equal((await request('/api/admin/diagnostics',{identity:'scoped'})).status,403);
}));

test('device enrollment request retries reuse package handle and consumed delivery is not recreated',()=>fixture(async({request})=>{
 const requestId=crypto.randomUUID(),before=await request('/api/admin/sources'),body={revision:before.data.revision,requestId,host:{id:'test-retry',label:'TEST_ONLY retry',expectedHostname:'TEST-ONLY',role:'codex-source'}};
 const first=await request('/api/admin/sources/enroll',{method:'POST',body}),again=await request('/api/admin/sources/enroll',{method:'POST',body});
 assert.equal(first.status,200);assert.equal(again.status,200);assert.equal(again.data.revision,first.data.revision);assert.equal(again.data.issuedCredential.downloadId,first.data.issuedCredential.downloadId);
 const receipt=await request('/api/admin/sources/enrollments/'+requestId);assert.equal(receipt.status,200);assert.equal((await request('/api/admin/sources/enrollments/'+requestId,{identity:'second'})).status,404);assert.equal((await request('/api/admin/sources/enrollments/'+requestId,{identity:'viewer'})).status,403);
 await request('/api/admin/credentials/'+first.data.issuedCredential.downloadId);
 const consumed=await request('/api/admin/sources/enroll',{method:'POST',body});assert.equal(consumed.status,200);assert.equal(consumed.data.issuedCredential,undefined);
}));
test('collector replacement uses separate endpoint and stale generation cannot change access',()=>fixture(async({request})=>{
 const before=await request('/api/admin/sources'),host={id:'test-source',label:'TEST_ONLY source',expectedHostname:'TEST-ONLY',role:'codex-source'};
 const duplicate=await request('/api/admin/sources/enroll',{method:'POST',body:{revision:before.data.revision,host}});assert.equal(duplicate.status,409);
 const stale=await request('/api/admin/sources/test-source/replace',{method:'POST',body:{revision:before.data.revision,requestId:crypto.randomUUID(),expectedGeneration:99,host}});assert.equal(stale.status,409);
 const replaced=await request('/api/admin/sources/test-source/replace',{method:'POST',body:{revision:before.data.revision,requestId:crypto.randomUUID(),expectedGeneration:1,host}});assert.equal(replaced.status,200);assert.equal(replaced.data.source.credentialGeneration,2);
 assert.equal((await request('/api/admin/sources')).data.sources.find(s=>s.id==='test-source').setup.reporting,'waiting');
}));


test('device package cannot be delivered after revoke or replacement',()=>fixture(async({request})=>{
 const before=await request('/api/admin/sources'),host={id:'test-delivery',label:'TEST_ONLY',expectedHostname:'TEST-ONLY',role:'codex-source'};
 const created=await request('/api/admin/sources/enroll',{method:'POST',body:{revision:before.data.revision,requestId:crypto.randomUUID(),host}});
 const rotated=await request('/api/admin/sources/test-delivery/replace',{method:'POST',body:{revision:created.data.revision,requestId:crypto.randomUUID(),expectedGeneration:1,host}});
 assert.equal((await request('/api/admin/credentials/'+created.data.issuedCredential.downloadId)).status,404);
 await request('/api/admin/sources/test-delivery/revoke',{method:'POST',body:{revision:rotated.data.revision}});
 assert.equal((await request('/api/admin/credentials/'+rotated.data.issuedCredential.downloadId)).status,404);
}));
test('device package expiry does not expire authorized source and does not create another credential',()=>fixture(async({request})=>{
 const requestId=crypto.randomUUID(),before=await request('/api/admin/sources'),body={revision:before.data.revision,requestId,host:{id:'test-expiry',label:'TEST_ONLY',expectedHostname:'TEST-ONLY',role:'codex-source'}};
 const created=await request('/api/admin/sources/enroll',{method:'POST',body}),clock=Date.now;
 try{Date.now=()=>clock()+300001;assert.equal((await request('/api/admin/credentials/'+created.data.issuedCredential.downloadId)).status,404);
 const receipt=await request('/api/admin/sources/enrollments/'+requestId);assert.equal(receipt.data.source.status,'active');assert.equal(receipt.data.issuedCredential,undefined);assert.equal(receipt.data.revision,created.data.revision);}
 finally{Date.now=clock;}
}));


test('concurrent one-use package retrieval cannot deliver a credential twice',()=>fixture(async({request,administration})=>{
 const before=await request('/api/admin/sources'),created=await request('/api/admin/sources/enroll',{method:'POST',body:{revision:before.data.revision,requestId:crypto.randomUUID(),host:{id:'test-single-delivery',label:'TEST_ONLY',expectedHostname:'TEST-ONLY'}}});
 const route='/api/admin/credentials/'+created.data.issuedCredential.downloadId,read=administration.state.bind(administration);
 administration.state=async()=>{await new Promise(resolve=>setTimeout(resolve,25));return read();};
 const results=await Promise.all([request(route),request(route)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,404]);
}));

test('pending enrollment locators recover only in the issuing session and consume once after authority refresh',()=>fixture(async({request,origin})=>{
 const signIn=async()=>{const r=await fetch(origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:keys.owner})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
 const first=await signIn(),other=await signIn();
 const call=async(route,{cookie=first,method='GET',body}={})=>{const r=await fetch(origin+route,{method,headers:{cookie,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
 const before=await call('/api/admin/sources');const created=await call('/api/admin/sources/enroll',{method:'POST',body:{revision:before.data.revision,host:{id:'test-recover',label:'TEST_ONLY recovery',expectedHostname:'TEST-ONLY',role:'codex-source'}}});assert.equal(created.status,200);
 const locator=created.data.issuedCredential.downloadId;
 const pending=await call('/api/admin/credentials');assert.equal(pending.status,200);assert.deepEqual(pending.data.issuedCredentials.map(i=>i.downloadId),[locator]);assert.equal(JSON.stringify(pending.data).includes('token'),false);
 assert.deepEqual((await call('/api/admin/credentials',{cookie:other})).data.issuedCredentials,[]);
 assert.equal((await call('/api/admin/credentials/'+locator,{cookie:other})).status,404);
 const pair=await Promise.all([call('/api/admin/credentials/'+locator),call('/api/admin/credentials/'+locator)]);assert.deepEqual(pair.map(r=>r.status).sort(),[200,404]);assert.deepEqual((await call('/api/admin/credentials')).data.issuedCredentials,[]);
 assert.equal((await call('/api/admin/sources')).data.sources.filter(s=>s.id==='test-recover').length,1);
 assert.equal((await request('/api/admin/credentials',{identity:'viewer'})).status,403);assert.deepEqual((await request('/api/admin/credentials',{identity:'second'})).data.issuedCredentials,[]);
}));

test('source revocation invalidates pending enrollment recovery without reissuing identity',()=>fixture(async({request})=>{
 const sources=await request('/api/admin/sources');const create=await request('/api/admin/sources/enroll',{method:'POST',body:{revision:sources.data.revision,host:{id:'test-expire',label:'TEST_ONLY expiry',expectedHostname:'TEST-ONLY'}}});assert.equal(create.status,200);const id=create.data.issuedCredential.downloadId;
 const revoked=await request('/api/admin/sources/test-expire/revoke',{method:'POST',body:{revision:create.data.revision}});assert.equal(revoked.status,200);assert.deepEqual((await request('/api/admin/credentials')).data.issuedCredentials,[]);assert.equal((await request('/api/admin/credentials/'+id)).status,404);
}));
test('pending packages expire at five minutes and cannot be recovered by a demoted issuer',async t=>fixture(async({request})=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const create=async id=>{const s=await request('/api/admin/sources');return request('/api/admin/sources/enroll',{method:'POST',body:{revision:s.data.revision,host:{id,label:'TEST_ONLY expiry',expectedHostname:'TEST-ONLY'}}});};
 const expired=await create('test-expiration');assert.equal(expired.status,200);t.mock.timers.tick(300001);assert.deepEqual((await request('/api/admin/credentials')).data.issuedCredentials,[]);assert.equal((await request('/api/admin/credentials/'+expired.data.issuedCredential.downloadId)).status,404);
 const pending=await create('test-demotion');assert.equal(pending.status,200);const users=await request('/api/admin/users');const demoted=await request('/api/admin/users',{identity:'second',method:'POST',body:{revision:users.data.revision,user:{id:'owner',label:'TEST_ONLY demoted',role:'viewer',hostIds:null,projectIds:null}}});assert.equal(demoted.status,200);assert.equal((await request('/api/admin/credentials')).status,403);assert.equal((await request('/api/admin/credentials/'+pending.data.issuedCredential.downloadId)).status,403);
}));

test('sign-out and a new browser session cannot revive an unconsumed old-session package',()=>fixture(async({origin,request})=>{
 const login=async()=>{const r=await fetch(origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:keys.owner})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
 const cookie=await login(),s=await request('/api/admin/sources');const made=await fetch(origin+'/api/admin/sources/enroll',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({revision:s.data.revision,host:{id:'test-logout',label:'TEST_ONLY logout',expectedHostname:'TEST-ONLY'}})});assert.equal(made.status,200);const ticket=(await made.json()).issuedCredential.downloadId;
 assert.equal((await fetch(origin+'/api/session/logout',{method:'POST',headers:{cookie}})).status,200);assert.equal((await fetch(origin+'/api/admin/credentials',{headers:{cookie}})).status,401);const next=await login();const list=await fetch(origin+'/api/admin/credentials',{headers:{cookie:next}});assert.deepEqual((await list.json()).issuedCredentials,[]);assert.equal((await fetch(origin+'/api/admin/credentials/'+ticket,{headers:{cookie:next}})).status,404);
}));

test('an uncertain repeated enrollment never generates a second identity or new credential',()=>fixture(async({request})=>{
 const s=await request('/api/admin/sources'),body={revision:s.data.revision,host:{id:'test-repeat',label:'TEST_ONLY repeat',expectedHostname:'TEST-ONLY'}};const responses=await Promise.all([request('/api/admin/sources/enroll',{method:'POST',body}),request('/api/admin/sources/enroll',{method:'POST',body})]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal((await request('/api/admin/sources')).data.sources.filter(s=>s.id==='test-repeat').length,1);assert.equal((await request('/api/admin/credentials')).data.issuedCredentials.length,1);
}));
