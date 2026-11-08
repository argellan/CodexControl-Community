#!/usr/bin/env python3
# Author: Bishop Crockett
# Owner: Argellan.com
# License: MIT
# SPDX-License-Identifier: MIT
# Attribution covers ARGELLAN-authored implementation and modifications only.
# Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
"""Optional, rebuildable local DuckDB projection of verified cold archive data.

The receiver catalog and immutable segments are read-only inputs. This program
has no custody acknowledgment, retention, arbitrary SQL or network interface.
"""
import argparse
import calendar
import contextlib
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import threading
import time
import uuid

SAFE_INT = 9007199254740991
MAX_INPUT = 65536
MAX_OUTPUT = 262144
LOCAL_FILESYSTEMS = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "overlay"}
DAY = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
spec = importlib.util.spec_from_file_location("archive_receiver", Path(__file__).with_name("archive-receiver.py"))
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)


class Refusal(Exception):
    def __init__(self, code="ANALYTICS_INVALID"):
        self.code = code


def require(value, code="ANALYTICS_INVALID"):
    if not value:
        raise Refusal(code)


def integer(value, low=0, high=SAFE_INT):
    return type(value) is int and low <= value <= high


def label(value):
    return isinstance(value, str) and 0 < len(value) <= 256 and not any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in value)


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def private_file(filename):
    path = receiver.no_symlinks(filename, True)
    receiver.trusted_ancestors(path)
    if receiver.windows_guard() is not None:
        receiver.windows_guard().check(path)
    if os.name != "nt":
        info = path.stat()
        require(info.st_uid == os.geteuid() and not info.st_mode & 0o077, "ANALYTICS_CONFIG")
    return path


def local_path(path):
    path = receiver.no_symlinks(path)
    receiver.trusted_ancestors(path)
    if sys.platform.startswith("linux"):
        require(receiver.linux_mount(path)["filesystem"] in LOCAL_FILESYSTEMS, "ANALYTICS_STORAGE")
    elif os.name == "nt":
        target = Path(path)
        while not target.exists():
            target = target.parent
        receiver.windows_guard().check(target, private=False)
        import ctypes
        root = Path(path).anchor
        require(not str(path).startswith("\\\\") and ctypes.windll.kernel32.GetDriveTypeW(str(root)) == 3, "ANALYTICS_STORAGE")
    else:
        # An unqualified filesystem is never silently treated as local storage.
        raise Refusal("ANALYTICS_STORAGE")
    return path


def read_configuration(filename):
    value = receiver.parse_json(receiver.read_bounded(private_file(filename), 16384))
    required = {"version", "receiverConfig", "databaseDirectory"}
    require(type(value) is dict and required <= set(value) <= required | {"memoryLimitMb", "threads", "queryTimeoutSeconds"}, "ANALYTICS_CONFIG")
    require(type(value["version"]) is int and value["version"] == 1, "ANALYTICS_CONFIG")
    for name in ("receiverConfig", "databaseDirectory"):
        require(isinstance(value[name], str) and Path(value[name]).is_absolute(), "ANALYTICS_CONFIG")
    for name, default, low, high in (("memoryLimitMb", 256, 64, 1024), ("threads", 2, 1, 4), ("queryTimeoutSeconds", 15, 1, 30)):
        value.setdefault(name, default)
        require(integer(value[name], low, high), "ANALYTICS_CONFIG")
    cold = receiver.parse_json(receiver.read_bounded(private_file(value["receiverConfig"]), 16384))
    require(type(cold) is dict and {"archiveDirectory", "catalogDirectory", "receiverId"} <= set(cold) <= {"archiveDirectory", "catalogDirectory", "receiverId", "timescale", "expectedArchiveMount"}, "ANALYTICS_CONFIG")
    require(isinstance(cold["receiverId"], str) and str(uuid.UUID(cold["receiverId"])) == cold["receiverId"], "ANALYTICS_CONFIG")
    for name in ("archiveDirectory", "catalogDirectory"):
        require(isinstance(cold[name], str) and Path(cold[name]).is_absolute(), "ANALYTICS_CONFIG")
        p = receiver.no_symlinks(cold[name])
        receiver.trusted_ancestors(p)
        require(p.is_dir(), "ANALYTICS_UNAVAILABLE")
        if os.name != "nt":
            info = p.stat()
            require(info.st_uid == os.geteuid() and not info.st_mode & 0o022, "ANALYTICS_STORAGE")
    receiver.validate_storage(cold)
    cold["root"] = Path(cold["archiveDirectory"])
    cold["catalogRoot"] = Path(cold["catalogDirectory"])
    directory = local_path(value["databaseDirectory"])
    # A projection must never share its writable directory with archive inputs.
    for other in (cold["root"], cold["catalogRoot"]):
        require(directory != other and other not in directory.parents and directory not in other.parents, "ANALYTICS_STORAGE")
    value["directory"], value["cold"] = directory, cold
    return value


