// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import crypto from 'node:crypto';
import {buildAccountUsageResponse} from './account-usage.mjs';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const admin = {role: 'admin', hostIds: null, projectIds: null};
const fullAdmin = viewer => viewer?.role === 'admin' && viewer.hostIds === null && viewer.projectIds === null;
const denied = (message, status = 403) => Object.assign(new Error(message), {status});
const boundedText = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

/** Bounded SELECT-only access through the existing journal connection seam. */
export function readSpendingUsagePage(journal, {hostIds, threadIds, after, admittedAtMs}) {
  if (!journal || !hostIds.length) return {available: false, rows: [], hasMore: false};
  return journal.database(db => {
    const generation = db.prepare("SELECT value FROM metadata WHERE key='epoch'").get()?.value;
    if (!generation) return {available: false, rows: [], hasMore: false};
    if (after && after.generation !== generation) return {available: true, generation, sourceChanged: true, rows: [], hasMore: false};
    if (after && (!Number.isSafeInteger(after.sequence) || after.sequence < 0))
      return {available: true, generation, sourceChanged: true, rows: [], hasMore: false};
    if (after?.sequence > 0 && db.prepare('SELECT sample_key FROM usage_samples_v2 WHERE rowid=?').get(after.sequence)?.sample_key !== after.sampleKey)
      return {available: true, generation, sourceChanged: true, rows: [], hasMore: false};
    const sequence = after?.sequence ?? 0;
    const rows = db.prepare(`SELECT rowid AS ingestSequence,sample_key,host_id,session_id,source_id,source_record_key,source_ms,received_ms,
      native_thread_id,native_response_id,provider_account_key,usage_scope,accounting_class,
      input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens
      FROM usage_samples_v2 WHERE received_ms>=? AND rowid>? AND
      host_id IN (${hostIds.map(() => '?')}) AND native_thread_id IN (${threadIds.map(() => '?')})
      ORDER BY rowid LIMIT 129`)
      .all(admittedAtMs, sequence, ...hostIds, ...threadIds);
    return {available: true, generation, rows: rows.slice(0, 128), hasMore: rows.length > 128};
  });
}

