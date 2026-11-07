// Author: Bishop Crockett
// Owner: Argellan.com
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createGitHubConnections,validateGitHubAppConfiguration,GITHUB_CONNECTION_CALLBACK_PATH,GITHUB_CONNECTION_PERMISSIONS,GITHUB_CONNECTION_LIMITS} from '../lib/github-connections.mjs';
import {privateDirectory} from '../lib/installation-storage.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const generated = prefix => prefix + crypto.randomBytes(24).toString('hex');
const json = (value,status = 200,headers = {}) => new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});
const repo = (id,name = 'argellan/test-' + id) => ({id,full_name:name,private:true,archived:false,permissions:{pull:true,push:false,admin:false},description:'EXCLUDED_DESCRIPTION',temp_clone_token:'EXCLUDED_CLONE_TOKEN'});
const installation = (id = 10) => ({id,app_id:1234,account:{id:900,login:'argellan'},repository_selection:'selected',permissions:{...GITHUB_CONNECTION_PERMISSIONS},suspended_at:null});
const gate = () => { let entered, release; return {ready:new Promise(resolve => { entered = resolve; }),wait:new Promise(resolve => { release = resolve; }),entered:() => entered(),release:() => release()}; };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'cc-github-auth-'));
  await privateDirectory(root);
  const clientSecret = generated('TEST_ONLY_'), secretFile = path.join(root,'client-secret'), directory = path.join(root,'state');
  await fs.writeFile(secretFile,clientSecret,{mode:0o600});
  let time = Date.parse('2026-10-29T03:00:00Z'), service;
  const config = {enabled:true,appId:1234,clientId:'Iv1.TEST_ONLY',appSlug:'argellan-test-only',clientSecretFile:secretFile};
  const viewerA = {id:'alice',profileKey:generated('profile-'),role:'viewer',hostIds:null,projectIds:null}, viewerB = {id:'bob',profileKey:generated('profile-'),role:'viewer',hostIds:null,projectIds:null};
  let currentA = viewerA, currentB = viewerB;
  const optionsA = {viewer:viewerA,clientKey:hash('TEST_ONLY_SESSION_A'),verifyAuthority:() => currentA,project:'Project A'}, optionsB = {viewer:viewerB,clientKey:hash('TEST_ONLY_SESSION_B'),verifyAuthority:() => currentB,project:'Project A'};
  const accounts = {
    a:{user:{id:101,login:'alice'},installations:[installation()],repositories:new Map([[10,[repo(1)]]])},
    b:{user:{id:102,login:'bob'},installations:[installation()],repositories:new Map([[10,[repo(2)]]])},
  };
  const tokens = new Map(), refreshTokens = new Map(), challenges = new Map(), calls = [], issued = [];
  let intercept = null, tokenTransform = value => value;
  const transport = async (url,options) => {
    assert.ok(url.startsWith('https://api.github.com/') || url === 'https://github.com/login/oauth/access_token');
    assert.equal(options.redirect,'error'); assert.ok(options.signal instanceof AbortSignal);
    calls.push({url,options});
    const overridden = intercept && await intercept(url,options); if (overridden) return overridden;
    if (url === 'https://github.com/login/oauth/access_token') {
      assert.equal(options.method,'POST'); assert.equal(options.headers['content-type'],'application/x-www-form-urlencoded');
      const body = new URLSearchParams(options.body); assert.equal(body.get('client_id'),config.clientId); assert.equal(body.get('client_secret'),clientSecret);
      let account;
      if (body.get('grant_type') === 'refresh_token') {
        account = refreshTokens.get(body.get('refresh_token')); assert.ok(account,'refresh token is current'); refreshTokens.delete(body.get('refresh_token'));
      } else {
        account = accounts[body.get('code')]; assert.ok(account);
        assert.equal(body.get('redirect_uri'),'https://control.test' + GITHUB_CONNECTION_CALLBACK_PATH);
        const verifier = body.get('code_verifier'); assert.match(verifier,/^[A-Za-z0-9_-]{43}$/);
        assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'),challenges.get(body.get('code')));
      }
      const value = {access_token:generated('ghu_'),refresh_token:generated('ghr_'),token_type:'bearer',expires_in:28800,refresh_token_expires_in:15897600,scope:''};
      tokens.set(value.access_token,account); refreshTokens.set(value.refresh_token,account); issued.push(value);
      return json(tokenTransform(value));
    }
    const target = new URL(url);
    if (target.pathname === '/applications/' + config.clientId + '/token') {
      assert.equal(options.method,'DELETE'); assert.equal(options.headers.authorization,'Basic ' + Buffer.from(config.clientId + ':' + clientSecret).toString('base64'));
      const token = JSON.parse(options.body).access_token; tokens.delete(token); return new Response(null,{status:204});
    }
    assert.equal(options.method,'GET'); assert.equal(options.headers['X-GitHub-Api-Version'],'2026-03-10');
    const account = tokens.get(options.headers.authorization?.slice(7)); if (!account) return json({message:'EXCLUDED_AUTH_BODY'},401);
    if (target.pathname === '/user') return json({...account.user,email:'EXCLUDED_EMAIL',avatar_url:'https://untrusted.test/avatar'});
    if (target.pathname === '/user/installations') return json({total_count:account.installations.length,installations:account.installations});
    const match = target.pathname.match(/^\/user\/installations\/(\d+)\/repositories$/);
    if (match) {
      const repositories = account.repositories.get(Number(match[1])); if (!repositories) return json({message:'EXCLUDED_BODY'},404);
      return json({total_count:repositories.length,repositories});
    }
    assert.fail('Unexpected provider endpoint');
  };
  service = await createGitHubConnections({configuration:config,directory,publicOrigin:'https://control.test',transport,now:() => time});
  t.after(async () => {
    await service?.close();
    const resolved = path.resolve(root); assert.equal(path.dirname(resolved),path.resolve(os.tmpdir())); assert.ok(path.basename(resolved).startsWith('cc-github-auth-'));
    await fs.rm(resolved,{recursive:true,force:true});
  });
  const start = async (options = optionsA,code = 'a') => {
    const result = await service.startAuthorization(options), url = new URL(result.authorizationUrl);
    challenges.set(code,url.searchParams.get('code_challenge'));
    return {result,url,query:new URLSearchParams({state:url.searchParams.get('state'),code})};
  };
  const link = async (options = optionsA,code = 'a') => { const flow = await start(options,code); await service.callback({query:flow.query}); const result = await service.completeAuthorization(options); return {...flow,result}; };
  return {root,directory,config,clientSecret,optionsA,optionsB,accounts,tokens,issued,calls,start,link,get service() { return service; },setIntercept:value => { intercept = value; },setTokenTransform:value => { tokenTransform = value; },advance:amount => { time += amount; },revokeViewer:() => { currentA = null; },changeViewer:value => { currentA = value; },changeViewerB:value => { currentB = value; },async reopen() { await service.close(); service = await createGitHubConnections({configuration:config,directory,publicOrigin:'https://control.test',transport,now:() => time}); }};
}

