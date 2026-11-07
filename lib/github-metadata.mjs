// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// Deliberately narrow metadata projection. Never persist GitHub response bodies.
export const GITHUB_API_VERSION = '2026-03-10';
const bad = () => { throw new Error('Invalid GitHub metadata'); };
export const integer = value => Number.isSafeInteger(value) && value > 0 ? value : bad();
const nullable = (value, validate) => value === null || value === undefined ? null : validate(value);
const flag = value => typeof value === 'boolean' ? value : bad();
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : bad();
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : bad();
const enumeration = values => value => values.includes(value) ? value : bad();
const status = enumeration(['queued','in_progress','completed','requested','waiting','pending']);
const conclusion = enumeration(['success','failure','neutral','cancelled','skipped','timed_out','action_required','stale','startup_failure']);
const times = (value, keys) => Object.fromEntries(keys.map(key => [key, nullable(value[key], date)]));
const repositoryId = value => nullable(value?.id, integer);
const revision = value => ({repositoryId:repositoryId(value?.repo), sha:nullable(value?.sha, sha)});

export function validateGitHubConfiguration(value) {
  const keys = ['sourceId','hostId','project','repository','repositoryId','pullNumbers','intervalMs','discoverPulls','branch','collectChecks'];
  if (!value || Object.keys(value).some(key => !keys.includes(key))) bad();
  if (!/^[-a-z0-9]{1,64}$/.test(value.sourceId || '') || !/^[-a-z0-9]{1,64}$/.test(value.hostId || '')) bad();
  if (typeof value.project !== 'string' || !value.project || value.project.length > 160 || /[\x00-\x1f\x7f]/.test(value.project)) bad();
  if (typeof value.repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value.repository) || value.repository.split('/')[1] === '..') bad();
  integer(value.repositoryId);
  if (!Array.isArray(value.pullNumbers) || value.pullNumbers.length > 16 || new Set(value.pullNumbers).size !== value.pullNumbers.length) bad();
  value.pullNumbers.forEach(integer);
  if (value.discoverPulls !== undefined && typeof value.discoverPulls !== 'boolean') bad();
  if (value.collectChecks !== undefined && typeof value.collectChecks !== 'boolean') bad();
  if (value.branch !== undefined && (typeof value.branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value.branch) || value.branch.includes('..') || value.branch.includes('//'))) bad();
  const intervalMs = value.intervalMs ?? 300000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60000 || intervalMs > 86400000) bad();
  return Object.freeze({...value, pullNumbers:Object.freeze([...value.pullNumbers]), intervalMs});
}

export function projectGitHubMetadata(kind, value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad();
  const id = kind === 'branch' ? integer(context.repositoryId) : integer(value.id), common = {kind, id, repositoryId:context.repositoryId};
  if (kind === 'repository') {
    if (id !== context.repositoryId || typeof value.full_name !== 'string' || value.full_name.toLowerCase() !== context.repository.toLowerCase()) bad();
    return {...common, fullName:value.full_name, private:flag(value.private), archived:flag(value.archived), disabled:nullable(value.disabled, flag), ...times(value,['created_at','updated_at','pushed_at'])};
  }
  if (kind === 'pull') {
    if (integer(value.number) !== context.pullNumber || repositoryId(value.base?.repo) !== context.repositoryId) bad();
    return {...common, number:value.number, state:enumeration(['open','closed'])(value.state), draft:nullable(value.draft,flag), merged:nullable(value.merged,flag), base:revision(value.base), head:revision(value.head), mergeCommitSha:nullable(value.merge_commit_sha,sha), ...times(value,['created_at','updated_at','closed_at','merged_at'])};
  }
  if (kind === 'pull-list') {
    if (repositoryId(value.base?.repo) !== context.repositoryId) bad();
    return {...common, number:integer(value.number), state:enumeration(['open','closed'])(value.state), draft:nullable(value.draft,flag), base:revision(value.base), head:revision(value.head), ...times(value,['created_at','updated_at','closed_at','merged_at'])};
  }
  if (kind === 'branch') {
    if (value.name !== context.branch) bad();
    return {...common, id:context.repositoryId, name:context.branch, headSha:sha(value.commit?.sha), protected:flag(value.protected)};
  }
  if (kind === 'check') {
    if (sha(value.head_sha) !== context.headSha) bad();
    return {...common, headSha:value.head_sha, suiteId:nullable(value.check_suite?.id,integer), appId:nullable(value.app?.id,integer), status:status(value.status), conclusion:nullable(value.conclusion,conclusion), ...times(value,['started_at','completed_at'])};
  }
  if (kind === 'status') return {...common, headSha:context.headSha, state:enumeration(['error','failure','pending','success'])(value.state), ...times(value,['created_at','updated_at'])};
  if (kind === 'run') {
    if (repositoryId(value.repository) !== context.repositoryId || (context.headSha && sha(value.head_sha) !== context.headSha)) bad();
    return {...common, headSha:value.head_sha, headRepositoryId:repositoryId(value.head_repository), workflowId:integer(value.workflow_id), runNumber:integer(value.run_number), attempt:integer(value.run_attempt), status:status(value.status), conclusion:nullable(value.conclusion,conclusion), ...times(value,['created_at','updated_at','run_started_at'])};
  }
  if (kind === 'artifact') {
    if (value.workflow_run && (integer(value.workflow_run.id) !== context.runId || sha(value.workflow_run.head_sha) !== context.headSha)) bad();
    const bytes = value.size_in_bytes;
    if (!Number.isSafeInteger(bytes) || bytes < 0) bad();
    const digest = nullable(value.digest, v => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v) ? v : bad());
    return {...common, runId:context.runId, observedRunAttempt:context.runAttempt, headSha:context.headSha, sizeBytes:bytes, digest, expired:flag(value.expired), ...times(value,['created_at','updated_at','expires_at'])};
  }
  bad();
}

export function githubScopeAllowed(configuration, viewer, hosts, now = Date.now()) {
  return !!viewer && (viewer.hostIds === null || viewer.hostIds?.includes(configuration.hostId)) &&
    (viewer.projectIds === null || viewer.projectIds?.includes(configuration.project)) &&
    !!hosts?.some(host => host.id === configuration.hostId && !host.disabled && (!host.expiresAt || Date.parse(host.expiresAt) > now));
}
