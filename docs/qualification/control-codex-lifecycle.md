# P3 owned Codex lifecycle preview

This optional, inert adapter adds Windows-owned Codex app-server lifecycle
components to the P0-P2 foundation. It does not install or activate a service,
listener, observer endpoint or UI. Deployment, packaging and production
acceptance are separate later stages. The enclosing workstream's
docs/CHECKPOINT.md remains the sole authority/evidence/remaining-work record.

## Compatibility and account boundary

The adapter selects exactly codex-cli 0.164.0-alpha.11.1, Windows x64:

- Executable SHA-256: 1103e9e09c71fa2cd0afd6d8f3b9a2d63174fe8efd7cb5bd09f1cb14ef58a098.
- Normal v2 schema SHA-256: 8fe0d6335768743b8388dfdbe95fef85303524093e2dffc301704555e73e718f.
- Model: gpt-6.1-sol; reasoning: high by default, explicitly selected xhigh supported;
  service tier requested: default.
- Sandbox: read-only, no network access for sandboxed work; approval policy:
  never; reviewer: user. A never-ask policy grants no extra OS permission.

Binary hashing streams through a 1-MiB buffer. No PATH discovery, automatic
upgrade, model/tier fallback, shell wrapper or experimental-API opt-in occurs
inside the adapter. The old P0 schema profile remains historical evidence.