def open_catalog(config):
    filename = receiver.no_symlinks(config["cold"]["catalogRoot"] / "catalog.sqlite", True)
    db = sqlite3.connect(filename.as_uri() + "?mode=ro", uri=True, timeout=2)
    try:
        db.execute("PRAGMA query_only=ON")
        db.execute("PRAGMA trusted_schema=OFF")
        require(db.execute("SELECT value FROM archive_meta WHERE key='receiverId'").fetchone() == (config["cold"]["receiverId"],), "ANALYTICS_RECEIVER")
        return db
    except Exception:
        db.close()
        raise


SCHEMA = """
CREATE TABLE IF NOT EXISTS analytics_meta(key VARCHAR PRIMARY KEY,value VARCHAR NOT NULL);
CREATE TABLE IF NOT EXISTS analytics_segments(
 raw_sha256 VARCHAR PRIMARY KEY,compressed_sha256 VARCHAR NOT NULL,segment_path VARCHAR NOT NULL,
 records BIGINT NOT NULL,raw_bytes BIGINT NOT NULL,projected_at VARCHAR NOT NULL);
CREATE TABLE IF NOT EXISTS analytics_items(
 item_id VARCHAR PRIMARY KEY,record_sha256 VARCHAR NOT NULL,canonical_line VARCHAR NOT NULL,
 version INTEGER NOT NULL,source_sequence BIGINT NOT NULL,source_table VARCHAR NOT NULL,
 source_row_key VARCHAR NOT NULL,row_data VARCHAR NOT NULL,recorded_at VARCHAR NOT NULL,
 host_id VARCHAR NOT NULL,project VARCHAR,session_id VARCHAR,day VARCHAR,day_ms BIGINT,
 logical_key VARCHAR,causal_ms BIGINT,received_ms BIGINT,effective_ms BIGINT,
 sample_key VARCHAR,usage_scope VARCHAR,accounting_class VARCHAR,response_identity VARCHAR,
 semantic_signature VARCHAR NOT NULL,account_identity VARCHAR,
 input_tokens BIGINT,cached_tokens BIGINT,uncached_tokens BIGINT,cache_write_tokens BIGINT,
 output_tokens BIGINT,reasoning_tokens BIGINT,total_tokens BIGINT);
CREATE TABLE IF NOT EXISTS analytics_membership(
 segment_sha256 VARCHAR NOT NULL,item_id VARCHAR NOT NULL,ordinal INTEGER NOT NULL,
 PRIMARY KEY(segment_sha256,ordinal),UNIQUE(segment_sha256,item_id));
CREATE INDEX IF NOT EXISTS analytics_host_source ON analytics_items(host_id,source_table);
"""


def schema_signature(db):
    return (
        db.execute("SELECT schema_name,table_name,sql FROM duckdb_tables() WHERE NOT internal ORDER BY schema_name,table_name").fetchall(),
        db.execute("SELECT schema_name,index_name,table_name,sql FROM duckdb_indexes() ORDER BY schema_name,index_name").fetchall(),
        db.execute("SELECT schema_name,view_name,sql FROM duckdb_views() WHERE NOT internal ORDER BY schema_name,view_name").fetchall())


