# Control runtime compatibility matrix — P0 foundation

Observed: 2026-10-22 UTC. Scope: passive declarations and P0–P1 foundation only. Runtime status: **DECLARED_ONLY / EXPERIMENTAL_PREVIEW; execution disabled; runtime qualification NOT_RUN**.

The implementation baseline is commit `dcd446e27b09e42a3e5ed38046e87e3193d89568`, tree `bebae9dee4dd7483807a84daac3d2885935ee4f6`, on the isolated `codex/control-foundation-p0p1` branch. This document supplies compatibility evidence for the approved control-surfaces plan, SHA-256 `cd4c35cf12f16c6ed4c42db73f00d9f754b50b59110135a9cc1841728bc9efcd`. That plan and authority records remain in the enclosing workstream outside this sanitized distribution; its `docs/CHECKPOINT.md` owns current authority, evidence and remaining work.

## Exact observed inputs

| Component | Exact observation | Qualification boundary |
| --- | --- | --- |
| Codex CLI | `codex-cli 0.163.0-alpha.11` | Preview binary; version/help/schema observation only. No handshake, account call, provider turn or terminal. |
| Codex executable SHA-256 | `00c0f1e4099246fddcd67ec620ca8ed50827c7d70e113b7224f7a2933cf2d67c` | Rehashed on 2026-10-22. Byte identity does not verify publisher authenticity or distribution rights. |
| Platform | `win32`, `x64`; Windows release `10.0.26300` | One observed local platform. Linux, macOS, ARM64 and other Windows builds are NOT_RUN. |
| Node.js | `24.19.0`, module ABI `137` | Focused local foundation tests only; no claim that every Node 24 minor has been qualified. |
| Node executable SHA-256 | `3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237` | Recorded test-runtime identity, not a vendor signature. |
| Adapter / transport | P0 declaration evaluator; future owned app-server stdio adapter | No runtime transport, process owner, authentication or control endpoint exists in this package. |
| Provider/account/model/effort/tier | UNKNOWN / NOT_SELECTED | No account availability or native policy permission was checked. No fallback or tier change was attempted. |

