# Rendering efficiency and measurement
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

Data ingestion with maximum efficiency and the lowest practical overhead is a
core requirement. Preserve captured source records independently of display
limits. A bounded visual projection is not a retention policy.

## Current implementation

- Use elapsed time with `requestAnimationFrame`, without a fixed 15 ms paint
  gate that aliases high-refresh displays. Replay advances by elapsed time.
- Observe viewport and timeline geometry with `ResizeObserver`; do not measure
  layout after animation-frame writes. Limit timeline style updates to visible
  rows through `IntersectionObserver` and reuse unchanged widths and labels.
- Cache source timestamps, eligible evidence and spans until source revision or
  replay eligibility changes. Invalidate on exact replay boundaries, backseek,
  source replacement, resize, device-pixel ratio and relevant preferences.
- Build per-worker activity indexes once per update, preserving the original
  source precedence and worker state machine. Avoid repeated full-history scans.
- Retain DOM references and skip identical markup. Construct hidden Events and
  Turns markup when those tabs are selected. Spans and Events request exact
  density bins without constructing hidden turn groups. The pending-call,
  request, failure and selected-event bin priorities remain identical to the
  full Turns projection. Map mode skips Ribbon-only work.
- Reuse mutation-checked retained-record normalization and identity keys through
  weak caches. Keep deterministic actor collision coordinates in a bounded
  sixteen-entry cache, with current graph nodes rebound on every projection.
  Source statuses, task labels, records and directed routes remain current.
- Observe ticker intrinsic text and clipping widths instead of reading layout
  synchronously after replacing text. A stopped replay paints invalidations
  once, then sleeps on clock timers; playing replay and live motion use animation
  frames. The replay endpoint receives a final source-clock paint.
- Paint bounded Canvas overlays over inspectable SVG evidence. Reuse glow and
  coin sprites, channel indexes and active route samples. Clear the overlay once
  when activity ends; retained stations and routes remain visible.
- Suspend animation work in hidden documents. Preserve reduced-motion settings,
  explicit pause, source gaps and refresh/recovery watermarks. A refresh never
  turns retained source evidence into new live traffic.

## R16 qualified comparison

A fresh-scene Chrome comparison on the Windows workstation measured frozen R15
against the optimized R16 Full workspace at 1440 x 900, DPR 1, CPU 1x and no
network throttling. Each scene used four synthetic hosts, 24 workers, 5,000 seed
events and 48 new records every two seconds, with eight visible map workers,
one-minute scope, all hosts/projects/events, dark vivid theme and 14 px
JetBrains Mono. The observed windows lasted 15.35 seconds for R15 and 15.20
seconds for R16, with thirteen complete data renders in each.

These are **TEST_ONLY laboratory observations**, not Raspberry Pi measurements,
production-fleet acceptance, a repeatability study or a sustained 60 fps claim.
The local evidence is `r16-render-optimized-results.json`; its paired `baseline`
and `after` sections supply the values below. Stage timings are inclusive, so
they must not be added to complete-render time.

| Measurement | Frozen R15 | Optimized R16 Full |
|---|---:|---:|
| Visible events/min at start / end, rounded | 4.1K / 3.1K | 4.1K / 3.1K |
| Median frame interval | 16.7 ms | 16.7 ms |
| 95th-percentile frame interval | 33.3 ms | 16.8 ms |
| 99th-percentile frame interval | 166.7 ms | 133.4 ms |
| Frames taking more than 25 ms | 66 | 21 |
| Long tasks, count | 15 | 13 |
| Long-task total / maximum | 2,200 / 216 ms | 1,434 / 133 ms |
| Complete data renders, count | 13 | 13 |
| Mean complete data-render CPU time | 159.08 ms | 109.92 ms |
| Mean timeline-render CPU time | 44.39 ms | 16.61 ms |
| Mean ticker-render CPU time | 13.18 ms | 0.55 ms |
| Mean map-render CPU time | 55.58 ms | 51.58 ms |
| DOM elements, start / end | 3,347 / 3,347 | 3,413 / 3,413 |
| Encoded network bytes during measurement | 1,116,262 | 1,087,472 |

The one-minute event rate falls as older seed events leave the displayed
window; this is not deletion of source or archive records. Both scenes had the
same rounded rate trajectory, although their wall times and request completion
boundaries were not byte-identical. The small network-byte difference does not
establish an ingestion-bandwidth improvement.

