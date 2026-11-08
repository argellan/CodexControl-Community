# Process Explorer — read-only MVP candidate

Author: Bishop Crockett. Owner: Argellan.com. License: MIT. SPDX-License-Identifier: MIT.

This candidate is not deployed. It adds a **Processes** entry to Fleet & workers (Fleet on phones), using the existing application typography, color themes, panels, lazy workspace loader and dialog dismissal contract. No process-control action is exposed.

## Collection and custody

The Windows collector is opt-in through `processTelemetry.enabled: true` in its existing private configuration. The same opt-in in a Community runtime's private configuration enables its own local host observation. Both require PowerShell 7 at the existing Windows installation path. No existing configuration is enabled by this change. Linux and macOS process collection are not implemented; absence is reported as not observed, never zero usage.

The collector authenticates and pins the existing hub before checking `/api/collector/process-capabilities`. Unsupported hubs do not initiate sampling. Samples have a minimum 30-second cadence and only one sampling operation can run at a time. The OS sampler derives a limited role locally; raw command lines, private paths, environment variables, tokens, audio, transcripts and document contents are not transported.

Each sanitized capture is first staged in a private durable file. The legacy collector stages alongside its existing outbox, then includes `processSamples` in the pending upload batch. Wrong or missing receipt hashes, network failures and collector restarts preserve pending data. Staging and outbox copies are removed only after the matching committed receipt. A crash between their removal operations safely replays the same batch.

Community standalone and Hub installations stage a local capture before the journal transaction and remove the duplicate staged file only after a matching journal commit confirmation. A Community Node stages before its local commit, retains the capture and frames it into its existing paired-installation outbox; the Hub validates both the complete authenticated envelope and the exact process-sample commit receipt. Older Hubs that cannot accept the new field reject the frame, leaving the Node's pending copy for retry. The sampler runs separately from the normal collection loop. A graceful shutdown waits for an in-flight process sample to be staged and committed before closing; if that cannot be done, shutdown reports failure rather than claiming preservation. An abrupt power loss before the sample reaches its durable stage can still lose that in-flight observation.

The existing local `history.sqlite` stores immutable sanitized frames in `process_observations`, with authenticated host identity, observer epoch, source sequence, observed time, receipt time and SHA-256. Identical retries deduplicate; different content under the same epoch/sequence is rejected. Host state, usage, events and process frames share the existing FULL-synchronous transaction and journal-worker acknowledgement/fencing path.

`process_storage` participates in source storage admission. `process_totals` maintains retained counts and bytes in the same transaction; normal UI polling does not scan the entire history. An earlier isolated draft is upgraded atomically without replacing observations. Indexed reads load at most three frames for current projections; history pagination returns at most three full frames. Each submitted frame batch is limited to 512 KiB. The display renders at most 50 rows, independently of durable retention.

**Off-host process archiving is opt-in and deployment remains held.** Upgrade the receiver to the V4-capable source before enabling `processHistory: true` in the existing private archive sender configuration (at least two batches/run). Existing usage archiving remains enabled independently. Process frames use the same pinned SSH transport, frozen retries and content-addressed immutable segments; receipts bind receiver identity, exact item membership and raw bytes after receiver readback and durable commit. Receiver-side verification can recheck segment/manifest hashes. Local history is retained even after successful verification; no process eviction operation is implemented. The optional analytics projection retains process records without treating them as token usage. If storage admission refuses new data, collector pending files remain. Do not delete these files or treat this as an unlimited-capacity archive solution. Active SQLite remains on local disk, never SMB/NFS.

## Read API and scope

All routes require the existing authenticated viewer. Only GET is accepted.

| Route | Purpose |
| --- | --- |
| `/api/processes/hosts` | Enabled, nonexpired source identities permitted to the viewer; no collector credentials. |
| `/api/processes?host=...` | Current tree or resource projection, server-side search/status/role filtering and bounded pagination. |
| `/api/processes/summary?host=...` | Matching scoped counts and metrics. |
| `/api/processes/detail?host=...&key=...` | One exact host/boot/PID/creation-time process instance and its evidence. |
| `/api/processes/history?host=...&before=...` | Durable safe frames with stable ingest cursors and digests. |

