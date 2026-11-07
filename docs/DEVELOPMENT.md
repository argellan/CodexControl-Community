# Source checks
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

The hub and collector still run directly on Node.js 24 without npm runtime
dependencies. The root package.json and lockfile provide development checks only;
the release allowlist does not include the npm tooling or node_modules.

Install the pinned JavaScript tools with `npm ci --ignore-scripts`, then run
`npm run lint`. This checks every JavaScript module, stylesheet, HTML document and
JSON file outside generated/dependency directories. ESLint checks both the runtime
and tests, with separate browser and Node globals. Stylelint checks CSS correctness;
HTML Validate checks structure, controls and ARIA. The checks do not reformat files.

Three exceptions preserve intentional behavior: validators may reject ASCII control
characters, public errors may omit private upstream causes, and labels may retain
explicit `for` associations even when their control is nested. The access-key input
has a local autocomplete exception; account passwords retain normal autocomplete.
The installer's private-directory helper must always apply its credential-protection
precondition, so its documented analyzer exception does not add a bypassing WhatIf.

## Other languages

Use a disposable Python environment and install `scripts/lint-requirements.txt`.
With that environment active, `npm run lint:python` runs the pinned Ruff checks.
`npm run lint:sql` parses the PostgreSQL archive projection and checks ambiguous
columns, set widths, joins, casts and references. It does not apply the SQL or
qualify a live PostgreSQL/TimescaleDB instance. Python is not required to run the
ordinary hub or collector.

PowerShell checks require PowerShell 7.4+ and PSScriptAnalyzer 1.25.0. Run
`npm run lint:powershell` if the module is on PSModulePath, or use a local module:

```powershell
Save-Module PSScriptAnalyzer -RequiredVersion 1.25.0 -Path .local/ps-modules
pwsh -NoProfile -File scripts/lint-powershell.ps1 -AnalyzerPath .local/ps-modules/PSScriptAnalyzer/1.25.0/PSScriptAnalyzer.psd1
```

Install ShellCheck 0.11.0 and run `npm run lint:shell`. Set the `SHELLCHECK`
environment variable to an absolute executable path if it is not on PATH.
All deployment shell scripts are checked using the POSIX sh dialect.

The container recipe can also be checked with Hadolint 2.15.1:
`hadolint deploy/archive-container/Dockerfile`. Its DL3008 warning remains until
the deployment's Debian package versions are qualified and pinned; source lint
does not select or install production packages.

## Tests and optional analytics

`npm test` runs the complete existing synthetic suite with a 256 MiB Node heap and
test concurrency one. The equivalent command without npm is:

```text
node --max-old-space-size=256 --test --test-concurrency=1 tests/*.test.mjs
```

Install `scripts/analytics-requirements.txt` in a disposable Python environment
and set `CODEX_ANALYTICS_PYTHON` to that environment's absolute Python path to
include the real DuckDB engine and HTTP integration cases. Without that variable,
those tests report explicit skips. POSIX-only checks also skip on Windows; passing
Windows tests does not qualify Linux/ARM64 deployment.

Repository/Owner resource guards still apply. Use disposable synthetic data, keep
one heavy job active at a time, and preserve original failed test output alongside
subsequent correction evidence. Source checks do not authorize production changes,
publication, real telemetry or a release. Build a new candidate to regenerate its
manifest and checksums after source edits; old receipts describe their original bytes.
