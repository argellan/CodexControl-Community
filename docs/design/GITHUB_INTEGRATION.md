# GitHub repository evidence
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

CodexControl can collect repository, branch, pull request, check, commit-status,
workflow-run and artifact **metadata** from GitHub.com. Open **GitHub** in the
dashboard header. It is a read-only evidence view; it cannot merge, approve,
dispatch, cancel, download artifacts or modify a repository.

## Reading the view

Choose a repository, then expand a PR, check, run or artifact. PRs include the
base/head repository IDs and exact SHAs. Artifact digests and run attempts are
reported by GitHub; CodexControl does not download bytes to verify those digests.
Links open the corresponding GitHub page. Titles, descriptions, account names,
workflow names, logs, file contents and credentials are deliberately excluded.

The source host/project binding is explicit. The panel is independent of the
observation-plane replay clock and shows its own capture/validation times.
`current` means the configured cycle finished; it never means complete repository
history, permission to merge, or an independently proven passing build.
`collecting`, `partial`, `rate limited`, `stale` and `unavailable` remain visible.

**Captured history** pages through immutable observations, including conditional
304 validations. A changed/restored journal resets an incompatible cursor with a
gap notice. **Refresh view** returns to the latest summary; it does not force an
extra GitHub collection. The browser updates every 15 seconds only while the panel
is open, visible and automatic refresh is selected. Closing it stops its timer.

## Secure enrollment

Enrollment is optional and disabled by default. Use an expiring fine-grained
personal access token restricted to the intended repositories, or a GitHub App
installation token refreshed by an external credential manager. The collector
does not mint or refresh tokens. Required read permissions: Metadata, Contents,
Pull requests, Commit statuses and Actions. Grant no write permissions.

GitHub does not offer Checks API access through fine-grained personal tokens.
For those tokens, explicitly set `collectChecks: false`; the view reports partial
coverage and never treats unavailable checks as a passing or empty check result.
Checks require a GitHub App installation token with Checks read access. The
default `collectChecks: true` remains suitable for that complete integration.
See [GitHub token limitations](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens-limitations).
The application cannot prove the issuer's effective grant from a token string;
the administrator must verify least privilege in GitHub.

Keep the credential in an owner-private local regular file, never an environment
variable, command argument, browser field, source file, enrollment export or Git.
On POSIX, use mode 0600 and the hub's OS account. On Windows, allow only that
account, SYSTEM and Administrators. Do not use SMB/NFS for credentials or journals.
Tokens are refreshed from that file when it changes or after 60 seconds.

Add the following optional `github` property to the hub's private startup JSON.
Substitute the real immutable repository ID, an enrolled source host, exact
project label and local paths. Restart the hub after changing startup bindings.
The configuration is not currently edited through Settings Center.

```json
{
  "github": {
    "sources": [{
      "sourceId": "github-example",
      "hostId": "example-host",
      "project": "Example project",
      "repository": "example/example-repository",
      "repositoryId": 123456,
      "branch": "main",
      "discoverPulls": true,
      "collectChecks": false,
      "pullNumbers": [],
      "intervalMs": 300000,
      "enabled": true,
      "credentialFile": "/srv/codex-control/private/github-token"
    }],
    "archiveSenderConfigFile": "/srv/codex-control/private/archive.json"
  }
}
```

At most eight sources are accepted. A source binding is immutable once its journal
exists; changing the repository, host or project requires a new source ID/journal.
Keep the old journal and its archive. Disabled/expired hosts stop collection and
lose view access. Individual viewer permissions must include both the bound host
and project. Shared/legacy viewer credentials cannot read private GitHub evidence.
A loopback gateway must forward an individual hub credential over validated TLS.

## Capture, limits and retention

Collection uses GET requests only, a fixed `api.github.com` origin, explicit API
version, no redirects, repository-ID checks, bounded bodies, validated pagination,
persisted backoff and conditional ETags. One scheduler processes sources serially,
at most two requests per source per 15-second tick. Default cycles are five minutes.
Initial larger cycles can therefore take several minutes. No browser drives them.

Open-PR discovery captures the first page of up to 50 recently updated open PRs
and expands up to 16 PRs; explicit PR numbers can track closed PRs. The configured
branch is monitored even without PRs. Checks/statuses/runs are queried in the base
repository for observed heads. Fork-only checks and complete historical discovery
are outside this integration. Limits are 20 pages per endpoint and 2,048 jobs per
cycle. Limits produce `partial`, and every captured page remains stored.

Journals live in `dataDirectory/github/<sourceId>.sqlite`. The summary is bounded
to 100 pages/300 records; history responses are separately bounded. These display
limits never remove observations. Pending archive bytes and filesystem reserve
apply backpressure before further collection. No local deletion operation exists.

The optional archive sender reuses the established pinned SSH transport but adds
a separate V3 `github_metadata` family. Upgrade the receiver first. Exact pending
bytes survive restart and lost acknowledgements; custody advances only after the
expected receiver confirms exact batch hash and membership. Existing V1/V2 usage
records are unchanged. The NAS stores immutable compressed NDJSON, not active SQL.
Local journals are retained even after acknowledgement. Archive failure appears in
the panel with backlog counts. Retained rows and incomplete cycles remain intact.

The optional Timescale projection is usage-only. Use a receiver with that projection
disabled for GitHub metadata; a projection-enabled receiver explicitly refuses V3
without acknowledging it. GitHub observations remain pending locally in that case.
Do not treat local backup/restore of `history.sqlite` alone as a GitHub backup:
also copy the complete GitHub journal directory while the hub is stopped, or use
SQLite's coherent backup API and preserve archive receipts/inflight batches.

## Operational verification

Confirm the repository ID and read-only grant before activation. After startup,
verify a current or explicitly partial cycle, branch SHA, latest check/run state,
and a durable archive receipt. Test a scoped viewer and a denied viewer. Check
source/credential expiry, network outage recovery and backlog visibility. Compare
the displayed SHA and metadata with GitHub. Keep credentials and live readbacks
outside the distributable source tree.
