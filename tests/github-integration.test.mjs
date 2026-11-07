// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {GitHubIntegration} from '../lib/github-integration.mjs';
import {projectGitHubMetadata,validateGitHubConfiguration} from '../lib/github-metadata.mjs';
import {createServer} from './fixture-server.mjs';
import {selectGitHubArchiveBatch,acknowledgeGitHubArchive,githubArchiveStatus} from '../lib/github-archive.mjs';
import {archiveGitHubOnce} from '../scripts/archive-github.mjs';
import {spawn} from 'node:child_process';
import {writeFile,readFile} from 'node:fs/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

const sha = 'a'.repeat(40), baseSha = 'b'.repeat(40), token = 'github_pat_TEST_ONLY_01234567890123456789';
const configuration = {sourceId:'github-fixture',hostId:'source-fixture',project:'Fixture project',repository:'example/fixture',repositoryId:42,pullNumbers:[7],intervalMs:60000};
const viewer = {id:'fixture-viewer',hostIds:['source-fixture'],projectIds:['Fixture project']}, hosts = [{id:'source-fixture'}];
const root = '/repos/example/fixture', time = '2030-01-01T00:00:00Z';
const repository = {id:42,full_name:'example/fixture',private:true,archived:false};
const pull = {id:70,number:7,state:'open',draft:false,merged:false,base:{repo:{id:42},sha:baseSha},head:{repo:{id:43},sha},title:'PRIVATE_PROMPT_SENTINEL',body:'SECRET_BODY_SENTINEL'};
const check = {id:80,head_sha:sha,check_suite:{id:81},app:{id:82},status:'completed',conclusion:'success',output:{text:'RAW_OUTPUT_SENTINEL'}};
const run = {id:90,repository:{id:42},head_repository:{id:43},head_sha:sha,workflow_id:91,run_number:1,run_attempt:2,status:'completed',conclusion:'success'};
const artifact = {id:100,size_in_bytes:123,expired:false,digest:'sha256:'+'c'.repeat(64),workflow_run:{id:90,head_sha:sha},name:'PRIVATE_NAME_SENTINEL',archive_download_url:'https://private.invalid/secret'};
const json = (value,headers={}) => new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json',etag:'"fixture-v1"',...headers}});
const defaultReply = url => {
  const parsed = new URL(url), endpoint = parsed.pathname;
  if (endpoint === root) return json(repository);
  if (endpoint === root+'/pulls/7') return json(pull);
  if (endpoint.endsWith('/check-runs')) return json({total_count:1,check_runs:[check]});
  if (endpoint.endsWith('/statuses')) return json([{id:85,state:'success',description:'RAW_STATUS_SENTINEL'}]);
  if (endpoint.endsWith('/actions/runs')) return json({total_count:1,workflow_runs:[run]});
  if (endpoint.endsWith('/artifacts')) return json({total_count:1,artifacts:[artifact]});
  throw new Error('Unexpected fixture request');
};
async function fixture(t,extra={}) {
  const directory = await mkdtemp(path.join(os.tmpdir(),'cc-github-')), file = path.join(directory,'github.sqlite');
  let clock = Date.parse(time), integration, reply = defaultReply; const resources=[]; const requests = [];
  const options = {file,configuration,tokenProvider:async()=>token,now:()=>clock,fetchImpl:async(url,options)=>{requests.push({url,options});return reply(url,options);},...extra};
  integration = new GitHubIntegration(options);
  t.after(async()=>{resources.forEach(db=>db.close());integration?.close();await rm(directory,{recursive:true,force:true});});
  return {file,requests,resources,get integration(){return integration;},read:(options={})=>integration.read({viewer,hosts,...options}),advance:(ms=60001)=>{clock+=ms;},reply:fn=>{reply=fn;},reopen:()=>{integration.close();integration=new GitHubIntegration(options);}};
}

