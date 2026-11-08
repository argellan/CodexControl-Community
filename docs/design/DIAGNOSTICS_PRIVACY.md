# Local diagnostics and Help improve the app
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

This application implements offline local diagnostics, exact reviewed export and an optional LOCAL SYNTHETIC-ONLY sharing mode. Real-report producers, real ownership/recipient approval and hosted deployment remain disabled. No version change or worker control is introduced. This is implementation documentation, not deployment/security/release acceptance.

## Local setup and usable workflow

Existing authenticated named application accounts are required for synthetic sharing; local/legacy shared handles cannot establish operator ownership. Browser-local diagnostics/export need neither an account, consent nor network. Backend diagnostics capture locally; its export requires a current unrestricted administrator.

Start the shipped fixture receiver on loopback only, with an absolute NEW local directory and an available fixed port. No installation, external endpoint or secret is required:

    node --max-old-space-size=256 scripts/diagnostics-receiver.mjs --directory=C:\ABSOLUTE_NEW_SYNTHETIC_RECEIVER --port=4319

The entry refuses existing/relative/UNC directories and unknown/duplicate CLI options. It prints only the actual loopback port/path/mode and closes its own listener on SIGINT/SIGTERM. Reports use fixed files inside that new directory. Keep receiver output separate from the application's instance directory and observation/archive databases. No live source data should be submitted.

The examples/diagnostics-local-application.example.json file is a fragment for a separately authorized LOCAL synthetic application instance. Its syntheticDiagnostics field selects mode synthetic-only and receiverPort 4319. It does not create accounts, change existing credentials, enroll sources or install services. Use existing named test accounts with the ordinary application authentication/roles. The managed runtime must listen on loopback in this mode. No public recipient URL or arbitrary destination is accepted by the UI/API.

Open Settings > Help improve the app. Without that explicit configuration or current named-account authority, synthetic controls stay unavailable and real sharing stays off. In configured local mode:

1. An unrestricted administrator explicitly authorizes the displayed fixed loopback recipient. Synthetic backend aggregates have a separate unchecked administrator choice. Save recipient authorization applies only those explicit choices.
2. Each authenticated browser session refreshes state, explicitly checks Help improve the app, and selects Save my synthetic sharing choice. Another account or another authenticated browser session does not inherit it. Tabs sharing one browser session share a revision and reject stale enables.
3. After the saved choice, future actual browser error/rejection/poll captures automatically submit only an allowlisted category and bounded count under the server-derived session grant. The separate administrator backend choice enables future fixed backend failure categories from the actual application catches. Neither producer reads exception text, local history or captured observations. Optional manual test buttons remain positive controls, not the automatic producer.
4. Keep sharing off cancels that browser/API authority's active send and purges its queued unsent reports when the server acknowledges it. Already delivered bytes cannot be recalled. If offline cancellation cannot reach the server, the UI states that confirmation is unavailable and requires retry; it never claims recall or a server change it could not confirm.

The label, purpose, fields, recipient, retention and HTTPS IP-visibility limitation are visible before consent. No checkbox is prechecked, and changing it does not submit automatically. Changes require the explicit Save button. The UI uses existing ARGELLAN cards/native buttons/labels/live status and adds no animation or permanent polling.

## Account, session and consent boundaries

The application adapter is connected to existing ViewerAccess authentication and settings delivery reauthorization. A source-configured boolean is not identity proof. A sharing grant is created only for an authenticated configured named account, current registration and server-derived browser-session/API authority. The opaque in-memory client key is derived under the application's ephemeral secret; it is never persisted, exported, logged or sent to the receiver. No bearer credential/cookie is retained in a sharing record.

Consent is memory-only, default-off on fresh install/restart/upgrade and independent of personal preferences. Up to 64 current authority records are admitted; expired idle records are released. Each authority lease is at most 15 minutes and no longer than its authenticated session/account expiry; current requests renew authority. Expiry, logout, administration/security transitions, recipient reauthorization and opt-out clear pending work. Unknown ownership keeps that class off. Real natural-person/content ownership is not inferred from a named account: the only permitted transmission class is the explicitly configured local synthetic mode; reports contain fixed categories/counts, with no source content.

