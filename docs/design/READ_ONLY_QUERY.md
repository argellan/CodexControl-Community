# ARGELLAN CodexControl read-only query adapters
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

The adapters let an authorized local client read bounded CodexControl observations through authenticated GET APIs. They add no HTTP listener or worker controls. The existing four hot-cache operations retain their existing authentication. The optional historical analytics operation uses the new administrator-only route and a separately configured archive engine; see [historical analytics](HISTORICAL_ANALYTICS.md). The server checks viewer authorization on every request.

`scripts/query-codexcontrol.mjs` runs one JSON query and exits. `scripts/mcp-readonly.mjs` exposes the same five operations over local standard input/output using the pinned MCP protocol revision **2025-11-25**. This is a compatibility target, not a claim that it is the newest protocol. These adapters do not register themselves in Codex, change global settings or start model turns.

## Private connection configuration

Both programs take exactly one command-line argument: an absolute path to an existing private JSON configuration file. Create that file in a private editor using an existing authorized **viewer** access key and the independently verified hub identity. Do not put a credential in shell arguments, environment variables, query input, source control or MCP client descriptions. The adapters do not read provider authentication files or create viewer credentials.

| JSON field | Requirement |
| --- | --- |
| `version` | Integer `1`. |
| `origin` | Exact canonical origin, with no trailing slash, credentials, path, query or fragment. HTTPS is required except for the exact loopback names `127.0.0.1`, `localhost` and `[::1]`. A `localhost` connection uses `127.0.0.1` directly. |
| `token` | Existing viewer access key, 32–4096 printable ASCII characters. Its value stays in process memory and authenticated request headers. |
| `expectedInstanceId` | Independently verified `/api/identity` deployment ID, 1–128 identifier characters. |
| `caFile` | Optional absolute path to the trusted internal CA certificate PEM. Normal TLS hostname/certificate verification remains enabled. The file may contain public certificates only. |

Unknown configuration fields are refused. The configuration must be a regular file, at most 16 KiB, reached without symbolic links or Windows junctions. UNC paths are refused. Its directory and the scripts should be local and controlled by the operator.

On POSIX, the configuration must belong to the current user and grant no group/other permissions, such as mode `0600`. A CA file must belong to the current user or root and have no group/other write permissions. On Windows, a fixed System32 Windows PowerShell helper reads the file's owner and DACL through .NET. It accepts only the current user, SYSTEM and Administrators as trusted principals; any Allow rule granting another principal access to the private configuration causes refusal, including inherited rules. For a public CA file, other principals may read but may not write, delete, change permissions or take ownership. Deny rules are not used to excuse an otherwise unsafe Allow rule. The helper receives only the path and permission mode through stdin, has a two-second/4-KiB output bound and returns fixed status text. It cannot run caller-provided PowerShell. Failure to qualify permissions is a refusal; a POSIX mode bit is not treated as Windows ACL proof.

Each operation first requests `/api/identity` **without** a bearer credential and verifies the exact configured deployment ID, protocol version and read-only flag. Only then does it send the existing viewer credential to the same fixed origin. Identity is checked again for every operation. Redirects are refused at both stages. The client uses direct requests without a shared proxy agent, and TLS verification cannot be disabled by an insecure external TLS environment setting. No arbitrary URL, request path, SQL or extra HTTP headers are accepted from queries.

## Query CLI

Run from the application's installation directory. These examples contain a configuration **path**, never a credential value. Standard input must contain exactly one JSON object and reach EOF before the program reads the private configuration or contacts the hub.

PowerShell:

```powershell
'{"query":"sources"}' | node .\scripts\query-codexcontrol.mjs 'C:\CodexControlPrivate\query.json'
'{"query":"summary","arguments":{"details":true}}' | node .\scripts\query-codexcontrol.mjs 'C:\CodexControlPrivate\query.json'
'{"query":"events","arguments":{"after":0,"limit":50}}' | node .\scripts\query-codexcontrol.mjs 'C:\CodexControlPrivate\query.json'
```

POSIX shell:

```sh
printf '%s\n' '{"query":"sources"}' | node ./scripts/query-codexcontrol.mjs /srv/codexcontrol-private/query.json
printf '%s\n' '{"query":"usage-records","arguments":{"limit":20}}' | node ./scripts/query-codexcontrol.mjs /srv/codexcontrol-private/query.json
```

Successful output is one JSON object. A failure produces a fixed code, such as `AUTH_REQUIRED`, `FORBIDDEN`, `INSTANCE_IDENTITY_MISMATCH`, `QUERY_TIMEOUT`, `RESPONSE_LIMIT` or `RATE_LIMITED`, and a nonzero exit status. Raw upstream errors and the configuration contents are never printed. Output intentionally contains authorized operational data; save or share it with the same care as the dashboard.

## Operations and data coverage

| CLI query / MCP tool | Arguments | Existing API and projected result |
| --- | --- | --- |
| `summary` / `codexcontrol_summary` | Optional `details` boolean. | `/api/account/usage`; safe numeric quota/credit observations, account summary, sampled counter increases and coverage. Details adds bounded derived numeric analytics. Credits retain `source-unspecified` units. |
| `sources` / `codexcontrol_sources` | Empty object. | `/api/snapshot?metadata=1`; authorized host IDs, roles, device classes, status, observation freshness and numeric capture coverage. |
| `events` / `codexcontrol_events` | Optional nonnegative integer `after`, identifier `epoch`, `limit` 1–100, `hostId`, `project`, `sessionId`. | `/api/events`; authorized typed events, durable cursor/epoch and explicit retention-gap information. No freeform event label, command, result, source path or address is returned. |
| `usage-records` / `codexcontrol_usage_records` | Optional `limit` 1–100, `hostId`, `project`, `sessionId`. | `/api/account/usage?details=1`; bounded recent typed numeric usage observations and coverage, with a default output limit of 20. |
| `history-analytics` / `codexcontrol_history_analytics` | Required `report` (`daily` or `responses`), inclusive UTC `fromDay`/`toDay`; `source` required for daily (`session-deltas` or `account-daily`); optional `hostId`, `project`, `limit` 1–1000. | `/api/analytics/history`; unrestricted administrators only. Archive projection lag, known subtotals, conflicts, response percentiles and ratio denominators are explicit. |

