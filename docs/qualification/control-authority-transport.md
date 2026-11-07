# P2 authority, enrollment, ownership and transport

This is an explicit local implementation contract for the optional control
components. Native provider execution, provider launch/resume, live approval
responses and terminal IO remain unavailable. Every P2 host permission receipt
sets nativeExecutionAllowed=false. This document grants no activation or
deployment authority; the enclosing workstream's docs/CHECKPOINT.md remains the
sole authority/evidence/remaining-work record.

The implementation continues from P0–P1 commit
11b2b2b12d0094f1826a3724018453b822fb7996. The isolated lane also merges immutable
observer integration 3ccf04aaa07a361bec1a4c5bff909064cc74589e and its test-only
successor cc85224f2fbacf9e913be6041d1109743cafeb17, preserving R6 and its
subsequent committed security repairs. This is source reconciliation inside the
control lane, not a claim that the security candidate is deployed. The control
delta does not rewrite server.mjs, viewer/password authentication, UI, analytics,
archive receiver, installation or release manifests.

## Entry points and trust boundaries

| Component | Explicit interface and responsibility |
| --- | --- |
| ControlIdentities | Reauthenticate an existing named password account using its original live observer cookie; issue a separate bounded RAM-only control credential. Authenticate again at each sensitive phase. |
| LocalOwnerBoundary | Check the actual OS account, private directory/file permissions and local path before owner-local bootstrap/configuration access. |
| AuthorityStore | Protected local control-authority.sqlite with typed projections, immutable request receipts/audit, transactional capacity counts and current authorization inside write transactions. |
| ControlAuthority | Explicit grants, manager operations, stable enrollment, short signed exact-context assertions and durable one-use consumption. |
| HostConnections | Dedicated key challenge, typed connection handles, fresh host generation/epoch checks, retirement and honest revocation enforcement status. |
| ActorAssertionIssuer / FreshActorChecks | Fresh audience/epoch/challenge/operation/phase-bound actor assertions over private inherited pipes. No browser or gateway token can mint an actor. |
| ActorCheckedAuthority | Await a new hub actor check before each broker issue and consumption, then apply current local grants within a synchronous broker transaction. |
| ControlBroker | Bounded host protocol on inherited streams or an explicitly attached authoritative HTTPS facade. Owns no network listener or process supervisor. |
| ControlHostAgent | Explicit outbound connection, enrolled endpoint/pin, dedicated key proof, ordered metadata frames and current host-policy validation. No reconnect loop or provider process. |
| OwnershipLease / ProjectRoot | Real held kernel exclusivity, durable monotonic fence, held filesystem/Git identity and final host checks. |
| createControlFacade | Disabled by default; optional admission, authorization and synchronous publication seam. Supports both direct and asynchronous actor-checked brokers. |

Imported components do not create control databases, timers, listeners, children
or provider traffic. The journal/store modules read their fixed migration text.
Construction and startup calls are separate. server.mjs does not register these
routes or start a broker. A future installation must run the broker separately,
connect only its owned inherited descriptors, protect its OS/configuration
boundary and explicitly attach the authoritative listener. P2 supplies and tests
those stream/component interfaces; it is not an installed service or UI.

Owner-private same-OS-principal embedding/configuration is trusted. Processes
running as that principal can interfere with that principal's files and memory;
process separation alone is not privilege isolation. Untrusted wire messages,
operation metadata and authenticated browser requests have strict closed schemas.

## Named authentication and grants

An observer administrator has no control execution grant by default. Shared
viewer keys, local preview, collectors and fixed gateway bearers are ineligible.
ControlIdentities requires a named password-enabled account, fresh password
verification and the original live cookie. It checks the current ViewerAccess
instance after the awaited derivation and rejects stale, changed or revoked
sessions. Control credentials and cookie bindings remain RAM-only.

Control sessions default to 15 minutes and 128 entries, with hard upper bounds.
Grant management requires reauthentication within five minutes. Logout, password,
role or scope changes invalidate the original cookie/control binding. There is
no automatic fallback to another account or source. Viewer host/project scope is
checked against explicit canonical registry IDs; observation alone creates no
mapping or authority for an existing project/session UUID.