test('unconfigured and disabled App states are actionable and never contact a provider',async () => {
  let calls = 0;
  for (const configuration of [undefined,{enabled:false}]) {
    const service = await createGitHubConnections({configuration,transport:() => { calls++; }});
    const status = await service.status(); assert.equal(status.state,'unconfigured'); assert.equal(status.configured,false); assert.equal(status.setup.ownerConfigurationRequired,true); assert.deepEqual(status.repositories,[]);
    assert.equal((await service.startAuthorization()).state,'unconfigured'); await assert.rejects(service.authorizeRepository(),{reason:'app_registration_required'}); await service.close();
  }
  assert.equal(calls,0);
});

test('configuration fixes GitHub.com authority and owner callback; rejects inline secrets, paths and redirect overrides',() => {
  const config = {enabled:true,appId:1,clientId:'Iv1.TEST_ONLY',appSlug:'argellan-app',clientSecretFile:path.resolve('TEST_ONLY_secret')};
  assert.equal(validateGitHubAppConfiguration(config,'https://control.test').callbackUrl,'https://control.test' + GITHUB_CONNECTION_CALLBACK_PATH);
  assert.equal(validateGitHubAppConfiguration(config,'http://127.0.0.1:3456').publicOrigin,'http://127.0.0.1:3456');
  for (const bad of [{...config,clientSecret:'TEST_ONLY'},{...config,callbackUrl:'https://evil.test'},{...config,apiOrigin:'https://evil.test'},{...config,clientSecretFile:'relative'},{...config,clientSecretFile:'//server/secret'},{...config,appSlug:'../../apps'},{...config,appId:'1'}]) assert.throws(() => validateGitHubAppConfiguration(bad,'https://control.test'));
  for (const origin of ['http://control.test','https://control.test/','https://control.test/?next=evil','https://user:pass@control.test','https://control.test/#callback']) assert.throws(() => validateGitHubAppConfiguration(config,origin));
});

