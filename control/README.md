# Control foundation and lifecycle preview: P0–P3

This optional package implements passive compatibility assessment, metadata
contracts, transient buffers, operation state projection, a local SQLite
journal, and the P2 authority, enrollment, ownership and transport components.
The optional [P3 owned Codex lifecycle preview](../docs/qualification/control-codex-lifecycle.md) adds a separately constructed provider dispatcher. Native approval replies and terminals remain unavailable.
Observer entry points and identity do not import or start it. Components start
only through explicit embedding calls; no service is installed by importing it.

The [P2 contract](../docs/qualification/control-authority-transport.md) describes
the named-principal authentication, owner-local bootstrap, separate authority
database, signed actor/host channels, project ownership and qualification limits.
All P2 validation-only receipts retain nativeExecutionAllowed=false. P3 uses its explicit HostPolicy.dispatchLifecycle gate and an owned-process adapter; importing either starts nothing.

The approved Control Surfaces Implementation Plan R1 has SHA-256
cd4c35cf12f16c6ed4c42db73f00d9f754b50b59110135a9cc1841728bc9efcd.
That plan and the sole current authority/checkpoint remain in the enclosing
workstream's docs/CHECKPOINT.md, outside this distribution. This README
describes the code contract; it does not grant implementation or deployment
authority for later phases.

## Compatibility boundary

The [runtime matrix](../docs/qualification/control-runtime-matrix.md) binds the
investigated executable and normal/experimental schema bytes. Assessment returns
only DECLARED_ONLY or UNAVAILABLE, always with executionAllowed=false, no
qualified operations and runtimeVerification=NOT_RUN. Native initialization,
effective policy and account checks belong to later approved stages. An exported
method is not an execution grant.

The [dependency inventory](../docs/qualification/control-dependencies.md) covers
Node built-ins and future dependency gates. No SDK, terminal or other package
has been added. Node 24.19.0 is the tested runtime; its SQLite API has release
candidate maturity, not universal stable-runtime compatibility.

## Metadata and privacy contract

The operation schema accepts generated UUID identifiers, an enumerated action,
a complete target, immutable context revisions/fence/epoch, timestamps and
timeout. It validates action-specific target requirements. Actor, project, host
and provider references are registry identifiers; trusted later components must
derive them from authenticated authority rather than accepting browser assertions.

Native request/decision schemas distinguish reference metadata from command,
diff, form or answer content. Numeric and string native request IDs remain
distinct. Request/terminal/grant contracts validate shape, not authenticity,
permissions, ownership or live capability.

Unknown properties, custom prototypes, proxies, accessors and malformed
identifiers are refused before serialization. Errors use a closed code
vocabulary and fixed message; foreign exception details are not propagated.
No durable prompt, command argument, output, credential, reasoning, arbitrary
summary or content-derived fingerprint field exists.

Opaque native IDs are syntactic metadata, not a general secret detector. The
future adapter must extract them only from the correct native fields and
discard excluded content at its boundary. A caller deliberately disguising
content as an ID defeats a source classification rule; regexes are not redaction.

The transient store owns bounded Buffer copies with separate transport,
turn-consent and approval-consent lifetimes. It never serializes or hashes their
content. A repeated reservation cannot replace bytes or rehydrate consumed
content. Consumed/invalidated owned buffers are overwritten; JavaScript strings,
caller copies and runtime/OS copies are outside that guarantee. This is not
secure memory erasure.

Transient expiry uses a monotonic clock, explicit API calls or sweep(), with no
timer. The later lifecycle owner must schedule bounded sweeps and invalidate
context on steering, item/path changes, resolution, turn end, expiry,
revocation, disconnect and shutdown. A lost/backward/invalid clock clears the
store and refuses further use. Bounded tombstones cannot replace the durable
journal: after restart only a genuinely new admission may reserve payload.

## Journal API

Import ControlJournal from lib/journal.mjs. Explicitly call
ControlJournal.open({directory}) to open control.sqlite in that local absolute
directory; call close() when finished. Import creates no database, child,
connection or timer.

| Method | Contract |
| --- | --- |
| admit(envelope) | Atomically reserves operation ID and actor/request key, appends admission metadata and returns the committed operation. An exact retry returns duplicate=true; changed metadata conflicts. |
| get(operationId) | Returns the current durable projection or null. It grants no authority. |
| transition(event) | Requires event ID, expected revision, type, timestamp and complete original context. Optional native refs, enumerated reason and reconciliation evidence ID are metadata only. |
| recover({connectionEpoch, atMs, limit}) | Classifies operations of an already retired epoch. Default page 100, maximum 1,000; hasMore requires another deliberate recovery call. Opening a connection never triggers recovery. |
| read({after, through, limit, maxBytes, journalId}) | Returns immutable sequenced metadata and a fixed high-water mark. Up to 1,000 records/2 MiB per page. Continue with the same through value to finish a snapshot. |
| status() | Reports stored and pending counts/bytes and the actual archive-verifier state. |
| selectArchiveBatch({limit, maxBytes}) | Reads pending immutable versions without consuming or acknowledging them. |
| recordArchiveReceipt({batch, receipt}) | Verifies a configured pinned receiver signature and exact local versions, then acknowledges transactionally. No transport or eviction occurs. |

