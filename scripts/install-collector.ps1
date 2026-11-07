# Author: Bishop Crockett
# Owner: Argellan.com
# License: MIT
# SPDX-License-Identifier: MIT
# Attribution covers ARGELLAN-authored implementation and modifications only.
# Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
[CmdletBinding()]
param(
    [string]$EnrollmentConfig,
    [string]$ExpectedOrigin,
    [string]$ExpectedInstanceId,
    [string]$ExpectedHostname,
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'ARGELLAN\Codex-Control-Collector'),
    [string]$NodePath,
    [string]$CaFile,
    [switch]$StartAtLogon,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
function Set-PrivateCollectorDirectory {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions','',Justification='Mandatory internal credential-protection step; skipping it with WhatIf would let installation continue without private permissions.')]
    param([Parameter(Mandatory=$true)][string]$Path)
    if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Collector destination must be an ordinary directory.' }
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $allowed = @($owner.Value, 'S-1-5-18') | Select-Object -Unique
    # A new DACL removes explicit grants too. /inheritance:r and /grant:r alone
    # leave unrelated explicit principals able to read newly written credentials.
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($owner)
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($sid in $allowed) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
    $verified = Get-Acl -LiteralPath $Path
    $rules = @($verified.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
    if (-not $verified.AreAccessRulesProtected -or $verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value -or $rules.Count -ne $allowed.Count) { throw 'Private collector permissions could not be verified.' }
    foreach ($rule in $rules) {
        if ($rule.IdentityReference.Value -notin $allowed -or $rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne 'ContainerInherit,ObjectInherit' -or $rule.PropagationFlags -ne 'None') { throw 'Unexpected collector access rule; no configuration has been written.' }
    }
}
$destinationRoot = [System.IO.Path]::GetFullPath($Destination)
$runnerPath = Join-Path $destinationRoot 'supervise.ps1'
$digest = [System.Security.Cryptography.SHA256]::Create()
try { $taskSuffix = ([BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($destinationRoot.ToLowerInvariant())))).Replace('-','').Substring(0,12) } finally { $digest.Dispose() }
$taskName = 'ARGELLAN Codex Control Collector ' + $taskSuffix
$taskArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $runnerPath + '"'
if ($Uninstall) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        if ($task.Actions.Count -ne 1 -or $task.Actions[0].Arguments -cne $taskArguments -or [IO.Path]::GetFileName($task.Actions[0].Execute) -ine 'powershell.exe') { throw 'Task action does not match this collector; refusing to stop or remove it.' }
        Stop-ScheduledTask -TaskName $taskName
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    Write-Output 'Owned collector login task removed. Application, configuration, logs and pending outbox are preserved.'
    return
}
if (-not $EnrollmentConfig -or -not $ExpectedOrigin -or -not $ExpectedInstanceId -or -not $ExpectedHostname) { throw 'Supply EnrollmentConfig, ExpectedOrigin, ExpectedInstanceId and ExpectedHostname from a trusted enrollment channel.' }
if (-not $NodePath) { $runtime = Get-Command node -ErrorAction Stop; $NodePath = $runtime.Source }
if ([int](& $NodePath -p 'Number(process.versions.node.split(".")[0])') -lt 24) { throw 'Install an independently verified Node.js 24 runtime first.' }
$actualHostname = (& $NodePath -p 'require("node:os").hostname()').Trim()
if ($actualHostname -ine $ExpectedHostname) { throw 'This enrollment is for a different machine. No credential has been read or sent.' }
$sourceRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $sourceRoot 'RELEASE_MANIFEST.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'Install from a verified sanitized candidate containing RELEASE_MANIFEST.json.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if (-not $manifest.finalRuntime -or $manifest.status -cne 'READY_FOR_REVIEW_NOT_PUBLISHED') { throw 'Provisional runtime cannot be installed by this helper.' }
foreach ($record in $manifest.files) {
    if ($record.path -match '(^[/\\]|(^|[/\\])\.\.([/\\]|$)|^[A-Za-z]:)') { throw 'Invalid candidate checksum path.' }
    $candidatePath = [IO.Path]::GetFullPath((Join-Path $sourceRoot $record.path))
    if (-not $candidatePath.StartsWith($sourceRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Candidate path escapes application.' }
    if ((Get-FileHash -LiteralPath $candidatePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $record.sha256) { throw 'Candidate checksum mismatch before enrollment identity probe.' }
}
$allowlist = Get-Content -LiteralPath (Join-Path $sourceRoot 'release\runtime-files.json') -Raw | ConvertFrom-Json
$probeArguments = @((Join-Path $sourceRoot 'scripts\setup-instance.mjs'), ('--verify-origin=' + $ExpectedOrigin), ('--expected-instance-id=' + $ExpectedInstanceId), ('--expected-hostname=' + $ExpectedHostname))
if ($CaFile) { $probeArguments += '--ca-file=' + [IO.Path]::GetFullPath($CaFile) }
& $NodePath @probeArguments | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Expected endpoint identity or TLS verification failed. No enrollment credential has been read or sent.' }
# Credential loading is intentionally after the unauthenticated identity probe.
$config = Get-Content -LiteralPath $EnrollmentConfig -Raw | ConvertFrom-Json
if ($config.url.TrimEnd('/') -cne $ExpectedOrigin.TrimEnd('/') -or $config.expectedInstanceId -cne $ExpectedInstanceId -or $config.expectedHostname -ine $ExpectedHostname) { throw 'Enrollment does not match the independently confirmed origin, instance and machine.' }
if ($config.hostId -notmatch '^[a-z0-9][a-z0-9-]{0,63}$' -or -not $config.token -or $config.token.Length -lt 32) { throw 'Invalid per-host enrollment.' }
if ((Test-Path -LiteralPath $destinationRoot) -and (Get-ChildItem -LiteralPath $destinationRoot -Force | Select-Object -First 1)) { throw 'Destination is not empty. Preserve it and use an explicit update instead of enrolling twice.' }
foreach ($relative in $allowlist.runtime) {
    $sourcePath = [IO.Path]::GetFullPath((Join-Path $sourceRoot $relative))
    if (-not $sourcePath.StartsWith($sourceRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime path escapes candidate.' }
    $record = @($manifest.files | Where-Object { $_.path -ceq $relative })
    if ($record.Count -ne 1 -or (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $record[0].sha256) { throw 'Candidate runtime checksum mismatch.' }
}
New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
Set-PrivateCollectorDirectory -Path $destinationRoot
$application = Join-Path $destinationRoot 'app'
foreach ($relative in $allowlist.runtime) { $target = [IO.Path]::GetFullPath((Join-Path $application $relative)); if (-not $target.StartsWith($application + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime target escapes collector application.' }; New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null; Copy-Item -LiteralPath (Join-Path $sourceRoot $relative) -Destination $target; $record = @($manifest.files | Where-Object { $_.path -ceq $relative }); if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $record[0].sha256) { throw 'Installed runtime checksum mismatch.' } }
if ($CaFile) { $localCa = Join-Path $destinationRoot 'ca.crt'; Copy-Item -LiteralPath $CaFile -Destination $localCa; $config | Add-Member -NotePropertyName caFile -NotePropertyValue $localCa -Force } elseif ($config.caFile) { throw 'Supply the collector-local trusted CA using -CaFile; hub filesystem paths are not portable.' }
$configPath = Join-Path $destinationRoot 'collector.json'
[IO.File]::WriteAllText($configPath,($config | ConvertTo-Json -Depth 10),(New-Object Text.UTF8Encoding($false)))
$runner = @'
$ErrorActionPreference = 'Stop'
$guard = New-Object Threading.Mutex($false,'Local\ARGELLAN-CodexControl-__SUFFIX__')
if (-not $guard.WaitOne(0)) { exit }
try { while ($true) { $process = Start-Process -FilePath '__NODE__' -ArgumentList @('"__APP__\collector.mjs"','"__ROOT__\collector.json"') -WorkingDirectory '__APP__' -WindowStyle Hidden -PassThru -RedirectStandardOutput '__ROOT__\collector.log' -RedirectStandardError '__ROOT__\collector-error.log'; $process.WaitForExit(); Start-Sleep -Seconds 5 } } finally { $guard.ReleaseMutex(); $guard.Dispose() }
'@
$runner = $runner.Replace('__SUFFIX__',$taskSuffix).Replace('__NODE__',$NodePath.Replace("'","''")).Replace('__APP__',$application.Replace("'","''")).Replace('__ROOT__',$destinationRoot.Replace("'","''"))
[IO.File]::WriteAllText($runnerPath,$runner,(New-Object Text.UTF8Encoding($false)))
& $NodePath (Join-Path $application 'collector.mjs') $configPath --once
if ($LASTEXITCODE -ne 0) { throw 'Initial collection was not acknowledged. Private configuration/outbox remain available for diagnosis; no login task was installed.' }
if ($StartAtLogon) {
    $action = New-ScheduledTaskAction -Execute powershell.exe -Argument $taskArguments
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
    $principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Read-only enrolled Codex source; independently verified endpoint identity' | Out-Null
    Start-ScheduledTask -TaskName $taskName
}
Write-Output 'Collector initial batch acknowledged. Credentials remain in the private destination; no provider credentials were requested.'
