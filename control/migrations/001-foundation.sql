-- P1 metadata-only foundation. No provider credentials, prompts, arguments,
-- raw output, private reasoning or content-derived fingerprints belong here.
CREATE TABLE journal_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  connection_epoch TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  last_event_id TEXT NOT NULL,
  last_at_ms INTEGER NOT NULL CHECK (last_at_ms >= 0),
  UNIQUE (actor_id, request_key)
) STRICT;
CREATE INDEX operations_epoch_state ON operations(connection_epoch, state);

CREATE TABLE operation_transitions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE NOT NULL,
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  record_json TEXT NOT NULL,
  record_sha256 TEXT NOT NULL CHECK (length(record_sha256) = 64),
  record_bytes INTEGER NOT NULL CHECK (record_bytes > 0),
  UNIQUE (operation_id, revision)
) STRICT;
CREATE INDEX transitions_operation ON operation_transitions(operation_id, revision);

CREATE TABLE archive_receipts (
  receipt_id TEXT PRIMARY KEY,
  receiver_id TEXT NOT NULL,
  batch_sha256 TEXT NOT NULL CHECK (length(batch_sha256) = 64),
  receipt_json TEXT NOT NULL,
  verified_at_ms INTEGER NOT NULL CHECK (verified_at_ms >= 0)
) STRICT;
CREATE TABLE archived_record_versions (
  event_id TEXT PRIMARY KEY REFERENCES operation_transitions(event_id),
  record_sha256 TEXT NOT NULL CHECK (length(record_sha256) = 64),
  receipt_id TEXT NOT NULL REFERENCES archive_receipts(receipt_id)
) STRICT;
CREATE TABLE journal_counts (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  records INTEGER NOT NULL CHECK (records >= 0),
  record_bytes INTEGER NOT NULL CHECK (record_bytes >= 0),
  pending_records INTEGER NOT NULL CHECK (pending_records >= 0),
  pending_bytes INTEGER NOT NULL CHECK (pending_bytes >= 0)
) STRICT;
INSERT INTO journal_counts VALUES (1, 0, 0, 0, 0);

CREATE TRIGGER count_transition AFTER INSERT ON operation_transitions BEGIN
  UPDATE journal_counts SET records=records+1, record_bytes=record_bytes+NEW.record_bytes,
    pending_records=pending_records+1, pending_bytes=pending_bytes+NEW.record_bytes WHERE id=1;
END;
CREATE TRIGGER count_archived_version AFTER INSERT ON archived_record_versions BEGIN
  UPDATE journal_counts SET pending_records=pending_records-1,
    pending_bytes=pending_bytes-(SELECT record_bytes FROM operation_transitions WHERE event_id=NEW.event_id)
    WHERE id=1;
END;
CREATE TRIGGER exact_archived_version BEFORE INSERT ON archived_record_versions
  WHEN NOT EXISTS (SELECT 1 FROM operation_transitions
    WHERE event_id=NEW.event_id AND record_sha256=NEW.record_sha256)
  BEGIN SELECT RAISE(ABORT, 'archive version mismatch'); END;
CREATE TRIGGER transitions_no_update BEFORE UPDATE ON operation_transitions
  BEGIN SELECT RAISE(ABORT, 'immutable transition'); END;
CREATE TRIGGER transitions_no_delete BEFORE DELETE ON operation_transitions
  BEGIN SELECT RAISE(ABORT, 'immutable transition'); END;
CREATE TRIGGER receipts_no_update BEFORE UPDATE ON archive_receipts
  BEGIN SELECT RAISE(ABORT, 'immutable receipt'); END;
CREATE TRIGGER receipts_no_delete BEFORE DELETE ON archive_receipts
  BEGIN SELECT RAISE(ABORT, 'immutable receipt'); END;
CREATE TRIGGER archived_no_update BEFORE UPDATE ON archived_record_versions
  BEGIN SELECT RAISE(ABORT, 'immutable archive version'); END;
CREATE TRIGGER archived_no_delete BEFORE DELETE ON archived_record_versions
  BEGIN SELECT RAISE(ABORT, 'immutable archive version'); END;

-- Reserved projections for later P2-P6 implementations. P1 exposes no mutators
-- for these tables and cannot issue grants, enroll a host or own a runtime.
CREATE TABLE control_grants (
  grant_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, host_id TEXT NOT NULL,
  project_id TEXT NOT NULL, provider_profile_id TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
  expires_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER,
  metadata_json TEXT NOT NULL
) STRICT;
CREATE TABLE host_enrollments (
  host_id TEXT PRIMARY KEY, identity_ref TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  state TEXT NOT NULL CHECK (state IN ('PENDING','ACTIVE','REVOKED')),
  metadata_json TEXT NOT NULL
) STRICT;
CREATE TABLE runtime_owners (
  runtime_id TEXT PRIMARY KEY, host_id TEXT NOT NULL,
  provider_profile_id TEXT NOT NULL, project_id TEXT NOT NULL,
  ownership_fence INTEGER NOT NULL CHECK (ownership_fence > 0),
  connection_epoch TEXT NOT NULL, state TEXT NOT NULL, metadata_json TEXT NOT NULL
) STRICT;
CREATE TABLE owned_sessions (
  session_id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL,
  host_id TEXT NOT NULL, provider_profile_id TEXT NOT NULL, project_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL, policy_revision INTEGER NOT NULL,
  state TEXT NOT NULL, metadata_json TEXT NOT NULL
) STRICT;
CREATE TABLE native_request_refs (
  request_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL, connection_epoch TEXT NOT NULL,
  request_kind TEXT NOT NULL, state TEXT NOT NULL, metadata_json TEXT NOT NULL
) STRICT;
CREATE TABLE terminal_sessions (
  terminal_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, project_id TEXT NOT NULL,
  runtime_id TEXT, ownership_fence INTEGER NOT NULL,
  connection_epoch TEXT NOT NULL, state TEXT NOT NULL, metadata_json TEXT NOT NULL
) STRICT;
CREATE TABLE delivery_cursors (
  consumer_id TEXT PRIMARY KEY, journal_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0)
) STRICT;
PRAGMA user_version=1;