The journal is not a broker or authority verifier. It checks context against
the admitted envelope; P2 must supply current authenticated grants, canonical
project identity, host policy, authority generations and exclusive ownership
immediately before each native effect and sensitive publication.

### Dispatch and recovery rules for future callers

1. Admit authorized metadata once. Only duplicate=false permits the first
   transient-payload reservation. A retry returns custody, not a request to
   obtain new content.
2. Revalidate current authority/ownership, then commit DISPATCH_INTENT.
   Send a native request only after a **new**, successful intent commit, never
   after a duplicate receipt, read or reopen. Transactions do not invoke
   provider/IPC callbacks or await asynchronous work.
3. Record native acceptance and final outcome separately. A final observation
   may arrive before ACK. Later observations cannot regress that final state.
   Duplicate events return the **current** operation plus their original
   immutable receipt, so a historical ACK cannot replace current completion.
4. After ownership and old-epoch retirement are independently established,
   recovery classifies admission without dispatch intent as NOT_DISPATCHED.
   All other unfinished states become UNKNOWN. Neither state resends work.
5. UNKNOWN remains unknown on late native observations. Only separately
   authenticated reconciliation with a new event and evidence ID may resolve
   it. P1 validates the ID's shape; it does not authenticate the evidence.

Expiry/cancellation before dispatch is distinct from expiry/cancellation after
intent, which cannot prove absence of an effect. Completion of a turn is not
task verification or Owner acceptance. Local reservation/revision rules provide
deduplication, not distributed exactly-once execution.

## Storage, receipts and migrations

The schema uses WAL with synchronous FULL, foreign keys, STRICT tables,
immediate write transactions, immutable transition/receipt triggers and
transactional custody counters. Timestamps and typed native references are
retained as captured metadata; payloads are never retained.

Normal admission and new ordinary dispatch require the configured normal free
space threshold and pending-byte budget. Existing effect receipts/recovery,
plus narrowly enumerated interruption/runtime-stop/terminal-termination actions,
may use the smaller emergency threshold. Defaults are 64 MiB normal, 4 MiB
emergency and 256 MiB pending logical metadata. These are admission thresholds,
not preallocated space or guarantees against another process filling the disk.
Actual OS-full-disk, power-loss and native emergency-stop behavior require later
qualification.

No age/row/byte eviction exists. An absent archive, rejected receipt or lost
acknowledgment leaves every version local and pending. Even acknowledged records
remain local. A future verified archive/eviction system must preserve the same
exact-version custody rule.

The optional verifier accepts an explicit Ed25519 public KeyObject and receiver
UUID. Receiver ID/key digest is pinned durably on first configuration; silent
replacement is refused. The signed receipt binds journal identity, segment
identity/digest, exact batch digest, record count/bytes, storage time and the
receiver's durability assertion. Hashes cover validated metadata, never
sensitive content. Authentication of that assertion is not independent proof
of correct remote storage. P1 has no archive receiver or transfer implementation;
signed closed-segment tests use disposable local fixtures. Receiver-key
rotation/revocation requires a later explicit design.

Use only local disk. UNC paths, symlink/junction ancestors and known network
filesystem types are refused. Those checks do not certify every mapped drive,
mount or ACL configuration, nor defeat a malicious same-user path race.
Future installation must independently qualify local storage and private OS
permissions; Windows chmod is not represented as an ACL guarantee.

See [migration rules](migrations/README.md). Version 1 initializes only an empty
database and refuses foreign, changed or newer schemas. There is no observer
database migration, destructive repair or automatic downgrade. Future upgrades
must first produce and verify a SQLite-consistent local backup.

## Verification

Run the focused suite with Node 24:

    node --max-old-space-size=128 --test --test-concurrency=1 control/tests/*.test.mjs

The P0–P1 Windows x64 run on 22 October 2026 passed all 78 tests on Node
24.19.0. The P2 verification receipt binds the later complete source/test set.
Tests run serially; disposable crash-test children use a 64 MiB V8
heap cap. These heap caps do not limit total process RSS or other applications.

Tests use disposable local stores, generated fixture identities/keys, synthetic
native metadata, real owned Node child termination and real SQLite contention/
rollback. They do not execute a provider, shell terminal or production host
operation. Passive-probe reuse verifies retained exact schema bytes without
starting Codex. P2 exercises the kernel-held project lease and fencing contract.
P3 adds separately qualified owned runtime/session lifecycle. Approval responses, browser behavior,
performance under live ingestion and deployment remain later stages.
