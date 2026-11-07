# GitHub metadata integration closeout
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

The worker's original V1 slice is reconciled with the released 1.0.1 maintenance
baseline. The combined optional 1.1.0 candidate adds normal runtime scheduling,
secure credential-file reading, branch/open-PR discovery, a scoped ARGELLAN dialog,
gateway forwarding, and a separate exact-receipt archive family. The full contract,
setup and limitations are in [GitHub integration](../design/GITHUB_INTEGRATION.md).

## Preserved review corrections

- Only a conditional request with a sent ETag may accept a 304 validation.
- Retry/reset/poll headers become finite safe deadlines; overflow cannot bypass backoff.
- Lease cleanup errors clear the in-process busy flag and permit recovery.
- 1.0.1 source-context project scoping and unqualified-history exclusion remain unchanged.
- Repository selection invalidates in-flight history responses before rendering.
- The receiver permits filtered V3 queries without changing V1/V2 record validation.

## Qualification and release boundaries

Targeted tests cover collection, identity mismatches, scope, conditional recovery,
rate limits, archive custody, gateway forwarding and late authorization changes.
The actual Python receiver is exercised with exact exported bytes and a lost ACK.
The three worker regressions remain part of the combined suite. Browser checks
cover keyboard/backdrop dismissal, narrow viewport and request suspension.

The frozen candidate is independently reviewed before activation. Production
credential provisioning, source configuration, receiver upgrade and publication
remain distinct operations. An unconfigured source is unavailable; test fixtures
and local benchmark measurements never represent live GitHub evidence.

No existing event/usage/account storage or collector contract is replaced. V3
GitHub observations use a separate local journal. No repository writes, artifact
content downloads, prompts, raw output, private reasoning or credential capture.
The optional usage-only Timescale projection does not accept the new family; use
a non-projection receiver. Keep the maintainer repository's visibility unchanged.
