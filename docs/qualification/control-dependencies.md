# Control foundation dependency inventory — P0–P2

Initially recorded 2026-10-22; P2 update 2026-10-24. Control runtime components use **Node.js 24 built-ins and repository-owned modules only**. P2 adds no npm/pip packages, SDK installation, native PTY library, browser terminal renderer or provider service. The separately merged observer development tooling has its own existing lockfile; it is not a new control-runtime dependency. The enclosing workstream's `docs/CHECKPOINT.md`, outside this distribution, owns authority and current implementation status.

## Current foundation

| Dependency / source | Use | Version / maturity evidence | License and qualification boundary |
| --- | --- | --- | --- |
| Repository-owned `control/` ESM | Contracts, privacy, transient content, state machine, journal/archive foundations and passive compatibility | P0–P1 source on the isolated branch; component test evidence is owned by its implementation lane | Root `LICENSE` is MIT, copyright Blackvalley Defense. This inventory is not a security sign-off. |
| Node.js runtime | Executes `.mjs` modules and the built-in test runner | Observed/tested `24.19.0`, Windows x64, ABI `137`; exact executable digest is in the [runtime matrix](control-runtime-matrix.md) | Node license plus bundled third-party notices; preserve exact distribution notices if redistributed. |
| `node:sqlite` | Local active control metadata journal, via `DatabaseSync` | Node `24.19.0` docs: Stability **1.2 — Release candidate**, promoted in `24.15.0`; not a fully stable API claim | Built into Node; no standalone SQLite npm binding is added. Native database implementation and notices remain part of the Node distribution. |
| `node:crypto` | SHA-256 identity checks, UUIDs and journal/archive cryptographic primitives | Node `24.19.0` docs: Stability 2. Hashes identify bytes; they do not authenticate a publisher or grant execution authority | Built-in OpenSSL-backed functionality. Algorithm/API presence is not independent protocol or FIPS validation. |
| `node:fs`, `node:fs/promises`, `node:path`, `node:url` | Local file/journal/evidence paths and module URLs | Built-in APIs; exact filesystem and crash behavior still require target-platform qualification | Included with Node. Active SQLite files stay on local disk, never SMB/NFS. |
| `node:util`, `node:perf_hooks` | Type checks and monotonic transient-content timing | Built-in APIs; content remains transient according to the P1 contract | Included with Node. No telemetry package is introduced. |
| `node:child_process` | Fixed passive CLI inspection; test-only crash fixtures in the separate journal lane | Native probe uses only version/help/schema argv; no provider RPC or service launch | Included with Node; not a process isolation library. |
| `node:https`, `node:http`, `node:tls`, `node:stream` | Explicit host TLS duplex stream and bounded inherited-pipe frames | Node 24.19.0 local TLS/chain/hostname/pin/closure tests; no ambient proxy or credential fallback | Included with Node. The host proof authenticates the client separately; this is not mutual TLS. |
| Windows PowerShell / .NET ACL APIs | Explicit owner-local boundary checks on Windows, using the fixed OS executable and JSON stdin | Directory/file ownership and allowed SID checks exercised in disposable Windows fixtures | OS component, not bundled. No credentials in command arguments or environment, no policy change or elevation. |
| `node:test`, `node:assert/strict`, `node:os` | Foundation fixtures and local runtime observations | Built-in test support; synthetic fixtures are TEST_ONLY | No external test runner installed. |
| Codex CLI | Optional externally supplied passive schema input | Only `0.163.0-alpha.11` / exact Windows x64 SHA-256 is accepted by the probe | Not bundled or installed here. Actual binary publisher provenance, full notices, redistribution and upstream production support remain unresolved gates. |

