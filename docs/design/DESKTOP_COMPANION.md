# Desktop Dot observation
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

The companion has two independent inputs: observed worker presence and the
desktop's selected Dot artwork. Neither input establishes that a voice call is
connected, that someone is speaking, or that the microphone is muted.

## Automatic artwork

An administrator can opt a Codex-source collector into discovery by adding
`"desktopCompanion": {"enabled": true}` to its private collector configuration.
The collector reads its own OS user's `.codex/.codex-global-state.json`. A custom
absolute `codexHome` is optional. No account password or additional API key is
needed. This integration is version-sensitive and fails closed if the saved
desktop schema changes. Execution-target collectors do not enable it.

Discovery matches the cached account/user pair to its exact saved pet selection.
It reads only the matching artwork reference, fingerprint, sprite version and
Dot display name; it does not retain account IDs, signed URLs, descriptions,
message previews or other desktop content. Multiple accounts are never guessed
from a list of pet names. Built-in pets and WebP-only cache entries are not yet
supported by automatic discovery; unsupported selections remain unavailable.

Checks run at most once per five seconds, with no overlapping work. An unchanged
file needs only a stat check. Validated PNG sprites use the desktop's 8-column
layout and either 9 or 11 rows, with 192-by-208-pixel frames. The maximum image
size is 8 MiB; PNG dimensions, CRCs, inflated row sizes and filter bytes are
validated, and metadata is removed. Downloads require HTTPS on an OpenAI artwork
subdomain, normal TLS verification, no embedded credentials, no redirects, a
ten-second deadline and an eight-MiB response bound. Download URLs stay in memory.

Cloud artwork links expire. A previously verified private local cache survives
restart and does not need a working link. A newly selected uncached image needs
a fresh link from the desktop; opening the desktop's pet settings can refresh
its cache. No desktop authentication credentials are extracted to renew links.

The collector sends a changed image through a separately authenticated upload.
It then sends only its small metadata reference in normal durable batches. An
upload must be acknowledged before that reference is published. Upload failures
do not delay worker or usage ingestion. One artwork request at a time is admitted
on a hub; assets are stored outside the public web root. Immutable image and
selection-manifest files are retained without eviction. A selection-change event
also enters the normal durable history and archive path. Existing usage custody,
cursors, receipts and retention rules are unchanged. Artwork files are local hub
data, not claimed to be part of the usage-segment NAS archive.

Only authenticated full-fleet administrators can request artwork. Collector
credentials cannot view it; viewer credentials cannot upload it. Disabled or
expired sources are refused. Each read is bound to the current host and content
hash, with authority checked again after asynchronous work. Public release files
contain no personal images or desktop identifiers.

The existing account refresh provides selection references; the browser fetches
the image separately once per selected hash. It verifies the image checksum and
dimensions before showing it. Signing out clears the displayed asset and revokes
its blob URL. Where several desktops report artwork, the most recently observed
selection is shown with its desktop name. It is desktop identity, not a claim
that every administrator owns that Dot. A browser-local manual fallback remains
optional. Animation follows existing worker-presence and reduced-motion controls;
there is no new animation loop or telemetry polling timer.

## Voice: identified source, external subscription unavailable

The inspected desktop build maintains a voice coordinator with connection phase,
activity, microphone-mute and output-mute state. Those are the correct source
signals. The verified external app-server and app-tools interfaces do not expose
an observer subscription to that coordinator. A newly spawned app-server is a
separate process and is not an attachment to the desktop's existing call.

Consequently this release does not claim live voice integration. It does not
enable call recording, scrape transcripts, capture audio, infer mute from silence,
patch the desktop, or expose a remote-debugging port. The dashboard reports voice
state as unavailable. The next dependency is a supported read-only desktop
subscription or provider-approved bridge exposing only metadata, scoped to its
owning account and conversation. Until that exists, a synthetic switchboard or
worker heartbeat cannot satisfy the acceptance criteria.

When that source is available, qualification must demonstrate start/active/end,
user and assistant speaking, microphone mute and output mute separately, silent
connected periods, transfer between conversations, feed loss, stale/unknown
state, restart and account changes. No call may be fabricated for a test result.

References: [ChatGPT Voice](https://learn.chatgpt.com/docs/features/voice) and
[Codex App Server](https://learn.chatgpt.com/docs/app-server). Official voice
availability is distinct from an external observation API.