/** Explicitly injected local adapter. No timers, provider calls, dispatch or automatic family renewal. */
export class SpendingAdvisory {
  constructor({ledger, familyId}) {
    this.ledger = ledger; this.familyId = familyId;
    ledger.advisoryContext(familyId);
  }
  async readStatus({sources = [], viewer, readPage = () => ({available: false, rows: [], hasMore: false})}) {
    if (!fullAdmin(viewer)) throw denied('Unrestricted administrator access required');
    const {manifest, cursor} = this.ledger.advisoryContext(this.familyId);
    const now = this.ledger.clock();
    const bound = sources.filter(source => manifest.binding.hostIds.includes(source.hostId));
    if (bound.some(source => source.accountUsage?.accountKey && source.accountUsage.accountKey !== manifest.accountKey))
      this.ledger.stop(this.familyId, 'ACCOUNT_BINDING_CHANGED');
    const accounts = buildAccountUsageResponse({sources: bound, viewer: admin, now}).accountUsage.accounts;
    const account = accounts.find(value => value.accountKey === manifest.accountKey);
    const limit = account?.limits.find(value => value.limitId === manifest.weeklySelection.limitId);
    const window = limit?.[manifest.weeklySelection.slot];
    const at = Date.parse(account?.limitsObservedAt);
    const telemetry = account?.limitsStatus === 'available' && window?.windowDurationMins === 10080 &&
      Number.isFinite(at) ? {observedAtMs: at, usedPercent: window.usedPercent, resetAt: window.resetsAt} : null;
    this.ledger.observe(this.familyId, telemetry);
    if (account?.ordinaryUsageAllowed === false || limit?.spendControlReached === true)
      this.ledger.stop(this.familyId, 'PROVIDER_USAGE_DISALLOWED');
    const hostIds = manifest.binding.hostIds.filter(value => account?.hostIds.includes(value));
    const page = await readPage({hostIds, threadIds: manifest.binding.threadIds, after: cursor,
      admittedAtMs: manifest.admittedAtMs, now});
    const summary = {accepted: 0, duplicates: 0, excluded: 0};
    if (!page || !Array.isArray(page.rows) || page.rows.length > 128) throw denied('Invalid advisory source page', 503);
    if (page.sourceChanged || cursor && page.generation && page.generation !== cursor.generation)
      this.ledger.stop(this.familyId, 'USAGE_SOURCE_CHANGED');
    else if (page.available) {
      let after = cursor ?? {generation: page.generation, sequence: 0, sampleKey: ''};
      for (const row of page.rows) {
        const sameAccount = row.provider_account_key === manifest.accountKey;
        const ownerBound = row.provider_account_key === null;
        const eligible = hostIds.includes(row.host_id) && manifest.binding.threadIds.includes(row.native_thread_id) &&
          row.accounting_class === 'candidate' && row.usage_scope === 'response' &&
          boundedText(row.native_response_id) && (sameAccount || ownerBound) &&
          (row.source_ms === null || row.source_ms >= manifest.admittedAtMs) &&
          row.received_ms <= now;
        if (row.received_ms > now || row.source_ms !== null && row.source_ms > now)
          this.ledger.stop(this.familyId, 'USAGE_TIME_UNCERTAIN');
        if (!eligible || row.source_ms !== null && row.source_ms > now) summary.excluded++;
        else {
          let result; try { result = this.ledger.recordObservedUsage(this.familyId, {
            receiptId: row.sample_key, responseId: hash([manifest.accountKey, row.native_thread_id, row.native_response_id]),
            inputTokens: row.input_tokens, cachedInputTokens: row.cached_input_tokens,
            outputTokens: row.output_tokens, reasoningOutputTokens: row.reasoning_output_tokens,
            provenance: {accountKey: manifest.accountKey, hostId: row.host_id, threadId: row.native_thread_id,
              accountBinding: sameAccount ? 'PROVIDER_ACCOUNT' : 'OWNER_BOUND_THREAD', sampleKey: row.sample_key,
              recordKey: row.source_record_key, sourceId: row.source_id,
              sourceTimeMs: row.source_ms, receivedMs: row.received_ms}
          }); } catch (error) {
            if (!['INVALID_USAGE', 'INVALID_USAGE_IDENTITY', 'INVALID_USAGE_PROVENANCE'].includes(error.code)) throw error;
            this.ledger.stop(this.familyId, 'OBSERVED_USAGE_INVALID');
            result = {recorded: false, duplicate: false};
          }
          if (result.recorded) summary.accepted++; else if (result.duplicate) summary.duplicates++; else summary.excluded++;
        }
        after = {generation: page.generation, sequence: row.ingestSequence, sampleKey: row.sample_key};
      }
      this.ledger.advisoryCheckpoint(this.familyId, after, summary);
    }
    const current = this.ledger.status(this.familyId), context = this.ledger.advisoryContext(this.familyId);
    const increase = current.weekly.lastObserved === null ? null : current.weekly.lastObserved - current.weekly.baseline;
    const timeReserve = this.ledger.clock() >= manifest.deadlineMs - manifest.closeoutReserveMs;
    const weeklyReserve = increase !== null && increase >= manifest.weeklyPointBudget - manifest.closeoutWeeklyPoints;
    return {schemaVersion: 1, mode: 'ADVISORY', familyId: this.familyId,
      state: current.stopped ? 'STOP_RECOMMENDED' : timeReserve || weeklyReserve ? 'CLOSEOUT_RECOMMENDED' : 'OBSERVING',
      stopped: current.stopped, reason: current.stop?.reason ?? (timeReserve ? 'CLOSEOUT_TIME_RESERVED' : weeklyReserve ? 'CLOSEOUT_WEEKLY_RESERVED' : null),
      nativeDispatchEnforcement: 'UNSUPPORTED', providerAccountSpendingGuarantee: false,
      modelStepInterruption: false, evaluatedAt: new Date(this.ledger.clock()).toISOString(),
      limitsObservedAt: account?.limitsObservedAt ?? null,
      deadlineMs: manifest.deadlineMs, weeklyIncreasePoints: increase,
      weeklyPointBudget: manifest.weeklyPointBudget, weeklyResetAt: current.weekly.resetAt,
      tokenBudget: manifest.tokenBudget, spent: context.observedRecords ? current.spent : null,
      reserved: current.reserved, nativeReserved: null, remaining: current.remaining,
      unknown: true,
      coverage: {complete: false, usageSourceAvailable: !!page.available, backlog: !!page.hasMore,
        observedResponses: context.observedRecords, ...context.importSummary,
        binding: 'Explicit Owner account/host/thread binding; null provider identity remains Owner-declared',
        limitations: 'Only attributable response observations are counted. Cumulative/ambiguous samples are excluded. No complete native dispatch inventory.'}
    };
  }
}
