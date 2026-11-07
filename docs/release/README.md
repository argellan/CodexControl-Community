# Bounded release protocol
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

This is the maintainer adoption of the ARGELLAN release-protocol research of
23 October 2026. It supplies evidence structure and a local consistency validator.
It does **not** certify CodexControl, authorize release, start scans or add runtime
telemetry. Continue the currently authorized stage in the existing
`docs/CHECKPOINT.md`; a register is supporting evidence, not another status ledger.

## Start with scope, not a new battery of tests

1. Read current instructions, authority and exact base/head/tree/worktree state.
   Reconcile concurrent writers. Preserve intended source and unfinished work
   privately; exclude secrets and live state from public packages.
2. Freeze a risk-based plan: supported behavior/platforms, actual commands,
   time/resource ceilings, applicable checks, required CI or a justified absence,
   and action authority. Reuse valid unchanged evidence with an explicit rationale.
   The research's timing suggestions are proposals, not automatic new gates.
3. Use [the runbook](worker-runbook.md), [stage catalog](stage-catalog.json) and
   [security profiles](profiles-and-security-checks.md) for the affected boundaries.
   Twelve security procedures describe positive/rejection cases and limits; they
   are not an instruction to scan production or to spawn extra workers.
4. Copy [the example register](release-register.example.json) into an approved
   private evidence directory and replace its placeholders. Record observations,
   limitations, hashes, failures, missing tests and stale evidence honestly.
5. Validate its structure and consistency. Deliver the decision packet and exact
   source/artifact/remote tuple. Existing explicit authority may already cover an
   action; do not manufacture another approval gate. Otherwise the owner decides.
   Push, deployment, publication, tagging and visibility changes remain separate.

G00–G03 cover authority, identity, preservation and the frozen plan; G04–G07 cover
bounded cleanup, provenance, brand and configured quality checks; G08–G12 cover
workflows, performance, security, custody and diagnostics privacy; G13–G15 cover
the artifact, final review and decision packet. G16 verifies an authorized push and
exact-SHA CI; G17 preserves the session. Mandatory coverage is not a demand to run
every possible test. An absent capability can be NOT_APPLICABLE only with a reason
and supporting evidence. Unknown applicability stays unresolved.

## Local validator

Maintainers need PowerShell **7.4 or newer** (`pwsh`), with its built-in `Test-Json`.
The dashboard and Pi hub still need only their documented Node runtime; PowerShell
is not a new runtime dependency. Run from the extracted source root, substituting
the private path:

```powershell
pwsh -NoProfile -File ./scripts/validate-release-register.ps1 -RegisterPath /absolute/private/release-register.json
```

Exit 0 means the record is structurally/semantically consistent. It does not read
referenced evidence files, recompute their hashes, verify signatures or ownership,
contact GitHub, execute recorded commands, or prove that any claimed test happened.
Inspect actual evidence independently. Keep logs/registers with private identities,
addresses and configuration out of public source and public artifacts.

Adopted schema **1.1** adds expected repository visibility and valid stage IDs. The
validator also rejects contradictory authority, stale PASS records, mismatched
source/tree/artifact/version bindings, omitted blocker/risk summaries, missing
owner/restore evidence kinds, out-of-scope approvals, dirty readiness candidates,
inconsistent push states and wrong-SHA/failed/duplicate required CI. Use exact
action tokens (`push`, `deploy`, `publish`, `change-visibility`); aliases are not
inferred. Record an expected old SHA, using the all-zero SHA only for an explicitly
approved new ref. Repository visibility must be known before claiming readiness.
The original research schema is retained privately; its 1.0 records must be
deliberately migrated rather than silently interpreted as 1.1.

Every PASS must describe the current candidate. For valid reuse, retain the
original observed evidence, explain unchanged inputs in `plan.reuse_decisions`,
and record the current applicability/identity review. Do not rewrite a historical
test as a fresh run. A late change invalidates affected evidence and approval;
rebuild the artifact and re-run only justified checks. Current-candidate approval
does not grant authority over another source tree or destination.

## Current product boundaries

Captured usage has a separate exact-version archive contract. Unarchived events
remain locally preserved beyond hot-cache targets; historical event gaps remain
real and complete off-host event custody is **not implemented**. This integration
does not solve that gap or enable event eviction. Optional historical analytics
is separately gated by host qualification and activation. A register or usage
archive receipt does not establish full-instance backup or actual restore.

The package builder now compares mapped README, status, update guide, public
checkpoint, support matrix and carryover documents against their canonical public
sources and checks their application version. It rejects drift before creating a
candidate. It never packages the private outer operational checkpoint. Checksums
establish integrity, not publisher identity, security certification or permission.

## Templates and sources

- [Launcher](launcher.md), [working templates](working-templates.md),
  [decision report](final-push-report-template.md), [schema](release-register.schema.json).
- [Actual repository command forms](repository-command-catalog.md); substitutes
  and side effects must be checked against the current authorized fixture plan.
- [Security procedures](security-procedures.json) and [source register](source-register.json).
  These 22 public references and their status/pins are carried from the research,
  not represented as newly checked upstream documents. `PROJECT-REVIEW` in the
  adapted stage catalog means current project evidence, not an external standard.
  Private local research references and operational identities are excluded.

The full original report/toolkit remain private research inputs. There is no claim
of NIST/ASVS/SLSA certification, independent human sign-off, complete platform
qualification, or current publication approval.