Grants explicitly bind actor, host, project, optional provider profile/session,
action set, expiry, grant/policy revisions and authority generation. Management
authority is separate from execution grants; a host-scoped grant cannot mint
another manager. The first manager and recovery require the owner-local boundary.
Current manager/principal status and recent reauthentication are checked again
inside the write transaction. Request retries return the original receipt and
current projection, without repeating the mutation or restoring revoked rights.

## Owner-local bootstrap

The separately invoked control/scripts/bootstrap-control.mjs requires absolute
private store and current viewer-config paths, expected OS account, hub/actor IDs
and a stable request UUID. Username/password enter a bounded JSON stdin object;
they must never be supplied in command arguments, environment variables or logs.
The operator selects the current protected installation configuration explicitly.
The CLI verifies the named password account and exits after creating management
authority only; it creates no host, execution grant, provider or terminal.

On Windows, fixed Windows PowerShell/.NET calls check the actual SID, ownership
and ACL entries for directory/config file. Only that owner, SYSTEM and local
Administrators are accepted as allowed principals. On POSIX, expected effective
UID/ownership and owner-only mode are required; that platform remains unexecuted
by this Windows qualification. No chmod/ACL fallback, privilege elevation or
filesystem-permission change is performed by the product bootstrap.

Initial bootstrap is durably one-time. An exact lost-response retry reads the
same receipt. A new initial request after bootstrap is refused. Explicit recovery
preserves audit, advances authority generation, replaces manager enablement and
invalidates old authority. It never clears UNKNOWN operations, pending archive
versions or the operation journal. Actual installation bootstrap remains unrun;
the CLI tests use generated disposable accounts and private directories.

## Enrollment and connection identity

The host generates and retains its dedicated Ed25519 private key. The broker
retains public verification material and approved configuration only: host/hub
IDs, protocol, endpoint/server certificate pin, OS-account/inventory references
and generation. Enrollment activation proves key possession over all exact
enrollment metadata and a short pending challenge. The broker never delivers,
escrows or resets a host private key after a lost response.

Enrollment/activation request IDs are stable and independently readable.
Activation has a bounded expiry; a duplicate response cannot create another
host or replace current state. Rotation requires a different public key and
advances durable host generation. It retires a superseded live handle and its
bound transport; same-generation concurrent ownership remains refused. Rotation
does not release or steal a held project kernel lease.

Every channel uses a fresh connection epoch and a one-use broker challenge.
Opaque handles are privately branded; copying an ID/object cannot authenticate
a connection. Host generation and active enrollment are checked again for every
privileged phase or receipt. New requests cannot execute offline. Reconnection
is explicit and does not resend operations or resume a provider.

Revocation distinguishes PENDING, UNREACHABLE, UNKNOWN_AFTER_RESTART and an actual
authenticated ACKNOWLEDGED_NEW_INPUT_DISABLED receipt. That ACK means future
input was disabled; nativeStopConfirmed remains false. A network loss or host
credential change does not prove any process exited.

## Consumption and publication linearization

Assertions bind the exact normalized operation, principal/session/revision,
grant, host generation, project identity, connection epoch, ownership fence,
phase and short lifetime. Their hashes cover validated permitted metadata only.
Admission is not authority forever. After each awaited host/actor hop, the broker
rechecks the current named identity, scopes, grant, project, host and revisions.