test('authorization requires an individual, current session and permitted project',async t => {
  const f = await fixture(t);
  for (const options of [{...f.optionsA,viewer:{...f.optionsA.viewer,id:'local'}},{...f.optionsA,viewer:{...f.optionsA.viewer,profileKey:undefined}},{...f.optionsA,clientKey:'guess'},{...f.optionsA,verifyAuthority:undefined},{...f.optionsA,project:undefined}]) await assert.rejects(f.service.startAuthorization(options));
  const viewer = {...f.optionsA.viewer,projectIds:['Only permitted']}; f.changeViewer(viewer);
  await assert.rejects(f.service.startAuthorization({...f.optionsA,viewer,project:'Other'}),{reason:'project_not_permitted',status:403});
  assert.equal(f.calls.length,0);
});

test('state and PKCE are random, single-use and exchange secrets only in a server POST body',async t => {
  const f = await fixture(t), flow = await f.start();
  assert.equal(flow.url.origin,'https://github.com'); assert.equal(flow.url.pathname,'/login/oauth/authorize'); assert.equal(flow.url.searchParams.get('code_challenge_method'),'S256'); assert.equal(flow.url.searchParams.get('scope'),'offline_access'); assert.match(flow.url.searchParams.get('state'),/^[A-Za-z0-9_-]{43}$/); assert.equal(flow.url.searchParams.has('client_secret'),false);
  const response = await f.service.callback({query:flow.query}); assert.deepEqual(response,{schemaVersion:1,configured:true,readOnly:true,state:'authorization_received',reason:null,completionRequired:true,completionPath:'/?github=complete'});
  await assert.rejects(f.service.callback({query:flow.query}),{reason:'authorization_state_expired_or_used'});
  assert.equal(f.calls.filter(call => call.url.includes('/access_token')).length,1);
  assert.equal((await f.service.completeAuthorization(f.optionsA)).state,'authorized');
  await assert.rejects(f.service.completeAuthorization(f.optionsA),{reason:'authorization_completion_required'});
});

test('CSRF, duplicate parameters, installation hints and custom redirects cannot replace state',async t => {
  const f = await fixture(t), flow = await f.start();
  for (const query of [new URLSearchParams({code:'a',state:'attacker'}),new URLSearchParams(flow.query + '&state=' + flow.query.get('state')),new URLSearchParams(flow.query + '&installation_id=10'),new URLSearchParams(flow.query + '&redirect_uri=https://evil.test'),new URLSearchParams({code:'a'})]) await assert.rejects(f.service.callback({query}));
  assert.equal(f.calls.length,0); await f.service.callback({query:flow.query}); assert.equal((await f.service.completeAuthorization(f.optionsA)).state,'authorized');
});

test('callback does not require a Strict cookie and cannot complete for another session, viewer or project',async t => {
  const f = await fixture(t), flow = await f.start(); await f.service.callback({query:flow.query});
  await assert.rejects(f.service.completeAuthorization({...f.optionsA,clientKey:hash('OTHER_SESSION')}),{reason:'authorization_completion_required'});
  await assert.rejects(f.service.completeAuthorization(f.optionsB),{reason:'authorization_completion_required'});
  await assert.rejects(f.service.completeAuthorization({...f.optionsA,project:'Project B'}),{reason:'authorization_completion_required'});
  assert.equal((await f.service.completeAuthorization(f.optionsA)).state,'authorized');
});

test('authorization state expires, provider denial consumes it and a newer start supersedes it',async t => {
  const f = await fixture(t), expired = await f.start(); f.advance(GITHUB_CONNECTION_LIMITS.stateLifetimeMs + 1);
  await assert.rejects(f.service.callback({query:expired.query}),{reason:'authorization_state_expired_or_used'});
  const denied = await f.start(); assert.equal((await f.service.callback({query:new URLSearchParams({state:denied.query.get('state'),error:'access_denied'})})).reason,'authorization_denied');
  await assert.rejects(f.service.callback({query:denied.query}));
  const first = await f.start(), latest = await f.start(); assert.notEqual(first.query.get('state'),latest.query.get('state'));
  await assert.rejects(f.service.callback({query:first.query}),{reason:'authorization_state_expired_or_used'}); await f.service.callback({query:latest.query});
  assert.equal(f.calls.filter(call => call.url.includes('/access_token')).length,1);
});

