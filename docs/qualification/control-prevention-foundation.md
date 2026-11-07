# ARGELLAN local prevention foundation (W02)

Author: Bishop Crockett
Owner: Argellan.com

This optional library records task-family admission and usage metadata in an
owner-private SQLite database on local disk. It is a deterministic prevention
foundation, not a production control integration or a billing limiter. Imports
start no model, worker chat, provider process, listener or scheduler.

## Enforcement boundary

PreventionLedger.reserve atomically reserves against one durable family budget.
invokeReserved admits an already reserved operation, commits RUNNING, and calls
the supplied invoking callback on the same JavaScript stack, without an
intervening await. That prevents replay through this API. A stop committed after
admission treats that invocation as in flight.

Only a trusted invoking runtime that actually uses this API gains that admission
boundary. Codex desktop/model sampling, tool execution outside this library,
native provider requests and other callers remain ADVISORY / NOT INTEGRATED.
No application hook is installed by this change. Tests and monitor prompts do
not intercept all model steps. This is not a hard quota, charge or OS-memory cap.

Authority references and observable model/tier fields are caller-supplied
records, not credential verification or served-billing evidence. Known observable
model/effort/tier mismatches are rejected; null observations remain explicitly unknown. The trusted
host must verify Owner authority and retain platform denials. In particular,
a retry record cannot override a sandbox, permission or automatic-review refusal.

## Immutable admission

The manifest has fixed task/family IDs, an optional parent, authority evidence
reference, bounded scope and definition-of-done codes, explicit budget approval,
limit and closeout reserve, fixed deadline/time reserve, requested and observable
model/effort/tier, and enforcement classification. Unknown fields are rejected;
credentials, prompts, outputs, private reasoning and command arguments have no
storage fields. Only validated metadata is canonically hashed.

Manifests are immutable and digest checked; database triggers prohibit ordinary
updates and deletion. Children are records only. They inherit the same family,
authority, requested configuration, budget and enforcement boundary, may narrow
scope/deadline and cannot reduce the time reserve. Depth and family size are
bounded. Creating a child never launches it.

A budget without explicit numeric approval is tracking-only; no expensive
reservation is admitted. No Owner token allowance is inferred from the account's
remaining percentage. The suggested 12,000 recorded-token envelope with
2,000 for closeout is a proposal, not an activated budget.

## Accounting, stops and custody

SQLite IMMEDIATE transactions serialize reservations across local clients.
Recorded usage and outstanding reservation balances jointly consume the family
limit. Monitor and child usage count against that same family. Usage event IDs
are idempotent across reopen; conflicting duplicates preserve the original
record and latch a stop. Late known usage remains recordable after a stop and
can reveal an overrun; recording it never fabricates a recoverable charge total.

Telemetry carries a bounded observation age, reset epoch and remaining value.
Unavailable, stale, future or out-of-order telemetry refuses new work. A changed
reset epoch or any confirmed replenishment latches a stop even if a 100% sample
was missed. The campaign floor is below 5% remaining. Fresh samples, restarts
and duplicate manifests cannot clear a stop or rebaseline the family.

The 70% warning, 90% no-new-work and 10% closeout-reserve fixture values
are policy examples. They do not override an Owner's stricter budget. A finite
time reserve switches to closeout-only before the deadline. Cleanup reservations
can use only their reserved allowance and do not authorize substantive work.

Cancellation before invocation releases an unexecuted reservation. Cancellation
of RUNNING work records a request and retains custody. UNKNOWN execution and
unverified cleanup retain their balance across restart and cannot be replayed.
Only an explicit known-terminal, verified-cleanup receipt releases the remainder.
The host remains responsible for real cancellation, exit proof and reconciliation.

A denial sets a durable family hold, preventing new operation IDs and child
records from evading the refusal. A single retry of the original operation can
be recorded only with materially relevant new authority evidence and known
non-execution and an evidence reference distinct from the original authority;
a second denial permits no further retry. These are local trusted
caller assertions and still require the supported platform to authorize the act.

## Storage and qualification limits

Active databases and their WAL/SHM remain on the same local owner-private disk.
No archive eviction, credential copying, automatic repair, migration, network
operation or provider-history mutation is performed. Logical audit charges and
a closeout reserve bound ordinary admissions; they are not a physical disk quota.
On capacity/storage refusal the invoking host must retain pending observations
and receipts for reconciliation. It may not silently drop history.

The focused suite exercises real local SQLite persistence, denial/cancellation
receipts, reset/stale stops, usage deduplication, guarded callbacks and a
two-client reservation race using deterministic local Node worker threads.
Those threads are test clients, not model workers. This does not qualify Linux,
physical devices, native lifecycle controls, managed security, model-step hooks,
production billing enforcement, release performance or deployment.

Current authority and run disposition remain exclusively in the enclosing
docs/CHECKPOINT.md. No production integration or native-test hold is reopened.