The strongest measured reductions are in ticker and timeline work. The map
still averages about 52 ms per data render, and thirteen long tasks remain.
This iteration preserves the map styling, route geometry, source attribution,
refresh/replay watermarks and durable captured data. More map/SVG projection
work may be justified by subsequent measurements; no map-specific performance
guarantee is inferred from the bounded geometry cache alone.

## Historical R15 comparison

A historical paired synthetic browser test compared the renderer preceding R15
with R15 at 1440 x 900, device scale 1, CPU 1x and no network throttling. Each run
started a fresh deterministic scene: four hosts, 24 workers, 5,000 seed events,
48 new records per two seconds, eight visible map workers, one-minute scope,
all hosts/projects/events, vivid dark theme and 14 px JetBrains Mono. Fonts were
ready before a two-second warmup and a 15-second measurement under a Chrome
performance trace. This is a laboratory measurement, not a fleet-wide guarantee.

| Measurement | Pre-R15 renderer | R15 renderer |
|---|---:|---:|
| Retained events at start / end | 5,096 / 5,480 | 5,144 / 5,480 |
| Median frame interval | 16.7 ms | 16.7 ms |
| 95th-percentile frame interval | 33.4 ms | 33.3 ms |
| 99th-percentile frame interval | 350.0 ms | 199.9 ms |
| Frames taking more than 25 ms | 93 | 46 |
| Long-task total / maximum | 3,381 / 441 ms | 2,290 / 264 ms |
| Mean complete data-render CPU time | 330.8 ms | 174.0 ms |
| Mean worker / timeline / map render CPU | 24.7 / 92.9 / 99.3 ms | 8.0 / 37.8 / 69.8 ms |
| DOM elements | 4,788 | 3,347 |
| Forced-layout time in trace | 3,444 ms | 44 ms |
| Network bytes during measurement | 1,053,874 | 1,072,906 |

The R15 run processed twelve renders versus ten in the preceding run; the
workload was comparable, not byte-identical at every instant. Rendering gains
do not demonstrate an ingestion bandwidth reduction. Long tasks remain and this
does **not** establish sustained 60 fps under load. The residual forced layout is
the then-current ticker overflow measurement, addressed by the R16 observed-width
change above. This historical table must not be used as R16 acceptance evidence.

## Acceptance for subsequent work

Keep real-event attribution and durable completeness as correctness gates.
Measure cold recovery separately from a warmed live view. Record source counts,
viewport, DPR, display preferences, tab visibility, refresh rate, CPU/network
conditions, frame percentiles, long tasks, heap, transfer bytes and ingestion
latency. Restart synthetic scenes before paired runs; a continuously growing
fixture makes late measurements incomparable with early ones.

Evaluate incremental topology projection, cooperative work scheduling and a
module-worker projection only against measured hotspots. Account for structured
clone, synchronization and memory costs before moving work off the main thread.
Use WebGL or WebGPU only if Canvas painting becomes the measured bottleneck and
the fallback retains the same evidence, accessibility and motion semantics.
New rendering technology alone is not evidence of lower overhead.

Source-level tests cover cache invalidation, worker attribution, source tie
precedence, sprite reuse, viewport changes, idle clearing, replay and reduced
motion. Browser traces and actual visual checks are separate acceptance evidence.


## R17 narrow follow-up

R17 retains the ARGELLAN observation-plane layout, source-time semantics and
bounded animation budgets. Parsed string source clocks use a mutation-aware
WeakMap; filtering, ordering, worker state and expiry still run against the
current reference clock and metadata. Station buttons and their label/emblem
children are keyed by current visible identity, updated only when fields change,
and pruned when absent. This preserves native keyboard focus and avoids replacing
all stations as their age text changes. Journey markup has an equality guard.

A private Windows embedded-Chrome comparison used the same frozen 5,000-record,
24-worker fixture, Full view, 1440 x 900 at DPR 1, no CPU slowdown, fonts ready,
two-second warm-up and twelve-second windows. Both had eleven complete renders:

| Metric | Frozen R16 | R17 candidate |
|---|---:|---:|
| Mean activity projection | 25.64 ms | 13.13 ms |
| Mean complete map render | 44.57 ms | 33.60 ms |
| Mean complete dashboard render | 71.55 ms | 64.06 ms |
| Station elements added / removed | 154 / 154 | 0 / 0 |
| Retained station identities | Replaced on updates | 14 of 14 |
| Long-task count / total | 11 / 788 ms | 9 / 622 ms |
| Maximum long task | 79 ms | 100 ms |
| p99 animation frame interval | 83.5 ms | 83.3 ms |

