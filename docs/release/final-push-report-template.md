# ARGELLAN final push report
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

Fill this before requesting push approval. All [REQUIRED] fields must be resolved or explicitly marked unknown/blocked. This document is not approval.

## Recommendation for the owner

Decision: [BLOCKED / READY_FOR_PUSH_REVIEW / READY_WITH_ACCEPTED_RISK]  
Reason and affected scope: [REQUIRED]  
Owner: [REQUIRED]  
Accountable worker and independent reviewer if used: [REQUIRED]  
Date and evidence register revision/hash: [REQUIRED]

## Authority and exact identities

- Authorized activities and authority reference: [REQUIRED]
- Requested model/effort/speed and independently observed settings: [REQUIRED]
- Unknown setting exception, if permitted: [REQUIRED or NOT_APPLICABLE]
- Repository URL and stable ID, visibility, target ref: [REQUIRED]
- Canonical source/worktree owner and branch: [REQUIRED]
- Expected old target SHA and proposed new commit/tree: [REQUIRED]
- Dirty/staged/untracked manifest and disposition: [REQUIRED]
- Release label and all version consumers: [REQUIRED]
- Exact artifact paths, SHA-256, build inputs/tool versions: [REQUIRED]
- Supported/experimental/unqualified platform and feature claims: [REQUIRED]

## What changed and why

Concrete problem, resulting behavior and compatibility impact: [REQUIRED]  
Behavior-preserving cleanup and equivalence evidence: [REQUIRED]  
Rights/provenance, license/notice and current brand decisions: [REQUIRED]  
Version/package/document alignment: [REQUIRED]  
New unsupported claims or removed scope: [NONE or explicit decision]

## Preservation and recovery

Checkpoint ID and private authorized location/recipient: [REQUIRED]  
Local-only/off-host verified/unconfirmed transfer state: [REQUIRED]  
Manifest/hash readback and source reconstruction evidence: [REQUIRED]  
Intended untracked source included; operational secrets excluded/protected: [REQUIRED]  
Data backup/snapshot and actual restore evidence, RPO/RTO: [REQUIRED where persistent data]  
Historical gaps, pending records and retention limits: [REQUIRED]

## Qualification summary

| Check group | Candidate/environment | Observed result | Evidence IDs | Limits or reused evidence rationale |
| --- | --- | --- | --- | --- |
| Baseline and quality/build | [fill] | [fill] | [fill] | [fill] |
| Unit/integration/regressions | [fill] | [fill] | [fill] | [fill] |
| Clean install/upgrade/restore/uninstall | [fill] | [fill] | [fill] | [fill] |
| Browser/hub/collector cells | [fill] | [fill] | [fill] | [fill] |
| Performance and resource bounds | [fill] | [fill] | [fill] | [fill] |
| Security static and dynamic separately | [fill] | [fill] | [fill] | [fill] |
| Custody/reconnect/pressure | [fill] | [fill] | [fill] | [fill] |
| Privacy/diagnostics/telemetry | [fill] | [fill] | [fill] | [fill] |
| Exact package/notices/version/diff | [fill] | [fill] | [fill] | [fill] |

Totals: PASS [n], FAIL [n], NOT_RUN [n], BLOCKED [n], STALE [n]; NOT_APPLICABLE [n with evidence].  
Missing tool/permission/platform/independence: [REQUIRED]  
Tool false positives and coverage limits: [REQUIRED]  
Raw metrics, baseline equivalence and outliers: [REQUIRED]  
Final aggregate checks and last changed inputs: [REQUIRED]

## Findings and closure

For every finding fill impact, likelihood/preconditions, confidence, release scope, affected code/route, owner and exit test. Attach reproduction or clearly label static hypothesis.

| ID | Blocker and why | Status | Exit test and new candidate | Closure evidence or owner risk decision |
| --- | --- | --- | --- | --- |
| [fill] | [fill] | [fill] | [fill] | [fill] |

Eligible accepted risk: [ID, owner, explicit authority, reason, compensating controls, expiry/trigger].  
Unwaivable authority/rights/identity failures resolved: [REQUIRED].  
Unrelated later improvements excluded from this gate: [REQUIRED].

## Exact approval request

Requested action: [single named private ref update; list any separately requested tag/release/deploy actions]  
Target repository and ref: [REQUIRED]  
Visibility: [REQUIRED]  
Expected remote old SHA: [REQUIRED]  
Approved candidate new SHA and artifact digests: [REQUIRED]  
Included risk decisions and rollback/recovery plan: [REQUIRED]

Owner response and evidence reference: [PENDING; fill actual response without inference].  
If target/source changes, this approval is [STALE pending re-review under policy].

## Post push verification addendum

Actual action/time: [NOT_RUN until authorized]  
Transport result: [denied/pending/uncertain/success with evidence]  
Independent remote SHA/visibility readback: [REQUIRED after push]  
Required CI names, exact SHA, attempt and conclusion: [REQUIRED; missing/skipped/unavailable explicit]  
Artifact download digest/attestation if in scope: [REQUIRED or NOT_APPLICABLE]  
Final state: [NOT_PUSHED / PUSHED_PENDING_VERIFICATION / REMOTE_VERIFIED / BLOCKED]  
No public release/deployment claim unless separately verified: [fill actual status].

## Next session handoff

Last completed gate, next exact action, remaining authority/access blocker, owned helper cleanup and final preservation receipt: [REQUIRED].

