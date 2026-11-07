# CodexControl User Manual
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

Version 1.2.0 - ARGELLAN

Local candidate reference: 1.2.0 rc3, canonical base `8a3c532e1b4fb323649b00b07fa3b5a4e14cb55d` plus the integrated documentation, artwork, packaging and test changes. This is a local release candidate, not deployment or publication approval. Demo recordings retain their original source labels and do not demonstrate archive analytics or qualify rc3.

PDF: [User manual](../public/assets/codexcontrol-user-manual.pdf). Reference: [Interface atlas](INTERFACE_ATLAS.md) and [atlas PDF](../public/assets/codexcontrol-interface-atlas.pdf). Examples use invented data; standalone screenshots identify the synthetic boundary. PDF document and diagram text is at least 10 pt.

## Sign in and inspect your first event

Open the address supplied by your administrator. For a shared installation, confirm the intended HTTPS address and a trusted certificate before entering credentials. A local single-computer instance normally uses `http://127.0.0.1:4317/`.

1. Under **Username & password**, enter the account your administrator created and select **Sign in**. If this connection does not offer password sign-in, use its fleet-hub link or expand **Use an access key**.
2. For key access, enter the viewer or administrator key from your private access package and select **Sign in with key**. Collector credentials do not provide dashboard access.
3. Check the connection label in the header. A connected host can be quiet; connected does not mean a model turn is running.
4. Leave **Live**, **All hosts**, **All projects** and **All events** selected initially. Choose a suitable **Window**, such as **5 min**.
5. Select a worker in **Fleet & workers**, then select a route, marker or timeline record. The **Inspector** shows the captured identity, source timing and available correlation.
6. Compare the event's state and timestamps. A start without a captured result remains incomplete. Return to **All lanes** when finished.

Expected result: the map, timeline and Inspector refer to the selected captured evidence. If the workspace is empty, broaden the time window and check **Alerts** before concluding that no activity occurred.

Keep access keys out of screenshots, URLs, shell history and shared notes. After use on a shared browser, open **Profile** and select **Sign out** where offered.

## Orient yourself in the workspace

The header places the main workflows together. **Live** returns observation to the current feed. **History** opens durable event browsing. **GitHub** opens separately timed repository metadata. **Handoff** prepares a reviewed local packet. **Alerts** opens attention and collection information. **Usage** opens **Compute & token usage**. **Settings** opens the **Settings center**.

The right side shows connection status, local and UTC clocks, a color-theme menu, **Dot**, and **Profile**. The theme menu contains **System**, **Dark** and **Light**, **Refresh observations**, and **Toggle wall display**. Refresh requests a new observation; it does not restart collectors.

| Workspace area | Purpose |
| --- | --- |
| Command bar | Live/replay controls, window and observation filters |
| Usage strip | Weekly allowance, sampled token burn and peak daily reading |
| Fleet & workers | Authorized machines and observed worker relationships |
| Observation plane | Flow map or Ribbon presentation of captured signals |
| Execution timeline | Spans, Events and Turns linked to source evidence |
| Inspector | Details for the selected host, worker, event or route |

**Alerts & actions** contains **Fleet pulse**, **Attention**, and expandable **Collection & evidence**. Open it when needed; those panels no longer occupy a permanent right-hand workspace column.

The default observation-plane share is 72% of its shared area with the timeline. Existing profiles retain their saved proportions. Drag the divider to favor the map or the timeline; that changes presentation only.

## Filter without changing collection

Observation filters narrow what you inspect. They do not select a dispatch destination or change another user's permissions.

1. Choose **Window**: **1 min**, **5 min**, **15 min** or **1 hour**.
2. Use **Host** to choose an observed machine and **Project** to narrow project context.
3. Use the event-category selector for **Commands**, **File changes / patches**, **Research**, **Agent activity**, **Remote jobs**, **Interruptions**, or **Input / approval**.
4. Type in **Project, tool, identity…** under **Fleet & workers** to narrow matching workers and events.
5. Select a worker to focus its lane. Use **All lanes** to clear that selection while keeping filters.
6. Select **Reset filters** to clear host, project, category, search and selected-lane restrictions together. The time window and replay position remain unchanged.

Machine identity and worker identity are separate. A machine may host several sessions; an execution target can report a bound remote job without hosting Codex itself. Parent branches require captured relationship metadata. A similar name alone does not establish a parent/child relationship.

Selecting a worker can adjust conflicting host/project choices and clear search so the selected evidence remains visible. After a usage drilldown, check the command bar again: focusing evidence may clear display restrictions or enter replay to locate an older retained event.

Expected result: visible counts, routes and timeline rows follow the selected observation scope. Missing options may reflect your access scope or the current inventory. Clearing a filter cannot grant access to hidden hosts or projects.

## Keep an investigation context

Applies to 1.2.0. Start with an authorized, loaded observation scope. The strip above the command bar names the Live/Replay clock and selected source scope.

1. Select a worker or event and read the scope strip before comparing panels.
2. Use **Previous context** to revisit an earlier selection when enabled.
3. Open **Investigation tools → Pin this context** to save a temporary reference, then **Return to pinned context** when needed.
4. In the same Live scope, choose **Mark review point**, then **Since review** to inspect subsequently visible evidence.
5. Use **Pin comparison window** and **Compare windows** to compare bounded browser selections.

Expected result: the named clock and scope explain which evidence is being compared. If a control is disabled, load a suitable selection and confirm that the comparison/review context is compatible. Changing source permissions clears incompatible investigation state. These are browser investigation aids, not durable checkpoints or verified historical host-health snapshots.

## Pin evidence for review

