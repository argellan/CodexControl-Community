#Requires -Version 7.4
# Author: Bishop Crockett
# Owner: Argellan.com
# License: MIT
# SPDX-License-Identifier: MIT
# Attribution covers ARGELLAN-authored implementation and modifications only.
# Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
param([string]$AnalyzerPath)
$ErrorActionPreference = 'Stop'
if ($AnalyzerPath) {
    Import-Module -Name (Resolve-Path -LiteralPath $AnalyzerPath).Path -ErrorAction Stop
} else {
    Import-Module -FullyQualifiedName @{ ModuleName = 'PSScriptAnalyzer'; RequiredVersion = '1.25.0' } -ErrorAction Stop
}
$problems = @(
    Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File -Recurse |
        ForEach-Object { Invoke-ScriptAnalyzer -Path $_.FullName -Severity Error,Warning }
)
foreach ($problem in $problems) {
    Write-Output ('{0}:{1} {2}: {3}' -f $problem.ScriptName,$problem.Line,$problem.RuleName,$problem.Message)
}
Write-Output ('PowerShell lint: {0} issue(s)' -f $problems.Count)
if ($problems.Count) { exit 1 }
