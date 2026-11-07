<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->
# Spending accounting and admission foundation

This standalone module provides durable local admission decisions and accounting.
An opt-in local advisory status endpoint consumes existing observations. The
collector, desktop observer, P3 control prototype, native Codex turns and providers
have no dispatch integration. Deployment remains held.
The workstream's authority and current status live in the workspace docs/CHECKPOINT.md.

## Enforcement boundary

The inspected canonical server rejects unsupported control methods. The account
observer permits initialize, account/read, account/rateLimits/read and
account/usage/read. Those read-only observation hooks do not intercept model
dispatch. No held native probe or P3 integration was started.

SPENDING_CAPABILITY reports NOT_INTEGRATED and native/external dispatch UNSUPPORTED.
A future application-owned dispatcher would need to check admission before every
request, bind its action identity, record dispatch, handle cancellation and settle
actual usage. No such dispatcher is supplied here. markStarted records a caller
transition; it does not launch, interrupt or cancel a model step. A local
reservation cannot guarantee provider/account spending or stop an in-flight call.

The trusted caller must authenticate Owner authority, supply canonical action and
usage identities, and restrict ledger access. Authority IDs are receipts, not
authentication credentials. The library cannot recognize an intentionally renamed
semantic action or an unreported request through another program. A denied
canonical action remains denied across interfaces, descendant task records and
restart. New authority creates a new linked family and retains the old receipts.

## Manifest and storage

SpendingLedger opens a separate SQLite file with BEGIN IMMEDIATE transactions,
WAL and synchronous=FULL. Use local disk only, with directory/file permissions
appropriate to the account. Do not share an active database over SMB/NFS or open a
production CodexControl history database. No schema or records in existing
databases are modified. Evidence here qualifies local Windows/SQLite behavior;
network filesystems and other hardware are unqualified.

createFamily(manifest, telemetry) persists an immutable whitelisted manifest:
family/task identity; Owner authority ID and statement; scope and definition of
done; admitted time and fixed deadline; token budget; closeout token/time/weekly
reserves; weekly baseline and window identity; telemetry age and reservation
lifetime; maximum attempts; requested and observed model, reasoning, tier and
Fast settings. Unknown observed settings are null. Enforcement capability is
fixed by the module and cannot be supplied as a stronger claim by a caller.

For dispatch admission, the token allowance must be explicitly supplied by the authorizing caller.
There is no conversion from tokens to currency or weekly percentage. The actual
Owner attempt uses a 30-minute/five-point envelope and has no authorized raw-token
cap; its saved attempt manifest records that cap as null. This module was exercised
only with synthetic allowances, not used to control the surrounding native chat.

An authority ID may admit only one family in this database. Reopening an existing
family cannot renew its deadline or budget. Renewing a recorded root task requires
a predecessor family and a distinct explicit authority ID. Prior manifests,
usage and journal receipts are retained. Descendants inherit ancestor budgets
and deadlines; they are records only and never dispatch children.

## Admissions, accounting and stop behavior

reserve accepts a request or monitor with stable task, action and reservation IDs
and a positive maximum token allowance. All ancestors must have capacity after
spent usage, active reservations and the family closeout reserve. Monitor work
uses the same allowance. Concurrent connections serialize admission and cannot
both reserve the same remaining capacity. Input validation and policy denials
fail closed. Denied actions cannot be retried under the same family authority.

Retries are bounded by immutable maxAttempts (one to three). Only unstarted
cancellation or lease expiry releases an unused reservation automatically.
A started cancellation is an unconfirmed request; the reservation remains held,
unknown and stopped until actual usage arrives. Expiry after start also retains
liability. Late usage bookkeeping remains available after stop.

recordUsage accepts final per-response input/output counts and nullable cached
input/reasoning output subsets, plus opaque receipt/response/reservation provenance.
Cached input is included within input; reasoning output is included within output.
Total spending is input plus output only. Response aliases deduplicate; conflicting
reports stop the family and retain prior records. Unknown totals retain the
reservation, report unknown, and make remaining null. Subset nulls are preserved
without fabricated values. Corrections do not overwrite prior usage or clear stop;
unresolved reconciliation requires examination of retained receipts.

Unknown, stale or future weekly observations, a changed/reset window, a falling
usage percentage, elapsed deadline, clock rollback, weekly/token exhaustion,
reservation overrun and ambiguous started cancellation/expiry latch stop.
Later fresh telemetry cannot clear it. Invalid operations also persist any stop
detected while processing them. Bookkeeping and cleanup remain possible.

Closeout admissions allow only write-receipt, reconcile-usage and
cancel-reservation, at zero tokens and dispatch=NONE. These are permissions for
local bookkeeping; they are not callable implementations of external operations.
Closeout cannot authorize a model request. No warning threshold can override the
Owner's task limits.