def verify_projection(db, config, expected):
    require(schema_signature(db) == expected, "ANALYTICS_SCHEMA")
    require(dict(db.execute("SELECT key,value FROM analytics_meta").fetchall()) == {"schemaVersion": "1", "receiverId": config["cold"]["receiverId"]}, "ANALYTICS_RECEIVER")


def open_engine(config, writable=False):
    try:
        import duckdb
    except ImportError:
        raise Refusal("ANALYTICS_DEPENDENCY") from None
    require(duckdb.__version__ == "1.5.6", "ANALYTICS_DEPENDENCY")
    directory = config["directory"]
    if writable:
        receiver.private_directory(directory)
        if os.name != "nt":
            require(not directory.stat().st_mode & 0o077, "ANALYTICS_STORAGE")
    require(directory.is_dir(), "ANALYTICS_UNAVAILABLE")
    filename = local_path(directory / "analytics.duckdb")
    require(writable or filename.is_file(), "ANALYTICS_UNAVAILABLE")
    existed = filename.exists()
    if existed:
        private_file(filename)
    # Spill is disabled deliberately: memory pressure refuses this projection or
    # query instead of allocating an unbounded temporary file on either host.
    settings = {
        "threads": str(config["threads"]), "memory_limit": str(config["memoryLimitMb"]) + "MB",
        "max_temp_directory_size": "0B", "enable_external_access": "false",
        "autoload_known_extensions": "false", "autoinstall_known_extensions": "false"}
    with contextlib.closing(duckdb.connect(":memory:", config=settings)) as reference:
        reference.execute(SCHEMA)
        expected = schema_signature(reference)
    # Reject an unrelated, wrong-receiver or altered existing file using a
    # read-only connection before obtaining any writable connection or chmod.
    if existed and writable:
        with contextlib.closing(duckdb.connect(str(filename), read_only=True, config=settings)) as existing:
            verify_projection(existing, config, expected)
    db = duckdb.connect(str(filename), read_only=not writable, config=settings)
    try:
        if writable and not existed:
            if os.name != "nt":
                os.chmod(filename, 0o600)
            db.execute("BEGIN")
            db.execute(SCHEMA)
            db.executemany("INSERT INTO analytics_meta VALUES (?,?)", [("schemaVersion", "1"), ("receiverId", config["cold"]["receiverId"])])
            db.execute("COMMIT")
        verify_projection(db, config, expected)
        return db, duckdb.__version__
    except Exception:
        db.close()
        raise


class Deadline:
    def __init__(self, connection, seconds):
        self.connection = connection
        self.end = time.monotonic() + seconds
        self.expired = False
        self.timer = threading.Timer(seconds, self.interrupt)
        self.timer.daemon = True

    def interrupt(self):
        self.expired = True
        with contextlib.suppress(Exception):
            self.connection.interrupt()

    def check(self):
        require(not self.expired and time.monotonic() < self.end, "ANALYTICS_TIMEOUT")

    def __enter__(self):
        self.timer.start()
        return self

    def __exit__(self, kind, value, traceback):
        self.timer.cancel()
        self.timer.join()
        if self.expired:
            raise Refusal("ANALYTICS_TIMEOUT") from None


