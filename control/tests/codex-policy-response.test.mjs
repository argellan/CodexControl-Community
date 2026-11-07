import test from 'node:test';
import assert from 'node:assert/strict';
import * as compatibility from '../providers/codex/compatibility.mjs';
const {CODEX_LIFECYCLE_PIN,assertNativePolicy}=compatibility;
function setup(){
 const metadata={...CODEX_LIFECYCLE_PIN,model:'gpt-6.1-sol',effort:'high',serviceTier:'default',accountBinding:'TEST_ONLY_ACCOUNT'};
 const profile={assertCurrent:()=>metadata},root={directory:'TEST_ONLY_ROOT'};
 const params={cwd:root.directory,model:metadata.model,modelProvider:'openai',approvalPolicy:'never',approvalsReviewer:'user',sandbox:'read-only',serviceTier:'default',config:{model_reasoning_effort:'high',project_doc_max_bytes:0},baseInstructions:'TEST_ONLY',developerInstructions:'TEST_ONLY',ephemeral:false};
 const result={model:metadata.model,modelProvider:'openai',reasoningEffort:'high',serviceTier:null,cwd:root.directory,approvalPolicy:'never',approvalsReviewer:'user',instructionSources:[],sandbox:{type:'readOnly',networkAccess:false}};
 const bind=()=>{assert.equal(typeof compatibility.bindNativeSessionPolicy,'function');return compatibility.bindNativeSessionPolicy(profile,root,params);};
 return {metadata,profile,root,params,result,bind};
}
test('explicit default request binding accepts pinned nullable tier and preserves unknown observation',()=>{const h=setup(),proof=h.bind(),policy=assertNativePolicy(h.result,h.profile,h.root,proof);assert.equal(policy.serviceTier,null);assert.equal(policy.requestedServiceTier,'default');assert.equal(Object.isFrozen(h.params),true);assert.equal(Object.isFrozen(h.params.config),true);});
test('nullable tier without recognized binding remains refused',()=>{const h=setup();assert.throws(()=>assertNativePolicy(h.result,h.profile,h.root));assert.throws(()=>assertNativePolicy(h.result,h.profile,h.root,{}));});
test('request proof cannot be reused',()=>{const h=setup(),proof=h.bind();assertNativePolicy(h.result,h.profile,h.root,proof);assert.throws(()=>assertNativePolicy(h.result,h.profile,h.root,proof));});
test('proof is bound to profile and project identity',()=>{for(const key of ['profile','root']){const h=setup(),other=setup(),proof=h.bind();assert.throws(()=>assertNativePolicy(h.result,key==='profile'?other.profile:h.profile,key==='root'?other.root:h.root,proof));}});
test('instruction sources remain forbidden even with valid default request proof',()=>{const h=setup(),proof=h.bind();assert.throws(()=>assertNativePolicy({...h.result,instructionSources:['TEST_ONLY_GLOBAL_AGENTS']},h.profile,h.root,proof));});
test('fast or missing tier is never normalized to default',()=>{for(const tier of ['fast','priority','flex','auto',undefined]){const h=setup(),proof=h.bind();assert.throws(()=>assertNativePolicy({...h.result,serviceTier:tier},h.profile,h.root,proof));}});
test('binding rejects expanded requested policy or document byte allowance',()=>{for(const mutate of [h=>{h.params.serviceTier='fast';},h=>{h.params.config.project_doc_max_bytes=1;},h=>{h.params.sandbox='workspace-write';},h=>{h.params.model='OTHER';}]){const h=setup();mutate(h);assert.equal(typeof compatibility.bindNativeSessionPolicy,'function');assert.throws(()=>compatibility.bindNativeSessionPolicy(h.profile,h.root,h.params));}});
test('binding refuses profile drift or a different pinned schema',()=>{for(const field of ['accountBinding','schemaSha256','instructionBinding']){const h=setup(),proof=h.bind();h.metadata[field]='CHANGED';assert.throws(()=>assertNativePolicy(h.result,h.profile,h.root,proof));}});
test('explicit Extra High request is bound and cannot silently downgrade',()=>{
 const h=setup();h.metadata.effort='xhigh';h.params.config.model_reasoning_effort='xhigh';h.result.reasoningEffort='xhigh';const proof=h.bind();assert.equal(assertNativePolicy(h.result,h.profile,h.root,proof).effort,'xhigh');
 const changed=setup(),bound=changed.bind();changed.metadata.effort='xhigh';changed.result.reasoningEffort='xhigh';assert.throws(()=>assertNativePolicy(changed.result,changed.profile,changed.root,bound));
});