status returns compact JSON with known spent, reserved, nullable remaining,
unknown, stopped/reason, weekly baseline/last observation/window, deadline and
capability. receipts returns append-only, sequenced manifest/admission/usage/stop
records. Status reads also evaluate deadline, telemetry age and reservation expiry.
The journal has no automatic retention eviction. No prompts, command arguments,
raw model output, credentials or private reasoning are collected by this module.

## Focused verification

Run node --test --test-concurrency=1 tests/spending-ledger.test.mjs.
The original run passed 14 tests on Node 24.19.0 / Windows. It covered inherited
family bounds, duplicate/subset/unknown usage, simultaneous SQLite reservations,
restart/renewal/stop persistence, reset/replenishment, stale/unknown observations,
cancellation/expiry/release, cross-interface denials, narrow closeout, monitors,
reserves, exhaustion and clock rollback.

The concurrency case uses two local JavaScript worker threads to exercise SQLite
connections; it creates no agent, model request, native child task or provider call.
No broad suite, benchmark, model-backed reviewer or new dependency was used.
See the saved lane evidence for exact source hashes, the owned patch and original
test results. Physical-device, production integration, crash/power-loss injection
and provider enforcement qualification were not performed.

## Local advisory adapter and JSON endpoint

The candidate now includes an explicitly injected local adapter and
GET /api/account/spending-status. No UI, production configuration or service is
enabled. Pass spendingAdvisory to createServer in a local harness; an ordinary
server without it returns HTTP 503 / NOT_CONFIGURED. Upstream configurations
return LOCAL_ONLY and do not forward this endpoint. HEAD does not ingest.

The endpoint requires authentication and an unrestricted administrator, rejects
scope/query overrides and mutation methods, and revalidates viewer/source scope
before delivering the response. It uses the existing snapshot and journal read
seams. There is no new timer, provider request, native probe or dispatch path.

Provision a separate local ledger once using createFamily with mode=advisory.
The Owner manifest must bind accountKey (the existing opaque 64-character account
key), binding.hostIds and binding.threadIds, plus weeklySelection.limitId/slot.
That selection remains fixed across reads. Supply the actual limitsObservedAt,
usedPercent and resetsAt from the selected existing observation at admission.
Do not replace the source timestamp with HTTP response time. The adapter
subsequently uses the existing account projection and its limits freshness.

A weekly/time-only advisory manifest permits tokenBudget=null and requires
closeoutTokens=0. No token allowance is invented. Advisory families refuse all
new dispatch admissions even when a numeric token cap is supplied. Requested
and observed settings remain separate and unknown tier/Fast values remain null.

After provisioning, the local composition is:

```js
import {createServer} from './server.mjs';
import {SpendingLedger} from './lib/spending-ledger.mjs';
import {SpendingAdvisory} from './lib/spending-advisory.mjs';

// localLedgerPath, admittedFamilyId and authenticatedLocalOptions are supplied
// explicitly by the local harness. Reopening does not create or renew a family.
const ledger = new SpendingLedger(localLedgerPath);
const spendingAdvisory = new SpendingAdvisory({ledger, familyId: admittedFamilyId});
const server = createServer({...authenticatedLocalOptions, spendingAdvisory});
// A local harness may bind server to 127.0.0.1 and must close server and ledger.
```

External observations use recordObservedUsage and never fabricate reservations,
dispatch approvals, attempts or cancellation confirmations. Import accepts
attributable per-response records in the bound hosts/threads. An explicit
provider account mismatch is excluded. When provider identity is null, membership
is Owner-declared through the immutable binding and is labeled OWNER_BOUND_THREAD;
it is not proof of the producing provider account. Response identity deduplicates
across aliases. Provenance retains sample/source-record keys, host/thread,
timestamps and binding basis; aliases/conflicts remain in journal receipts.

Cumulative, inherited/forked, execution, unknown-identity and pre-admission source
records are excluded from token totals. Native cumulative counters are not
converted into invented response deltas. Malformed counter/provenance input,
unknown totals and future source times produce persistent stop recommendations.
Original captured records remain in the existing journal.

Each GET reads at most 128 matching usage rows, plus one lookahead. Cursor order
uses SQLite insertion sequence (rowid), journal epoch and a retained anchor key.
Later commits sharing a received millisecond cannot fall behind a hash cursor.
A changed epoch, missing/replaced anchor or incompatible cursor stops import
without silently resetting it. Progress is durable; replay deduplicates after
an interrupted import. The adapter performs SELECTs against the existing usage
journal and writes only its separate advisory ledger. Returned-row bounds are
not a throughput, latency or total SQL scan-cost qualification.

JSON reports mode=ADVISORY and state=OBSERVING, CLOSEOUT_RECOMMENDED or
STOP_RECOMMENDED. It includes actual limitsObservedAt, deadline, weekly increase
and budget, known observed spending, reservations, nullable token remaining and
coverage/backlog details. Unknown/incomplete native inventory is always explicit:
unknown=true and coverage.complete=false. A zero local reservation count does
not establish native capacity; nativeReserved is null. Account-wide percentage
movement is not attributed task billing. No dollars are derived from tokens or
weekly usage.