def scan_catalog(catalog, db, deadline, limit=0):
    pending, archive_segments, known_segments = [], 0, 0
    cursor = catalog.execute("SELECT raw_sha256,compressed_sha256,segment_path,records,raw_bytes FROM segments ORDER BY first_recorded_ms,raw_sha256")
    while True:
        deadline.check()
        entries = cursor.fetchmany(512)
        if not entries:
            break
        archived = compact([entry[0] for entry in entries])
        known = {row[0]: row[1:] for row in db.execute("SELECT raw_sha256,compressed_sha256,segment_path,records,raw_bytes FROM analytics_segments WHERE raw_sha256 IN (SELECT unnest(from_json(?,'[\"VARCHAR\"]')))", [archived]).fetchall()}
        archive_segments += len(entries)
        for entry in entries:
            old = known.get(entry[0])
            if old is None:
                if len(pending) < limit:
                    pending.append(entry)
            else:
                require(old == entry[1:], "ANALYTICS_INTEGRITY")
                known_segments += 1
    projected_segments, last_at = db.execute("SELECT count(*),max(projected_at) FROM analytics_segments").fetchone()
    require(projected_segments == known_segments, "ANALYTICS_INTEGRITY")
    return pending, {
        "projectedSegments": projected_segments, "pendingSegments": archive_segments - known_segments,
        "projectedItems": db.execute("SELECT count(*) FROM analytics_items").fetchone()[0],
        "archiveItems": catalog.execute("SELECT count(*) FROM items").fetchone()[0], "lastProjectedAt": last_at}


def milliseconds(day):
    require(isinstance(day, str) and DAY.fullmatch(day))
    year, month, date = map(int, day.split("-"))
    require(1 <= month <= 12 and 1 <= date <= calendar.monthrange(year, month)[1])
    # The frozen receiver accepts Gregorian year 0000, which datetime.date
    # cannot represent. Integer civil-day arithmetic also avoids timezone and
    # float conversions at the supported date endpoints.
    def before_year(y):
        return 365 * y + (y + 3) // 4 - (y + 99) // 100 + (y + 399) // 400
    days = before_year(year) + sum(calendar.monthrange(year, m)[1] for m in range(1, month)) + date - 1
    return (days - before_year(1970)) * 86400000


def item_values(record, line):
    row, table = record["row"], record["table"]
    version = record["version"]
    require((version == 1 and table in receiver.V1_TABLES) or (version == 2 and table == "usage_samples_v2") or (version == 3 and table == "github_metadata") or (version == 4 and table == "process_observations"), "ANALYTICS_FAMILY")
    day = row.get("day")
    logical = causal = effective = response_id = account = signature = None
    received = row.get("received_ms")
    counters = [row.get(k) for k in ("input_tokens", "cached_input_tokens", "uncached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens")]
    if table == "usage_daily":
        logical = compact([row[k] for k in ("host_id", "session_id", "day", "segment_key")])
        causal = row["last_ms"]
    elif table == "account_usage_daily":
        logical = compact([row[k] for k in ("host_id", "account_identity", "day")])
        causal, account = row["observed_ms"], row["account_identity"]
        counters = [None, None, None, None, None, None, row["tokens"]]
    elif table == "usage_samples_v2":
        effective = row["source_ms"] if row["source_ms"] is not None else received
        if row["native_response_id"] and row["native_turn_id"]:
            response_id = compact([row[k] for k in ("host_id", "session_id", "native_thread_id", "native_response_id")])
        keys = receiver.V2_COUNTERS + ["native_session_id", "native_turn_id", "native_root_turn_id", "project", "context_provider", "context_model", "context_effort", "context_service_tier", "context_speed"]
        signature = compact([row[k] for k in keys])
    elif version == 3 and table == "github_metadata":
        # This independently closed metadata family is preserved, not treated
        # as token usage. An older receiver must still refuse it: the analytics
        # adapter never substitutes its own validator for the owning family.
        receiver.validate_record(record)
        counters = [None] * 7
        signature = compact([row[k] for k in ("source_id", "host_id", "project", "epoch", "sequence", "payload")])
    elif version == 4 and table == "process_observations":
        receiver.validate_record(record)
        counters = [None] * 7
        signature = row["digest"]
    if signature is None:
        signature = compact([row[k] for k in receiver.TABLES[table][0] if k != "received_ms"])
    return (record["itemId"], hashlib.sha256(line).hexdigest(), line.decode("utf-8") + "\n",
            record["version"], record["sequence"], table, compact(record["rowKey"]), compact(row), record["recordedAt"],
            row["host_id"], row.get("project"), row.get("session_id"), day, milliseconds(day) if day else None,
            logical, causal, received, effective, row.get("sample_key"), row.get("usage_scope"), row.get("accounting_class"),
            response_id, signature, account, *counters)


