# Uninstall without destroying evidence
<!--
Author: Bishop Crockett
Owner: Argellan.com
License: MIT
SPDX-License-Identifier: MIT
Attribution covers ARGELLAN-authored implementation and modifications only.
Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
-->

Stop and remove the service or scheduled task you installed for this instance. The generic Windows collector helper supports -Uninstall with the same -Destination; it verifies that the scheduled task action points to that collector before stopping/removing it. Other instances and tasks are not selected by name alone.

For the generic Windows collector, from the verified application directory, removal of its owned login task is:

```powershell
.\scripts\install-collector.ps1 -Uninstall -Destination (Join-Path $env:LOCALAPPDATA 'ARGELLAN\Codex-Control-Collector')
```

This leaves the collector application, enrollment, logs, pending batch and numeric source cursor intact. A foreground single-computer instance can be stopped with Ctrl+C in its own terminal. A Linux service must be disabled/removed using the exact unit you created; no generic command selects another worker or service by a similar name.

Archive the private configuration, users/password registry, audit/settings stores, history, collector outboxes/source cursors and necessary TLS/archive material. Verify exports/backups and any pending usage custody before decommissioning storage. Preserve NAS immutable segments and the receiver catalog/keys separately; stopping the hub does not revoke or erase them. Revoke the selected collector/viewer enrollment at the authoritative hub. Remove the application directory manually only after confirming its exact versioned path is no longer running and contains no private instance data.

No supplied helper recursively deletes private instance directories, histories, certificates or user data. Data destruction is a separate, explicit operator action. Removing this dashboard does not uninstall Codex or stop Codex workers. Node and your certificate trust configuration remain under your control.

## Optional destruction of the default Windows private instance

**This is irreversible and is not part of normal uninstall.** Use it only after verifying independent exports/backups and resolving pending archive custody. It applies only to the exact default instance created by INSTALL.md. It does not remove an external data directory, archive destination, receiver volume, certificate store or another user's instance. Review those separately.

The following PowerShell block verifies the absolute default path and refuses symbolic links/junctions before deleting anything. A second explicit typed phrase is required. Do not replace its target with a drive root or a computed list of paths.

```powershell
$approvedParent = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'ARGELLAN\CodexControl')).TrimEnd('\')
$instanceToDelete = [IO.Path]::GetFullPath((Join-Path $approvedParent 'instance')).TrimEnd('\')
if ([IO.Path]::GetDirectoryName($instanceToDelete) -cne $approvedParent -or [IO.Path]::GetFileName($instanceToDelete) -cne 'instance') { throw 'Exact private instance path required.' }
$walkPath = $instanceToDelete
while ($walkPath -and $walkPath -ne [IO.Path]::GetPathRoot($walkPath)) {
    $item = Get-Item -LiteralPath $walkPath -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Link or junction refused.' }
    $walkPath = [IO.Path]::GetDirectoryName($walkPath)
}
if (-not (Test-Path -LiteralPath (Join-Path $instanceToDelete 'installation.json') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $instanceToDelete 'hub.json') -PathType Leaf)) { throw 'Expected private instance metadata is missing.' }
$linkedChildren = @(Get-ChildItem -LiteralPath $instanceToDelete -Recurse -Force -ErrorAction Stop | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 })
if ($linkedChildren.Count) { throw 'Linked content refused; review manually.' }
$destructionPhrase = Read-Host 'Type DELETE PRIVATE CODEXCONTROL DATA after verifying backups and stopped services'
if ($destructionPhrase -cne 'DELETE PRIVATE CODEXCONTROL DATA') { throw 'Nothing deleted.' }
Remove-Item -LiteralPath $instanceToDelete -Recurse -Force -ErrorAction Stop
```

No destructive Linux/macOS helper is supplied. Preserve the private instance by default and review any separate deletion against its resolved absolute path and storage/backup inventory.
