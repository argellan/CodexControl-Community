# ARGELLAN conditional profiles and security procedures
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

Version 1.0 research proposal. All product execution below requires a later authorized run. Every check in this research is NOT_RUN. The procedures are tailored engineering judgment; the selected ASVS IDs were verified at v5.0.0, WSTG is pinned to 4.2, and source IDs resolve in source-register.md. This is not ASVS conformance.

## Applying a profile

Use web + self-hosted + collector + storage for the inspected CodexControl scope. Use desktop/installer checks only for the actual advertised package. Use regulated controls only after the owner identifies the actual contract, data class or legal obligation. Do not import multi-tenant, payment, OAuth or SSO requirements where those features do not exist.

Each static and dynamic procedure is a separate check record. A static PASS never supplies an unrun dynamic result. Evidence includes code/config locations, candidate identities, fixture digests, tool/version, expected and actual outcomes, persistent side effects and redacted output paths. The case and budget limits are starting proposals to ratify before execution.

## Common abort and recovery rule

Before any dynamic case define disposable roots, owned processes, network destinations and CPU/RSS/time/disk ceilings. Abort at the declared ceiling, preserve state and mark BLOCKED or FAIL. Never fill a live disk, stop another worker, send secrets to an unverified destination or broaden target scope. On denial stop that action; on uncertain mutation read state before considering a retry. Checkpoint completed work and continue independent allowed cases.

## Procedure catalog

### SEC01 Authentication and session lifecycle

**Trigger:** Web/account interface.

**Source basis:** ASVS v5.0.0-7.2.1 and 7.4.1; WSTG 4.2 section 4.4/4.6.

**Static method:** Enumerate sign-in, recovery/access-key, session and logout/revocation routes from code/config. Identify backend verification and expiry rules.

**Authorized dynamic method:** With disposable users, compare valid access with missing, malformed, expired and revoked credentials; attempt old-session reuse after logout and after account disable.

**Expected pass and closure:** Authorized case works; rejected requests disclose no scoped data and cause no protected write; terminated sessions remain unusable according to documented contract.

**Budget proposal:** 10 min; at most 20 requests per case.

**Limits:** No expiry feature assumed; document any persistent-key design and its risk. Proxy authentication requires an actual verified boundary.

### SEC02 Function and data authorization

**Trigger:** Accounts/scoped data, APIs, stream or export.

**Source basis:** ASVS v5.0.0-8.2.1, 8.2.2 and 8.3.1.

**Static method:** Map subject-role/data scope to each read/write route, event stream, export and admin action. Trace server-side enforcement and stale asynchronous result handling.

**Authorized dynamic method:** Use two synthetic subjects with disjoint host/project scopes plus administrator. Replay a permitted request under the other identity and after scope/revocation change; include an already-open stream.

**Expected pass and closure:** No unauthorized object/function response, persisted mutation or post-revocation stale disclosure; equivalent scopes consistent across UI/API/export.

**Budget proposal:** 15 min; small synthetic matrix.

**Limits:** Do not invent tenant boundaries. If no tenant exists, tenant isolation is NOT_APPLICABLE with architecture evidence.

### SEC03 Untrusted data to browser and interpreter

**Trigger:** Untrusted labels, queries, templates or child processes.

**Source basis:** ASVS v5.0.0-1.2.1, 1.2.4, 1.2.5 and 3.2.2.

**Static method:** Trace event labels, filenames and query input to HTML/URL/SQL/process sinks; inspect parameterization and context-specific handling.

**Authorized dynamic method:** Render inert marker strings containing delimiter/markup characters in disposable fixtures and verify visible text/DOM; exercise a rejected malformed query without executing host commands.

**Expected pass and closure:** Input is treated as data in the intended context; no unexpected navigation, executable markup or altered query/process structure.

**Budget proposal:** 10 min; no payload against live service.

**Limits:** Static suspicion is not a demonstrated exploit; a safe textContent path does not prove all other sinks safe.

### SEC04 Browser origin and deployment boundary

**Trigger:** Browser plus HTTP/TLS or proxy.

**Source basis:** ASVS v5.0.0-13.1.1; WSTG 4.2 sections 4.2/4.6/4.11.

**Static method:** Inventory cookie/storage auth, CSRF-relevant mutations, CORS, CSP, frame policy, Host/Origin handling, proxy headers and bind/TLS defaults.

**Authorized dynamic method:** In isolated instance compare intended origin/host with foreign/missing/mismatched values as permitted by protocol; check preflight, framing and ambient-credential state changes where present.

**Expected pass and closure:** Documented trust boundary enforced; response headers fit actual content/workflow; foreign origin cannot cause protected action or read sensitive response.

