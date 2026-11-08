// Author: Bishop Crockett; Owner: Argellan.com; License: MIT; SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {HistoryJournal} from '../lib/history.mjs';
import {JournalWriter} from '../lib/journal-writer.mjs';
import {normalizeProcessSamples,processDigest} from '../lib/process-history.mjs';
const owner={hostIds:null,projectIds:null};
const frame=(sequence=1)=>({epoch:'11111111-1111-4111-8111-111111111111',snapshot:{schemaVersion:1,sourceKind:'local-os',hostId:'alpha',bootId:'boot',sequence,observedAt:new Date(Date.now()-1000+sequence).toISOString(),cores:8,collection:{status:'ok',complete:true,scope:'test'},processes:[{pid:42,parentPid:1,createdAt:'2026-01-01T00:00:00Z',executable:'node.exe',role:'Node.js runtime',family:'Codex',metricStatus:'ok',privateCommitBytes:1000,workingSetBytes:500,cpuTimeMs:20,ioBytes:0}]}});
async function fixture(t,storageAdmission={}){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'argellan-process-'));t.after(async()=>{const base=await fs.realpath(os.tmpdir()),target=await fs.realpath(directory);assert.ok(target.startsWith(base+path.sep));await fs.rm(target,{recursive:true,force:true});});return HistoryJournal.open({directory,storageAdmission:{freeBytes:0,freeFraction:0,workingBytes:0,...storageAdmission}});}
const args=s=>({hostId:'alpha',state:{sessions:[]},processSamples:s});
test('Same SQLite transaction preserves exact versions, duplicates and restart reads',async t=>{let j=await fixture(t);const f=frame();const a=j.commit(args([f]));assert.equal(a.processes.added,1);assert.equal(j.commit(args([f])).processes.duplicates,1);j=await HistoryJournal.open({directory:path.dirname(j.file)});const r=j.processRead(owner,new URLSearchParams('host=alpha&mode=history'),['alpha']);assert.equal(r.retained.n,1);assert.equal(r.observations[0].digest,processDigest(normalizeProcessSamples([f],'alpha')[0]));});
test('Conflicting sequence rolls back state and does not replace original version',async t=>{const j=await fixture(t),f=frame();j.commit(args([f]));const changed=structuredClone(f);changed.snapshot.processes[0].privateCommitBytes=9000;assert.throws(()=>j.commit({...args([changed]),state:{replacement:true}}),{status:409});assert.equal(j.state('alpha').replacement,undefined);assert.equal(j.processRead(owner,new URLSearchParams('host=alpha&mode=history'),['alpha']).retained.n,1);});
test('Older arrivals retained without displacing newest observed projection; bounded history',async t=>{const j=await fixture(t),f=frame(2);j.commit(args([f]));const old=frame(1);old.snapshot.observedAt='2020-01-01T00:00:00Z';j.commit(args([old]));const r=j.processRead(owner,new URLSearchParams('host=alpha'),['alpha']);assert.equal(r.rows[0].privateCommitBytes,1000);assert.equal(r.retained.n,2);assert.equal(r.archive.evictionAllowed,false);});
test('a search with no matches still reports the selected host observation coverage',async t=>{const j=await fixture(t);j.commit(args([frame()]));const result=j.processRead(owner,new URLSearchParams('host=alpha&q=does-not-exist'),['alpha']);assert.equal(result.total,0);assert.equal(result.summary.processes,0);assert.equal(result.hostCoverage[0].hostId,'alpha');assert.equal(result.hostCoverage[0].status,'ok');});
test('Host scopes and project scope fail closed; no raw denied metadata',async t=>{const j=await fixture(t);j.commit(args([frame()]));assert.throws(()=>j.processRead({hostIds:['beta'],projectIds:null},new URLSearchParams('host=alpha'),['alpha']),{status:403});assert.throws(()=>j.processRead({hostIds:null,projectIds:['secret']},new URLSearchParams('host=alpha'),['alpha']),{status:403});assert.throws(()=>j.processRead(owner,new URLSearchParams('host=alpha&task=guess'),['alpha']),{status:409});});
test('Raw command fields and cross-host samples rejected before durable acceptance',async t=>{const j=await fixture(t),f=frame();f.snapshot.processes[0].commandLine='--token private';assert.throws(()=>j.commit(args([f])),/Unsupported process field/);assert.equal(j.state('alpha'),null);assert.throws(()=>normalizeProcessSamples([frame()],'beta'),/provenance/);});
test('Process custody participates in source admission and preserves old data on pressure',async t=>{const j=await fixture(t,{sourceBytes:1});assert.throws(()=>j.commit(args([frame()])),e=>e.code==='STORAGE_BACKPRESSURE'&&e.journalOutcome==='rolled-back');assert.equal(j.state('alpha'),null);assert.equal(j.processRead(owner,new URLSearchParams('host=alpha&mode=history'),['alpha']).retained.n,0);});
test('Bounded writer acknowledges only committed process receipt',async t=>{const j=await fixture(t),writer=new JournalWriter(j);try{const r=await writer.commit(JSON.stringify(args([frame()])),j.storageAdmission);assert.equal(r.processes.added,1);assert.equal(j.processRead(owner,new URLSearchParams('host=alpha'),['alpha']).total,1);}finally{await writer.close();}});