Official documentation says schema exports correspond to the specific CLI version that generated them. The developer-command reference still describes app-server as a development/debugging interface that may change without notice. This evidence therefore establishes a pinned preview candidate, not production support. [Message schema](https://learn.chatgpt.com/docs/app-server#message-schema), [developer commands](https://learn.chatgpt.com/docs/developer-commands#codex-app-server), retrieved 2026-10-22.

| Variant / bundle | Bytes | SHA-256 |
| --- | ---: | --- |
| Normal combined | 730,500 | `408e09849d5d4931992a4227a7f3eb80b15d24901f84aca0562e816634651a82` |
| Normal v2 | 628,192 | `d204b96d8560d56600127423b89df9db471b3e22338e8809bb91d5a952998978` |
| Experimental combined | 890,285 | `af491b61b83ff04943f2207268d2539d09b6e4bea7aef9972adb9eda2026d1be` |
| Experimental v2 | 776,767 | `f826863e71e4e5678d6900a87c916414a1c5a06ca805d42037e8f91a762688e9` |

Bundle filenames are `codex_app_server_protocol.schemas.json` and `codex_app_server_protocol.v2.schemas.json`. “Normal” means generated without `--experimental`; it does **not** mean stable or production-supported. Normal `ClientRequest` contains 105 methods; experimental contains 172. Normal `ServerRequest` contains 10 methods; experimental contains 11. Presence outside the reviewed subset gives no permission to dispatch a method.

## Method and field declarations

All rows below are local exported-schema observations, not live behavior tests. “Required” lists the schema's top-level required parameters; CodexControl's future policy must impose its own stricter explicit project, ownership, approval and execution limits. The full schemas remain local evidence. This table is intentionally a selected control matrix, not a generic RPC specification.

| Native method / direction | Export | Required fields | Material observed fields and limits |
| --- | --- | --- | --- |
| `initialize` — client request | Normal | `clientInfo` | Optional capabilities include `experimentalApi`; no initialization performed. |
| `thread/start` — client request | Normal | None | `cwd`, `model`, `modelProvider`, `approvalPolicy`, `approvalsReviewer`, `sandbox`, `serviceTier`, `ephemeral`. Defaults are not authority. |
| `thread/resume` — client request | Normal | `threadId` | `cwd`, model/policy overrides and `excludeTurns`. `history`, `path`, `permissions`, `runtimeWorkspaceRoots`, `initialTurnsPage` appear only in the experimental export. |
| `turn/start` — client request | Normal | `input`, `threadId` | `sandboxPolicy`, `approvalPolicy`, `approvalsReviewer`, `effort`, `serviceTier`, `serviceTierForTurn`, `clientUserMessageId`. Native persistence/idempotency semantics remain unverified. |
| `turn/steer` — client request | Normal | `expectedTurnId`, `input`, `threadId` | `expectedTurnId` is required; do not steer a replacement turn after stale-state failure. |
| `turn/interrupt` — client request | Normal | `threadId`, `turnId` | Declaration does not prove all child processes stop, or supply a global stop-all operation. |
| `command/exec` — client request | Normal | `command` | `cwd`, `processId`, `tty`, `size`, `streamStdin`, `streamStdoutStderr`, `sandboxPolicy`, `timeoutMs`, `outputBytesCap`, `env`; also declares `disableTimeout` and `disableOutputCap`. These bypass-like knobs are not authorized defaults. `permissionProfile` is experimental-only. |
| `command/exec/write` — client request | Normal | `processId` | `deltaBase64`, `closeStdin`; future input admission still needs independent grants and current ownership. |
| `command/exec/resize` — client request | Normal | `processId`, `size` | Native dimensions and range checks need adapter validation. |
| `command/exec/terminate` — client request | Normal | `processId` | Native termination acknowledgement is not independently observed process exit. |
| `item/commandExecution/requestApproval` — server request | Normal | `itemId`, `startedAtMs`, `threadId`, `turnId` | Optional `approvalId` and `kind` must remain distinct from the JSON-RPC request ID and item ID. `availableDecisions` and `additionalPermissions` are experimental-only. |
| `item/fileChange/requestApproval` — server request | Normal | `itemId`, `startedAtMs`, `threadId`, `turnId` | Optional `grantRoot`, `reason`; response requires `decision`. |
| `item/permissions/requestApproval` — server request | Normal | `cwd`, `itemId`, `permissions`, `startedAtMs`, `threadId`, `turnId` | Response requires `permissions`; optional `scope`, `strictAutoReview`. No broader grant is inferred from accepting a different request kind. |
| `item/tool/requestUserInput` — server request | Normal, described EXPERIMENTAL | `isBlocking`, `itemId`, `questions`, `threadId`, `turnId` | `autoResolutionMs` is deprecated. Response requires `answers`. Never auto-answer from a local timer. |
| `mcpServer/elicitation/request` — server request | Normal | Base `serverName`, `threadId`, plus mode-specific fields | Form/URL variants differ; experimental export adds user-verification mode. Separate request handling and URL policy remain unimplemented. |
| `process/spawn`, `process/writeStdin`, `process/resizePty`, `process/kill` — client requests | Experimental only | Spawn: `command`, `cwd`, `processHandle` | A different process contract. Not a substitute for `command/exec`, and not enabled by this foundation. |
| `thread/shellCommand` — client request | Normal | See retained schema | Normal export presence does not make it eligible. Excluded from the control subset because of its different privilege contract. |

The ordinary `RequestId` declaration permits a string or an int64 integer. Preserve the type in correlation keys; JavaScript integers beyond safe precision require separate adapter handling. Native command/file decision declarations distinguish `accept`, `decline`, `cancel` and session/policy variants. Initial product approval policy remains one-time only. None of these replies has been sent.

OpenAI's reference places `command/exec` under configured sandbox policies and documents streamed/PTY interaction; it explicitly describes experimental `process/*` and `thread/shellCommand` as unsandboxed. A host-owned `node-pty` terminal has yet another OS identity and lifecycle contract. These paths cannot share a blanket “terminal supported” claim. [Command execution](https://learn.chatgpt.com/docs/app-server#command-execution), [process execution](https://learn.chatgpt.com/docs/app-server#process-execution). Detailed research provenance remains in the enclosing workstream's research register, outside this distribution.

## Passive probe and evidence

`control/scripts/probe-codex-schema.mjs` accepts only an absolute explicit executable path and an optional pair of absolute retained-schema directories. It rejects an unknown binary hash/platform, shells/wrappers, relative paths, unknown flags and incomplete reuse pairs. It never discovers a different executable via PATH and has no generic RPC facility.

Without reuse arguments its only native commands are `--version`, `app-server generate-json-schema --help`, and normal/experimental `app-server generate-json-schema --out ...` exports. Each runs without a shell, with hidden Windows process windows, ignored stdin, a reduced environment without inherited provider tokens, a 15-second timeout and a 128-KiB output cap per stream. Generated files go into a unique directory beneath this worktree's ignored `.local/control-compatibility/`. Exact binary hashes are checked before and after native commands. Failures expose bounded reason codes, not raw stderr or personal paths.

Export validation checks at most 2,048 JSON files, 32 directories, 64 MiB total and 2 MiB per file after child exit. These are inspection/admission limits, not an OS disk quota. The pinned binary and ordinary local filesystem permissions remain trusted prerequisites; pre/post hashing does not provide a kernel lock against executable replacement. This utility is not a sandbox, publisher verifier or credential-isolation mechanism.

The final executed 2026-10-22 check used reuse mode: it independently rehashed the existing executable and all four retained schema bundles, copied the full bundles into worktree-local evidence, and performed structural checks. It launched **zero native commands** (`nativeCalls: []`). Its report is `.local/control-compatibility/probe-SU0s3V/probe-report.json`, SHA-256 `e4fb993117b4284961ecc9af497544c5261916b56fdbd8c4783b1a5b4b046412`, observed at `2026-10-22T10:16:53.151Z`. The prior version/help/schema observation is reused only because all exact byte hashes match. Fresh export execution and its timeout/output-limit failure paths were not rerun in P0–P1. Native output and output fingerprints are excluded from passive-stage receipts; those receipts keep only stage, exit/signal and byte counts.

Example invocation, with actual approved absolute paths supplied locally:

```powershell
node control/scripts/probe-codex-schema.mjs --executable $codexExecutable --reuse-normal $normalSchemaDirectory --reuse-experimental $experimentalSchemaDirectory
```

`control/lib/compatibility.mjs` returns `DECLARED_ONLY` only when platform/version/executable and all four exact bundle hashes match and the selected method/required-field contract passes. It always returns `executionAllowed: false`, no qualified operations, account capability UNKNOWN and runtime verification NOT_RUN. Changed/missing/malformed/unknown input returns UNAVAILABLE; there is no “latest compatible” fallback. Its structural inspector covers a bounded subset of exported JSON Schema; it is not a general schema validator or runtime request validator.

## Validation and remaining gates

The final serial suite (`node --max-old-space-size=128 --test --test-concurrency=1 control/tests/*.test.mjs`) passed **78 tests, 0 failed, 0 skipped**, including all **20 compatibility tests**, on Node `24.19.0`, Windows x64. Compatibility tests cover identity drift, changed same-size schema bytes, unknown variants, malformed/oversized input, required steering/request fields, missing methods, new native required arguments, duplicate methods, external/broken references, unsupported parameter unions, immutable pins, fixed passive argv, invalid CLI flags, hostile evidence/option/argument accessors and proxies, revoked proxies, decorated Buffer hooks, and refusal to execute an unrecognized file named `codex.exe`. Compact schema fixtures are TEST_ONLY. The separate reuse report is the positive check against real retained exports.

Runtime handshakes, authentication, account entitlement, sandbox enforcement, policy decisions, provider turns, approvals, resume, terminal IO, process-tree termination, host enrollment, services, Linux behavior and production deployment remain **NOT_RUN**. Qualified-preview/production enablement requires the later P2–P8 implementation and exact live acceptance evidence. Claude/Gemini remain optional P9 candidates with no adapter/dependency/runtime claim in P0–P1. No private prototype is promoted to accepted integration by this matrix.