def insert_rows(db, table, rows):
    require(table in ("analytics_items", "analytics_membership"))
    if rows:
        # Transform the bounded batch once into typed structs. json_each plus
        # repeated extraction duplicates parse allocations; scalar Python
        # bindings are disproportionately costly. Both SQL and struct are fixed.
        keys = ["c" + str(i) for i in range(len(rows[0]))]
        structure = compact([{key: "VARCHAR" for key in keys}])
        values = compact([dict(zip(keys, row)) for row in rows])
        db.execute("INSERT INTO " + table + " SELECT value.* FROM unnest(from_json(?,?)) batch(value)", [values, structure])


def sync(config, limit):
    require(integer(limit, 1, 32))
    with contextlib.closing(open_catalog(config)) as catalog:
        db, version = open_engine(config, True)
        with contextlib.closing(db), Deadline(db, config["queryTimeoutSeconds"]) as deadline:
            pending, _ = scan_catalog(catalog, db, deadline, limit)
            imported = imported_items = raw_bytes = 0
            for raw_sha, compressed_sha, relative, count, size in pending:
                deadline.check()
                receiver.validate_storage(config["cold"])
                _, raw, records, manifest = receiver.checked_segment(config["cold"], relative)
                require((manifest["rawSha256"], manifest["compressedSha256"], manifest["records"], manifest["rawBytes"]) == (raw_sha, compressed_sha, count, size), "ANALYTICS_INTEGRITY")
                db.execute("BEGIN")
                try:
                    values, memberships = [], []
                    prior_items = {row[0]: row[1:] for row in db.execute("SELECT item_id,record_sha256,canonical_line FROM analytics_items WHERE item_id IN (SELECT json_extract_string(value,'$') FROM json_each(?))", [compact([entry[0]["itemId"] for entry in records])]).fetchall()}
                    for ordinal, (record, line, _) in enumerate(records):
                        deadline.check()
                        digest = hashlib.sha256(line).hexdigest()
                        prior = prior_items.get(record["itemId"])
                        require(prior is None or prior == (digest, line.decode("utf-8") + "\n"), "ANALYTICS_INTEGRITY")
                        if prior is None:
                            values.append(item_values(record, line))
                        memberships.append((raw_sha, record["itemId"], ordinal))
                    insert_rows(db, "analytics_items", values)
                    insert_rows(db, "analytics_membership", memberships)
                    db.execute("INSERT INTO analytics_segments VALUES (?,?,?,?,?,?)", [raw_sha, compressed_sha, relative, count, size, utc_now()])
                    deadline.check()
                    db.execute("COMMIT")
                    imported += 1
                    imported_items += len(values)
                    raw_bytes += len(raw)
                except Exception:
                    with contextlib.suppress(Exception):
                        db.execute("ROLLBACK")
                    raise
            _, health = scan_catalog(catalog, db, deadline)
            return {"version": 1, "engine": "duckdb", "engineVersion": version, "receiverId": config["cold"]["receiverId"], "generatedAt": utc_now(),
                    "importedSegments": imported, "importedItems": imported_items, "importedRawBytes": raw_bytes, **health}