Durable consumption is the revocation/dispatch linearization point. It obtains
BEGIN IMMEDIATE and then rechecks those bindings and expiry inside that same
transaction, including after storage checks. A different owner-local process can
commit recovery or revocation while a broker is waiting for the writer lock;
pre-transaction JavaScript checks cannot prevent that race. Only one writer can
hold the transaction; current committed state must be read after lock acquisition.
[SQLite transaction semantics](https://www.sqlite.org/lang_transaction.html),
[connection isolation](https://www.sqlite.org/isolation.html).

A consumed action can precede a later revocation; revocation cannot undo an
already admitted effect. Conversely, a revocation/recovery committed before
consumption prevents its receipt and permit. Broker restart loses pending signing
contexts; durable one-use records, new actor/broker epochs and host fences prevent
an old packet from silently becoming new execution.

HostPolicy independently checks the pinned broker signature, actual connection,
live held lease, project/Git identity, operation/context and one-use permit
immediately before accepting the host gate. Native dispatch is unavailable.
The facade's sensitive publisher uses a synchronous owned writer after fresh
consumption and a current hub actor check. An asynchronous broker adapter is
awaited, then the actor is checked again before publication; a late logout cannot
revive a cached response. Product adapters must not insert another await before
the final effect/publication or turn a metadata gate into native qualification.

## Transport and resource bounds

P2 selects built-in HTTPS/1.1 duplex POST rather than adding a WebSocket package.
The exact endpoint is /api/control/v1/host-channel with the versioned frame
content type. TLS chain validation, hostname verification and an exact DER
certificate SHA-256 pin are all required. The agent additionally checks that
endpoint/pin against its enrolled configuration. TLS authenticates the server;
the dedicated signed challenge authenticates the host. No mutual-TLS claim is
made. The implementation follows the separate hostname check contract in the
[Node 24.19.0 TLS reference](https://raw.githubusercontent.com/nodejs/node/v24.19.0/doc/api/tls.md).

Browser Origin, cookies, bearer/proxy credentials, forwarding headers, compressed
content, redirects, alternate paths/methods and generic RPC are refused. A
private agent avoids ambient proxies and TLS-session reuse. The broker itself
opens no TCP listener; the same framing accepts owned inherited streams.

Frames are four-byte length plus strict UTF-8 JSON, with type/direction/sequence
and epoch checks. Defaults are 64 KiB/frame, 256 KiB total internal buffering and
eight queued/active messages per channel; hard maxima and absolute progress
deadlines are enforced. Partial frames, stalled writers/callbacks, tiny-frame
floods and malformed input close the channel. Receive handlers are serial.

The broker defaults to 32 peers and at most 32 pending host checks per peer.
Actor checks cap pending requests at 32; authority assertions cap at 64, including
in-flight issuance. The facade caps host checks at 32. A timed-out handler retains
its slot until it settles, so repeated timeouts cannot grow abandoned callbacks
without bound. Closed actor pipes reject new admission immediately and settle
every pending request directly. There is no background reconnect/poll loop.

Heap caps and these logical buffer limits exclude runtime, TLS, kernel and other
process memory. Performance/maximum-host/browser claims require later measured
qualification; test duration is not an optimization result.

## Storage, privacy and qualification limits

The separate authority database uses local WAL/FULL transactions, immutable
audit/request receipts, schema identity checks and transactional custody counts.
Every record is retained. The default 64 MiB logical audit budget and normal
64 MiB free-space threshold refuse ordinary writes; revocation and enumerated
emergency actions may use a 4 MiB reserve. These are thresholds, not preallocated
disk or a guarantee against another process exhausting the volume. There is no
authority archive transfer or eviction; status reports all records retained.

No durable prompt, command argument, raw output, credential, private reasoning
or content-derived fingerprint field exists. Host/broker private keys, cookies,
passwords and control credentials remain outside telemetry. Actor control
credentials cross only the owned private pipe in bounded RAM; they do not enter
host frames, URLs, audit, archives, errors or logs. Public-key/configuration,
filesystem identity and allowed operation metadata digests have distinct uses.
JavaScript/OS memory is not represented as securely erasable.

Ownership uses a lifetime rollback-mode SQLite exclusive transaction plus a
separately committed monotonic counter. A crash releases the kernel lock; the
next legitimate acquisition advances the fence without unlinking files. The
initial ownership resource is project-scoped: one controller owns a project on
that host, covering its future runtimes/sessions/terminals conservatively.
P3 must still prove actual runtime/session lineage; observed IDs confer none.

ProjectRoot retains native directory and Git/worktree-pointer handles, rechecks
their identities and refuses unqualified symlinks, junctions, network paths or
replacement. Same-user malicious filesystem interference, unqualified filesystems
and POSIX/platform behavior remain explicit limits. No production OS identity,
volume, network peer or installation has been qualified by fixture tests.

Verification uses serial Node 24.19.0 Windows x64 tests with 128 MiB V8 old-space
caps and 64 MiB owned child caps. It includes real SQLite/process contention,
cross-process recovery/revocation races, actual loopback TLS, inherited child
pipes, actual synthetic-account password verification and owner-local CLI runs.
There are no provider turns, live approvals, terminal shells or remote-host tests.

No UI changes are part of P2. Desktop/phone/tablet, physical-device, live observer
performance, installer/supervisor, managed security, source-bound release gate
and deployment acceptance remain later work. No final-runtime package is created
here. The existing executable performance-release gate remains mandatory before
any future packaging/deployment; local source tests do not waive it.