**Budget proposal:** 10 min; loopback/mock origins only.

**Limits:** Header presence alone is insufficient. Local loopback HTTP may be intentional; do not force internet-service HSTS assumptions onto it.

### SEC05 Filesystem paths and reviewed exports

**Trigger:** File access, exports, ZIPs or generated downloads.

**Source basis:** ASVS v5.0.0-5.3.2; 1.2.10 for spreadsheet formats.

**Static method:** Identify allowed roots and links/reparse points; inspect path construction, normalization, symlink policy, extraction destinations, review authorization and exported field allowlist.

**Authorized dynamic method:** Use a disposable tree with sentinel files outside allowed root and hostile/ambiguous filenames; create a small export and independently inspect members/fields/hashes. If CSV is supported, inspect formula-leading cells.

**Expected pass and closure:** No read/write outside scope, secret/unrelated content, invalid archive path or unreviewed field; download names safe; spreadsheet interpretation mitigated where applicable.

**Budget proposal:** 15 min; less than 10 MiB fixtures.

**Limits:** No extraction of unknown hostile archives in production. Formula protection is conditional, not a mandate to add spreadsheet export.

### SEC06 Outbound requests and integration credentials

**Trigger:** HTTP fetch, API integration or archive transport.

**Source basis:** ASVS v5.0.0-1.3.6, 12.1.1 and 13.1.1.

**Static method:** Inventory destinations, redirect handling, DNS/proxy assumptions, TLS verification, credential injection scope and integration defaults.

**Authorized dynamic method:** Use mock endpoints to compare approved destination and refused foreign/redirect/TLS failure; simulate provider rate limit, expired auth and unavailable permission.

**Expected pass and closure:** No credential sent before identity/destination validation or to unintended redirect; TLS fails closed; partial/unavailable remains visible with bounded retry.

**Budget proposal:** 15 min; mock destinations only.

**Limits:** Do not request real cloud metadata or unrelated hosts; no credential expansion/account provisioning to make a test pass.

### SEC07 Collector identity and semantic ingestion

**Trigger:** Collector/event receiving pipeline.

**Source basis:** ASVS v5.0.0-2.2.1 and 8.3.1 plus product contract.

**Static method:** Trace enrollment, instance/host/project/source identity, source schema versions and cursor/ACK logic; identify totals' identity basis and timestamp semantics.

**Authorized dynamic method:** Send known synthetic valid, wrong-instance/host, malformed, stale/future, duplicate, reordered and corrected-version batches; restart between lost-ACK retry and resend.

**Expected pass and closure:** Correct source scope, deterministic duplicate/correction treatment, no invented totals; rejected/uncommitted input does not advance cursor; previous exact retry has documented idempotency.

**Budget proposal:** 20 min; at most 1000 tiny records.

**Limits:** Require only ordering/replay guarantees the protocol promises; preserve provenance and show gaps rather than fabricate continuity.

### SEC08 Reconnect and bounded resource pressure

**Trigger:** Streams, parsers, queues or history workload.

**Source basis:** ASVS v5.0.0-2.4.1.

**Static method:** Read size/count/decompression/time/concurrency/storage limits and overload policy; distinguish capture preservation from rendering bounds.

**Authorized dynamic method:** Disconnect/reconnect a viewer and collector, use slow reader plus bounded burst just above a configured limit, then release pressure. Compare committed fixture counts before/after.

**Expected pass and closure:** No silent loss, retry storm or unbounded growth; clear stale/gap/backpressure state; documented recovery cursor and bounded workload/latency behavior.

**Budget proposal:** 15 min; predeclare CPU/RSS/disk abort thresholds.

**Limits:** No uncontrolled DoS or disk filling; use quotas or failure injection. Model worker resource use separately from product workload.

### SEC09 Archive transaction and exact receipt custody

**Trigger:** Durable archive/retention paths.

**Source basis:** ASVS v5.0.0-2.3.3; SQLite practice; product custody rules.

**Static method:** Trace row version to outbox/segment, receiver/catalog commit, receipt verification and eviction. Identify rebuildable indexes versus original source.

**Authorized dynamic method:** Interrupt before/after write/ACK, lose ACK, retry same/different bytes, supply foreign/partial/corrupt receipt or segment; concurrently correct one record version.

**Expected pass and closure:** Only exact current durably accepted versions become eligible for eviction; corrupt/foreign/partial evidence rejected; originals retained; retry has defined semantics.

**Budget proposal:** 20 min; disposable data only.

