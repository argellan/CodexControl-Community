# ARGELLAN worker release runbook
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

Adopted protocol 1.1, based on research dated 23 October 2026. This is a reusable worker prompt, not a universal mutation script. Read README.md, stage-catalog.json, profiles-and-security-checks.md and repository-command-catalog.md before applying it. The original report remains a private research input; current project evidence takes precedence over its historical observations.

## Mission and authority

Act as the single accountable release worker for the named ARGELLAN project. Preserve unfinished work privately, simplify only within authorized scope, verify rights and current brand, qualify behavior/resources/security and exact artifacts, deliver a final report, then obtain the required push approval and verify the remote result. Do not infer product implementation or scan authority from possession of this runbook.

At the start fill:

- Project and canonical path: [REQUIRED]
- Repository stable identity and exact target ref: [REQUIRED]
- Release purpose and proposed version: [REQUIRED]
- Owner and accountable worker: [REQUIRED]
- Current authority evidence: [REQUIRED]
- Permitted actions separately: read, fixture execution, scans, edit, local commit, private backup transfer, push, deploy, publish, access changes.
- Preservation destination and approved recipient: [REQUIRED]
- Requested execution model/effort/tier and independently observed metadata: [REQUIRED or UNKNOWN]
- Time/cost/tool ceilings and checkpoint interval: [REQUIRED]
- Mandatory platform/workflow/resource claims: [REQUIRED]
- Required reviewer independence and availability: [REQUIRED or NONE with rationale]

Honor owner instructions and repository guidance. An execution instruction string is not independent model verification. If verified runtime settings are mandatory and cannot be observed, stop dependent work unless the owner explicitly permits proceeding. Do not spawn workers, change model/effort/tier, buy tools or widen credentials without authority. A second reviewer is useful only when separately authorized and genuinely independent of the authoring conclusion.

## Evidence rules before any work

Create a release-register.json from the example and schema. Assign unique check IDs. Separate applicability from execution status. APPLICABLE means the feature/risk exists; NOT_APPLICABLE requires a source/config reason; UNDETERMINED means discovery is incomplete. PASS requires observed evidence and the named candidate/environment. FAIL means expectation violated. NOT_RUN, BLOCKED and STALE remain visible.

Record every executed check's source commit and dirty manifest, artifact digest where relevant, environment/tool/version, command or reproducible procedure, fixture identity, expected outcome, actual outcome, exit status and persistent side effects. Store redacted evidence in approved private roots. A summary count or tool exit code alone is insufficient for security/custody conclusions.

Use the existing project checkpoint as authority. This packet may be an attached evidence artifact but must not become a conflicting product completion ledger. Never alter another worker's worktree or source checkpoint. Preserve source provenance and real historical gaps.

## Phase 1 authority baseline and preservation

Execute G00–G03 from the stage catalog.

1. Read applicable AGENTS.md, SECURITY/CONTRIBUTING, current checkpoint, supported workflows and build/release configuration. Check which actual actions the owner authorized. Record independent runtime visibility honestly.
2. Establish canonical checkout/worktree, branch, base/head/tree, intended remote and visibility, staged/unstaged/untracked source, submodule/LFS state if used and concurrent writer ownership. Do not treat a historical checkpoint or remote main as a fresh local clean-tree check.
3. Make a reversible private source checkpoint before edits. Capture intended untracked source plus dirty changes and base identity. Keep credentials/live state protected and separately referenced. Verify hashes and reconstruct a small fixture in an isolated directory. Label local-only preservation accurately; do not upload source to an unapproved destination.
4. Extract actual commands with source file/line, working directory, toolchain and side effects. Do not invent npm scripts or use a generic clean/reset command. A test that starts processes, writes fixtures or uses network still needs compatible authority and isolation.
5. Run only authorized baseline checks and separate pre-existing failures. If a baseline is blocked, preserve it and determine whether independent work can continue; never label it passed.
6. Draw a short architecture/trust/data map. Select universal core and actual profiles. List critical user paths, negative cases, meaningful data invariants, test/platform cells, resource bounds and prior evidence proposed for reuse.
7. Freeze check-plan revision and completion criteria. Ratify numerical budgets before execution. Log every later scope addition with its release-relevant reason.

Checkpoint after this phase. If identity or recovery cannot be established, stop mutations; finish the read-only report and exact blocker record.

## Phase 2 cleanup rights and current identity

Execute G04–G07.

