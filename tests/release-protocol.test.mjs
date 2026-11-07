// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildCandidate,validateMappedReleaseDocuments} from '../scripts/package-release.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const example=JSON.parse(await fs.readFile(path.join(root,'docs/release/release-register.example.json'),'utf8'));
const pwsh=process.env.CODEXCONTROL_TEST_PWSH||'pwsh';
const probe=spawnSync(pwsh,['-NoProfile','-Command','if($PSVersionTable.PSVersion -lt [version]"7.4"){exit 1}'],{encoding:'utf8',timeout:10000,windowsHide:true});
const unavailable=probe.status!==0?'PowerShell 7.4+ is required for maintainer register validation':false;
async function fixture(run){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cc-protocol-TEST_ONLY-'));
 try{return await run(directory);}finally{
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('cc-protocol-TEST_ONLY-'));
  await fs.rm(directory,{force:true,recursive:true});
 }
}
function ready(){
 const r=structuredClone(example);r.scope.research_only=false;r.scope.expected_visibility='private';r.plan.frozen=true;
 r.plan.ci_policy='NONE_JUSTIFIED';r.plan.required_ci_names=[];r.plan.ci_policy_reason='TEST_ONLY no remote CI';
 r.authority.allowed_actions=['read','push'];r.authority.forbidden_actions=['deploy','publish'];
 r.execution_settings.verification_state='VERIFIED';r.execution_settings.observed='TEST_ONLY fixture metadata';
 r.candidate={commit:'a'.repeat(40),tree:'b'.repeat(40),dirty_state:'CLEAN',dirty_manifest_ref:null,artifact_sha256:'c'.repeat(64),artifact_path:'TEST_ONLY.zip',version:'1.2.0',local_identity_verified:true};
 const add=(id,kind)=>r.evidence.push({...structuredClone(r.evidence[0]),id,kind,path_or_url:'TEST_ONLY synthetic receipt'});
 add('E-RESULT','REPORT');add('E-MANIFEST','MANIFEST');add('E-RESTORE','RESTORE_RECEIPT');add('E-REMOTE','REMOTE_RECEIPT');
 for(const c of r.checks){c.candidate_identity=structuredClone(r.candidate);if(c.phase==='QUALIFICATION'){c.status='PASS';c.actual='TEST_ONLY expected observation';c.observed_at=r.created_at;c.evidence_refs=['E-RESULT'];}}
 r.preservation={state:'LOCAL_ONLY',checkpoint_id:'TEST_ONLY',private_location:'TEST_ONLY',manifest_evidence_ref:'E-MANIFEST',restore_evidence_ref:'E-RESTORE',exclusions:['No production state']};
 r.decision.state='READY_FOR_PUSH_REVIEW';return r;
}
function approved(){const r=ready();r.approval={state:'APPROVED',owner:r.authority.owner,evidence_ref:'E-AUTH',repository:r.scope.repository,target_ref:r.scope.target_ref,expected_old_sha:'d'.repeat(40),approved_new_sha:r.candidate.commit,artifact_sha256s:[r.candidate.artifact_sha256],actions:['push']};return r;}
function remote(){const r=approved();r.remote.state='VERIFIED';r.remote.observed_sha=r.candidate.commit;r.remote.observed_visibility='private';r.remote.evidence_refs=['E-REMOTE'];r.decision.state='REMOTE_VERIFIED';r.plan.ci_policy='REQUIRED';r.plan.required_ci_names=['TEST_ONLY CI'];r.remote.required_ci=[{name:'TEST_ONLY CI',sha:r.candidate.commit,run_attempt:1,conclusion:'SUCCESS',evidence_ref:'E-RESULT'}];return r;}
async function validate(r,directory){
 const file=path.join(directory,'register.json');await fs.writeFile(file,JSON.stringify(r));
 return spawnSync(pwsh,['-NoProfile','-File',path.join(root,'scripts/validate-release-register.ps1'),'-RegisterPath',file],{encoding:'utf8',timeout:15000,windowsHide:true});
}
const cases=[
 ['research example remains NOT_RUN and not approved',()=>structuredClone(example),true],
 ['complete synthetic readiness record',ready,true],
 ['exact approved candidate',approved,true],
 ['exact remote and required CI',remote,true],
 ['research cannot become readiness',()=>({...ready(),scope:example.scope}),false],
 ['missing qualification stage',()=>{const r=ready();r.checks=r.checks.filter(c=>c.stage_id!=='G11');return r;},false],
 ['wrong stage ID',()=>{const r=ready();r.checks[0].stage_id='G99';return r;},false],
 ['stale PASS',()=>{const r=ready();r.checks[1].invalidated_by=['changed source'];return r;},false],
 ['stale N/A justification',()=>{const r=ready();Object.assign(r.checks[1],{applicability:'NOT_APPLICABLE',status:'NOT_RUN',invalidated_by:['changed feature scope']});return r;},false],
 ['changed tree with same commit',()=>{const r=ready();r.checks[1].candidate_identity.tree='e'.repeat(40);return r;},false],
 ['changed artifact',()=>{const r=ready();r.checks[1].candidate_identity.artifact_sha256='e'.repeat(64);return r;},false],
 ['dirty candidate',()=>{const r=ready();r.candidate.dirty_state='DIRTY_RECORDED';return r;},false],
 ['missing restore evidence',()=>{const r=ready();r.preservation.restore_evidence_ref='E-RESULT';return r;},false],
 ['unknown settings without exception',()=>{const r=ready();r.execution_settings.verification_state='UNKNOWN';r.execution_settings.observed=null;return r;},false],
 ['owner exception must have authority kind',()=>{const r=ready();r.execution_settings.verification_state='UNKNOWN';r.execution_settings.exception_authority='E-RESULT';return r;},false],
 ['missing reference',()=>{const r=ready();r.checks[0].evidence_refs=['missing'];return r;},false],
 ['duplicate evidence',()=>{const r=ready();r.evidence.push(r.evidence[0]);return r;},false],
 ['unlisted open blocker',()=>{const r=ready();r.findings=[{id:'F1',title:'TEST_ONLY',check_refs:[],impact:'TEST_ONLY',likelihood:'TEST_ONLY',preconditions:'TEST_ONLY',confidence:'STATIC_REVIEW',release_scope:'TEST_ONLY',blocker:true,unwaivable:true,owner:'TEST_ONLY',exit_test:'TEST_ONLY',state:'OPEN',closure_evidence_refs:[],accepted_by:null,acceptance_authority_ref:null,acceptance_expiry_or_trigger:null,compensating_controls:[]}];return r;},false],
 ['forbidden approved action',()=>{const r=approved();r.approval.actions.push('deploy');return r;},false],
 ['contradictory authority',()=>{const r=ready();r.authority.forbidden_actions.push('push');return r;},false],
 ['approval on wrong repository',()=>{const r=approved();r.approval.repository='example/other';return r;},false],
 ['approval missing expected old SHA',()=>{const r=approved();r.approval.expected_old_sha=null;return r;},false],
 ['wrong approved artifact',()=>{const r=approved();r.approval.artifact_sha256s=['e'.repeat(64)];return r;},false],
 ['unapproved remote success',()=>{const r=remote();r.approval.state='NOT_REQUESTED';return r;},false],
 ['wrong visibility',()=>{const r=remote();r.remote.observed_visibility='public';return r;},false],
 ['wrong SHA CI',()=>{const r=remote();r.remote.required_ci[0].sha='e'.repeat(40);return r;},false],
 ['failed CI',()=>{const r=remote();r.remote.required_ci[0].conclusion='FAILURE';return r;},false],
 ['duplicate CI',()=>{const r=remote();r.remote.required_ci.push(r.remote.required_ci[0]);return r;},false],
 ['unknown schema version',()=>({...ready(),schema_version:'1.0'}),false],
 ['recorded commands never execute',()=>{const r=ready();r.checks[0].procedure='throw TEST_ONLY must remain data';return r;},true],
];
for(const [name,make,pass] of cases)test(name,{skip:unavailable},()=>fixture(async directory=>{
 const result=await validate(make(),directory);assert.equal(result.error,undefined);assert.equal(result.status,pass?0:1,result.stdout+result.stderr);
 if(pass){const output=JSON.parse(result.stdout);assert.equal(output.semantic,'PASS');assert.match(output.notice,/consistency/i);}
}));

