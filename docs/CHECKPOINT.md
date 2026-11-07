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


## Community0.1.0 native Windows EXE — local build / installation blocked, 26October2026UTC

Direct Owner scope: build native Windows EXE with bundled runtimes; retain all features except required Pi/NAS dependencies; no WSL/VM/container; local tests; private repo; no publication/deployment. This CE-only tranche does not integrate canonical/internal work or modify the outer root checkpoint. CE remains an unborn local branch ce/preview-0.1.0-20261025; no source/history uploaded. Live GitHub metadata verified private argellan/CodexControl-Community ID1433673781,size0.

Current native build04 is 66,901,504bytes, SHA25663ef438841c81a31132fe32e3d6d1b0c6bf8ad3c0291be74e109dbacb46b7f15; payloadmanifest a7e15aef7310f49a42adaa381e575246511745806b7940c0beed9f5f14e1b7a8;350 payloadfiles plusmanifest,258 apppayloadfiles. BundledNode24.19.0/Python3.13.5/SQLite3.49.1/DuckDB1.5.6 import probePASS. Source additions retain exact-version custody validation and authorization checks; default local receiver/catalog/analytics need no SSH/Pi/NAS. Windows service observation has a bounded native read provider; POSIX helper retained as optional platform support. Advisory-only eight-path patch from7dea00ce applied without ancestor reversions. Required all-platform/all-feature qualification is not inferred from source retention.

Validation: five focused installer/localtransport casesPASS,53 advisory/targets/Windows-service casesPASS. Original RED failures preserved. Initialbuild failed mappedREADME drift; root/distributiondocs corrected with preimages. Native attempt01 failed .NETArrayList/object[] cast before extraction; smallest cast repair verified by attempt02's complete payload verificationPASS. Attempt02 install then failed 'Attempted to perform an unauthorized operation' in the private-directory setup boundary. Appdestination exists empty; privateinstance absent. All owned children terminal; no fixtureport listener; every ownlease released. No alternate ACL route, security-policy change or deletion. This is an OS operation refusal, not an automatic-review rejection. Further native install execution parked.

Next minimal gate: separately approved native Windows execution able to apply the required private-directory DACL to a NEW visibly TEST_ONLY destination, preserving failedfixtures. Existing data/user/config/service/production state must remain untouched. Native install/start/authenticatedapp/localquery, restart, upgrade/forwardrecovery, uninstall/data-retention, GUI/accessibility/freshcoin/device evidence are BLOCKED/NOT_RUN. Current-source mandatory performance and independent release review remain OPEN; no gate weakened. Python3.13.5 is pinned to prior fixture lineage, not claimed newest/security-qualified. Full source inventory/patch/ZIP and exact raw receipts at output/community-0.1.0-windows-20261026. Requested Sol6.1/High/Standard(default/Fastoff); independently observed served/configured tier/effort unavailable. No workers/globalsettings/commit/push/publication/deployment.


## Native Windows installer permission recovery — 26October2026 02:11UTC

Owner explicitly authorized resolving the installer blocker without weaker ACLs and completing local installation/startup/restart/recovery/features; private repo, no publication/deployment. Only CE release/windows/Installer.cs changed in this tranche. Independent control/content-review edits to CE_PREPARATION, support matrices and notices preserved. Outer/canonical source/checkpoint untouched; no commit/push.

Exact native original-method reproduction: current user already owned the directory, but the new descriptor marked owner modified and Win32 SetSecurityInfo refused it (UnauthorizedAccessException,HRESULT0x80070005). Fix persists only the required DACL and refuses unless owner already matches; strict readback requires protected inheritance and exactly current-user+SYSTEM inheritable full-control grants. No ownership transfer, added principal, policy/profile/global change or fallback. Native descriptor regression5/5PASS, including four in-memory unsafe-descriptor refusals.

Final candidate06 EXE SHA256cd0b76335990d211355f632c764a80a19d0b0d425156dffaade7b26d1ad11f59,66,903,552bytes; payloadmanifestf617beab03495db7ad36aff0b2dbdd0d8b206ddddfecfe3716e94329e587b0f8. All350payloads verified by actualEXE and installed-byte readback. All7 final native casesPASS: new secure install with system-onlyPATH/bundledruntimes, occupied-state refusal, authenticatedapp/settings0.1.0/localDuckDBquery, graceful stop/restart identity, data-retaining uninstall guidance. Automatic app deletion/Programs-and-Features registration/logon service not implemented.

Installed feature evidence on runtime-equivalentcandidate05: settings/history/usage/diagnostics/support/localanalyticsPASS, actual protected-config query+MCP5toolsPASS. Browser6profiles nohorizontaloverflow; Flow/Ribbon/replay,Usage/Settings/GitHub/Handoff/Alerts dialogs, reducedmotion screenshots and fresh real-renderer token coinsPASS (2512sprite draws,max12rendered). PhoneMap/tablet worker-node readinessPASS after waiting for realnodes; initial unsettled screenshot retained. Browser/profile evidence is nativeWindowsheadlessChrome, not physicaldevice/performance acceptance.

Supported local consistentbackup/staging/offlinerestore/applicationreadbackPASS with18tables/72schemaobjects, full captured/provenance/head/receipt logical sets at frozen cutoff2026-10-26T01:57:37.279Z; documented stream-generation rotation only. Newer originals preserved, current security hash unchanged,7accepted events read after restart. Local monotonicfixtureRTO891.1287ms;0accepted-cutoff records lost, not productionRPO/RTO/offhost promise. Pending-custody refusalPASS with records/security unchanged. Unqualified code-pointer recovery correctly refused without changing identity/security; no fabricatedperformanceevidence. Archive-only rehydration not claimed.