Schema version 1 and recipient/grant revision bind each choice and test submission. Stale enables and mismatched schema/recipient/grant are rejected. Stale opt-out is fail-closed. Recipient/backend changes revoke browser choices and abort pending sends. Recreated authority records get a new grant binding. A future expanded transmission schema requires new implementation and fresh consent; unrelated preferences never imply consent.

The backend administrator choice is separate instance-wide permission for future fixed backend categories/counts in this local synthetic fixture. An active current administrator authority lease is required; browser consent does not grant backend permission. A single bounded observer sees only the already sanitized new local event and forwards its category/count, never the stored history, stack/site/hour, exception or observations. Startup unclean-shutdown markers are not transmitted. Enabling either producer never replays local diagnostic history.

## Local diagnostics and exact export

Existing runtime/process/storage diagnostics remain on-demand and separate. Their process IDs and other operational fields are not copied into this export or synthetic report schema. Observation/usage capture, exact-version custody, archive and existing compression paths are unchanged.

The new local event has only kind, generic category, one fixed instrumentation call-site identifier and coarse UTC hour. Raw exception message/stack/reason, prompt, source, environment, auth, paths, names, emails, IPs and URLs are never read into these records. Native stack reconstruction is deliberately omitted. Allowed sites include client:event, client:rejection, client:poll, backend:request, backend:analytics, backend:collection, runtime:startup and unknown.

Caught polling parse/transport failures use fixed capture and fixed console text while preserving poll/backoff/cursor/disconnect/recovery behavior. Global browser hooks cover later uncaught JS errors/unhandled rejections and suppress their default raw reporting. Errors before hook installation and unrelated console/extension behavior remain outside that guarantee. Caught analytics/collector operational failures and outer HTTP/collection failures record fixed backend evidence; routine authorization/body/admission rejections do not create duplicate exception events. Original response/status and capture/custody semantics remain.

The run marker reports only that a previous process did not record clean closure. Detection is incomplete, cause is unknown, and it neither captures every fatal crash nor infers its cause. An unavailable diagnostic store never blocks dashboard startup.

### Windows launcher and runtime failure evidence

The Windows launcher creates an owner-and-SYSTEM-only crash-reports directory inside the instance data directory and gives each run a fresh correlation UUID. The launcher and runtime logs each retain at most four 64 KiB files, rotating the oldest diagnostic file only; captured observations, archives and backups are never part of this rotation. Records contain UTC time, application version and the installer-manifest SHA-256 as build identity. The UUID links evidence from a launcher and its child without identifying a user or account.

The runtime records caught startup failures, Node fatal exceptions, unhandled rejections that reach Node's fatal exception monitor, orderly SIGINT/SIGTERM observations and its exit code where Node can observe them. The launcher records child start and exit codes, and bounded categories for stdout and stderr. Unknown output is recorded only as suppressed-output metadata: exception messages, command arguments, environment values, raw output and arbitrary paths are never written to these diagnostic files. Optional stack sites are restricted to a small fixed list of application filenames and numeric locations. Diagnostic files are local only and are not included in synthetic sharing.

The launcher drains each child stream with an 8,192-character line bound and forwards console output through a separate 16-line bounded queue. If a console consumer blocks, excess forwarded lines can be dropped and a bounded backpressure count is recorded; child-stream draining does not wait for that consumer. Oversize lines are replaced with a fixed suppression message. Normal readiness messages still use the existing readiness verification and receipt.

Windows does not generally provide a reliable POSIX signal for the launcher's child-exit status, so its signal field is unavailable; a runtime signal record is present only when the runtime observes one. The prior run-state marker remains a separate unknown-cause observation. A power loss, forced termination, native hang, broken disk or launcher termination can prevent some or all records from being written. These records do not prove the cause of an otherwise unexplained shutdown. If the private diagnostic directory cannot be established, evidence is unavailable and the application continues.

Preview browser diagnostics works offline. Administrator backend preview uses the current same-origin API and also works through the supported authenticated gateway. The gateway admits only the exact GET export-preview route with no query, rechecks delivery authority and caps its response at 128 KiB. Extra paths/methods/query and foreign-origin/unauthenticated requests are rejected.

