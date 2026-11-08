// Author: Bishop Crockett; Owner: Argellan.com; License: MIT; SPDX-License-Identifier: MIT
import crypto from 'node:crypto';
import {installProcessArchive,processArchiveStatus} from './process-archive.mjs';
import {validateSnapshot,ProcessStore} from './process-model.mjs';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export const processDigest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function normalizeProcessSamples(samples,hostId){
 if(!Array.isArray(samples)||samples.length>1||Buffer.byteLength(JSON.stringify(samples))>524288)fail('Process observation exceeds admission bound',413);
 return samples.map(frame=>{
  if(!frame||Object.keys(frame).some(k=>!['epoch','snapshot'].includes(k))||typeof frame.epoch!=='string'||!/^[a-f0-9-]{36}$/.test(frame.epoch)||frame.snapshot?.hostId!==hostId||frame.snapshot?.sourceKind!=='local-os')fail('Invalid process provenance');
  const allowed=new Set('key pid createdAt parentPid executable role family roleBasis privateCommitBytes workingSetBytes cpuTimeMs ioBytes metricStatus sessionId'.split(' '));
  if(!Array.isArray(frame.snapshot.processes)||frame.snapshot.processes.some(p=>!p||Object.keys(p).some(k=>!allowed.has(k))))fail('Unsupported process field');
  const safe=validateSnapshot({...frame.snapshot,receivedAt:frame.snapshot.receivedAt??frame.snapshot.observedAt});return {epoch:frame.epoch,snapshot:safe};
 });
}
export function installProcessSchema(db){db.exec(`CREATE TABLE IF NOT EXISTS process_observations(
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, host_id TEXT NOT NULL, observer_epoch TEXT NOT NULL,
 source_sequence INTEGER NOT NULL, observed_ms INTEGER NOT NULL, received_ms INTEGER NOT NULL,
 digest TEXT NOT NULL, payload TEXT NOT NULL, bytes INTEGER NOT NULL,
 UNIQUE(host_id,observer_epoch,source_sequence));
 CREATE TABLE IF NOT EXISTS process_storage(host_id TEXT PRIMARY KEY,logical_bytes INTEGER NOT NULL);
 CREATE TRIGGER IF NOT EXISTS process_storage_insert AFTER INSERT ON process_observations BEGIN INSERT INTO process_storage(host_id,logical_bytes) VALUES(NEW.host_id,4096+8*NEW.bytes) ON CONFLICT(host_id) DO UPDATE SET logical_bytes=logical_bytes+4096+8*NEW.bytes; END;
 CREATE INDEX IF NOT EXISTS process_host_time ON process_observations(host_id,observed_ms DESC,sequence DESC);
 CREATE INDEX IF NOT EXISTS process_host_sequence ON process_observations(host_id,sequence);`);
 // Bootstrap once for earlier isolated candidates; never rescan full history on a UI poll.
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='process_totals'").get()){
  db.exec('SAVEPOINT process_totals_upgrade');try{db.exec(`CREATE TABLE process_totals(host_id TEXT PRIMARY KEY,n INTEGER NOT NULL,bytes INTEGER NOT NULL);
   INSERT INTO process_totals SELECT host_id,COUNT(*),COALESCE(SUM(bytes),0) FROM process_observations GROUP BY host_id;
   CREATE TRIGGER process_totals_insert AFTER INSERT ON process_observations BEGIN INSERT INTO process_totals(host_id,n,bytes) VALUES(NEW.host_id,1,NEW.bytes) ON CONFLICT(host_id) DO UPDATE SET n=n+1,bytes=bytes+NEW.bytes; END;`);db.exec('RELEASE process_totals_upgrade');}
  catch(error){db.exec('ROLLBACK TO process_totals_upgrade; RELEASE process_totals_upgrade');throw error;}
 }
 installProcessArchive(db);
}
export function processCharge(db,hostId){// Immutable observations before the validated contiguous receipt cursor remain
 // retained locally, but no longer consume the pending-archive allowance.
 // The host/sequence index bounds this read to unarchived rows; disk reserve
 // admission still accounts for the real local filesystem on every commit.
 return db.prepare('SELECT COALESCE(SUM(4096+8*bytes),0) AS logical_bytes FROM process_observations WHERE host_id=? AND sequence>(SELECT COALESCE(MAX(last_sequence),0) FROM process_archive_receipts)').get(hostId).logical_bytes;}
