// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {DatabaseSync} from 'node:sqlite';

const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !Object.hasOwn(Object.prototype, value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const clone = value => JSON.parse(JSON.stringify(value));
const fail = code => Object.assign(new Error(code), {code});
const requireValue = (condition, code = 'INVALID_INPUT') => { if (!condition) throw fail(code); };
const total = usage => usage.inputTokens + usage.outputTokens;
const localOperations = new Set(['write-receipt', 'reconcile-usage', 'cancel-reservation']);
export const SPENDING_CAPABILITY = Object.freeze({
  module: 'ATOMIC_LOCAL_ADMISSION_AND_ACCOUNTING',
  applicationRuntimeIntegration: 'NOT_INTEGRATED',
  nativeCodexTurns: 'UNSUPPORTED',
  externalProviderCalls: 'UNSUPPORTED',
  accountSpendingGuarantee: false,
  modelStepInterruption: false
});

function manifestValue(value) {
  requireValue(value && id(value.familyId) && id(value.taskId));
  requireValue(value.ownerAuthority && id(value.ownerAuthority.id) && text(value.ownerAuthority.statement));
  requireValue(text(value.scope) && text(value.definitionOfDone));
  for (const key of ['admittedAtMs', 'deadlineMs', 'closeoutTokens', 'closeoutReserveMs',
    'telemetryMaxAgeMs', 'reservationTtlMs', 'maxAttempts']) requireValue(integer(value[key]));
  const advisory = value.mode === 'advisory';
  requireValue(value.mode === undefined || advisory);
  requireValue(integer(value.tokenBudget) || advisory && value.tokenBudget === null);
  requireValue(value.tokenBudget === null ? value.closeoutTokens === 0 : value.tokenBudget > value.closeoutTokens);
  requireValue(value.deadlineMs > value.admittedAtMs);
  if (advisory) {
    requireValue(typeof value.accountKey === 'string' && /^[a-f0-9]{64}$/.test(value.accountKey));
    requireValue(value.binding && ['hostIds', 'threadIds'].every(key => Array.isArray(value.binding[key]) &&
      value.binding[key].length > 0 && value.binding[key].length <= 64 &&
      new Set(value.binding[key]).size === value.binding[key].length &&
      value.binding[key].every(item => text(item) && item.length <= 256)));
    requireValue(value.weeklySelection && id(value.weeklySelection.limitId) && ['primary', 'secondary'].includes(value.weeklySelection.slot));
  }
  requireValue(value.closeoutReserveMs > 0 && value.closeoutReserveMs < value.deadlineMs - value.admittedAtMs);
  requireValue(value.telemetryMaxAgeMs > 0 && value.reservationTtlMs > 0 && value.maxAttempts >= 1 && value.maxAttempts <= 3);
  requireValue(value.weeklyBaseline && Number.isFinite(value.weeklyBaseline.usedPercent) &&
    value.weeklyBaseline.usedPercent >= 0 && value.weeklyBaseline.usedPercent <= 100 &&
    integer(value.weeklyBaseline.resetAt) && value.weeklyBaseline.resetAt > 0);
  requireValue(Number.isFinite(value.weeklyPointBudget) && value.weeklyPointBudget > 0 &&
    value.weeklyBaseline.usedPercent + value.weeklyPointBudget <= 100);
  requireValue(Number.isFinite(value.closeoutWeeklyPoints) && value.closeoutWeeklyPoints >= 0 &&
    value.closeoutWeeklyPoints < value.weeklyPointBudget);
  requireValue(value.requested && text(value.requested.model) && text(value.requested.reasoning) &&
    text(value.requested.tier) && typeof value.requested.fast === 'boolean');
  requireValue(value.observed && ['model', 'reasoning', 'tier', 'fast'].every(key =>
    value.observed[key] === null || (key === 'fast' ? typeof value.observed[key] === 'boolean' : text(value.observed[key]))));
  requireValue(value.previousFamilyId === undefined || id(value.previousFamilyId));
  // Persist a whitelist; never accept an invented enforcement claim or request payload.
  const result = clone(Object.fromEntries(['familyId', 'taskId', 'ownerAuthority', 'scope', 'definitionOfDone',
    'admittedAtMs', 'deadlineMs', 'tokenBudget', 'closeoutTokens', 'closeoutReserveMs', 'telemetryMaxAgeMs',
    'reservationTtlMs', 'maxAttempts', 'weeklyBaseline', 'weeklyPointBudget', 'closeoutWeeklyPoints',
    'requested', 'observed', 'previousFamilyId'].filter(key => value[key] !== undefined).map(key => [key, value[key]])));
  result.ownerAuthority = {id: value.ownerAuthority.id, statement: value.ownerAuthority.statement};
  result.weeklyBaseline = {usedPercent: value.weeklyBaseline.usedPercent, resetAt: value.weeklyBaseline.resetAt};
  result.requested = Object.fromEntries(['model', 'reasoning', 'tier', 'fast'].map(key => [key, value.requested[key]]));
  result.observed = Object.fromEntries(['model', 'reasoning', 'tier', 'fast'].map(key => [key, value.observed[key]]));
  if (advisory) {
    result.mode = 'advisory'; result.accountKey = value.accountKey;
    result.binding = {hostIds: [...value.binding.hostIds], threadIds: [...value.binding.threadIds]};
    result.weeklySelection = {limitId: value.weeklySelection.limitId, slot: value.weeklySelection.slot};
  }
  return result;
}

/**
 * Trusted local caller boundary. No model, process, HTTP, provider or native dispatch.
 * Use a separate local SQLite file; never open a live database over SMB/NFS.
 */
export class SpendingLedger {
  constructor(file, {clock = Date.now} = {}) {
    requireValue(typeof file === 'string' && file.length > 0 && typeof clock === 'function');
    this.clock = clock;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spending_families(id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS spending_authority ON spending_families(json_extract(state,'$.manifest.ownerAuthority.id'));
      CREATE TABLE IF NOT EXISTS spending_receipts(
        sequence INTEGER PRIMARY KEY, family_id TEXT NOT NULL, at_ms INTEGER NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL);
    `);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return clone(result); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  append(familyId, at, kind, payload) {
    this.db.prepare('INSERT INTO spending_receipts(family_id,at_ms,kind,payload) VALUES(?,?,?,?)')
      .run(familyId, at, kind, JSON.stringify(payload));
  }
  latch(state, reason) {
    if (!state.stop) state.stop = {reason, atMs: state.lastClockMs};
  }
  maintain(state, now) {
    requireValue(integer(now), 'INVALID_CLOCK');
    if (now < state.lastClockMs) this.latch(state, 'CLOCK_ROLLBACK');
    state.lastClockMs = Math.max(now, state.lastClockMs);
    if (now >= state.manifest.deadlineMs) this.latch(state, 'DEADLINE');
    if (now >= state.manifest.weeklyBaseline.resetAt * 1000) this.latch(state, 'TELEMETRY_WINDOW_ENDED');
    for (const reservation of Object.values(state.reservations)) {
      if (reservation.state === 'reserved' && now >= reservation.expiresAtMs) reservation.state = 'expired';
      if (reservation.state === 'started' && now >= reservation.expiresAtMs) {
        reservation.unknown = true;
        this.latch(state, 'STARTED_RESERVATION_EXPIRED');
      }
    }
    if (!state.telemetry || now < state.telemetry.observedAtMs ||
      now - state.telemetry.observedAtMs > state.manifest.telemetryMaxAgeMs) this.latch(state, 'TELEMETRY_STALE_OR_UNKNOWN');
  }
  mutate(familyId, kind, fn) {
    requireValue(id(familyId), 'INVALID_IDENTITY');
    const envelope = this.transaction(() => {
      const row = this.db.prepare('SELECT state FROM spending_families WHERE id=?').get(familyId);
      requireValue(row, 'INVALID_IDENTITY');
      let state = JSON.parse(row.state);
      const now = this.clock();
      this.maintain(state, now);
      const maintained = clone(state);
      let result, errorCode = null;
      try { result = fn(state, now); }
      catch (error) { state = maintained; errorCode = error.code ?? 'OPERATION_FAILED'; result = {error: errorCode}; }
      this.db.prepare('UPDATE spending_families SET state=? WHERE id=?').run(JSON.stringify(state), familyId);
      this.append(familyId, state.lastClockMs, kind, {result, stop: state.stop});
      return {result, errorCode};
    });
    if (envelope.errorCode) throw fail(envelope.errorCode);
    return envelope.result;
  }
  createFamily(value, telemetry) {
    const manifest = manifestValue(value);
    return this.transaction(() => {
      requireValue(!this.db.prepare('SELECT id FROM spending_families WHERE id=?').get(manifest.familyId), 'FAMILY_EXISTS');
      requireValue(!this.db.prepare("SELECT id FROM spending_families WHERE json_extract(state,'$.manifest.ownerAuthority.id')=?").get(manifest.ownerAuthority.id), 'NEW_AUTHORITY_REQUIRED');
      const sameTask = this.db.prepare("SELECT id FROM spending_families WHERE json_extract(state,'$.manifest.taskId')=?").all(manifest.taskId);
      requireValue(sameTask.length === 0 || sameTask.some(row => row.id === manifest.previousFamilyId), 'PREDECESSOR_REQUIRED');
      const now = this.clock();
      requireValue(integer(now) && manifest.admittedAtMs <= now && now < manifest.deadlineMs);
      if (manifest.previousFamilyId) {
        const previous = this.db.prepare('SELECT state FROM spending_families WHERE id=?').get(manifest.previousFamilyId);
        requireValue(previous, 'INVALID_PREDECESSOR');
        const old = JSON.parse(previous.state);
        requireValue(old.manifest.ownerAuthority.id !== manifest.ownerAuthority.id, 'NEW_AUTHORITY_REQUIRED');
      }
      const state = {manifest, lastClockMs: now, telemetry: null, stop: null, tasks: {
        [manifest.taskId]: {taskId: manifest.taskId, parentId: null, tokenBudget: manifest.tokenBudget, deadlineMs: manifest.deadlineMs}
      }, reservations: {}, usage: {}, deniedActions: {}, attempts: {}};
      this.applyTelemetry(state, telemetry, now);
      this.maintain(state, now);
      this.db.prepare('INSERT INTO spending_families(id,state) VALUES(?,?)').run(manifest.familyId, JSON.stringify(state));
      this.append(manifest.familyId, now, 'admission-manifest', {manifest, capability: SPENDING_CAPABILITY, stop: state.stop});
      return this.project(state);
    });
  }
  applyTelemetry(state, telemetry, now) {
    const valid = telemetry && integer(telemetry.observedAtMs) && telemetry.observedAtMs <= now &&
      now - telemetry.observedAtMs <= state.manifest.telemetryMaxAgeMs &&
      Number.isFinite(telemetry.usedPercent) && telemetry.usedPercent >= 0 && telemetry.usedPercent <= 100 &&
      integer(telemetry.resetAt) && telemetry.resetAt > 0;
    if (!valid) { this.latch(state, 'TELEMETRY_STALE_OR_UNKNOWN'); return; }
    const before = state.telemetry ?? state.manifest.weeklyBaseline;
    if (telemetry.resetAt !== state.manifest.weeklyBaseline.resetAt || telemetry.usedPercent < before.usedPercent ||
      state.telemetry && telemetry.observedAtMs < state.telemetry.observedAtMs) {
      this.latch(state, 'TELEMETRY_RESET_OR_REPLENISHMENT'); return;
    }
    state.telemetry = {observedAtMs: telemetry.observedAtMs, usedPercent: telemetry.usedPercent, resetAt: telemetry.resetAt};
    if (telemetry.usedPercent - state.manifest.weeklyBaseline.usedPercent >= state.manifest.weeklyPointBudget)
      this.latch(state, 'WEEKLY_LIMIT');
  }
  observe(familyId, telemetry) {
    // Fresh telemetry may restore knowledge, but can never clear an existing stop.
    return this.mutate(familyId, 'telemetry', (state, now) => {
      this.applyTelemetry(state, telemetry, now); return this.project(state);
    });
  }
  registerTask(familyId, task) {
    return this.mutate(familyId, 'task-record', state => {
      requireValue(!state.stop, 'FAMILY_STOPPED');
      requireValue(task && id(task.taskId) && id(task.parentId) && !state.tasks[task.taskId], 'INVALID_IDENTITY');
      const parent = state.tasks[task.parentId];
      requireValue(parent && integer(task.tokenBudget) && task.tokenBudget <= parent.tokenBudget &&
        integer(task.deadlineMs) && task.deadlineMs <= parent.deadlineMs &&
        task.deadlineMs > state.lastClockMs, 'INHERITED_BOUND');
      state.tasks[task.taskId] = {taskId: task.taskId, parentId: task.parentId,
        tokenBudget: task.tokenBudget, deadlineMs: task.deadlineMs};
      return {registered: task.taskId, dispatch: 'NONE'};
    });
  }
  lineage(state, taskId) {
    const result = [];
    for (let task = state.tasks[taskId]; task; task = state.tasks[task.parentId]) result.push(task.taskId);
    return result;
  }
  amounts(state, taskId = null) {
    const belongs = item => taskId === null || this.lineage(state, item.taskId).includes(taskId);
    const records = [...Object.values(state.usage), ...Object.values(state.observedUsage ?? {})].filter(belongs);
    const spent = records.reduce((sum, item) => sum + (item.inputTokens === null || item.outputTokens === null ? 0 : total(item)), 0);
    const reserved = Object.values(state.reservations).filter(item => belongs(item) && ['reserved', 'started'].includes(item.state))
      .reduce((sum, item) => sum + item.estimatedTokens, 0);
    return {spent: integer(spent) ? spent : null, reserved: integer(reserved) ? reserved : null, unknown: !integer(spent) || !integer(reserved) || records.some(item => item.inputTokens === null || item.outputTokens === null) ||
      Object.values(state.reservations).some(item => belongs(item) && item.unknown === true)};
  }
  deny(state, actionId, reason) {
    if (id(actionId) && !state.deniedActions[actionId]) state.deniedActions[actionId] = {reason, atMs: state.lastClockMs};
    return {allowed: false, reason, stopped: state.stop !== null};
  }
  reserve(familyId, request) {
    return this.mutate(familyId, 'request-admission', (state, now) => {
      if (!request || !id(request.taskId) || !id(request.actionId) || !id(request.reservationId) ||
        !state.tasks[request.taskId]) return this.deny(state, request?.actionId, 'INVALID_IDENTITY');
      const {taskId, actionId, reservationId, estimatedTokens, kind = 'request', operation} = request;
      if (state.deniedActions[actionId]) return {allowed: false, reason: 'ACTION_DENIAL_LATCHED', stopped: state.stop !== null};
      if (kind === 'closeout') {
        if (estimatedTokens !== 0 || !localOperations.has(operation)) return this.deny(state, actionId, 'INVALID_CLOSEOUT');
        return {allowed: true, localOnly: true, operation, dispatch: 'NONE'};
      }
      if (!['request', 'monitor'].includes(kind) || !integer(estimatedTokens) || estimatedTokens < 1)
        return this.deny(state, actionId, 'INVALID_REQUEST');
      if (state.manifest.mode === 'advisory') return this.deny(state, actionId, 'ADVISORY_ONLY_NO_DISPATCH');
      if (state.stop) return this.deny(state, actionId, 'FAMILY_STOPPED');
      if (Object.hasOwn(state.reservations, reservationId)) return this.deny(state, actionId, 'RESERVATION_ID_REUSED');
      if ((state.attempts[actionId] ?? 0) >= state.manifest.maxAttempts) return this.deny(state, actionId, 'RETRY_LIMIT');
      if (Object.values(state.reservations).some(item => item.actionId === actionId && ['reserved', 'started'].includes(item.state)))
        return this.deny(state, actionId, 'ACTION_IN_FLIGHT');
      if (now >= state.manifest.deadlineMs - state.manifest.closeoutReserveMs)
        return this.deny(state, actionId, 'CLOSEOUT_TIME_RESERVED');
      if (state.telemetry.usedPercent - state.manifest.weeklyBaseline.usedPercent >=
        state.manifest.weeklyPointBudget - state.manifest.closeoutWeeklyPoints)
        return this.deny(state, actionId, 'CLOSEOUT_WEEKLY_RESERVED');
      for (const ancestorId of this.lineage(state, taskId)) {
        const ancestor = state.tasks[ancestorId], usage = this.amounts(state, ancestorId);
        const reserve = ancestor.parentId === null ? state.manifest.closeoutTokens : 0;
        if (now >= ancestor.deadlineMs) return this.deny(state, actionId, 'TASK_DEADLINE');
        if (usage.unknown || usage.spent + usage.reserved + estimatedTokens > ancestor.tokenBudget - reserve)
          return this.deny(state, actionId, 'INSUFFICIENT_BUDGET_OR_RESERVE');
      }
      state.attempts[actionId] = (state.attempts[actionId] ?? 0) + 1;
      state.reservations[reservationId] = {reservationId, taskId, actionId, kind, estimatedTokens,
        state: 'reserved', expiresAtMs: Math.min(now + state.manifest.reservationTtlMs, state.manifest.deadlineMs),
        unknown: false};
      return {allowed: true, reservationId, attempt: state.attempts[actionId], expiresAtMs: state.reservations[reservationId].expiresAtMs};
    });
  }
  markStarted(familyId, reservationId) {
    requireValue(id(reservationId), 'INVALID_RESERVATION');
    return this.mutate(familyId, 'caller-start-record', (state, now) => {
      const item = state.reservations[reservationId];
      requireValue(item && item.state === 'reserved', 'INVALID_RESERVATION');
      if (state.stop || state.deniedActions[item.actionId]) return {allowed: false, reason: 'FAMILY_OR_ACTION_STOPPED'};
      if (now >= state.manifest.deadlineMs - state.manifest.closeoutReserveMs ||
        state.telemetry.usedPercent - state.manifest.weeklyBaseline.usedPercent >= state.manifest.weeklyPointBudget - state.manifest.closeoutWeeklyPoints ||
        this.lineage(state, item.taskId).some(taskId => now >= state.tasks[taskId].deadlineMs))
        return this.deny(state, item.actionId, 'START_BOUND_EXCEEDED');
      item.state = 'started';
      return {allowed: true, reservationId, integration: 'CALLER_RECORDED_ONLY'};
    });
  }
  cancel(familyId, reservationId) {
    requireValue(id(reservationId), 'INVALID_RESERVATION');
    return this.mutate(familyId, 'cancellation', state => {
      const item = state.reservations[reservationId];
      requireValue(item, 'INVALID_RESERVATION');
      if (item.state === 'reserved') item.state = 'cancelled';
      else if (item.state === 'started') {
        item.cancelRequested = true; item.unknown = true; this.latch(state, 'CANCELLATION_UNCONFIRMED');
      }
      return {reservationId, state: item.state, cancellationConfirmed: item.state === 'cancelled', ...this.amounts(state)};
    });
  }
  recordUsage(familyId, receipt) {
    return this.mutate(familyId, 'usage', state => {
      requireValue(receipt && id(receipt.responseId) && id(receipt.receiptId) && id(receipt.reservationId), 'INVALID_USAGE_IDENTITY');
      const reservation = state.reservations[receipt.reservationId];
      requireValue(reservation, 'INVALID_RESERVATION');
      for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens'])
        requireValue(receipt[key] === null || integer(receipt[key]), 'INVALID_USAGE');
      requireValue(receipt.cachedInputTokens === null || receipt.inputTokens !== null && receipt.cachedInputTokens <= receipt.inputTokens, 'INVALID_USAGE');
      requireValue(receipt.reasoningOutputTokens === null || receipt.outputTokens !== null && receipt.reasoningOutputTokens <= receipt.outputTokens, 'INVALID_USAGE');
      requireValue(receipt.inputTokens === null || receipt.outputTokens === null || integer(total(receipt)), 'INVALID_USAGE');
      const normalized = {responseId: receipt.responseId, receiptId: receipt.receiptId, reservationId: receipt.reservationId,
        taskId: reservation.taskId, inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens,
        cachedInputTokens: receipt.cachedInputTokens, reasoningOutputTokens: receipt.reasoningOutputTokens};
      const existing = state.usage[receipt.responseId];
      const same = existing && ['reservationId', 'taskId', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens']
        .every(key => existing[key] === normalized[key]);
      if (existing) {
        if (!same) this.latch(state, 'USAGE_CONFLICT');
        return {recorded: false, duplicate: same, reason: same ? 'DUPLICATE_RESPONSE' : 'USAGE_CONFLICT'};
      }
      if (Object.values(state.usage).some(item => item.receiptId === receipt.receiptId || item.reservationId === receipt.reservationId)) {
        this.latch(state, 'USAGE_IDENTITY_CONFLICT'); return {recorded: false, reason: 'USAGE_IDENTITY_CONFLICT'};
      }
      state.usage[receipt.responseId] = normalized;
      if (receipt.inputTokens === null || receipt.outputTokens === null) {
        reservation.unknown = true; this.latch(state, 'USAGE_UNKNOWN');
      } else {
        reservation.state = 'settled'; reservation.unknown = false;
        if (total(receipt) > reservation.estimatedTokens) this.latch(state, 'RESERVATION_OVERRUN');
        for (const ancestorId of this.lineage(state, reservation.taskId)) {
          const amounts = this.amounts(state, ancestorId);
          if (amounts.unknown) this.latch(state, 'ACCOUNTING_UNKNOWN');
          if (amounts.spent >= state.tasks[ancestorId].tokenBudget) this.latch(state, 'TOKEN_LIMIT');
        }
      }
      return {recorded: true, ...this.amounts(state), stop: state.stop};
    });
  }
  advisoryContext(familyId) {
    requireValue(id(familyId), 'INVALID_IDENTITY');
    const row = this.db.prepare('SELECT state FROM spending_families WHERE id=?').get(familyId);
    requireValue(row, 'INVALID_IDENTITY');
    const state = JSON.parse(row.state);
    requireValue(state.manifest.mode === 'advisory', 'ADVISORY_FAMILY_REQUIRED');
    return clone({manifest: state.manifest, cursor: state.advisoryCursor ?? null,
      importSummary: state.importSummary ?? {accepted: 0, duplicates: 0, excluded: 0},
      observedRecords: Object.keys(state.observedUsage ?? {}).length});
  }
  recordObservedUsage(familyId, receipt) {
    return this.mutate(familyId, 'external-observed-usage', state => {
      requireValue(state.manifest.mode === 'advisory', 'ADVISORY_FAMILY_REQUIRED');
      requireValue(receipt && id(receipt.responseId) && id(receipt.receiptId), 'INVALID_USAGE_IDENTITY');
      for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens'])
        requireValue(receipt[key] === null || integer(receipt[key]), 'INVALID_USAGE');
      requireValue(receipt.inputTokens === null || receipt.outputTokens === null || integer(total(receipt)), 'INVALID_USAGE');
      requireValue(receipt.cachedInputTokens === null || receipt.inputTokens !== null && receipt.cachedInputTokens <= receipt.inputTokens, 'INVALID_USAGE');
      requireValue(receipt.reasoningOutputTokens === null || receipt.outputTokens !== null && receipt.reasoningOutputTokens <= receipt.outputTokens, 'INVALID_USAGE');
      const p = receipt.provenance;
      requireValue(p && p.accountKey === state.manifest.accountKey &&
        state.manifest.binding.hostIds.includes(p.hostId) && state.manifest.binding.threadIds.includes(p.threadId) &&
        ['PROVIDER_ACCOUNT', 'OWNER_BOUND_THREAD'].includes(p.accountBinding) &&
        ['sampleKey', 'recordKey'].every(key => typeof p[key] === 'string' && /^[a-f0-9]{64}$/.test(p[key])) &&
        (p.sourceId === null || typeof p.sourceId === 'string' && /^[a-f0-9]{64}$/.test(p.sourceId)) &&
        (p.sourceTimeMs === null || integer(p.sourceTimeMs)) && integer(p.receivedMs), 'INVALID_USAGE_PROVENANCE');
      const normalized = {responseId: receipt.responseId, receiptId: receipt.receiptId,
        taskId: state.manifest.taskId, inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens,
        cachedInputTokens: receipt.cachedInputTokens, reasoningOutputTokens: receipt.reasoningOutputTokens,
        provenance: Object.fromEntries(['accountKey', 'hostId', 'threadId', 'accountBinding', 'sampleKey', 'recordKey',
          'sourceId', 'sourceTimeMs', 'receivedMs'].map(key => [key, p[key]]))};
      state.observedUsage ??= {};
      const old = state.observedUsage[receipt.responseId];
      if (old) {
        const same = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens'].every(key => old[key] === normalized[key]);
        if (!same) this.latch(state, 'OBSERVED_USAGE_CONFLICT');
        return {recorded: false, duplicate: same, observation: normalized};
      }
      if (Object.values(state.observedUsage).some(item => item.receiptId === receipt.receiptId)) {
        this.latch(state, 'OBSERVED_IDENTITY_CONFLICT'); return {recorded: false, duplicate: false, observation: normalized};
      }
      state.observedUsage[receipt.responseId] = normalized;
      const amounts = this.amounts(state);
      if (amounts.unknown) this.latch(state, 'OBSERVED_USAGE_UNKNOWN');
      if (state.manifest.tokenBudget !== null && amounts.spent >= state.manifest.tokenBudget) this.latch(state, 'TOKEN_LIMIT');
      return {recorded: true, observation: normalized};
    });
  }
  advisoryCheckpoint(familyId, cursor, summary) {
    return this.mutate(familyId, 'advisory-import-cursor', state => {
      requireValue(state.manifest.mode === 'advisory', 'ADVISORY_FAMILY_REQUIRED');
      requireValue(cursor && text(cursor.generation) && integer(cursor.sequence) &&
        (cursor.sampleKey === '' || /^[a-f0-9]{64}$/.test(cursor.sampleKey)), 'INVALID_IMPORT_CURSOR');
      const old = state.advisoryCursor;
      if (old && (old.generation !== cursor.generation || cursor.sequence < old.sequence ||
        cursor.sequence === old.sequence && cursor.sampleKey !== old.sampleKey)) {
        this.latch(state, 'USAGE_SOURCE_CHANGED'); return {saved: false};
      }
      requireValue(['accepted', 'duplicates', 'excluded'].every(key => integer(summary?.[key])), 'INVALID_IMPORT_SUMMARY');
      state.advisoryCursor = {generation: cursor.generation, sequence: cursor.sequence, sampleKey: cursor.sampleKey};
      const previous = state.importSummary ?? {accepted: 0, duplicates: 0, excluded: 0};
      state.importSummary = Object.fromEntries(Object.keys(previous).map(key => [key, previous[key] + summary[key]]));
      return {saved: true};
    });
  }

  stop(familyId, reason = 'OWNER_STOP') {
    requireValue(id(reason));
    return this.mutate(familyId, 'stop', state => { this.latch(state, reason); return this.project(state); });
  }
  project(state) {
    const amounts = this.amounts(state), manifest = state.manifest;
    return {schemaVersion: 1, familyId: manifest.familyId, taskId: manifest.taskId, ...amounts,
      mode: manifest.mode ?? 'admission', tokenBudget: manifest.tokenBudget,
      remaining: amounts.unknown || manifest.tokenBudget === null ? null : Math.max(0, manifest.tokenBudget - amounts.spent - amounts.reserved),
      closeoutTokens: manifest.closeoutTokens, stopped: state.stop !== null, stop: state.stop,
      weekly: {baseline: manifest.weeklyBaseline.usedPercent, lastObserved: state.telemetry?.usedPercent ?? null,
        pointBudget: manifest.weeklyPointBudget, resetAt: manifest.weeklyBaseline.resetAt},
      deadlineMs: manifest.deadlineMs, capability: SPENDING_CAPABILITY};
  }
  status(familyId) { return this.mutate(familyId, 'status-receipt', state => this.project(state)); }
  receipts(familyId) {
    requireValue(id(familyId), 'INVALID_IDENTITY');
    return this.db.prepare('SELECT sequence,at_ms AS atMs,kind,payload FROM spending_receipts WHERE family_id=? ORDER BY sequence')
      .all(familyId).map(row => ({...row, payload: JSON.parse(row.payload)}));
  }
}