Preview freezes readable schemaVersion/applicationVersion/events JSON. Cancel clears pending/frozen preview before any Blob/download is created. A late response cannot restore a cancelled or invalid-authority export. Download exact preview creates those frozen bytes once, to the local browser only. New errors do not mutate them. Manually sharing the downloaded file is a separate operator action.

## Numerical limits and retention

These limits were fixed before budget checks; diagnostic eviction never applies to captured observation/usage records.

| Resource | Bound / overflow behavior |
| --- | --- |
| Local event | <=1 KiB by construction, fixed fields and one known site only |
| Local ring/export | 100 events / 64 KiB; oldest diagnostics evicted, observation records untouched |
| Capture admission | 20 attempts/second; excess diagnostics refused without an unbounded work queue |
| Local age | 7 days by coarse UTC hour; prune on capture/read/startup/close and hourly while running |
| Backend physical files | diagnostics.json plus one bounded .pending file, <=128 KiB combined, tiny run-state marker |
| Browser lifetime | Current tab memory only; reload discards it; no localStorage/cookie persistence |
| App sharing authorities | <=64 in-memory records; current authority lease <=15 minutes/session/account expiry |
| Synthetic queue | GLOBAL 20 reports / <16 KiB across authorities; each sender also bounded; full refuses new telemetry |
| Queue age/retries | <=24 hours; 5 attempts/report, jittered exponential 1-60s, 2s request/ACK timeout |
| Automatic browser batch | One event-triggered 250ms timer, five possible category counters capped at 100 each, one in-flight application request with 2s abort; at most 30 batches/minute; no idle loop or browser retries. Failure drops the transient batch and disables the local producer until explicit state refresh; local diagnostics continue. |
| Application admission | At most 30 new synthetic reports/minute globally across manual/automatic classes; full/rate-limited automatic telemetry is dropped without changing local diagnostic retention. |
| Sender scheduling | One active transport globally, idle timer suspended; at most one scheduled queue drain |
| Request / ACK | 2 KiB JSON body / 256 bytes ACK, no compression, redirects or credentials |
| Receiver | 30 requests/minute including malformed requests; 2 handlers, 1 writer, 4 sockets, 3s inactivity bound |
| Receiver storage | 100 reports / 64 KiB; one <=64 KiB replacement; full returns 507 without evicting unexpired accepted reports |
| Receiver age | 24 hours, startup/minute cleanup; receipt/idempotency data expires with its report |
| Gateway preview | Exact read-only route, no query/body, <=128 KiB encoded/decoded response |
| Capture budget fixture | 1,000 calls <=100ms elapsed/CPU, <=8 MiB heap delta, preview <=64 KiB, request <=2 KiB |
| Test host admission | >=24 GiB free physical RAM, commit <60%, Node heap 256 MiB, concurrency 1, exclusive shared heavy-job.lock |

Physical local deletion can lag expiry by an hour plus I/O completion; receiver deletion can lag by a minute plus I/O completion. Offline files are purged at next startup. I/O failure can delay physical cleanup until storage is restored; no secure erase or deletion from user backups is promised. Atomic local replacement is not an off-host backup or universal power-loss guarantee. Local storage failures retain bounded in-memory evidence and expose unavailable storage status.

The short capture fixture is not browser frame/update/ingestion qualification. A zero Windows process.cpuUsage sample reflects measurement granularity, not zero CPU consumption. Browser/performance/platform and independent review gates remain separate.

## Receiver schema, retry and runnable demo

public/diagnostics-schema.mjs is the strict runtime authority; the supplied JSON Schema mirrors it. The flat ten-field synthetic envelope requires current schema/consent/app versions, origin synthetic, fresh per-report UUID, browser/backend class, fixed category, count 1-100 and coarse latency/memory buckets. Unknown/nested/oversized/malformed fields are rejected before persistence. UUIDs deduplicate only that delivery/retry for 24 hours; no permanent device/user/session identifier is sent.

