-- Separate P2 authority database; never upgrades or rewrites the P1 journal.
CREATE TABLE authority_state(id INTEGER PRIMARY KEY CHECK(id=1),hub_id TEXT NOT NULL,generation INTEGER NOT NULL,policy_revision INTEGER NOT NULL,bootstrap_request TEXT,last_at_ms INTEGER NOT NULL) STRICT;
CREATE TABLE principals(actor_id TEXT PRIMARY KEY,viewer_id TEXT UNIQUE NOT NULL,metadata_json TEXT NOT NULL) STRICT;
CREATE TABLE managers(actor_id TEXT PRIMARY KEY REFERENCES principals(actor_id),enabled INTEGER NOT NULL CHECK(enabled IN(0,1))) STRICT;
CREATE TABLE grants(grant_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL REFERENCES principals(actor_id),host_id TEXT NOT NULL,project_id TEXT NOT NULL,metadata_json TEXT NOT NULL) STRICT;
CREATE INDEX grants_scope ON grants(actor_id,host_id,project_id);
CREATE TABLE hosts(host_id TEXT PRIMARY KEY,metadata_json TEXT NOT NULL) STRICT;
CREATE TABLE pending_hosts(host_id TEXT PRIMARY KEY,metadata_json TEXT NOT NULL) STRICT;
CREATE TABLE projects(project_id TEXT PRIMARY KEY,host_id TEXT NOT NULL,metadata_json TEXT NOT NULL) STRICT;
CREATE TABLE authority_requests(request_id TEXT PRIMARY KEY,actor_id TEXT,kind TEXT NOT NULL,input_sha256 TEXT NOT NULL,receipt_json TEXT NOT NULL) STRICT;
CREATE TABLE authority_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL,metadata_json TEXT NOT NULL,metadata_bytes INTEGER NOT NULL CHECK(metadata_bytes>0)) STRICT;
CREATE TABLE authority_counts(id INTEGER PRIMARY KEY CHECK(id=1),records INTEGER NOT NULL CHECK(records>=0),bytes INTEGER NOT NULL CHECK(bytes>=0)) STRICT;
INSERT INTO authority_counts VALUES(1,0,0);
CREATE TRIGGER audit_count AFTER INSERT ON authority_audit BEGIN UPDATE authority_counts SET records=records+1,bytes=bytes+NEW.metadata_bytes WHERE id=1; END;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON authority_audit BEGIN SELECT RAISE(ABORT,'immutable authority audit'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON authority_audit BEGIN SELECT RAISE(ABORT,'immutable authority audit'); END;
CREATE TRIGGER requests_no_update BEFORE UPDATE ON authority_requests BEGIN SELECT RAISE(ABORT,'immutable authority receipt'); END;
CREATE TRIGGER requests_no_delete BEFORE DELETE ON authority_requests BEGIN SELECT RAISE(ABORT,'immutable authority receipt'); END;
PRAGMA user_version=1;