Stops survive restart and subsequent fresh readings. GET evaluation is
on demand; it cannot interrupt an in-flight model step or enforce a provider
spending ceiling. The generic ledger capability NOT_INTEGRATED describes
dispatch admission; only advisory status is connected to the local server.

The final functional evidence comprises 29 distinct focused cases across the
initial 28-case run and targeted fixture/cursor/invalid-counter corrections.
Initial failures and their exact source bindings are retained. Successful
unchanged cases were not repeatedly rerun. Local loopback HTTP fixtures cover
JSON, HEAD, authentication, restricted viewers, origin checks, scope overrides,
disabled configuration and source revocation during an asynchronous read.
Production, physical-device and performance/release qualification remain NOT_RUN.

## Compact advisory status in Usage

The existing Compute & token usage dialog now includes one compact advisory
paragraph using existing styles. It displays observation, closeout/stop
recommendations, unavailable/restricted states and explicit stale last readings.
Known weekly-point movement and deadline remain separate from unknown values.
Every state says it cannot stop Codex or cap spending and that token history is
incomplete. Backend/private error strings and family identity are not rendered.

Reads share the existing visible detail-refresh cadence (at most once per
15 seconds while Usage is open), with no new polling loop. Refresh readings
forces the next detail read; the advisory request has an eight-second abort
bound. Closed, hidden, page-hidden and destroyed views stop new reads and abort
pending ones. Old scope/identity responses are rejected. Only an authenticated
administrator with a known viewer identity requests the account-wide endpoint.
Permission loss clears the cache before concurrent successful data can publish.
Unavailable advisory data does not break existing usage details.

The paragraph is a semantic note. State transitions use the existing refresh
announcer, avoiding a repeatedly rebuilt new live region. No new controls are
added. The existing refresh button now restores its former keyboard focus after
temporary disabling if focus fell to the body; explicit user focus moves are
preserved. Desktop and phone Escape/focus return were checked.

Verification: the first focused run passed all 53 account-usage, advisory and
routing cases. A browser keyboard check then reproduced focus loss; a targeted
reproduction failed, and both corrected focus cases passed. There are 55 distinct
cases with passing evidence across these bounded runs; unchanged successful
suites were not repeated.

Rendered before/after evidence covers 1366x620, 1280x600, 1920x1080, phone
390x844/844x390 and tablet 768x1024/1024x768, plus a 125% scaling-equivalent case
measured at 1094x496 CSS pixels. Initial window-size calibration captures were
excluded. Header, toolbar, primary canvas, timeline and workspace heights match
in all eight cases. Laptop workspace heights remain 415.2 and 395.2 pixels.
The normal paragraph measures 38.1 pixels on laptops and 57.1 in phone portrait,
using the unchanged existing 11.2px text style. No horizontal overflow was
observed; mobile refresh controls remain 44px high. Tested warning contrast is
5.34:1 in the light theme. Reduced motion produced no status animations.
Phone More -> Usage navigation and focus return work. A scoped viewer sees no
private metrics and makes no advisory requests. Closed-dialog advisory requests
were also zero.

The browser plugin refused screenshot file export because the task path was
outside its configured file roots. Screenshots were inspected inline; no
alternate export path was tried. Numeric measurements, exact source/test
evidence and fixture provenance are under
.local/spending-advisory-ui-20261025T155414Z/. Retired synthetic fixture ledgers
are preserved; a reused family correctly refused recreation. Later fixture
processes use separate TEST_ONLY databases.

Both worktree and canonical app.css remain untouched. P3 and production services
remain untouched. Physical HP ProBook/iOS/iPadOS/Android, full-theme accessibility
and performance/release qualification are NOT_RUN. No performance improvement,
installed acceptance or deployment is claimed; deployment remains HELD.

## 25 October 2026 release qualification — HELD

Release preflight added the ledger and advisory modules to the explicit runtime
allowlist. Affected tests passed 54/54. Configured lint exposed two unused
parameters; their removal passed lint and the affected 34/34 tests. The first
measurement run was stopped and retained because this correction invalidated
its source binding. No successful or failed samples were substituted.

The corrected-source headed run used the unchanged release budgets, 5,000 seed
events, 128 configured workers and 24 incoming records per second. It stopped
on the first candidate failure: laptop 1366x620 repetition 1 measured update
latency p95 of 517ms against the 500ms limit. All 5,360 expected records were
committed and retained; this sample had zero API errors, zero long tasks and
33.4ms frame p99. Three samples completed; the remaining 45 were not run. This
isolated sample does not establish the cause of the latency failure.

The final-runtime packaging command rejected the partial/failed performance
evidence and created no final package. Functional source is preserved on the
feature branch, but release qualification FAILED and deployment remains HELD.
No release tag, integration, production operation or P3 change is authorized by
this source commit. Both app.css files and the canonical index are preserved.
Raw local evidence is retained under
.local/spending-release-20261025T172557Z/; corrected-source-run contains the
failed gate samples and acknowledged fixture/browser cleanup.
