# CodexControl Interface Atlas
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

Version 1.2.0 - ARGELLAN. Local rc3 reference for canonical base `8a3c532e1b4fb323649b00b07fa3b5a4e14cb55d` plus integrated documentation, artwork, packaging and test changes; deployment and publication remain separate. This atlas identifies controls and evidence meanings. Use the [manual](USER_MANUAL.md) for procedures and recovery. Schematics explain layout; they are not application captures or performance evidence. Actual synthetic screenshots are provided separately in [the demo guide](DEMO.md).

## Atlas index

The PDF has one reference topic per page after this index. Body, table and schematic labels are at least 10 pt. Full-resolution application captures remain separate so their small UI labels are not reduced to unreadable print thumbnails.

| Reference topic | What to find |
| --- | --- |
| Header and workspace | Navigation and linked panels |
| Scope and clocks | Live source window versus frozen replay |
| Flow relationships | Calls, results, workers and missing evidence |
| Ribbon lanes | Source-timed records and aggregation |
| Zoom and navigation | Separate view scales and keyboard alternatives |
| Inspector | Identity, timestamps, provenance and limits |
| Investigation context and evidence basket | Temporary references and bounded comparisons |
| History and Replay | Durable pages, gaps and return to Live |
| Usage counters | Inclusive counts, subsets and unknown values |
| Reviewed exports and Handoff | Preview, disclosure and confirmation |
| GitHub repository evidence | Independent metadata clock and coverage |
| Settings, Profile and Dot | Personal settings and capability boundaries |
| Optional archive analytics | CLI/MCP location, availability and projection limits |
| Preservation and limits | Archive distinctions and support evidence |

## Header and workspace

Where: top header and the main workbench. Applies to 1.2.0. The schematic shows functional relationships, not pixel positions at every viewport.

<!-- schematic:workspace -->

| Label | Meaning and action |
| --- | --- |
| Live / History | Current observation window / retained journal browsing |
| GitHub | Optional separately timed repository metadata |
| Handoff | Freeze a bounded selection for reviewed local export |
| Alerts / Usage / Settings | Attention evidence / numeric observations / supported configuration |
| Fleet & workers | Authorized hosts and observed sessions; select a lane |
| Flow / Ribbon | Two presentations of captured source evidence |
| Spans / Events / Turns | Paired operations / individual records / turn context |
| Inspector | Details for the selected host, worker, route or event |

Keyboard: Tab and Shift+Tab move focus; Enter or Space activate native controls. Use the first **Skip to workspace** link to reach the main surface. Layouts and small viewports can hide or rearrange panels while collection continues.

Related task: manual, **Orient yourself in the workspace**.

## Scope and clocks

Where: investigation strip and command bar above the observation plane. The header also shows wall-clock time and connection state.

| Reading | Meaning and alternate state |
| --- | --- |
| LIVE and Window | Current source-time window over newly received and retained evidence |
| REPLAY and source time | Frozen evidence selection at the replay position |
| Host / Project / category | Presentation filters within existing authorization |
| Worker search / All lanes | Narrow matching workers; clear only the selected lane |
| Reset filters | Clear filters and lane while keeping Window/replay position |
| Previous context | Return to an earlier compatible investigation selection |
| Return to live | Leave Replay and inspect the current feed |

Complete caveat: **Replay host health is unknown. Current inventory does not reconstruct historical host health.** A connected source may be quiet, and an old screen may be retained during disconnection. These states do not prove current execution or successful completion.

Wall clocks, source timestamps, receipt times and the replay cursor are distinct. Changing a display clock does not rewrite evidence. Keyboard/touch users can use the native selectors and buttons; no drag gesture is required for those choices.

Related tasks: manual, **Filter without changing collection** and **Replay and browse durable events**.

## Flow relationships

Where: **Flow** in the observation-plane header. Use **Key** for the application legend. This diagram is schematic and uses invented identities.

<!-- schematic:flow -->

| Visual | Evidence meaning |
| --- | --- |
| Source station | Machine that supplied observations; a heartbeat is not a running model turn |
| Worker station | Observed session with a host-scoped identity |
| Outbound call | A captured tool start for the scoped call |
| Return | A result captured for that same scoped call |
| Parent/hosting branch | Explicit recorded relationship; no traffic implied |
| Job report | Target report with explicit originating worker binding |
| Quiet/historical route | Retained context without new live activity |
| Missing result | Completion was not captured; ongoing execution is unknown |