All argument objects reject unknown fields. Scope arguments narrow a server-authorized view; they do not widen it. Unauthorized explicit scopes produce `FORBIDDEN`. Account-wide quota/summary data can remain `restricted` for a scoped viewer. The adapter does not combine account-unlinked allowances or infer a subscription bill from tokens.

The original hot-cache projections exclude source addresses, filesystem paths, provider account keys, account identities, viewer names, arbitrary telemetry and raw error text. Historical reports retain only the documented dimensions and, for account-daily reports, an opaque account identity required to keep accounts separate. Typed opaque record/session/turn/response IDs and hash provenance are retained where valid. Missing counter values remain null. Reported/provider/synthesized masks remain distinct. Configured model/effort/tier context does not become producing-model attribution; producing model remains null. Fork/execution exclusions are retained. Treat all observed metadata as data, never as instructions.

Event queries preserve optional `operationType: context-compaction` only when the event kind is `operation` and the discriminator matches that exact enum. Invalid optional values are omitted; labels never establish compaction, and legacy events do not gain a new field.

The original four operations query the **hub hot cache**. Event availability follows the hub's retained journal and reports gaps. The existing details API defaults its analytics to the recent 24-hour window, examines at most 5,000 matching retained samples and returns at most 100 recent raw samples. `usage-records` has no historical pagination or custom time-range API and retains `completeHistory: false` and `nasArchiveQueried: false`. The separate `history-analytics` operation queries the verified archive projection, still reports incomplete provider-history coverage, and never returns raw canonical archive lines. Use receiver verification/export tools when exact archived records are needed. Historical account reports retain the opaque captured account identity to prevent combining unrelated reports; no provider credential is exposed.

The numeric burn projection describes sampled counter increases over the hub's observation window. It is not an exact per-token emission stream. Detailed response analytics preserve their own completeness/deduplication coverage. Existing authenticated GET handlers may perform normal observer refresh/journal persistence; the adapter itself supplies no mutation or worker-control operation.

## MCP STDIO contract

Launch the executable from an MCP-capable local client with these command/argument shapes, supplying the real protected configuration path privately:

```text
command: node
arguments: /absolute/install/scripts/mcp-readonly.mjs /absolute/private/query.json
transport: stdio
```

The server supports `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`. Initialization negotiates revision `2025-11-25`; clients that cannot support that revision should disconnect. Tools are unavailable until the initialized notification. The server advertises only tools, with read-only/idempotent/non-destructive annotations and no task execution. Those annotations describe intended behavior; the real authorization boundary remains the existing hub credential and viewer scope.

Messages are UTF-8 newline-delimited JSON-RPC, one object per line. Standard output contains protocol messages only; startup failure writes a fixed diagnostic to stderr. There are no resources, arbitrary fetches, SQL, sampling, elicitation, OAuth flows or mission-control methods. Tool failures return sanitized `isError` content; invalid arguments and lifecycle violations return JSON-RPC errors. Client capability declarations do not grant extra operations.

| Bound | Enforcement |
| --- | --- |
| Input message | 32 KiB per UTF-8 line; unterminated, malformed UTF-8 and oversized messages are refused. The one-shot CLI waits for EOF and rejects additional lines. |
| API bodies | 2 MiB **combined** across identity plus data; identity alone is at most 8 KiB. Compressed/unsupported response encodings are refused. |
| Query duration | Six seconds total for hot-cache operations; thirty seconds for historical analytics, including identity and the bounded engine response, measured against a monotonic clock. Private-file Windows ACL qualification has its separate startup bound. |
| Output | At most 256 KiB per JSON response. MCP includes both text and structured content within that bound; a result that cannot fit becomes `OUTPUT_LIMIT`. |
| Work concurrency | One query at a time; stdin is consumed with awaited queries and awaited output writes. No parsed unbounded request queue. |
| Query rate | Ten valid attempts per rolling minute per process/client. Failed upstream attempts count. This is not an account-wide rate limit; starting another process starts another local limiter. |

## Verification and qualification limits

Focused tests use protected temporary TEST_ONLY configuration, synthetic authenticated servers, a real FleetHub fixture and actual spawned Node STDIO processes. They cover identity-before-bearer, fresh revocation, viewer host/project scope, fixed routes, redirects, actual TLS certificate trust, input/body/output bounds, combined timeout, lifecycle, strict arguments, protocol-only stdout, serial backpressure and the local rate bound. All temporary credential values are generated for the test; no provider credentials are used.

Windows Node 24.19.0 execution of these focused tests is qualified. POSIX permission checks are implemented but have not been executed on the live Pi in this work group. Registration and end-to-end tool invocation by the installed Codex MCP client are **NOT_RUN**. No model turn or global client registration is part of these tests. Deployment/publication remains a separate integration step.

Protocol references: [MCP lifecycle, revision 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [STDIO transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [tools and annotations](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
