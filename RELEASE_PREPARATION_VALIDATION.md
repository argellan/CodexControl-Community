# Version 1.0.1 maintenance qualification

This patch corrects three findings from the frozen V1.0.0 source review and
removes event-journal deletion without an off-host event receipt. The original
review covered part of the source tree; it was not a whole-repository security
certification. Focused collector identity, scoped history, TLS-key privacy and
retention tests passed. Initial sustained Windows runs exposed an intermittent
two-second PowerShell ACL-helper deadline in the unrelated read-only query
client. The check still fails closed; its bounded startup allowance is now five
seconds. The final serial Windows source suite ran 1,047 tests: 1,045 passed,
zero failed, and two platform-specific tests were skipped. The two document
PDFs were regenerated and checked for page count, 10 pt minimum text, page
bounds and private-content markers. Release package integrity and ARM64/live
readback are recorded separately by exact candidate. V1.0.1 preserves future
captured events locally but does not recover older expired rows or provide
off-host event archiving.

# Version 1.0.0 focused release closeout

The frozen release includes the existing reviewed source plus the bounded V1 presentation/handoff/documentation delta. Earlier security reviews and corrections remain evidence at their stated immutable revisions. No new repository-wide scan was run for this closeout. A clean source result, partially canceled scan, targeted regression pass and security certification are different claims.

Changed-path checks cover handoff allowlisting, immutable snapshots, review gating, stale async cancellation, fresh viewer/source authorization stamps, fixed safe ZIP paths, CRCs and independently recomputed SHA-256 values. The handoff performs no vault operation, raw-content collection or worker dispatch. The actual browser download was decoded and its manifest/file hashes recomputed. Source capture, archive schemas and custody policies were not rewritten.

Windows x64 and Linux ARM64 fresh setup/update/stop and isolated service/collector startup evidence are summarized in SUPPORT_MATRIX.md. The final source is frozen by an explicit allowlist, no-symlink/static-import closure and content/privacy checks, then hash-verified on the Pi and against GitHub. Current process, archive health, TLS, protected API behavior and exact deployed bytes require final readback. Actual reboot was established by a changed kernel boot identity and enabled-user-unit startup; instance, epoch/cursor, synthetic event/usage sample, saved preferences and pending archive versions matched across the reboot. The isolated test unit was removed and its private evidence retained. Existing production hub and archive timer also returned, with unchanged private configuration and a healthy SQLite check. The setup/service entry path is unchanged by final presentation and handoff deltas.

The user guide and interface atlas contain sanitized explanatory mockups, not private screenshots. All document text and illustration labels are at least 10 pt; every page is rendered and inspected, and text bounds/privacy sentinels checked. They explain current behavior and explicitly separate unimplemented integrations.

The bounded live UI smoke check and previous controlled rendering work do not establish universal 60 fps, all-hardware support, billing reconciliation, full account-wide capture or a maximum fleet size. Failed/unknown source readings remain explicit. Full captured usage retention remains independent of browser limits.

Historical qualification notes follow unchanged below and apply only to their stated revisions.

# Observer0.12 accounting, efficiency and query qualification scope

This revision adds append-only six-counter numeric samples, native response/turn identities, configured-context provenance, an independent bounded source cursor with exact acknowledgements, and backward-compatible V1/V2 archive records. Legacy in-flight archive bytes and receipts remain unchanged through migration. Only exact native response identities contribute to response sums; cumulative and last-response readings remain evidence. Cached input and reasoning remain subsets. Missing or conflicting values are not converted to zero or attributed to an unreported producing model.

The ordinary usage strip does not load detailed sample analytics. Details are loaded on demand; Full, Compact and Mini views bound rendering independently of ingestion. Paused replay, hidden tabs and concealed panes must not continually paint unchanged coordinates or replay old arrivals. The redacted export workspace is local and opt-in; the synthetic demo has no ingestion, cursor or alert authority. Read-only query/MCP tools use existing viewer-scoped APIs, fixed projections, verified endpoint identity and bounded resources; they do not add a network listener or execute Codex work.

Focused source and isolated runtime checks cover migration/restore, immutable records, retry/cursor recovery, authorization transitions, exact archive custody, comparable ratios, optional native account fields, redaction and replay boundaries. A synthetic 100,000-sample workload exposed and corrected full-scan ACK updates, unnecessary retention sorting and expensive counts. Those measurements are fixture evidence, not a Pi throughput or universal 60fps claim. The foreground community lifecycle is qualified separately from service installation, TLS onboarding and reboot persistence.

