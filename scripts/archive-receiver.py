#!/usr/bin/env python3
# Author: Bishop Crockett
# Owner: Argellan.com
# License: MIT
# SPDX-License-Identifier: MIT
# Attribution covers ARGELLAN-authored implementation and modifications only.
# Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
"""Private SSH/stdin usage archive. Cold gzip files are authoritative, not an index.

Run the default receive operation as a forced SSH command with a private config.
No listen socket, shell, credentials, caller-selected storage paths or deletion API.
The optional Timescale projection is a separate local, peer-authenticated operation.
"""
import argparse
import contextlib
import importlib.util
import calendar
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
import uuid
import zlib

_WINDOWS_GUARD = None

def windows_guard():
    global _WINDOWS_GUARD
    if os.name != 'nt':
        return None
    if _WINDOWS_GUARD is None:
        spec = importlib.util.spec_from_file_location('archive_windows', Path(__file__).with_name('archive-windows.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _WINDOWS_GUARD = module.WindowsArchiveGuard()
    return _WINDOWS_GUARD

MAX_BYTES = 4 * 1024 * 1024
MAX_RECORDS = 1000
SAFE_INT = 9007199254740991
HEX = re.compile(r"^[0-9a-f]{64}$")
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
ACCOUNT_ISO = re.compile(r"([0-9]{4}|[+-][0-9]{6})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{3})Z")
TABLES = {
    "usage_baselines": ("host_id session_id project provider model source_ms received_ms input_tokens cached_input_tokens output_tokens total_tokens has_delta", "host_id session_id"),
    "usage_observations": ("sequence host_id session_id project provider model source_ms received_ms interval_ms status input_tokens cached_input_tokens output_tokens total_tokens delta_input delta_cached delta_uncached delta_output delta_total", "sequence"),
    "usage_daily": ("host_id session_id segment_key project provider model day input_tokens cached_input_tokens uncached_input_tokens output_tokens total_tokens observations partial_observations overflow first_ms last_ms", "host_id session_id day segment_key"),
    "account_usage_observations": ("sequence host_id sample_key observed_ms limits_ms usage_ms received_ms account_identity payload", "sequence"),
    "account_usage_daily": ("host_id account_identity day tokens observed_ms received_ms", "host_id account_identity day"),
}
TABLES = {k: (v[0].split(), v[1].split()) for k, v in TABLES.items()}
# V1 is a frozen wire contract: adding a source must not broaden its validator.
V1_TABLES = TABLES
V2_SAMPLE_COLUMNS = """sample_key host_id session_id source_id source_record_key source_offset source_kind source_version
usage_scope source_ms received_ms time_basis project
native_thread_id native_session_id native_turn_id native_root_turn_id native_response_id provider_account_key
context_turn_id context_provider context_model context_effort context_service_tier context_speed
producing_provider producing_model producing_effort producing_service_tier producing_speed
forked_from_id inherited_history source_role accounting_class
input_tokens cached_input_tokens cache_write_input_tokens output_tokens reasoning_output_tokens total_tokens
reported_mask provider_reported_mask synthesized_mask""".split()
V2_COUNTERS = "input_tokens cached_input_tokens cache_write_input_tokens output_tokens reasoning_output_tokens total_tokens".split()
V2_SAMPLE_HASH_COLUMNS = [key for key in V2_SAMPLE_COLUMNS if key not in ("sample_key", "received_ms")]
TABLES = {**V1_TABLES, "usage_samples_v2": (V2_SAMPLE_COLUMNS, ["sample_key"])}


class Refusal(Exception):
    pass


def require(value, message="Invalid archive input"):
    if not value:
        raise Refusal(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key")
        result[key] = value
    return result


def parse_json(raw):
    try:
        return json.loads(raw, object_pairs_hook=unique_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(Refusal("Invalid JSON number")))
    except (ValueError, UnicodeError, RecursionError):
        raise Refusal("Invalid JSON") from None


def shape(value, keys):
    require(type(value) is dict and set(value) == set(keys))


def optional_shape(value, required, optional):
    require(type(value) is dict and set(required) <= set(value) <= set(required) | set(optional))


def integer(value, minimum=0, maximum=SAFE_INT):
    return type(value) is int and minimum <= value <= maximum


def text(value, maximum=256):
    if not isinstance(value, str) or not value or len(value.encode("utf-16-le", "surrogatepass")) // 2 > maximum:
        return False
    return not any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in value)


def timestamp(value):
    require(isinstance(value, str) and ISO.fullmatch(value))
    try:
        result = dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=dt.timezone.utc)
        require(result.year >= 1970)
        delta = result - dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
        return delta.days * 86400000 + delta.seconds * 1000 + delta.microseconds // 1000
    except ValueError:
        raise Refusal("Invalid archive timestamp") from None


def day(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return False
    try:
        year, month, date = (int(part) for part in value.split("-"))
        return 1 <= month <= 12 and 1 <= date <= calendar.monthrange(year, month)[1]
    except ValueError:
        return False


def account_timestamp(value):
    """Match ECMAScript Date.toISOString, preserving existing source bytes.

    datetime only supports years 1..9999; the hub's canonical source stamps
    include year zero and signed six-digit years across the full Date range.
    Use proleptic Gregorian integer arithmetic, with the same TimeClip bound.
    Negative times remain source evidence but have no nonnegative SQL time.
    """
    match = ACCOUNT_ISO.fullmatch(value) if isinstance(value, str) else None
    require(match is not None)
    year_text, *parts = match.groups()
    year = int(year_text)
    month, date, hour, minute, second, millis = map(int, parts)
    require(len(year_text) == 4 or year < 0 or year >= 10000)
    require(1 <= month <= 12 and hour < 24 and minute < 60 and second < 60)
    days_in_month = (31, 29 if calendar.isleap(year) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    require(1 <= date <= days_in_month[month - 1])
    adjusted = year - (month <= 2)
    era = adjusted // 400
    year_of_era = adjusted - era * 400
    day_of_year = (153 * (month + (-3 if month > 2 else 9)) + 2) // 5 + date - 1
    days = era * 146097 + year_of_era * 365 + year_of_era // 4 - year_of_era // 100 + day_of_year - 719468
    result = days * 86400000 + hour * 3600000 + minute * 60000 + second * 1000 + millis
    require(-8640000000000000 <= result <= 8640000000000000)
    return result if result >= 0 else None


def validate_account(payload):
    require(isinstance(payload, str) and len(payload.encode("utf-8")) <= 32768)
    value = parse_json(payload)
    optional_shape(value, "version source status observedAt lastAttemptAt accountKey planType limitsObservedAt usageObservedAt limits summary dailyUsageBuckets errorCode".split(),
                   ("ordinaryUsageAllowed", "rateLimitResetCredits", "threadUsage"))
    require(value["version"] == 1 and type(value["version"]) is int and value["source"] == "codex-app-server")
    require(value["status"] in ("available", "partial", "stale", "unavailable"))
    require(value["accountKey"] is None or isinstance(value["accountKey"], str) and HEX.fullmatch(value["accountKey"]))
    require(value["planType"] is None or text(value["planType"], 128))
    for key in ("observedAt", "lastAttemptAt", "limitsObservedAt", "usageObservedAt"):
        if value[key] is not None:
            account_timestamp(value[key])
    require(type(value["limits"]) is list and len(value["limits"]) <= 8)
    seen = set()
    for limit in value["limits"]:
        optional_shape(limit, "limitId limitName planType primary secondary".split(),
                       ("credits", "spendControlReached", "individualLimit", "normalModelSlug", "rateLimitReachedType"))
        require(text(limit["limitId"], 128) and limit["limitId"] not in seen)
        seen.add(limit["limitId"])
        for key in ("limitName", "planType"):
            require(limit[key] is None or text(limit[key], 128))
        for key in ("primary", "secondary"):
            window = limit[key]
            if window is None:
                continue
            shape(window, ("usedPercent", "windowDurationMins", "resetsAt"))
            percent = window["usedPercent"]
            require(percent is None or type(percent) in (int, float) and 0 <= percent <= 100)
            require(all(window[k] is None or integer(window[k]) for k in ("windowDurationMins", "resetsAt")))
        if "credits" in limit and limit["credits"] is not None:
            credits = limit["credits"]
            optional_shape(credits, ("hasCredits", "unlimited"), ("balance",))
            require(type(credits["hasCredits"]) is bool and type(credits["unlimited"]) is bool)
            if "balance" in credits and credits["balance"] is not None:
                require(isinstance(credits["balance"], str) and len(credits["balance"]) <= 64 and re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", credits["balance"]))
        if "spendControlReached" in limit:
            require(limit["spendControlReached"] is None or type(limit["spendControlReached"]) is bool)
        if "individualLimit" in limit:
            require(limit["individualLimit"] is None)
        if "normalModelSlug" in limit:
            slug = limit["normalModelSlug"]
            require(slug is None or isinstance(slug, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,127}", slug))
        if "rateLimitReachedType" in limit:
            require(limit["rateLimitReachedType"] is None or limit["rateLimitReachedType"] in (
                "rate_limit_reached", "workspace_owner_credits_depleted", "workspace_member_credits_depleted",
                "workspace_owner_usage_limit_reached", "workspace_member_usage_limit_reached"))
    shape(value["summary"], "lifetimeTokens peakDailyTokens longestRunningTurnSec currentStreakDays longestStreakDays".split())
    require(all(v is None or integer(v) for v in value["summary"].values()))
    buckets = value["dailyUsageBuckets"]
    if buckets is not None:
        require(type(buckets) is list and len(buckets) <= 366)
        previous = None
        for bucket in buckets:
            shape(bucket, ("startDate", "tokens"))
            require(day(bucket["startDate"]) and integer(bucket["tokens"]))
            require(previous is None or previous < bucket["startDate"])
            previous = bucket["startDate"]
    require(value["errorCode"] is None or value["errorCode"] in ("spawn-failed", "process-exited", "output-limit", "invalid-response", "unexpected-request", "unsupported-method", "rpc-unavailable", "timeout", "stopped", "account-unavailable", "method-refused"))
    if "ordinaryUsageAllowed" in value:
        require(value["ordinaryUsageAllowed"] is None or type(value["ordinaryUsageAllowed"]) is bool)
    if "threadUsage" in value:
        require(value["threadUsage"] is None)
    if "rateLimitResetCredits" in value and value["rateLimitResetCredits"] is not None:
        reset = value["rateLimitResetCredits"]
        optional_shape(reset, ("availableCount",), ("credits",))
        require(integer(reset["availableCount"]))
        if "credits" in reset:
            require(reset["credits"] is None or type(reset["credits"]) is list and not reset["credits"])
    return value


def validate_v2_sample(row, row_key):
    shape(row, V2_SAMPLE_COLUMNS)
    shape(row_key, ("sample_key",))
    require(isinstance(row["sample_key"], str) and HEX.fullmatch(row["sample_key"]))
    require(row_key["sample_key"] == row["sample_key"])
    require(text(row["host_id"]) and text(row["session_id"]))
    for key in ("source_id", "provider_account_key"):
        require(row[key] is None or isinstance(row[key], str) and HEX.fullmatch(row[key]))
    require(isinstance(row["source_record_key"], str) and HEX.fullmatch(row["source_record_key"]))
    require(row["source_offset"] is None or integer(row["source_offset"]))
    require(row["source_kind"] in ("token_count", "token_usage_record"))
    require(row["source_version"] is None or text(row["source_version"], 128))
    require(row["usage_scope"] in ("thread-total", "last-response", "response", "turn-total"))
    require(row["source_ms"] is None or integer(row["source_ms"], 0, 8640000000000000))
    require(integer(row["received_ms"], 0, 8640000000000000))
    require(row["time_basis"] in ("source", "receipt"))
    require((row["time_basis"] == "source") == (row["source_ms"] is not None))
    for key in ("project", "native_thread_id", "native_session_id", "native_turn_id", "native_root_turn_id", "native_response_id", "context_turn_id", "forked_from_id"):
        require(row[key] is None or text(row[key]))
    for key in ("context_provider", "context_model"):
        require(row[key] is None or text(row[key], 128))
    for key in ("context_effort", "context_service_tier", "context_speed"):
        require(row[key] is None or text(row[key], 64))
    # Neither currently qualified rollout kind establishes producing attributes.
    # Do not silently turn configured context into a claim about production.
    require(all(row[key] is None for key in ("producing_provider", "producing_model", "producing_effort", "producing_service_tier", "producing_speed")))
    require(row["inherited_history"] is None or integer(row["inherited_history"], 0, 1))
    require(row["source_role"] in ("codex-source", "execution-target", "execution-job", "unknown"))
    require(row["accounting_class"] in ("candidate", "fork-excluded", "execution-excluded", "unknown"))
    expected = ("execution-excluded" if row["source_role"] in ("execution-target", "execution-job") else
                "fork-excluded" if row["forked_from_id"] is not None or row["inherited_history"] == 1 else
                "candidate" if row["source_role"] == "codex-source" else "unknown")
    require(row["accounting_class"] == expected)
    for key in ("reported_mask", "provider_reported_mask", "synthesized_mask"):
        require(integer(row[key], 0, 63))
    reported, provider, synthesized = (row[key] for key in ("reported_mask", "provider_reported_mask", "synthesized_mask"))
    require(provider & ~reported == 0 and synthesized & ~reported == 0 and provider & synthesized == 0)
    for bit, key in enumerate(V2_COUNTERS):
        value = row[key]
        require(value is None or integer(value))
        # A reported but invalid source value is retained as unknown (null).
        # Missing fields must not acquire an invented numeric zero.
        require(reported & (1 << bit) or value is None)
    # Preserve safe source values even if cache/input or reasoning/output do not
    # reconcile. Derived metrics must qualify comparable subsets, not repair data.
    canonical = json.dumps([row[key] for key in V2_SAMPLE_HASH_COLUMNS], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    require(hashlib.sha256(canonical).hexdigest() == row["sample_key"], "Invalid usage sample identity")


def validate_github_record(record):
    """V3 is an independent, closed metadata family; V1/V2 stay frozen."""
    require(record['table'] == 'github_metadata')
    row = record['row']
    shape(row, 'source_id host_id project epoch sequence payload'.split())
    shape(record['rowKey'], 'source_id epoch sequence'.split())
    require(all(row[k] == v and type(row[k]) is type(v) for k, v in record['rowKey'].items()))
    require(all(isinstance(row[k], str) and re.fullmatch(r'[-a-z0-9]{1,64}', row[k]) for k in ('source_id', 'host_id')))
    require(text(row['project'], 160) and integer(row['sequence'], 1) and row['sequence'] == record['sequence'])
    require(isinstance(row['epoch'], str) and re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', row['epoch']))
    require(isinstance(row['payload'], str) and len(row['payload'].encode()) <= 2097152)
    require(hashlib.sha256((row['epoch']+'\n'+str(row['sequence'])+'\n'+row['payload']).encode()).hexdigest() == record['itemId'])
    obs = parse_json(row['payload'])
    shape(obs, 'schemaVersion sourceId repositoryId apiOrigin apiVersion endpoint cycle context observedAt httpStatus metadataSha256 metadata priorObservedAt'.split())
    require(type(obs['schemaVersion']) is int and obs['schemaVersion'] == 1 and obs['sourceId'] == row['source_id'] and integer(obs['repositoryId'], 1) and integer(obs['cycle'], 1))
    require(obs['apiOrigin'] == 'https://api.github.com' and obs['apiVersion'] == '2026-03-10')
    require(isinstance(obs['endpoint'], str) and len(obs['endpoint']) <= 1024 and re.fullmatch(r'/repos/[A-Za-z0-9-]+/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_%./-]+)?(?:\?[A-Za-z0-9_=&%-]+)?', obs['endpoint']))
    require(obs['observedAt'] == record['recordedAt'] and type(obs['httpStatus']) is int and obs['httpStatus'] in (200, 304))
    require(isinstance(obs['metadataSha256'], str) and HEX.fullmatch(obs['metadataSha256']))
    require(type(obs['context']) is dict and set(obs['context']) <= {'pullNumber','headSha','runId','runAttempt','branch'})
    def sha40(v):
        return isinstance(v, str) and re.fullmatch(r'[a-f0-9]{40}', v)
    for key, value in obs['context'].items():
        require(sha40(value) if key == 'headSha' else text(value, 200) if key == 'branch' else integer(value, 1))
    if obs['httpStatus'] == 304:
        require(obs['metadata'] is None)
        timestamp(obs['priorObservedAt'])
        return
    require(obs['priorObservedAt'] is None)
    page = obs['metadata']
    shape(page, ['records','next','totalCount'])
    require(page['totalCount'] is None or integer(page['totalCount']))
    require(page['next'] is None or isinstance(page['next'], str) and page['next'].startswith(obs['endpoint'].split('?')[0]+'?') and len(page['next']) <= 1024)
    require(type(page['records']) is list and len(page['records']) <= 50)
    require(hashlib.sha256(json.dumps(page, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest() == obs['metadataSha256'])
    schemas = {
        'repository':'fullName private archived disabled created_at updated_at pushed_at',
        'branch':'name headSha protected',
        'pull':'number state draft merged base head mergeCommitSha created_at updated_at closed_at merged_at',
        'pull-list':'number state draft base head created_at updated_at closed_at merged_at',
        'check':'headSha suiteId appId status conclusion started_at completed_at',
        'status':'headSha state created_at updated_at',
        'run':'headSha headRepositoryId workflowId runNumber attempt status conclusion created_at updated_at run_started_at',
        'artifact':'runId observedRunAttempt headSha sizeBytes digest expired created_at updated_at expires_at',
    }
    for item in page['records']:
        require(type(item) is dict and item.get('kind') in schemas)
        shape(item, ['kind','id','repositoryId']+schemas[item['kind']].split())
        require(integer(item['id'], 1) and item['repositoryId'] == obs['repositoryId'])
        for key, value in item.items():
            if value is None:
                require(key in {'disabled','draft','merged','mergeCommitSha','suiteId','appId','headRepositoryId','conclusion','digest'} or key.endswith('_at'))
            elif key in {'id','repositoryId','number','suiteId','appId','headRepositoryId','workflowId','runNumber','attempt','runId','observedRunAttempt'}:
                require(integer(value, 1))
            elif key == 'sizeBytes':
                require(integer(value))
            elif key in {'private','archived','disabled','draft','merged','protected','expired'}:
                require(type(value) is bool)
            elif key in {'headSha','mergeCommitSha'}:
                require(sha40(value))
            elif key == 'digest':
                require(isinstance(value, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', value))
            elif key.endswith('_at'):
                require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT[\d:.]+Z', value))
                try:
                    dt.datetime.fromisoformat(value.replace('Z','+00:00'))
                except ValueError:
                    require(False)
            elif key in {'base','head'}:
                shape(value, ['repositoryId','sha'])
                require(value['repositoryId'] is None or integer(value['repositoryId'], 1))
                require(value['sha'] is None or sha40(value['sha']))
            elif key == 'fullName':
                require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9-]+/[A-Za-z0-9_.-]+', value))
            elif key == 'name':
                require(text(value, 200) and value == obs['context'].get('branch'))
            elif key == 'state':
                require(value in (('open','closed') if item['kind'] in ('pull','pull-list') else ('error','failure','pending','success')))
            elif key == 'status':
                require(value in ('queued','in_progress','completed','requested','waiting','pending'))
            elif key == 'conclusion':
                require(value in ('success','failure','neutral','cancelled','skipped','timed_out','action_required','stale','startup_failure'))


def validate_record(record):
    shape(record, "version itemId sequence table rowKey recordedAt row".split())
    require(type(record["version"]) is int and record["version"] in (1, 2, 3))
    require(isinstance(record["itemId"], str) and HEX.fullmatch(record["itemId"]))
    require(integer(record["sequence"], 1))
    recorded_ms = timestamp(record["recordedAt"])
    table, row = record["table"], record["row"]
    if record['version'] == 3:
        validate_github_record(record)
        return recorded_ms
    if record["version"] == 2:
        require(table == "usage_samples_v2")
        validate_v2_sample(row, record["rowKey"])
        return recorded_ms
    require(table in V1_TABLES)
    columns, keys = V1_TABLES[table]
    shape(row, columns)
    shape(record["rowKey"], keys)
    require(all(type(row[k]) is type(record["rowKey"][k]) and row[k] == record["rowKey"][k] for k in keys))
    require(text(row["host_id"]))
    for key in ("session_id",):
        if key in row:
            require(text(row[key]))
    for key, maximum in (("project", 256), ("provider", 128), ("model", 128)):
        if key in row:
            require(row[key] is None or text(row[key], maximum))
    for key in columns:
        if key.endswith("_ms"):
            require(row[key] is None and key in ("observed_ms", "limits_ms", "usage_ms", "interval_ms") or integer(row[key], 1 if key == "interval_ms" else 0, 8640000000000000))
        if key.endswith("_tokens") or key.startswith("delta_"):
            require(row[key] is None or integer(row[key]))
    if "sequence" in row:
        require(integer(row["sequence"], 1))
    if "day" in row:
        require(day(row["day"]))
    if "account_identity" in row:
        require(row["account_identity"] == "unlinked" or isinstance(row["account_identity"], str) and HEX.fullmatch(row["account_identity"]))
    # Partial daily sums cover different observed subsets; retain their exact values.
    # Raw/baseline and fully comparable daily counters keep the subset invariant.
    if "cached_input_tokens" in row and (table != "usage_daily" or row["partial_observations"] == 0):
        require(row["cached_input_tokens"] is None or row["input_tokens"] is None or row["cached_input_tokens"] <= row["input_tokens"])
    if table == "usage_baselines":
        require(integer(row["has_delta"], 0, 31))
    elif table == "usage_observations":
        require(row["status"] in ("baseline", "delta", "partial", "reset", "gap", "out-of-order", "future", "stale"))
        accepted = row["status"] in ("delta", "partial")
        deltas = [row[k] for k in columns if k.startswith("delta_")]
        require(accepted or all(v is None for v in deltas))
        require(row["status"] != "delta" or all(v is not None for v in deltas))
        require(not accepted or integer(row["interval_ms"], 1, 300000))
        require(row["delta_cached"] is None or row["delta_input"] is None or row["delta_cached"] <= row["delta_input"])
        require(row["delta_uncached"] is None or row["delta_input"] is not None and row["delta_cached"] is not None and row["delta_uncached"] == row["delta_input"] - row["delta_cached"])
    elif table == "usage_daily":
        require(isinstance(row["segment_key"], str) and HEX.fullmatch(row["segment_key"]))
        # Node's JSON.stringify uses literal Unicode and compact separators.
        segment = json.dumps([row["project"], row["provider"], row["model"]], ensure_ascii=False, separators=(",", ":"))
        require(hashlib.sha256(segment.encode()).hexdigest() == row["segment_key"])
        require(integer(row["observations"], 1) and integer(row["partial_observations"], 0, row["observations"]))
        require(type(row["overflow"]) is int and row["overflow"] in (0, 1) and row["first_ms"] <= row["last_ms"])
        require(not row["overflow"] or all(row[k] is None for k in columns if k.endswith("_tokens")))
    elif table == "account_usage_observations":
        account = validate_account(row["payload"])
        require(HEX.fullmatch(row["sample_key"]) and hashlib.sha256(row["payload"].encode()).hexdigest() == row["sample_key"])
        require((account["accountKey"] or "unlinked") == row["account_identity"])
        for source, field in (("observedAt", "observed_ms"), ("limitsObservedAt", "limits_ms"), ("usageObservedAt", "usage_ms")):
            require((account_timestamp(account[source]) if account[source] is not None else None) == row[field])
    elif table == "account_usage_daily":
        require(integer(row["tokens"]))
    return recorded_ms


def decode_segment(compressed):
    require(0 < len(compressed) <= MAX_BYTES, "Compressed archive bound exceeded")
    try:
        decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
        raw = decoder.decompress(compressed, MAX_BYTES + 1)
        require(len(raw) <= MAX_BYTES and not decoder.unconsumed_tail, "Expanded archive bound exceeded")
        require(decoder.eof and not decoder.unused_data, "Incomplete or trailing gzip data")
    except zlib.error:
        raise Refusal("Invalid archive gzip") from None
    require(raw.endswith(b"\n") and raw and b"\r" not in raw, "Expected canonical NDJSON")
    lines = raw[:-1].split(b"\n")
    require(0 < len(lines) <= MAX_RECORDS, "Archive record bound exceeded")
    records, seen = [], set()
    for line in lines:
        require(line and len(line) <= 131072, "Archive record bound exceeded")
        record = parse_json(line.decode("utf-8", "strict"))
        recorded_ms = validate_record(record)
        require(record["itemId"] not in seen, "Duplicate archive item")
        seen.add(record["itemId"])
        records.append((record, line, recorded_ms))
    return raw, records


def no_symlinks(path, require_file=False):
    path = Path(os.path.abspath(path))
    for part in [*reversed(path.parents), path]:
        if part.exists() or part.is_symlink():
            info = part.lstat()
            mode = info.st_mode
            require(not stat.S_ISLNK(mode) and not getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0), "Archive path cannot contain symlinks or reparse points")
    if require_file:
        require(path.is_file(), "Missing archive file")
    return path


def fsync_directory(path):
    if os.name == "nt":
        # Windows namespace mutations use no-replace WRITE_THROUGH publication.
        # This checks the directory; named-file/catalog flushes precede ACK.
        windows_guard().check(path)
        return
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def trusted_ancestors(path):
    if os.name == "nt":
        ancestor = Path(path).parent
        while not ancestor.exists():
            require(ancestor.parent != ancestor, 'Archive ancestor is unavailable')
            ancestor = ancestor.parent
        windows_guard().check(ancestor, private=False)
        return
    # A private final directory is insufficient if another principal can rename
    # it through a writable ancestor. Root and this dedicated account are the
    # trust boundary. Root-owned sticky /tmp safely permits private test roots.
    for ancestor in reversed(path.parents):
        if not ancestor.exists():
            continue
        info = ancestor.stat()
        require(info.st_uid in (0, os.geteuid()), "Archive ancestor must be owned by a trusted principal")
        require(not info.st_mode & 0o022 or info.st_mode & stat.S_ISVTX, "Archive ancestor cannot be writable by others without sticky protection")


def private_directory(path):
    path = no_symlinks(path)
    trusted_ancestors(path)
    missing = []
    current = path
    while not current.exists():
        missing.append(current)
        current = current.parent
    for directory in reversed(missing):
        try:
            guard = windows_guard()
            if guard is None:
                directory.mkdir(mode=0o700)
            else:
                temporary = Path(tempfile.mkdtemp(prefix='.pending-dir-', dir=directory.parent))
                guard.publish(temporary, directory, directory=True)
        except FileExistsError:
            require(directory.is_dir(), "Archive directory creation conflict")
            no_symlinks(directory)
        fsync_directory(directory)
        fsync_directory(directory.parent)
    no_symlinks(path)
    trusted_ancestors(path)
    if windows_guard() is not None:
        windows_guard().check(path)
    if os.name != "nt":
        info = path.stat()
        require(info.st_uid == os.geteuid() and not info.st_mode & 0o022, "Archive directory must be owned and not writable by others")
    return path


def linux_mount(path):
    """Read the actual longest matching mount, including bind mounts."""
    if not sys.platform.startswith("linux"):
        return None
    target = os.path.abspath(path)
    matches = []
    with open("/proc/self/mountinfo", encoding="utf-8") as source:
        for line in source:
            parts = line.rstrip().split(" ")
            split = parts.index("-")
            def unescape(value):
                return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), value)
            mount = unescape(parts[4])
            if target == mount or target.startswith(mount.rstrip("/") + "/"):
                matches.append({"mountPoint": mount, "filesystem": parts[split + 1], "source": unescape(parts[split + 2])})
    require(matches, "Cannot establish archive filesystem identity")
    return max(matches, key=lambda value: len(value["mountPoint"]))


def validate_storage(config):
    guard = windows_guard()
    if guard is not None:
        for name in ('archiveDirectory', 'catalogDirectory'):
            target = Path(config[name])
            while not target.exists():
                target = target.parent
            guard.check(target, private=False)
    catalog_mount = linux_mount(config["catalogDirectory"])
    archive_mount = linux_mount(config["archiveDirectory"])
    if catalog_mount:
        require(catalog_mount["filesystem"] in ("ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "overlay"), "Archive catalog must use a durable local filesystem")
    expected = config.get("expectedArchiveMount")
    if expected is not None:
        shape(expected, ("mountPoint", "source", "filesystem"))
        require(all(text(value, 1024) for value in expected.values()))
        require(archive_mount is not None and expected == archive_mount, "Archive mount identity changed or disconnected")
    if archive_mount and archive_mount["filesystem"] not in ("ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "overlay"):
        require(expected is not None, "Network archive requires an exact mount identity pin")


def read_bounded(path, maximum=MAX_BYTES):
    no_symlinks(path, True)
    guard = windows_guard()
    with guard.hold(path) if guard is not None else contextlib.nullcontext():
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as source:
            data = source.read(maximum + 1)
    require(len(data) <= maximum, "Archive file bound exceeded")
    return data


def immutable_write(path, data):
    private_directory(path.parent)
    no_symlinks(path)
    if path.exists():
        require(read_bounded(path, max(MAX_BYTES, len(data))) == data, "Conflicting immutable archive file")
        return
    fd, temporary = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        # A link publishes without replacing any existing name.
        guard = windows_guard()
        if guard is None:
            os.link(temporary, path)
        else:
            guard.publish(temporary, path)
        fsync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
        fsync_directory(path.parent)


def load_config(filename):
    if windows_guard() is not None:
        windows_guard().check(filename)
    config = parse_json(read_bounded(no_symlinks(filename, True), 16384))
    require(type(config) is dict and set(config) <= {"archiveDirectory", "catalogDirectory", "receiverId", "timescale", "expectedArchiveMount"})
    require(set(config) >= {"archiveDirectory", "catalogDirectory", "receiverId"})
    require(isinstance(config["archiveDirectory"], str) and Path(config["archiveDirectory"]).is_absolute())
    require(isinstance(config["catalogDirectory"], str) and Path(config["catalogDirectory"]).is_absolute())
    try:
        require(str(uuid.UUID(config["receiverId"])) == config["receiverId"])
    except (ValueError, TypeError, AttributeError):
        raise Refusal("Invalid receiver identity") from None
    if os.name != "nt":
        info = Path(filename).stat()
        require(info.st_uid == os.geteuid() and not info.st_mode & 0o077, "Receiver config must be private")
    timescale = config.get("timescale", {"enabled": False})
    require(type(timescale) is dict and set(timescale) <= {"enabled", "database", "psqlPath"})
    require(type(timescale.get("enabled", False)) is bool)
    if timescale.get("enabled"):
        require(timescale.get("database") == "codexcontrol_archive")
        configured_psql = Path(timescale.get("psqlPath", "/usr/bin/psql"))
        require(configured_psql.is_absolute())
        # Debian's /usr/bin/psql is a root-managed symlink to pg_wrapper. Only
        # the executable may resolve symlinks; archive/catalog paths never do.
        psql = no_symlinks(configured_psql.resolve(strict=True), True)
        require(os.access(psql, os.X_OK))
    config["timescale"] = timescale
    validate_storage(config)
    config["root"] = private_directory(config["archiveDirectory"])
    config["catalogRoot"] = private_directory(config["catalogDirectory"])
    return config


def connect(config):
    validate_storage(config)
    root = config["catalogRoot"]
    filename = no_symlinks(root / "catalog.sqlite")
    if windows_guard() is not None and filename.exists():
        windows_guard().check(filename)
    db = sqlite3.connect(filename, timeout=30, isolation_level=None)
    if os.name != "nt":
        os.chmod(filename, 0o600)
    db.execute("PRAGMA synchronous=FULL")
    db.execute("PRAGMA journal_mode=DELETE")
    db.execute("PRAGMA busy_timeout=30000")
    db.executescript("""
    CREATE TABLE IF NOT EXISTS archive_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS segments(raw_sha256 TEXT PRIMARY KEY,compressed_sha256 TEXT NOT NULL,segment_path TEXT NOT NULL UNIQUE,records INTEGER NOT NULL,raw_bytes INTEGER NOT NULL,compressed_bytes INTEGER NOT NULL,first_recorded_ms INTEGER NOT NULL,last_recorded_ms INTEGER NOT NULL,projected_at TEXT);
    CREATE TABLE IF NOT EXISTS items(catalog_id INTEGER PRIMARY KEY AUTOINCREMENT,item_id TEXT NOT NULL UNIQUE,record_sha256 TEXT NOT NULL,segment_sha256 TEXT NOT NULL,ordinal INTEGER NOT NULL,table_name TEXT NOT NULL,host_id TEXT NOT NULL,project TEXT,recorded_ms INTEGER NOT NULL,source_sequence INTEGER NOT NULL,FOREIGN KEY(segment_sha256) REFERENCES segments(raw_sha256));
    CREATE INDEX IF NOT EXISTS items_scope ON items(host_id,project,recorded_ms,catalog_id);
    CREATE INDEX IF NOT EXISTS items_segment ON items(segment_sha256,ordinal);
    """)
    row = db.execute("SELECT value FROM archive_meta WHERE key='receiverId'").fetchone()
    require(row is None or row[0] == config["receiverId"], "Archive receiver identity changed")
    db.execute("INSERT OR IGNORE INTO archive_meta VALUES('receiverId',?)", (config["receiverId"],))
    fsync_directory(root)
    return db


def segment_metadata(raw, compressed, records):
    raw_sha = hashlib.sha256(raw).hexdigest()
    date = min(r[0]["recordedAt"] for r in records)[:10].replace("-", "/")
    relative = f"segments/{date}/{raw_sha}.jsonl.gz"
    manifest = {"version": 1, "rawSha256": raw_sha, "compressedSha256": hashlib.sha256(compressed).hexdigest(),
                "records": len(records), "rawBytes": len(raw), "compressedBytes": len(compressed),
                "firstRecordedMs": min(r[2] for r in records), "lastRecordedMs": max(r[2] for r in records),
                "itemIds": [r[0]["itemId"] for r in records]}
    return relative, manifest


def checked_segment(config, relative):
    require(isinstance(relative, str) and re.fullmatch(r"segments/\d{4}/\d{2}/\d{2}/[a-f0-9]{64}\.jsonl\.gz", relative), "Invalid segment reference")
    target = config["root"] / relative
    compressed = read_bounded(target)
    raw, records = decode_segment(compressed)
    expected, manifest = segment_metadata(raw, compressed, records)
    require(expected == relative, "Archive content address mismatch")
    stored = parse_json(read_bounded(target.with_suffix(".manifest.json"), 262144))
    require(stored == manifest, "Archive manifest mismatch")
    return compressed, raw, records, manifest


def index_segment(db, relative, manifest, records):
    raw_sha = manifest["rawSha256"]
    existing = db.execute("SELECT compressed_sha256,segment_path,records,raw_bytes,compressed_bytes,first_recorded_ms,last_recorded_ms FROM segments WHERE raw_sha256=?", (raw_sha,)).fetchone()
    values = (manifest["compressedSha256"], relative, len(records), manifest["rawBytes"], manifest["compressedBytes"], manifest["firstRecordedMs"], manifest["lastRecordedMs"])
    require(existing is None or existing == values, "Conflicting archive catalog segment")
    for record, line, _ in records:
        prior = db.execute("SELECT record_sha256 FROM items WHERE item_id=?", (record["itemId"],)).fetchone()
        require(prior is None or prior[0] == hashlib.sha256(line).hexdigest(), "Conflicting archive item bytes")
    db.execute("INSERT OR IGNORE INTO segments(raw_sha256,compressed_sha256,segment_path,records,raw_bytes,compressed_bytes,first_recorded_ms,last_recorded_ms) VALUES(?,?,?,?,?,?,?,?)", (raw_sha, *values))
    for ordinal, (record, line, recorded_ms) in enumerate(records):
        db.execute("INSERT OR IGNORE INTO items(item_id,record_sha256,segment_sha256,ordinal,table_name,host_id,project,recorded_ms,source_sequence) VALUES(?,?,?,?,?,?,?,?,?)", (record["itemId"], hashlib.sha256(line).hexdigest(), raw_sha, ordinal, record["table"], record["row"]["host_id"], record["row"].get("project"), recorded_ms, record["sequence"]))


def receive(config, compressed):
    received_compressed_sha = hashlib.sha256(compressed).hexdigest()
    raw, records = decode_segment(compressed)
    require(not config["timescale"].get("enabled") or all(record["version"] != 3 for record, _, _ in records), "GitHub metadata requires a receiver without the usage-only Timescale projection")
    relative, manifest = segment_metadata(raw, compressed, records)
    db = connect(config)
    try:
        db.execute("BEGIN IMMEDIATE")
        prior = db.execute("SELECT segment_path FROM segments WHERE raw_sha256=?", (manifest["rawSha256"],)).fetchone()
        if prior:
            compressed, verified_raw, verified_records, manifest = checked_segment(config, prior[0])
            require(verified_raw == raw, "Conflicting archive batch")
            relative, records = prior[0], verified_records
        else:
            # Check item conflicts before publishing any new immutable file.
            for record, line, _ in records:
                prior_item = db.execute("SELECT record_sha256 FROM items WHERE item_id=?", (record["itemId"],)).fetchone()
                require(prior_item is None or prior_item[0] == hashlib.sha256(line).hexdigest(), "Conflicting archive item bytes")
            target = config["root"] / relative
            if target.exists():
                # Crash after file publication but before catalog commit. The
                # sender's gzip header may differ on an exact raw-byte retry.
                old = read_bounded(target)
                old_raw, old_records = decode_segment(old)
                require(old_raw == raw, "Conflicting immutable archive file")
                compressed, records = old, old_records
                relative, manifest = segment_metadata(raw, compressed, records)
            else:
                immutable_write(target, compressed)
            immutable_write(target.with_suffix(".manifest.json"), (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode())
            checked_segment(config, relative)
        index_segment(db, relative, manifest, records)
        db.execute("COMMIT")
        fsync_directory(config["catalogRoot"])
        validate_storage(config)
        checked_segment(config, relative)
        guard = windows_guard()
        if guard is not None:
            # A refused flush leaves the exact sender batch pending, even if
            # catalog COMMIT succeeded; the existing exact retry is idempotent.
            for durable_file in (config['root'] / relative, (config['root'] / relative).with_suffix('.manifest.json'), config['catalogRoot'] / 'catalog.sqlite'):
                guard.flush_file(durable_file)
        return {"version": 1, "batchId": manifest["rawSha256"], "rawSha256": manifest["rawSha256"],
                "compressedSha256": manifest["compressedSha256"], "receivedCompressedSha256": received_compressed_sha, "records": len(records),
                "receiverId": config["receiverId"], "durable": True, "itemIds": manifest["itemIds"], "segment": relative}
    except Exception:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise
    finally:
        db.close()


def verify(config, rebuild=False):
    db = connect(config)
    count = records_count = 0
    try:
        db.execute("BEGIN IMMEDIATE")
        if rebuild:
            db.execute("DELETE FROM items")
            db.execute("DELETE FROM segments")
        segments = config["root"] / "segments"
        if segments.exists():
            for directory, dirs, files in os.walk(segments, followlinks=False):
                for name in dirs:
                    no_symlinks(Path(directory) / name)
                for name in files:
                    if not name.endswith(".jsonl.gz"):
                        continue
                    target = no_symlinks(Path(directory) / name, True)
                    relative = target.relative_to(config["root"]).as_posix()
                    if rebuild and not target.with_suffix(".manifest.json").exists():
                        compressed = read_bounded(target)
                        raw, records = decode_segment(compressed)
                        expected, manifest = segment_metadata(raw, compressed, records)
                        require(expected == relative, "Archive content address mismatch")
                        immutable_write(target.with_suffix(".manifest.json"), (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode())
                    _, _, records, manifest = checked_segment(config, relative)
                    if rebuild:
                        index_segment(db, relative, manifest, records)
                    else:
                        for ordinal, (record, line, _) in enumerate(records):
                            indexed = db.execute("SELECT record_sha256 FROM items WHERE item_id=?", (record["itemId"],)).fetchone()
                            require(indexed and indexed[0] == hashlib.sha256(line).hexdigest(), "Archive catalog item mismatch")
                        indexed = db.execute("SELECT compressed_sha256 FROM segments WHERE raw_sha256=?", (manifest["rawSha256"],)).fetchone()
                        require(indexed and indexed[0] == manifest["compressedSha256"], "Archive catalog segment mismatch")
                    count += 1
                    records_count += len(records)
        require(db.execute("SELECT COUNT(*) FROM segments").fetchone()[0] == count, "Archive catalog has missing segments")
        # Check the catalog in the other direction as well: an extra/corrupted
        # item locator must not hide behind otherwise valid cold segments.
        cached_path, cached_records = None, None
        for indexed in db.execute("SELECT segment_path,ordinal,item_id,record_sha256,table_name,host_id,project,recorded_ms,source_sequence FROM items LEFT JOIN segments ON segment_sha256=raw_sha256 ORDER BY segment_path,ordinal"):
            relative, ordinal, item_id, record_sha, table, host, project, recorded_ms, sequence = indexed
            require(relative is not None, "Archive catalog has an orphan item")
            if cached_path != relative:
                _, _, cached_records, _ = checked_segment(config, relative)
                cached_path = relative
            require(integer(ordinal, 0, len(cached_records) - 1), "Archive catalog ordinal mismatch")
            record, line, source_ms = cached_records[ordinal]
            require((item_id, record_sha, table, host, project, recorded_ms, sequence) == (record["itemId"], hashlib.sha256(line).hexdigest(), record["table"], record["row"]["host_id"], record["row"].get("project"), source_ms, record["sequence"]), "Archive catalog item locator mismatch")
        db.execute("COMMIT")
        return {"version": 1, "receiverId": config["receiverId"], "verified": True, "rebuilt": rebuild, "segments": count, "segmentRecords": records_count, "distinctItems": db.execute("SELECT COUNT(*) FROM items").fetchone()[0]}
    except Exception:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise
    finally:
        db.close()


def query(config, args):
    require(integer(args.after, 0) and integer(args.limit, 1, 1000))
    conditions, values = ["catalog_id>?"], [args.after]
    for key, value in (("host_id", args.host), ("project", args.project), ("table_name", args.table)):
        if value is not None:
            require(text(value) and (key != "table_name" or value in (*TABLES, "github_metadata")))
            conditions.append(key + "=?")
            values.append(value)
    for operator, value in ((">=", args.from_ms), ("<=", args.to_ms)):
        if value is not None:
            require(integer(value))
            conditions.append("recorded_ms" + operator + "?")
            values.append(value)
    db = connect(config)
    try:
        result = db.execute("SELECT catalog_id,segment_path,ordinal,item_id FROM items JOIN segments ON segment_sha256=raw_sha256 WHERE " + " AND ".join(conditions) + " ORDER BY catalog_id LIMIT ?", (*values, args.limit)).fetchall()
        cache_path, cache = None, None
        for cursor, relative, ordinal, item_id in result:
            if cache_path != relative:
                _, _, cache, _ = checked_segment(config, relative)
                cache_path = relative
            require(integer(ordinal, 0, len(cache) - 1), "Archive retrieval ordinal mismatch")
            record, line, _ = cache[ordinal]
            require(record["itemId"] == item_id, "Archive retrieval index mismatch")
            # Stderr reports paging metadata; stdout remains exact canonical NDJSON.
            sys.stdout.buffer.write(line + b"\n")
        print(json.dumps({"version": 1, "records": len(result), "nextCursor": result[-1][0] if result else args.after, "limit": args.limit}), file=sys.stderr)
    finally:
        db.close()


def status(config):
    db = connect(config)
    try:
        return {"version": 1, "receiverId": config["receiverId"], "segments": db.execute("SELECT COUNT(*) FROM segments").fetchone()[0], "items": db.execute("SELECT COUNT(*) FROM items").fetchone()[0], "compressedBytes": db.execute("SELECT COALESCE(SUM(compressed_bytes),0) FROM segments").fetchone()[0], "rawBytes": db.execute("SELECT COALESCE(SUM(raw_bytes),0) FROM segments").fetchone()[0], "timescaleEnabled": config["timescale"].get("enabled", False), "timescalePendingSegments": db.execute("SELECT COUNT(*) FROM segments WHERE projected_at IS NULL").fetchone()[0], "retention": "indefinite; no deletion operation"}
    finally:
        db.close()


def project_timescale(config, limit):
    require(config["timescale"].get("enabled") is True, "Timescale projection is not enabled")
    require(integer(limit, 1, 32))
    db = connect(config)
    projected = 0
    try:
        rows = db.execute("SELECT raw_sha256,segment_path FROM segments WHERE projected_at IS NULL ORDER BY first_recorded_ms,raw_sha256 LIMIT ?", (limit,)).fetchall()
        for raw_sha, relative in rows:
            _, _, records, _ = checked_segment(config, relative)
            lines = []
            for record, line, _ in records:
                value = {"record": record, "recordSha256": hashlib.sha256(line).hexdigest(), "segmentSha256": raw_sha}
                lines.append(json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("\\", "\\\\"))
            sql = "BEGIN;\nCREATE TEMP TABLE codexcontrol_projection_batch(value jsonb) ON COMMIT DROP;\nCOPY codexcontrol_projection_batch(value) FROM STDIN;\n" + "\n".join(lines) + "\n\\.\nSELECT codexcontrol_archive.ingest_usage_batch();\nCOMMIT;\n"
            result = subprocess.run([config["timescale"].get("psqlPath", "/usr/bin/psql"), "--no-psqlrc", "--no-password", "--host=/var/run/postgresql", "--dbname=codexcontrol_archive", "--set=ON_ERROR_STOP=1", "--quiet"], input=sql.encode(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, env={"PATH": os.defpath, "HOME": str(Path.home()), "PGCONNECT_TIMEOUT": "10", "PGOPTIONS": "-c statement_timeout=45000 -c lock_timeout=5000"})
            require(result.returncode == 0, "Timescale projection failed; durable cold records remain pending")
            now = dt.datetime.now(dt.timezone.utc).isoformat()
            db.execute("UPDATE segments SET projected_at=? WHERE raw_sha256=?", (now, raw_sha))
            projected += 1
        return {"version": 1, "projectedSegments": projected, "pendingSegments": db.execute("SELECT COUNT(*) FROM segments WHERE projected_at IS NULL").fetchone()[0]}
    except subprocess.TimeoutExpired:
        raise Refusal("Timescale projection timed out; durable cold records remain pending") from None
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--verify", action="store_true")
    mode.add_argument("--rebuild", action="store_true")
    mode.add_argument("--query", action="store_true")
    mode.add_argument("--status", action="store_true")
    mode.add_argument("--project-timescale", action="store_true")
    parser.add_argument("--after", type=int, default=0)
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--host")
    parser.add_argument("--project")
    parser.add_argument("--table")
    parser.add_argument("--from-ms", type=int)
    parser.add_argument("--to-ms", type=int)
    args = parser.parse_args()
    os.umask(0o077)
    config = load_config(args.config)
    if args.query:
        query(config, args)
        return
    if args.verify or args.rebuild:
        result = verify(config, args.rebuild)
    elif args.status:
        result = status(config)
    elif args.project_timescale:
        result = project_timescale(config, min(args.limit, 32))
    else:
        result = receive(config, sys.stdin.buffer.read(MAX_BYTES + 1))
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except (Refusal, OSError, sqlite3.Error, UnicodeError, ValueError, TypeError, KeyError, IndexError, OverflowError) as error:
        # Never echo record values, subprocess stderr or config credentials.
        print(json.dumps({"version": 1, "durable": False, "error": str(error) if isinstance(error, Refusal) else "Archive operation failed"}, separators=(",", ":")), file=sys.stderr)
        sys.exit(1)