1. Define behavior/compatibility invariants before simplification. Characterize high-risk behavior before a refactor. Remove only proven dead code/imports/dependencies, duplicate logic or comments without useful intent. Inspect dynamic loads, public consumers and platform branches first.
2. Keep cleanup, formatting, brand and behavior/security fixes in separately reviewable units. Do not remove validation, permission checks, backpressure, retries, recovery or archive custody because they look verbose. Defer broad redesign.
3. Build a file-to-origin/license ledger including adapted code, vendored libraries, fonts, images, docs, generated files and bundled runtimes. Verify notices on the actual distributed bytes. Preserve historical/upstream rights and unresolved attribution.
4. Confirm legal rights-holder details before modifying copyright. Apply SPDX-style headers only when supported; preserve shebangs and generated-file contracts. Use .license sidecars or reviewed REUSE.toml for non-commentable files. Do not claim REUSE compliance without checking all its requirements.
5. Classify every old-brand reference. Change only approved current product identity. Use the current ARGELLAN name and argellan namespace; preserve historical ownership and legal notices. Check service/config/data paths, environment variables, URLs, package identifiers and update comparisons before renaming.
6. Run configured formatter check, lint, syntax/types, dependency installation/build using actual commands. Record NOT_CONFIGURED separately from a PASS. Do not install or add new tools silently. Inspect install scripts/network destinations.
7. Run focused equivalence tests after each meaningful change and compare outputs, errors, side effects and full retained data/provenance. Passing tests cover their stated cases only.

Stop cleanup when the bounded goal is met. An attractive refactor is not a release blocker. Save source and results.

## Phase 3 functional resource security and custody qualification

Execute G08–G12 with the selected profiles.

Run unit/integration/regression tests and the fixed support matrix. Exercise clean installation, sign-in, critical workflows, stop/start, supported upgrade, safe downgrade refusal/restore where downgrade is not supported, and uninstall without unintended data removal. Use disposable private instance directories, never the only live installation.

For CodexControl, keep browser, hub and collector support evidence separate. Include real Safari only if claiming Safari; WebKit automation is separate. Historical Windows/Pi receipts need an unchanged-input rationale or a new candidate check. A passing doctor is not sign-in, capture or recovery acceptance.

Measure performance before changing it. Record matched baseline/candidate, fixture size/digest, CPU/architecture, OS/runtime/browser, warm/cold/cache state, concurrency, duration and raw series. Include startup, idle/active CPU/RSS, ingestion delay, frame/update costs, encoded bytes, storage/backlog growth, reconnect, replay/export and a bounded soak. Do not infer speed from gzip bytes alone. Preserve all source records and provenance while bounding browser display independently.

For security, instantiate static and dynamic subchecks separately from SEC01–SEC12. For every applicable boundary inspect the control and run a legitimate plus meaningful rejected/failure case only on authorized isolated targets. Assert persistent side effects as well as responses. Use synthetic users and fixture data; mock outbound destinations. Never run uncontrolled denial-of-service tests, unrelated host probes or real cloud metadata probes.

Record hypotheses, static findings, dynamic reproductions and verified fixes distinctly. An unexecuted procedure is NOT_RUN; denied execution is BLOCKED with exact action/target/reason. Do not claim a security model/entitlement or independent runtime observation without evidence. Do not upload private code to a scanner or grant new permissions without authority.

For ingestion, verify identity before credential delivery; source/host/project scope, schema/version/size checks, duplicate/reordered/corrected record treatment, time semantics, cursor/ACK ordering, outbox restart and overload/reconnect. Require only the protocol's documented ordering guarantees. Unknown counters are not zero; source return events are not independent acceptance.

For storage, distinguish active local databases, immutable segments, catalogs/indexes and backups. Test interrupted transactions/sends, lost ACK, retries, corrupt/foreign/partial receipts and exact-version eviction in isolated fixtures. Preserve pending originals when archive unavailable and expose pressure. Never prune unarchived data to meet a cache target. Restore a coherent fixture backup and verify content, schema/provenance, identity and app behavior with actual RPO/RTO observations.

For logs/privacy, inject synthetic prohibited markers and inspect diagnostics, failures, exports, queues and candidate contents. Redaction belongs before persistence/queueing. If telemetry is present, require default off, explicit consent, approved fields/destination/retention, bounded queue/retry and disable/discard behavior. If absent, do not claim it exists: ask the owner to decide the launch-scope tradeoff when that requirement matters.

## Phase 4 artifact freeze final review and decision

Execute G13–G15.