This is one quiet retained-data comparison; source time continued between runs.
It does not qualify a live-load, Pi-rendering, sustained-60-fps or tail-latency
improvement. The larger maximum task remains explicit. A fixed-reference pure
projection differential also matched all graph/evidence fields across 73 scope,
clock, duplicate-identity, timestamp-mutation, metadata and removal cases.

The ingestion increment reuses daily/account statements within the existing
operation only. It adds no connection lifetime, concurrency or schema changes.
Comparable cache-pair sums share the existing scoped aggregate scan, preserving
NULL sums, zero comparable counts and ratio-of-sums semantics. Six in-memory
AB/BA pairs of identical 256-session / 366-day batches reduced prepares per changed
write from 1,256 to 16 and mean write CPU from 199.59 to 58.19 ms. Complete logical
state matched the frozen baseline. Read median was 13.57 versus 13.72 ms; one fewer
scan/prepare is established, but a read-latency improvement is not. These timings
exclude filesystem fsync, HTTP queueing and actual Pi load.

Further revision-domain scheduling, incremental projections, cooperative slices,
transport compression/deltas and workers remain measured follow-ups. GPU,
OffscreenCanvas workers, shared memory and WebTransport remain conditional on
an attributed bottleneck and a demonstrated end-to-end benefit.


## R18 Fit preparation and bounded response compression

The two synchronous Fit geometry passes now share one private preparation context.
Worker/channel selection, complete route evidence and density are reused only
within that invocation. Route reuse checks the exact placed actor IDs, and each
pass clones route descriptors before adding geometry. Standalone projection and
every subsequent update remain fresh; no persistent graph cache or source-time
invalidation shortcut was introduced. Complete differentials against R17 covered
242 Fit outputs, 240 standalone outputs and 120 source projections without input
mutation, including changed graph objects, metadata, selected history and backseek.

One actual embedded-Chrome comparison used the same frozen 5,000-record / 24-worker
retained-data scene, Full view, 1440 x 900 at DPR 1, no CPU/network slowdown, two-second
font warm-up and fifteen-second windows. HTTP identity was held fixed to isolate
renderer cost. Both windows had fourteen full renders and 1,937 DOM elements:

| Metric | R17 | R18 |
|---|---:|---:|
| Mean complete Fit work per map update | 8.61 ms | 4.55 ms |
| Mean complete map render | 24.19 ms | 19.04 ms |
| Mean complete dashboard render | 43.64 ms | 38.57 ms |
| Long tasks / total | 2 / 113 ms | 1 / 55 ms |
| Maximum long task | 60 ms | 55 ms |
| p99 frame interval | 33.4 ms | 33.3 ms |

Both managed traces observed CLS 0. This single quiet-data comparison is not a
live-load, sustained-60-fps, Pi-rendering, field-INP or leak qualification. Source
clock ages differed between windows. Independent pure-model AB/BA experiments
are complementary CPU evidence, not substitutes for those browser limitations.

Selected authenticated read-only JSON and text-static responses can negotiate
asynchronous gzip level 1. Admission is process-wide: at most two actual jobs,
4 MiB input per job, bounded output, no waiting queue or private response cache.
Identity remains the fallback when acceptable. Disconnects retain admission until
the actual compression operation completes. Authorization is checked before work
and again before publication. Existing no-store semantics remain, with Vary for
Accept-Encoding. Credential/profile/settings/admin/session responses, collector
POST/ACK, preauthentication resources and already compressed media are excluded.
The active database, archival format and ingestion/ACK semantics are unchanged.