test('pending completion expires and never stores a token durably before authenticated completion',async t => {
  const f = await fixture(t), flow = await f.start(); await f.service.callback({query:flow.query});
  const database = await fs.readFile(path.join(f.directory,'connections.sqlite')); assert.equal(database.includes(Buffer.from(f.issued[0].access_token)),false);
  f.advance(GITHUB_CONNECTION_LIMITS.completionLifetimeMs + 1); await assert.rejects(f.service.completeAuthorization(f.optionsA),{reason:'authorization_completion_required'});
  assert.equal((await f.service.status(f.optionsA)).state,'disconnected');
});

test('all public envelopes exclude tokens, client secrets, PKCE verifiers and unprojected provider bodies',async t => {
  const f = await fixture(t), flow = await f.link(), selected = await f.service.selectRepositories({...f.optionsA,repositories:[{installationId:10,repositoryId:1}]}), access = await f.service.authorizeRepository({...f.optionsA,installationId:10,repositoryId:1}), status = await f.service.status(f.optionsA);
  const text = JSON.stringify([flow.result,selected,access,status]);
  for (const forbidden of [f.clientSecret,...f.issued.flatMap(value => [value.access_token,value.refresh_token]),'EXCLUDED_','clientSecretFile','profileKey','verifier']) assert.equal(text.includes(forbidden),false);
  assert.equal(selected.state,'connected'); assert.equal(access.state,'permitted'); assert.equal(access.repository.repositoryId,1);
  const database = await fs.readFile(path.join(f.directory,'connections.sqlite')); assert.equal(database.includes(Buffer.from(f.clientSecret)),false); assert.equal(database.includes(Buffer.from(flow.query.get('state'))),false); assert.equal(database.includes(Buffer.from(f.issued[0].access_token)),true);
});

test('shared installation never shares users, repository access or local selections',async t => {
  const f = await fixture(t); await f.link(); await f.link(f.optionsB,'b');
  const a = await f.service.selectRepositories({...f.optionsA,repositories:[{installationId:10,repositoryId:1}]}); assert.deepEqual(a.repositories.map(repo => repo.repositoryId),[1]);
  const b = await f.service.listRepositories(f.optionsB); assert.deepEqual(b.repositories.map(repo => repo.repositoryId),[2]); assert.deepEqual(b.selection,[]);
  await assert.rejects(f.service.selectRepositories({...f.optionsB,repositories:[{installationId:10,repositoryId:1}]}),{reason:'repository_not_permitted',status:403});
  await assert.rejects(f.service.authorizeRepository({...f.optionsB,installationId:10,repositoryId:1}),{reason:'repository_not_permitted',status:403});
  await f.service.selectRepositories({...f.optionsB,repositories:[{installationId:10,repositoryId:2}]}); await f.service.disconnect(f.optionsA);
  assert.equal((await f.service.status(f.optionsB)).state,'connected'); assert.equal((await f.service.status(f.optionsA)).state,'disconnected');
});

test('selections belong to a viewer AND a project and project text never grants repository access',async t => {
  const f = await fixture(t); await f.link(); await f.service.selectRepositories({...f.optionsA,repositories:[{installationId:10,repositoryId:1}]});
  const projectB = {...f.optionsA,project:'Project B'}; assert.deepEqual((await f.service.status(projectB)).selection,[]);
  await assert.rejects(f.service.authorizeRepository({...projectB,installationId:10,repositoryId:1}),{reason:'repository_not_permitted'});
  await f.service.selectRepositories({...projectB,repositories:[{installationId:10,repositoryId:1}]});
  await f.service.selectRepositories({...f.optionsA,repositories:[]}); assert.equal((await f.service.status(projectB)).state,'connected'); assert.equal((await f.service.status(f.optionsA)).state,'authorized');
});

test('user-only authorization stays authorized and requires App installation/repository grant',async t => {
  const f = await fixture(t); f.accounts.a.installations = []; const linked = await f.link();
  assert.equal(linked.result.state,'authorized'); assert.equal(linked.result.reason,'install_app_or_grant_repository_access'); assert.deepEqual(linked.result.repositories,[]); assert.match(linked.result.installUrl,/^https:\/\/github.com\/apps\/argellan-test-only\/installations\/new$/);
  await assert.rejects(f.service.authorizeRepository({...f.optionsA,installationId:10,repositoryId:1}),{reason:'repository_not_permitted'});
});