test('vertical slice captures provenance and identities without content or credentials',async t=>{
  const f=await fixture(t), result=await f.integration.poll();
  assert.equal(result.state,'current');assert.equal(result.requests,6);assert.ok(result.responseBytes>0);
  const page=f.read();assert.equal(page.observations.length,6);assert.equal(page.stale,false);assert.equal(page.coverage.completeRepositoryHistory,false);
  const records=page.observations.flatMap(o=>o.metadata?.records||[]);
  assert.deepEqual(records.map(r=>r.kind),['repository','pull','check','status','run','artifact']);
  assert.deepEqual(records[1].base,{repositoryId:42,sha:baseSha});assert.equal(records[1].head.repositoryId,43);
  assert.equal(records.at(-1).observedRunAttempt,2);assert.equal(records.at(-1).digest,artifact.digest);
  for(const request of f.requests){assert.equal(request.options.method,'GET');assert.equal(request.options.redirect,'error');assert.equal(new URL(request.url).origin,'https://api.github.com');assert.equal(request.options.headers['X-GitHub-Api-Version'],'2026-03-10');}
  const db=new DatabaseSync(f.file,{readOnly:true});const persisted=JSON.stringify(db.prepare('SELECT payload FROM observations').all())+JSON.stringify(db.prepare('SELECT * FROM pages').all());db.close();
  for(const forbidden of [token,'PRIVATE_','SECRET_','RAW_','private.invalid','authorization'])assert.equal(persisted.includes(forbidden),false,forbidden);
  assert.equal(page.archive.evictionEnabled,false);assert.equal(page.archive.status,'not_configured');
});

test('bounded collection resumes after restart; duplicate calls and conditional recovery do not replay committed jobs',async t=>{
  const f=await fixture(t);assert.equal((await f.integration.poll({requestBudget:2})).state,'collecting');assert.equal(f.read().observations.length,2);
  f.reopen();await f.integration.poll();assert.equal(f.requests.length,6);assert.equal(f.read().observations.length,6);
  assert.equal((await f.integration.poll()).requests,0);
  f.advance();f.reply((url,options)=>{assert.equal(options.headers['If-None-Match'],'"fixture-v1"');return new Response(null,{status:304});});
  await f.integration.poll();const page=f.read();assert.equal(page.observations.length,12);assert.ok(page.observations.slice(6).every(o=>o.metadata===null&&o.httpStatus===304&&o.priorObservedAt));
  assert.equal(new Set(page.observations.map(o=>o.cycle+o.endpoint)).size,12);
});

test('changed versions and return to an older value remain immutable captured observations',async t=>{
  const f=await fixture(t);await f.integration.poll();f.advance();
  f.reply(url=>new URL(url).pathname===root+'/pulls/7'?json({...pull,state:'closed'}):defaultReply(url));await f.integration.poll();
  f.advance();f.reply(defaultReply);await f.integration.poll();
  const states=f.read().observations.flatMap(o=>o.metadata?.records||[]).filter(r=>r.kind==='pull').map(r=>r.state);assert.deepEqual(states,['open','closed','open']);
  const db=new DatabaseSync(f.file);assert.throws(()=>db.exec('DELETE FROM observations'),/Immutable/);assert.throws(()=>db.exec("UPDATE observations SET payload='{}'"),/Immutable/);db.close();
});

test('scope intersects host and project, including disabled and expired sources',async t=>{
  const f=await fixture(t);await f.integration.poll();
  for(const denied of [null,{...viewer,hostIds:[]},{...viewer,projectIds:[]},{...viewer,projectIds:['other']},{}])assert.throws(()=>f.read({viewer:denied}),{status:403});
  for(const source of [[],[{id:'other'}],[{id:'source-fixture',disabled:true}],[{id:'source-fixture',expiresAt:'2020-01-01T00:00:00Z'}]])assert.throws(()=>f.read({hosts:source}),{status:403});
  assert.equal(f.read({viewer:{id:'admin',hostIds:null,projectIds:null}}).observations.length,6);
});

test('rate limits survive restart, block requests until reset and recover without losing pending work',async t=>{
  const f=await fixture(t);let first=true;
  f.reply(url=>{if(first){first=false;return new Response(null,{status:429,headers:{'retry-after':'120','x-ratelimit-remaining':'0','x-ratelimit-reset':String(Date.parse(time)/1000+180)}});}return defaultReply(url);});
  assert.equal((await f.integration.poll()).state,'rate_limited');assert.equal(f.read().observations.length,0);f.reopen();f.advance(120001);assert.equal((await f.integration.poll()).requests,0);
  f.advance(60000);await f.integration.poll();assert.equal(f.read().observations.length,6);assert.equal(f.read().state,'current');
});

