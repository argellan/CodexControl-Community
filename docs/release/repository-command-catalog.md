# Repository command catalog
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

These are command forms extracted from the selected source, not permission to run
them. Re-read their actual flags, side effects and fixture boundaries at the current
candidate. The source checkout has pinned development-only lint tools; the hub and
collector have no npm runtime dependencies. See [source checks](../DEVELOPMENT.md).

| Purpose | Command form | Current source / scope |
| --- | --- | --- |
| Runtime identity | `node --version` | INSTALL.md; reads executable version only |
| Targeted release checks | `node --test --test-concurrency=1 tests/release.test.mjs tests/release-protocol.test.mjs` | Disposable setup/packaging fixtures and register validation; PowerShell 7.4+ required for register tests |
| Source lint | `npm run lint` | JavaScript, CSS, HTML and JSON; development tools only |
| Complete existing suite | `node --max-old-space-size=256 --test --test-concurrency=1 tests/*.test.mjs` | CONTRIBUTING.md; execute only when the frozen risk-based plan calls for it |
| Candidate build | `node scripts/package-release.mjs --final-runtime --destination=ABSOLUTE_NEW_DIRECTORY` | scripts/package-release.mjs; writes a new directory, explicit manifest and checksums; no push |
| Provisional candidate | `node scripts/package-release.mjs --provisional --destination=ABSOLUTE_NEW_DIRECTORY` | Same builder; missing payloads remain provisional, never qualified by renaming |
| Register consistency | `pwsh -NoProfile -File scripts/validate-release-register.ps1 -RegisterPath ABSOLUTE_PRIVATE_REGISTER` | Schema/semantic checks only; no evidence execution or external requests |
| Selected instance diagnosis | `node scripts/community-doctor.mjs --instance-dir=ABSOLUTE_PRIVATE_INSTANCE` | Read scripts/community-doctor.mjs and secure operator authority first; diagnostic output can be private |

Uppercase values are required substitutions, not literal ready-to-run arguments.
Shell quoting depends on the actual path. Setup, update, enrollment, service,
restore, uninstall and host commands have separate mutation/identity consequences;
read INSTALL.md, UPDATE.md, UNINSTALL.md and the affected script before planning an
isolated smoke check. No generic production mutation, Git push or scan command is
implied here. The schema validator does not validate shell syntax or sandbox a
command: it never runs one.
