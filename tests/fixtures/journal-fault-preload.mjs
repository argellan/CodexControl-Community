// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// TEST_ONLY fault injection. Never loaded by the application or qualification.
import {isMainThread,parentPort} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
if(!isMainThread&&process.env.TEST_ONLY_JOURNAL_FAULT){
 const fault=process.env.TEST_ONLY_JOURNAL_FAULT,native=DatabaseSync.prototype.exec;let armed=true,settingsRecorded=false;
 DatabaseSync.prototype.exec=function(sql,...args){
  if(!settingsRecorded&&sql==='BEGIN IMMEDIATE'){
   settingsRecorded=true;const settings={};for(const name of ['synchronous','journal_mode','wal_autocheckpoint','cache_size','busy_timeout'])settings[name]=Object.values(this.prepare('PRAGMA '+name).get())[0];
   fs.writeFileSync(process.env.TEST_ONLY_JOURNAL_DIRECTORY+'/TEST_ONLY-writer-settings.json',JSON.stringify(settings));
  }
  if(armed&&sql==='BEGIN IMMEDIATE'&&fault==='native-full'){
   const result=native.call(this,sql,...args),pages=this.prepare('PRAGMA page_count').get().page_count;
   native.call(this,'PRAGMA max_page_count='+pages);armed=false;return result;
  }
  if(armed&&sql==='COMMIT'){
   armed=false;
   if(fault==='slow-commit')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);
   if(fault==='write-error'||fault==='sync-error')throw Object.assign(new Error('TEST_ONLY injected '+fault),{code:fault==='write-error'?'SQLITE_IOERR_WRITE':'SQLITE_IOERR_FSYNC'});
   if(fault==='before-commit-exit')process.exit(86);
   if(fault==='after-commit-exit'){const result=native.call(this,sql,...args);fs.writeFileSync(process.env.TEST_ONLY_JOURNAL_MARKER,'COMMIT_RETURNED');process.exit(87);return result;}
  }
  return native.call(this,sql,...args);
 };
 if(fault==='missing-ack')parentPort.postMessage=()=>{};
}
