# Read-only Codex account observer
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

CodexControl can collect account quota and token-activity metrics from a locally
installed Codex executable. This is separate from token counts observed in worker
session records. The Pi hub does not need Codex or a model runtime installed.

An owner enables the source in a **private local collector configuration**:

```json
{
  "accountObserver": {
    "enabled": true,
    "executable": "/absolute/local/path/to/codex",
    "accountKey": "0000000000000000000000000000000000000000000000000000000000000000",
    "intervalMs": 60000,
    "timeoutMs": 15000
  }
}
```

Use the absolute native executable path for the collector host. Windows uses a
drive-qualified `.exe` path; shell wrappers and network paths are refused. The
example account key is a placeholder: generate an opaque random 32-byte hex value
and assign the same value only to explicitly enrolled sources for the same account.
Do not derive the key from an email address, credential or other personal identifier.
It may be omitted; a null key cannot establish cross-host account identity.

The source opens an owned stdio `codex app-server` process at most once per minute.
It initializes the connection, sends `initialized`, and calls only:

- `account/read` with `refreshToken: false`;
- `account/rateLimits/read`;
- `account/usage/read`.

The official [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server)
defines these read methods. The observer does not read credential files, start or
resume threads, invoke models, perform login/logout, redeem resets, purchase
credits, send email, accept server requests or expose a network listener.

Regular event collection is not blocked by the account request. Each event cycle
samples the latest cached account result while a bounded background request runs.
The collector `--once` mode awaits that one bounded request and then closes it.
Normal collector shutdown terminates its owned child. Requests have a 15-second
default overall deadline, a 512 KiB aggregate output budget and a 256 KiB buffered
line bound. Raw stderr, RPC errors, email addresses, account IDs and auth state
never enter the collector payload. Optional numeric credit balances and their
reported units are retained as source observations when supplied by the native
account response. They are private account data, available only to an authorized
full-scope administrator; scoped viewers do not receive those balances. No
subscription bill or API cost is inferred from them.

The optional top-level `accountUsage` object in a collector batch contains:

| Field | Meaning |
| --- | --- |
| `version`, `source` | Contract version 1 and `codex-app-server` |
| `status` | `available`, `partial`, `stale` or `unavailable` |
| `observedAt` | Last successful metric observation, or null |
| `lastAttemptAt` | Most recent request attempt; this does not refresh old metrics |
| `accountKey`, `planType` | Explicit opaque grouping key and observed plan label |
| `limitsObservedAt`, `limits` | Per-account quota buckets, with primary and secondary windows |
| `usageObservedAt`, `summary` | Lifetime/peak daily tokens, longest turn and activity streaks |
| `dailyUsageBuckets` | At most 366 dated token buckets, or null |
| `errorCode` | Fixed diagnostic category, never raw provider text |

Quota windows expose observed `usedPercent`, `windowDurationMins` and `resetsAt`.
Token summary values are nullable. Missing data remains unavailable rather than
zero. A failed quota or usage refresh preserves that section's earlier timestamp;
the GUI must assess its age separately. `partial` means only one endpoint refreshed,
and `stale` means a request failed after an earlier successful observation. The
hub must enforce authorization before exposing account-wide history to viewers.

The account source cannot be enabled or reconfigured through hub-managed session
source policy. Only an owner editing the local collector configuration can enable
the executable or change its opaque account key. Execution-target collectors do
not invoke this source.

The collector validates optional account observations against the same strict
schema used by hub ingestion before attaching them to a durable batch. Invalid
optional telemetry is omitted while primary worker events, sessions and batch
identity are retained. A previously spooled batch receives the same check on
recovery, so malformed account metadata cannot permanently block its event delivery.
Malformed Unicode labels become unavailable and duplicate provider aliases retain
the first valid observation for each effective quota bucket ID.

The observer compares the documented account type and email only in private
process memory to detect a local account switch. It never exports, hashes as a
grouping key, logs or persists that identity. A detected switch clears all cached
quota and token history before new requests, preventing a partial refresh from
mixing accounts. The configured opaque grouping key is then disabled for the
remaining observer lifetime. Explicitly re-enroll the source with an appropriate
account key and restart the collector after switching accounts. If a usable local
identity is unavailable, each successful account read clears cached sections and
the source remains unlinked; freshness and privacy take precedence over retaining
incomplete account history.

Installer updates can remove version-specific executable directories. The observer
never searches PATH, scans for a replacement, executes a fallback or downloads a
helper. If a launch fails, verify that the explicitly configured native executable
still exists and belongs to the intended local installation. A replacement path
requires an owner to update the private local configuration and use the established
collector restart procedure. Restoring the same configured path allows recovery on
the next normal poll; failed attempts retain the configured 60–300 second cadence,
with only one observation in flight. This is diagnosis and bounded retry, not
automatic repair.

For local integrations, `observer.diagnostic()` returns null without a launch
failure, or a sanitized object with `code`, `action` and `nextAttemptAt`. The code
is `executable-missing` only when launch reports `ENOENT` and a metadata check of
that exact path confirms `ENOENT` or `ENOTDIR`; an existing executable, permission
failure or inconclusive check remains `spawn-failed`. The check shares the original
observation deadline. The action is `verify-configured-local-executable`, and
`nextAttemptAt` is null after stop. No executable path or raw operating-system
error is returned. This local diagnostic is not attached to the shared collector
payload: its compatible `errorCode` remains `spawn-failed`. Showing the precise
local category on the hub requires a separate integration change. Earlier metrics
retain their original timestamps and become stale when a refresh fails.