test('missing data is unavailable, retained history becomes stale and recovers',async t=>{
  const f=await fixture(t);await f.integration.poll();f.advance(120001);assert.equal(f.read().state,'stale');
  f.reply(()=>new Response(null,{status:404}));await f.integration.poll();assert.equal(f.read().state,'unavailable');assert.equal(f.read().reason,'missing_or_inaccessible');assert.equal(f.read().observations.length,6);
  f.advance();f.reply(defaultReply);await f.integration.poll();assert.equal(f.read().observations.length,12);
});

test('authentication failures never expose upstream error content or credential exceptions',async t=>{
  const f=await fixture(t,{tokenProvider:async()=>{throw new Error(token);}});await f.integration.poll();assert.equal(f.requests.length,0);assert.equal(f.read().reason,'authentication_unavailable');assert.equal(JSON.stringify(f.read()).includes(token),false);
});

test('storage pressure defers before fetching; no retained records are evicted',async t=>{
  let free=10**12;const f=await fixture(t,{storageAdmission:{statfs:()=>({bavail:free,bsize:1,blocks:10**12})}});
  await f.integration.poll();f.advance();free=0;await f.integration.poll();assert.equal(f.requests.length,6);assert.equal(f.read().reason,'storage_pressure');assert.equal(f.read().observations.length,6);
  free=10**12;f.advance();await f.integration.poll();assert.equal(f.read().observations.length,12);
});

test('validated pagination continues and never follows foreign origins or credential-bearing links',async t=>{
  const f=await fixture(t);f.reply(url=>{
    const u=new URL(url);if(u.pathname.endsWith('/check-runs'))return json({total_count:2,check_runs:[{...check,id:u.searchParams.get('page')==='2'?88:80}]},u.searchParams.get('page')==='1'?{link:`<${url.replace('page=1','page=2')}>; rel="next"`}:{});
    return defaultReply(url);
  });await f.integration.poll();assert.equal(f.read().observations.length,7);assert.ok(f.requests.some(r=>r.url.endsWith('page=2')));
  f.advance();f.reply(url=>new URL(url).pathname.endsWith('/check-runs')?json({total_count:1,check_runs:[check]},{link:'<https://attacker.invalid/secret?page=2>; rel="next"'}):defaultReply(url));
  await f.integration.poll();assert.equal(f.read().reason,'invalid_pagination');assert.ok(f.requests.every(r=>new URL(r.url).origin==='https://api.github.com'));
});

test('missing conditional cache, oversized bodies, malformed records and repository replacement fail closed',async t=>{
  const f=await fixture(t);f.reply(()=>new Response(null,{status:304}));await f.integration.poll();assert.equal(f.read().reason,'missing_conditional_cache');
  f.advance();f.reply(()=>json(repository,{'content-length':'3000000'}));await f.integration.poll();assert.equal(f.read().reason,'response_too_large');
  f.advance(120001);f.reply(()=>json({...repository,id:999}));await f.integration.poll();assert.equal(f.read().reason,'invalid_metadata');assert.equal(f.read().observations.length,0);
  f.advance(240001);f.reply(defaultReply);await f.integration.poll();assert.equal(f.read().state,'current');
});

test('concurrent polls serialize and cursor pages are bounded without dropping history',async t=>{
  const f=await fixture(t);let resolve;const gate=new Promise(r=>{resolve=r;});f.reply(async url=>{await gate;return defaultReply(url);});
  const first=f.integration.poll();assert.equal((await f.integration.poll()).state,'busy');resolve();await first;
  let after=0,caughtUp;const seen=[];do{const page=f.read({after,limit:2});seen.push(...page.observations.map(o=>o.sequence));after=page.nextCursor;caughtUp=page.caughtUp;}while(!caughtUp);
  assert.deepEqual(seen,[1,2,3,4,5,6]);assert.throws(()=>f.read({limit:101}),{status:400});
});

test('HTTP route enforces authentication, source/project scopes, read only and disabled default',async t=>{
  const f=await fixture(t);await f.integration.poll();
  const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
  const viewers=[{...viewer,label:'Fixture',tokenHash:hash('viewer-key')},{...viewer,id:'denied',label:'Denied',projectIds:[],tokenHash:hash('denied-key')}];
  const hub={hosts:hosts.map(h=>({...h,tokenHash:hash('collector-key')})),states:new Map()};const server=createServer({hub,viewers,githubIntegration:f.integration});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const url='http://127.0.0.1:'+server.address().port+'/api/integrations/github';
  assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{authorization:'Bearer denied-key'}})).status,403);
  const headers={authorization:'Bearer viewer-key'};const response=await fetch(url+'?limit=2',{headers});assert.equal(response.status,200);assert.equal((await response.json()).observations.length,2);
  assert.equal((await fetch(url,{method:'POST',headers})).status,405);assert.equal((await fetch(url+'?limit=2&limit=3',{headers})).status,400);
  hub.hosts[0].disabled=true;assert.equal((await fetch(url,{headers})).status,403);
});