Host authorization, source expiry/disable state and viewer authority are checked server-side, including immediately before response delivery. Responses use the existing bounded compression helper. Gateways preserve upstream denial and do not create individual local viewer grants; individual accounts belong at the authoritative hub.

No supported task/project ownership adapter is attached in this MVP. Project-restricted viewers are denied process metadata. Explicit task/project API queries fail closed. A selected dashboard project blocks host-wide UI inspection rather than merely changing its caption. Task completion, wait leases, reusable-worker leases and suspected leftovers cannot be established by this collector alone. Those lifecycle categories require later supported owner evidence.

## Interpretation and interaction

Private commit, working set, CPU counters and growth are distinct. CPU percentage is explicitly relative to one core; it can exceed 100% for multithreaded work. Growth is derived from at least three valid observations spanning at least 20 seconds. Memory bars compare processes on the displayed page, not total physical RAM or estimated reclaimable memory.

Unknown is legitimate. Quiet CPU does not prove a process is waiting or abandoned. A missing parent does not prove safe termination. Denied, stale and missing observations never become zero memory or inferred exit. Stable process keys include host, boot, PID and creation time; repeated complete scoped absence is separate from partial enumeration.

The workspace updates only while open and visible, at 15-second intervals. Superseded queries are aborted and stale responses rejected. Keyed rows preserve focus; filtering and paging are server-side. Resource/tree views, branch collapse, search, status filters, source choice, exact-instance inspection, Escape and outside-click dismissal share the application's existing interaction patterns. The inspector shows status reasons, confidence, resource samples and observed lifecycle events. It does not speculate about a process's thoughts or task.

## Integration and release holds

This work is isolated from canonical source and the UI worker's separate Projects/Export changes. Shared styles/font assets match that worker's current candidate byte-for-byte; no separate font system was introduced. Integrate the small app entry-point changes with the current UI owner's source rather than replacing its files wholesale.

Targeted Windows/backend and synthetic browser checks are implementation evidence. They are not a Pi qualification, a full-dashboard performance matrix, or physical HP/iOS/iPadOS acceptance. Those release gates and production activation remain held.

Roll back code only after preserving the database and all pending files. Older hubs and receivers can refuse process-bearing batches; never strip those frames to make a retry pass. Prefer disabling future sampling after pending custody has been reconciled. Do not downgrade the journal over unacknowledged data or delete additive schema/history as a rollback shortcut.

## Backup and offline restore contract

Own backups include the complete process observation history, source identities, aggregate counters, verified archive receipts and any frozen in-flight archive batch. Backup inspection is an administrative full-history operation, not a dashboard polling operation.

The strict inspector recognizes four complete historical shapes: journals without Process Explorer; the pre-archive MVP (inspection contract 0); the complete archive schema before the receipt-sequence index (contract 1); and the indexed archive schema (contract 2). These contract numbers describe inspected shapes; older databases did not store a process schema-version marker. Partial object sets are not treated as older schemas. Existing startup migrations add missing *version-level* capabilities without rewriting observations or inventing archive receipts.

Validation compares the application's exact tables, indexes, uniqueness and singleton constraints, and immutable-history/accounting triggers. It verifies canonical safe payloads and hashes, stable source identities, host relationships, aggregate totals and the exact retained records covered by each receipt or frozen retry. Unrecognized fields, changed objects, inconsistent counters and invalid custody fail closed. The backup manifest and file checksums remain mandatory.

Offline replacement refuses outstanding process-history custody as well as outstanding usage custody. Staging does not mutate the active database. The offline command preserves original files and rolls back an interrupted install. Restoring a backup may restore an older frozen retry; it remains pending until the archive receiver verifies that exact batch. Local history is never deleted to satisfy archive admission or restore validation.