test('foreign App, suspended installation, missing read permissions and write grants cannot admit repositories',async t => {
  const f = await fixture(t); await f.link();
  for (const bad of [{...installation(),app_id:9999},{...installation(),suspended_at:'2026-10-29T00:00:00Z'},{...installation(),permissions:{metadata:'read'}},{...installation(),permissions:{...GITHUB_CONNECTION_PERMISSIONS,contents:'write'}},{...installation(),permissions:{...GITHUB_CONNECTION_PERMISSIONS,administration:'read'}}]) {
    f.accounts.a.installations = [bad]; const result = await f.service.listRepositories(f.optionsA); assert.deepEqual(result.repositories,[]); assert.deepEqual(result.selection,[]);
    await assert.rejects(f.service.authorizeRepository({...f.optionsA,installationId:10,repositoryId:1}),{reason:'repository_not_permitted'});
  }
});

test('fresh protected reads exclude repository and installation access removed after selection',async t => {
  const f = await fixture(t); await f.link(); await f.service.selectRepositories({...f.optionsA,repositories:[{installationId:10,repositoryId:1}]});
  f.accounts.a.repositories.set(10,[]); assert.deepEqual((await f.service.status(f.optionsA)).selection,[]);
  await assert.rejects(f.service.authorizeRepository({...f.optionsA,installationId:10,repositoryId:1}),{reason:'repository_not_permitted'});
  f.accounts.a.repositories.set(10,[{...repo(1),permissions:{pull:false}}]); assert.deepEqual((await f.service.status(f.optionsA)).repositories,[]);
  f.accounts.a.repositories.delete(10); assert.deepEqual((await f.service.status(f.optionsA)).selection,[]);
});

test('repository selections reject unselected IDs, duplicates, extra fields, strings and capacity overflow',async t => {
  const f = await fixture(t); await f.link();
  for (const repositories of [[{installationId:10,repositoryId:999}],[{installationId:10,repositoryId:1},{installationId:10,repositoryId:1}],[{installationId:10,repositoryId:'1'}],[{installationId:10,repositoryId:1,project:'Other'}],Array.from({length:33},(_,i) => ({installationId:10,repositoryId:i + 1}))]) await assert.rejects(f.service.selectRepositories({...f.optionsA,repositories}));
  assert.deepEqual((await f.service.status(f.optionsA)).selection,[]);
});

test('revoked token clears local credential state and never falls back to an installation or static credential',async t => {
  const f = await fixture(t); await f.link(); f.tokens.clear(); const before = f.calls.length;
  const status = await f.service.status(f.optionsA); assert.equal(status.state,'reauthorization_required'); assert.equal(status.reason,'github_authorization_revoked'); assert.deepEqual(status.repositories,[]);
  assert.equal(f.calls.length,before + 1); assert.equal((await f.service.status(f.optionsA)).state,'disconnected'); assert.equal(f.calls.length,before + 1);
  await assert.rejects(f.service.authorizeRepository({...f.optionsA,installationId:10,repositoryId:1}),{reason:'github_authorization_required'});
});

test('expiring tokens refresh once, rotate durably and remain bound to the same GitHub user',async t => {
  const f = await fixture(t); await f.link(); f.advance(28800000 - 59000);
  assert.equal((await f.service.status(f.optionsA)).state,'authorized'); assert.equal(f.issued.length,2);
  const refreshCalls = f.calls.filter(call => call.url.endsWith('/access_token') && new URLSearchParams(call.options.body).get('grant_type') === 'refresh_token'); assert.equal(refreshCalls.length,1);
  await f.service.status(f.optionsA); assert.equal(f.issued.length,2); await f.reopen(); await f.service.status(f.optionsA); assert.equal(f.issued.length,2);
});

