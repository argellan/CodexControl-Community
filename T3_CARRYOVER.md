# T3 carryover and remaining integrations

This application adapts selected read-only architecture and presentation patterns reviewed from T3 Code. It does not bundle the full T3 provider runtime. The retained MIT notice is in THIRD_PARTY_NOTICES.md. Review reference: upstream commit `ce2815d665acb0dedc028c12109d3b7aebbcc134`.

| Capability | Current implementation | Limits |
| --- | --- | --- |
| Durable event history | SQLite journal, committed ingestion cursor, retention and equal-time paging | Retention gaps are disclosed; no claim of complete native history |
| Recovery | Cursor catch-up, epoch changes, bootstrap/backfill distinctions, frozen replay | History does not animate as a fresh live burst |
| Source normalization | Bounded passive native records, title metadata and provenance | A supported-native-version fixture matrix remains incomplete |
| Workers/subagents | Host-scoped identities, explicit parent edges, context/model/input states | Missing parents and incomplete capture remain visible |
| Connection handling | Sole retry owner, exponential backoff and jitter, bounded requests and server retry guidance | Network partitions and resource saturation still require deployment qualification |
| Usage | Host/session observed counters and context; optional native account-reader weekly limits, lifetime/peak daily tokens and daily history; visible meters and usage details | Account-wide data requires administrator access and local opt-in; copied sessions may overlap; missing/changed identity stays unlinked; no billing inference |
| Profile | Visible Profile/sign-in entry, own account/access settings and session-revoking sign-out | Observer account and connected Codex subscription are distinct; no provider login, SSO/MFA or email recovery |
| Timeline | Density overview, event groups, minimap, source/event seeking, bounded durable pages | Bounded rendering; no unbounded message log |
| Scoped access | Separate collector/viewer/admin identities, host/project scopes, password accounts, personal profiles | SSO/MFA/email recovery are not implemented; not a high-isolation multitenant service |
| Observation plane | Compact source/worker icons, real outbound/return branches, retained quiet topology, live/replay distinction | Routes reflect captured evidence, not inferred execution or verified outcomes |
| GitHub repository/check/artifact evidence | Optional scoped repository/branch/PR base/head SHA, check/status/run and artifact metadata; conditional recovery and separate immutable metadata archives | Requires explicit read-only GitHub enrollment and effective permissions; Checks coverage can be partial. No artifact bytes, raw diffs, file contents, merge/approval or execution controls. See [GitHub guide](docs/design/GITHUB_INTEGRATION.md). |
| Detailed process telemetry | Source/system and observer diagnostics | No demand subscriptions, PID/start identity history, I/O/job attribution |
| Reviewed Obsidian handoff | Frozen filtered observation metadata, optional reviewer summary, explicit confirmation and local Markdown/JSON/manifest ZIP | At most 1000 events; aliases/day dates; not a full archive or structured artifact handoff; no automatic vault access |
| Historical archive analytics | Optional DuckDB projection with administrator-only HTTP, CLI and MCP daily/response reports | Disabled until configured and qualified on its target; known subtotals, conflicts and projection lag stay explicit. Projection does not ACK custody, reconstruct the hot head or activate Timescale. See [analytics guide](docs/design/HISTORICAL_ANALYTICS.md). |
| Native voice / cloud presence | Explicit unavailable state | No supported attachment to desktop-owned Dot voice or account-wide Cloud discovery |

Each source machine must be enrolled deliberately. A remote execution target also needs real producer metadata binding its job to the originating host/session/call. Diagnostic events alone do not qualify that integration.

Execution controls, interactive terminals, approval replies, worktree changes, provider launch/resume and automatic placement remain outside this read-only program. Native voice observation, additional repository providers, artifact-content sources, process telemetry, broader installation tests, accessibility and sustained concurrent fleet/browser load are separate work. Journal-only throughput evidence must not be described as whole-fleet or 300-worker acceptance.

## Provenance boundary

The retained T3 MIT notice remains applicable distribution material while provenance is reviewed. The launch report describes a bounded selected-file comparison, not whole-project clearance or proof of ideas-only reuse. No attribution is removed or narrowed here. Preserve LICENSE, THIRD_PARTY_NOTICES.md and the font OFL with their distributed assets.