Optional credit balances retain the provider's decimal string with units unspecified; no dollar value is inferred. Native thread estimates and producing-model attribution can remain unavailable. Optional Timescale SQL has no qualified database-engine deployment. Complete desktop/Dot coverage, provider streaming, billing reconciliation, sustained fleet-scale/browser performance and internet-hosting readiness are not implied. Final immutable candidate tests, security-review coverage and live deployment readback must be assessed independently; older counts below apply only to their named revisions.

# Observer0.10 archive qualification scope

This revision adds transactional capture of exact usage row versions, bounded migration, immutable retry batches, receiver-bound raw/member receipts, permanent compressed segments and a rebuildable local receiver catalog. Regression coverage exercises lost acknowledgements, concurrent ingestion, changed gzip encodings, foreign/partial receipts, damaged segments, mount refusal, source timestamp corrections, old/undated account days, exact-version pruning and restore exclusion. Bounded independent review reproduced and verified the capture, restore and retry roots. Source and fixture checks do not establish a complete new managed security scan.

Receiver tests run real Python processes against disposable local filesystems; the sender/receiver integration uses actual gzip and catalog commits without a real SSH server. POSIX permission/ancestor cases require the ARM64 run. Real NAS filesystem durability, receiver host enrollment, off-Pi transfer and Timescale engine qualification require the chosen destination. They must remain NOT_RUN until verified. Scheduling examples are disabled and unconfigured. The production database stays on the Pi; no live database is opened over SMB/NFS.

Exact frozen-export Windows/ARM64 suite results and any live deployment are recorded independently by the maintainer. Historical counts below apply only to their named revisions. Full native provider-stream coverage, billing reconciliation, sustained fleet-scale performance and complete assistive-technology qualification are not implied.

# Observer0.9 usage-history qualification scope

This revision adds transactional SQLite usage observations and rollups, sampled60second burn, compact accessible meters and provider-attributed token coin batches. Focused independent review reproduced and corrected cross-project daily totals, restored-stream cursor recovery, fabricated idle zeros from partial counters and inconsistent cache-delta backup rejection. Regression coverage includes source-time/receipt-time bounds, retries/reopen, privacy scopes, counter gaps/resets/overflow, rollback and actual offline restore, bounded retention, account daily compaction, refresh/replay/reduced-motion and coin density. Per-worker mixed model/project windows retain exact subtotals with ambiguous metadata explicitly labeled.

These are bounded source and fixture checks, not another complete managed security scan, provider billing reconciliation or fleet-scale acceptance. Exact frozen-export Windows/ARM64 and live deployment results are maintainer readback evidence. Historical counts below apply only to their stated revisions. Raw retention and sampled-rate limitations are documented in docs/design/USAGE_HISTORY.md.

# Release preparation checks

## Observer 0.8 account/profile correction

The new native account reader and scoped usage endpoints have synthetic regression coverage for method allowlisting, owned-child shutdown, timeout/output budgets, optional malformed telemetry, account changes, per-section freshness, future timestamps, explicit account deduplication, admin-only history and scoped active-session totals. Profile/usage presentation tests cover missing/zero/stale/expired/idle/partial values, output encoding, safe hub links, distinct account histories and visible controls. A bounded independent review reproduced and corrected optional quota data blocking event batches and a clock-ahead source replacing current readings. No new full repository Deep Scan is claimed for this feature delta.

The observer uses no model calls or thread lifecycle methods. It emits no email, provider credentials, raw provider errors, account-service identifiers or credit balances. The hub's normal snapshots omit account-wide observations; only the dedicated administrator endpoint exposes them. Account readings use wall-clock freshness independently of frozen replay, and account updates add no waterfall events. Final exported-byte tests, ARM64 staging and live deployment readback are recorded separately by the maintainer. Historical test counts below apply to their stated revisions.

The complete sanitized R8 source candidate was exported on 2026-10-20 with 140 explicitly allowlisted files, no missing imports or forbidden-content findings. All 421 included tests passed on Windows x64 / Node24.19.0 in15497.535ms and an isolated Raspberry Pi5 8GB Linux ARM64 stage in15720.618179ms, with zero failures/skips/cancellations. The source working-tree suite also passed421/421 in15524.138ms. These are application/unit/integration fixture results; they do not establish sustained concurrent fleet/browser performance, full accessibility, a fresh OS/service installation or security certification. Source/test bytes were hash-checked independently on ARM64. Additional fixture-name sanitization does not alter runtime behavior.

The checks below are historical preparation evidence at their recorded revisions, not current publication/security acceptance. A separate managed security review and required corrections precede the maintainer-authorized public source push. Operational identities, deployment records, account verifiers, access tokens, private certificates/keys and histories are not included.