**Limits:** No deleting production records or resetting queues. Durable receipt assumptions include filesystem/transport boundaries, not just hash equality.

### SEC10 Coherent backups migrations and restore

**Trigger:** Persistent state or supported updates.

**Source basis:** SQLite Online Backup API; engineering judgment.

**Static method:** Document snapshot consistency across databases/config/identity, exclusions, migration versions, rollback policy and restore trust behavior.

**Authorized dynamic method:** Backup a disposable representative instance via supported method, restore to an isolated root and compare schema, selected logical rows, provenance/receipts and application reads; simulate one migration failure.

**Expected pass and closure:** Actual recovery succeeds within agreed RTO/RPO; unsupported downgrade safely refuses; original only copy untouched; credentials not silently rebound.

**Budget proposal:** 30 min initial fixture; cap by declared volume.

**Limits:** A backup existing or database integrity check is not a successful application restore; real NAS durability remains separate evidence.

### SEC11 Privacy logging diagnostics and telemetry

**Trigger:** All outputs; consent path if implemented.

**Source basis:** ASVS v5.0.0-16.2.5 and 16.3.4; product exclusions.

**Static method:** Enumerate capture/diagnostic/log/export/telemetry fields and destinations, retention and access; inspect error observability and redaction before queueing.

**Authorized dynamic method:** Inject synthetic prohibited markers, trigger one refusal/error and inspect outputs/state. Where telemetry exists, test fresh off/consent/on/disable/queued-report behavior with mock receiver.

**Expected pass and closure:** No prohibited values in saved/transmitted outputs; actionable redacted errors; default-off and disposal rules match consent contract.

**Budget proposal:** 15 min; synthetic fields only.

**Limits:** Do not label data anonymous solely because names are omitted; receiver metadata still matters. Feature absent stays NOT_IMPLEMENTED.

### SEC12 Dependencies build and private release configuration

**Trigger:** Included dependencies/runtime/assets and build/distribution.

**Source basis:** Scorecard checks; GitHub secure use; SLSA.

**Static method:** Inventory exact direct/transitive/runtime/asset versions and sources, lock/install scripts, dynamic downloads, build credentials, workflow authority and artifact inclusions.

**Authorized dynamic method:** When separately authorized, run declared dependency/secret/static checks on the frozen input and inspect results; compare actual artifact members to inventory; validate trusted build/source identity.

**Expected pass and closure:** No unexplained included dependency/secret; applicable advisories triaged with impact/reachability; privileged workflow exposure resolved; coverage/permission limits explicit.

**Budget proposal:** 30 min; one approved tool pass plus triage.

**Limits:** No scans performed by this research. A tool score or clean pattern scan is not proof of source integrity or application security.

## CodexControl invariants to place in the release contract

1. Observation never starts, stops, approves, steers or resumes workers.
2. Collection remains within deliberately enrolled source identity and scope.
3. Full captured usage records and provenance remain preserved independently of display limits.
4. Rejected or deferred collection does not acknowledge uncaptured rows or advance the source cursor.
5. Receipt-gated eviction covers the exact current record version; an unavailable archive retains pending originals.
6. Active SQLite and its engine remain on the same local host/storage; NAS holds closed immutable segments and qualified backups.
7. Credentials, prompts, command arguments, raw output and private reasoning remain outside capture/export contracts.
8. Replay/backfill/unknown values never become fabricated live activity, zero counters or independent acceptance claims.
9. GitHub partial/stale/unavailable evidence stays distinct from a passing check and from actual artifact-byte verification.
10. Restoring data does not silently copy a foreign instance's trust, credentials or authority into the current instance.

## Reference matrices

For each row record candidate digest, actual OS/browser/runtime/version, fixture, procedure and observed result. State advertised, experimental, unsupported or unqualified explicitly.

- Browser: Chrome, Edge, Firefox and actual Safari only to the extent advertised; desktop and iPadOS separate. Test sign-in, selection/zoom, keyboard/reduced-motion, replay, reconnect and reviewed download.
- Hub: Windows x64 and Pi 5 8 GB ARM64 are prior reference environments; requalify candidate-relevant installation, local storage, stop/start and no-NAS behavior. Other hosts need their own evidence before support claims.
- Collector: actual supported source formats/version, enrolled identity, first batch, reconnect/outbox retry and login/service/reboot behavior only where promised.
- Storage: fresh local instance, archive absent, receiver unavailable, valid/invalid receipt, restart, coherent backup/restore; optional analytics engine only if actually advertised.

Historical receipts can be reused with a written invariance analysis. An unsupported platform is not a failure unless it is promised; an untested promised platform is a blocked or explicitly revised support claim.

