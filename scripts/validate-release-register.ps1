#Requires -Version 7.4
# Author: Bishop Crockett
# Owner: Argellan.com
# License: MIT
# SPDX-License-Identifier: MIT
# Attribution covers ARGELLAN-authored implementation and modifications only.
# Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
param(
 [Parameter(Mandatory=$true)][string]$RegisterPath,
 [string]$SchemaPath=(Join-Path $PSScriptRoot '../docs/release/release-register.schema.json')
)
# Maintainer-only data validation. Never executes a recorded command, uploads evidence,
# contacts a remote, changes the product or grants authority.
$ErrorActionPreference='Stop'
try {
 $raw=Get-Content -LiteralPath $RegisterPath -Raw
 if(-not (Test-Json -Json $raw -SchemaFile $SchemaPath -ErrorAction Stop)){throw 'JSON Schema validation failed'}
 $r=$raw | ConvertFrom-Json -Depth 100
 $problems=[System.Collections.Generic.List[string]]::new()
 $cm=@{};$em=@{};$fm=@{}
 foreach($set in @(@{label='check';items=$r.checks;map=$cm},@{label='evidence';items=$r.evidence;map=$em},@{label='finding';items=$r.findings;map=$fm})){
  foreach($item in $set.items){
   if($set.map.ContainsKey($item.id)){$problems.Add("Duplicate $($set.label) ID")}
   else{$set.map[$item.id]=$item}
  }
 }
 function Refs($refs,$map,$where){foreach($ref in $refs){if(-not $map.ContainsKey($ref)){$problems.Add("$where has a missing reference")}}}
 function Kind($ref,$expected,$where){
  if(-not $ref -or -not $em.ContainsKey($ref) -or $em[$ref].kind -cne $expected){$problems.Add("$where lacks $expected evidence")}
 }
 function SameSet($left,$right){
  $a=@($left|Sort-Object -Unique);$b=@($right|Sort-Object -Unique)
  return ($a.Count -eq $b.Count -and @($a|Where-Object {$_ -cnotin $b}).Count -eq 0)
 }
 foreach($action in $r.authority.allowed_actions){
  if($r.authority.forbidden_actions -ccontains $action){$problems.Add('Contradictory action authority')}
 }
 Kind $r.authority.evidence_ref 'OWNER_AUTHORITY' 'Authority'
 if($r.execution_settings.exception_authority){Kind $r.execution_settings.exception_authority 'OWNER_AUTHORITY' 'Settings exception'}
 if($r.execution_settings.verification_state -eq 'VERIFIED' -and -not $r.execution_settings.observed){$problems.Add('Verified settings lack observed metadata')}
 foreach($c in $r.checks){
  Refs $c.evidence_refs $em $c.id; Refs $c.finding_refs $fm $c.id
  if($c.replacement_check_id){
   Refs @($c.replacement_check_id) $cm $c.id
   if($c.replacement_check_id -ceq $c.id){$problems.Add('Check replaces itself')}
  }
  if($c.status -eq 'PASS'){
   if($c.invalidated_by.Count){$problems.Add('PASS check is invalidated')}
   if($c.method_kind -ne 'OWNER_DECISION'){
    foreach($key in @('commit','tree','dirty_state','dirty_manifest_ref','artifact_sha256','version','local_identity_verified')){
     if($c.candidate_identity.$key -cne $r.candidate.$key){$problems.Add("PASS candidate $key differs")}
    }
   }
   foreach($ref in $c.finding_refs){if($fm.ContainsKey($ref) -and $fm[$ref].state -eq 'OPEN'){$problems.Add('PASS check links an open finding')}}
  }
 }
 foreach($f in $r.findings){
  Refs $f.check_refs $cm $f.id; Refs $f.closure_evidence_refs $em $f.id
  if($f.state -eq 'RISK_ACCEPTED'){
   if($f.unwaivable -or $f.accepted_by -cne $r.authority.owner){$problems.Add('Invalid risk acceptance')}
   Kind $f.acceptance_authority_ref 'OWNER_AUTHORITY' 'Risk acceptance'
  }
 }
 Refs $r.decision.open_blocker_ids $fm 'Open blockers';Refs $r.decision.accepted_risk_ids $fm 'Accepted risks'
 $open=@($r.findings|Where-Object {$_.blocker -and $_.state -eq 'OPEN'}|ForEach-Object {$_.id})
 $accepted=@($r.findings|Where-Object {$_.state -eq 'RISK_ACCEPTED'}|ForEach-Object {$_.id})
 if(-not (SameSet $open $r.decision.open_blocker_ids)){$problems.Add('Open blocker summary differs from findings')}
 if(-not (SameSet $accepted $r.decision.accepted_risk_ids)){$problems.Add('Accepted risk summary differs from findings')}
 foreach($ref in @($r.approval.evidence_ref,$r.preservation.manifest_evidence_ref,$r.preservation.restore_evidence_ref,$r.candidate.dirty_manifest_ref)){if($ref){Refs @($ref) $em 'Approval/preservation/identity'}}
 Refs $r.remote.evidence_refs $em 'Remote'
 foreach($ci in $r.remote.required_ci){if($ci.evidence_ref){Refs @($ci.evidence_ref) $em 'CI'}}
 $ready=$r.decision.state -in @('READY_FOR_PUSH_REVIEW','READY_WITH_ACCEPTED_RISK','PUSHED_PENDING_VERIFICATION','REMOTE_VERIFIED')
 if($r.scope.research_only -and $r.decision.state -ne 'RESEARCH_ONLY'){$problems.Add('Research-only scope cannot claim release execution')}
 if($ready){
  foreach($stage in (0..15|ForEach-Object {'G{0:D2}' -f $_})){
   if(@($r.checks|Where-Object {$_.stage_id -eq $stage -and $_.mandatory -and $_.phase -eq 'QUALIFICATION'}).Count -eq 0){$problems.Add("Required qualification stage $stage absent")}
  }
  if(-not $r.plan.frozen){$problems.Add('Readiness requires a frozen plan')}
  if(-not $r.candidate.local_identity_verified -or -not $r.candidate.commit -or -not $r.candidate.tree -or $r.candidate.dirty_state -ne 'CLEAN' -or $r.candidate.dirty_manifest_ref -or -not $r.candidate.artifact_sha256 -or -not $r.candidate.version){$problems.Add('Readiness lacks a clean verified source/tree/artifact/version')}
  if($r.scope.expected_visibility -eq 'UNKNOWN'){$problems.Add('Readiness lacks expected visibility')}
  if($r.preservation.state -in @('NOT_DONE','TRANSFER_UNCONFIRMED') -or -not $r.preservation.manifest_evidence_ref){$problems.Add('Readiness lacks verified preservation')}
  Kind $r.preservation.restore_evidence_ref 'RESTORE_RECEIPT' 'Preservation restore'
  if($r.plan.ci_policy -eq 'UNDETERMINED' -or ($r.plan.ci_policy -eq 'REQUIRED' -and $r.plan.required_ci_names.Count -eq 0) -or ($r.plan.ci_policy -eq 'NONE_JUSTIFIED' -and $r.plan.required_ci_names.Count)){$problems.Add('CI policy unresolved or contradictory')}
  if($r.execution_settings.verification_state -eq 'UNKNOWN' -and -not $r.execution_settings.exception_authority){$problems.Add('Unknown settings need an actual owner exception')}
  foreach($c in $r.checks|Where-Object {$_.mandatory -and $_.phase -eq 'QUALIFICATION'}){
   if($c.applicability -eq 'UNDETERMINED'){$problems.Add('Mandatory applicability unknown')}
   if($c.applicability -eq 'NOT_APPLICABLE'){
    if($c.evidence_refs.Count -eq 0){$problems.Add('N/A check lacks evidence')}
    if($c.invalidated_by.Count){$problems.Add('N/A check has invalidated evidence')}
    continue
   }
   if($c.status -ne 'PASS'){
    $linked=@($c.finding_refs|ForEach-Object {$fm[$_]})
    if($c.hard_gate -or $c.status -ne 'FAIL' -or $linked.Count -eq 0 -or @($linked|Where-Object {$null -eq $_ -or $_.state -ne 'RISK_ACCEPTED' -or $_.unwaivable}).Count){$problems.Add('Mandatory gate unresolved')}
   }
  }
  if($open.Count){$problems.Add('Open release blocker')}
  if($r.decision.state -eq 'READY_FOR_PUSH_REVIEW' -and $accepted.Count){$problems.Add('Accepted risks require an explicit risk decision state')}
  if($r.decision.state -eq 'READY_WITH_ACCEPTED_RISK' -and -not $accepted.Count){$problems.Add('Risk decision has no accepted risk')}
  if($r.remote.state -eq 'UNCERTAIN'){$problems.Add('Uncertain push requires reconciliation before readiness')}
 }
 if($r.approval.state -eq 'APPROVED'){
  Kind $r.approval.evidence_ref 'OWNER_AUTHORITY' 'Approval'
  if($r.approval.owner -cne $r.authority.owner){$problems.Add('Approval owner differs')}
  if($r.scope.research_only -or -not $r.candidate.local_identity_verified -or $r.candidate.dirty_state -ne 'CLEAN'){$problems.Add('Approval lacks a releasable execution candidate')}
  if(-not $r.approval.expected_old_sha -or -not $r.candidate.commit -or $r.approval.approved_new_sha -cne $r.candidate.commit -or $r.approval.repository -cne $r.scope.repository -or $r.approval.target_ref -cne $r.scope.target_ref){$problems.Add('Approval tuple differs or lacks expected old SHA')}
  if(-not $r.candidate.artifact_sha256 -or $r.candidate.artifact_sha256 -cnotin $r.approval.artifact_sha256s){$problems.Add('Approved artifact missing')}
  if(-not $r.approval.actions.Count){$problems.Add('Approval has no action')}
  foreach($action in $r.approval.actions){
   if($action -cnotin $r.authority.allowed_actions -or $action -cin $r.authority.forbidden_actions){$problems.Add('Approved action outside authority')}
  }
 }
 if($r.remote.state -in @('PUSHED_PENDING_VERIFICATION','VERIFIED') -or $r.decision.state -in @('PUSHED_PENDING_VERIFICATION','REMOTE_VERIFIED')){
  if(-not $ready -or $r.approval.state -ne 'APPROVED' -or 'push' -cnotin $r.approval.actions){$problems.Add('Push state lacks approved qualified push')}
 }
 if(($r.remote.state -eq 'PUSHED_PENDING_VERIFICATION') -ne ($r.decision.state -eq 'PUSHED_PENDING_VERIFICATION')){$problems.Add('Pending push states differ')}
 if($r.decision.state -eq 'REMOTE_VERIFIED' -or $r.remote.state -eq 'VERIFIED'){
  if($r.decision.state -ne 'REMOTE_VERIFIED' -or $r.remote.state -ne 'VERIFIED' -or $r.remote.observed_sha -cne $r.candidate.commit -or -not $r.remote.evidence_refs.Count -or $r.remote.observed_visibility -eq 'UNKNOWN' -or $r.remote.observed_visibility -cne $r.scope.expected_visibility){$problems.Add('Remote identity/visibility/evidence inconsistent')}
  foreach($ref in $r.remote.evidence_refs){Kind $ref 'REMOTE_RECEIPT' 'Remote verification'}
  if($r.plan.ci_policy -eq 'REQUIRED'){foreach($name in $r.plan.required_ci_names){
   $ci=@($r.remote.required_ci|Where-Object {$_.name -ceq $name})
   if($ci.Count -ne 1){$problems.Add('CI lacks a unique current result')}
   elseif($ci[0].sha -cne $r.candidate.commit -or $ci[0].conclusion -ne 'SUCCESS' -or $ci[0].run_attempt -lt 1 -or -not $ci[0].evidence_ref){$problems.Add('CI lacks current success evidence')}
  }}
 }
 if($problems.Count){
  [pscustomobject]@{schema='PASS';semantic='FAIL';errors=@($problems);notice='No recorded command or remote action was executed.'}|ConvertTo-Json
  exit 1
 }
 [pscustomobject]@{schema='PASS';semantic='PASS';decision=$r.decision.state;checks=$r.checks.Count;notice='Record consistency only. Evidence authenticity, product qualification and authority require independent review.'}|ConvertTo-Json
} catch {
 # Do not echo register content, evidence paths, owner names or tool exception text.
 [Console]::Error.WriteLine('Release register rejected: schema or semantic inconsistency. Review the register against docs/release/README.md.')
 exit 1
}
