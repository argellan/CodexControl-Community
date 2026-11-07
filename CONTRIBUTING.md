# Contributing to a future public release
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

No public repository is currently designated. Do not infer an official issue tracker, maintainer inbox or contribution agreement. Keep changes reviewable and use synthetic TEST_ONLY fixtures; never submit real machine inventories, session files, tokens, prompts, screenshots or private database content.

Preserve read-only worker observation, source identities, frozen replay, bounded storage/memory and ARGELLAN's visual language in the official build. Distinguish source evidence, inferred relationships and unavailable capability. New settings need validation, permissions, persistence and recovery tests. Use keyboard-accessible controls, a reduced-motion path, legible color semantics and density appropriate to the existing workbench.

Run the sanitized runtime suite with `node --max-old-space-size=256 --test --test-concurrency=1 tests/*.test.mjs`. The source checkout also has [pinned lint checks](docs/DEVELOPMENT.md); those development tools are not runtime dependencies. Qualification also includes Windows and ARM64 smoke checks, TLS/identity enrollment, load and visual review. Private operational tests and deployment records are excluded. Document skipped checks explicitly. The MIT code license permits forks; see TRADEMARKS.md before presenting a fork as an official product.
