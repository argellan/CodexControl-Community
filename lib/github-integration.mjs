// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {requireStorageReserve, storageAdmissionOptions, StorageBackpressure} from './storage-admission.mjs';
import {GITHUB_API_VERSION, validateGitHubConfiguration, projectGitHubMetadata, githubScopeAllowed} from './github-metadata.mjs';
import {installGitHubArchive,githubArchiveStatus} from './github-archive.mjs';

const API = 'https://api.github.com';
const MAX_BODY = 2 * 1024 * 1024, PAGE_SIZE = 50, MAX_PAGES = 20, MAX_JOBS = 2048;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const failure = reason => Object.assign(new Error('GitHub metadata unavailable'), {reason});
const initial = () => ({cycle:0, queue:[], seen:[], due:0, retryAt:0, failures:0, state:'unavailable', reason:'not_collected', cyclePartial:false, capturedBytes:0, capturedPages:0});
const listKeys = {check:'check_runs', run:'workflow_runs', artifact:'artifacts'};

// Reject malformed/overflowing seconds before JSON can turn Infinity into null.
const deadline = (seconds, base = 0) => {
  if(typeof seconds !== 'string' || !/^\d{1,12}$/.test(seconds))return 0;
  const value=base+Number(seconds)*1000;
  return Number.isSafeInteger(value)&&value>base&&value<=8640000000000000?value:0;
};

