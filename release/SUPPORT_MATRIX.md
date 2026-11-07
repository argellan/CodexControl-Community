# Operating scope and qualification

## Community 0.1.0 scope

This matrix retains historical 1.2.0 source and host qualification. It does not qualify the Community 0.1.0 native Windows candidate. Community source includes bundled local runtimes, local archive/analytics transport and Windows service observation; installer/lifecycle results belong to the existing CE checkpoint. NTFS archive publication, durability and ACL equivalence, exact-candidate performance, all-feature and device acceptance remain open. The historical INTERNAL validation record is deliberately not distributed with this preview.

## Retained historical qualification



Local candidate: 1.2.0 rc3, canonical base `8a3c532e1b4fb323649b00b07fa3b5a4e14cb55d` plus the integrated documentation, artwork, packaging and test changes. Demo captures retain their original `2021b98241e208305960008e6c0e6aa026a207e3` baseline; shared interface bytes are bound separately. A source review, synthetic browser exercise and historical host test establish different things.

The operating model is a self-hosted read-only observer on a private trusted network. Each source is deliberately enrolled. Node.js 24 is required; 24.19.0 is the recorded tested baseline. No npm dependencies or provider API key are required by the observer.

## Browser clients

| Browser / device | Evidence and qualification limit |
| --- | --- |
| Desktop Chrome / Windows x64 | The original documentation job exercised the actual `2021b98241e2` 1.2.0 application in an isolated browser context with an invented fixture. See [demo evidence](docs/DEMO.md) for the exact browser, viewport and interactions. This does not qualify installation, real collection or a final integrated build. |
| Other recorded desktop/narrow viewports | The historical INTERNAL validation record and retained [rendering notes](docs/design/RENDERING_PERFORMANCE.md) describe selected fixtures. They are not a complete named-browser/version acceptance matrix. |
| Edge and Firefox | No fresh acceptance receipt is supplied by this job. Chromium similarity alone is not Edge qualification. |
| Safari on macOS and actual iPadOS Safari | Not exercised by this job. WebKit automation, if recorded elsewhere, must remain separate from actual Safari. An iPad browser test would not qualify an Apple Silicon Mac hub or collector. |
| Assistive technology / touch | Source includes semantic controls, keyboard paths and reduced-motion support. Selected checks are recorded; full screen-reader, touch-device and WCAG conformance qualification is not established. |

## Hub hosts

These rows retain the historical qualification described in the baseline SUPPORT_MATRIX and historical INTERNAL release validation. They are not new host tests by the documentation job. Reuse requires the unchanged path and an exact candidate binding.

| Hub environment | Recorded evidence and remaining limit |
| --- | --- |
| Windows x64 / Node 24.19.0 | Recorded fresh candidate setup, foreground start/stop, application-pointer update, settings and history-epoch persistence. Windows OS reboot/login transition was not exercised in that qualification. |
| Raspberry Pi 5, 8 GB / Debian 13 ARM64 / Node 24.19.0 | Recorded isolated install/update/stop; user systemd service, TLS/instance trust, synthetic ingest/duplicate handling, restart/crash recovery and actual machine reboot with retained identity, epoch, cursor, preferences and pending data. This qualifies the recorded service/setup path; changed integrated assets need their own binding. |
| Linux x64 | Fresh hub installation not separately qualified in the baseline. Experimental outside the reference configuration. |
| Pi 5 2 GB / 4 GB, other ARM boards | Capacity and lifecycle qualification not established. The 8 GB result cannot be generalized to these variants. |
| macOS / Windows ARM64 | Hub qualification not established. Browser access is a separate question. |
| Containerized dashboard / public internet / multitenant service | Not qualified. The optional archive receiver has a separate deployment boundary. |

## Collectors and sources

| Collector / source | Evidence and qualification limit |
| --- | --- |
| Windows x64 generic enrollment path | Baseline records endpoint/instance checks before credential delivery, wrong-target refusal, private ACL, initial acknowledged batch, interactive limited-user task registration and execution of its action. The actual Windows OS reboot/login transition remained unexercised. |
| Linux x64 execution target | Existing source evidence is recorded. Explicit originating host/session/call binding is required; a diagnostic event alone does not qualify remote-job correlation. |
| Native Codex source versions | Supported sanitized contracts and fixture tests exist, but a complete native-version matrix remains incomplete. Unknown compatibility stays unknown. |
| macOS / Windows ARM64 collector | Not qualified by the above host/browser evidence. |
| Claude Code / automatic Cloud discovery / native desktop voice | No shipped qualified observation workflow. Browser companion artwork or activity does not prove native voice/mute state. |

## Optional archive analytics host

| Component | Availability and qualification boundary |
| --- | --- |
| DuckDB 1.5.6 archive projection | Separate optional Python/engine installation, disabled until configured. Local actual-engine/source qualification is recorded in the [analytics guide](docs/design/HISTORICAL_ANALYTICS.md); no production target, forced-key, service, filesystem, resource or catch-up acceptance follows from this review. |
| Historical HTTP / CLI / MCP reports | On demand for authenticated unrestricted administrators. Original four adapters remain hot-cache queries; `history-analytics` uses the separately qualified archive projection. No browser panel or polling is added. |
| Custody and coverage | Rebuildable projection, not the immutable archive authority. It does not ACK receiver/Pi custody, edit catalog progress, permit event eviction or establish full provider history. V3 GitHub metadata remains separate from usage totals. |

## Data, scale and known limits

History replay is bounded to retained journal coverage. Local event observations have no verified off-host event-archive receipt path and remain on local SQLite beyond cache targets. Usage has a separate exact-version durable archive contract; GitHub metadata has its own archive path. Pending versions survive destination outages. Aggregates do not replace full-fidelity captured records. Active SQLite belongs on local disk, never SMB/NFS; NAS holds closed immutable segments and verified snapshots.

The reference hub is a Pi 5 with 8 GB and a small deliberately enrolled fleet. Browser workloads, viewports and retained windows affect rendering. Existing synthetic requestAnimationFrame callback-gap samples do not measure GPU delivery, qualify 300 agents or promise sustained 60 fps. This job makes no new performance claim. Display aggregation never authorizes dropping durable records.

Sampled burn is accepted counter increases over a rolling window, not provider generation speed or billing. Response, last-response, turn-total and thread-total scopes overlap and must not be summed. Missing counters remain unknown. Numeric reasoning is an output subset; reasoning text is excluded. Native account readings require opt-in, source compatibility and administrator access, and remain separate from worker counters.

Execution controls, provider launch/resume, approval replies, interactive terminals, SSO/MFA/email recovery, mobile/TV applications and direct Timescale querying or arbitrary NAS SQL are not supported workflows. Optional administrator archive reports follow the separate DuckDB integration above. A running process, passing doctor, sample screenshot or staged restore is not operational acceptance.

Maintainer release-register validation requires PowerShell 7.4+ only for that maintainer task. Validator exit 0 establishes consistency, not authenticated evidence, release permission, full-instance backup or actual restore. See the [release protocol](docs/release/README.md).