test('binding and projection reject unknown config, mismatched SHAs, and invalid identities',async t=>{
  assert.throws(()=>validateGitHubConfiguration({...configuration,token}));assert.throws(()=>validateGitHubConfiguration({...configuration,repository:'../fixture'}));assert.deepEqual(validateGitHubConfiguration({...configuration,pullNumbers:[]}).pullNumbers,[]);
  assert.throws(()=>projectGitHubMetadata('check',{...check,head_sha:baseSha},{...configuration,headSha:sha}));
  assert.throws(()=>projectGitHubMetadata('artifact',{...artifact,id:Number.MAX_SAFE_INTEGER+1},{...configuration,headSha:sha,runId:90}));
  const f=await fixture(t);assert.throws(()=>new GitHubIntegration({file:f.file,configuration:{...configuration,project:'Other'},tokenProvider:async()=>token}),/binding changed/);
});

test('second process owner is excluded and an expired crashed lease can resume',async t=>{
  const f=await fixture(t);let resolve;const gate=new Promise(r=>{resolve=r;});f.reply(async url=>{await gate;return defaultReply(url);});
  const first=f.integration.poll();await new Promise(r=>setImmediate(r));
  const second=new GitHubIntegration({file:f.file,configuration,tokenProvider:async()=>token,now:()=>Date.parse(time),fetchImpl:()=>{throw new Error('Must not fetch');}});
  assert.equal((await second.poll()).state,'busy');second.close();resolve();await first;
  f.advance();const db=new DatabaseSync(f.file);db.prepare('INSERT INTO lease VALUES(1,?,?)').run('crashed-owner',Date.parse(time));db.close();
  f.reply(defaultReply);assert.equal((await f.integration.poll()).state,'current');assert.equal(f.read().observations.length,12);
});

test('successful exhausted quota and x-poll-interval survive the next invocation',async t=>{
  const f=await fixture(t);let first=true;f.reply(url=>{if(first){first=false;return json(repository,{'x-ratelimit-remaining':'0','x-ratelimit-reset':String(Date.parse(time)/1000+90),'x-poll-interval':'240'});}return defaultReply(url);});
  await f.integration.poll();assert.equal(f.requests.length,1);f.advance();assert.equal((await f.integration.poll()).requests,0);f.advance(30000);await f.integration.poll();assert.equal(f.read().state,'current');
  f.advance();assert.equal((await f.integration.poll()).requests,0);f.advance(90000);assert.equal((await f.integration.poll()).requests,6);
});

test('pagination limit is explicitly partial and retains every captured page',async t=>{
  const f=await fixture(t);f.reply(url=>{const u=new URL(url);if(u.pathname.endsWith('/check-runs')){const page=Number(u.searchParams.get('page'));u.searchParams.set('page',String(page+1));return json({total_count:2000,check_runs:[{...check,id:page+1000}]},{link:`<${u.href}>; rel="next"`});}return defaultReply(url);});
  for(let i=0;i<4;i++)await f.integration.poll();
  const read=f.read();assert.equal(read.state,'partial');assert.equal(read.reason,'collection_bound');assert.equal(read.observations.filter(o=>o.endpoint.includes('check-runs')).length,20);assert.equal(f.requests.length,25);
});

test('journal admission stops before capacity exhaustion without eviction',async t=>{
  const f=await fixture(t,{storageAdmission:{sourceBytes:2097152+500}});await f.integration.poll();assert.equal(f.requests.length,1);assert.equal(f.read().reason,'storage_pressure');assert.equal(f.read().archive.pendingPages,1);assert.ok(f.read().pendingRequests>0);
});

test('401, 403, 500 and transport failure preserve captured history and recover',async t=>{
  const f=await fixture(t);await f.integration.poll();
  for(const code of [401,403,500]){f.advance(4000000);f.reply(()=>new Response('SECRET_UPSTREAM_ERROR',{status:code}));await f.integration.poll();assert.equal(f.read().state,'unavailable');assert.equal(f.read().observations.length,6);assert.equal(JSON.stringify(f.read()).includes('SECRET_UPSTREAM_ERROR'),false);}
  f.advance(4000000);f.reply(()=>{throw new Error('SECRET_TRANSPORT_ERROR');});await f.integration.poll();assert.equal(f.read().reason,'transport_or_storage_error');
  f.advance(4000000);f.reply(defaultReply);await f.integration.poll();assert.equal(f.read().observations.length,12);
});