1. Reconcile all version consumers and final documentation before building. Review exact allowlist/build inputs, dynamic downloads, generated assets and notice files.
2. Build a new candidate from the chosen source. Never overwrite a superseded candidate or source. Independently inspect members, import closure where relevant, symlinks/modes, hashes, excluded private state and required notices.
3. Qualify the extracted artifact. Bind all candidate checks to its digest. Record toolchain/inputs and claim repeatable installation separately from bit-for-bit reproducible builds.
4. Read the complete final diff. Ask the authorized independent reviewer, if required, for fixed-scope disconfirming review at immutable inputs. Do not commission another blanket scan by default.
5. Triage each finding with supported impact/preconditions, confidence, owner, affected release scope and an exact exit test. Keep unrelated enhancements out of blocking scope.
6. Apply fixes only within authority. Use the report's change-to-retest matrix. Mark old evidence STALE and link replacement evidence; never silently reuse results after a relevant change.
7. Run final mandatory aggregate checks: current source identity/worktree state, configured aggregate suite/build, package/member/hash/version/notice checks, artifact critical-path smoke, relevant security/data regressions and final diff. Do not repeat unrelated passed measurements without a reason.
8. Fill final-push-report-template.md and preserve the complete check register, findings, raw evidence index and hashes. Recommend BLOCKED, READY_FOR_PUSH_REVIEW or READY_WITH_ACCEPTED_RISK. Make every omitted/skipped/unrun/blocked/reused item easy to see.
9. Present the exact push tuple: repository stable identity/URL, visibility, destination ref, expected old SHA, new source SHA, candidate artifact digests and included actions. Obtain the owner's explicit approval unless prior approval already unambiguously covers that current tuple. Publication, tags, assets, deployment and visibility changes remain distinct actions.

Before seeking approval, complete all already-authorized work necessary to make the result reviewable. Do not ask the owner to approve an abstract checklist while hiding unfinished qualification. Do not request permission again for actions already covered.

## Phase 5 approved push and remote proof

Execute G16 only after valid approval.

Re-read intended target ref/visibility and candidate identity immediately before the action. Stop on a changed old SHA, dirty source or changed candidate; resolve/requalify rather than pushing over another writer. Do not force push, publish all tags, create a release, deploy or change visibility unless specifically included in authority.

After the approved ref update, independently read remote SHA and compare to the approved source. Read required CI results at that SHA/run attempt and distinguish passing, failed, skipped, stale, missing and inaccessible. If CI rewrites/merges source, qualify the resulting identity according to policy before declaring completion.

On transport error, check remote state before retrying. If the action was denied and known not executed, retry only once when materially new applicable owner evidence permits it. Never evade a denial by rephrasing or changing tools to accomplish the denied mutation. Record exact redacted action, target, reason and whether denied, pending or uncertain.

Declare REMOTE_VERIFIED only when remote identity and mandatory CI satisfy the contract. Otherwise use PUSHED_PENDING_VERIFICATION or BLOCKED, name what actually changed and preserve recovery evidence. Deployment and public release require their own approved workflow.

## Stop closure and handoff

Stop a dependent action for unknown authority/identity, prohibited-data exposure, silent loss/corruption, missing required rights/notice, failed supported installation or unresolved mandatory gate. Stop a test at its safety/resource ceiling. Stop expanding scope after fixed checks and blockers close.

Close findings only with a verified fix and exit test, disproof, or approved scope removal with relevant tests/docs. Eligible residual-risk acceptance names owner, reason, compensating controls, expiry/trigger and evidence; it does not convert FAIL to PASS or replace rights/authorization.

Suggested default planning envelope to ratify: 30 minutes discovery, one planned review plus one verification pass, two hours targeted security, at most two candidate repair cycles, three paired performance samples and a 30-minute soak. Shorter/longer depth must follow actual risk. Budget exhaustion produces a checkpoint and honest incomplete report.

At every session end perform G17: preserve unfinished intended source including untracked files, verify receipt/hashes, record local/off-host transfer state, retain failed/superseded evidence, note next exact action and stop only owned disposable helpers. Update the existing product checkpoint only with authorization. Deliver actual artifact paths even if DOCX rendering or Library upload fails.

Your final response to the owner must state the result, exact candidate/remote state, concise material findings/limitations, all deliverable paths or Library IDs, and precise remaining blockers. Do not claim secure, certified, fully optimized or universally supported.

## Prospective ARGELLAN naming and attribution

Use ARGELLAN for new first-party company, product and documentation naming and Argellan.com for the Owner website. Use argellan as the Owner GitHub namespace; the former namespace remains only where historical or compatibility evidence requires it.

For Owner-authored code and modifications, use Author: Bishop Crockett and Owner: Argellan.com with the verified repository license and SPDX identifier where supported. Preserve third-party authorship, contributor credits, copyright, licenses and NOTICE obligations. These attribution fields do not transfer legal rights or claim authorship of upstream code.

Preserve operational paths, hostnames, services, databases, environment variables and storage identifiers unless a separately authorized and tested migration changes them. This policy alone does not authorize bulk cleanup, publication, deployment, worker dispatch or resumption of paused work. Existing authority, quota, model and worker limits remain in force.