test('ambiguous rotating refresh records an intent and is never blindly retried',async t => {
  const f = await fixture(t); await f.link(); f.advance(28800000 - 59000); let refreshCalls = 0;
  f.setIntercept((url,options) => { if (url.endsWith('/access_token') && new URLSearchParams(options.body).get('grant_type') === 'refresh_token') { refreshCalls++; throw Error('EXCLUDED_TRANSPORT_ERROR'); } });
  await assert.rejects(f.service.status(f.optionsA),{reason:'provider_unavailable'}); await assert.rejects(f.service.status(f.optionsA),{reason:'refresh_interrupted_reauthorize'}); assert.equal(refreshCalls,1);
  await f.reopen(); await assert.rejects(f.service.status(f.optionsA),{reason:'refresh_interrupted_reauthorize'}); assert.equal(refreshCalls,1);
});

test('expired refresh token and nonexpiring/PAT token responses require fresh authorization',async t => {
  const f = await fixture(t); await f.link(); f.advance(15897600000 + 1); await assert.rejects(f.service.status(f.optionsA),{reason:'reauthorization_required'});
  for (const transform of [value => ({...value,access_token:generated('github_pat_')}),value => ({...value,expires_in:undefined,refresh_token:undefined}),value => ({...value,scope:'repo'}),value => ({...value,token_type:123})]) {
    f.setTokenTransform(transform); const flow = await f.start(); await assert.rejects(f.service.callback({query:flow.query}),{reason:'invalid_token_response'});
  }
});

test('logout and permission changes during provider reads prevent metadata delivery',async t => {
  const f = await fixture(t); await f.link(); const pause = gate();
  f.setIntercept(async url => { if (new URL(url).pathname === '/user/installations') { pause.entered(); await pause.wait; } });
  const read = f.service.status(f.optionsA); await pause.ready; f.changeViewer({...f.optionsA.viewer,projectIds:['Other']}); pause.release(); await assert.rejects(read,{reason:'viewer_authority_changed'});
  assert.equal(f.calls.some(call => call.url.includes('/repositories')),true); // prior complete had this request
});

test('disconnect races fence outstanding reads and cannot resurrect a local link',async t => {
  const f = await fixture(t); await f.link(); const pause = gate();
  f.setIntercept(async url => { if (new URL(url).pathname.endsWith('/repositories')) { pause.entered(); await pause.wait; } });
  const read = f.service.status(f.optionsA); await pause.ready; const disconnected = await f.service.disconnect(f.optionsA); assert.equal(disconnected.state,'disconnected'); pause.release(); await assert.rejects(read,{reason:'connection_changed'});
  assert.equal((await f.service.status(f.optionsA)).state,'disconnected');
});

test('disconnect during OAuth exchange invalidates callback, reports uncertainty and revokes late token once',async t => {
  const f = await fixture(t), flow = await f.start(), pause = gate();
  f.setIntercept(async url => { if (url.endsWith('/access_token')) { pause.entered(); await pause.wait; } });
  const callback = f.service.callback({query:flow.query}); await pause.ready;
  const result = await f.service.disconnect(f.optionsA); assert.equal(result.remoteRevoked,false); assert.equal(result.reason,'provider_revocation_unconfirmed'); pause.release();
  await assert.rejects(callback,{reason:'authorization_state_expired_or_used'}); assert.equal(f.calls.filter(call => call.options.method === 'DELETE').length,1); assert.equal((await f.service.status(f.optionsA)).state,'disconnected');
});

test('disconnect revokes staged and saved tokens, while provider failure still revokes local access',async t => {
  const f = await fixture(t); await f.link(); const next = await f.start(); await f.service.callback({query:next.query});
  const result = await f.service.disconnect(f.optionsA); assert.equal(result.remoteRevoked,true); assert.equal(f.calls.filter(call => call.options.method === 'DELETE').length,2);
  await f.link(); f.setIntercept((url,options) => options.method === 'DELETE' ? json({message:'EXCLUDED_REVOCATION_FAILURE'},500) : null);
  const failed = await f.service.disconnect(f.optionsA); assert.equal(failed.state,'disconnected'); assert.equal(failed.remoteRevoked,false); assert.equal((await f.service.status(f.optionsA)).state,'disconnected');
});

test('provider redirects and hostile pagination never change the credential destination',async t => {
  const f = await fixture(t); await f.link();
  f.setIntercept(url => new URL(url).pathname === '/user/installations' ? json({total_count:2,installations:[installation()]},200,{link:'<https://evil.test/steal?page=2>; rel="next"'}) : null);
  await assert.rejects(f.service.listRepositories(f.optionsA),{reason:'invalid_provider_pagination'});
  f.setIntercept(url => new URL(url).pathname === '/user' ? new Response(null,{status:302,headers:{location:'https://evil.test/steal'}}) : null);
  await assert.rejects(f.service.listRepositories(f.optionsA),{reason:'provider_unavailable'});
  assert.equal(f.calls.some(call => new URL(call.url).hostname === 'evil.test'),false);
});