The Node `24.19.0` tagged documentation confirms the SQLite and crypto maturity distinctions above. `DatabaseSync` executes synchronously, so a future broker/host service must budget/block-isolate its work rather than infer low latency from a built-in API. Keep database tuning, crash recovery, custody and migration tests tied to exact Node/SQLite builds. [SQLite docs at v24.19.0](https://raw.githubusercontent.com/nodejs/node/v24.19.0/doc/api/sqlite.md), [crypto docs at v24.19.0](https://raw.githubusercontent.com/nodejs/node/v24.19.0/doc/api/crypto.md), retrieved 2026-10-22.

Node's license file contains its primary permissive license and the separate notices for bundled dependencies. “No npm dependencies” does not mean the runtime contains no third-party code. Preserve that complete version-specific file in any future packaged runtime. [Node v24.19.0 LICENSE](https://raw.githubusercontent.com/nodejs/node/v24.19.0/LICENSE), retrieved 2026-10-22. The passive subprocess wrapper follows the documented direct-executable API with shell disabled; its timeout and buffer limits do not supply native process-tree containment. [Child process docs at v24.19.0](https://raw.githubusercontent.com/nodejs/node/v24.19.0/doc/api/child_process.md).

## Future dependency gates — not installed or qualified

| Candidate | Earliest intended stage | Required decision/evidence before adoption |
| --- | --- | --- |
| Codex app-server runtime distribution | P3, packaging P8 | Exact binary/version/schema/OS pins, publisher verification, notices/SBOM, trusted update procedure, authentication/terms, lifecycle/sandbox behavior, rollback and upstream maturity decision. The current alpha is only schema-observed. |
| `@openai/codex-sdk` or Python `openai-codex` | Separate adapter decision | Do not add merely because an SDK exists. Resolve CLI-wrapper versus app-server API capabilities, exact package/transitive versions and licenses, authentication/persistence behavior and runtime qualification. Neither SDK is a P1 dependency. |
| WebSocket transport package, if required | P2/P5/P6 | Explicit implementation selection; exact lockfile/integrity and license inventory; origin/authentication/revocation, payload/compression/backpressure limits, disconnect behavior and update policy. No package is silently inherited from a private prototype. |
| `node-pty` | P6 host terminal, if selected | Exact native package/Node ABI/build-tool/runtime pins per Windows/Linux platform; library and ConPTY-related notices; child ownership, cleanup/termination, resource bounds and repeated lifecycle evidence. OS identity confinement is independent of the library. |
| `@xterm/xterm` and individually selected addons | P6 terminal UI | Exact package/addon versions, source/integrity/license notices, local assets/CSP, parser/output bounds, accessibility and renderer/PTY flow tests. No third-party page JavaScript may inherit terminal input access. |
| Claude Agent SDK | Optional P9 | Separate Owner-selected scope, exact SDK/CLI versions, vendor authentication/terms, package/transitive notices, permission/interrupt/resume semantics and independent acceptance. |
| Gemini CLI ACP and any ACP client library | Optional P9 | Exact CLI/protocol/capability pins, dependency/notices inventory, cancellation/permissions/session lifecycle and no assumed terminal write/resize parity. |

The selected architecture is bound to approved plan SHA-256 `cd4c35cf12f16c6ed4c42db73f00d9f754b50b59110135a9cc1841728bc9efcd`. The plan and detailed primary-source register remain in the enclosing workstream outside this distribution. The candidate table is a future procurement/qualification checklist, not a declaration that packages have been installed or approved. Any package adoption must update this inventory with exact resolved versions, provenance, checksums, transitive dependencies, license notices and platform results before packaging.

## Present limits

No package installation, login, API key creation, initialize/model request, provider turn, terminal, service, SSH connection or deployment was performed by this dependency/compatibility lane. This document supplies inventory and source-supported API maturity information; it does not certify native runtime suitability, distribution compliance, exploit resistance or production readiness. Later accepted implementation and release evidence must resolve those gates without weakening the observer's separate distribution promise.

P2 exercises real password verification only for generated TEST_ONLY accounts,
dedicated generated host/broker keys, loopback TLS and owned Node children. Its
static localhost certificate/private key are explicitly public TEST_ONLY fixture
data, generated with the already installed OpenSSL tool; tests and runtime do
not require an OpenSSL subprocess. Installed provider credentials, accounts,
services and remote hosts are not used. See the [P2 contract](control-authority-transport.md).

## P3 owned lifecycle preview

The optional Codex adapter adds no third-party runtime package or SDK. It uses the already inventoried Node child_process, fs, path, crypto, util/stream and SQLite facilities, fixed Windows PowerShell ACL metadata checks, and the separately pinned installed Codex executable/schema described in the [P3 contract](control-codex-lifecycle.md). Python standard-library tomllib was used only by local qualification provisioning to project MCP names and file metadata; the adapter receives that trusted private projection and does not require Python at runtime. No native binary is bundled or redistribution rights claimed. Hooks/plugins/MCP/extra agents are disabled for the bounded preview; managed security, SBOM/installer and platform qualification remain later work.
