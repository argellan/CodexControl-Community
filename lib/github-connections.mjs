// Author: Bishop Crockett
// Owner: Argellan.com
// SPDX-License-Identifier: MIT
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {readPrivateKeyFile} from './private-key-file.mjs';
import {GITHUB_API_VERSION,projectGitHubMetadata} from './github-metadata.mjs';

const API = 'https://api.github.com', WEB = 'https://github.com';
export const GITHUB_CONNECTION_CALLBACK_PATH = '/api/integrations/github/callback';
export const GITHUB_CONNECTION_COMPLETION_PATH = '/?github=complete';
export const GITHUB_CONNECTION_PERMISSIONS = Object.freeze({metadata:'read', contents:'read', pull_requests:'read', checks:'read', statuses:'read', actions:'read'});
export const GITHUB_CONNECTION_LIMITS = Object.freeze({stateLifetimeMs:600000, completionLifetimeMs:300000, pending:128, users:1024, selectedRepositories:32, pageSize:50, pages:10, installations:20, repositories:500, requests:40, responseBytes:2097152});
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
const validId = value => Number.isSafeInteger(value) && value > 0;
const sameRepository = (a,b) => a.installationId === b.installationId && a.repositoryId === b.repositoryId;
const privatePath = value => typeof value === 'string' && path.isAbsolute(value) && value.length <= 1024 && !/^(?:\\\\|\/\/)/.test(value) && !/[\x00-\x1f\x7f]/.test(value);
const publicValue = (state, reason = null, extra = {}) => ({schemaVersion:1, configured:true, readOnly:true, state, reason, ...extra});
const problem = (reason, status = 503) => Object.assign(new Error('GitHub connection unavailable'), {status, code:'GITHUB_CONNECTION_UNAVAILABLE', reason});

export function validateGitHubAppConfiguration(value, publicOrigin) {
  if (value === undefined || value === null || value.enabled === false) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['enabled','appId','clientId','appSlug','clientSecretFile'].includes(key)) || value.enabled !== true || !validId(value.appId) || typeof value.clientId !== 'string' || !/^[A-Za-z0-9._-]{8,100}$/.test(value.clientId) || typeof value.appSlug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(value.appSlug) || !privatePath(value.clientSecretFile)) throw problem('invalid_app_configuration');
  let origin;
  try { origin = new URL(publicOrigin); } catch { throw problem('fixed_public_origin_required'); }
  if (origin.origin !== publicOrigin || origin.username || origin.password || origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname))) throw problem('fixed_public_origin_required');
  return Object.freeze({...value, publicOrigin, callbackUrl:publicOrigin + GITHUB_CONNECTION_CALLBACK_PATH});
}

// Only the newly created service directory is hardened. An existing directory
// with an unsafe owner/ACL is refused; it is never silently repaired.
const ACL_SCRIPT = String.raw`$ErrorActionPreference='Stop'
try {
 $request=[Console]::In.ReadToEnd() | ConvertFrom-Json
 $current=[Security.Principal.WindowsIdentity]::GetCurrent().User
 $trusted=@($current.Value,'S-1-5-18','S-1-5-32-544')
 if ($request.create) {
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($current); $acl.SetAccessRuleProtection($true,$false)
  foreach ($id in $trusted) {
   $sid=New-Object Security.Principal.SecurityIdentifier($id)
   $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
   $acl.AddAccessRule($rule)
  }
  [IO.Directory]::SetAccessControl($request.path,$acl)
 }
 $acl=if($request.directory){[IO.Directory]::GetAccessControl($request.path)}else{[IO.File]::GetAccessControl($request.path)}
 if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) {throw 'Refused'}
 foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted) {throw 'Refused'}
 }
 [Console]::Out.Write('GITHUB_PRIVATE_OK')
} catch {exit 1}`;

async function windowsAcl(file, directory, create = false) {
  await new Promise((resolve,reject) => {
    let child, output = '', bytes = 0, timer, settled = false;
    const finish = ok => { if (settled) return; settled = true; clearTimeout(timer); ok ? resolve() : reject(problem('private_storage_required')); };
    try { child = spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ACL_SCRIPT,'utf16le').toString('base64')], {stdio:['pipe','pipe','pipe'], shell:false, windowsHide:true}); }
    catch { finish(false); return; }
    timer = setTimeout(() => { child.kill(); finish(false); },5000);
    child.on('error',() => finish(false)); child.stdin.on('error',() => finish(false));
    child.stdout.on('data',chunk => { bytes += chunk.length; if (bytes > 1024) { child.kill(); finish(false); } else output += chunk.toString('utf8'); });
    child.stderr.on('data',chunk => { bytes += chunk.length; if (bytes > 1024) { child.kill(); finish(false); } });
    child.on('close',code => finish(code === 0 && output === 'GITHUB_PRIVATE_OK'));
    child.stdin.end(JSON.stringify({path:file, directory, create}));
  });
}

