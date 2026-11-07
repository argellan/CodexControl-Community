import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeQualificationBudget} from './fixtures/native-qualification-budget.mjs';
import {ControlError} from '../lib/errors.mjs';
function fixture(){let at=1800000000000;const gate=createNativeQualificationBudget({now:()=>at,startedAtMs:at}),sample={stage:'PREPARE',remaining:48,resetAt:1800500000,observedAtMs:at};return {gate,sample,advance:n=>{at+=n;}};}
for(const [name,change]of [
  ['missing remaining',s=>{delete s.remaining;}],['string remaining',s=>{s.remaining='unknown';}],['NaN remaining',s=>{s.remaining=NaN;}],['infinite remaining',s=>{s.remaining=Infinity;}],['negative quota',s=>{s.remaining=-1;}],['quota above100',s=>{s.remaining=101;}],
  ['missing reset',s=>{delete s.resetAt;}],['invalid reset',s=>{s.resetAt='1793382063';}],['expired reset',s=>{s.resetAt=1;}],['future observation',s=>{s.observedAtMs++;}],['stale observation',s=>{s.observedAtMs-=90001;}],['missing observation',s=>{delete s.observedAtMs;}],['unknown stage',s=>{s.stage='ANY';}]
])test('native quota gate latches on '+name,()=>{const {gate,sample}=fixture(),bad={...sample};change(bad);assert.throws(()=>gate.observe(bad),e=>e instanceof ControlError);assert.equal(gate.status().stopped,true);assert.throws(()=>gate.observe(sample),e=>e instanceof ControlError);});
test('unavailable authoritative usage is a latched stop',()=>{const {gate,sample}=fixture();assert.throws(()=>gate.unavailable());assert.throws(()=>gate.observe(sample));});
test('one percentage point and changed reset stop even at an old waiting stage',()=>{for(const update of [{remaining:47},{resetAt:1800500001}]){const {gate,sample}=fixture();gate.observe(sample);assert.throws(()=>gate.observe({...sample,...update}));}});
test('floor and hard duration bound remain independent of stage permission',()=>{const low=fixture();assert.throws(()=>low.gate.observe({...low.sample,remaining:4}));const timed=fixture();timed.gate.observe(timed.sample);timed.advance(600000);assert.throws(()=>timed.gate.observe({...timed.sample,observedAtMs:timed.sample.observedAtMs+600000}));});
test('valid observations preserve baseline across all permitted stages',()=>{const {gate,sample}=fixture();for(const stage of ['PREPARE','LAUNCH_CREATE','TURN_STEER_INTERRUPT','STOP_RELAUNCH_RESUME','FOLLOWUP'])assert.equal(gate.observe({...sample,stage}).baselineRemaining,48);assert.equal(gate.status().stopped,false);});
test('malicious observation getter is never called',()=>{const {gate,sample}=fixture();let called=0;Object.defineProperty(sample,'remaining',{enumerable:true,get(){called++;return 48;}});assert.throws(()=>gate.observe(sample));assert.equal(called,0);});


test('approved time extension preserves the original quota baseline instead of rebaselining',()=>{const at=1800000000000,gate=createNativeQualificationBudget({now:()=>at,startedAtMs:at,initialBaseline:47,initialResetAt:1800500000});assert.throws(()=>gate.observe({stage:'PREPARE',remaining:46,resetAt:1800500000,observedAtMs:at}));assert.equal(gate.status().reason,'QUOTA_BOUND');});

test('explicit45minute five-point window preserves baseline until the fixed boundary',()=>{
 let at=1800000000000;const gate=createNativeQualificationBudget({now:()=>at,startedAtMs:at,durationMs:2700000,quotaPoints:5,initialBaseline:98,initialResetAt:1800500000});
 const sample=remaining=>({stage:'PREPARE',remaining,resetAt:1800500000,observedAtMs:at});
 assert.equal(gate.observe(sample(98)).baselineRemaining,98);at+=600001;
 assert.equal(gate.observe(sample(94)).baselineRemaining,98);
 assert.throws(()=>gate.observe(sample(93)));assert.equal(gate.status().reason,'QUOTA_BOUND');
});
test('explicit45minute deadline expires independently of quota',()=>{
 let at=1800000000000;const gate=createNativeQualificationBudget({now:()=>at,startedAtMs:at,durationMs:2700000,quotaPoints:5,initialBaseline:98,initialResetAt:1800500000});
 gate.observe({stage:'PREPARE',remaining:98,resetAt:1800500000,observedAtMs:at});at+=2700000;
 assert.throws(()=>gate.observe({stage:'PREPARE',remaining:98,resetAt:1800500000,observedAtMs:at}));assert.equal(gate.status().reason,'DURATION_BOUND');
});
test('same-epoch replenishment cannot silently resume a window',()=>{
 const at=1800000000000,gate=createNativeQualificationBudget({now:()=>at,startedAtMs:at,quotaPoints:5,initialBaseline:98,initialResetAt:1800500000});
 gate.observe({stage:'PREPARE',remaining:97,resetAt:1800500000,observedAtMs:at});
 assert.throws(()=>gate.observe({stage:'PREPARE',remaining:98,resetAt:1800500000,observedAtMs:at}));assert.equal(gate.status().reason,'REPLENISHMENT');
});
test('extended allowance remains explicitly bounded to45minutes and5points',()=>{
 for(const change of [{durationMs:2700001},{quotaPoints:6},{quotaPoints:0},{quotaPoints:1.5}])assert.throws(()=>createNativeQualificationBudget(change));
});