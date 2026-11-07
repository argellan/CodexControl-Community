# Opt-in usage exports and synthetic demonstration
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

`public/usage-export.mjs` creates a new allowlisted document from the current account-usage response's `sampleAnalytics`. It does not serialize the original payload, fetch more data, read browser storage, initiate downloads or send/post anything. The caller must provide an explicit export control and show `usageExportPreview(model)` before offering a local download. Render preview values as text, never as HTML. Identity and precise-time switches should start off each time; saved display preferences must not silently opt users into disclosure.

```javascript
const model = buildUsageExport(accountResponse, {
  includeIdentities: false,
  includePreciseTimes: false,
  maxRows: 1000
});
const preview = usageExportPreview(model);
const json = usageExportJSON(model);
const csv = usageExportCSV(model);
const svg = usageExportSVG(model, { theme: 'dark', palette: 'semantic' });
const pngBlob = await usageExportPNG(model);
```

The builder returns a deeply frozen document. Serializers accept only documents produced by this module, so adding arbitrary source fields to a copied object cannot bypass the allowlist. JSON, CSV, SVG and PNG all carry the incomplete-account and accounting limitations. SVG contains a title, accessible description, visible labels and fixed approved token colors; the full caveats remain embedded in its description. PNG is a local raster copy; keep JSON/CSV/SVG available as accessible data alternatives.

Host, session, project and native thread/turn/response identities become aliases by default. Aliases are stable for the same selected identity set regardless of row order; adding/removing identities can change their numbering. They are not a promise of anonymization: dates, counts and activity patterns can remain identifying. A separate explicit switch includes the selected raw identities, and a separate explicit switch includes source/receipt timestamps. Absolute path-like identity values remain excluded. Source IDs, source-record/sample keys, credentials, prompts, arguments, outputs, reasoning text, arbitrary labels and unknown fields are never copied even with those switches enabled.

Default times have day resolution. Rows preserve individual scope/classification and six numeric counter fields; they are not silently combined into daily consumption. Thread totals, last-response readings, response readings and turn totals must not be summed together. The response summary comes from the server's selected response analysis and may cover more records than the displayed/exported recent rows. Coverage includes retained/matching/returned/exported counts, exclusions, identity gaps, conflicts and truncation. Exporting the current view is not a full archive export or proof of complete account usage.

Input includes cached input; output includes numeric reasoning. The additive image uses new input, cached input and inclusive output. Reasoning and cache-write remain separately labeled components. Ratio values are recomputed from the supplied comparable numerator/denominator sums; missing, zero or inconsistent denominators are unavailable. Tokens, source-unit credit balances, native estimates and actual invoices are distinct. No pricing or account-wide completeness is inferred.

Exports are capped at 1,000 rows and inspect at most 5,000 input rows for alias construction. CSV quotes all cells and neutralizes spreadsheet formula prefixes in every string. SVG uses fixed markup, escaped text and palette presets, with no scripts, foreign objects, embedded images or external references. Image dimensions are restricted to 640–1600 by 640–1200 pixels. PNG rasterization prefers direct `createImageBitmap` decoding of an in-memory SVG Blob. If that API is absent or rejects SVG, it falls back to an encoded self-contained SVG data image, which the existing image policy permits. No blob-URI CSP allowance is added. Both paths use a local canvas and bounded image/encoding waits; bitmaps and canvas resources are released on success or failure. No external request is required. Actual browser rendering remains a release qualification step; mocked rasterization tests establish helper behavior, not visual acceptance.

`public/synthetic-demo.mjs` exposes `createSyntheticDemo({seed,workers,now})`. It returns deterministic, immutable TEST_ONLY source rows, usage summaries, workers and tool events for a presentation-only demo. Every host/event is marked synthetic, counters use synthesized provenance, and the returned integration contract disables live ingestion, persistent cursors and notifications. It has no transports, storage access, timers or live clock dependency. Do not pass demo data into collectors, the durable journal, live token-motion watermarks, event recovery, user notifications or the real account state. A demo view must use separate in-memory presentation state and remain visibly labeled TEST_ONLY.

The module includes no real account identity, credential, source path, hostname, IP address or provider billing data. The fixture is suitable for screenshots, onboarding and development demonstrations once the separate UI integration has been reviewed.
