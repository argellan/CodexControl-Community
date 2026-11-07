// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// TEST_ONLY child harness; each case has a fresh process and disposable store.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {FleetHub} from '../../lib/fleet.mjs';
import {JournalWriter} from '../../lib/journal-writer.mjs';
import crypto from 'node:crypto';
const directory=process.env.TEST_ONLY_JOURNAL_DIRECTORY,fault=process.env.TEST_ONLY_JOURNAL_FAULT,token='TEST_ONLY-token';
const hub=await FleetHub.open({directory,hosts:[{id:'test-source',tokenHash:crypto.createHash('sha256').update(token).digest('hex')}]});
const release=hub.retainJournalWriter(),keeper=hub.journal.retainConnection();
const payload=id=>({hostId:'test-source',batchId:id,observedAt:new Date().toISOString(),sessions:[],events:[{id,sessionId:'test-session',at:new Date().toISOString(),kind:'operation',...(fault==='native-full'?{label:'x'.repeat(240)}:{})}]});
let result={fault};
try{
 if(fault==='missing-ack')hub.writer=new JournalWriter(hub.journal,{timeoutMs:250});
 const first=payload('first');if(fault==='native-full')first.events=Array.from({length:500},(_,i)=>({...first.events[0],id:'full-'+i}));
 if(fault==='parent-exit'){
  await hub.ingest(token,first);await hub.ingest(token,payload('second'));
  const third=payload('unacknowledged');await fs.writeFile(path.join(directory,'TEST_ONLY-replay.json'),JSON.stringify(third));void hub.ingest(token,third);
  process.stdout.write(JSON.stringify({acknowledged:['test-source:first','test-source:second']}),()=>process.kill(process.pid,'SIGKILL'));
  await new Promise(()=>{});
 }else if(fault==='slow-commit'){
  let acknowledged=false,ticked=false;const pending=hub.ingest(token,first).then(value=>{acknowledged=true;return value;});
  await new Promise(resolve=>setTimeout(()=>{ticked=true;assert.equal(acknowledged,false);assert.equal(hub.states.has('test-source'),false);resolve();},50));
  const ack=await pending;assert.equal(ack.added,1);assert.equal(ticked,true);result.acknowledged=1;
 }else{
  const pending=hub.ingest(token,first),queued=hub.ingest(token,payload('queued'));const settled=await Promise.allSettled([pending,queued]);
  assert.equal(settled[0].status,'rejected');result.firstError={code:settled[0].reason.code,sqliteCode:settled[0].reason.sqliteCode,outcome:settled[0].reason.journalOutcome};
  if(['before-commit-exit','after-commit-exit','missing-ack'].includes(fault)){
   assert.equal(settled[1].status,'rejected');assert.equal(settled[1].reason.code,'JOURNAL_GENERATION_CHANGED');assert.equal(hub.fenced,false);assert.equal(hub.writer,null);
   if(fault==='before-commit-exit')assert.equal(hub.journal.status().retainedEvents,0);
   if(fault==='after-commit-exit'){assert.equal(await fs.readFile(process.env.TEST_ONLY_JOURNAL_MARKER,'utf8'),'COMMIT_RETURNED');assert.equal(hub.journal.status().retainedEvents,1);assert.equal(hub.states.get('test-source').batchId,'first');}
   delete process.env.TEST_ONLY_JOURNAL_FAULT;
   const replay=await hub.ingest(token,first);assert.equal(replay.added,fault==='before-commit-exit'?1:0);assert.equal(hub.journal.status().retainedEvents,1);result.replayAdded=replay.added;
  }else{
   assert.equal(result.firstError.outcome,'rolled-back');assert.equal(settled[1].status,'fulfilled');assert.equal(hub.journal.status().retainedEvents,1);assert.equal(hub.states.get('test-source').batchId,'queued');
   result.nativeFull=fault==='native-full';if(result.nativeFull)assert.equal(result.firstError.sqliteCode,13,'real SQLite SQLITE_FULL required');
  }
 }
 const settings=JSON.parse(await fs.readFile(path.join(directory,'TEST_ONLY-writer-settings.json'),'utf8'));
 assert.deepEqual(settings,{synchronous:2,journal_mode:'wal',wal_autocheckpoint:1000,cache_size:-2000,busy_timeout:3000});result.writerSettings=settings;
 await release();assert.equal(hub.writer,null);result.closed=true;
 console.log(JSON.stringify(result));
}finally{await release();keeper();}