test('transaction failure leaves cursor and conditional cache unchanged for retry',async t=>{
  const f=await fixture(t);const db=new DatabaseSync(f.file);db.exec("CREATE TRIGGER fixture_reject BEFORE INSERT ON observations BEGIN SELECT RAISE(ABORT,'Fixture failure'); END;");
  await f.integration.poll();assert.equal(f.read().observations.length,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pages').get().n,0);
  db.exec('DROP TRIGGER fixture_reject');db.close();f.reopen();f.advance();await f.integration.poll();assert.equal(f.read().observations.length,6);assert.equal(f.requests[1].options.headers['If-None-Match'],undefined);
});

test('unconfigured HTTP source is unavailable and shared viewers are refused',async t=>{
  const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
  const server=createServer({viewers:[{...viewer,label:'Fixture',tokenHash:hash('viewer-key')}],viewTokenHash:hash('shared-key')});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const url='http://127.0.0.1:'+server.address().port+'/api/integrations/github';
  assert.equal((await fetch(url,{headers:{authorization:'Bearer shared-key'}})).status,403);
  const response=await(await fetch(url,{headers:{authorization:'Bearer viewer-key'}})).json();assert.equal(response.state,'unavailable');assert.equal(response.reason,'not_configured');assert.deepEqual(response.sources,[]);assert.match(response.permissionStamp,/^[a-f0-9]{64}$/);
});

test('replaced journals and restore cursors signal a gap and resume from retained observations',async t=>{
  const f=await fixture(t);await f.integration.poll();const first=f.read();assert.match(first.epoch,/^[a-f0-9-]{36}$/);
  f.reopen();assert.equal(f.read().epoch,first.epoch);
  const replaced=f.read({after:4,epoch:crypto.randomUUID()});assert.equal(replaced.gap.reason,'journal_changed');assert.equal(replaced.observations[0].sequence,1);
  const restored=f.read({after:999,epoch:first.epoch});assert.equal(restored.gap.reason,'cursor_ahead');assert.equal(restored.observations[0].sequence,1);
});

test('unsolicited 304 without a sent validator cannot certify cached metadata',async t=>{
  const f=await fixture(t);f.reply(url=>{const response=defaultReply(url);response.headers.delete('etag');return response;});await f.integration.poll();f.advance();
  f.reply((url,options)=>{assert.equal(options.headers['If-None-Match'],undefined);return new Response(null,{status:304});});
  await f.integration.poll();assert.equal(f.read().state,'unavailable');assert.equal(f.read().reason,'missing_conditional_cache');assert.equal(f.read().observations.length,6);
});

test('overflowing retry and poll intervals never serialize nonfinite deadlines or bypass backoff',async t=>{
  const f=await fixture(t);f.reply(()=>new Response(null,{status:429,headers:{'retry-after':'1e308'}}));await f.integration.poll();assert.ok(Number.isSafeInteger(f.read().retryAt));
  assert.equal((await f.integration.poll()).requests,0);f.advance();
  f.reply(url=>{const response=defaultReply(url);response.headers.set('x-poll-interval','1e308');return response;});await f.integration.poll();assert.equal(f.read().state,'current');f.reopen();assert.equal((await f.integration.poll()).requests,0);
});

test('lease cleanup storage failure does not permanently latch in-process busy state',async t=>{
  const f=await fixture(t);const db=new DatabaseSync(f.file);db.exec("CREATE TRIGGER reject_lease_delete BEFORE DELETE ON lease BEGIN SELECT RAISE(ABORT,'Fixture cleanup storage error'); END;");
  await assert.rejects(f.integration.poll(),/Fixture cleanup storage error/);db.exec('DROP TRIGGER reject_lease_delete');db.close();
  f.advance();assert.equal((await f.integration.poll()).state,'current');assert.equal(f.read().observations.length,12);
});

test('branch and discovered PR collection share head jobs and bounded snapshots retain provenance',async t=>{
  const f=await fixture(t,{configuration:{...configuration,pullNumbers:[],discoverPulls:true,branch:'main'}});
  f.reply(url=>{const u=new URL(url);if(u.pathname===root+'/branches/main')return json({name:'main',commit:{sha},protected:true});if(u.pathname===root+'/pulls')return json([pull]);return defaultReply(url);});
  await f.integration.poll();const summary=f.integration.snapshot({viewer,hosts});
  assert.equal(summary.state,'current');assert.equal(f.requests.length,8);assert.equal(summary.records.length,8);
  assert.equal(f.requests.filter(r=>r.url.includes('/check-runs')).length,1);assert.equal(summary.records.find(r=>r.kind==='branch').headSha,sha);
  assert.ok(summary.records.every(r=>r.observedAt&&r.verifiedAt));assert.equal(summary.coverage.branch,'main');assert.equal(summary.coverage.completeRepositoryHistory,false);
  assert.throws(()=>f.integration.snapshot({viewer:{...viewer,projectIds:['Other']},hosts}),{status:403});
  f.advance();f.reply(()=>new Response(null,{status:304}));await f.integration.poll();
  const second=f.integration.snapshot({viewer,hosts});assert.equal(second.records[0].observedAt,summary.records[0].observedAt);assert.notEqual(second.records[0].verifiedAt,summary.records[0].verifiedAt);
});

test('branch-only repositories work without pull requests and discovery caps remain explicit',async t=>{
  const f=await fixture(t,{configuration:{...configuration,pullNumbers:[],discoverPulls:true,branch:'main'}});
  f.reply(url=>{const u=new URL(url);if(u.pathname===root+'/branches/main')return json({name:'main',commit:{sha},protected:false});if(u.pathname===root+'/pulls')return json([]);return defaultReply(url);});
  await f.integration.poll();assert.equal(f.read().state,'current');assert.equal(f.integration.snapshot({viewer,hosts}).records.some(r=>r.kind==='branch'),true);
  f.advance();f.reply(url=>{const u=new URL(url);if(u.pathname===root+'/branches/main')return json({name:'main',commit:{sha},protected:false});if(u.pathname===root+'/pulls')return json(Array.from({length:20},(_,i)=>({...pull,id:1000+i,number:i+1})));if(/\/pulls\/\d+$/.test(u.pathname))return json({...pull,number:Number(u.pathname.split('/').at(-1))});return defaultReply(url);});
  for(let i=0;i<4;i++)await f.integration.poll();assert.equal(f.read().state,'partial');assert.equal(f.read().reason,'collection_bound');assert.equal(f.read().observations.filter(o=>o.cycle===2&&/\/pulls\/\d+$/.test(o.endpoint)).length,16);
});

test('GitHub immutable archive retries exact bytes and only exact receipts advance custody',async t=>{
  const f=await fixture(t);await f.integration.poll();const db=new DatabaseSync(f.file);f.resources.push(db);
  const before=db.prepare('SELECT * FROM observations').all(),batch=selectGitHubArchiveBatch(db,{maxRecords:2});
  assert.equal(batch.records,2);assert.deepEqual(selectGitHubArchiveBatch(db),batch);
  const receipt={durable:true,receiverId:'fixture-receiver',batchId:batch.batchId,rawSha256:batch.rawSha256,records:batch.records,itemIds:batch.itemIds};
  assert.throws(()=>acknowledgeGitHubArchive(db,batch,{...receipt,itemIds:[...batch.itemIds].reverse()}));assert.equal(githubArchiveStatus(db).pendingPages,6);
  acknowledgeGitHubArchive(db,batch,receipt);assert.equal(githubArchiveStatus(db).pendingPages,4);assert.equal(githubArchiveStatus(db).archivedPages,2);
  const next=selectGitHubArchiveBatch(db);assert.equal(next.lastSequence,6);assert.throws(()=>acknowledgeGitHubArchive(db,next,{...receipt,batchId:next.batchId,rawSha256:next.rawSha256,records:next.records,itemIds:next.itemIds,receiverId:'changed'}));
  assert.deepEqual(db.prepare('SELECT * FROM observations').all(),before);assert.throws(()=>db.exec('DELETE FROM observations'));
});

const receiverScript=fileURLToPath(new URL('../scripts/archive-receiver.py',import.meta.url));
const receiver=(config,input,args=[])=>new Promise((resolve,reject)=>{const child=spawn(process.env.CODEX_TEST_PYTHON||(process.platform==='win32'?'python':'python3'),[receiverScript,'--config',config,...args],{stdio:['pipe','pipe','pipe'],windowsHide:true});let stdout='',stderr='';child.on('error',reject);child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.on('error',()=>{});child.stdin.end(input);});

test('actual V3 receiver archives every metadata kind, recovers a lost receipt and rejects private fields',async t=>{
  const f=await fixture(t,{configuration:{...configuration,discoverPulls:true,branch:'main'}});
  f.reply(url=>{const u=new URL(url);if(u.pathname===root+'/branches/main')return json({name:'main',commit:{sha},protected:true});if(u.pathname===root+'/pulls')return json([pull]);return defaultReply(url);});
  await f.integration.poll();f.advance();f.reply(()=>new Response(null,{status:304}));await f.integration.poll();
  const db=new DatabaseSync(f.file);f.resources.push(db);const batch=selectGitHubArchiveBatch(db),dir=path.dirname(f.file),config=path.join(dir,'receiver.json'),receiverId=crypto.randomUUID();
  await writeFile(config,JSON.stringify({archiveDirectory:path.join(dir,'cold'),catalogDirectory:path.join(dir,'catalog'),receiverId}),{mode:0o600});
  let sent=[];const send=async({compressed})=>{sent.push(Buffer.from(compressed));const result=await receiver(config,compressed);assert.equal(result.code,0,result.stderr);return result.stdout;};
  const first=await send({compressed:gzipSync(Buffer.from(batch.body),{level:1})});assert.equal(JSON.parse(first).records,16);
  const failed=await archiveGitHubOnce({file:f.file,configFile:'fixture'},{load:async()=>({receiverId}),send:async args=>{await send(args);throw Error('lost ACK');}});assert.equal(failed.status,'unavailable');assert.equal(failed.pendingPages,16);
  const result=await archiveGitHubOnce({file:f.file,configFile:'fixture'},{load:async()=>({receiverId}),send});assert.equal(result.status,'healthy');assert.equal(result.pendingPages,0);assert.deepEqual(sent[1],sent[2]);
  const ack=JSON.parse(first),stored=await readFile(path.join(dir,'cold',ack.segment));assert.equal(gunzipSync(stored).toString(),batch.body);
  const exported=await receiver(config,undefined,['--query','--table','github_metadata']);assert.equal(exported.code,0,exported.stderr);assert.equal(exported.stdout,batch.body);
  const record=JSON.parse(batch.body.split('\n')[0]),observation=JSON.parse(record.row.payload);observation.token='PRIVATE_SENTINEL';record.row.payload=JSON.stringify(observation);record.itemId=crypto.createHash('sha256').update(record.row.epoch+'\n'+record.sequence+'\n'+record.row.payload).digest('hex');
  assert.notEqual((await receiver(config,gzipSync(Buffer.from(JSON.stringify(record)+'\n')))).code,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observations').get().n,16);assert.equal((await receiver(config,undefined,['--verify'])).code,0);
});


test('explicit partial token mode skips Checks while retaining other metadata and recovery',async t=>{
  const f=await fixture(t,{configuration:{...configuration,discoverPulls:true,branch:'main',collectChecks:false}});
  f.reply(url=>{const u=new URL(url);assert.ok(!u.pathname.endsWith('/check-runs'));if(u.pathname===root+'/branches/main')return json({name:'main',commit:{sha},protected:true});if(u.pathname===root+'/pulls')return json([pull]);return defaultReply(url);});
  await f.integration.poll();const first=f.integration.snapshot({viewer,hosts});
  assert.equal(first.state,'partial');assert.equal(first.reason,'checks_not_configured');assert.equal(first.coverage.checks,'disabled');assert.equal(first.pendingRequests,0);
  assert.equal(f.requests.length,7);for(const kind of ['repository','branch','pull','status','run','artifact'])assert.ok(first.records.some(r=>r.kind===kind));assert.ok(!first.records.some(r=>r.kind==='check'));
  assert.equal(f.read().observations.length,7);f.reopen();assert.equal((await f.integration.poll()).requests,0);
  f.advance();f.reply(()=>new Response(null,{status:304}));await f.integration.poll();assert.equal(f.read().observations.length,14);assert.equal(f.integration.snapshot({viewer,hosts}).reason,'checks_not_configured');
  const db=new DatabaseSync(f.file);f.resources.push(db);const batch=selectGitHubArchiveBatch(db);assert.equal(batch.records,14);
});