export function recordProcesses(db,samples,hostId,now){
 let added=0;for(const f of normalizeProcessSamples(samples,hostId)){
  const payload=JSON.stringify(f),digest=processDigest(f),old=db.prepare('SELECT digest FROM process_observations WHERE host_id=? AND observer_epoch=? AND source_sequence=?').get(hostId,f.epoch,f.snapshot.sequence);
  if(old){if(old.digest!==digest)fail('Process sequence conflicts with durable observation',409);continue;}
  db.prepare('INSERT INTO process_observations(host_id,observer_epoch,source_sequence,observed_ms,received_ms,digest,payload,bytes) VALUES(?,?,?,?,?,?,?,?)').run(hostId,f.epoch,f.snapshot.sequence,Date.parse(f.snapshot.observedAt),now,digest,payload,Buffer.byteLength(payload));added++;
 }return {received:samples.length,added,duplicates:samples.length-added};
}
export function readProcesses(db,viewer,query,allowedHosts){
 if(!viewer)fail('Viewer authentication required',401);
 if(viewer.projectIds!==null)fail('Process project ownership is not yet attached; unrestricted project scope required',403);
 const host=query.get('host');if(!host)fail('Select a host for bounded process inspection');
 if(!allowedHosts.includes(host)||viewer.hostIds!==null&&!viewer.hostIds.includes(host))fail('Host not permitted',403);
 const count=db.prepare('SELECT n,bytes FROM process_totals WHERE host_id=?').get(host)??{n:0,bytes:0};
 const requestedLimit=query.get('limit'),limit=requestedLimit===null?50:Number(requestedLimit);if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('Invalid process page limit');
 if(query.has('project')||query.has('task'))fail('Supported ownership adapter required for project/task filtering',409);
 const mode=query.get('mode')||'list';
 if(mode==='history'){
  const before=query.has('before')?Number(query.get('before')):Number.MAX_SAFE_INTEGER;if(!Number.isSafeInteger(before)||before<1)fail('Invalid process history cursor');
  const rows=db.prepare('SELECT sequence,digest,payload FROM process_observations WHERE host_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?').all(host,before,Math.min(limit,3));
  return {schemaVersion:1,readOnly:true,hostId:host,observations:rows.map(r=>({sequence:r.sequence,digest:r.digest,...JSON.parse(r.payload)})),nextBefore:rows.at(-1)?.sequence??null,archive:processArchiveStatus(db,host),retained:count};
 }
 const rows=db.prepare('SELECT sequence,payload FROM process_observations WHERE host_id=? ORDER BY observed_ms DESC,sequence DESC LIMIT 3').all(host).reverse(),store=new ProcessStore();
 // Up to three bounded samples establish counters without loading durable history into RAM.
 let projectionOrder=0;for(const row of rows){const f=JSON.parse(row.payload);store.ingest({...f.snapshot,sequence:++projectionOrder});}
 const collapsed=query.getAll('collapsed');if(collapsed.length>100||collapsed.some(key=>key.length>400))fail('Invalid tree expansion');
 const filter={host,collapsed,view:query.get('view')||'resources',q:query.get('q')||'',status:query.get('status')||'',role:query.get('role')||'',limit,offset:Number(query.get('offset')||0)};
 if(!Number.isSafeInteger(filter.offset)||filter.offset<0||filter.offset>10000)fail('Invalid process offset');
 const result=store.query(viewer,filter);if(!rows.length)return {schemaVersion:1,readOnly:true,status:'not-observed',hostId:host,rows:[],summary:{processes:null,privateCommitBytes:null},archive:processArchiveStatus(db,host)};if(mode==='detail'){const key=query.get('key');if(!key)fail('Process identity required');const p=store.processes.get(key);if(!p||p.hostId!==host)fail('Process not observed',404);result.rows=[{...p,...store.explain(p)}];result.total=1;}
 else if(mode==='summary')delete result.rows;else if(mode!=='list')fail('Unknown process read mode');
 return {...result,retained:count,projectionSequence:rows.at(-1)?.sequence??null,capabilities:{taskOwnership:false,processControls:false,platform:'windows-first'},archive:processArchiveStatus(db,host)};
}