OpenAI documents app-server initialization, lifecycle methods and generated
version-specific schemas. This adapter treats its pinned build as an experimental
preview. Local qualification applies only to that executable/schema pair and
does not establish production acceptance. [Official app-server reference](https://learn.chatgpt.com/docs/app-server#lifecycle-overview).

An explicit host-local profile identifies the native home and opaque profile/
account references. The native vendor profile boundary verifies the actual
OS owner, local paths and absence of foreign writers. Existing vendor sandbox
read access is preserved. This boundary conveys no grant-manager authority:
control databases and bootstrap retain the stricter owner-private P2 boundary.
The integration issues no native ACL, login/logout, credential, global configuration or persistent-access edit. The vendor retains responsibility for its normal credential-store lifecycle; any file-version change fences new input.

A trusted local provisioning step supplies a complete parsed MCP-server inventory
and exact native configuration file identity/mtime/size. Changed configuration
fences new work. The child explicitly disables each inventoried MCP server through validated bare override keys (dotted/quoted server names are unsupported), hooks,
plugins, apps, skill-driven MCP installation, additional agents, browser/computer use, shell/exec tools and
the Code Mode host. It uses its own stdio, an environment allowlist, empty
inherited custom instructions, zero project-document ingestion and fixed
thread instructions. Project-local .codex/config.toml is refused.

This app-server version does not support exec's ignore-user-config switch.
Strict-config rejects an installed app-only computer_use field. The adapter
therefore does not claim exec-style config isolation. It applies supported
explicit overrides and refuses mismatching returned model/effort/tier,
approval/reviewer, cwd or sandbox, and unapproved/missing instructionSources.
The sole allowed nonempty source is an explicitly consented, version-pinned
global AGENTS.md as described below.
It never weakens a refused sandbox/managed policy.

account/read uses refreshToken=false and checks the explicitly selected ChatGPT
identity in private RAM before create/resume/start/steer. Native credentials are
never read or hashed by this adapter. Regular-file identity/mtime/size of the
selected auth store, combined with permitted profile/filesystem metadata, bind
the account version. Refresh/replacement/account changes fence further input;
they do not silently rebind old lineage. Keyring-only and non-ChatGPT profiles
are unsupported in this initial preview. A fresh selected-account binding is
not proof of another profile's sessions. No email/token enters control metadata.
Actual billing tier remains unknown unless separately exposed by native evidence.

## Components and interfaces

| Component | Responsibility |
| --- | --- |
| CodexProfile / NativeProfileBoundary | Pinned executable/schema/platform, selected native account/config/store identity, owner/write boundary. |
| OwnedCodexRuntime | Hidden, shell-free owned ChildProcess and stdio; fixed startup plan; count/discard stderr; stop through retained process/job ownership. |
| WindowsJobHost | Optional temporary Windows helper; assign the suspended native child before resume; held-job termination and zero-active-process exit proof. |
| CodexStdioTransport | Closed JSONL methods, correlation, bounded queues/bytes, fresh synchronous prewrite guard, sanitized errors and no replay. |
| CodexSessionRegistry | Separate local codex-lineage.sqlite, immutable metadata events, atomic runtime/session/turn lineage, no imported-session adoption. |
| CodexLifecycle | launchRuntime, createSession, resumeOwnedSession, startTurn, steerTurn, interruptTurn, stopOwnedRuntime and private metadata inspection. |
| HostPolicy.dispatchLifecycle | Opt-in final synchronous signed-permit/root/lease gate for the seven lifecycle actions. |
| Transient consumeBound | One-use turn-consent bytes matched to exact operation scope/kind/lifetime. |

Constructors are private embedding/configuration APIs. They are not browser,
gateway or arbitrary RPC endpoints. Tests may inject a synthetic runtime factory;
status labels that path TEST_ONLY. Real process creation still requires a branded
CodexProfile. Existing P2 validation-only receipts retain nativeExecutionAllowed=false;
P3's explicit lifecycle gate is a separate opt-in seam.

The allowed native methods are initialize, account/read, config/read, model/list,
thread/start, thread/resume, turn/start, turn/steer and turn/interrupt. No login,
logout, thread import/path/history, fork, shellCommand, command/exec, process/*,
approval response, terminal or general extension method is exposed.

## Authority, intent and native receipts

Each action validates exact host/project/profile/runtime/session/turn context,
obtains fresh P2 admission authority and appends the P1 journal admission.
Separate durable dispatch intent precedes the awaited DISPATCH assertion/consumed
permit. Immediately before spawn/write/stop, the current host policy, held
project root and kernel lease/fence/epoch are checked without an intervening
await. Publication requests new authority after native awaits. Permission loss
suppresses delivery but does not authorize deleting captured metadata.

The RAM content store consumes only exact operation-bound turn consent. Input
does not enter operation envelopes, registry records, hashes, error messages or
logs. Native output/items/reasoning are discarded transiently. Provider-native
history remains in the provider's store; CodexControl does not import it.

Runtime records retain an opaque process binding and PID metadata. Stop authority
uses the retained ChildProcess or optional held Windows Job Object, never a saved
PID. In contained mode the registry process is the host; the native PID and
creation time are diagnostic exit evidence. A process error or termination ACK
is not exit proof. Direct mode waits for owned process exit/close and leaves tree
exit unverified. Contained mode also requires the native root to exit and job
accounting to report zero active processes. No PID lookup/adoption, taskkill or
unrelated process sweep occurs. The project lease remains externally owned and
is never stolen/released by this adapter.

A native thread reference is accepted only as the correlated creation reply.
Resume requires matching durable creation lineage, exact profile/account/store/
root binding, a confirmed exited previous runtime and no active/pending/UNKNOWN
session state. A new runtime ID and connection are required. Resume does not send
history, filesystem paths to rollouts, or arbitrary observed UUIDs.

turn/steer always supplies the exact expectedTurnId. An interrupt ACK records
INTERRUPT_REQUESTED. Only the owning connection's matching native completion
changes the observed result to INTERRUPTED. Early completion is correlated before
projection; late completion cannot resurrect authority or turn UNKNOWN into
permission to retry. Stop of active/pending work leaves UNKNOWN lineage. Clean
idle stop preserves resume proof. Loss of a reply or controller instance never
automatically replays an operation.

## Bounds, storage and qualification

The preview admits at most two retained/launching runtimes, one active/starting
turn across them, eight in-flight lifecycle operations, 32 sessions per runtime,
eight early metadata events and four interrupt intents per active turn.
Reservations precede awaits. Stop removes transient tracking but retains durable
history. A blocked or unconfirmed process retains its runtime slot.

Stdio defaults: 256-KiB line, 1-MiB total incomplete-input/output buffering,
16 pending requests and five-second request deadlines. The pinned optional
ServerNotification.emittedAtMs int64 field is accepted only on notifications,
within JavaScript safe-integer bounds; it is event metadata, never an authority
clock. Requests/responses and other root fields retain their strict shapes.
Writers recheck authority
after backpressure and before the single write. Unknown IDs, malformed UTF-8,
oversize, errors and disconnects settle/close without retry. Server requests
expose metadata only, remain unanswered and hold new work; P4 is absent.

The separate local registry uses WAL/FULL transactions, fixed error containment,
indexed session/runtime lookup and maintained audit-byte counters. Ordinary intent
needs 64 MiB free headroom and respects a 64-MiB logical audit threshold; final/
unknown/exit metadata may use the 4-MiB reserve. These are admission thresholds,
not a preallocated quota. No history eviction, destructive repair, NAS-active
SQLite, archive transfer or automatic schema upgrade occurs.

Synthetic tests use real P2 identities, signed grants/permits, held roots/leases,
SQLite and journal data with an injected native runtime. They do not qualify
native behavior. The explicit native fixture is outside the automatic test glob.
It requires its run flag and fresh authoritative usage observations; malformed,
missing, future, stale, changed-reset, below-floor or depleted observations latch
a stop. Stage waiting also checks the bound. Only owned-runtime cleanup bypasses
the budget stop; it still needs its P2 stop authority.

A native qualification uses one disposable temporary project outside the
repository, one session, at most two turn/start calls, one steer, one interrupt
and one owned resume. Runtime admissions share a window-wide cap of at most four;
the normal successful sequence uses two sequential owned runtimes. Defaults are
ten minutes/one weekly point. An explicitly authorized window may configure up
to 45 minutes/five weekly points, with one baseline and fixed deadline covering
all attempts. A stopped window cannot renew itself; renewed Owner authority uses
a fresh receipt while preserving historical stops and UNKNOWN records. Fixed
synthetic input only; provider history and closed control metadata are retained,
and credentials are not copied.

Node tests run serially with 128-MiB runner/file V8 old-space caps and 64-MiB owned
Node fixture-child caps. Logical bounds/V8 settings are not total-RSS or OS
process-memory guarantees. Synchronous filesystem/PowerShell owner checks can
delay Node timers; a configured timer is not a hard wall-clock deadline.

No UI/observer routes changed. Browser/phone/tablet/hardware, Linux/macOS,
installer/supervision, cross-platform tree qualification, native approvals/terminals,
archive transfer, managed security, live observer performance and source-bound
release/deployment acceptance remain later gates. This document is a component
contract; current run disposition and remaining work belong in docs/CHECKPOINT.md.


The recorded native attempt and its Owner-delegated continuation both ended during startup (CLOSED), with two aggregate runtime launches, zero sessions/turns and verified owned-parent exits. A concrete MCP-key quoting defect was corrected and passed real passive parser validation; the second startup closure was subsequently localized to the pinned notification emittedAtMs field being rejected by our transport. The bounded repair passed real grant-backed authenticated startup and owned-parent stop on 24 October 2026; this does not qualify session creation, turns, interruption or owned resume. Those startup attempts did not qualify native lifecycle/AC02. The original47%baseline reached46% and the fixed extended deadline expired; a persistent workstream stop latch now refuses this helper before another launch. A later native diagnostic/qualification needs new Owner authority. These run facts are recorded in the enclosing checkpoint and immutable private receipts; this paragraph does not approve resumption.

Owner-selected instruction policy and nullable tier compatibility (25 October 2026):
the standard outgoing session request is frozen and bound to the exact pinned
profile/account/project before dispatch. An explicit null tier is accepted only
with that recognized single-use binding; missing, Fast, priority, flex and auto
remain refused. Published observedTier remains null. This enforces the requested
Standard route and does not establish the served billing tier.

The Owner expressly permits only the selected signed-in profile's global
AGENTS.md, pinned to file identity/version. That metadata consent is separate
from profile selection and is not inferred from a path. The integration holds a
read-only file descriptor and checks device/inode, size, modification/birth/change
timestamps and current path identity. It reads/hashes no instruction contents.
An AGENTS.override.md appearance, version replacement, unapproved project/skill
source or duplicate source is refused. The consent's metadata binding enters
runtime/session lineage; a changed binding cannot silently resume old lineage.
The repository document cap remains explicitly zero in the per-session request.
Without explicit consent the original zero-global-instruction policy remains.

The qualification CLI requires a fixed explicit window. Its budget supports at
most 45 minutes and five weekly points only when configured, preserves the
original baseline through all attempts, and stops on reset/replenishment or stale
observations. Default allowance remains ten minutes/one point. Runtime admissions
are counted under the shared lease and each attempt retains a separate receipt.
Current run outcomes and remaining native qualification belong in CHECKPOINT.md.

Optional Windows owned-process containment:
The qualification runner can create a temporary owner-private Windows Job Object
host from the checked-in C# source using the installed Windows .NET compiler.
It starts the native executable suspended, assigns it to the held job, then
resumes it. Job kill-on-close, no normal breakaway, a 512-MiB committed job-memory
limit and sixteen-process limit apply to the native job. These limits do not cap
the whole desktop application or Node runner RSS and are not a hostile-process
sandbox or billing guarantee. Standard Windows job inheritance covers ordinary
child creation; brokered or WMI-created process behavior is outside this proof.

Owned stop signals a nonce-bound private marker; termination uses the held job
handle. A successful tree receipt requires the root held handle to have exited
and the job accounting to report zero active processes before host exit. Natural
root exit also terminates surviving descendants. Saved PIDs are diagnostic
identity only; they never authorize lookup, adoption or termination. The runner
preserves each full fixed-shape exit proof before deleting its temporary fixture.
Direct-process mode cannot claim this tree proof.

Spawn-plan construction uses one immutable, validated profile snapshot. Final
P2 authorization, profile, root and lease checks still execute immediately before
spawn. The three-second consumed authority permit is not extended to accommodate
preparation. Selected High/Extra High effort is bound through launch, session,
turn and resume policy; an effort mismatch fails closed. The bounded full native
qualification admits at most one session, two turn starts, one steer, one
interrupt and one owned resume, with a separate aggregate runtime cap. This
component contract does not claim that a particular qualification run passed.

A trusted local provisioning step may supply a qualification window with a
separately reconciled metadata-only native configuration inventory. Provisioning
parses the current TOML without logging values, checks the MCP inventory, refuses
provider/endpoint or file-instruction overrides, and binds inode/mtime/size while
preserving older inventories. The runner reads that metadata; it does not
automatically refresh a refused binding. Profile construction still rejects any
drift from the exact snapshot. A fresh configuration inventory does not repin
global AGENTS consent, rebind old account/session lineage or edit the signed-in
configuration. Current run results remain solely in CHECKPOINT.md and the
referenced evidence.
