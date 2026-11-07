# Durable usage and sampled token burn
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

Usage observations live in the hub's existing private `history.sqlite` database. Session samples, baselines, daily deltas, sanitized account reports, source account daily totals and their archive custody commit in the same SQLite transaction as the source checkpoint and events. An acknowledged source batch cannot update the checkpoint while losing its usage observation. Identical retransmission does not add another sample; changed same-timestamp reports are preserved as non-burn revisions. Restart reads the same durable baseline.

Session history starts with the first captured baseline. Previously consumed tokens are retained in that baseline but are not reconstructed as new traffic. The account observer can supply older daily account totals; these are upserted with their source date and retained separately from session deltas. No provider credentials, email, prompts, command arguments or raw results are stored by this feature.

## Rate and color meaning

The live meters sum accepted, monotonic counter increases observed in the last60seconds and divide by60. They measure sampled counter batches, not the provider's token generation cadence. A report may cover an interval longer than the display window; its capture interval remains inspectable. The existing source collector reports periodically and can skip intermediate provider reports. No complete per-request stream is claimed.

Input includes cached input. The three additive visual channels are:

| Channel | Meaning | Map direction |
| --- | --- | --- |
| Gold, Input new | Input increase minus cached-input increase | Observed worker toward labeled model-usage anchor |
| Silver, Output | Output increase | Model-usage anchor toward observed worker |
| Magenta, Cached | Cached-input increase, already included in input | Worker toward model-usage anchor |

Inclusive input remains in the drilldown. None of these values is a bill, currency, subscription allowance or independently verified provider execution. Copied sessions on different machines may overlap; explicit inherited forks and execution-target counters are excluded.

A first reading establishes a baseline. Counter decreases, source-clock rollback, future reports, identity/project/provider/model changes, stale observations and gaps longer than120seconds cannot become fresh burn. Missing fields remain unknown; partial observations are labeled. Quiet after a qualified baseline can show zero, while an old token report becomes stale. A returned result or completed turn can still have a fresh token delta; the calculation does not depend on an unreliable active-session label.

## Map and replay

Coin samples represent bounded batches rather than one animated object per token. Their colors and drilldown preserve exact reported counts. Dedicated model-usage channels are distinct from tool calls and target reports. A token counter alone cannot prove a GitHub request, server hop or network transfer, so coins never use those routes. Missing/hidden workers or unknown providers remain unplaced rather than acquiring an invented route.

The first response establishes a browser watermark. Subsequent committed usage sequences can launch motion once. Refresh, repeat polling, old backfill, replay, paused/hidden views and reduced-motion preferences do not turn retained samples into new live traffic. The browser stores only bounded sequence watermarks, not token reports or credentials. Frozen replay continues to show retained event history; this release does not reconstruct historical token coin flights.

## Retention and access

Usage preservation is independent of the event journal's seven-day policy. Raw session/account observations target30days or a shared200,000-row hot cache; account observations have a50,000-row sub-target. Sampled session daily rollups and source account daily totals target730days or a shared200,000-row hot cache. Baselines target200,000rows. None of these targets permits deleting an unarchived record version. Failed or unconfigured archival preserves the backlog beyond the targets. Lossless immutable archive segments have no automatic age-based deletion. See [permanent usage archive](USAGE_ARCHIVE.md) for custody, resource bounds, NAS placement and optional Timescale analytics.

Host, project and selected-session restrictions apply in SQL before rates, rows and counts are returned. Disabled or expired sources are excluded from live projections. Account-wide history additionally requires an administrator with unrestricted host/project authorization; separate account allowances or daily totals are never added together. A narrow display selection does not turn account-wide weekly allowance into project usage.

Backups include all usage and archive-custody tables in the same SQLite snapshot. Restore validates their schema, metadata, counters and sanitized account payloads. Older backups remain readable, but replacing current usage requires its archive bootstrap and pending transfers to be complete. Offline restore and the archive sender share an exclusive database replacement lock. Partial or unexpected schemas are refused. Code rollback must preserve current data and account/password registries; use a matching reviewed backup procedure for an actual storage rollback.