Select a route or station to inspect its source evidence. Enter/Space provides the keyboard equivalent for focusable map controls. A group can represent multiple calls: inspect its members rather than treating the drawn path as one execution.

Complete caveat: **Crossing lines do not establish a relationship. A recorded return is not independent acceptance or verification of task success.**

Related task: manual, **Read the Flow map**.

## Ribbon lanes

Where: **Ribbon**, beside Flow. Applies to 1.2.0. Worker lanes share the source-time axis; thickness and groups represent recorded events, not a packet trace or one marker per token.

<!-- schematic:ribbon -->

| Control or mark | Meaning and action |
| --- | --- |
| Worker lane | Source records grouped under a worker identity |
| Event cluster | Bounded representation of source events in a time bin; inspect members |
| Inspect events | Open an inspectable event route to the same retained evidence |
| Key | Open the Ribbon legend |
| Pause | Pause presentation motion; capture continues |
| Expand | Give the Ribbon more room; restore with the same control |
| Cursor / time axis | The current Live window or Replay source clock |

Select a marker for evidence. Use **Inspect events** or the timeline for a keyboard-accessible record list. The Ribbon viewport accepts focus and arrow-key scrolling; visible zoom buttons avoid requiring a wheel gesture.

Quiet lanes and missing returns do not establish ongoing work. A grouped marker is a visual projection; the underlying durable record is not discarded by aggregation. The synthetic capture does not qualify live throughput or a fleet-size limit.

Related task: manual, **Inspect the timeline and Ribbon**.

## Zoom and navigation

Where: the observation-plane header and its scrollable view. Flow and Ribbon maintain independent zoom values.

| Action | Behavior and boundary |
| --- | --- |
| Zoom out / Zoom in | Change the current view's scale within 50-300% |
| Fit | Reset the current view to its fitted 100% scale |
| Ctrl + mouse wheel | Zoom inside the observation view around the pointer |
| Scroll / arrow keys in Ribbon | Pan available content |
| Expand / restore | Change presentation space without changing capture |
| Timeline density | Seek captured source activity, possibly entering Replay |
| Previous context | Revisit earlier investigation scope when available |

The visible native buttons are keyboard/touch alternatives to wheel zoom. Source inspection and button exercise are distinct from a physical Ctrl+wheel or touch-device test. Do not describe this documentation job as qualifying those devices or gestures.

Zoom does not change a record's identity, source timestamp, collection scope or retention. Switching Flow/Ribbon restores each view's own scale. Source labels and selection should be interpreted at the named clock and scope.

Related tasks: manual, **Read the Flow map** and **Keep an investigation context**.

## Inspector

Where: select a map route, worker, event or timeline operation. **Investigation tools → Dock inspector** can keep it beside the evidence views.

| Field | Interpretation |
| --- | --- |
| Event ID / Session / Host | Scoped captured identity; compare these across views |
| Kind / category | Sanitized event classification |
| Outcome | Source-reported result state; not independent acceptance |
| Duration | Available paired elapsed time, or unknown/open |
| Turn / Call / item | Native correlation identifiers when captured |
| Time source / Delivery / Source | Timestamp basis, bootstrap/backfill/live distinction and provenance |
| Group members | Underlying source records for an aggregated route |

An open start has no captured matching completion. The dashed duration stops at captured evidence rather than declaring indefinite execution. **Focus this session** narrows the presentation. Escape clears selected map evidence; the Inspector close button dismisses its view.

An observed failure directs investigation back to the native source for deliberately excluded details. Prompts, arguments, raw output and private reasoning are not reconstructed here.

Related task: manual, **Sign in and inspect your first event**.

## Investigation context and evidence basket

Where: **Investigation tools** above the command bar. These are temporary browser investigation aids.

| Control | Meaning and limit |
| --- | --- |
| Pin this context / Return to pinned context | Save and revisit one compatible presentation reference |
| Mark review point / Since review | Compare later visible evidence in the same Live scope |
| Pin comparison window / Compare windows | Compare bounded browser selections |
| Pin selected evidence | Add an event reference to the basket |
| Evidence basket | Review at most 64 references; remove any reference |
| Open retained History | Request missing retained records on demand |
| Review available pins in Handoff | Export review only for available pinned source records |
| Dock inspector | Keep Inspector visible alongside the workbench |

References do not duplicate or replace journal records. If a referenced record has left the browser cache, the basket says so and offers History. It does not infer a substitute or guarantee the record still exists in retained history. A permission/authority change clears incompatible state.

