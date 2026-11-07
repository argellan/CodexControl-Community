# Native account analytics

Author: Bishop Crockett  
Owner: Argellan.com

This integration reads the signed-in account's native Codex analytics. It is separate from observed worker token rates. Screenshots and local fixtures are not account data.

## Source contracts

The installed desktop client uses read-only GET requests under `https://chatgpt.com/backend-api/wham/`:

- `usage/daily-token-usage-breakdown`: daily attribution by feature, model, surface and turn trigger. Preserve the returned `percent` or `credits` unit; never relabel these values as tokens.
- `analytics/daily-plugin-usage-metrics`: plugin invocation counts.
- `analytics/daily-skill-usage-metrics`: skill invocation counts.
- `analytics/daily-workspace-usage-counts` with `workspace_user=true`: personal message/turn counts by model and client.

These are native-client contracts, not a documented stable public analytics API. Contract changes fail closed. The source's freshness timestamp remains separate from collection time. Missing dates remain unknown, and grouped chart categories remain available in the category list and readings table.

## Local enablement and identity

Set `nativeAnalytics: true` within an already enabled local `accountObserver` configuration only after the account owner authorizes the native read. It is off by default. The collector reads its existing Codex sign-in locally, checks the ID-token email against the app-server account identity, and sends the access token only to the fixed OpenAI origin. Redirects, automatic token refresh, login and arbitrary endpoint configuration are not supported. Authentication refusal or account change clears cached analytics. Credentials and private account identifiers never enter collector batches, the browser or release assets.

## Capture, delivery and retention

The collector reads the four datasets at most every five minutes. Each response is bounded, validated and reduced to numeric measurements and categorical provenance. Native skill/plugin identifiers are excluded. Each complete or partial collection is compressed and content-addressed; failed datasets retain their own prior timestamp. A full capture is retried until the existing durable batch acknowledgement succeeds, after which later batches carry a digest reference. Restarting the collector safely resends a full capture.

Full captures use the existing account observation SQLite table and exact-version archive outbox. The account observation payload bound is128KiB; the compressed field is limited to96KiB and decoded content to2MiB. Existing rows, receipts and historical keys are unchanged. No record is evicted without the existing verified archive receipt. A source-scoped digest index resolves current references without scanning account history.

Ordinary account responses contain references only. Authenticated unrestricted administrators may request decoded data with `/api/account/usage?details=1&native=1`; host eligibility and linked account identity are checked before lookup. The UI requests a new body only when an opened history view sees a new digest. Existing live rate refresh remains independent.

## Acceptance

Focused tests cover units, tampering, bounds, identity changes, denial, reference delivery, durable restart, archive capture, API authorization and chart totals. Full source-bound performance qualification and physical device acceptance remain separate release requirements. Enabling this option on production requires the existing deployment authority and performance gate; a local account read does not grant deployment approval.
