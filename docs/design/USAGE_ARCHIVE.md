# Permanent usage archive
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

CodexControl keeps its live SQLite database on the hub's local disk. It sends closed, immutable compressed files to a separate archive receiver. A NAS is suitable for those closed files; it is not the location of the live hub database or of a SQLite catalog accessed over SMB/NFS. Database engines and their active files stay together on local storage.

This preserves captured usage values indefinitely. It cannot recover observations that predate collection, intermediate provider samples the collector never received, or data previously removed by an older release. Existing exclusions for passwords, access tokens, provider credentials, prompts, command arguments, raw output and private reasoning remain in force.

## Storage tiers

| Tier | Location | Purpose | Deletion rule |
| --- | --- | --- | --- |
| Live hub SQLite | Pi local disk | Source checkpoints, sampled burn, hot usage history, transactional archive outbox | A usage row can leave the hot cache only after its exact current version has a verified archive receipt |
| Immutable segments | Receiver local disk or a qualified NAS mount | Lossless gzip NDJSON, manifests and complete source-row versions | No automatic age-based deletion |
| Receiver SQLite catalog | Receiver local disk | Idempotency, indexed queries, verification and rebuild metadata | Rebuildable from verified segments; never a network-mounted active database |
| Optional TimescaleDB | Separate database server, local data volume | SQL analytics over immutable usage versions | No retention deletion policy; optional lossless compression after seven days |

For a NAS supporting Linux containers/SSH, the receiver can run there with its catalog on a local volume. Otherwise a small Linux server runs the receiver, keeps its catalog locally and mounts the NAS only for immutable segments. PostgreSQL/TimescaleDB can run on the same server or another dedicated database host. The Pi does not need to run TimescaleDB.

## Capture and custody

The five V1 archived source tables are session observations, session baselines, session daily deltas, account source snapshots and account source daily totals. SQLite triggers capture inserted and changed row versions in the same transaction as the source checkpoint. A bounded bootstrap captures rows retained before archive support was installed; rows without captured custody cannot be evicted while bootstrap is incomplete.

Source timestamps do not uniquely identify a report. A changed session report at an already recorded timestamp is preserved as a non-burn source revision using the real source row identity. It cannot create a zero-interval token rate. A fresh same-time correction resets the baseline before the next measured interval. Older/future account-day reports are preserved even when they cannot replace the qualified latest-day projection. Old account days are not filtered out at ingestion. Reports without a usable source usage timestamp retain their full sanitized daily buckets rather than receiving an invented date.

Account snapshots normally omit repeated day arrays because separate daily versions retain those values. A bounded hash cache deduplicates explicit source revisions while ignoring receipt-time-only changes. This cache is not evidence or custody: evicting a cache entry never deletes a pending archive item, and an old repeated revision may be captured again after cache expiry. Latest-value projections and immutable historical versions must be distinguished when querying; summing every revised daily total would overcount.

Each outbox item has a random 256-bit identity. The sender freezes an ordered NDJSON batch and its SHA-256 before transmission. A retry uses those exact bytes and member IDs even if new observations arrive. The dedicated SSH connection uses a pinned host key, a dedicated key and a forced receiver command. It disables agent forwarding, port forwarding, interactive authentication and connection multiplexing.

The receiver validates the complete schema and bounded input, writes a content-addressed gzip segment and manifest, fsyncs the files and directories, and commits its local catalog before returning a durable receipt. Raw SHA-256, exact ordered item IDs, count and receiver identity must match before the Pi commits its acknowledgement. A differently encoded gzip of identical raw records is valid: the receipt identifies the retained compressed bytes separately from the received stream's bytes.

An acknowledgement covers a particular immutable version, not a sequence high-water mark or an entire mutable table. An updated daily row needs a new receipt. Historical source revisions do not advance the live row's custody head. Missing, malformed, partial, foreign or mismatched receipts leave the pending batch intact.

## V1 and V2 compatibility

R16 adds the immutable `usage_samples_v2` source table. The five V1 table shapes, canonical column order and record serialization remain unchanged. Existing outbox items, frozen in-flight bodies, receipts, source-version cache entries and NAS segments are preserved. Each V2 row is a separately typed thread total, last-response reading, response reading or turn total. These scopes are observations of different accounting levels; adding them together would count the same work more than once.