test('package refuses mapped stale docs and version conflicts before creating a candidate',()=>fixture(async directory=>{
 const documents={'release/STATUS.md':'RELEASE_STATUS.md','release/CHECKPOINT.md':'docs/CHECKPOINT.md'};
 for(const name of ['release','public','docs'])await fs.mkdir(path.join(directory,name));
 const write=(name,text)=>fs.writeFile(path.join(directory,name),text);
 await write('release/STATUS.md','# Status\n\nVersion 1.0.1 is TEST_ONLY\n');
 await write('RELEASE_STATUS.md','# Status\n\nVersion 1.2.0 is TEST_ONLY\n');
 await write('release/CHECKPOINT.md','TEST_ONLY old checkpoint');await write('docs/CHECKPOINT.md','TEST_ONLY current checkpoint');
 await write('public/build-info.mjs',"export const APPLICATION_VERSION='1.2.0';export const APPLICATION_LABEL='1.2.0';");
 const manifest={schemaVersion:1,runtime:['public/build-info.mjs'],support:[],documents};
 const destination=path.join(directory,'candidate');
 await assert.rejects(buildCandidate({sourceRoot:directory,destination,manifest,finalRuntime:true}),/document drift/);
 await assert.rejects(fs.stat(destination),{code:'ENOENT'});
 await write('release/STATUS.md',await fs.readFile(path.join(directory,'RELEASE_STATUS.md')));
 await assert.rejects(validateMappedReleaseDocuments(directory,documents),/document drift/);
 await write('release/CHECKPOINT.md','TEST_ONLY current checkpoint');
 await write('public/build-info.mjs',"export const APPLICATION_VERSION='1.0.1';export const APPLICATION_LABEL='1.0.1';");
 await assert.rejects(validateMappedReleaseDocuments(directory,documents),/versions differ/);
 await write('public/build-info.mjs',"export const APPLICATION_VERSION='1.2.0';export const APPLICATION_LABEL='1.2.0';");
 const receipt=await buildCandidate({sourceRoot:directory,destination,manifest,finalRuntime:true});assert.equal(receipt.missing.length,0);
 assert.equal(await fs.readFile(path.join(destination,'docs/CHECKPOINT.md'),'utf8'),'TEST_ONLY current checkpoint');
}));