// One instance owns one LOCAL database and one explicit repository binding.
// No deletion/eviction API exists: archive support is deliberately not claimed.
export class GitHubIntegration {
  #db; #configuration; #tokenProvider; #fetch; #now; #storage; #file; #busy = false; #owner = crypto.randomUUID();
  constructor({file, configuration, tokenProvider, fetchImpl = fetch, now = Date.now, storageAdmission} = {}) {
    this.#configuration = validateGitHubConfiguration(configuration);
    if (typeof file !== 'string' || !path.isAbsolute(file) || /^(?:\\\\|\/\/)/.test(file)) throw new Error('Local absolute GitHub journal path required');
    if (typeof tokenProvider !== 'function') throw new Error('In-memory credential provider required');
    this.#file = file; this.#tokenProvider = tokenProvider; this.#fetch = fetchImpl; this.#now = now;
    this.#storage = storageAdmissionOptions(storageAdmission);
    mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
    requireStorageReserve(file, this.#storage);
    this.#db = new DatabaseSync(file);
    try {
      this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS scheduler (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_ms INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS pages (endpoint TEXT PRIMARY KEY, etag TEXT, payload TEXT NOT NULL, observed_ms INTEGER NOT NULL, verified_ms INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS observations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, cycle INTEGER NOT NULL, endpoint TEXT NOT NULL, observed_ms INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(cycle,endpoint));
        CREATE TRIGGER IF NOT EXISTS observations_no_delete BEFORE DELETE ON observations BEGIN SELECT RAISE(ABORT,'Immutable captured metadata'); END;
        CREATE TRIGGER IF NOT EXISTS observations_no_update BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT,'Immutable captured metadata'); END;`);
      const binding = JSON.stringify(this.#configuration), prior = this.#db.prepare('SELECT payload FROM binding WHERE id=1').get();
      if (prior && prior.payload !== binding) throw new Error('GitHub binding changed; use a new journal');
      this.#db.prepare('INSERT OR IGNORE INTO binding VALUES(1,?)').run(binding);
      this.#db.prepare('INSERT OR IGNORE INTO journal VALUES(1,?)').run(crypto.randomUUID());
      this.#db.prepare('INSERT OR IGNORE INTO scheduler VALUES(1,?)').run(JSON.stringify(initial()));
      installGitHubArchive(this.#db);
      if(process.platform!=='win32')chmodSync(file,0o600);
    } catch (error) { this.#db.close(); throw error; }
  }
  close() { if (this.#busy) throw new Error('GitHub collection still active'); this.#db.close(); }
  #state() { return JSON.parse(this.#db.prepare('SELECT payload FROM scheduler WHERE id=1').get().payload); }
  #save(state) {
    const changed=this.#db.prepare('UPDATE scheduler SET payload=? WHERE id=1 AND EXISTS(SELECT 1 FROM lease WHERE id=1 AND owner=?)').run(JSON.stringify(state),this.#owner).changes;
    if(!changed)throw failure('lease_lost');
  }
  #lease() {
    const now = this.#now();
    return !!this.#db.prepare('INSERT INTO lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_ms=excluded.expires_ms WHERE lease.expires_ms<=? OR lease.owner=?').run(this.#owner,now+60000,now,this.#owner).changes;
  }
  #owned() { return this.#db.prepare('SELECT owner FROM lease WHERE id=1').get()?.owner === this.#owner; }
  #root() { return '/repos/' + this.#configuration.repository; }
  #job(kind, endpoint, context = {}, page = 1) { return {kind, endpoint, context, page}; }
  #enqueue(state, job) {
    if (state.seen.includes(job.endpoint)) return;
    if (state.seen.length >= MAX_JOBS) { state.cyclePartial = true; return; }
    state.seen.push(job.endpoint); state.queue.push(job);
  }
  #expand(state, job, records, next) {
    const root = this.#root();
    if (job.kind === 'repository') {
      for (const number of this.#configuration.pullNumbers) this.#enqueue(state, this.#job('pull', `${root}/pulls/${number}`, {pullNumber:number}));
      if(this.#configuration.branch)this.#enqueue(state,this.#job('branch',`${root}/branches/${encodeURIComponent(this.#configuration.branch)}`,{branch:this.#configuration.branch}));
      if(this.#configuration.discoverPulls)this.#enqueue(state,this.#job('pull-list',`${root}/pulls?state=open&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=1`));
    }
    if(job.kind==='pull-list')for(const record of records){
      state.discoveredPulls=state.discoveredPulls||[];
      if(state.discoveredPulls.includes(record.number))continue;
      if(state.discoveredPulls.length>=16){state.cyclePartial=true;continue;}
      state.discoveredPulls.push(record.number);this.#enqueue(state,this.#job('pull',`${root}/pulls/${record.number}`,{pullNumber:record.number}));
    }
    if (job.kind === 'pull' || job.kind === 'branch') for (const record of records) {
      const headSha = job.kind==='branch'?record.headSha:record.head.sha;
      if (!headSha) { state.cyclePartial = true; continue; }
      const context = {headSha};
      if(this.#configuration.collectChecks!==false)this.#enqueue(state, this.#job('check', `${root}/commits/${headSha}/check-runs?filter=all&per_page=${PAGE_SIZE}&page=1`, context));
      this.#enqueue(state, this.#job('status', `${root}/commits/${headSha}/statuses?per_page=${PAGE_SIZE}&page=1`, context));
      this.#enqueue(state, this.#job('run', `${root}/actions/runs?head_sha=${headSha}&per_page=${PAGE_SIZE}&page=1`, context));
    }
    if (job.kind === 'run') for (const record of records) this.#enqueue(state, this.#job('artifact', `${root}/actions/runs/${record.id}/artifacts?per_page=${PAGE_SIZE}&page=1`, {headSha:record.headSha, runId:record.id, runAttempt:record.attempt}));
    if (next) {
      if (job.page >= (job.kind==='pull-list'?1:MAX_PAGES)) state.cyclePartial = true;
      else this.#enqueue(state, {...job, endpoint:next, page:job.page + 1});
    }
  }
  #next(link, job) {
    if (!link) return null;
    if (link.length > 8192) throw failure('invalid_pagination');
    const entries = link.split(',').filter(value => /;\s*rel="next"/.test(value));
    if (!entries.length) return null;
    if (entries.length !== 1) throw failure('invalid_pagination');
    const match = entries[0].match(/^\s*<([^>]+)>;\s*rel="next"\s*$/);
    if (!match) throw failure('invalid_pagination');
    const candidate = new URL(match[1]), expected = new URL(job.endpoint, API);
    expected.searchParams.set('page', String(job.page + 1));
    const canonical = url => [...url.searchParams].sort().map(pair => pair.join('=')).join('&');
    if (candidate.origin !== API || candidate.username || candidate.password || candidate.hash || candidate.pathname !== expected.pathname || canonical(candidate) !== canonical(expected)) throw failure('invalid_pagination');
    // Use our constructed endpoint, never the server-supplied URL.
    return expected.pathname + expected.search;
  }
  async #body(response) {
    if (!/^application\/(?:[^;]+\+)?json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw failure('invalid_response');
    if (Number(response.headers.get('content-length')) > MAX_BODY) { await response.body?.cancel(); throw failure('response_too_large'); }
    const reader = response.body?.getReader(); if (!reader) throw failure('invalid_response');
    const chunks = []; let bytes = 0;
    try { for (;;) { const {done,value} = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_BODY) throw failure('response_too_large'); chunks.push(value); } }
    catch (error) { await reader.cancel().catch(() => {}); throw error; }
    try { return {value:JSON.parse(Buffer.concat(chunks).toString('utf8')), bytes}; } catch { throw failure('invalid_response'); }
  }
  #retry(response, state, now) {
    return Math.max(now + Math.min(3600000, 60000 * 2 ** Math.min(state.failures,6)), deadline(response.headers.get('retry-after'),now), response.headers.get('x-ratelimit-remaining') === '0' ? deadline(response.headers.get('x-ratelimit-reset')) : 0);
  }
  async #request(job, cache) {
    let token; try { token = await this.#tokenProvider(); } catch { throw failure('authentication_unavailable'); }
    if (typeof token !== 'string' || !/^[A-Za-z0-9_]{20,255}$/.test(token)) throw failure('authentication_unavailable');
    const headers = {accept:'application/vnd.github+json', authorization:'Bearer ' + token, 'X-GitHub-Api-Version':GITHUB_API_VERSION, 'User-Agent':'CodexControl-readonly-metadata'};
    if (cache?.etag) headers['If-None-Match'] = cache.etag;
    // Redirects are refused, including repository rename/transfer. Credentials
    // never follow server-provided URLs; configuration requires explicit rebinding.
    return this.#fetch(API + job.endpoint, {method:'GET', headers, redirect:'error', signal:AbortSignal.timeout(15000)});
  }
  async poll({requestBudget = 8} = {}) {
    if (!Number.isSafeInteger(requestBudget) || requestBudget < 1 || requestBudget > 16) throw new Error('Invalid GitHub request budget');
    if (this.#busy) return {state:'busy', requests:0};
    this.#busy = true; let requests = 0, bytes = 0; const started = performance.now();
    try {
      if (!this.#lease()) return {state:'busy', requests:0};
      let state = this.#state(); const now = this.#now();
      if (now < state.retryAt || (!state.queue.length && now < state.due)) return {state:state.state, requests:0};
      if (!state.queue.length) {
        state = {...state, cycle:state.cycle + 1, seen:[], queue:[], discoveredPulls:[], cyclePartial:false, state:'collecting', reason:null};
        this.#enqueue(state, this.#job('repository', this.#root())); this.#save(state);
      }
      while (requests < requestBudget && state.queue.length && this.#now() >= state.retryAt) {
        const job = state.queue[0], cache = this.#db.prepare('SELECT * FROM pages WHERE endpoint=?').get(job.endpoint);
        let response;
        try {
          if (!this.#lease()) return {state:'busy',requests};
          requireStorageReserve(this.#file, this.#storage);
          if (state.capturedBytes - githubArchiveStatus(this.#db).archivedBytes + MAX_BODY > this.#storage.sourceBytes) throw new StorageBackpressure();
          requests++; response = await this.#request(job, cache);
          const received = this.#now();
          if (![200,304].includes(response.status)) {
            await response.body?.cancel();
            const rate = response.status === 429 || response.status === 403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0');
            state.state = rate ? 'rate_limited' : 'unavailable';
            state.reason = rate ? 'rate_limit' : response.status === 401 ? 'authentication_failed' : response.status === 403 ? 'permission_denied' : response.status === 404 ? 'missing_or_inaccessible' : 'upstream_error';
            state.retryAt = this.#retry(response,state,received); state.failures++; if(this.#owned())this.#save(state); break;
          }
          let page;
          if (response.status === 304) { await response.body?.cancel(); if (!cache?.etag) throw failure('missing_conditional_cache'); page = JSON.parse(cache.payload); }
          else {
            const body = await this.#body(response); bytes += body.bytes;
            const items = ['status','pull-list'].includes(job.kind) ? body.value : listKeys[job.kind] ? body.value[listKeys[job.kind]] : [body.value];
            if (!Array.isArray(items) || items.length > PAGE_SIZE) throw failure('invalid_response');
            const context = {...this.#configuration, ...job.context};
            let records; try { records = items.map(item => projectGitHubMetadata(job.kind,item,context)); } catch { throw failure('invalid_metadata'); }
            const totalCount = listKeys[job.kind] ? body.value.total_count : null;
            if (totalCount !== null && (!Number.isSafeInteger(totalCount) || totalCount < 0)) throw failure('invalid_response');
            page = {records, next:this.#next(response.headers.get('link'),job), totalCount};
          }
          const nextState = structuredClone(state); nextState.queue.shift(); nextState.failures = 0; nextState.retryAt = 0;
          this.#expand(nextState,job,page.records,page.next);
          if (page.totalCount !== null && page.totalCount > (job.page - 1) * PAGE_SIZE + page.records.length && !page.next) nextState.cyclePartial = true;
          nextState.due = Math.max(nextState.due,deadline(response.headers.get('x-poll-interval'),received));
          const exhausted = response.headers.get('x-ratelimit-remaining') === '0';
          if (exhausted) nextState.retryAt = this.#retry(response,state,received);
          nextState.state = nextState.queue.length ? exhausted ? 'rate_limited' : 'collecting' : nextState.cyclePartial ? 'partial' : 'current';
          nextState.reason = nextState.cyclePartial ? 'collection_bound' : exhausted ? 'rate_limit' : null;
          if (!nextState.queue.length) { nextState.due = Math.max(nextState.due,received + this.#configuration.intervalMs); nextState.completedAt = received; }
          const serialized = JSON.stringify(page), etag = response.headers.get('etag');
          const observation = {schemaVersion:1, sourceId:this.#configuration.sourceId, repositoryId:this.#configuration.repositoryId, apiOrigin:API, apiVersion:GITHUB_API_VERSION, endpoint:job.endpoint, cycle:state.cycle, context:job.context, observedAt:new Date(received).toISOString(), httpStatus:response.status, metadataSha256:hash(serialized), metadata:response.status === 304 ? null : page, priorObservedAt:response.status === 304 ? new Date(cache.observed_ms).toISOString() : null};
          const observationText = JSON.stringify(observation);
          nextState.capturedBytes += Buffer.byteLength(observationText); nextState.capturedPages++;
          // Captured page, conditional-cache state and queue advancement commit together.
          this.#db.exec('BEGIN IMMEDIATE');
          try {
            if (!this.#owned()) throw failure('lease_lost');
            requireStorageReserve(this.#file,this.#storage);
            this.#db.prepare('INSERT INTO observations(cycle,endpoint,observed_ms,payload) VALUES(?,?,?,?)').run(state.cycle,job.endpoint,received,observationText);
            this.#db.prepare('INSERT INTO pages VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET etag=excluded.etag,payload=excluded.payload,observed_ms=excluded.observed_ms,verified_ms=excluded.verified_ms').run(job.endpoint,etag && /^[\x20-\x7e]{1,256}$/.test(etag) ? etag : response.status === 304 ? cache.etag : null,serialized,response.status === 304 ? cache.observed_ms : received,received);
            this.#save(nextState); this.#db.exec('COMMIT'); state = nextState;
          } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
        } catch (error) {
          await response?.body?.cancel().catch(() => {});
          state.state = 'unavailable'; state.reason = error?.code === 'STORAGE_BACKPRESSURE' ? 'storage_pressure' : error?.reason || 'transport_or_storage_error';
          state.retryAt = this.#now() + Math.min(3600000,60000 * 2 ** Math.min(state.failures,6)); state.failures++;
          if(this.#owned())this.#save(state); break;
        }
      }
      return {state:state.state, requests, responseBytes:bytes, elapsedMs:performance.now()-started};
    } finally {
      try { this.#db.prepare('DELETE FROM lease WHERE id=1 AND owner=?').run(this.#owner); }
      finally { this.#busy = false; }
    }
  }
  read({viewer, hosts, after = 0, limit = 50, epoch} = {}) {
    if (!githubScopeAllowed(this.#configuration,viewer,hosts,this.#now())) throw Object.assign(new Error('GitHub source not permitted'),{status:403});
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error('Invalid GitHub cursor'),{status:400});
    if(epoch !== undefined && (typeof epoch !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(epoch)))throw Object.assign(new Error('Invalid GitHub epoch'),{status:400});
    const currentEpoch = this.#db.prepare('SELECT epoch FROM journal WHERE id=1').get().epoch;
    const latest = this.#db.prepare('SELECT sequence FROM observations ORDER BY sequence DESC LIMIT 1').get()?.sequence || 0;
    const gap = epoch && epoch !== currentEpoch ? {reason:'journal_changed'} : after > latest ? {reason:'cursor_ahead'} : null;
    if(gap)after=0;
    const state = this.#state(), rows = this.#db.prepare('SELECT sequence,payload FROM observations WHERE sequence>? ORDER BY sequence LIMIT ?').all(after,limit+1), observations = [];
    let bytes = 0;
    for (const row of rows.slice(0,limit)) { const size = Buffer.byteLength(row.payload); if (observations.length && bytes + size > 262144) break; bytes += size; observations.push({sequence:row.sequence,...JSON.parse(row.payload)}); }
    const stale = !state.completedAt || this.#now() > state.completedAt + this.#configuration.intervalMs * 2;
    return {epoch:currentEpoch, gap, sourceId:this.#configuration.sourceId, repository:this.#configuration.repository, repositoryId:this.#configuration.repositoryId, hostId:this.#configuration.hostId, project:this.#configuration.project, state:state.state === 'current' ? stale ? 'stale' : this.#configuration.collectChecks===false ? 'partial' : 'current' : state.state, stale, reason:state.reason || (this.#configuration.collectChecks===false ? 'checks_not_configured' : null), completedAt:state.completedAt ? new Date(state.completedAt).toISOString() : null, retryAt:state.retryAt || null, pendingRequests:state.queue.length, coverage:{checks:this.#configuration.collectChecks===false?'disabled':'enabled',explicitPullNumbers:this.#configuration.pullNumbers,discoverPulls:!!this.#configuration.discoverPulls,branch:this.#configuration.branch||null,completeRepositoryHistory:false, forkChecks:'base_repository_only', paginationAtomic:false, maxPagesPerEndpoint:MAX_PAGES}, archive:{...githubArchiveStatus(this.#db),capturedBytes:state.capturedBytes,admissionBytes:this.#storage.sourceBytes}, observations, nextCursor:observations.at(-1)?.sequence ?? after, caughtUp:rows.length === observations.length};
  }
  snapshot(options={}) {
    const base=this.read({...options,limit:1}),state=this.#state();
    const pages=this.#db.prepare('SELECT p.payload,p.observed_ms,p.verified_ms FROM pages p JOIN observations o ON o.endpoint=p.endpoint WHERE o.cycle=? ORDER BY o.sequence LIMIT 100').all(state.cycle);
    const records=[],seen=new Set();let truncated=pages.length===100;
    for(const page of pages)for(const record of JSON.parse(page.payload).records){
      const key=record.kind+':'+record.id+':'+(record.headSha||'');if(seen.has(key))continue;
      seen.add(key);if(records.length>=300){truncated=true;continue;}
      records.push({...record,observedAt:new Date(page.observed_ms).toISOString(),verifiedAt:new Date(page.verified_ms).toISOString()});
    }
    const {observations,nextCursor,caughtUp,...status}=base;
    return {...status,records,displayTruncated:truncated,displayLimit:300};
  }
}