On 2026-10-20 the final focused release-helper and settings-API run passed 19/19 tests on Windows x64 with Node 24.19.0 (12 release tests and 7 API tests). The recorded run took 1231.7071 ms, with no failures or skipped tests. This is evidence for the preparation helpers and isolated HTTP fixtures at that revision, not a final-runtime or production qualification.

Exercised: fresh temporary-directory single-computer and fleet configuration; Windows per-user private-directory ACL application; owner/collector credential separation; no-overwrite behavior; rejection of ports below 1024 before instance creation; unauthenticated local identity verification and mismatch refusal; explicit HTTPS certificate verification despite an insecure external environment; pointer update/backup; generated launcher's main-entry guard from another working directory; synthetic allowlisted packaging/checksums; rejection of suspicious content, missing final runtime and symlinked sources; and Windows PowerShell installer parsing/static ordering checks. Isolated settings API tests cover personal/admin revision conflicts, project-scoped administration denials, issuer-bound one-time credential downloads, flat identity-pinned collector enrollment, invalid machine-ID rejection without registry mutation, and gateway forwarding of a valid backup identity.

TLS fixture files were synthetic readable markers, not real certificates or keys; the explicit HTTPS-verification option was tested through a mocked transport. No real enrollment credential was sent. The generated launcher test used a TEST_ONLY runtime stub. The package test used a TEST_ONLY miniature source tree, not the operational application. A read-only content preflight covered 78 allowlisted source files with no missing files or secret/private-path findings. The public runtime candidate itself has not been packaged by these checks.

NOT_RUN here: actual Windows scheduled-task installation/login persistence; trusted remote HTTPS enrollment; fresh Linux/macOS installation; service installation or reboot; full-runtime setup smoke; full browser/accessibility qualification; public-candidate Pi performance; publication/security certification. Existing internal observer evidence does not remove these limits. Final-runtime packaging and independent human review remain required.

Supplemental isolated collector qualification on 2026-10-20: the collector-identity and rollback-export tests passed 17/17 on Pi 5 Linux ARM64 in 455.36109 ms and 17/17 on Windows in 776.0351 ms, with no failures or skips. A reproduced Linux native-collector exit timeout was traced to recursive file watchers retaining child handles after post-construction unref; constructing those watchers with persistent:false removed the handles. The regression reads nested synthetic Codex log directories and retains its original five-second exit limit; the Pi native subprocess completed in 109.194378 ms. These tests used a separate staged application, temporary TEST_ONLY files and a loopback fixture endpoint, without changing the live service or its data. The rollback exporter and its test are explicitly included in the candidate allowlist.


## Focused security corrections

The source includes regression coverage for collector identity/metadata types, duplicate worker hierarchies and bounded traversal, progress output encoding, journal-only event retention, authentication before collector body buffering, a shared upload admission budget through commit, short proxy-source login throttling, bounded personal-profile queues and logout revocation. Profile tests retain named-layout partial updates, FIFO revisions, last-good recovery and unrelated-user session isolation. Tests use disposable local fixtures; they do not attack production services.

Security outcomes must be read from the version-bound review receipts. A canceled or time-limited scan is incomplete coverage, even when its saved findings have been corrected. Passing tests alone do not establish a complete security audit or internet-hosting readiness.


## Version-bound follow-up review

Two independent Standard static reviews were consolidated and sealed for commit d21d33b45050062460057640f9270594abc74ac1 on October20,2026. They reviewed143text/source/inventorypaths and bounded headers/integrity/static serving for two WOFF2 assets. Four remaining low-severity findings covered malformed event text/Unicode, quadratic route membership, inherited local job-feed type keys and development HTTP fixtures reading real local observation metadata. The subsequent source corrects all four roots and adds focused regressions. Independent bounded correction reviews also found and verified timestamp-normalization and blank-label/missing-inventory regressions during remediation.

The final correction delta has focused source/in-memory review and application regression evidence; it is not represented as a new full repository Deep Scan. The preceding canceled scan retains incomplete coverage independently of the completed follow-up. These source reviews did not perform production exploitation, resource-exhaustion tests or inspect private deployment configuration. They do not certify internet-facing or high-isolation multitenant hosting.

Route projection uses Set-backed membership and fixed presentation budgets while retaining complete bounded source evidence for inspection. Exact record/group/direction/window counts and omitted counts remain separate from sampled route legs. Normal application tests use synthetic HTTP observations, with deliberate file-reader integration tests confined to temporary roots.