All original failures retained: missing oldowner-write permission, oldJsoncast, harness snapshot-version/Settingsselector/unknown-provider fixture, stale readiness buffer, unexposed error-code expectation, pending-state sequencing and SQLite null-prototype schema-comparison errors. Corrected harness preserves meaningful assertions; no product behavior weakened. Resource occupied admissions refused before execution and foreign locks untouched; all owned leases/processes closed.

Remaining release holds: Windows receiver directory-publication/power-loss durability and ownership equivalence are NOTQUALIFIED (receiver's fsync_directory skipsWindows); full current-source performance and independent release/security/rights/device acceptance remain OPEN. Functional receipt/restore tests do not prove crash-safe custody or safe exact-version eviction after power loss. No globalsettings/workers/production/live data/providercalls/publication/deployment. Detailed exact raw logs/source hashes/private source ZIP/receipts: output/community-0.1.0-windows-20261026/permission-recovery-20261026T013628Z/NATIVE_RECOVERY.md. Local requested tranche complete; no automatic new testing.

## Candidate07 independent native archive review — 26October2026 00:35EDT

Direct Owner authority: independently review completed Windows archive durability/NTFS fixes, build candidate07, rerun affected archive/recovery checks; preserve06/receipts; private/local, no publication/deployment. Review is CHANGES_REQUESTED_NATIVE_BLOCKER. Source lane451-file frozen input verified against manifest932bcc15b89b4528a8c9a69b4eb6afdd033f03cb4ae9c6bba36bd2a943d1247f; its26offlinePASS reused with14savedreceipt hashes verified, not rerun or native acceptance. No product source or existing ACL changes by this review; no workers/globalsettings/commit/push. RequestedSol6.1/High/Standard(default/Fastfalse), independently observed model/effort/configured/served tierUNKNOWN. Actual ordinaryquota29%used/71%remaining/reset1793513448, credits60997.5521950000 unchanged.

Candidate07 buildPASS exit0/13.578s: EXE66,911,744bytes SHA2560e6de46e7bcbd34f22ba2e8f51271398d635c021c6afc04ca3faa5bb24385143; embeddedmanifest6009e312fe15f4069c6e76edd6f892fa52e49ce824c3e59b1f1dc63d1ba1525e. ActualEXE verifies353payloads; all353extracted hashes and261appsource mappingsPASS. Candidate06 remainscd0b76335990d211355f632c764a80a19d0b0d425156dffaade7b26d1ad11f59; sixsealedartifact/inventoryfiles and all138original receiptchecksums independently match. Twelve source deltas/additions,0removals; exact old/new hashes and fullsourcepatch1b3a0b6d69d8e4f496e51d750bfe70bd7700179279ac0f2fae1f9f38bf8d2b7a retained. Frozen candidate07 source is distinct from this later evidence-only checkpoint append.

P1CE07-01: Python and Node guards apply current/SYSTEM/Administrators owner allowlist to every ancestor includingC:\. Real native Win32 descriptor proves this host's fixedNTFS/non-reparseC:\ root is owned byNT SERVICE\TrustedInstaller; no active untrustedreplacement grant under implemented mask. Owner predicate rejects it. Actual new TEST_ONLYEXE installFAIL(expected0/actual1), receiverFAILdurable:false/noACK, senderFAILARCHIVE_CONFIG_PERMISSIONS, analyticsFAILANALYTICS_FAILED; supportedrestoreBLOCKED at same admission before custody evaluation/replacement. OS-managed owner support needs narrow source-owner disposition without relaxing privateleaf/reparse/unsafe-parent checks. Workspace ancestors also permit AuthenticatedUsersmodify, and observed AppData/Local ancestors have a capabilitySIDfullcontrol grant; they require separate safe-destination compatibility handling. No ACL rewritten, newtrustprincipal added or bypass used.

Synthetic preservationPASS:3capturedobservations/3events/8archiveversions,5heads,0receipts, all18logicaltables/72schemaobjects byte-field reconciled across refusals; pending/inflight state and latestsecurity unchanged. Supportedconsistentbackup/stagePASS at frozen2026-10-26T04:28:53.241Z, backup1792988933249-560d3c11b455. Positive restore/start/restart/authenticatedreadback, nativepublication/flush/ACKretry/eviction remainBLOCKED/NOTRUN; RPO/RTO NOTMEASURABLE. No fabricatedreceipt or performanceevidence. No powerloss/OSreboot/physicaldevice/fullsuite/security/performance rerun. Historicalgapthrough557/archive-onlyrehydration/offhost limits remain.

Allownleases released and childrenterminal; testport64612clear. Laterforeignrendererlease preserved and no furtherheavytests launched. Guard>=24GiBfree/physicalused<70%/commit<60%,Node256MiB/concurrency1 maintained at admission. Repository live metadataPRIVATE,argellan/CodexControl-Community ID1433673781,size0. Existingperformance, independentrelease/security/rights/dependency/signing/device and code-update gates remain. Details/exact commands/logs/preserved partialinstall/sourcebinding: output/community-0.1.0-windows-20261026/candidate07-20261026T042400Z/CANDIDATE07_REVIEW.md. Candidate07 is failed local qualification evidence, not an accepted replacement for06. No automatic retry, publication or deployment.
