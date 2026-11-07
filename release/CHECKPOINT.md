# Observation usability integration — 1.2.0 candidate

The UI candidate is reconciled with the released 1.1.0 GitHub integration.
Flow and Ribbon have independent bounded zoom, shared Canvas/DOM geometry,
and elapsed-time motion. Ribbon density and grouped markers describe captured
records, not token spend or invented progress. Groups retain source references.

Investigation context, previous-context navigation, an evidence basket and a
review brief use existing browser records. They add no background data requests.
Context and selected evidence are invalidated when access changes. The readable
Handoff preview uses the existing frozen, sanitized, explicitly reviewed packet.
Settings and GitHub implementations load on first use, with retryable loading and
authority-change cancellation. Routine map updates reuse unchanged zoom geometry
and cached scroll offsets rather than forcing layout reads. Gzip uses level 3 with
the same two-task and byte limits, measured on ARM64 to offset the retained
archive-status metadata without removing any captured fields. Settings navigation
remains usable in short windows. ARGELLAN artwork and existing
saved display preferences are retained. No capture, database, archive, credential,
source enrollment, collector queue or control semantics change in this release.

The existing GitHub dialog and authorization invalidation remain integrated.
Checks remain explicitly unavailable in configured partial monitoring. Account
observer executable discovery and unsupported native voice subscriptions are not
claimed as part of this UI change. The packaged manual describes the existing
workflows; new investigation controls are supplementary, read-only views.

Targeted source, packaging, ARM64 and live checks qualify each deployed artifact;
a source commit alone does not establish deployment or maximum-load performance.

# Optional GitHub integration candidate

The combined candidate reconciles the original metadata worker with the 1.0.1
maintenance baseline. It adds optional bounded collection, branch/open-PR discovery,
scoped read-only ARGELLAN inspection, gateway compression, and V3 immutable archives.
No existing captured usage/event/account store is replaced. Configuration and
credentials are excluded from the distributable tree. Default behavior is disabled.

Independent combined review passed 229 targeted tests with three platform skips;
ARM64 runtime and packaging checks passed 18 tests with one Windows-only skip.
An additional confirmed provider limitation is now explicit: fine-grained personal
tokens cannot access Checks. Configured partial monitoring skips that endpoint,
continues supported metadata, and labels unavailable Checks without implying success.
The focused integration/runtime follow-up passed 33 tests with one POSIX skip.
A source commit alone is not live qualification. See docs/design/GITHUB_INTEGRATION.md for the exact contract,
setup, scope/coverage limits and retention behavior.

# Public source checkpoint

Observer 1.0.1 refuses collector credential delivery unless the destination
deployment identity is pinned and verified, checks TLS private-key file access,
and keeps project-scoped journal metadata within the authorized event scope.
Event rows remain in the local journal beyond age/row/byte hot-cache targets
until a verified off-host event archive and exact-version receipt path exist.
Existing historical retention gaps are not repaired by this code-only update.
The separately archived full-fidelity usage observations retain their existing
custody rules. No worker control or new data category is added.

Observer 1.0.0 moves alerts and collection evidence into an on-demand dialog,
removes the fixed right rail, and keeps source-gap notices out of the workspace
banner and activity ticker. The observation pane uses the released width. New
profiles default to a 72% map/timeline share with a 32–88% range; existing saved
shares and all observation data remain unchanged.

Observer 0.21.1 adds opt-in automatic desktop Dot artwork discovery, private
content-addressed hub storage, version-2 spritesheets, administrator-only lazy
artwork delivery, and durable selection-change evidence. Existing account polling
carries references, never image bytes. No public credential or private artwork is
shipped. The installed desktop voice coordinator is internal; an external
connection/speaking/mute subscription has not been qualified. Voice remains
explicitly unavailable and is never inferred from worker activity.

Observer 0.21 adds consistent outside-click dismissal, a private personal profile
editor, a single expandable fleet/worker column, floating evidence inspection,
and compact hover previews. Project lives beside Host; Motion lives beside map
tools. Theme uses an icon; display/demo utilities live inside grouped settings.
Profile photos are prepared in the browser, validated again by the hub, stored
separately from observations, and fetched only on demand or profile revision.
Hub page navigation no longer rejects a legitimate cross-site top-level visit;
API requests keep the existing origin and authentication protections.
The header Dot companion reports observed worker activity and supports private
browser-local Codex spritesheets. Desktop voice state remains unavailable without
an authenticated bridge to the owning desktop client; no preview call is shown.

