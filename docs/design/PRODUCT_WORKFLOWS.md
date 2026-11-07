# Product workflows and customization
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

CodexControl separates observing work, personal presentation, and administering
an installation. A viewer's observation filters are never a dispatch target.
Administration permissions do not imply permission to control a Codex runtime.

## Settings center

Open Settings in the header. The center groups controls by the job they serve:

| Group | Destinations | Scope |
| --- | --- | --- |
| Start here | Overview and setup checks | Saved configuration and observed status, with unknowns explicit |
| Your workspace | Appearance; Layouts & panels; Map & motion; Clocks & wall display; Attention | Your authenticated presentation profile |
| Administration | Hosts & enrollment; Accounts & permissions; Collection; History & archive; Instance & network | Installation policy and explicitly authorized identities |
| Operations | Diagnostics; Change history; Backup & recovery; Control capability information | Protected on-demand inspection and supported administrative actions |

Search finds tasks as well as individual settings. Small windows use a section
picker instead of requiring a sideways menu. A section change preserves a draft;
closing with unsaved changes asks whether to keep editing or discard it. Saving
uses independent profile and installation revisions. A conflict keeps the
remaining draft for review rather than silently overwriting another tab.

Personal display changes follow the authenticated viewer. Shared access keys
share one profile; individual accounts have independent profiles. Named layouts
store presentation choices, including density, panes and motion. They deliberately
exclude host, project and event filters. A new dashboard starts with the live,
all-source observation scope, independently of saved presentation choices.

## Accounts and access

An administrator can inspect accounts, create or edit an identity, assign
host/project scopes and expiration, rotate an access key, manage password sign-in,
or revoke access. Scope choices use recognizable observed names alongside stable
identities. A selected identity that is no longer observed must remain visible
for review; it must not disappear and accidentally broaden access.

An empty selected scope grants no access in that dimension. All hosts/projects
is an explicit choice. Administrative API checks remain authoritative even if a
client changes or fabricates controls. Existing last-administrator protections
remain in place. Password changes clear secrets and require sign-in again.
Credential downloads are private, short-lived and available once; ordinary
inventory, diagnostics and audit responses never contain those credentials.

## Machine enrollment and collection

Machine identity, enrollment, installation and observed activity are different
states. Issuing a package does not install a collector. A valid enrollment with
no heartbeat is not a fresh connected source. A heartbeat does not establish an
active model turn or account-wide collection completeness.

Use the expected physical hostname when enrolling a source. Install its private
package on that machine and verify the intended instance and TLS identity.
Preferred and alternate addresses describe interfaces for one machine identity;
they do not create separate machines. Source paths belong to the owning machine.
An execution target need not run Codex and must not be presented as a Codex
session host merely because it executes an offloaded command.

The collection view distinguishes saved source policy, enrolled credentials,
and observed freshness, gaps and capture limits. Runtime/parser compatibility
that a source has not reported remains unknown. No screen automatically discovers
private accounts, installs collectors or expands collection scope.

## History, archive and recovery

Event replay uses the local bounded event journal. Full captured usage versions
have a separate permanent archival contract. Event-cache budgets and usage
hot-cache targets must not be presented as one retention setting.

The administrator's diagnostics read existing archive custody metadata on demand:
pending versions, verified receipts, last success and error state. A receipt
count is not an independent verification of every NAS file, a restore test or a
claim of complete provider/account coverage. Missing archive service leaves
pending captured usage protected on the local disk. Only a verified receipt for
the exact current usage record version permits its hot-cache eviction.

Private backup creation and managed restore staging retain their existing
validation and revision checks. Staging a restore does not restart the service
or prove a successful recovery. Updates and restarts use the documented managed
procedure; unavailable operations must never be represented by working-looking
buttons that silently do nothing.

## Diagnostics and audit

Health summaries describe the observer process, its local journal and enrolled
sources. The first CPU/loop reading can be unknown because a measurement interval
does not exist yet. Host resource totals do not identify a worker's resource use.
Exact metadata remains available for investigation without making raw JSON the
primary navigation experience.

Configuration and administration audit streams have explicit source labels and
timestamps. No records loaded, a failed read and a confirmed empty result are
different states. Diagnostics, inventory and audit are fetched only when their
workflow needs them or the operator requests refresh; the center adds no
continuous polling to the live observation plane.

## Planned capability boundaries

Saved observation scopes/pins, a richer personal attention worklist, and native
control are distinct additions. Existing named layouts and alert quieting must
not be advertised as equivalent to those unfinished capabilities. Optional
control requires its own host/project grants, version-qualified native interfaces,
host-local credentials, separate content policy and durable operation recovery.
An observation-only installation remains useful with control entirely absent.
There is no claim of arbitrary attachment to active desktop sessions or access
to a private first-party relay. Experimental dependencies must retain their
qualification label instead of being marketed as supported production APIs.


## V1 workspace and reviewed handoff

The header keeps Live, History, Handoff, Alerts, Usage and Settings together. Attention, source-gap notices and Collection & evidence are on-demand inside Alerts; there is no permanent right rail. The Observation Plane fills the released width. Its default map/timeline share is 72%, supported range 32-88%; existing saved profiles are preserved. CODEX CONTROL sits beneath the approved ARGELLAN wordmark.

Handoff freezes the currently filtered event window, including replay. A preview-ready review checkbox and a fresh authorization check are required before a local three-file Obsidian packet is downloaded. Summary edits reset review. No vault is accessed automatically. See OBSIDIAN_HANDOFF.md for privacy, source integrity and completeness limits. Profile links to the illustrated User Manual and Interface Atlas PDFs.