Use the native disclosure and buttons with Tab/Enter/Space. A disabled comparison/review control usually lacks a compatible context; read the scope strip before drawing a conclusion.

Related tasks: manual, **Keep an investigation context** and **Pin evidence for review**.

## History and Replay

Where: header **History**, command-bar **Replay**, and the replay range controls.

| Control or state | Meaning |
| --- | --- |
| Before local time / Load | Request a bounded page before the chosen source-time boundary |
| Older page | Move to earlier retained records when available |
| Select event / Replay page | Inspect that event or the loaded page at source time |
| Play replay / 1x, 4x, 16x | Advance the presentation cursor; no agent execution |
| Recent window / All retained | Choose the frozen capture range |
| Catching up | Historical recovery without new-live marker animation |
| Offline retained view | Earlier evidence remains; current source state is unknown |
| Gap / changed epoch | Continuity limit requiring an honest boundary |

Return with **Live** or **Return to live**. Newly arriving observations can continue to collect while the frozen Replay selection remains unchanged. Reload, reconnect and backfill must not turn old records into fabricated live traffic.

A bounded page or current browser buffer is not complete history. A historical gap stays a gap. Replay does not reconstruct native conversations, historical host health, private outputs or past token flights.

Related task: manual, **Replay and browse durable events**.

## Usage counters

Where: header **Usage**, the usage strip and expandable **Captured response evidence**.

| Counter or scope | Interpretation |
| --- | --- |
| Inclusive input | Contains cached input already |
| Cached input | Input subset; never add it a second time |
| Cache-write input | Separate source component where reported |
| Inclusive output | Contains numeric reasoning output already |
| Reasoning | Numeric output subset; no reasoning text |
| Reported total | Source total with its own scope |
| Response / last response / turn / thread | Different, potentially overlapping scopes; do not sum |

Visual channels are I new input, O inclusive output and C cached input. Letters and patterns supplement color. Configured model/effort is context, not established producing-model attribution.

Missing counters remain unavailable. A comparable ratio can use a smaller valid source subset while a complete response sum stays unavailable; inspect numerator, denominator and coverage before comparison. Sampled burn is counter increase divided by an observation window, not provider generation speed or billing.

Native account allowances require separate opt-in/source/role conditions. They use wall-clock readings and remain independent of map Replay. Separate accounts are not pooled.

Related tasks: manual, **Read compute and token usage** and **Understand the six counters**.

## Reviewed exports and Handoff

Where: **Usage → Preview local export**, or header **Handoff**. Both freeze bounded snapshots for local review.

| Surface | Controls and boundary |
| --- | --- |
| Usage preview | Scope, row count, caveats, image and first allowlisted rows |
| Disclosure choices | Raw identities and precise timestamps start off; each requires a separate choice |
| Usage formats | JSON, CSV, SVG and PNG; at most 1,000 rows |
| Handoff table | Readable rows; Previous 50 / Next 50 changes only the page |
| Raw JSON | Exact sanitized frozen Handoff payload |
| Reviewer summary | Optional text, at most 2,000 characters; included as reviewed |
| Reviewed checkbox | Required before Handoff download; changing summary clears it |
| Handoff ZIP | Markdown, observations JSON and manifest; no automatic vault access |

Aliases and day-level dates do not guarantee anonymity. Review activity patterns before sharing. An open preview does not automatically download, post or send anything. Reopen it to capture a newer selection. A downloaded bounded packet is not a full archive, conversation or independently verified result.

Related tasks: manual, **Export a usage view** and **Prepare an Obsidian handoff**.

## GitHub repository evidence

Where: header **GitHub**. Optional administrator enrollment supplies read-only scoped GitHub.com metadata.

| Record or state | Meaning and boundary |
| --- | --- |
| Repository / branch / PR | Stable IDs, source binding and exact base/head SHAs |
| Check / commit status / workflow run | Reported metadata with its available permissions and coverage |
| Artifact | Metadata and reported digest; bytes are not downloaded or independently verified |
| Captured history | Immutable metadata observations, including conditional validations |
| Refresh view | Return to the latest stored summary; not a forced API collection |
| Current / partial / stale / unavailable | Independent capture state, not permission to merge or proof of a passing build |
| Archive custody | Separate GitHub metadata archive state |

The GitHub panel has its own capture/validation clock and does not follow map Replay. Unavailable checks are not passing or empty checks. Token-specific effective permissions and Checks enrollment must be qualified separately. No merge, approval, dispatch, cancellation, source-content retrieval or artifact download is supplied.