test('pagination is bounded, reports partial coverage and constructs each allowed next request itself',async t => {
  const f = await fixture(t); await f.link();
  f.setIntercept(url => {
    const target = new URL(url); if (!target.pathname.endsWith('/repositories')) return null;
    const page = Number(target.searchParams.get('page')), repositories = Array.from({length:50},(_,i) => repo((page - 1) * 50 + i + 1));
    const next = new URL(target); next.searchParams.set('page',String(page + 1));
    return json({total_count:100000,repositories},200,{link:'<' + next.href + '>; rel="next"'});
  });
  const before = f.calls.length, result = await f.service.listRepositories(f.optionsA); assert.equal(result.repositories.length,500); assert.equal(result.partial,true); assert.equal(f.calls.length - before,12); assert.equal(f.calls.some(call => new URL(call.url).searchParams.get('page') === '11'),false);
});

test('malformed, oversized and identity-swapped provider responses fail closed without source text leakage',async t => {
  const f = await fixture(t); await f.link();
  for (const response of [json({id:999,login:'mallory'}),new Response('EXCLUDED_INVALID_JSON',{headers:{'content-type':'application/json'}}),json({id:101,login:'alice'},200,{'content-length':String(GITHUB_CONNECTION_LIMITS.responseBytes + 1)}),new Response('EXCLUDED_HTML',{headers:{'content-type':'text/html'}})]) {
    f.setIntercept(url => new URL(url).pathname === '/user' ? response : null);
    await assert.rejects(f.service.listRepositories(f.optionsA),error => { assert.equal(error.message,'GitHub connection unavailable'); assert.equal(JSON.stringify(error).includes('EXCLUDED_'),false); return true; });
  }
});

test('private durable state survives restart, pending browser state does not and changed App bindings are refused',async t => {
  const f = await fixture(t); await f.link(); await f.service.selectRepositories({...f.optionsA,repositories:[{installationId:10,repositoryId:1}]}); const flow = await f.start(); await f.reopen();
  await assert.rejects(f.service.callback({query:flow.query}),{reason:'authorization_state_expired_or_used'}); assert.equal((await f.service.status(f.optionsA)).state,'connected');
  await assert.rejects(createGitHubConnections({configuration:{...f.config,appId:5678},directory:f.directory,publicOrigin:'https://control.test'}),{reason:'app_binding_changed'});
  if (process.platform !== 'win32') { assert.equal((await fs.stat(f.directory)).mode & 0o777,0o700); assert.equal((await fs.stat(path.join(f.directory,'connections.sqlite'))).mode & 0o777,0o600); }
});

async function makePublic(file,directory) {
  if (process.platform !== 'win32') { await fs.chmod(file,directory ? 0o755 : 0o644); return; }
  const script = String.raw`$ErrorActionPreference='Stop'; try {$r=[Console]::In.ReadToEnd()|ConvertFrom-Json; $acl=if($r.directory){[IO.Directory]::GetAccessControl($r.path)}else{[IO.File]::GetAccessControl($r.path)}; $sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'ReadAndExecute','Allow'); $acl.AddAccessRule($rule); if($r.directory){[IO.Directory]::SetAccessControl($r.path,$acl)}else{[IO.File]::SetAccessControl($r.path,$acl)}; exit 0}catch{exit 1}`;
  await new Promise((resolve,reject) => {
    const child = spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdio:['pipe','ignore','ignore'],shell:false,windowsHide:true});
    child.once('error',reject); child.once('close',code => code === 0 ? resolve() : reject(Error('TEST_ONLY ACL setup failed'))); child.stdin.end(JSON.stringify({path:file,directory}));
  });
}

test('owner-private files and Windows ACLs/POSIX modes are enforced before credential use',async t => {
  const f = await fixture(t); await makePublic(f.config.clientSecretFile,false);
  await assert.rejects(f.service.startAuthorization(f.optionsA),{reason:'owner_secret_file_required'}); assert.equal(f.calls.length,0);
  const unsafeDirectory = path.join(f.root,'unsafe'); await fs.mkdir(unsafeDirectory,{mode:0o700}); await makePublic(unsafeDirectory,true);
  await assert.rejects(createGitHubConnections({configuration:f.config,directory:unsafeDirectory,publicOrigin:'https://control.test'}),{reason:'private_storage_required'});
  assert.equal(await fs.access(path.join(unsafeDirectory,'connections.sqlite')).then(() => true,() => false),false);
});

