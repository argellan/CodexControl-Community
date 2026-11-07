# CodexControl data preservation
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

At ARGELLAN, data is king. The Owner explicitly requires full captured usage history to be preserved for future analysis.

- Keep full-fidelity captured observations and their provenance. Aggregates are additional projections, never the only retained copy.
- Treat Pi age and row limits as hot-cache targets. Eviction requires a verified durable receipt covering the exact current record version in the long-term archive.
- If the archive is unavailable, preserve pending records, retry safely and expose backlog/storage pressure. Never silently drop data to satisfy a cache limit.
- Keep active SQLite files on the Pi's local disk. Database engines and their active files belong on the same host/local storage; do not put active database files across SMB/NFS. NAS storage is for closed immutable archive segments and verified backup snapshots.
- Preserve the existing exclusions for credentials, prompts, command arguments, raw output and private reasoning. This preference does not authorize unrelated collection or changes to another governed mission system.
- Continue the current authorized stage and use docs/CHECKPOINT.md for current authority, evidence and remaining work. No competing completion ledger.

## Performance is a core requirement

Data ingestion with maximum efficiency and the lowest practical overhead is an explicit Owner priority. Preserve every captured source record while bounding browser rendering independently. Measure frame pacing, update cost, ingestion latency, memory and transfer volume before claiming an optimization. Use elapsed-time animation, avoid repeated full-tree replacement and read/write layout thrashing, suspend unnecessary hidden/idle work, and preserve accessibility and reduced-motion behavior. Visual aggregation or level of detail must never silently discard durable data or fabricate activity.


## Total screen-height acceptance

Every future CodexControl UI change must budget the full browser height. At 1366×620 and 1280×600 CSS pixels, place weekly allowance and burn immediately under a compact header and preserve useful map/timeline height. Measure before/after header, toolbar, map canvas and timeline heights; inspect screenshots at those sizes, a larger desktop and a 125% scaling-equivalent viewport. Keep keyboard targets, labels, reduced motion and reflow usable. No horizontal overflow, clipped essential controls or durable-data eviction as a layout shortcut. Physical laptop verification must be explicitly marked NOT_RUN when unavailable.


## Phone and tablet support is mandatory

CodexControl must provide a deliberate, readable, touch-friendly phone and tablet/iPad experience alongside desktop. Preserve the shared data, account scope and capabilities. Use clear primary navigation, meaningful page/section identity, usable touch targets, safe-area-aware placement, orientation/reflow support, accessible dialogs and readable forms. Compact status metrics must support the operational workspace rather than dominate it. Verify desktop regressions separately from phone/tablet behavior. Browser viewport tests do not establish iOS/iPadOS/Android hardware qualification; record those acceptance limits explicitly.

## Performance release admission

Every UI/feature or API change must pass the executable performance gate before final packaging or deployment. Use scripts/performance-gate.mjs through package-release.mjs --final-runtime --performance-evidence=ABSOLUTE_JSON. Missing, stale, incomplete or failing evidence blocks release; a provisional package is not deployable. Preserve the source/workload binding and raw measurements. Run at least three controlled, visible samples per required desktop, scaling, phone, tablet, Ribbon and reduced-motion scenario, with at least5,000 retained events and128 workers. Measure encoded transfer, render CPU/stage latency, frame pacing/long tasks, ingestion and display delay, and steady-state heap. Retain exact records and update cadence; do not pass by suppressing activity, slowing refresh, shrinking workload or raising budgets. Budget changes require explicit Owner direction. Record physical-device acceptance separately. Continue to use docs/CHECKPOINT.md for authority and evidence.

## Prospective ARGELLAN naming and attribution

Use ARGELLAN for new first-party company, product and documentation naming and Argellan.com for the Owner website. Use argellan as the Owner GitHub namespace; the former namespace remains only where historical or compatibility evidence requires it.

For Owner-authored code and modifications, use Author: Bishop Crockett and Owner: Argellan.com with the verified repository license and SPDX identifier where supported. Preserve third-party authorship, contributor credits, copyright, licenses and NOTICE obligations. These attribution fields do not transfer legal rights or claim authorship of upstream code.

Preserve operational paths, hostnames, services, databases, environment variables and storage identifiers unless a separately authorized and tested migration changes them. This policy alone does not authorize bulk cleanup, publication, deployment, worker dispatch or resumption of paused work. Existing authority, quota, model and worker limits remain in force.

## Feature preservation requires written Owner permission

No existing feature may be removed, disabled, or made unavailable without the Owner's express written permission. Performance optimization, redesign, refactoring, transport changes and replacement features do not grant that permission. Preserve established behavior and its data dependencies. Spinning token coins are a pillar design choice and must remain functional. Release checks must exercise affected user-visible features, including actual rendered token coins during fresh usage, as well as performance. If requirements conflict, preserve the feature and surface the conflict to the Owner.