Keyboard: native repository selectors, disclosures and links. See the [GitHub guide](design/GITHUB_INTEGRATION.md) for enrollment; keep credentials out of the browser and artifacts.

Related task: manual, **Inspect GitHub repository evidence**.

## Settings, Profile and Dot

Where: header **Settings**, **Profile** and **Dot**. Available destinations depend on authenticated role and configured capabilities.

| Destination | Meaning and limit |
| --- | --- |
| Personal appearance/layouts/clocks/motion | Saved presentation; collection continues |
| Find a setting / Section picker | Local task search and navigation, including narrow windows |
| Save changes / Discard draft | Revision-checked settings draft; account/enrollment actions are separate |
| Accounts / enrollment / history / diagnostics | Protected administration when configured |
| Backup & recovery | Managed snapshots and staged restore instructions; staging is not a completed restore |
| Control | Explicit unavailable control boundary; no remote operation |
| Profile | Observer identity, private photo and access; distinct from the Codex subscription |
| Dot | Observed presence/artwork; no native voice/mute/audio/transcript feed |

Use visible focus and native buttons. Dirty Settings drafts offer **Keep editing** or **Discard & close**. After a lost mutation response, refresh authoritative state before retrying. Keep unknown, failed and confirmed-empty reads distinct.

Reduced/paused motion stops presentation movement without stopping capture. Screen-reader and physical touch qualification remain separate from source inspection and desktop keyboard checks.

Related tasks: manual, **Work safely in Settings**, **Your profile and Dot**, and administrator recovery procedures.

## Optional archive analytics

Where: authenticated `history-analytics` CLI query, `codexcontrol_history_analytics` STDIO MCP tool, or the on-demand administrator HTTP API after separate activation. This feature adds no browser control or continuous polling.

| Reading or boundary | Meaning |
| --- | --- |
| Daily / responses | Archived source reports; daily session deltas and account readings stay separate |
| Pending segments / last projected time | Projection lag and import time, not source freshness or complete archive coverage |
| Exact integer strings / known | Precision-preserving known subtotals with contributor counts; missing is not zero |
| Conflicts / exclusions / truncated | Explicit limits on usable identities and bounded output groups |
| Ratio coverage | Comparable source numerator/denominator populations, not a complete account total |
| Unavailable | Missing/unqualified engine, projection or transport is not an empty history result |

The engine is an optional separately installed Python/DuckDB runtime, with its database on local storage at the analytics host. Full-scope authenticated administrator access and a qualified pinned transport are required. The immutable archive remains authoritative; projection neither acknowledges custody nor reconstructs the hot-cache head. V3 GitHub metadata is retained separately from token totals. Target-host/service/resource/catch-up qualification and activation remain separate from local source acceptance.

Related task: manual, **Query qualified archived reports**. Setup and recovery: [historical analytics](design/HISTORICAL_ANALYTICS.md).

## Preservation and limits

Where: **Usage → Usage database**, **Settings → History & archive**, and the [support matrix](../SUPPORT_MATRIX.md).

<!-- schematic:preservation -->

| Evidence family | Durable boundary |
| --- | --- |
| Event journal | Local SQLite replay/recovery; no verified off-host event receipt path in this baseline |
| Usage versions | Full-fidelity captured versions; exact-current-version durable receipt required before cache eviction |
| GitHub metadata | Separate immutable metadata history and archive custody |
| Aggregates / visual bins | Additional projections; do not replace captured source records |
| Backups | Verified coherent snapshots; a receipt count alone is not a restore test |

Complete caveat: **Archive loss preserves pending records and exposes backlog/storage pressure. Never delete pending evidence merely to meet a cache target.** Active SQLite stays local to its engine; NAS storage holds closed immutable segments and verified snapshots.

The reference hub is a Pi 5 with 8 GB. Smaller Pi variants, other hubs, actual Safari, native collectors and lifecycle paths require their own evidence. No screenshot, callback-gap sample or successful process start establishes universal compatibility or sustained 60 fps.

MIT code, T3's retained MIT notice, the JetBrains Mono OFL and the separate ARGELLAN trademark policy remain applicable. This atlas grants no execution authority, publication approval or expanded collection permission.

Related tasks: manual, **Understand preservation and storage** and **Administrator: backups and recovery**.


Maintainers: the [release protocol](release/README.md) provides candidate-bound evidence structure. Its validator establishes consistency only, not authenticated evidence, full-instance recovery, certification or action authority. It adds no runtime telemetry or hub PowerShell dependency.