test('permission drift on an active private database prevents every protected operation',async t => {
  const f = await fixture(t); await f.link(); await makePublic(path.join(f.directory,'connections.sqlite'),false); const before = f.calls.length;
  await assert.rejects(f.service.status(f.optionsA),{reason:'private_storage_required'}); await assert.rejects(f.service.disconnect(f.optionsA),{reason:'private_storage_required'}); assert.equal(f.calls.length,before);
});

test('on-demand repository metadata requires project selection and never exposes unprojected content',async t=>{
 const f=await fixture(t);await f.link();await assert.rejects(f.service.readRepository({...f.optionsA,installationId:10,repositoryId:1}),{reason:'repository_not_permitted'});
 await f.service.selectRepositories({...f.optionsA,repositories:[{installationId:10,repositoryId:1}]});
 const sha='a'.repeat(40);
 f.setIntercept((url,options)=>{if(!url.startsWith('https://api.github.com/repos/'))return null;assert.equal(options.method,'GET');const u=new URL(url);
  if(u.pathname==='/repos/argellan/test-1')return json({...repo(1),default_branch:'main',description:'EXCLUDED_DESCRIPTION',disabled:false});
  if(u.pathname.endsWith('/branches/main'))return json({name:'main',commit:{sha},protected:true});
  if(u.pathname.endsWith('/pulls'))return json([]);
  if(u.pathname.endsWith('/actions/runs'))return json({total_count:0,workflow_runs:[]});
  if(u.pathname.endsWith('/check-runs'))return json({total_count:0,check_runs:[]});
  if(u.pathname.endsWith('/status'))return json({total_count:0,statuses:[]});
  assert.fail('Unexpected metadata endpoint');
 });
 const value=await f.service.readRepository({...f.optionsA,installationId:10,repositoryId:1});assert.equal(value.state,'current');assert.equal(value.project,'Project A');assert.deepEqual(value.records.map(r=>r.kind),['repository','branch']);assert.equal(value.coverage.mode,'on-demand');assert.equal(value.coverage.completeRepositoryHistory,false);assert(!JSON.stringify(value).includes('EXCLUDED'));
 await assert.rejects(f.service.readRepository({...f.optionsA,project:'Project B',installationId:10,repositoryId:1}),{reason:'repository_not_permitted'});
 f.accounts.a.repositories.set(10,[]);await assert.rejects(f.service.readRepository({...f.optionsA,installationId:10,repositoryId:1}),{reason:'repository_not_permitted'});
});

test('GitHub callback accepts only the exact optional issuer before exchanging a code',async t => {
  const f=await fixture(t),flow=await f.start();
  for(const issuer of ['', 'https://evil.test/login/oauth', 'https://github.com/login/oauth/', 'https://github.com.evil.test/login/oauth', 'http://github.com/login/oauth']){
    const query=new URLSearchParams(flow.query);query.set('iss',issuer);
    await assert.rejects(f.service.callback({query}),{reason:'invalid_authorization_callback',status:400});
  }
  const duplicate=new URLSearchParams(flow.query);duplicate.append('iss','https://github.com/login/oauth');duplicate.append('iss','https://github.com/login/oauth');
  await assert.rejects(f.service.callback({query:duplicate}),{reason:'invalid_authorization_callback',status:400});
  assert.equal(f.calls.length,0);
  const valid=new URLSearchParams(flow.query);valid.set('iss','https://github.com/login/oauth');
  assert.equal((await f.service.callback({query:valid})).state,'authorization_received');
  await assert.rejects(f.service.callback({query:valid}),{reason:'authorization_state_expired_or_used'});
  assert.equal((await f.service.completeAuthorization(f.optionsA)).state,'authorized');
});
test('GitHub issuer validation preserves denial handling',async t => {
  const f=await fixture(t),flow=await f.start();
  const query=new URLSearchParams({state:flow.query.get('state'),error:'access_denied',iss:'https://github.com/login/oauth'});
  assert.equal((await f.service.callback({query})).reason,'authorization_denied');
  assert.equal(f.calls.length,0);
});