def validate_query(value):
    required = {"version", "report", "fromDay", "toDay", "allowedHostIds"}
    require(type(value) is dict and required <= set(value) <= required | {"hostId", "project", "source", "limit"})
    require(type(value["version"]) is int and value["version"] == 1 and value["report"] in ("daily", "responses"))
    for key in ("fromDay", "toDay"):
        require(isinstance(value[key], str) and DAY.fullmatch(value[key]))
    start, end = milliseconds(value["fromDay"]), milliseconds(value["toDay"])
    require(0 <= (end - start) // 86400000 <= 3659)
    hosts = value["allowedHostIds"]
    require(type(hosts) is list and len(hosts) <= 64 and all(label(v) for v in hosts) and len(set(hosts)) == len(hosts))
    for key in ("hostId", "project"):
        require(key not in value or label(value[key]))
    require("hostId" not in value or value["hostId"] in hosts, "ANALYTICS_SCOPE")
    if value["report"] == "daily":
        require(value.get("source") in ("session-deltas", "account-daily"))
        require(value["source"] != "account-daily" or "project" not in value, "ANALYTICS_SCOPE")
    else:
        require("source" not in value)
    value.setdefault("limit", 100)
    require(integer(value["limit"], 1, 1000))
    return value


def host_clause(request):
    hosts = [request["hostId"]] if "hostId" in request else request["allowedHostIds"]
    return ("host_id IN (" + ",".join("?" for _ in hosts) + ")" if hosts else "FALSE"), hosts


def rows_dict(cursor):
    keys = [column[0] for column in cursor.description]
    return [dict(zip(keys, row)) for row in cursor.fetchall()]


def daily_report(db, request):
    clause, args = host_clause(request)
    account = request["source"] == "account-daily"
    source = "account_usage_daily" if account else "usage_daily"
    project_clause = " AND project=?" if "project" in request else ""
    filtered_args = [request["fromDay"], request["toDay"]] + ([request["project"]] if "project" in request else [])
    qualifier = "coalesce(causal_ms<=received_ms AND day_ms<=received_ms,FALSE)" if account else "TRUE"
    rank = "causal_ms DESC,received_ms DESC" if account else "causal_ms DESC"
    cte = f"""WITH scoped AS (SELECT * FROM analytics_items WHERE source_table='{source}' AND {clause}),
     qualified AS (SELECT *,dense_rank() OVER(PARTITION BY logical_key ORDER BY {rank}) AS causal_rank FROM scoped WHERE {qualifier}),
     top_versions AS (SELECT * FROM qualified WHERE causal_rank=1),
     conflicts AS (SELECT logical_key,count(DISTINCT semantic_signature)>1 AS conflict FROM top_versions GROUP BY logical_key),
     latest AS (SELECT t.*,c.conflict,row_number() OVER(PARTITION BY t.logical_key ORDER BY recorded_at DESC,source_sequence DESC,item_id DESC) AS chosen FROM top_versions t JOIN conflicts c USING(logical_key)),
     selected AS (SELECT * FROM latest WHERE chosen=1 AND day>=? AND day<=?{project_clause})"""
    names = [("input", "input_tokens"), ("cached", "cached_tokens"), ("uncached", "uncached_tokens"), ("output", "output_tokens"), ("total", "total_tokens")]
    sums = ",".join(f"sum(CASE WHEN NOT conflict THEN {column} END) AS {name},count(CASE WHEN NOT conflict THEN {column} END) AS known_{name}" for name, column in names)
    groups = cte + f" SELECT day,host_id,project,account_identity,count(CASE WHEN NOT conflict THEN 1 END) AS records,{sums} FROM selected GROUP BY day,host_id,project,account_identity"
    parameters = args + filtered_args
    matched = db.execute("SELECT count(*) FROM (" + groups + ")", parameters).fetchone()[0]
    raw_rows = rows_dict(db.execute(groups + " ORDER BY day,host_id,project NULLS FIRST,account_identity NULLS FIRST LIMIT ?", parameters + [request["limit"]]))
    conflict_count = db.execute(cte + " SELECT count(*) FROM selected WHERE conflict", parameters).fetchone()[0]
    excluded = db.execute(f"SELECT count(*) FROM analytics_items WHERE source_table='{source}' AND {clause} AND NOT ({qualifier}) AND day>=? AND day<=?{project_clause}", args + filtered_args).fetchone()[0]
    rows = [{"day": r["day"], "hostId": r["host_id"], "project": r["project"], "accountIdentity": r["account_identity"], "source": request["source"], "records": r["records"],
             "values": {name: str(r[name]) if r[name] is not None else None for name, _ in names}, "known": {name: r["known_" + name] for name, _ in names}} for r in raw_rows]
    return rows, matched, conflict_count, excluded


def response_report(db, request):
    clause, args = host_clause(request)
    project_clause = " AND project=?" if "project" in request else ""
    # Reconcile all allowed evidence before time/project filters. First receipt
    # represents a replayed sample, so an undated replay cannot renew its age.
    cte = f"""WITH replay AS (SELECT *,row_number() OVER(PARTITION BY sample_key ORDER BY received_ms,recorded_at,item_id) AS sample_rank FROM analytics_items WHERE source_table='usage_samples_v2' AND {clause}),
     samples AS (SELECT * FROM replay WHERE sample_rank=1),
     identities AS (SELECT response_identity,count(DISTINCT semantic_signature) AS signatures FROM samples WHERE usage_scope='response' AND accounting_class='candidate' AND response_identity IS NOT NULL GROUP BY response_identity),
     classified AS (SELECT s.*,CASE WHEN usage_scope<>'response' OR accounting_class<>'candidate' THEN 'excluded'
       WHEN response_identity IS NULL THEN 'missing' WHEN signatures>1 THEN 'conflict'
       WHEN row_number() OVER(PARTITION BY response_identity,usage_scope,accounting_class ORDER BY effective_ms DESC,received_ms DESC,sample_key DESC)=1 THEN 'response' ELSE 'duplicate' END AS disposition
       FROM samples s LEFT JOIN identities USING(response_identity)),
     selected AS (SELECT * FROM classified WHERE effective_ms>=? AND effective_ms<?{project_clause})"""
    parameters = args + [milliseconds(request["fromDay"]), milliseconds(request["toDay"]) + 86400000] + ([request["project"]] if "project" in request else [])
    fields = [("input", "input_tokens"), ("cached", "cached_tokens"), ("cacheWrite", "cache_write_tokens"), ("output", "output_tokens"), ("reasoning", "reasoning_tokens"), ("total", "total_tokens")]
    metric_sql = ",".join(f"sum(CASE WHEN disposition='response' THEN {column} END) AS {name},count(CASE WHEN disposition='response' THEN {column} END) AS known_{name}" for name, column in fields)
    ratio_sql = []
    for name, numerator, denominator in (("cache", "cached_tokens", "input_tokens"), ("reason", "reasoning_tokens", "output_tokens")):
        comparable = f"disposition='response' AND {numerator} IS NOT NULL AND {denominator} IS NOT NULL AND {numerator}<={denominator}"
        ratio_sql.extend([f"sum(CASE WHEN {comparable} THEN {numerator} END) AS {name}_n", f"sum(CASE WHEN {comparable} THEN {denominator} END) AS {name}_d", f"count(CASE WHEN {comparable} THEN 1 END) AS {name}_count"])
    percentiles = ",".join(f"quantile_cont(CASE WHEN disposition='response' THEN {column} END,{fraction}) AS {name}" for name, column, fraction in (("totalP50", "total_tokens", ".5"), ("totalP95", "total_tokens", ".95"), ("outputP50", "output_tokens", ".5"), ("outputP95", "output_tokens", ".95")))
    counts = ",".join(f"count(CASE WHEN disposition='{status}' THEN 1 END) AS {name}" for name, status in (("responseCount", "response"), ("duplicateRows", "duplicate"), ("conflictRows", "conflict"), ("identityMissingRows", "missing"), ("excludedRows", "excluded")))
    groups = cte + f" SELECT host_id,project,{counts},{metric_sql},{','.join(ratio_sql)},{percentiles} FROM selected GROUP BY host_id,project"
    matched = db.execute("SELECT count(*) FROM (" + groups + ")", parameters).fetchone()[0]
    raw_rows = rows_dict(db.execute(groups + " ORDER BY host_id,project NULLS FIRST LIMIT ?", parameters + [request["limit"]]))
    conflict_count, excluded = db.execute(cte + " SELECT count(CASE WHEN disposition='conflict' THEN 1 END),count(CASE WHEN disposition IN ('excluded','missing') THEN 1 END) FROM selected", parameters).fetchone()
    rows = []
    for row in raw_rows:
        ratios, ratio_coverage = {}, {}
        for name, prefix, subtract in (("cacheHit", "cache", False), ("reasoningShare", "reason", False), ("newInputFraction", "cache", True)):
            n, d, comparable = row[prefix + "_n"], row[prefix + "_d"], row[prefix + "_count"]
            if subtract and n is not None:
                n = d - n
            ratios[name] = n / d if d is not None and d > 0 else None
            ratio_coverage[name] = {"numerator": str(n) if n is not None else None, "denominator": str(d) if d is not None else None, "comparableRows": comparable, "excludedRows": row["responseCount"] - comparable}
        values = {key: row[key] for key in ("responseCount", "duplicateRows", "conflictRows", "identityMissingRows", "excludedRows")}
        rows.append({"hostId": row["host_id"], "project": row["project"], **values,
                     "totals": {name: str(row[name]) if row[name] is not None else None for name, _ in fields},
                     "known": {name: row["known_" + name] for name, _ in fields}, "ratios": ratios, "ratioCoverage": ratio_coverage,
                     "percentiles": {name: row[name] for name in ("totalP50", "totalP95", "outputP50", "outputP95")}})
    return rows, matched, conflict_count, excluded


def read_report(config, request=None):
    if request is not None:
        request = validate_query(request)
    with contextlib.closing(open_catalog(config)) as catalog:
        db, version = open_engine(config)
        with contextlib.closing(db), Deadline(db, config["queryTimeoutSeconds"]) as deadline:
            db.execute("BEGIN TRANSACTION")
            _, health = scan_catalog(catalog, db, deadline)
            base = {"version": 1, "engine": "duckdb", "engineVersion": version, "receiverId": config["cold"]["receiverId"], "generatedAt": utc_now()}
            if request is None:
                return {**base, **health}
            rows, matched, conflicts, excluded = daily_report(db, request) if request["report"] == "daily" else response_report(db, request)
            deadline.check()
            return {**base, "report": request["report"], "coverage": {"completeHistory": False, "source": "verified-archive-projection", "aggregation": "known-subtotals", "headReconstruction": "unavailable", **health,
                    "matchedRows": matched, "returnedRows": len(rows), "truncated": matched > len(rows), "conflictRows": conflicts, "excludedRows": excluded}, "rows": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--sync", action="store_true")
    modes.add_argument("--status", action="store_true")
    modes.add_argument("--query", action="store_true")
    parser.add_argument("--limit", type=int, default=32)
    arguments = parser.parse_args()
    os.umask(0o077)
    config = read_configuration(arguments.config)
    if arguments.sync:
        result = sync(config, arguments.limit)
    elif arguments.query:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        require(0 < len(raw) <= MAX_INPUT)
        result = read_report(config, receiver.parse_json(raw))
    else:
        result = read_report(config)
    encoded = (compact(result) + "\n").encode("utf-8")
    require(len(encoded) <= MAX_OUTPUT, "ANALYTICS_OUTPUT_LIMIT")
    sys.stdout.buffer.write(encoded)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Source data, paths, SQL, Python traceback and OS diagnostics are private.
        code = error.code if isinstance(error, Refusal) else "ANALYTICS_UNAVAILABLE" if isinstance(error, (ImportError, FileNotFoundError)) else "ANALYTICS_FAILED"
        print(compact({"version": 1, "engine": "duckdb", "error": {"code": code}}), file=sys.stderr)
        sys.exit(1)
