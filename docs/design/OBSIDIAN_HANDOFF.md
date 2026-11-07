# Reviewed Obsidian handoff
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

Open Handoff in the dashboard header. The selection freezes synchronously from the current authorized event window, including Live or Replay and its current host/project/event/search/worker filters. No additional source content is collected. At most 1000 events from a bounded 5000-candidate browser selection are exported; the packet declares selected/exported counts, truncation, known gap count and that complete history is not established.

The preview contains allowlisted event kinds, categories, source outcomes, bounded durations, day-level dates, packet-local host/worker aliases and per-event SHA-256 fingerprints. Original names, IDs, project labels, prompts, arguments, raw outputs, private reasoning, paths, source labels, account data and credentials are excluded. Fingerprints cover selected allowlisted metadata and its source identities/timing; they do not authenticate excluded source content. Aliases are not guaranteed anonymization: dates, counts and activity patterns may identify a workflow.

Optionally enter a plain-text reviewer summary of at most 2000 characters. It is included in the downloaded Markdown as literal text, so review its contents for the intended recipient. Review confirmation stays disabled until the preview is ready; editing the summary resets it. The application checks current viewer and source permissions before preparing a preview and again before downloading it. Expired, revoked, changed, failed or unavailable access requires sign-in, refresh and a new review. It does not offer an offline cached-export fallback.

The ZIP has exactly three fixed relative filenames:

| File | Purpose |
| --- | --- |
| CodexControl-Handoff.md | Obsidian-compatible note, scope, reviewer narrative, activity summary, observation table and limitations |
| observations.json | Frozen sanitized metadata projection and per-event fingerprints |
| manifest.json | Application version, snapshot hash, exact file lengths/SHA-256, coverage and preview-confirmation fact |

The manifest records outcomesIndependentlyVerified:false. Preview confirmation is a release review, not worker acceptance, verification of source claims or cryptographic publisher identity. SHA-256 checks integrity, not source trust.

Extract each packet into a NEW uniquely named folder; review all three files, then copy that folder into the chosen Obsidian vault and open CodexControl-Handoff.md. Do not overwrite an earlier packet. Obsidian's official Markdown import instructions describe copying files/folders into a vault: https://obsidian.md/help/import/markdown . This release uses standard Markdown files; it adds no Obsidian plugin, vault watcher, protocol launcher or automatic synchronization. No actual user vault is accessed or modified by CodexControl.

The handoff is a bounded reviewed handoff of captured observations. It is not a full archive export, raw conversation export, artifact/file-content export or task-control interface. Rich independently reviewed artifact packages remain a separate future capability. Full captured usage continues following the existing durable archive contract.