| Format | Version | Compatibility rule |
| --- | --- | --- |
| Five legacy source-record types | 1 | Original canonical bytes and strict legacy row shapes remain readable |
| `usage_samples_v2` source record | 2 | Exactly 43 typed columns; primary key `sample_key` |
| Sender batch and durable receipt | 1 | Existing raw hash, ordered item membership, count and receiver identity checks |
| Immutable segment manifest | 1 | Existing content address, file hashes and manifest shape; no old segment rewrite |
| Receiver catalog | Existing local schema | Both record versions can share a segment and be verified, rebuilt and queried |

The sample key is SHA-256 of the compact UTF-8 JSON array of all canonical sample columns except `sample_key` and `received_ms`, in fixed column order. This internal capture identity is separate from a nullable native response ID. The receiver recomputes it before publication. Unknown fields, private payload fields, unsupported versions, version/table mismatches and malformed identities are refused without echoing their values.

The six nullable counters are inclusive input, cached input, cache-write input, inclusive output, numeric reasoning output and total, in that order. Their presence/provenance masks use bits 1, 2, 4, 8, 16 and 32. A missing field stays null. A present but invalid source value may also be null with its reported bit retained. A reported zero is not proof of a separately provider-measured zero: provider and synthesized masks require explicit source evidence, are subsets of the reported mask and cannot overlap. Safe numeric observations are preserved even when their relationships are inconsistent; analytical calculations must qualify comparable values rather than repair the archive.

Configuration attributes are stored under `context_*`; the currently qualified rollout sources do not establish `producing_*` attributes, which remain null. Likewise, absent native thread, turn, session or response IDs are not inferred. Fork, inherited-history and execution-source classifications remain attached to preserved samples instead of causing their removal. Raw host-owned observations are not collapsed across machines merely because the machines are enrolled together.

Deploy and verify a dual-version receiver before enabling V2 sending. The receiver must accept an unchanged V1 retry, V2 records and a mixed batch, with lost-acknowledgement, query and rebuild checks. A hub migration adds the V2 table/indexes/triggers atomically without rewriting existing custody. Preexisting incomplete bootstrap remains incomplete and continues boundedly. A complete bootstrap remains valid because the new table starts empty with capture triggers installed before ingestion.

Backup inspection supports the original V1 journal metadata and manifests. Restore verifies those original bytes before migrating its candidate copy; it must not rewrite a backup to make its manifest match. Pending or in-flight V2 samples require the same current-database restore refusal as V1. Code rollback must use a binary compatible with the current data schema, rather than attempting to downgrade or delete the new table.

The optional Timescale upgrade adds `usage_sample_versions_v2` and dispatches by source-record version. It leaves the legacy hypertable and five-table constraint intact. Typed numeric and scope columns are additional query projections; the full source row remains in `row_data` and the independent immutable segment. A mixed segment is marked projected only after its complete SQL transaction succeeds. Actual Timescale-engine execution and policy verification are separate activation checks; static template tests do not establish engine qualification.

## Failure behavior and resource bounds

Raw 30-day/200,000-row and daily 730-day/200,000-row settings are hot-cache targets, not destruction policies. The account sub-cap and baseline cap are also targets. Unarchived rows remain on the Pi beyond them. Retention deletion is bounded to 1,000 rows per pass. The event journal is separate: V1 has no off-host event archive or receipt path, so unarchived event rows remain on the Pi beyond their configured age, count and byte targets. Older releases could delete event rows; their reported retention floor records the resulting gap. An immutable event archive and receipt-gated hot-cache eviction remain required future work.

The sender performs at most four batches per run, with at most 1,000 records and 2 MiB raw bytes per batch. A run is bounded to 110 seconds; each transfer is bounded and failure-safe. The example systemd service limits CPU and memory and runs at low I/O priority. It does not overlap another invocation. At a one-minute cadence, its configured ceiling is 4,000 row versions per minute; sustained growth above that needs a measured capacity adjustment. Version counts are not token counts.

The administration-only usage dialog reports configuration state, bootstrap, pending versions, oldest pending time and last verified transfer. Restricted viewers do not receive fleet archive counts. A stale success, increasing backlog, disconnected NAS or failed receiver is not reported as completed preservation. Pending data can eventually exhaust local storage during a long outage; capacity must be monitored and expanded or the destination repaired. The program must not silently sacrifice unarchived data to avoid that condition.

NAS mounts require an exact Linux mount-point/source/filesystem pin. If the mount disappears or changes, the receiver fails closed instead of writing into the now-unmounted local directory. The selected filesystem must support atomic hard-link publication and file/directory fsync. A successful synthetic local filesystem test does not qualify an actual NAS.

## Receiver configuration