test('Collector epoch restart preserves newest same-boot projection',async t=>{const j=await fixture(t),a=frame(500);a.snapshot.observedAt='2026-01-01T00:00:00Z';j.commit(args([a]));const b=frame(1);b.epoch='22222222-2222-4222-8222-222222222222';b.snapshot.processes[0].privateCommitBytes=2000;j.commit(args([b]));assert.equal(j.processRead(owner,new URLSearchParams('host=alpha'),['alpha']).rows[0].privateCommitBytes,2000);});

test('Byte/count/page boundaries reject intake without changing durable versions',async t=>{
 const j=await fixture(t),f=frame();j.commit(args([f]));
 assert.throws(()=>normalizeProcessSamples([f,f],'alpha'),{status:413});
 const large=frame(2);large.snapshot.processes=Array.from({length:4000},(_,i)=>({...f.snapshot.processes[0],pid:i+1}));assert.throws(()=>j.commit(args([large])),{status:413});
 assert.equal(j.processRead(owner,new URLSearchParams('host=alpha&mode=history'),['alpha']).retained.n,1);
 for(const query of ['limit=0','limit=101','offset=-1','offset=10001','mode=history&before=nope'])assert.throws(()=>j.processRead(owner,new URLSearchParams('host=alpha&'+query),['alpha']),{status:400});
 assert.equal(j.processRead(owner,new URLSearchParams('host=beta'),['beta']).summary.processes,null);
});

test('New source pressure rolls back new sample while retaining previously committed custody',async t=>{
 const j=await fixture(t);j.commit(args([frame()]));j.storageAdmission.sourceBytes=1;
 assert.throws(()=>j.commit(args([frame(2)])),e=>e.code==='STORAGE_BACKPRESSURE');
 assert.equal(j.processRead(owner,new URLSearchParams('host=alpha&mode=history'),['alpha']).retained.n,1);
});


test('Retained totals upgrade preserves every version and polling uses indexed bounded reads',async t=>{
 let j=await fixture(t);j.commit(args([frame()]));j.commit(args([frame(2)]));const before=j.processRead(owner,new URLSearchParams('host=alpha&mode=history'),['alpha']);
 j.database(db=>db.exec('DROP TRIGGER process_totals_insert; DROP TABLE process_totals'));
 j=await HistoryJournal.open({directory:path.dirname(j.file)});const after=j.processRead(owner,new URLSearchParams('host=alpha&mode=history'),['alpha']);assert.deepEqual(after,before);
 j.commit(args([frame(3)]));assert.equal(j.processRead(owner,new URLSearchParams('host=alpha'),['alpha']).retained.n,3);
 const plan=j.database(db=>db.prepare('EXPLAIN QUERY PLAN SELECT sequence,payload FROM process_observations WHERE host_id=? ORDER BY observed_ms DESC,sequence DESC LIMIT 3').all('alpha'));assert.ok(plan.some(r=>r.detail.includes('process_host_time')));assert.ok(plan.every(r=>!r.detail.includes('TEMP B-TREE')));
});