async function assertPrivate(file, directory = false) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.size > 16777216)) throw problem('private_storage_required');
  if (process.platform === 'win32') await windowsAcl(file,directory);
  else if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw problem('private_storage_required');
  return stat;
}

async function openStore(directory, binding) {
  if (!privatePath(directory)) throw problem('local_private_directory_required');
  // No ancestor may redirect the credential store through a junction/symlink.
  for (let ancestor = path.resolve(directory);;) {
    try { if ((await fs.lstat(ancestor)).isSymbolicLink()) throw problem('private_storage_required'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const next = path.dirname(ancestor); if (next === ancestor) break; ancestor = next;
  }
  let created = false;
  try { await fs.mkdir(directory,{mode:0o700}); created = true; } catch (error) { if (error.code !== 'EEXIST') throw problem('private_storage_required'); }
  if (created && process.platform === 'win32') await windowsAcl(directory,true,true);
  await assertPrivate(directory,true);
  const file = path.join(directory,'connections.sqlite');
  try { const handle = await fs.open(file,'wx',0o600); await handle.close(); } catch (error) { if (error.code !== 'EEXIST') throw problem('private_storage_required'); }
  const original = await assertPrivate(file);
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS binding(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS connections(owner TEXT PRIMARY KEY, generation INTEGER NOT NULL, payload TEXT);');
    db.prepare('INSERT OR IGNORE INTO binding VALUES(1,?)').run(binding);
    if (db.prepare('SELECT value FROM binding WHERE id=1').get().value !== binding) throw problem('app_binding_changed');
  } catch (error) { db?.close(); throw error?.reason ? error : problem('private_storage_unavailable'); }
  return {
    async check() { await assertPrivate(directory,true); const current = await assertPrivate(file); if (current.dev !== original.dev || current.ino !== original.ino) throw problem('private_storage_changed'); },
    get(owner) { const row = db.prepare('SELECT generation,payload FROM connections WHERE owner=?').get(owner); return row ? {generation:row.generation, payload:row.payload === null ? null : JSON.parse(row.payload)} : {generation:0,payload:null}; },
    put(owner, expected, payload) {
      const encoded = payload === null ? null : JSON.stringify(payload);
      if (encoded && Buffer.byteLength(encoded) > 32768) throw problem('connection_record_too_large');
      if (expected === 0) {
        if (db.prepare('SELECT count(*) AS n FROM connections').get().n >= GITHUB_CONNECTION_LIMITS.users) throw problem('connection_capacity',429);
        if (!db.prepare('INSERT OR IGNORE INTO connections VALUES(?,1,?)').run(owner,encoded).changes) throw problem('connection_changed',409);
      } else if (!db.prepare('UPDATE connections SET generation=generation+1,payload=? WHERE owner=? AND generation=?').run(encoded,owner,expected).changes) throw problem('connection_changed',409);
      return expected + 1;
    },
    close() { db.close(); },
  };
}

function authority(options, now) {
  const {viewer,clientKey,verifyAuthority,project} = options || {};
  if (!viewer || ['local','legacy'].includes(viewer.id) || typeof viewer.id !== 'string' || !viewer.id || viewer.id.length > 128 || typeof viewer.profileKey !== 'string' || !viewer.profileKey || viewer.profileKey.length > 256 || typeof clientKey !== 'string' || !/^[a-f0-9]{64}$/.test(clientKey) || typeof verifyAuthority !== 'function') throw problem('individual_authenticated_session_required',401);
  const stamp = value => JSON.stringify([value?.id,value?.profileKey,value?.role,value?.hostIds,value?.projectIds,value?.expiresAt]);
  const initial = stamp(viewer), owner = hash(JSON.stringify([viewer.id,viewer.profileKey]));
  if (project !== undefined && (typeof project !== 'string' || !project.trim() || project.length > 160 || /[\x00-\x1f\x7f]/.test(project))) throw problem('invalid_project',400);
  const check = () => {
    const current = verifyAuthority();
    if (!current || stamp(current) !== initial || current.disabled || current.expiresAt && (!Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= now())) throw problem('viewer_authority_changed',403);
    if (project !== undefined && current.projectIds !== null && !current.projectIds?.includes(project)) throw problem('project_not_permitted',403);
    return current;
  };
  check();
  return {owner,session:hash(JSON.stringify([owner,clientKey])),stamp:initial,project,check};
}

function tokenPayload(value, now) {
  if (!value || typeof value !== 'object' || value.error || typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer' || typeof value.access_token !== 'string' || !/^ghu_[A-Za-z0-9_]{20,251}$/.test(value.access_token) || typeof value.refresh_token !== 'string' || !/^ghr_[A-Za-z0-9_]{20,251}$/.test(value.refresh_token) || !Number.isSafeInteger(value.expires_in) || value.expires_in < 60 || value.expires_in > 28800 || !Number.isSafeInteger(value.refresh_token_expires_in) || value.refresh_token_expires_in < value.expires_in || value.refresh_token_expires_in > 15897600 || value.scope !== undefined && value.scope !== '') throw problem(value?.error === 'bad_refresh_token' || value?.error === 'invalid_grant' ? 'reauthorization_required' : 'invalid_token_response');
  return {accessToken:value.access_token,refreshToken:value.refresh_token,expiresAt:now + value.expires_in * 1000,refreshExpiresAt:now + value.refresh_token_expires_in * 1000};
}

async function readJSON(response, bound) {
  if (response.redirected || !/^application\/(?:[^;]+\+)?json(?:;|$)/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length')) > bound) { await response.body?.cancel(); throw problem('invalid_provider_response'); }
  const reader = response.body?.getReader(); if (!reader) throw problem('invalid_provider_response');
  let size = 0; const chunks = [];
  try { for (;;) { const {value,done} = await reader.read(); if (done) break; size += value.byteLength; if (size > bound) throw problem('provider_response_too_large'); chunks.push(value); } }
  catch (error) { await reader.cancel().catch(() => {}); throw error?.reason ? error : problem('invalid_provider_response'); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw problem('invalid_provider_response'); }
}

function nextPage(link, endpoint, page) {
  if (!link) return false;
  if (link.length > 8192) throw problem('invalid_provider_pagination');
  const entries = link.split(',').filter(part => /;\s*rel="next"/.test(part));
  if (!entries.length) return false;
  const match = entries.length === 1 && entries[0].match(/^\s*<([^>]+)>;\s*rel="next"\s*$/);
  if (!match) throw problem('invalid_provider_pagination');
  let target; try { target = new URL(match[1]); } catch { throw problem('invalid_provider_pagination'); }
  const expected = new URL(endpoint,API); expected.searchParams.set('page',String(page + 1));
  const canonical = url => [...url.searchParams].sort().map(pair => pair.join('=')).join('&');
  if (target.origin !== API || target.username || target.password || target.hash || target.pathname !== expected.pathname || canonical(target) !== canonical(expected)) throw problem('invalid_provider_pagination');
  return true;
}

const userProjection = user => {
  if (!user || !validId(user.id) || typeof user.login !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(user.login)) throw problem('invalid_provider_identity');
  return {id:user.id,login:user.login};
};
const permissionState = installation => {
  if (installation.suspended_at) return 'suspended';
  const permissions = installation.permissions;
  return permissions && typeof permissions === 'object' && Object.entries(GITHUB_CONNECTION_PERMISSIONS).every(([name,value]) => permissions[name] === value) && Object.entries(permissions).every(([name,value]) => name in GITHUB_CONNECTION_PERMISSIONS && value === 'read') ? 'available' : 'permission_update_required';
};
function repositoryProjection(repository, installationId) {
  if (!repository || !validId(repository.id) || typeof repository.full_name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository.full_name) || ['.','..'].includes(repository.full_name.split('/')[1]) || typeof repository.private !== 'boolean' || typeof repository.archived !== 'boolean') throw problem('invalid_provider_repository');
  if (repository.permissions?.pull !== true) return null;
  return {installationId,repositoryId:repository.id,fullName:repository.full_name,private:repository.private,archived:repository.archived,url:WEB + '/' + repository.full_name};
}

/** One authoritative hub service. All public results are credential-free.
 * transport is a fetch-compatible server-only injection, not a URL supplied by a viewer.
 * Callback performs no durable link; completeAuthorization requires the initiating session.
 */
export async function createGitHubConnections({configuration,directory,publicOrigin,transport = fetch,now = Date.now} = {}) {
  const config = validateGitHubAppConfiguration(configuration,publicOrigin);
  const unavailable = () => publicValue('unconfigured','app_registration_required',{configured:false,setup:{ownerConfigurationRequired:true,permissions:GITHUB_CONNECTION_PERMISSIONS},repositories:[],installations:[],selection:[]});
  if (!config) return {status:async() => unavailable(),listRepositories:async() => unavailable(),startAuthorization:async() => unavailable(),callback:async() => unavailable(),completeAuthorization:async() => unavailable(),selectRepositories:async() => unavailable(),authorizeRepository:async() => { throw problem('app_registration_required'); },disconnect:async() => unavailable(),close:async() => {}};
  if (typeof transport !== 'function' || typeof now !== 'function') throw problem('invalid_service_configuration');
  const store = await openStore(directory,hash(JSON.stringify([config.appId,config.clientId,config.publicOrigin]))), pending = new Map(), busy = new Set(), exchanging = new Set();
  let closed = false, active = 0, closeResolve;
  const installUrl = WEB + '/apps/' + config.appSlug + '/installations/new';
  const cleanup = () => { for (const [key,state] of pending) if (state.until <= now()) pending.delete(key); };
  const guard = async auth => { if (closed) throw problem('service_closed'); auth?.check(); await store.check(); auth?.check(); };
  const generationCheck = (auth,generation) => { if (closed) throw problem('service_closed'); auth.check(); if (store.get(auth.owner).generation !== generation) throw problem('connection_changed',409); };
  const secret = async () => {
    try { const value = (await readPrivateKeyFile(config.clientSecretFile,{maxBytes:512})).toString('utf8').trim(); if (!/^[A-Za-z0-9_-]{20,200}$/.test(value)) throw problem('owner_secret_file_required'); return value; }
    catch { throw problem('owner_secret_file_required'); }
  };
  const request = async (endpoint, options = {}, bound = GITHUB_CONNECTION_LIMITS.responseBytes) => {
    if (closed) throw problem('service_closed');
    let response;
    try { response = await transport(endpoint,{...options,redirect:'error',signal:AbortSignal.timeout(15000)}); }
    catch { throw problem('provider_unavailable'); }
    if (closed) { await response.body?.cancel(); throw problem('service_closed'); }
    if (response.redirected || response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      throw problem(response.status === 429 || response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0' ? 'github_rate_limited' : response.status === 401 ? 'github_authorization_revoked' : response.status === 403 ? 'github_permission_denied' : response.status === 404 ? 'github_access_removed' : 'provider_unavailable',response.status === 429 ? 429 : 503);
    }
    if (response.status === 204) { await response.body?.cancel(); return null; }
    return readJSON(response,bound);
  };
  const oauth = async parameters => {
    const clientSecret = await secret();
    return request(WEB + '/login/oauth/access_token',{method:'POST',headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.clientId,client_secret:clientSecret,...parameters}).toString()},8192);
  };
  const revokeToken = async token => {
    const clientSecret = await secret();
    return request(API + '/applications/' + config.clientId + '/token',{method:'DELETE',headers:{accept:'application/vnd.github+json','content-type':'application/json','X-GitHub-Api-Version':GITHUB_API_VERSION,authorization:'Basic ' + Buffer.from(config.clientId + ':' + clientSecret).toString('base64')},body:JSON.stringify({access_token:token})},8192);
  };
  const api = (endpoint, token) => request(API + endpoint,{method:'GET',headers:{accept:'application/vnd.github+json',authorization:'Bearer ' + token,'X-GitHub-Api-Version':GITHUB_API_VERSION,'User-Agent':'CodexControl-readonly-connections'}});
  const inspectAccess = async (record, check) => {
    let requests = 0, partial = false;
    const get = async endpoint => { check(); if (++requests > GITHUB_CONNECTION_LIMITS.requests) throw problem('provider_request_bound'); const result = await api(endpoint,record.accessToken); check(); return result; };
    const user = userProjection(await get('/user'));
    if (record.user && record.user.id !== user.id) throw problem('github_identity_changed');
    const installations = [], repositories = [], seenInstallations = new Set(), seenRepositories = new Set();
    let total = null;
    for (let page = 1; page <= GITHUB_CONNECTION_LIMITS.pages; page++) {
      const endpoint = '/user/installations?per_page=50&page=' + page;
      // Capture pagination headers without accepting an upstream URL as a request target.
      check(); if (++requests > GITHUB_CONNECTION_LIMITS.requests) { partial = true; break; }
      let response;
      try { response = await transport(API + endpoint,{method:'GET',headers:{accept:'application/vnd.github+json',authorization:'Bearer ' + record.accessToken,'X-GitHub-Api-Version':GITHUB_API_VERSION,'User-Agent':'CodexControl-readonly-connections'},redirect:'error',signal:AbortSignal.timeout(15000)}); }
      catch { throw problem('provider_unavailable'); }
      if (closed) { await response.body?.cancel(); throw problem('service_closed'); }
      if (response.status !== 200 || response.redirected) { await response.body?.cancel(); throw problem(response.status === 401 ? 'github_authorization_revoked' : response.status === 403 ? 'github_permission_denied' : 'provider_unavailable'); }
      const value = await readJSON(response,GITHUB_CONNECTION_LIMITS.responseBytes); check();
      if (!Array.isArray(value.installations) || value.installations.length > 50 || !Number.isSafeInteger(value.total_count) || value.total_count < 0) throw problem('invalid_provider_response');
      if (total !== null && total !== value.total_count) partial = true; total = value.total_count;
      for (const installation of value.installations) {
        if (!validId(installation.id) || !validId(installation.app_id) || seenInstallations.has(installation.id)) throw problem('invalid_provider_installation');
        seenInstallations.add(installation.id);
        if (installation.app_id !== config.appId) continue;
        if (installations.length >= GITHUB_CONNECTION_LIMITS.installations) { partial = true; continue; }
        if (!['all','selected'].includes(installation.repository_selection)) throw problem('invalid_provider_installation');
        installations.push({id:installation.id,account:userProjection(installation.account),repositorySelection:installation.repository_selection,state:permissionState(installation)});
      }
      const more = nextPage(response.headers.get('link'),endpoint,page);
      if (!more) { if (seenInstallations.size < total) partial = true; break; }
      if (page === GITHUB_CONNECTION_LIMITS.pages) partial = true;
    }
    for (const installation of installations) {
      if (installation.state !== 'available') continue;
      let seen = 0;
      for (let page = 1; page <= GITHUB_CONNECTION_LIMITS.pages; page++) {
        if (requests >= GITHUB_CONNECTION_LIMITS.requests || repositories.length >= GITHUB_CONNECTION_LIMITS.repositories) { partial = true; break; }
        const endpoint = '/user/installations/' + installation.id + '/repositories?per_page=50&page=' + page;
        check(); requests++;
        let response;
        try { response = await transport(API + endpoint,{method:'GET',headers:{accept:'application/vnd.github+json',authorization:'Bearer ' + record.accessToken,'X-GitHub-Api-Version':GITHUB_API_VERSION,'User-Agent':'CodexControl-readonly-connections'},redirect:'error',signal:AbortSignal.timeout(15000)}); }
        catch { throw problem('provider_unavailable'); }
        if (closed) { await response.body?.cancel(); throw problem('service_closed'); }
        if (response.status !== 200 || response.redirected) {
          await response.body?.cancel(); check();
          if ([403,404].includes(response.status)) { installation.state = 'access_removed'; partial = true; break; }
          throw problem(response.status === 401 ? 'github_authorization_revoked' : 'provider_unavailable');
        }
        const value = await readJSON(response,GITHUB_CONNECTION_LIMITS.responseBytes); check();
        if (!Array.isArray(value.repositories) || value.repositories.length > 50 || !Number.isSafeInteger(value.total_count) || value.total_count < 0) throw problem('invalid_provider_response');
        seen += value.repositories.length;
        for (const raw of value.repositories) {
          const repository = repositoryProjection(raw,installation.id); if (!repository) continue;
          const key = repository.installationId + ':' + repository.repositoryId;
          if (seenRepositories.has(key)) throw problem('invalid_provider_repository'); seenRepositories.add(key); repositories.push(repository);
        }
        const more = nextPage(response.headers.get('link'),endpoint,page);
        if (!more) { if (seen < value.total_count) partial = true; break; }
        if (page === GITHUB_CONNECTION_LIMITS.pages) partial = true;
      }
    }
    // If an installation vanished mid-pagination, no earlier page grants access.
    return {user,installations,repositories:repositories.filter(repo => installations.some(installation => installation.id === repo.installationId && installation.state === 'available')),partial,requests};
  };
  const run = async (options, operation) => {
    const auth = authority(options,now); if (closed) throw problem('service_closed');
    if (busy.has(auth.owner)) throw problem('connection_busy',409);
    if (active >= 8) throw problem('connection_capacity',429);
    busy.add(auth.owner); active++;
    try { await guard(auth); cleanup(); return await operation(auth); }
    catch (error) { throw error?.reason ? error : problem('private_storage_unavailable'); }
    finally { busy.delete(auth.owner); active--; if (!active) closeResolve?.(); }
  };
  const loaded = async auth => {
    let row = store.get(auth.owner); if (!row.payload) return row;
    if (row.payload.refreshing) throw problem('refresh_interrupted_reauthorize',409);
    const check = () => generationCheck(auth,row.generation);
    check();
    if (row.payload.expiresAt > now() + 60000) return row;
    if (row.payload.refreshExpiresAt <= now() + 60000) throw problem('reauthorization_required',401);
    const previous = row.payload;
    // Durable refresh intent prevents competing processes from using the same
    // rotating refresh token. Interrupted/ambiguous refresh requires reauth.
    row.generation = store.put(auth.owner,row.generation,{...previous,refreshing:true});
    try {
      const tokens = tokenPayload(await oauth({grant_type:'refresh_token',refresh_token:previous.refreshToken}),now()); check();
      await guard(auth); check();
      row.generation = store.put(auth.owner,row.generation,{...previous,...tokens,refreshing:false}); row.payload = {...previous,...tokens,refreshing:false};
      return row;
    } catch (error) { throw error?.reason ? error : problem('refresh_interrupted_reauthorize',409); }
  };
  const display = (row, access, project) => {
    const selection = (row.payload.selection || []).filter(selected => selected.project === project).map(selected => access.repositories.find(repo => sameRepository(repo,selected))).filter(Boolean);
    return publicValue(selection.length ? 'connected' : 'authorized',selection.length ? null : access.repositories.length ? 'select_repositories' : access.installations.some(item => item.state === 'permission_update_required') ? 'read_only_permissions_required' : access.partial ? 'access_check_incomplete' : 'install_app_or_grant_repository_access',{project,user:access.user,repositories:access.repositories,installations:access.installations,selection,partial:access.partial,checkedAt:new Date(now()).toISOString(),expiresAt:new Date(row.payload.expiresAt).toISOString(),installUrl,permissions:GITHUB_CONNECTION_PERMISSIONS,limits:GITHUB_CONNECTION_LIMITS});
  };
  const read = async (options, operation) => run(options,async auth => {
    if (auth.project === undefined) throw problem('project_required',400);
    const row = await loaded(auth);
    if (!row.payload) return publicValue('disconnected',null,{project:auth.project,repositories:[],installations:[],selection:[],installUrl});
    const check = () => generationCheck(auth,row.generation);
    let access;
    try { access = await inspectAccess(row.payload,check); }
    catch (error) {
      if (error.reason === 'github_authorization_revoked') { await guard(auth); check(); store.put(auth.owner,row.generation,null); return publicValue('reauthorization_required',error.reason,{repositories:[],installations:[],selection:[],installUrl}); }
      throw error;
    }
    await guard(auth); check();
    return operation ? operation({auth,row,access,check}) : display(row,access,auth.project);
  });
  const service = {
    status:options => read(options),
    listRepositories:options => read(options),
    startAuthorization:options => run(options,async auth => {
      if (auth.project === undefined) throw problem('project_required',400);
      if (pending.size >= GITHUB_CONNECTION_LIMITS.pending) throw problem('authorization_capacity',429);
      // Confirm the owner secret is configured before sending the user to GitHub.
      await secret(); await guard(auth);
      const row = store.get(auth.owner), state = random(), verifier = random(), generation = store.put(auth.owner,row.generation,row.payload);
      for (const [key,flow] of pending) if (flow.owner === auth.owner) pending.delete(key);
      pending.set(hash(state),{owner:auth.owner,session:auth.session,stamp:auth.stamp,project:auth.project,generation,verifier,until:now() + GITHUB_CONNECTION_LIMITS.stateLifetimeMs,phase:'started'});
      const url = new URL(WEB + '/login/oauth/authorize');
      for (const [key,value] of Object.entries({client_id:config.clientId,redirect_uri:config.callbackUrl,state,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',scope:'offline_access'})) url.searchParams.set(key,value);
      auth.check();
      return publicValue('authorizing',null,{project:auth.project,authorizationUrl:url.href,expiresAt:new Date(now() + GITHUB_CONNECTION_LIMITS.stateLifetimeMs).toISOString()});
    }),
    async callback({query} = {}) {
      if (closed) throw problem('service_closed'); cleanup();
      if (!(query instanceof URLSearchParams) || [...query.keys()].some(key => !['code','state','error','iss'].includes(key) || query.getAll(key).length !== 1) || query.has('iss') && query.get('iss') !== WEB + '/login/oauth' || !/^[A-Za-z0-9_-]{43}$/.test(query.get('state') || '')) throw problem('invalid_authorization_callback',400);
      const key = hash(query.get('state')), flow = pending.get(key);
      if (!flow || flow.phase !== 'started' || flow.until <= now()) throw problem('authorization_state_expired_or_used',400);
      // Consume before the first await. Duplicate callbacks never exchange twice.
      if (active >= 8) throw problem('connection_capacity',429);
      pending.delete(key); active++; exchanging.add(flow.owner);
      let record;
      try {
        if (query.has('error')) return publicValue('disconnected','authorization_denied',{completionPath:GITHUB_CONNECTION_COMPLETION_PATH});
        if (!/^[A-Za-z0-9_-]{1,512}$/.test(query.get('code') || '') || store.get(flow.owner).generation !== flow.generation) throw problem('authorization_state_expired_or_used',400);
        record = tokenPayload(await oauth({code:query.get('code'),code_verifier:flow.verifier,redirect_uri:config.callbackUrl}),now());
        const user = userProjection(await api('/user',record.accessToken));
        if (closed || flow.until <= now() || store.get(flow.owner).generation !== flow.generation) throw problem('authorization_state_expired_or_used',400);
        pending.set(key,{...flow,verifier:null,record:{...record,user,selection:[]},phase:'received',until:now() + GITHUB_CONNECTION_LIMITS.completionLifetimeMs});
        return publicValue('authorization_received',null,{completionRequired:true,completionPath:GITHUB_CONNECTION_COMPLETION_PATH});
      } catch (error) {
        // The provider may have accepted an exchange before a local disconnect.
        // No stale token is retained; revocation is one bounded best effort.
        if (record && !closed) await revokeToken(record.accessToken).catch(() => {});
        throw error?.reason ? error : problem('authorization_callback_failed');
      } finally { exchanging.delete(flow.owner); active--; if (!active) closeResolve?.(); }
    },
    completeAuthorization:options => run(options,async auth => {
      if (auth.project === undefined) throw problem('project_required',400);
      const entry = [...pending].find(([,flow]) => flow.owner === auth.owner && flow.session === auth.session && flow.stamp === auth.stamp && flow.project === auth.project && flow.phase === 'received');
      if (!entry) throw problem('authorization_completion_required',409);
      const [key,flow] = entry; pending.delete(key);
      const check = () => { generationCheck(auth,flow.generation); if (flow.until <= now()) throw problem('authorization_state_expired_or_used',400); };
      check(); const access = await inspectAccess(flow.record,check); await guard(auth); check();
      const prior = store.get(auth.owner).payload, selection = (prior?.user?.id === access.user.id ? prior.selection || [] : []).map(selected => { const repo = access.repositories.find(item => sameRepository(item,selected)); return repo ? {...repo,project:selected.project} : null; }).filter(Boolean), payload = {...flow.record,user:access.user,selection};
      const generation = store.put(auth.owner,flow.generation,payload);
      return display({generation,payload},access,auth.project);
    }),
    selectRepositories:options => read(options,async ({auth,row,access,check}) => {
      const wanted = options.repositories;
      if (!Array.isArray(wanted) || wanted.length > GITHUB_CONNECTION_LIMITS.selectedRepositories || wanted.some(repo => !repo || Object.keys(repo).some(key => !['installationId','repositoryId'].includes(key)) || !validId(repo.installationId) || !validId(repo.repositoryId)) || new Set(wanted.map(repo => repo.installationId + ':' + repo.repositoryId)).size !== wanted.length) throw problem('invalid_repository_selection',400);
      const selected = wanted.map(repo => access.repositories.find(item => sameRepository(item,repo)));
      if (selected.some(repo => !repo)) throw problem('repository_not_permitted',403);
      const selection = [...row.payload.selection.filter(repo => repo.project !== auth.project),...selected.map(repo => ({...repo,project:auth.project}))];
      if (selection.length > 128) throw problem('connection_record_too_large',413);
      await guard(auth); check(); const payload = {...row.payload,selection};
      const generation = store.put(auth.owner,row.generation,payload);
      return display({generation,payload},access,auth.project);
    }),
    readRepository:async options => {
      const result=await read(options,async ({auth,row,access,check})=>{
        if(!validId(options.installationId)||!validId(options.repositoryId))throw problem('invalid_repository_selection',400);
        const repository=access.repositories.find(repo=>sameRepository(repo,options));
        if(!repository||!row.payload.selection.some(selected=>selected.project===auth.project&&sameRepository(repository,selected)))throw problem('repository_not_permitted',403);
        const base='/repos/'+repository.fullName,context={repositoryId:repository.repositoryId,repository:repository.fullName},records=[],unavailable=[];
        const observedAt=new Date(now()).toISOString();let bounded=false;
        const get=async endpoint=>{check();const value=await api(endpoint,row.payload.accessToken);check();return value;};
        const add=(kind,value,extra={})=>records.push({...projectGitHubMetadata(kind,value,{...context,...extra}),observedAt,verifiedAt:observedAt});
        const part=async(name,fn)=>{try{await fn();}catch(error){check();if(['github_authorization_revoked','github_access_removed'].includes(error.reason))throw error;unavailable.push(name);}};
        const raw=await get(base);add('repository',raw);
        let branch;
        if(typeof raw.default_branch==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(raw.default_branch)&&!raw.default_branch.includes('..'))await part('branch',async()=>{branch=await get(base+'/branches/'+encodeURIComponent(raw.default_branch));add('branch',branch,{branch:raw.default_branch});});
        await part('pulls',async()=>{const list=await get(base+'/pulls?state=open&per_page=20');if(!Array.isArray(list)||list.length>20)throw problem('invalid_provider_response');bounded||=list.length===20;for(const pull of list)add('pull-list',pull);});
        let runs=[];
        await part('runs',async()=>{const page=await get(base+'/actions/runs?per_page=20');if(!Array.isArray(page.workflow_runs)||page.workflow_runs.length>20)throw problem('invalid_provider_response');bounded||=page.total_count>20;runs=page.workflow_runs;for(const run of runs)add('run',run);});
        const headSha=branch?.commit?.sha;
        if(/^[a-f0-9]{40}$/.test(headSha||'')){
          await part('checks',async()=>{const page=await get(base+'/commits/'+headSha+'/check-runs?per_page=20');if(!Array.isArray(page.check_runs)||page.check_runs.length>20)throw problem('invalid_provider_response');bounded||=page.total_count>20;for(const record of page.check_runs)add('check',record,{headSha});});
          await part('statuses',async()=>{const page=await get(base+'/commits/'+headSha+'/status?per_page=20');if(!Array.isArray(page.statuses)||page.statuses.length>20)throw problem('invalid_provider_response');bounded||=page.total_count>20;for(const record of page.statuses)add('status',record,{headSha});});
        }
        for(const run of runs.slice(0,2))await part('artifacts',async()=>{const page=await get(base+'/actions/runs/'+run.id+'/artifacts?per_page=20');if(!Array.isArray(page.artifacts)||page.artifacts.length>20)throw problem('invalid_provider_response');bounded||=page.total_count>20;for(const record of page.artifacts)add('artifact',record,{headSha:run.head_sha,runId:run.id,runAttempt:run.run_attempt});});
        await guard(auth);check();
        return publicValue(unavailable.length||bounded?'partial':'current',null,{project:auth.project,repository,records,observedAt,coverage:{mode:'on-demand',completeRepositoryHistory:false,unavailable,bounded}});
      });
      if(!['current','partial'].includes(result.state))throw problem('github_authorization_required',401);
      return result;
    },
    authorizeRepository:async options => {
      const result = await read(options,({auth,row,access,check}) => {
      if (!validId(options.installationId) || !validId(options.repositoryId)) throw problem('invalid_repository_selection',400);
      const repository = access.repositories.find(repo => sameRepository(repo,options));
      if (!repository || !row.payload.selection.some(selected => selected.project === auth.project && sameRepository(repository,selected))) throw problem('repository_not_permitted',403);
      check(); return publicValue('permitted',null,{project:auth.project,repository,checkedAt:new Date(now()).toISOString()});
      });
      if (result.state !== 'permitted') throw problem('github_authorization_required',401);
      return result;
    },
    // Revoke locally before the network operation, even if a read/refresh is
    // in flight. Its generation fence then prevents delivery or resurrection.
    async disconnect(options) {
      const auth = authority(options,now); await guard(auth); cleanup();
      const row = store.get(auth.owner); auth.check(); const generation = store.put(auth.owner,row.generation,null);
      const tokens = new Set(row.payload ? [row.payload.accessToken] : []), exchangeInFlight = exchanging.has(auth.owner);
      for (const [key,flow] of pending) if (flow.owner === auth.owner) { if (flow.record) tokens.add(flow.record.accessToken); pending.delete(key); }
      active++;
      try {
        let remoteRevoked = !exchangeInFlight;
        for (const token of tokens) {
          try {
            generationCheck(auth,generation); await revokeToken(token);
          } catch (error) { if (!['github_access_removed','github_authorization_revoked'].includes(error.reason)) remoteRevoked = false; }
        }
        generationCheck(auth,generation);
        return publicValue('disconnected',remoteRevoked ? null : 'provider_revocation_unconfirmed',{remoteRevoked,revocationUrl:WEB + '/settings/apps/authorizations',repositories:[],installations:[],selection:[]});
      } finally { active--; if (!active) closeResolve?.(); }
    },
    async close() {
      if (closed) return; closed = true; pending.clear();
      if (active) await new Promise(resolve => { closeResolve = resolve; });
      store.close();
    },
  };
  return service;
}
