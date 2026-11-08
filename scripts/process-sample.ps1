# Author: Bishop Crockett; Owner: Argellan.com; License: MIT; SPDX-License-Identifier: MIT
param([int]$Sequence=1)
$ErrorActionPreference='Stop'
$timer=[Diagnostics.Stopwatch]::StartNew()
$selfProcess=[Diagnostics.Process]::GetCurrentProcess()
$initialCpu=$selfProcess.TotalProcessorTime.TotalMilliseconds
$rows=Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name,CommandLine,SessionId,ReadTransferCount,WriteTransferCount -OperationTimeoutSec 10
$os=Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime,FreePhysicalMemory -OperationTimeoutSec 10
$all=@{};foreach($r in $rows){$all[[int]$r.ProcessId]=$r}
$procMap=@{};foreach($processObject in [Diagnostics.Process]::GetProcesses()){$procMap[$processObject.Id]=$processObject}
$chosen=[Collections.Generic.HashSet[int]]::new()
foreach($r in $rows){if($r.Name -match '^(node|codex|chatgpt)(\.exe)?$'){[void]$chosen.Add([int]$r.ProcessId)}}
for($pass=0;$pass -lt 16;$pass++){$changed=$false;foreach($r in $rows){if($chosen.Contains([int]$r.ParentProcessId)-and !$chosen.Contains([int]$r.ProcessId)){[void]$chosen.Add([int]$r.ProcessId);$changed=$true}};if(!$changed){break}}
$output=[Collections.Generic.List[object]]::new();$denied=0;$identityMissing=0
foreach($r in $rows){
 if(!$chosen.Contains([int]$r.ProcessId)){continue}
 if(!$r.CreationDate){$identityMissing++;continue}
 $role='Other executable';$family='Other';$basis='name';$command=[string]$r.CommandLine
 if($r.Name -match '^codex'){$family='Codex';$role='Desktop application';if($command -match '\bapp-server\b'){$role='Codex app-server';$basis='local-allowlist'}}
 elseif($r.Name -match '^chatgpt'){$family='ChatGPT';$role='Desktop application'}
 elseif($r.Name -eq 'node.exe'){
  $role='Node.js runtime';$family='Node.js / unattributed'
  if($command -match '\bmcp\b|modelcontextprotocol'){$role='MCP tool server candidate';$basis='local-allowlist'}
  elseif($command -match '\bplaywright\b|\bvitest\b|--test(?:\s|$)'){$role='Test runner candidate';$basis='local-allowlist'}
  elseif($command -match '\bvite\b|\bwebpack\b|\bnext\b'){$role='Development server candidate';$basis='local-allowlist'}
  elseif($command -match '\bcollector\.mjs\b'){$role='Collector / observer';$basis='local-allowlist'}
 }
 elseif($r.Name -match 'chrome|msedge'){$role='Browser helper';$family='Browser'}
 elseif($r.Name -match 'pwsh|powershell|cmd\.exe|python'){$role='Shell / launcher'}
 $ancestor=$r;$seen=[Collections.Generic.HashSet[int]]::new()
 for($level=0;$level -lt 32;$level++){
  if(!$seen.Add([int]$ancestor.ProcessId)){break}
  $parent=$all[[int]$ancestor.ParentProcessId]
  if(!$parent -or !$parent.CreationDate -or $parent.CreationDate -gt $ancestor.CreationDate){break}
  if($parent.Name -match '^codex'){$family='Codex';break};if($parent.Name -match '^chatgpt'){$family='ChatGPT';break};$ancestor=$parent
 }
 $commit=$null;$working=$null;$cpu=$null;$metricStatus='partial';$proc=$null
 try{
  $proc=$procMap[[int]$r.ProcessId];if(!$proc){throw [System.ArgumentException]::new('Process exited during enumeration')}
  if([Math]::Abs(($proc.StartTime.ToUniversalTime()-$r.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1){$metricStatus='vanished'}
  else{$commit=$proc.PrivateMemorySize64;$working=$proc.WorkingSet64;$cpu=$proc.TotalProcessorTime.TotalMilliseconds;$metricStatus='ok'}
 }catch [System.ArgumentException]{$metricStatus='vanished'}catch{$metricStatus='denied';$denied++}
 $safeName=if($r.Name -match '^[a-zA-Z0-9_.-]{1,64}$'){$r.Name}else{'unknown.exe'}
 $output.Add([ordered]@{pid=[int]$r.ProcessId;parentPid=[int]$r.ParentProcessId;createdAt=$r.CreationDate.ToUniversalTime().ToString('o');executable=$safeName;role=$role;family=$family;roleBasis=$basis;sessionId=[int]$r.SessionId;privateCommitBytes=$commit;workingSetBytes=$working;cpuTimeMs=$cpu;ioBytes=if($metricStatus -eq 'ok'){[double]$r.ReadTransferCount+[double]$r.WriteTransferCount}else{$null};metricStatus=$metricStatus})
 # The command line is used only for fixed role predicates, never emitted or saved.
 $command=$null
}
$selfProcess.Refresh();$timer.Stop()
foreach($processObject in $procMap.Values){$processObject.Dispose()}
[ordered]@{schemaVersion=1;sourceKind='local-os';hostId='local-workstation';bootId=$os.LastBootUpTime.ToUniversalTime().ToString('o');sequence=$Sequence;observedAt=[DateTime]::UtcNow.ToString('o');cores=[Environment]::ProcessorCount;availableRamBytes=[double]$os.FreePhysicalMemory*1024;collection=@{status=if($denied -or $identityMissing){'partial'}else{'ok'};complete=(!$denied -and !$identityMissing);scope='codex-chatgpt-node-and-descendants-v1';denied=$denied;enumerated=$rows.Count};processes=@($output.ToArray());overhead=@{elapsedMs=$timer.Elapsed.TotalMilliseconds;samplerCpuMs=$selfProcess.TotalProcessorTime.TotalMilliseconds-$initialCpu;samplerWorkingSetBytes=$selfProcess.WorkingSet64;samplerPeakWorkingSetBytes=$selfProcess.PeakWorkingSet64;identityMissing=$identityMissing}} | ConvertTo-Json -Depth 7 -Compress
$selfProcess.Dispose()