Implementation references: [Node 24.19 zlib thread-pool guidance](https://nodejs.org/download/release/v24.19.0/docs/api/zlib.html#threadpool-usage-and-performance-considerations),
[RFC 9110 content-coding negotiation](https://www.rfc-editor.org/rfc/rfc9110.html#section-12.5.3)
and [HEAD response semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.2).
Pi wire/CPU/ingest qualification is required independently of Windows byte estimates.


R18's actual ARM64 transport experiment used six fresh-process counterbalanced
AB/BA pairs on the Pi. Each read 24 JSON responses while four 100-event batches
received durable collector acknowledgements. Every run retained 5,400 exact
source events and decoded 6,837,432 response bytes. Only server receipt timestamps
were excluded from the cross-run event hash.

| Mean per run unless stated | R17 identity | R18 gzip |
|---|---:|---:|
| Encoded response bytes | 6,837,432 | 498,322 |
| Read latency | 30.40 ms | 33.82 ms |
| Durable collector ACK latency | 52.47 ms | 49.58 ms |
| Process CPU | 502.35 ms | 558.69 ms |
| End resident memory | 112.11 MiB | 114.71 MiB |

This bounds a tradeoff: 92.71% less wire traffic with about 11.2% more process CPU
in this fixture. It does not establish faster reads or sustained ingestion gains.
The disposable processes used nice 10 and a 128 MiB JS heap cap outside the live
unit's one-core quota; this was not a production load or soak qualification.

The local preview gateway also advertises gzip for the same four bodyless read-only
JSON API families. Its streaming decoder independently bounds compressed and
decoded bytes (16 KiB preferences; 32,000,000 bytes otherwise), rejects unsupported
or damaged encodings and uses an absolute six-second request/decode deadline.
The configured origin, CA validation, fixed route callers and authorization remain
in force. Sensitive/write routes do not advertise compression. There is no upstream
response cache, new destination, redirect following or ingestion-ACK compression.


## R19 sustained-live investigation

R19 moves qualification from quiet retained history to continuous source arrivals.
The private fixture has four synthetic hosts and 24 workers. It commits 5,000
bootstrap records, then 48 new records every two seconds, using the real hub and
SQLite journal. It never connects to a provider or production source. Browser
qualification uses a 1440 x 900 DPR-1 Full workspace, dark JetBrains presentation,
no CPU/network throttling, and fixed identity transport on both sides. Automatic
90-second observation windows follow ten seconds of warm-up. Browser frame,
long-task, long-animation-frame, stage CPU and complete durable source projection
are separate evidence; none can replace the others.

An initial sustained R18 trace exposed the distinction: individual Canvas draws
averaged 0.44 ms, while complete data updates averaged 80.16 ms. Most pauses came
from the data-update task. This traced 113.59-second diagnostic is not a numerical
baseline for an untraced candidate. A later automatic attribution window measured
73.81 ms per update without tracing. Controlled paired results belong to separate qualification evidence with exact
frozen asset/backend identities; these diagnostic timings cannot substitute for them.

The bounded corrections preserve data and presentation contracts:

- Stable worker cards, device/project headings and their 16 bars update changed
  fields and retain current focus rather than rebuilding every age refresh.
- Activity preparation populates its deduplication Map directly, removing two
  intermediate arrays and a pair array per admitted record. Filtering still
  precedes last-wins replacement and uses the original sort comparator.
- Topology channel selection builds a fresh per-invocation worker/journey index,
  preserving source order, duplicate entries, both worker endpoints, self routes,
  selected older channels, complete counts and existing sampling budgets.
- Event timestamp parsing uses weak object identity with field/parser guards;
  mutation, accessors, inherited/coercible values and replay remain observable.
- Alert identity preparation remains within one invocation, preserving current
  source/host freshness, duplicate/call/terminal matching, IDs and output order.

No database, capture format, retention rule, archive receipt, authorization scope,
worker control, network transport, palette, layout or source-clock animation
contract is changed by these corrections.

Google's current guidance supports reducing main-thread work, batching layout
reads before writes and yielding long tasks; yielding is not implemented merely
because it exists. A larger cooperative-render or browser-worker change requires
state-consistency, cancellation and measured total-cost qualification first.
Long-animation-frame observations also include browser rendering costs that a
JavaScript-only stage timer can miss. They complement long-task timings and frame
intervals; the W3C specification remains a working draft.

Research sources: [Optimize long tasks](https://web.dev/articles/optimize-long-tasks),
[layout read/write batching](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing),
[scheduler.yield](https://developer.chrome.com/blog/use-scheduler-yield), and the
[W3C Long Animation Frames draft](https://www.w3.org/TR/long-animation-frames/).

## R20 map and timeline preparation

R20 targets the remaining synchronous data-update work. The observation plane
retains exact SVG route elements and their paths, counters and accessible labels.
Token overlays have a separate SVG group, so a usage-only update cannot replace
captured event routes. Route identity includes the metadata/evidence shape and
duplicate occurrence; missing routes leave the DOM and its presentation cache.
This changes DOM lifetime, not route geometry, ARGELLAN styles, source counts,
recorded timestamps, replay admission or first-seen animation identity.

Worker-state and topology-density preparation reuse parsed source timestamps
with field/parser guards. Weak keys do not retain historical source objects or
cache scope-dependent state. Timestamp changes, future eligibility, backwards
replay, host gaps and window expiry still receive current evaluation.

Timeline density preparation can use correlation summaries instead of building
full per-call record arrays. Full turn-group inspection still retains its complete
existing projection. Exotic accessor options retain the legacy path; ordinary
application options are plain data. Diagnostic variants that reduced encoding
counts but increased measured CPU were rejected. Fewer operations alone do not
establish responsiveness.

Qualification uses the same fresh sustained source fixture and browser profile as
R19, with additional navigation, worker-state and token-layer attribution. Exact
source-field preservation, output equivalence, actual SVG namespaces, keyboard
focus, stopped replay and reduced motion are separate acceptance checks. Node
microbenchmarks and reduced DOM replacement cannot substitute for browser frame
measurements or Pi validation.

Further scheduling work should separate pure preparation from publication, carry
source/scope/replay/selection generations and cancel obsolete derived work before
commit. Ingestion and archive custody must never share that cancellation path.
Feature-detect scheduling APIs independently, and measure both slice duration and
total completion overhead. An engineering trial of short elapsed-time slices must
not become a claim of a universal budget. No cooperative scheduler, worker,
OffscreenCanvas, CSS containment or WebGL rewrite is included in this increment.

Additional primary research: [Prioritized Task Scheduling specification](https://wicg.github.io/scheduling-apis/),
[rendering budgets](https://web.dev/articles/rendering-performance),
[worker tradeoffs](https://web.dev/articles/off-main-thread), and
[content visibility](https://web.dev/articles/content-visibility).

## Responsive navigation preservation

Observer 0.17 keeps the existing map, route identity, animation, palette and
accounting paths. Header controls wrap without shrinking their hit areas, and the
workspace uses the actual header height. Presentation tabs have a bounded width
so the visible History label can wrap at narrow sizes. Reset filters clears only
presentation scope and selection, preserves replay position and time window,
and returns keyboard focus to the Host selector in Full, Compact and Mini.

Qualification uses the same deterministic workload as the preceding renderer
increment, with measurement starting ten seconds after the source seed. Report
per-run variation, long tasks, frame tails and recovered record identity; this UI
increment does not imply a large renderer speedup or sustained 60 fps. Browser
resource-timing buffers must be large enough for the measurement window before
using their entries as request totals. A viewport at half the CSS width/height
and twice the device scale is a zoom-equivalent reflow check, not evidence that
the browser's own zoom command was exercised. Active data files, collectors,
archive custody and transport behavior are unchanged by these UI corrections.

## Release admission gate

Final application packaging and the supported application updater require a passing, source-bound performance report. `scripts/performance-gate.mjs` owns the executable budgets; `package-release.mjs --final-runtime --performance-evidence=ABSOLUTE_JSON` validates evidence before creating output. It packages the report and its digest. `setup-instance.mjs --update-app=...` verifies the final manifest, every declared runtime byte and the report again before changing the installation pointer. Provisional source is not update-qualified. This does not prevent an administrator from manually replacing files; this project's deployment workflow must apply the same gate before any manual code swap.

Each required desktop, scaling, phone, tablet, Ribbon and reduced-motion scenario needs three visible samples of at least10seconds after warmup, with a deterministic workload of at least5,000events/128workers. Reports bind baseline/candidate runtime hashes, workload hash and browser/CPU environment. Retain raw measurements and record update cadence and workload preservation. Missing values, stale bindings, missing cases, loss of records or budget failures reject admission. Encoded traffic, total refresh CPU and steady-state heap may not regress by more than5percent in the median comparison. Absolute budgets additionally cover99th-percentile frame interval33.4ms, worst interval66.8ms, zero long tasks/API errors, stagep95 25ms/max49ms, display-delayp95 500ms, ingestionp95 2seconds, wire64KiB/s and steady-state heap growth8MiB/min. These are initial acceptance targets, not claims that the current deployment meets them. Budget changes require explicit Owner direction. Do not slow updates, reduce the fixture, disable live animation or discard evidence to pass. Physical HP/iOS/iPadOS/Android acceptance remains separate.