Observer0.20 strengthens current-authority checks for settings and administration.
Configuration saves and rollbacks coordinate with administrator revocation and
check authority again at publication; protected settings responses are checked
after asynchronous work. An administrator asks another administrator to rotate
their access key, avoiding self-lockout. Current-password changes remain available.
Collector ingestion retains its global memory/concurrency limits and admits one
in-flight body/commit per source so one source cannot reserve the entire pool.

Browser event retention uses hub receipt order rather than source clock priority.
Source timestamps remain evidence; recent replay stays anchored to the frozen
observation clock and all-history replay can inspect retained future evidence.
These are bounded browser projections: captured numeric usage and exact-version
archive custody are unchanged. ARGELLAN styling and the observation map remain.
Public test fixtures use neutral paths and identifiers, and optional observed
credit balances are explicitly described as private administrator-only data.
Source audit findings and corrected-candidate verification are separate results;
this checkpoint does not itself certify deployment or authorize publication.

Outstanding archive versions now have durable per-source logical admission
accounting and a separate fresh filesystem reserve. Refusal rolls back the
complete new capture transaction and preserves collector pending data/cursors.
Verified archive receipts release charge; drainage and committed-data reads
remain available. Exact previous wire retries retain their accepted identity
without repeating capture writes. The additive accounting schema is inspected
with managed backups; legacy backups remain readable before migration.
Gateway forwarding, personal preferences, backups and restore staging also
check the current request at their asynchronous publication boundaries.

Observer0.19 applies the selected ARGELLAN header and native View disclosure.
Live, History, Usage, Settings, profile and project scope remain explicit
destinations. Theme, density and wall controls retain their existing behavior.
The data-rich dashboard panels, observation map, timeline, inspectors, usage
meters, source capture and archive custody are preserved. This header increment
does not enable optional native control.

Observer0.18 reorganizes settings around complete personal and administrative
workflows: grouped destinations, task search, a narrow-window section picker,
recognizable account scopes, enrollment state, readable diagnostics/storage,
and separately labeled configuration and administration audit streams. Existing
revision checks, private credential handling and personal named layouts remain.
Build identity is shared by the application and settings API. Administrator
health metadata is read on demand; it adds no continuous observation polling.
The observation map, timeline, accounting and exact archive custody remain.
Optional native control is separately qualified work and is not supplied by
these settings improvements. See docs/design/PRODUCT_WORKFLOWS.md.

Observer0.10 adds exact-version archive custody to the durable usage database. A transactional outbox, immutable compressed files, a pinned SSH receiver and verified receipts protect full captured usage before hot-cache eviction. Source timestamp corrections and old account days remain captured without fabricated burn. Offline restore refuses incomplete custody and shares the sender replacement lock. Optional Timescale analytics remains a separately qualified off-Pi integration.

The default destination is unconfigured. No example enables replication or installs infrastructure. Configure a real receiver and pass the activation checks in docs/design/USAGE_ARCHIVE.md; local preservation alone does not establish an off-Pi copy. The Pi keeps its live SQLite files locally; a NAS holds closed immutable files rather than network-mounted active databases.

Existing compact meters, gold/silver/magenta usage coins and the ARGELLAN observation plane are preserved. The application remains a read-only observer of Codex work. Private instance identities, credentials, usage databases, operational addresses and deployment evidence are excluded. See RELEASE_PREPARATION_VALIDATION.md for qualification limits and T3_CARRYOVER.md for remaining integrations.
# Focused security closeout

This release corrects source-context event project binding, archive account-date
compatibility, Windows collector destination permissions, inherited palette-key
lookups and lifetime ribbon-layout retention. Existing captured history remains
intact; presentation caches are bounded separately. Legacy event project scope is
unqualified and is excluded from project-limited views until newly bound events
arrive from updated collectors. See UPDATE.md for receiver-first compatibility.



## V1 focused closeout

The Owner requires the reviewed Obsidian handoff and complete illustrated User Manual before V1. The release retains all captured source history/custody and ARGELLAN artwork. Current changes add on-demand Alerts, wider Observation Plane, 72% default (32-88% range), compact brand lockup, explicit handoff preview/download with current-permission checks, and Profile guide links. Source/storage/ingestion contracts remain unchanged. Qualification reuses prior reviewed preservation/security evidence with only targeted changed-path and lifecycle checks. No new broad security scan or universal performance claim is made.

The focused V1 lifecycle closeout established actual ARM64 machine reboot persistence and fresh Windows collector task-action startup; no Windows OS reboot claim is made. A coherent local production backup and post-reboot private-config/SQLite/archive checks passed. The isolated test unit was removed with test evidence preserved.