The receiver accepts POST /v1/synthetic-reports on loopback. Browser Origin headers/CORS, arbitrary routes/encodings/URLs/files/commands and embedded public secrets are absent or rejected. Loopback is not authentication against a privileged local adversary. Stored reports are untrusted data; status-only bounded logs never include payload/address content. ACK follows file sync plus atomic rename. Same validated ID/content returns 200, conflicting content 409; lost ACK retries the same report. Invalid content/version/type/size/rate/storage return bounded rejection statuses. Five failed attempts discard that unsent synthetic report; local evidence remains independent.

Run the actual application/settings/API demo into another absolute NEW local directory:

    node --max-old-space-size=256 scripts/diagnostics-demo.mjs --destination=C:\ABSOLUTE_NEW_SYNTHETIC_DEMO

The demo creates only its own in-process loopback application/receiver with ephemeral synthetic credentials that are never printed or saved. It drives exported settings actions against actual authenticated app APIs, proves default-off zero sends, separate B consent, explicit recipient/A choice, queue/delivery/outage/opt-out and working diagnostics/dashboard afterward. demo.json records exact API/receiver/queue counts, timing/bytes/heap and canary results. preview.json is sanitized; cancellation leaves download.json absent. It dispatches actual JS error events and triggers actual failing snapshot routes without manual send actions. Local application/receiver ports and PID are recorded. Its in-memory DOM workspace fixture is not real-browser QA.

Targeted regression command, under the Owner resource lock:

    node --max-old-space-size=256 --test --test-concurrency=1 tests/diagnostics-producer.test.mjs tests/diagnostics-application.test.mjs tests/diagnostics-privacy.test.mjs tests/diagnostics-telemetry.test.mjs tests/diagnostics-workspace.test.mjs

## HTTPS specification and author threat analysis

The deployment-contract JSON includes the runnable LOCAL mode and an unactivated future HTTPS specification. No production service, public endpoint or real-report receiver is installed. Before any real deployment: establish a named recipient/controller, real per-operator/content ownership, retention/deletion policy, fixed verified HTTPS origin/path, renewed schema-specific consents and independent review. Require verified TLS >=1.2, no bypass/redirects/client secret/cookies, no arbitrary destinations, proxy access/body/address logs disabled, global pre-body limits and local private receiver storage. HTTPS operators can still observe source IPs in memory; anonymity is not promised. Do not expose or repurpose the synthetic fixture as a public service.

Author analysis of the inspected boundaries, not independent security acceptance:

| Boundary / acceptance risk | Enforcing implementation and remaining gate |
| --- | --- |
| Secret/personal exception or parser content | diagnostics-schema sanitizedEvent fixed sites; browser hooks/poll fixed capture and generic console; backend catches fixed-only; real-browser console QA remains parent-owned |
| Wrong operator/session or stale enable | server ViewerAccess-derived ephemeral authority; ApplicationDiagnostics currentOwner, client/grant binding, schema/CAS, logout/security invalidation; only fixed-category local synthetic producers |
| Cancelled/revoked export returns late | settings context authority plus preview generation; fixed frozen bytes; gateway readback reauthorization/size bound |
| Hostile receiver input / arbitrary processing | flat enum schema, size/rate/storage bounds, no Origin/CORS/path/URL/command processing; fixed files and status-only logs |
| Retry/lost ACK / receiver outage | same per-report ID, synced receipt before ACK, bounded queue/retries, one active transport, abort/purge; no core ingestion dependency |
| Persistence/full/expiry | fixed local file caps, one writer, reject unexpired overflow, startup/idle cleanup; I/O failure and backup erasure limitations explicit |
| Accidental real reporting or hosted activation | no live report producer; explicit loopback synthetic mode, named auth plus separate consents; real ownership/recipient/deployment remains held |

Relevant source symbols: ApplicationDiagnostics in lib/application-diagnostics.mjs; createServer/settings authority in server.mjs and lib/settings-api.mjs; strict sanitizer/schema and reviewed workspace in public/diagnostics-schema.mjs and public/diagnostics-workspace.mjs; LocalDiagnostics; SyntheticSender/openSyntheticReceiver; startLocalSyntheticReceiver. F1-F4 corrections are acceptance/capture fixes, not claimed vulnerability remediations. Parent independent fix verification, actual browser/accessibility QA, artifact/platform qualification and canonical landing remain gated separately.