1. Select a captured event, then open **Investigation tools → Pin selected evidence**.
2. Open **Evidence basket** to review up to 64 references.
3. Use **Remove** to drop a reference or **Open retained History** when its source record has left the browser cache.
4. Choose **Review available pins in Handoff** to review the source records still available before export.
5. Use **Dock inspector** if you need the Inspector alongside the map and timeline.

Expected result: the basket identifies evidence by reference. It does not copy, preserve or replace journal records. Missing cached evidence stays missing; no substitute is inferred. An empty Handoff means no pinned source records are currently available for that review. Related reference: [investigation atlas](INTERFACE_ATLAS.md#investigation-context-and-evidence-basket).

## Read the Flow map

Select **Flow** in the observation-plane header. Each station represents a recorded device, worker, subagent, human-input queue or tool interface. Select a station or route to inspect its evidence. **Key** opens the map's evidence legend.

| Visual meaning | Supported interpretation |
| --- | --- |
| Outbound call | A tool-call start was captured |
| Return | A result for the same scoped call was captured |
| Job report | A target reported a job with an explicit worker binding |
| Relationship branch | Recorded hosting or parent relationship; no traffic implied |
| Quiet station or historical route | Retained context, without a new activity claim |
| Unknown or incomplete route | Missing result or unavailable source; execution is unconfirmed |

Routes may group operations sharing a worker, endpoint and category. Inspect the group to see individual call identities and states. Crossing lines are visual crossings, not network junctions. A job report does not prove the worker received or accepted it.

Use **Zoom out observation view** and **Zoom in observation view** for the current Flow or Ribbon presentation. **Fit** resets that view to its fitted 100% scale. Each view keeps its own zoom; switching views does not overwrite the other scale. Ctrl + mouse wheel zooms within the view and scrolling pans. Visible zoom buttons are the keyboard/touch alternative. Zoom changes presentation, not capture or time scope. The expand control gives the map more room and restores the surrounding workspace when toggled back. **Motion** pauses or resumes presentation according to the motion preference.

New live records can launch a marker once. Refresh, repeated polling, historical catch-up and quiet sources do not create synthetic activity. Dedicated **MODEL USAGE** routes represent observed counter batches; they do not prove a tool call or network transfer.

## Inspect the timeline and Ribbon

The **Execution timeline** offers three views of the same retained observation scope.

**Spans** pairs available start/result records into operation intervals. Solid means recorded; dashed indicates incomplete evidence. A dashed interval stops at the last captured activity rather than continuously declaring the operation active. Select a bar to open the Inspector.

**Events** lists individual records with source times, category symbols and abbreviated identities. Select **Show next 200** when more matching records are available. Showing a bounded list does not delete the other retained events.

**Turns** groups captured records into turn context. Expand a turn, review its record count and state, then choose a record. A completed turn is a reported endpoint, not independent verification that the assignment was correct.

Use the density strip to seek captured activity. Its bins summarize events, failures, input requests and pending calls. Seeking an older source time can put the workspace into replay. Confirm the **LIVE** or **REPLAY** mode label after navigation.

Select **Ribbon** beside Flow for source-timed lanes grouped by worker. Its **Inspect events**, **Key**, **Pause** and expand controls operate on this presentation. Hover or select a marker to inspect source evidence; **Inspect events** and the timeline provide a keyboard route. At coarser scales, grouped markers expose their member count and time bin. Inspect members before interpreting density. Quiet or retained lanes do not prove current execution. Flow and Ribbon keep independent zoom scales.

The Inspector separates source evidence from interpretation. Failures direct you back to the source in Codex for excluded details. Prompts, command arguments, tool output and private reasoning are outside this observer's captured content.

## Replay and browse durable events

Select **Replay** to freeze a captured inventory and event set for source-time inspection. Use **Play replay**, the **1× / 4× / 16×** selector and the scrubber. **Recent window** applies the selected Window; **All retained** expands the frozen capture range. Select **Live** to return to the current feed.

Replay is an evidence view. It does not reconstruct historical host health from the current inventory, resume an old task or recreate historical token-coin flights. New arrivals can continue to be collected without changing the frozen replay selection.

For events beyond the current browser view:

1. Select **History**.
2. Set **Before local time** and select **Load**. The browser requests a bounded page of committed source records.
3. Select **Older page** to move farther back when available.
4. Select a record to replay at its source time, or choose **Replay page** to inspect the loaded page.
5. Check any displayed history-gap reason. Return to **Live** when your investigation is complete.

History browsing follows relevant host, project and session restrictions. Its date control is separate from the live Window. The displayed source times are local; use UTC/source timestamps in details when comparing systems.

**Catching up**, **Offline · retained view**, and a reported history gap describe different conditions. Catch-up adds historical records without launching a new live burst. A retained screen can remain useful during disconnection, but current worker state is unknown until fresh observations return.

## Investigate Alerts

Select **Alerts** to open **Alerts & actions**. The header badge counts presented attention items and any separate current gap notice; it is not a count of running jobs.

Start with the source-gap notice and **Fleet pulse**. A disconnected observer, stale source, unavailable fleet hub or capture gap limits what you can conclude about current activity. Historical records remain available. A locally available preview can continue showing its own machine while the fleet hub is unavailable.

Under **Attention**, select an item to inspect the associated evidence or open the relevant usage section. Items can include recorded failures, input requests, source gaps, host-resource thresholds, low allowance, account blocking, archive backlog, sampled burn spikes and tools without a captured result.

Interpret each class in context. Host CPU and RAM describe all host processes. An unanswered tool cue says the thread is still reporting without a captured result; it does not confirm the external operation is running. A burn spike compares sampled windows and does not identify a tool as the cause.

The ticker in the command bar also opens its current item. **Quiet current alert for fifteen minutes** suppresses its presentation temporarily. The evidence stays in Alerts. Quieting does not resolve an approval, retry work, fix a source or change the underlying record.

Expand **Collection & evidence** for source details and **Observer diagnostics**. Administrators can review threshold policy in **Settings → Attention**. Browser sound is unavailable in this build; its reserved setting does not enable audible alarms.

## Read compute and token usage

Select **Usage**, or select a metric in the usage strip. **Compute & token usage** keeps account readings separate from the observation plane's replay clock. Select **Refresh readings** for a new request.

**Weekly** is a reported seven-day account allowance when a qualifying source supplies one. It shows remaining percentage and reset time, not tokens or money. A passed reset becomes **Awaiting refresh** until a new source reading confirms the state. With several accounts, inspect each allowance separately. They are not pooled.

**Token burn** measures accepted counter increases in a sampled window, normally 60 seconds. It divides those increases by the window length. It is not a provider's token-by-token generation stream. First readings establish a baseline. Resets, gaps and stale observations do not become artificial traffic.

**Peak daily** and lifetime values are account-service readings. They are distinct from daily deltas captured from worker sessions. An unrestricted administrator is required for account-wide quota/history; scoped viewers can still inspect authorized worker counters.

The native-account details can report ordinary included usage, separate allowance windows, reset-credit availability, credit balance, spend-control state and source coverage. Missing fields remain unavailable. Credit units are source-unspecified and are not displayed as USD. A normal quota-model alias is not producing-model attribution.

If **Ordinary included usage allowed** is false, the source reports blocking. A favorable percentage or reset time does not independently establish recovery. Native per-thread cost estimates are unavailable in this collector.

## Understand the six counters

Captured numeric evidence preserves six counters and their provenance. Some source records contain only a subset. Unavailable counters stay unavailable.

| Counter | Meaning and handling |
| --- | --- |
| Input including cache | Inclusive input count; already contains cached input |
| Cached input | Subset of inclusive input; never add it again to that input |
| Cache writes | Separately reported cache-write input component |
| Output including reasoning | Inclusive output count; already contains reported reasoning |
| Reasoning | Numeric output subset; no private reasoning text is collected |
| Reported total | Source's total counter, preserved with its stated scope |

The three additive visual channels are **I · New input**, **O · Output**, and **C · Cached input**. New input is inclusive input minus cached input. Output includes reasoning. The default Semantic palette uses blue, violet and teal, with solid, dashed and dotted patterns respectively. The optional Original palette uses gold, silver and magenta. Color is supplemented by letters and patterns.

Always read the scope: **response**, **last response**, **turn total** and **thread total** are different measurements. Do not sum them together. A latest-response snapshot is not the entire turn. Cumulative counters are not a rate.

Source-reported, provider-reported and synthesized values remain distinguishable in detailed evidence. Configured model, effort and service tier describe context; the producing model remains unavailable unless actually established by the source contract. A model-usage route represents captured counter batches, not one object per token or a financial balance.

## Inspect captured response evidence

In **Usage**, find **Captured response evidence**. Check its date scope, source age, retained/matching/returned counts, exclusions and partial-coverage warning before comparing totals.

Expand **Exact response identities by turn** to inspect comparable native response records. The response sums exclude incompatible accounting scopes and records lacking the required identity. Expand **Captured numeric source evidence** for the preserved source scope, six counters, source/receipt times and provenance masks. Retained evidence may exist even when it cannot safely contribute to a response sum.

**Comparable weighted ratios** use sums of valid comparable pairs. Cache-hit share is cached input divided by inclusive input. Reasoning share is reasoning divided by inclusive output. Missing, zero or inconsistent denominators produce unavailable results rather than invented percentages.

Other expandable sections support targeted investigation:

- **Comparable historical dimensions** groups captured comparable records by host, project and configured context.
- **Current root/direct and family usage** uses qualified current same-host parent links. It is not historical lineage or an inherited cumulative total. A selected-session view remains partial for the family.
- **Captured context compactions** counts exact typed operation records in the retained map scope. Legacy unlabeled coverage cannot establish zero compactions.
- **Recorded tool reliability** separates completed, failed, cancelled, unknown and missing pairs. Recorded elapsed time is not native time-to-first-token.
- **Selected-source capture diagnostics** exposes bounded capture/backlog information and source-version metadata.

Use a **Locate** or linked identity control to focus captured map/timeline evidence. If the exact event has left the browser's retained view, the workspace may focus source context and state that the event is unavailable. It does not invent a substitute route.

## Export a usage view

Usage export creates a local, bounded snapshot of captured response analytics. It does not query the full archive or send data to a service.

1. Open **Usage** and wait for captured response details to load.
2. Select **Preview local export**.
3. Review the image, scope, exported-row count, completeness warning, and **Preview first three allowlisted rows and caveats**.
4. Leave raw identities and precise timestamps off unless disclosure is required. Each option must be chosen explicitly for this export.
5. Select **Download JSON**, **Download CSV**, **Download SVG**, or **Download PNG**.
6. Close and reopen the preview to select newer readings; the open export remains frozen.

By default, host, project, session and native identities become aliases, and time has day resolution. Aliases are not a guarantee of anonymity: dates, counts and patterns can remain identifying. Absolute path-like identities remain excluded even when identity disclosure is enabled.

Exports exclude credentials, prompts, command arguments, raw outputs, reasoning text, arbitrary labels and unknown fields. They preserve usage scope and six numeric counters. Do not combine thread totals, turn totals and response snapshots into one consumption total. The summary may cover more records than the exported recent rows; inspect coverage counts.

JSON and CSV provide structured data; SVG provides a scalable labeled graphic; PNG provides a raster image. If PNG generation fails, JSON, CSV and SVG remain available. Exports are capped at 1,000 rows and are not billing statements or complete account histories.

## Inspect GitHub repository evidence

Applies to 1.2.0 when an administrator has configured a qualified read-only source. Open **GitHub** in the header, choose a repository and expand a PR, check, status, workflow run or artifact metadata record. Compare exact base/head SHAs and provenance.

Use **Captured history** for retained metadata observations and **Refresh view** to return to the latest sample. The panel has its own capture/validation times and archive custody. It does not follow the map replay clock. Refresh view is not a forced GitHub collection.

Expected result: configured read-only metadata appears with its own coverage and freshness. Unconfigured, collecting, partial, rate-limited, stale and unavailable remain distinct. Unavailable checks are not passing checks. Artifact digests are reported metadata; artifact bytes are not downloaded or independently verified. No merge, approval, dispatch or cancellation is available.

If nothing appears, check source configuration, repository binding, token permissions and the displayed coverage. Do not paste a credential into the browser or retry collection to bypass rate limits. A source token's effective grant requires administrator verification. See the [GitHub guide](design/GITHUB_INTEGRATION.md) and [atlas](INTERFACE_ATLAS.md#github-repository-evidence).

## Prepare an Obsidian handoff

**Handoff** exports the current filtered event window as a reviewed local ZIP. It does not access an Obsidian vault or collect excluded source content.

1. Set the desired time window, host, project, event filters and worker selection. Check whether the workspace is in Live or Replay.
2. Select **Handoff**. **Obsidian handoff** freezes an allowlisted copy of the selection.
3. Review the selected/exported counts, mode, partial/bounded label and source hash. Read the table with **Previous 50** / **Next 50**; expand **Raw JSON · exact sanitized frozen payload** for the exact allowlisted payload. Pagination changes only the preview page. The export limit is 1,000 events; this is not a full archive export.
4. Inspect the readable table and **Exact allowlisted observations preview** in Raw JSON. Add an optional **Reviewer summary**, up to 2,000 characters, if useful. Your narrative is included as reviewed; avoid information you do not intend to export.
5. Check **I reviewed the selected observations and my summary for export**. Changing the summary clears that confirmation.
6. Select **Download reviewed Obsidian handoff**.
7. Extract the ZIP into the chosen vault and open `CodexControl-Handoff.md`. Review all three files before sharing.

| File | Purpose |
| --- | --- |
| `CodexControl-Handoff.md` | Readable scope, reviewer narrative, observations and limits |
| `observations.json` | Selected allowlisted metadata and per-event fingerprints |
| `manifest.json` | Application version, coverage and file hashes |

The packet uses local host/worker aliases and day-level dates. Raw labels, prompts, outputs and paths are excluded. Fingerprints cover exported allowlisted metadata, not excluded source content. Review confirms the export decision; it does not independently verify worker outcomes. If no events match, broaden the window or adjust filters, then reopen Handoff.

## Work safely in Settings

Select **Settings** to open the **Settings center**. The role badge and available destinations reflect the authenticated account and this installation's capabilities.

| Group | Destinations |
| --- | --- |
| Start here | Overview |
| Your workspace | Appearance; Layouts & panels; Map & motion; Clocks & wall display; Attention |
| Administration | Hosts & enrollment; Accounts & permissions; Collection; History & archive; Instance & network |
| Operations | Diagnostics; Change history; Backup & recovery; Control |

Viewers receive personal destinations, **Your account**, and **Captured history**. Protected administration requires the appropriate full-scope administrator capability. Small windows use a **Section** picker.

Use **Find a setting** to search both fields and tasks, such as “password,” “enroll machine,” “layout” or “backup.” Search is local and does not change observation filters. Moving between sections keeps the draft.

For normal settings, edit the draft, review the unsaved-change count and select **Save changes**. **Discard draft** abandons those edits. Closing with a dirty draft offers **Keep editing** or **Discard & close**. Account and enrollment operations have their own action buttons; the footer can explicitly identify an account/enrollment draft.

Concurrent changes use independent profile and hub revisions. If another tab changed the same fields, select **Review hub changes** and choose **Keep my value** or **Use hub value** for each conflict. Review the merged draft, then save. A failed save is not proof the hub accepted nothing; refresh/read back the affected resource before retrying a consequential action.

## Set appearance, layouts, clocks and motion

Under **Appearance**, choose color theme, typeface, text size and interface density. Text size supports 12–20 px. Use **Layouts & panels** for overview mode and sizing. **Full workspace** shows workers, map and timeline. **Compact map** emphasizes the map. **Mini usage & attention** hides the map, workers and timeline while capture continues.

To save a reusable presentation:

1. Adjust the draft to the intended layout.
2. Enter a unique **New layout name**.
3. Select **Capture current draft**, then **Save changes**.
4. Later select **Use** to apply it, **Replace** to update it, or its remove control to delete it from the draft. Save again.

Up to eight layouts are supported; names can contain 1–48 characters. Layouts preserve presentation choices, not host/project/event filters. A new dashboard starts in the live, all-source observation scope allowed by the account.

The worker panel supports 200–420 px. **Observation plane share** supports 32–88%, default 72%. Drag dividers, focus them and use arrow keys, or double-click to reset. Persisted profiles are not rewritten by a changed default.

Under **Map & motion**, choose starting visualization, motion preference, category colors, token palette and available evidence-context options. **System** follows the device preference; **reduced** and **paused** suppress moving markers. Under **Clocks & wall display**, choose local/UTC clocks, format, milliseconds, local time zone and wall presentation. Clock presentation does not rewrite source timestamps.

## Your profile and Dot

Open **Profile** to edit **Your name**, **Nickname** and **Profile photo**. Nickname appears in the header; it does not change your sign-in username, role or permissions. Select **Save profile** and wait for confirmation. **Reload** reads the saved hub version; after a conflict, reload before saving again.

Photos accept JPEG, PNG or WebP up to 5 MiB, 16 megapixels and 8,192 pixels per side. The browser center-crops to 256 × 256 and removes metadata. The prepared photo is stored privately on the hub. Use **Remove photo**, then save, to remove it.

Select **Dot** to open **Your Dot companion**. Its worker-presence state reflects recent records from online observed hosts. **Replay view** is explicitly separate. No recent records does not imply disconnection.

Automatic desktop artwork requires an administrator's local collector opt-in. An enrolled Codex source reports its selected artwork; an authorized full-fleet administrator can view it. Several desktop selections are not merged into a claim of one owner: the most recently observed selection is identified by its desktop. Automatic discovery currently supports validated PNG sheets with eight columns and nine or eleven rows. Unsupported selections remain unavailable.

The **Optional browser-only sprite override** accepts PNG/WebP up to 8 MiB, exactly 1536 × 1872 in an 8 × 9 grid. It stays in this browser for this signed-in profile and origin. Use **Remove saved sprite** to clear it. Automatic artwork takes precedence when available.

Voice connection, speaking, microphone mute and output mute remain unavailable. Worker activity and animated artwork do not establish a call or mute state. This observer does not capture audio or transcripts.

## Administrator: accounts and passwords

Open **Settings → Accounts & permissions**. Inspect the loaded users before making a change; refresh if the inventory is stale or an earlier action could not be confirmed.

To create an account, select **Create a new user**. Enter **Account ID**, **Display name**, role, optional expiry, and host/project access. For password access, supply **Username**, **Initial password** and confirmation. Leaving username/password empty creates key-only access. Select **Create user** and download any issued private credential package once.

Usernames contain 3–64 letters/numbers, periods, underscores or hyphens, start with a letter or digit, and are normalized to lowercase. Passwords require 12–128 characters; spaces and case are preserved. The confirmation must match. Existing passwords are never shown or placed in credential downloads.

For each access dimension, **All enrolled hosts** or **All observed projects** is an explicit broad grant. Turn All off to grant only checked stable identities. An empty selected list grants no scope in that dimension. Retained selected identities remain visible even when absent from current observations. Do not assume a display-name change changes the underlying identity.

Use **Edit user → Save user** for account changes. **Issue a replacement access key** rotates another user's key; ask another administrator to replace your own. **Reset password** or **Set password** uses a separate action and invalidates that user's current sessions. Your own **Change your password** requires the current password and requires sign-in again afterward.

**Revoke** removes the selected access. Last-administrator protections remain enforced. Password account management may be unavailable through a local gateway; use the authoritative hub connection indicated by the sign-in workflow.

## Administrator: machines and collection

Open **Settings → Hosts & enrollment**. Enrollment creates a machine identity and credential; installation and fresh observation are later checks.

1. Under **Enroll a machine identity**, enter a stable lowercase host ID, device label and the intended physical machine's **Expected hostname**.
2. Choose device class and **Collection role**: `codex-source` for a supported Codex source, or `execution-target` for bound remote job reporting.
3. Enter preferred/alternate addresses as metadata for that one machine.
4. Select **Enroll identity and issue package**, confirm the operation when requested, then **Download package once**.
5. Transfer only that source's private package to the intended machine. Follow its installation instructions and verify instance identity, expected hostname and TLS.
6. Refresh collector inventory and confirm actual source observations and age.

Do not copy an enrollment across machines. A valid credential with no heartbeat is not a connected source. A heartbeat does not establish an active turn or complete account collection. **Revoke** under Collector access invalidates the selected source credential; it does not uninstall software on that host.

Use **Collection** for capture/compatibility information and **Managed collection profiles**. Source paths refer to the owning enrolled machine; the browser does not browse them. Explicit hub-managed source policy can define the exact source set. An empty managed set disables that collection; unmanaged hosts can preserve local policy.

Account observation and automatic Dot discovery require separate local collector opt-ins. Hub source-profile edits do not automatically enable those capabilities, discover Cloud work or attach to another desktop's active call.

## Understand preservation and storage

Codex Control has two related retention systems. The **event journal** supports replay and event recovery. V1 has no verified off-host event-archive receipt path, so captured events remain in local SQLite beyond configured age, row and byte targets. Local storage pressure can defer new capture; the configured targets are not permission to destroy unarchived events. Captured **usage observations** have a separate full-fidelity off-host archive contract.

The active SQLite database belongs on the hub's local disk. NAS storage is used for closed immutable archive segments and verified backup snapshots, not an active SQLite file across SMB/NFS.

In **Usage → Usage database**, inspect stored observations, baselines, daily rows, hot-cache targets and archive state. Administrators can also open **Settings → History & archive** for event history, custody and measured local storage. Raw usage hot-cache targets are normally 30 days/200,000 rows; daily projections target 730 days/200,000 rows. Targets apply only after exact-version verified archival, with additional per-family bounds shown in readings.

Only a durable receipt covering the exact current record version permits its local hot-cache eviction. An outage or unconfigured archive preserves pending versions beyond the target. Aggregates are useful projections; they do not replace captured source records. Immutable archive segments have no automatic age-based deletion.

Monitor **Pending record versions**, **Oldest pending version**, **Latest verified transfer**, local database/WAL size and available disk. A receipt count is not an independent check of every archive file or a successful restore test.

Storage pressure can defer new capture while committed data remains readable. Preserve the collector's pending batch and cursor; restore archive capacity or local headroom. Deleting pending records to satisfy a cache target breaks the preservation contract.

## Administrator: diagnostics and change history

Use **Settings → Diagnostics** for on-demand runtime, storage, collection and compatibility evidence. Alternatively, open **Alerts → Collection & evidence → Observer diagnostics** for the observer's process/journal reading.

Check observation time before acting. Observer RAM and CPU describe the dashboard process. Host CPU/RAM cover all host processes, not a worker's assigned share. A first CPU or event-loop reading can be **First sample**, because no prior measurement interval exists. Inspecting again creates a later interval; it does not establish per-job resource attribution.

Collection diagnostics separate observed connection, source-observation time, receipt time, gaps, numeric capture backlog and runtime compatibility. Unknown compatibility is not a supported-version claim. A source may be online while its numeric capture is backlogged or partial.

Open **Change history** to review configuration and administration audit streams. Entries retain their stream, time, actor, action and changed paths. **Not loaded**, a failed read and a confirmed empty response are separate states. Use the corresponding refresh control for a fresh reading. These protected inspections do not add continuous diagnostic polling to the map.

For support, open **Backup & recovery → Download sanitized support bundle**. Review the resulting local file before sharing; sanitization is not permission to disclose operational metadata. Keep credential packages, private source data and personal images separate.

The **Control** destination currently reports its capability boundary. No remote operation, approval or session control is initiated there. The absence of an attached adapter is not proof that every host lacks a native capability; it means this workspace exposes no supported control operation.

## Administrator: backups and recovery

Open **Settings → Backup & recovery**. Select **Create private backup**, then **Refresh backups** and confirm the new inventory entry. A managed backup covers sanitized configuration and a coherent history/usage/custody snapshot. It does not replace a separate private copy of users/password/security registries, collector credentials, external TLS material and archive configuration/keys. Include the private display-preferences directory for names and photos.

For a full offline instance copy, stop only the owned Codex Control process/service and archive sender first. Include any external local data directory. Never copy only the main file of a live WAL-mode SQLite database and call it a coherent backup.

**Stage restore** validates the selected managed backup and returns **Recovery instructions**. It does not replace the running database, restart a service or prove recovery. Follow the documented offline procedure with a compatible application build and preserve current newer data/security state first.

Current usage bootstrap and pending/in-flight archive custody must be fully accounted for before replacement. If restore refuses because custody is pending, repair/drain the archive and reconcile the evidence. Do not clear receipts, drop tables or erase batches to force acceptance. A supported recovery may establish a new history generation; preserve that distinction.

**Restore previous configuration** is a separate revision-checked configuration action. It retains event history and can require a managed restart. It is not a database restore or application downgrade. Inspect the stated restart requirement and verify the resulting behavior through a fresh reading.

A useful recovery exercise checks instance identity, individual access, saved profiles, retained history, source ages, pending custody and the restored data's provenance. A staged packet alone does not satisfy those checks.

## Install on one computer

Use an independently verified Node.js 24 runtime; 24.19.0 is the tested baseline in the supplied installation guidance. No npm dependencies, provider API key or Pi is required for a single-computer instance. Extract a verified release into a versioned application directory. Keep private instance data outside that directory and outside synchronized/public folders, on local storage.

From PowerShell in the verified application directory:

```powershell
node --version
$instanceDirectory = Join-Path $env:LOCALAPPDATA 'ARGELLAN\CodexControl\instance'
node .\scripts\setup-instance.mjs --mode=single-computer "--instance-dir=$instanceDirectory" --host-id=my-computer
node (Join-Path $instanceDirectory 'start.mjs')
```

Open `http://127.0.0.1:4317/`. Keep the foreground terminal running; **Ctrl+C** in that terminal stops this dashboard. Setup refuses an existing instance. Use the existing launcher or update procedure rather than deleting history to rerun setup.

Setup prints private file paths and instructions, not credentials. Open `owner-access.json` privately and use its key through **Use an access key**. Then create individual accounts under **Settings → Accounts & permissions**. Verify an individual sign-in and retain private owner recovery access.

The default source is the current user's local Codex session folder. For another explicitly selected source, initial setup accepts `--session-root=ABSOLUTE_LOCAL_CODEX_SESSION_DIRECTORY`. Never point it at provider-auth or credential storage.

For Linux, run `setup-instance.mjs` with the same single-computer mode and a private local instance path, then run that path's `start.mjs`. Use the full platform-specific instructions in `INSTALL.md`; generic commands do not establish support on every distribution. Setup does not install Node, firewall rules, certificate trust or services.

## Administrator: fleet hub and collectors

A fleet hub serves authorized source observations to browsers. A Raspberry Pi 5 with 8 GB RAM is an existing ARM64 hub target. Rendering happens in the browser; the Pi does not need Codex or a model runtime.

Before fleet setup, prepare trusted TLS certificate/key files, a fixed HTTPS public origin, local private instance storage and the first source's independently confirmed hostname. Run the documented `setup-instance.mjs --mode=fleet-hub` command with those real paths and identities. Supply a private CA file where required. Setup checks private-key file permissions as well as readability; it does not issue certificates or install trust.

Run the generated private launcher. Configure an owned service separately if needed and verify its actual resource limits, startup and restart behavior. A started process alone does not establish successful onboarding.

On the intended Windows source, use its issued enrollment and independently confirmed values:

```powershell
.\scripts\install-collector.ps1 -EnrollmentConfig 'ABSOLUTE_ENROLLMENT_FILE' -ExpectedOrigin 'https://dashboard.example.com:4317' -ExpectedInstanceId 'INSTANCE_ID_FROM_SETUP' -ExpectedHostname 'MY-LAPTOP'
```

The helper uses existing Node 24, verifies target machine/instance identity, applies private per-user access permissions and can register a login task with `-StartAtLogon`. It does not download a runtime or change routes/trust stores. A failed initial send retains its private outbox; verify actual receipt in the dashboard.

For a reverse proxy, preserve Host/Origin, use trusted matching certificates and verify upstream TLS. The runtime supports a bounded list of exact HTTPS proxy origins; configure it through the private deployment workflow. Do not place a shared owner bearer at the proxy or disable certificate verification. Each browser signs in individually.

## Update, roll back and uninstall

There is no in-browser software-update action. Obtain a verified candidate and read its `UPDATE.md`, manifest, checksums and compatibility notes.

1. Extract the candidate into a new versioned application directory.
2. Create a managed backup and preserve separate private security/configuration material. Stop only the owned processes required by the update procedure.
3. If record formats change, qualify the compatible archive receiver before enabling new source sending. Preserve pending envelopes, exact in-flight bytes and cursors.
4. Use the new application's `setup-instance.mjs --update-app=ABSOLUTE_NEW_APPLICATION_DIRECTORY --instance-dir=ABSOLUTE_EXISTING_INSTANCE_DIRECTORY` to update the installation pointer.
5. Start the existing private launcher. Update collectors through their documented existing-identity procedure; do not reenroll over an occupied installation.
6. Verify the same instance identity, users/passwords, scopes, settings, history epoch, retained data, fresh observations and archive custody. Confirm that refresh/replay does not relaunch old traffic.

A code rollback requires a build that understands the current database/archive schemas. A pre-V2 binary is not a supported code-only rollback after V2 usage tables exist; builds predating storage-admission schema also lack current enforcement. Never drop accounting objects or clear custody to make an older build start.

For uninstall, stop/remove only this instance's service or scheduled task. The Windows collector helper supports `-Uninstall` with the exact existing `-Destination`; it leaves data, enrollment, logs, pending batches and cursors intact. Revoke the selected credential at the hub and preserve verified backups/archives before decommissioning storage. Application removal does not uninstall Codex or stop its workers. Private data destruction is a separate explicit action; no normal helper recursively deletes it.

## Read-only CLI and MCP queries

Authorized local clients can query the hub through existing authenticated APIs. The one-shot `query-codexcontrol.mjs` adapter reads one JSON request and exits; `mcp-readonly.mjs` offers the same operations over local STDIO. Neither adapter registers itself in Codex or starts model work.

Create a protected local JSON connection file using the exact schema in `docs/design/READ_ONLY_QUERY.md`. It contains `version: 1`, the canonical `origin`, an existing viewer `token`, independently verified `expectedInstanceId`, and optional public `caFile`. Keep the credential out of arguments, environment variables, query text and source control. File permissions and identity checks are enforced; TLS verification stays enabled.

From the verified application directory, a PowerShell example using a generic private path is:

```powershell
'{"query":"sources"}' | node .\scripts\query-codexcontrol.mjs 'C:\CodexControlPrivate\query.json'
```

| CLI query | MCP tool | Result |
| --- | --- | --- |
| `summary` | `codexcontrol_summary` | Authorized quota/summary/burn observations |
| `sources` | `codexcontrol_sources` | Host status, roles and capture coverage |
| `events` | `codexcontrol_events` | Bounded typed events and durable cursor/gaps |
| `usage-records` | `codexcontrol_usage_records` | Recent bounded numeric usage records |
| `history-analytics` | `codexcontrol_history_analytics` | Optional administrator archive-projection daily/response reports |

For MCP, configure an approved local client with command `node`, arguments consisting of the adapter's absolute script path and protected configuration path, and transport `stdio`. Follow the documented protocol compatibility and client-registration procedure. Scope arguments only narrow authorized access.

The original four operations above read the hub hot cache. `usage-records` has no historical pagination or custom range; complete history is explicitly false. The separate optional `history-analytics` operation queries the verified archive projection and has the distinct conditions below. Fixed codes such as `AUTH_REQUIRED`, `FORBIDDEN` and `INSTANCE_IDENTITY_MISMATCH` identify failure classes without printing secrets. No arbitrary SQL, URLs, commands or worker-control operation is accepted.

## Query qualified archived reports

Before you start: an administrator must separately qualify and activate the optional archive/analytics host, its local projection storage, pinned DuckDB runtime and dedicated forced-command query transport. Source acceptance is not live activation. This is a CLI/MCP workflow; there is no new browser analytics panel. A local unauthenticated preview or a scoped viewer cannot query it. See [setup, qualification and recovery](design/HISTORICAL_ANALYTICS.md).

1. Use a protected existing CLI connection file for an authenticated unrestricted administrator at the authoritative hub. Retain the normal identity-before-credential and TLS checks.
2. Choose `daily` with either `session-deltas` or `account-daily`, or choose `responses`. Supply inclusive UTC `fromDay` and `toDay`, and an output-group limit from 1 to 1,000. Host/project filters only narrow authorized scope; an account-daily report cannot use a project filter.
3. For example, after activation, send a read-only request from PowerShell:

```powershell
'{"query":"history-analytics","arguments":{"report":"daily","source":"session-deltas","fromDay":"2026-10-01","toDay":"2026-10-22","limit":100}}' | node .\scripts\query-codexcontrol.mjs 'C:\CodexControlPrivate\query.json'
```

4. Inspect `coverage.pendingSegments`, `lastProjectedAt`, `truncated`, conflicts and exclusions before interpreting rows. Projection time is not source freshness or proof that every archive segment is projected. Output rows are bounded groups, not pagination through every raw archive record.
5. Preserve exact integer strings in `values`/`totals`. Read their `known` contributor counts and each ratio's comparable numerator/denominator coverage. Unknown is not zero; a known subtotal is not a complete total. Keep session-delta and account-daily reports separate.

Expected result: a bounded report from the configured, receiver-bound verified archive projection. If the engine/projection/transport is absent or unavailable, retain that state rather than inferring empty history. Unauthorized/restricted requests are refused; invalid arguments and busy/timeout conditions remain failures. Repair or activate only through the separately authorized operator procedure.

Boundary: the immutable archive remains authoritative. Projection never acknowledges Pi/receiver custody, advances its catalog, supplies complete off-host event custody or reconstructs the exact hot-cache head. Archived V3 GitHub metadata retains its own provenance and is not counted as tokens. Reports are not billing, native generation speed or complete provider history.

## Maintainer release evidence

Maintainers use the [bounded release protocol](release/README.md) to bind the exact candidate and explain unchanged-evidence reuse. PowerShell 7.4+ is required only for its local register validator, not ordinary dashboard/hub/collector use. A validator pass checks structure/consistency; it does not inspect referenced evidence, recompute hashes, run the recorded commands, certify the product or grant push/deploy/publication/activation authority. A register is supporting evidence, not a replacement for the existing checkpoint.

## Troubleshooting

| Symptom | Check and action |
| --- | --- |
| No workers/events | Clear filters, choose All lanes, widen Window, inspect Alerts/source freshness. An empty current view is not proof of no historical activity. |
| Disconnected or source gap | Treat current worker state as unknown. Preserve history/outboxes. Verify the intended hub, source process, trusted TLS and enrollment; reconnect before relying on freshness. |
| Old start looks active | Inspect for a matched result and latest source time. Dashed/open evidence is incomplete, not confirmed execution. |
| Weekly unavailable/restricted | Account source may be absent, unsupported, stale or outside your role. Full-scope administrator access and a local opt-in source are separate requirements. |
| Quota reset passed but still blocked | Refresh the source. Check ordinary-usage permission and each separate allowance. Reset time alone does not confirm recovery. |
| Token burn zero/unavailable | Check baseline, freshness and scope. First readings and unmeasurable gaps do not generate burn; a cumulative total is not a rate. |
| Settings or profile conflict | Reload/review hub values; resolve each conflict before saving. Do not repeatedly overwrite a stale revision. |
| User/enrollment action unconfirmed | Refresh the authoritative inventory before retrying. A lost response can leave a committed result. |
| Password form missing | Use the offered authoritative hub link or key access. A fixed-upstream local gateway does not validate local password identities. |
| Archive backlog/storage pressure | Inspect pending count, oldest version, destination and local headroom. Repair capacity/transfer; preserve pending records, receipts and source cursors. |
| Handoff empty or unavailable | Ensure captured events match; expand Window and reopen. A secure browser context and valid selection are required. |
| Dot artwork absent | Confirm local opt-in, supported sprite and fresh selection. Expired uncached links may need desktop cache refresh. Voice remains unavailable regardless. |
| PNG export fails | Use JSON, CSV or SVG and retain their caveats. Reopen for a fresh bounded selection. |

For a support report, record the application version, observation time, affected workflow, scope and fixed error/status code. Review the sanitized support bundle before sharing. Never attach access packages, passwords or private keys.

## Keyboard and terminology reference

| Control | Keyboard behavior |
| --- | --- |
| Workspace navigation/forms | Tab/Shift+Tab to move focus; Enter/Space activate appropriate controls |
| Skip to workspace | First skip link moves focus to the main surface |
| Map routes/model-usage anchor | Focus, then Enter or Space to inspect |
| Map selection | Escape clears selected map evidence |
| Worker divider | Left/Right arrows resize by 10 px; Home/End select supported extremes |
| Observation/timeline divider | Up/Down arrows adjust by two percentage points; Home/End select 32%/88% |
| Settings section navigation | Up/Down/Home/End move among section controls |
| Settings close/Escape | Dirty drafts require Keep editing or Discard & close |
| Foreground local dashboard | Ctrl+C in its own terminal stops that dashboard |

No global worker-control shortcut is supplied. Use visible controls and focus indicators. Reduced motion remains supported; stopped visual motion does not stop collection.

| Term | Meaning |
| --- | --- |
| Captured observation | Sanitized source record retained with its provenance |
| Source time / receipt time | When the source says the record occurred / when it reached the observer |
| Host / worker / execution target | Machine identity / observed session / machine reporting explicitly bound offloaded jobs |
| Epoch / recovery generation | Identity boundary for journal continuity and cursor recovery |
| Baseline / delta / rate | Initial comparable counter / observed increase / increase divided by observation window |
| Hot cache | Bounded local working set, with protected pending usage retained beyond targets |
| Exact-version receipt | Durable archive acknowledgment for the current captured record version |
| Partial / stale / restricted | Limited coverage / earlier aged reading / access-limited data |
| Handoff | Reviewed bounded local export, without automatic vault access |

V1's operating scope is observation, protected administration and preservation. Claude Code support, native voice, Cloud discovery, remote execution/approval controls, SSO, Android companion delivery and direct Timescale querying or arbitrary NAS SQL are not supplied working workflows. Optional administrator archive reports follow their separate qualification and activation contract. A future integration needs its own documented capability and qualification.
