# Control journal migrations

Version 1 creates a new, separate local SQLite metadata journal. It never opens
or migrates an observer database. The initial schema is applied in one immediate
transaction; an interrupted creation is retried only if the database is empty.
An unknown schema version, pre-existing foreign tables or changed migration
identity is refused. There is no automatic downgrade, reset or deletion path.

Operations, transitions and archive receipts are implemented in P1. Grant,
enrollment, runtime, session, native-request, terminal and delivery-cursor tables
reserve the approved projections; their write APIs and enforcement are later
stages. Their existence is not a working control capability.

P2 authority uses authority-001.sql to initialize a separate owner-private
control-authority.sqlite. It does not upgrade control.sqlite or its reserved
projections. Named-principal mappings, manager status, grants, enrollment and
project configuration have typed write APIs in AuthorityStore; immutable audit
and request receipts retain every allowed change. Authority consumption and
manager mutations recheck their current authorization within the same immediate
write transaction. Recovery advances authority generation and preserves the P1
journal and all custody. Neither database is automatically erased or downgraded.

Host ownership uses dedicated rollback-mode lock and fence databases. Their
files are never unlinked to reclaim a stale owner; a real held kernel lock and
durable monotonic counter establish the next ownership generation. These files
are host-local, distinct from both the broker journal and authority database.

A future migration must require a quiescent, fenced writer; create and verify a
local SQLite-consistent backup (including the WAL through SQLite's backup API);
record the exact source schema and backup receipt; migrate transactionally; and
verify preserved logical records before activation. Copying a live database
file alone is not a backup. Version 1 contains no upgrade requiring that path.
Network-mounted active databases and unverified backups are not supported.

P3 uses a separate local codex-lineage.sqlite schema1 owned by CodexSessionRegistry. It initializes only a new database, refuses foreign/newer identities, retains immutable metadata events and never changes the P1/P2 or native provider databases. No downgrade, repair, deletion or automatic upgrade is provided. Its native session references are ownership metadata, not copied provider history.
