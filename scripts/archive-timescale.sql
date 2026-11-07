-- Author: Bishop Crockett
-- Owner: Argellan.com
-- License: MIT
-- SPDX-License-Identifier: MIT
-- Attribution covers ARGELLAN-authored implementation and modifications only.
-- Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-- R14 optional, rebuildable query projection. Authoritative bytes remain in the
-- checksum-verified cold archive. Apply only to a dedicated, LOCAL engine volume.
-- Usage: sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d codexcontrol_archive -f archive-timescale.sql
-- The receiver's OS account codexarchive uses local peer authentication; no
-- password, public port, connection URL or unrelated application tables are required.
\set ON_ERROR_STOP on
DO $guard$
BEGIN
 IF current_database() <> 'codexcontrol_archive' THEN
  RAISE EXCEPTION 'Refusing a database other than codexcontrol_archive';
 END IF;
END $guard$;

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE SCHEMA IF NOT EXISTS codexcontrol_archive;
REVOKE ALL ON SCHEMA codexcontrol_archive FROM PUBLIC;

CREATE TABLE IF NOT EXISTS codexcontrol_archive.item_catalog (
 item_id text PRIMARY KEY CHECK(item_id ~ '^[a-f0-9]{64}$'),
 record_sha256 text NOT NULL CHECK(record_sha256 ~ '^[a-f0-9]{64}$'),
 segment_sha256 text NOT NULL CHECK(segment_sha256 ~ '^[a-f0-9]{64}$'),
 recorded_at timestamptz NOT NULL,
 projected_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS codexcontrol_archive.usage_versions (
 recorded_at timestamptz NOT NULL,
 item_id text NOT NULL,
 source_sequence bigint NOT NULL CHECK(source_sequence > 0),
 source_table text NOT NULL CHECK(source_table IN ('usage_baselines','usage_observations','usage_daily','account_usage_observations','account_usage_daily')),
 source_row_key jsonb NOT NULL,
 host_id text NOT NULL,
 project text,
 row_data jsonb NOT NULL,
 record_sha256 text NOT NULL,
 segment_sha256 text NOT NULL,
 PRIMARY KEY(recorded_at,item_id)
);
SELECT create_hypertable('codexcontrol_archive.usage_versions','recorded_at',
 chunk_time_interval=>INTERVAL '7 days',if_not_exists=>true);
CREATE INDEX IF NOT EXISTS usage_versions_worker
 ON codexcontrol_archive.usage_versions(host_id,project,recorded_at DESC);
CREATE INDEX IF NOT EXISTS usage_versions_source
 ON codexcontrol_archive.usage_versions(source_table,recorded_at DESC);

-- Additive V2 projection: never alter/rewrite the V1 hypertable or its CHECK.
-- Full typed source rows remain in row_data and the independent cold segments.
CREATE TABLE IF NOT EXISTS codexcontrol_archive.usage_sample_versions_v2 (
 recorded_at timestamptz NOT NULL,
 item_id text NOT NULL,
 source_sequence bigint NOT NULL CHECK(source_sequence > 0),
 sample_key text NOT NULL CHECK(sample_key ~ '^[a-f0-9]{64}$'),
 host_id text NOT NULL,
 session_id text NOT NULL,
 project text,
 usage_scope text NOT NULL CHECK(usage_scope IN ('thread-total','last-response','response','turn-total')),
 accounting_class text NOT NULL CHECK(accounting_class IN ('candidate','fork-excluded','execution-excluded','unknown')),
 input_tokens bigint CHECK(input_tokens BETWEEN 0 AND 9007199254740991),
 cached_input_tokens bigint CHECK(cached_input_tokens BETWEEN 0 AND 9007199254740991),
 cache_write_input_tokens bigint CHECK(cache_write_input_tokens BETWEEN 0 AND 9007199254740991),
 output_tokens bigint CHECK(output_tokens BETWEEN 0 AND 9007199254740991),
 reasoning_output_tokens bigint CHECK(reasoning_output_tokens BETWEEN 0 AND 9007199254740991),
 total_tokens bigint CHECK(total_tokens BETWEEN 0 AND 9007199254740991),
 reported_mask smallint NOT NULL CHECK(reported_mask BETWEEN 0 AND 63),
 provider_reported_mask smallint NOT NULL CHECK(provider_reported_mask BETWEEN 0 AND 63),
 synthesized_mask smallint NOT NULL CHECK(synthesized_mask BETWEEN 0 AND 63),
 row_data jsonb NOT NULL CHECK(jsonb_typeof(row_data)='object'),
 record_sha256 text NOT NULL,
 segment_sha256 text NOT NULL,
 CHECK((provider_reported_mask & ~reported_mask)=0 AND (synthesized_mask & ~reported_mask)=0 AND (provider_reported_mask & synthesized_mask)=0),
 CHECK((reported_mask & 1)<>0 OR input_tokens IS NULL),
 CHECK((reported_mask & 2)<>0 OR cached_input_tokens IS NULL),
 CHECK((reported_mask & 4)<>0 OR cache_write_input_tokens IS NULL),
 CHECK((reported_mask & 8)<>0 OR output_tokens IS NULL),
 CHECK((reported_mask & 16)<>0 OR reasoning_output_tokens IS NULL),
 CHECK((reported_mask & 32)<>0 OR total_tokens IS NULL),
 PRIMARY KEY(recorded_at,item_id)
);
SELECT create_hypertable('codexcontrol_archive.usage_sample_versions_v2','recorded_at',
 chunk_time_interval=>INTERVAL '7 days',if_not_exists=>true);
CREATE INDEX IF NOT EXISTS usage_sample_versions_v2_worker
 ON codexcontrol_archive.usage_sample_versions_v2(host_id,project,recorded_at DESC);
CREATE INDEX IF NOT EXISTS usage_sample_versions_v2_scope
 ON codexcontrol_archive.usage_sample_versions_v2(usage_scope,accounting_class,recorded_at DESC);

-- Feature-detect the installed 2.x API. The old compression API is retained only
-- for older self-hosted versions; >=2.20 uses the current columnstore procedure.
-- No age-based deletion/retention policy is installed, on either branch.
DO $compression$
DECLARE minor integer;
BEGIN
 SELECT split_part(extversion,'.',2)::integer INTO minor
 FROM pg_extension WHERE extname='timescaledb';
 IF minor >= 20 AND EXISTS(SELECT 1 FROM pg_proc WHERE proname='add_columnstore_policy' AND prokind='p') THEN
  EXECUTE 'ALTER TABLE codexcontrol_archive.usage_versions SET (timescaledb.enable_columnstore=true,timescaledb.segmentby=''source_table,host_id'',timescaledb.orderby=''recorded_at DESC'')';
  EXECUTE 'CALL add_columnstore_policy(''codexcontrol_archive.usage_versions'',after=>INTERVAL ''7 days'',if_not_exists=>true)';
 ELSE
  EXECUTE 'ALTER TABLE codexcontrol_archive.usage_versions SET (timescaledb.compress=true,timescaledb.compress_segmentby=''source_table,host_id'',timescaledb.compress_orderby=''recorded_at DESC'')';
  PERFORM add_compression_policy('codexcontrol_archive.usage_versions',INTERVAL '7 days',if_not_exists=>true);
 END IF;
END $compression$;

DO $sample_compression$
DECLARE minor integer;
BEGIN
 SELECT split_part(extversion,'.',2)::integer INTO minor
 FROM pg_extension WHERE extname='timescaledb';
 IF minor >= 20 AND EXISTS(SELECT 1 FROM pg_proc WHERE proname='add_columnstore_policy' AND prokind='p') THEN
  EXECUTE 'ALTER TABLE codexcontrol_archive.usage_sample_versions_v2 SET (timescaledb.enable_columnstore=true,timescaledb.segmentby=''usage_scope,host_id'',timescaledb.orderby=''recorded_at DESC'')';
  EXECUTE 'CALL add_columnstore_policy(''codexcontrol_archive.usage_sample_versions_v2'',after=>INTERVAL ''7 days'',if_not_exists=>true)';
 ELSE
  EXECUTE 'ALTER TABLE codexcontrol_archive.usage_sample_versions_v2 SET (timescaledb.compress=true,timescaledb.compress_segmentby=''usage_scope,host_id'',timescaledb.compress_orderby=''recorded_at DESC'')';
  PERFORM add_compression_policy('codexcontrol_archive.usage_sample_versions_v2',INTERVAL '7 days',if_not_exists=>true);
 END IF;
END $sample_compression$;

-- The private projector creates pg_temp.codexcontrol_projection_batch with COPY.
-- Its JSON values, source keys and even hostile-looking project labels are data,
-- never interpolated SQL. The regular item catalog enforces global idempotency
-- separately from the hypertable's mandatory time-inclusive primary key.
CREATE OR REPLACE FUNCTION codexcontrol_archive.ingest_usage_batch()
RETURNS bigint LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,codexcontrol_archive
AS $ingest$
DECLARE value jsonb; record jsonb; existing_hash text; inserted bigint:=0;
BEGIN
 PERFORM pg_advisory_xact_lock(47381725,1401);
 IF (SELECT count(*) FROM pg_temp.codexcontrol_projection_batch)>1000 THEN
  RAISE EXCEPTION 'Projection batch bound exceeded';
 END IF;
 FOR value IN SELECT batch.value FROM pg_temp.codexcontrol_projection_batch AS batch LOOP
  record:=value->'record';
  IF NOT coalesce(record->>'itemId' ~ '^[a-f0-9]{64}$'
   AND value->>'recordSha256' ~ '^[a-f0-9]{64}$'
   AND value->>'segmentSha256' ~ '^[a-f0-9]{64}$'
   AND ((record->>'version'='1' AND record->>'table' IN ('usage_baselines','usage_observations','usage_daily','account_usage_observations','account_usage_daily'))
    OR (record->>'version'='2' AND record->>'table'='usage_samples_v2'
     AND record->'row'->>'sample_key' ~ '^[a-f0-9]{64}$'
     AND record->'rowKey'=jsonb_build_object('sample_key',record->'row'->>'sample_key')))
   AND jsonb_typeof(record->'row')='object' AND jsonb_typeof(record->'rowKey')='object'
   AND (record->>'sequence')::bigint>0 AND length(record->'row'->>'host_id') BETWEEN 1 AND 256,false) THEN
   RAISE EXCEPTION 'Invalid usage projection record';
  END IF;
  SELECT record_sha256 INTO existing_hash FROM codexcontrol_archive.item_catalog WHERE item_id=record->>'itemId';
  IF FOUND THEN
   IF existing_hash<>value->>'recordSha256' THEN
    RAISE EXCEPTION 'Immutable projection item conflict';
   END IF;
   CONTINUE;
  END IF;
  INSERT INTO codexcontrol_archive.item_catalog(item_id,record_sha256,segment_sha256,recorded_at)
  VALUES(record->>'itemId',value->>'recordSha256',value->>'segmentSha256',(record->>'recordedAt')::timestamptz);
  IF record->>'version'='1' THEN
   INSERT INTO codexcontrol_archive.usage_versions(recorded_at,item_id,source_sequence,source_table,source_row_key,host_id,project,row_data,record_sha256,segment_sha256)
   VALUES((record->>'recordedAt')::timestamptz,record->>'itemId',(record->>'sequence')::bigint,record->>'table',record->'rowKey',record->'row'->>'host_id',record->'row'->>'project',record->'row',value->>'recordSha256',value->>'segmentSha256');
  ELSE
   INSERT INTO codexcontrol_archive.usage_sample_versions_v2(recorded_at,item_id,source_sequence,sample_key,host_id,session_id,project,usage_scope,accounting_class,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,reported_mask,provider_reported_mask,synthesized_mask,row_data,record_sha256,segment_sha256)
   VALUES((record->>'recordedAt')::timestamptz,record->>'itemId',(record->>'sequence')::bigint,record->'row'->>'sample_key',record->'row'->>'host_id',record->'row'->>'session_id',record->'row'->>'project',record->'row'->>'usage_scope',record->'row'->>'accounting_class',(record->'row'->>'input_tokens')::bigint,(record->'row'->>'cached_input_tokens')::bigint,(record->'row'->>'cache_write_input_tokens')::bigint,(record->'row'->>'output_tokens')::bigint,(record->'row'->>'reasoning_output_tokens')::bigint,(record->'row'->>'total_tokens')::bigint,(record->'row'->>'reported_mask')::smallint,(record->'row'->>'provider_reported_mask')::smallint,(record->'row'->>'synthesized_mask')::smallint,record->'row',value->>'recordSha256',value->>'segmentSha256');
  END IF;
  inserted:=inserted+1;
 END LOOP;
 RETURN inserted;
END $ingest$;
REVOKE ALL ON FUNCTION codexcontrol_archive.ingest_usage_batch() FROM PUBLIC;

-- Capturing a late historical report must not make it the current day total.
-- Keep every raw version; this analytical view selects a causally qualified
-- account source time (not a future source/day), or the latest worker last_ms.
-- source_sequence only breaks capture ties: it can restart after a Pi restore.
CREATE OR REPLACE VIEW codexcontrol_archive.latest_daily_versions AS
 WITH qualified AS (
  SELECT recorded_at,item_id,source_sequence,source_table,source_row_key,host_id,
   project,row_data,record_sha256,segment_sha256
  FROM codexcontrol_archive.usage_versions
  WHERE source_table='usage_daily'
   OR (source_table='account_usage_daily'
    AND (row_data->>'observed_ms')::bigint <= (row_data->>'received_ms')::bigint
    AND (row_data->>'day') <= to_char(
     to_timestamp((row_data->>'received_ms')::numeric/1000) AT TIME ZONE 'UTC','YYYY-MM-DD'))
 )
 SELECT DISTINCT ON (source_table,source_row_key)
  recorded_at,item_id,source_sequence,source_table,source_row_key,host_id,
  project,row_data,record_sha256,segment_sha256
 FROM qualified
 ORDER BY source_table,source_row_key,
  CASE WHEN source_table='account_usage_daily' THEN (row_data->>'observed_ms')::bigint
   ELSE (row_data->>'last_ms')::bigint END DESC,
  CASE WHEN source_table='account_usage_daily' THEN (row_data->>'received_ms')::bigint END DESC,
  recorded_at DESC,source_sequence DESC,item_id DESC;

DO $permissions$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='codexarchive') THEN
  GRANT CONNECT,TEMPORARY ON DATABASE codexcontrol_archive TO codexarchive;
  GRANT USAGE ON SCHEMA codexcontrol_archive TO codexarchive;
  GRANT SELECT,INSERT ON codexcontrol_archive.item_catalog,codexcontrol_archive.usage_versions,codexcontrol_archive.usage_sample_versions_v2 TO codexarchive;
  GRANT SELECT ON codexcontrol_archive.latest_daily_versions TO codexarchive;
  GRANT EXECUTE ON FUNCTION codexcontrol_archive.ingest_usage_batch() TO codexarchive;
 END IF;
END $permissions$;