Keep the receiver config private, owned by the service account. Example paths below are placeholders, not an installed destination:

```json
{
  "receiverId": "11111111-1111-4111-8111-111111111111",
  "catalogDirectory": "/var/lib/codexcontrol-archive/catalog",
  "archiveDirectory": "/srv/codexcontrol-archive/segments"
}
```

For network archive storage add an exact mount identity obtained from the receiver's real mount table:

```json
"expectedArchiveMount": {
  "mountPoint": "/mnt/codexcontrol-archive",
  "source": "nas.example:/export/codexcontrol",
  "filesystem": "nfs4"
}
```

Use a dedicated least-privilege SSH account and a restricted authorized key, for example:

```text
restrict,command="/usr/bin/python3 /opt/codexcontrol/archive-receiver.py --config /etc/codexcontrol/archive-receiver.json" ssh-ed25519 PUBLIC_KEY_ONLY
```

Provision and independently check the actual server identity before pinning it. Do not paste private keys or passwords into commands, public configuration, tickets or logs. See [sender setup](ARCHIVE_SENDER_SETUP.md) for the private sender configuration and disabled scheduling examples.

## Query, verify and restore

The receiver is a forced command, not an unauthenticated HTTP service. Owner-side CLI maintenance supports bounded query/export, full segment verification, catalog rebuild and status:

```bash
python3 /opt/codexcontrol/archive-receiver.py --config /etc/codexcontrol/archive-receiver.json --status
python3 /opt/codexcontrol/archive-receiver.py --config /etc/codexcontrol/archive-receiver.json --verify
python3 /opt/codexcontrol/archive-receiver.py --config /etc/codexcontrol/archive-receiver.json --query --limit 100
```

The segment set is the lossless source. Back up both the receiver catalog and immutable files, and periodically verify and test catalog rebuild. A NAS snapshot is useful additional protection but does not replace independent backup. Protect captured operational metadata with restrictive ACLs, appropriate at-rest encryption and an independent backup location.

Before offline hub restore, stop both the hub and archive timer/service. Restore acquires the same exclusive database replacement lock used by the sender and refuses to replace a current database with incomplete bootstrap, pending records or an in-flight batch. Legacy usage without archive custody must be started, captured and archived first. This prevents a successful older restore from hiding newer unarchived history under a retired database path. The original current files are still preserved by the existing restore transaction. Never restore an old account/password registry as part of a code rollback.

The existing private instance backup format is a separate consistent snapshot mechanism. The archive sender currently sends usage records, not scheduled copies of the whole instance backup. Off-host backup scheduling requires a separately qualified destination and copy/restore procedure. Do not label usage archival as full instance disaster recovery.

## Optional Timescale analytics

The implemented alternative is the separate [DuckDB historical analytics integration](HISTORICAL_ANALYTICS.md), providing bounded archived daily and response reports without altering the receiver's custody catalog. It has its own projection ledger and never reuses the Timescale `projected_at` marker. It remains disabled until separately configured and qualified on the target.

`scripts/archive-timescale.sql` creates the dedicated `codexcontrol_archive` analytics schema. It is not an alteration to a mission application's database. The receiver's optional projection uses local PostgreSQL peer authentication, an idempotency catalog and bounded bulk COPY. Projection failure leaves verified segments intact and pending for retry. Queries must select appropriate latest row versions before aggregation.

The SQL supports version-dependent compression/columnstore interfaces and contains no retention deletion policy. It must be executed and verified against the selected Timescale engine before activation; static review and synthetic psql failures do not qualify a production engine. SQLite remains the Pi's live store regardless of this optional projection.

## Activation acceptance

1. Confirm destination, service account, pinned SSH identity, local catalog path, capacity and independent backup policy.
2. Qualify real filesystem/mount durability, permissions and disconnected-mount refusal.
3. Send actual Pi source rows, verify receiver identity, raw/member checksums and committed receipt; independently query/export the same records.
4. Inject lost ACK and temporary destination failure; verify stable retry, no duplicate evidence and preserved Pi backlog.
5. Prove a newly changed row cannot be evicted using an older receipt, and that restore refuses incomplete custody.
6. Measure Pi service memory, collection latency and archival CPU/I/O with the real dataset; verify the schedule remains non-overlapping.
7. If Timescale is enabled, verify actual database creation, idempotent repeat projection, SQL queries and compression policy. Otherwise report it as not activated.

Until a destination has been supplied and these checks pass, archive status must remain unconfigured. Local no-loss protection can operate during that interval; off-Pi replication is not complete.
