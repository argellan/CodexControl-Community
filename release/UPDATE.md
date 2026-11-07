# Community 0.1.0 native Windows preview

The native installer creates only a NEW application/private instance and refuses existing state. Keep existing apps/data. Supported application update/forward-recovery still requires a performance-qualified compatible target through setup-instance.mjs; no older authority snapshot or private registry is substituted. The following retained historical instructions describe the existing generic seams and are not a claim that Community upgrade/rollback has been qualified.

<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->
## 1.1.0: optional GitHub metadata

Upgrade the archive receiver before activating the optional GitHub source. Existing usage families and data stay unchanged. See [GitHub integration](docs/design/GITHUB_INTEGRATION.md) for secure enrollment, scope, V3 archives and backup requirements. This feature does not activate without private administrator configuration.

# Update and rollback

Version 1.0.1 is a code-only maintenance update with no history or usage schema change. It refuses credentialed collector delivery to an unpinned hub, requires protected TLS private-key files, corrects scoped event metadata, and retains all unarchived event rows beyond hot-cache targets. The Windows read-only query client also allows bounded extra time for a cold PowerShell ACL check while retaining fail-closed behavior. Existing collectors need a pinned `expectedInstanceId`; preserve their outboxes and cursors while updating. This does not add an off-host event archive or recover event rows already expired by older builds.

Version 1.0.0 added reviewed handoff, illustrated guides and workspace refinements.

Do not roll back to V1.0.0 while relying on preservation of unarchived events: that build can evict them at its age, row or byte thresholds. Keep the new local event rows and a verified backup before any recovery decision.
Personal names and avatars are stored as owner-only `.account.json` files inside
the existing private display-preferences directory. Include that directory in
private instance backups. Photos, names and imported sprites are excluded from
release packages. Imported Codex sprites stay in this browser's IndexedDB for
the signed-in account and origin; they are not shared across devices.

1. Verify the new candidate's provenance, manifest and checksums, then extract it into a **new versioned application directory**. Do not overwrite the running app or copy private instance data into the candidate. Run `node scripts/community-doctor.mjs` from the new directory for bounded, redacted local checks; it does not prove an installation or database migration.
2. Create and verify a supported managed backup while the hub is healthy. That backup covers sanitized configuration and a coherent history/usage/custody SQLite snapshot; it does not replace a separate private backup of users, password/security registries, collector credentials, external TLS or archive keys/configuration. Stop only the owned Codex Control process/service and archive sender before an offline full-instance copy. Preserve any external local data directory as well. Never copy only the main file of a live WAL-mode database.
3. For a V2 upgrade, deploy and verify the dual-version archive receiver **before enabling V2 source sending**. Qualify unchanged V1 retry, V2 and mixed batches, durable receipt verification, lost-ACK recovery and receiver restart/query behavior. Leave existing segments, in-flight bodies, ordered item IDs and receipts intact. If no receiver is configured, new samples remain pending locally; monitor disk/backlog rather than deleting them.
4. Use the new application's existing setup helper to update the installation pointer. It saves the previous pointer and does not recreate credentials, change users, reset retention, rotate the event epoch or migrate a running database:

   ```sh
   node scripts/setup-instance.mjs --update-app=ABSOLUTE_NEW_APPLICATION_DIRECTORY --instance-dir=ABSOLUTE_EXISTING_INSTANCE_DIRECTORY
   ```

   On Windows, arguments containing spaces must be individually quoted. For the instance created by INSTALL.md, from the new application directory:

   ```powershell
   $instanceDirectory = Join-Path $env:LOCALAPPDATA 'ARGELLAN\CodexControl\instance'
   $newApplicationDirectory = (Get-Location).Path
   node .\scripts\setup-instance.mjs "--update-app=$newApplicationDirectory" "--instance-dir=$instanceDirectory"
   node (Join-Path $instanceDirectory 'start.mjs')
   ```

5. Start the existing private launcher. Startup adds V2 tables/indexes/triggers transactionally while preserving the five V1 source schemas and canonical bytes. Update enrolled collectors using their existing private identities and outboxes; stop only each owned collector while replacing its application files. Preserve V2 pending envelopes and `.usage-cursor.json` checkpoints together. Do not rerun first-time enrollment over an installed collector.
6. Confirm the same instance identity, users/passwords, viewer scopes, settings/retention policy, normal event epoch and retained history. Check live source ages, numeric capture backlog, source-role/fork exclusions, receiver health and exact version custody. Refresh/replay must not relaunch old animation. A started process or a green local doctor does not establish operational acceptance.

## Rollback and recovery

Use an application build that understands the current database and archive record versions. A pre-V2 application is **not a supported code-only rollback** once `usage_samples_v2` exists. Never drop the new tables, alter old canonical rows or clear pending/in-flight custody to make an older binary start. Retain the previous app and verified backups until acceptance.

Observer0.20 also installs the additive `storage_admission_sources` version1
table and accounting triggers without rewriting captured source rows. Use a
build that understands this schema for backup, restore and admission enforcement;
older builds may reject its managed snapshots and do not enforce the new source
allowance. A downgrade below0.20 is not a supported full-featured rollback after
this migration. Preserve the accounting objects with the journal; do not remove
them to make an older validator accept a backup. Legacy snapshots without these
objects remain readable and receive the additive migration when opened by0.20.

If the previous build supports the current data format, stop the owned instance and use that build's `setup-instance.mjs --update-app=... --instance-dir=...` to select it through the same reviewed pointer-update path. Do not rerun initial setup. A pointer change alone does not downgrade stored data.

An actual data rollback uses the supported verified offline restore procedure with a matching backup. Preserve current security/password registries and an independent copy of all newer data first. Current usage bootstrap and pending/in-flight archive records must be fully durably accounted for before replacement; an archive-custody refusal is a preservation guard. Repair/drain the archive and reconcile evidence rather than bypassing it. Supported restore may establish a new recovery generation; it must not masquerade as uninterrupted live history. See [archive compatibility](docs/design/USAGE_ARCHIVE.md).

Older verified V1 backups remain readable: their original manifest and bytes are checked before migration of a candidate copy. Partial or unknown schemas are refused. Normal updates preserve history, user identity, event epoch and retention settings; aggregates remain projections over preserved source observations. Generated checksums are unsigned and do not establish publisher identity.
# Security closeout compatibility

Update the archive receiver before the hub/collectors when applying this release.
The receiver now accepts the complete canonical ECMAScript account-timestamp
range. Existing immutable batches retry with their original bytes and identities;
do not clear pending batches or rewrite captured observations to unblock a retry.

Updated collectors bind each event's project at its source context. A later
working-directory change no longer relabels older events. Project-scoped viewers
receive only events carrying this binding. Older unqualified event records remain
intact for fleet/host viewers; their historical project cannot be reconstructed
reliably from a current session summary. Upgrade collectors to restore qualified
new-event visibility for project-scoped viewers. No historical records are deleted
or silently rewritten by this update.

Windows collector enrollment replaces and verifies the destination DACL before
writing configuration. It removes unrelated explicit grants as well as inherited
grants. This enrollment helper still refuses an occupied destination; use the
documented update procedure for an existing collector.

