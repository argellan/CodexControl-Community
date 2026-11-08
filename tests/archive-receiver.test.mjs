// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {gzipSync,gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {sanitizeAccountUsage} from '../lib/account-usage.mjs';
import {processFixture} from './helpers/private-process-fixture.mjs';

const script=fileURLToPath(new URL('../scripts/archive-receiver.py',import.meta.url));
const PYTHON=process.env.CODEX_TEST_PYTHON||(process.platform==='win32'?'python':'python3');
const receiverId='1c8391d1-13a6-4c56-91bf-d51c47954455',at='2026-10-20T12:00:00.000Z',now=Date.parse(at);
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const row=(sequence=1,extra={})=>({sequence,host_id:'TEST_ONLY_laptop',session_id:'TEST_ONLY_session',project:'TEST_ONLY_project',provider:'openai',model:'gpt-test',source_ms:now,received_ms:now,interval_ms:null,status:'baseline',input_tokens:100,cached_input_tokens:20,output_tokens:10,total_tokens:110,delta_input:null,delta_cached:null,delta_uncached:null,delta_output:null,delta_total:null,...extra});
const record=(sequence=1,extra={})=>({version:1,itemId:digest('TEST_ONLY_'+sequence),sequence,table:'usage_observations',rowKey:{sequence},recordedAt:at,row:row(sequence),...extra});
const encode=records=>Buffer.from(records.map(r=>JSON.stringify(r)).join('\n')+'\n');
const accountRecord=(sequence,buckets,extra={})=>{const account={version:1,source:'codex-app-server',status:'partial',observedAt:at,lastAttemptAt:at,accountKey:'a'.repeat(64),planType:'pro',limitsObservedAt:at,usageObservedAt:null,limits:[],summary:{lifetimeTokens:100,peakDailyTokens:100,longestRunningTurnSec:1,currentStreakDays:1,longestStreakDays:1},dailyUsageBuckets:buckets,errorCode:null,...extra},payload=JSON.stringify(account);return record(sequence,{table:'account_usage_observations',rowKey:{sequence},row:{sequence,host_id:'TEST_ONLY_laptop',sample_key:digest(payload),observed_ms:account.observedAt===at?now:null,limits_ms:account.limitsObservedAt===at?now:null,usage_ms:account.usageObservedAt===at?now:null,received_ms:now,account_identity:account.accountKey,payload}});};
const launch=(config,input=Buffer.alloc(0),args=[])=>new Promise((resolve,reject)=>{
 const child=spawn(PYTHON,[script,'--config',config,...args],{stdio:['pipe','pipe','pipe'],windowsHide:true});let stdout='',stderr='';
 child.on('error',reject);child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('close',code=>resolve({code,stdout,stderr,json:()=>JSON.parse(stdout)}));child.stdin.on('error',()=>{});child.stdin.end(input);
});
async function fixture(t){const privateFixture=await processFixture('codex-archive-TEST_ONLY-'),directory=privateFixture.root;t.after(()=>privateFixture.cleanup());const archiveDirectory=path.join(directory,'cold'),catalogDirectory=path.join(directory,'catalog'),config=path.join(directory,'receiver.json');await fs.writeFile(config,JSON.stringify({archiveDirectory,catalogDirectory,receiverId}),{mode:0o600});return{directory,archiveDirectory,catalogDirectory,config,run:(records,args=[])=>launch(config,gzipSync(encode(records)),args)};}

test('canonical ECMAScript account timestamps archive byte-exact across the complete Date range',async t=>{
 const f=await fixture(t),stamps=['0000-02-29T12:34:56.789Z','1969-12-31T23:59:59.999Z','1970-01-01T00:00:00.000Z','9999-12-31T23:59:59.999Z','+010000-01-01T00:00:00.000Z','+275760-09-13T00:00:00.000Z','-000001-12-31T23:59:59.999Z','-271821-04-20T00:00:00.000Z'];
 const records=stamps.map((stamp,i)=>{const r=accountRecord(i+1,null,{observedAt:stamp,lastAttemptAt:stamp,limitsObservedAt:stamp,usageObservedAt:stamp});const ms=Date.parse(stamp);assert.equal(new Date(ms).toISOString(),stamp);for(const key of ['observed_ms','limits_ms','usage_ms'])r.row[key]=ms>=0?ms:null;return r;});
 const result=await f.run(records);assert.equal(result.code,0,result.stderr);const exported=await launch(f.config,undefined,['--query']);assert.equal(exported.code,0,exported.stderr);assert.equal(exported.stdout,encode(records).toString());assert.equal((await launch(f.config,undefined,['--verify'])).json().verified,true);
});

test('account timestamp compatibility still refuses noncanonical, impossible and out-of-range dates',async t=>{
 const f=await fixture(t);for(const stamp of ['+009999-01-01T00:00:00.000Z','-000000-01-01T00:00:00.000Z','+275760-09-13T00:00:00.001Z','-271821-04-19T23:59:59.999Z','+010000-02-30T00:00:00.000Z','+010000-01-01T24:00:00.000Z','+010000-01-01T00:00:60.000Z','2026-01-01T00:00:00.000+00:00']){const result=await f.run([accountRecord(1,null,{lastAttemptAt:stamp})]);assert.notEqual(result.code,0,stamp);assert.equal(result.stdout,'');}
 assert.equal((await launch(f.config,undefined,['--status'])).json().items,0);
});

test('receiver acknowledges exact hashes and ordered item IDs only after durable cold files/catalog exist',async t=>{
 const f=await fixture(t),records=[record(),record(2)],raw=encode(records),compressed=gzipSync(raw),r=await launch(f.config,compressed);assert.equal(r.code,0,r.stderr);const ack=r.json();assert.equal(ack.version,1);assert.equal(ack.durable,true);assert.equal(ack.receiverId,receiverId);assert.equal(ack.batchId,digest(raw));assert.equal(ack.rawSha256,digest(raw));assert.equal(ack.compressedSha256,digest(compressed));assert.equal(ack.receivedCompressedSha256,digest(compressed));assert.deepEqual(ack.itemIds,records.map(r=>r.itemId));assert.equal(ack.records,2);assert.deepEqual(gunzipSync(await fs.readFile(path.join(f.archiveDirectory,ack.segment))),raw);assert.ok((await fs.stat(path.join(f.catalogDirectory,'catalog.sqlite'))).isFile());const status=(await launch(f.config,undefined,['--status'])).json();assert.equal(status.items,2);assert.equal(status.segments,1);assert.equal(status.timescalePendingSegments,1);assert.equal(status.timescaleEnabled,false);
});
test('exact retry is idempotent across process restarts and re-verifies immutable files',async t=>{
 const f=await fixture(t),first=await f.run([record()]),ack=first.json();for(let i=0;i<2;i++){const r=await f.run([record()]);assert.equal(r.code,0,r.stderr);assert.deepEqual(r.json(),ack);}const value=(await launch(f.config,undefined,['--status'])).json();assert.equal(value.items,1);assert.equal(value.segments,1);const segment=path.join(f.archiveDirectory,ack.segment);await fs.writeFile(segment,Buffer.from('broken'));const denied=await f.run([record()]);assert.notEqual(denied.code,0);assert.equal(denied.stdout,'');assert.match(denied.stderr,/gzip/);
});
test('changed gzip header on an identical raw batch reuses the verified durable segment',async t=>{
 const f=await fixture(t),raw=encode([record()]),compressed=gzipSync(raw),first=(await launch(f.config,compressed)).json(),different=Buffer.from(compressed);different[4]=1;const retry=await launch(f.config,different);assert.equal(retry.code,0,retry.stderr);assert.equal(retry.json().compressedSha256,first.compressedSha256);assert.equal(retry.json().receivedCompressedSha256,digest(different));assert.notEqual(retry.json().receivedCompressedSha256,retry.json().compressedSha256);assert.equal((await launch(f.config,undefined,['--status'])).json().segments,1);
});
test('same item ID with changed bytes refuses the entire batch before ACK or publication',async t=>{
 const f=await fixture(t);assert.equal((await f.run([record()])).code,0);const changed=record(1,{row:row(1,{input_tokens:999})}),denied=await f.run([record(2),changed]);assert.notEqual(denied.code,0);assert.equal(denied.stdout,'');assert.match(denied.stderr,/Conflicting archive item/);const value=(await launch(f.config,undefined,['--status'])).json();assert.equal(value.items,1);assert.equal(value.segments,1);
});
test('overlapping exact items deduplicate while new items preserve ordered receipt membership',async t=>{
 const f=await fixture(t);await f.run([record(),record(2)]);const r=await f.run([record(2),record(3)]);assert.equal(r.code,0,r.stderr);assert.deepEqual(r.json().itemIds,[record(2).itemId,record(3).itemId]);const status=(await launch(f.config,undefined,['--status'])).json();assert.equal(status.items,3);assert.equal(status.segments,2);assert.equal((await launch(f.config,undefined,['--verify'])).json().verified,true);
});
test('duplicate item IDs and duplicate JSON keys are refused rather than silently overwritten',async t=>{
 const f=await fixture(t);for(const raw of [encode([record(),record()]),Buffer.from(encode([record()]).toString().replace('"version":1','"version":1,"version":1')),Buffer.from(encode([record()]).toString().replace('"host_id":"TEST_ONLY_laptop"','"host_id":"TEST_ONLY_laptop","host_id":"other"'))]){const r=await launch(f.config,gzipSync(raw));assert.notEqual(r.code,0);assert.equal(r.stdout,'');assert.match(r.stderr,/Duplicate/);}
});
test('gzip bounds reject zip bombs, oversized streams, concatenated members, trailing junk and truncation',async t=>{
 const f=await fixture(t),valid=gzipSync(encode([record()]));for(const data of [gzipSync(Buffer.alloc(4*1024*1024+1,97)),Buffer.alloc(4*1024*1024+1,97),Buffer.concat([valid,valid]),Buffer.concat([valid,Buffer.from('junk')]),valid.subarray(0,valid.length-1)]){const r=await launch(f.config,data);assert.notEqual(r.code,0);assert.equal(r.stdout,'');assert.equal(JSON.parse(r.stderr).durable,false);}
});
test('record count and final newline bounds are explicit',async t=>{
 const f=await fixture(t);for(const raw of [encode(Array.from({length:1001},(_,i)=>record(i+1))),Buffer.from(JSON.stringify(record())),Buffer.from('\n'),Buffer.from('{}\n\n')]){const r=await launch(f.config,gzipSync(raw));assert.notEqual(r.code,0);assert.equal(r.stdout,'');}
});
test('receiver refuses foreign tables, unknown private fields, key mismatches, booleans and unsafe integers',async t=>{
 const f=await fixture(t),secret='TEST_ONLY_must_not_echo';for(const value of [record(1,{table:'users'}),record(1,{password:secret}),record(1,{row:{...row(),password:secret}}),record(1,{rowKey:{sequence:2}}),record(1,{sequence:true}),record(1,{row:row(1,{input_tokens:9007199254740992})}),record(1,{recordedAt:'2026-02-30T12:00:00.000Z'}),record(1,{itemId:'../../escape'})]){const r=await f.run([value]);assert.notEqual(r.code,0);assert.equal(r.stdout,'');assert.ok(!r.stderr.includes(secret));}
});
test('all five typed SQL row shapes survive exact round trip including account payloads',async t=>{
 const f=await fixture(t),account={version:1,source:'codex-app-server',status:'available',observedAt:at,lastAttemptAt:at,accountKey:'a'.repeat(64),planType:'pro',limitsObservedAt:at,usageObservedAt:at,limits:[],summary:{lifetimeTokens:100,peakDailyTokens:100,longestRunningTurnSec:1,currentStreakDays:1,longestStreakDays:1},dailyUsageBuckets:null,errorCode:null},payload=JSON.stringify(account),baseline={host_id:'TEST_ONLY_laptop',session_id:'TEST_ONLY_session',project:'TEST_ONLY_project',provider:'openai',model:'gpt-test',source_ms:now,received_ms:now,input_tokens:100,cached_input_tokens:20,output_tokens:10,total_tokens:110,has_delta:0},segment=digest(JSON.stringify([baseline.project,baseline.provider,baseline.model])),daily={host_id:baseline.host_id,session_id:baseline.session_id,segment_key:segment,project:baseline.project,provider:baseline.provider,model:baseline.model,day:'2026-10-20',input_tokens:10,cached_input_tokens:2,uncached_input_tokens:8,output_tokens:1,total_tokens:11,observations:1,partial_observations:0,overflow:0,first_ms:now,last_ms:now},a={sequence:1,host_id:baseline.host_id,sample_key:digest(payload),observed_ms:now,limits_ms:now,usage_ms:now,received_ms:now,account_identity:account.accountKey,payload},d={host_id:baseline.host_id,account_identity:account.accountKey,day:'2026-10-19',tokens:100,observed_ms:now,received_ms:now};const records=[record(),record(2,{table:'usage_baselines',rowKey:{host_id:baseline.host_id,session_id:baseline.session_id},row:baseline}),record(3,{table:'usage_daily',rowKey:{host_id:daily.host_id,session_id:daily.session_id,day:daily.day,segment_key:segment},row:daily}),record(4,{table:'account_usage_observations',rowKey:{sequence:1},row:a}),record(5,{table:'account_usage_daily',rowKey:{host_id:d.host_id,account_identity:d.account_identity,day:d.day},row:d})];const result=await f.run(records);assert.equal(result.code,0,result.stderr);const exported=await launch(f.config,undefined,['--query']);assert.equal(exported.code,0,exported.stderr);assert.equal(exported.stdout,encode(records).toString());
});
test('full 366-day account payload without a valid usage time survives byte-exact archive/export beyond the old 8KiB limit',async t=>{
 const f=await fixture(t),buckets=Array.from({length:366},(_,i)=>({startDate:new Date(Date.UTC(2024,0,1+i)).toISOString().slice(0,10),tokens:Number.MAX_SAFE_INTEGER-i})),missing=accountRecord(1,buckets),preEpoch=accountRecord(2,[{startDate:'0000-02-29',tokens:0},{startDate:'2026-10-19',tokens:123}],{usageObservedAt:'1969-12-31T23:59:59.999Z'});assert.ok(Buffer.byteLength(missing.row.payload)>8192);assert.equal(preEpoch.row.usage_ms,null);const r=await f.run([missing,preEpoch]);assert.equal(r.code,0,r.stderr);const exported=await launch(f.config,undefined,['--query']);assert.equal(exported.code,0,exported.stderr);assert.equal(exported.stdout,encode([missing,preEpoch]).toString());assert.equal((await launch(f.config,undefined,['--verify'])).json().verified,true);
});
test('full account buckets reject unsorted/duplicate/invalid dates, unsafe counts, extra fields and oversized payloads',async t=>{
 const f=await fixture(t),a={startDate:'2026-10-18',tokens:1},b={startDate:'2026-10-19',tokens:2},cases=[[b,a],[a,a],[{...a,startDate:'2026-02-30'}],[{...a,tokens:-1}],[{...a,tokens:null}],[{...a,tokens:true}],[{...a,tokens:9007199254740992}],[{...a,password:'TEST_ONLY_hidden'}],Array.from({length:367},(_,i)=>({startDate:new Date(Date.UTC(2024,0,1+i)).toISOString().slice(0,10),tokens:0}))];for(let i=0;i<cases.length;i++){const r=await f.run([accountRecord(i+1,cases[i])]);assert.notEqual(r.code,0);assert.equal(r.stdout,'');assert.ok(!r.stderr.includes('TEST_ONLY_hidden'));}const tooLarge=accountRecord(20,[a]);tooLarge.row.payload+=' '.repeat(32769-Buffer.byteLength(tooLarge.row.payload));tooLarge.row.sample_key=digest(tooLarge.row.payload);assert.equal(Buffer.byteLength(tooLarge.row.payload),32769);assert.notEqual((await f.run([tooLarge])).code,0);const fabricated=accountRecord(21,[a],{usageObservedAt:'1969-12-31T23:59:59.999Z'});fabricated.row.usage_ms=0;assert.notEqual((await f.run([fabricated])).code,0);
});

test('V1 optional account fields preserve exact presence, decimal strings and legacy bytes without accepting unsupported detail data',async t=>{
 const f=await fixture(t),base={limitId:'codex',limitName:null,planType:'pro',primary:null,secondary:null},enums=['rate_limit_reached','workspace_owner_credits_depleted','workspace_member_credits_depleted','workspace_owner_usage_limit_reached','workspace_member_usage_limit_reached'];
 const old=accountRecord(200,null),records=[old,...enums.map((rateLimitReachedType,i)=>accountRecord(201+i,null,{ordinaryUsageAllowed:i%2===0,rateLimitResetCredits:{availableCount:0,credits:[]},threadUsage:null,limits:[{...base,credits:{hasCredits:true,unlimited:false,balance:'12345.6789000000'},spendControlReached:false,individualLimit:null,normalModelSlug:'gpt-test/fast',rateLimitReachedType}]})),accountRecord(210,null,{ordinaryUsageAllowed:null,rateLimitResetCredits:null,threadUsage:null,limits:[{...base,credits:null,spendControlReached:null,individualLimit:null,normalModelSlug:null,rateLimitReachedType:null}]}),accountRecord(211,null,{rateLimitResetCredits:{availableCount:1},limits:[{...base,credits:{hasCredits:false,unlimited:true}}]}),accountRecord(212,null,{rateLimitResetCredits:{availableCount:2,credits:null},limits:[{...base,credits:{hasCredits:false,unlimited:false,balance:null}}]})];
 const raw=encode(records),accepted=await f.run(records);assert.equal(accepted.code,0,accepted.stderr);assert.equal(accepted.json().version,1);assert.equal(accepted.json().rawSha256,digest(raw));
 const query=await launch(f.config,undefined,['--query','--table','account_usage_observations']);assert.equal(query.code,0,query.stderr);assert.equal(query.stdout,raw.toString());
 const exported=query.stdout.trim().split('\n').map(JSON.parse),legacyPayload=JSON.parse(exported[0].row.payload);assert.equal(exported[0].row.payload,old.row.payload);
 for(const key of ['ordinaryUsageAllowed','rateLimitResetCredits','threadUsage'])assert.equal(Object.hasOwn(legacyPayload,key),false);
 const extended=JSON.parse(exported[1].row.payload);assert.equal(extended.limits[0].credits.balance,'12345.6789000000');assert.equal(typeof extended.limits[0].credits.balance,'string');
 assert.equal((await launch(f.config,undefined,['--verify'])).json().verified,true);
});

test('actual JavaScript account sanitizer payloads archive in Python with unchanged legacy bytes and optional field presence',async t=>{
 const f=await fixture(t),base={limitId:'codex',limitName:null,planType:'pro',primary:null,secondary:null},legacy=accountRecord(220,null);
 const source=[legacy,accountRecord(221,null,{ordinaryUsageAllowed:true,rateLimitResetCredits:{availableCount:0,credits:[]},threadUsage:null,limits:[{...base,credits:{hasCredits:true,unlimited:false,balance:'000.0000000000000000001'},spendControlReached:false,individualLimit:null,normalModelSlug:'TEST_ONLY/model-fast',rateLimitReachedType:'workspace_owner_credits_depleted'}]}),accountRecord(222,null,{rateLimitResetCredits:{availableCount:0},limits:[{...base,credits:{hasCredits:false,unlimited:true}}]})];
 const normalized=source.map(record=>{
  const payload=JSON.stringify(sanitizeAccountUsage(JSON.parse(record.row.payload)));
  return {...record,row:{...record.row,payload,sample_key:digest(payload)}};
 });
 assert.equal(normalized[0].row.payload,legacy.row.payload);
 const accepted=await f.run(normalized);assert.equal(accepted.code,0,accepted.stderr);
 const exported=await launch(f.config,undefined,['--query']);assert.equal(exported.stdout,encode(normalized).toString());
 const last=JSON.parse(normalized[2].row.payload);assert.equal(Object.hasOwn(last,'ordinaryUsageAllowed'),false);assert.equal(Object.hasOwn(last,'threadUsage'),false);assert.equal(Object.hasOwn(last.rateLimitResetCredits,'credits'),false);assert.equal(Object.hasOwn(last.limits[0].credits,'balance'),false);
});

test('optional account extensions strictly reject unknown/private keys, unsafe values and unqualified nonempty detail objects',async t=>{
 const f=await fixture(t),secret='TEST_ONLY_private_account_must_not_echo',base={limitId:'codex',limitName:null,planType:'pro',primary:null,secondary:null};
 const extras=[
  {ordinaryUsageAllowed:0},{ordinaryUsageAllowed:'true'},{threadUsage:{}},{threadUsage:{model:secret}},
  {rateLimitResetCredits:{}},{rateLimitResetCredits:[]},{rateLimitResetCredits:{availableCount:-1}},{rateLimitResetCredits:{availableCount:true}},{rateLimitResetCredits:{availableCount:9007199254740992}},
  {rateLimitResetCredits:{availableCount:0,credits:[{}]}},{rateLimitResetCredits:{availableCount:0,credits:secret}},{rateLimitResetCredits:{availableCount:0,password:secret}},
  ...[
   {credits:{}},{credits:[]},{credits:{hasCredits:1,unlimited:false}},{credits:{hasCredits:true,unlimited:null}},
   ...['','-1','+1','1e3','1.',' .5','.5','1,000','9'.repeat(65),1,true].map(balance=>({credits:{hasCredits:true,unlimited:false,balance}})),
   {credits:{hasCredits:true,unlimited:false,password:secret}},{spendControlReached:0},{spendControlReached:'false'},
   {individualLimit:{}},{individualLimit:{limit:1}},{normalModelSlug:''},{normalModelSlug:'gpt test'},{normalModelSlug:'x'.repeat(129)},{normalModelSlug:3},
   {rateLimitReachedType:'unknown'},{rateLimitReachedType:'RATE_LIMIT_REACHED'},{rateLimitReachedType:false},{privateKey:secret}
  ].map(value=>({limits:[{...base,...value}]}))
 ];
 for(const [i,extra] of extras.entries()){
  const result=await f.run([accountRecord(300+i,null,extra)]);assert.notEqual(result.code,0,'accepted invalid extension '+i);assert.equal(result.stdout,'');assert.equal(JSON.parse(result.stderr).durable,false);assert.ok(!result.stderr.includes(secret));
 }
 assert.deepEqual(await fs.readdir(f.archiveDirectory),[]);assert.equal(await fs.stat(path.join(f.catalogDirectory,'catalog.sqlite')).then(()=>true,()=>false),false);
});
test('database-only index can rebuild from verified immutable files and preserve full raw history',async t=>{
 const f=await fixture(t);await f.run([record(),record(2)]);await f.run([record(3)]);await fs.rm(path.join(f.catalogDirectory,'catalog.sqlite'));const rebuild=await launch(f.config,undefined,['--rebuild']);assert.equal(rebuild.code,0,rebuild.stderr);assert.equal(rebuild.json().distinctItems,3);assert.equal(rebuild.json().segments,2);const verify=await launch(f.config,undefined,['--verify']);assert.equal(verify.code,0,verify.stderr);const query=await launch(f.config,undefined,['--query']);assert.deepEqual(query.stdout.trim().split('\n').map(JSON.parse).map(r=>r.itemId).sort(),[1,2,3].map(i=>record(i).itemId).sort());
});
test('crash after cold file publication can recover an absent manifest/catalog without overwriting bytes',async t=>{
 const f=await fixture(t),first=(await f.run([record()])).json(),target=path.join(f.archiveDirectory,first.segment);await fs.rm(target.replace(/\.gz$/,'.manifest.json'));await fs.rm(path.join(f.catalogDirectory,'catalog.sqlite'));const retry=await f.run([record()]);assert.equal(retry.code,0,retry.stderr);assert.equal(retry.json().rawSha256,first.rawSha256);assert.equal((await launch(f.config,undefined,['--verify'])).json().verified,true);
});
test('manifest tampering or a catalog-referenced missing segment fails verification and retry',async t=>{
 const f=await fixture(t),ack=(await f.run([record()])).json(),target=path.join(f.archiveDirectory,ack.segment),manifest=target.replace(/\.gz$/,'.manifest.json');await fs.writeFile(manifest,'{}');assert.notEqual((await launch(f.config,undefined,['--verify'])).code,0);assert.notEqual((await f.run([record()])).code,0);await fs.rm(target);assert.notEqual((await launch(f.config,undefined,['--verify'])).code,0);
});
test('host/project/time filtering and cursor paging do not interpolate SQL-looking labels',async t=>{
 const f=await fixture(t),label="TEST_ONLY_'; DROP TABLE items; --",a=record(1,{row:row(1,{project:label})}),b=record(2,{row:row(2,{host_id:'TEST_ONLY_other'})});await f.run([a,b]);const query=await launch(f.config,undefined,['--query','--host','TEST_ONLY_laptop','--project',label,'--from-ms',String(now),'--to-ms',String(now),'--limit','1']);assert.equal(query.code,0,query.stderr);assert.equal(query.stdout,encode([a]).toString());const metadata=JSON.parse(query.stderr),next=await launch(f.config,undefined,['--query','--after',String(metadata.nextCursor)]);assert.equal(next.stdout,encode([b]).toString());assert.equal((await launch(f.config,undefined,['--status'])).json().items,2);
});
test('concurrent receivers serialize immutable publication and exact-item dedup',async t=>{
 const f=await fixture(t),results=await Promise.all([f.run([record(),record(2)]),f.run([record(),record(2)])]);for(const r of results)assert.equal(r.code,0,r.stderr);assert.deepEqual(results[0].json(),results[1].json());assert.equal((await launch(f.config,undefined,['--status'])).json().items,2);
});
test('a changed receiver UUID is refused instead of silently accepting an unrelated catalog',async t=>{
 const f=await fixture(t);await f.run([record()]);const config=JSON.parse(await fs.readFile(f.config,'utf8'));config.receiverId='2c8391d1-13a6-4c56-91bf-d51c47954455';await fs.writeFile(f.config,JSON.stringify(config));const r=await f.run([record(2)]);assert.notEqual(r.code,0);assert.match(r.stderr,/identity changed/);
});
test('archive/catalog symlinks or Windows junctions cannot redirect writes outside the configured roots',async t=>{
 const f=await fixture(t),outside=path.join(f.directory,'outside');await fs.mkdir(outside);await fs.symlink(outside,f.archiveDirectory,process.platform==='win32'?'junction':'dir');const r=await f.run([record()]);assert.notEqual(r.code,0);assert.match(r.stderr,/symlinks or reparse/);assert.deepEqual(await fs.readdir(outside),[]);
});
test('POSIX group/world writable non-sticky ancestors cannot redirect private archive children',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t),parent=path.join(f.directory,'unsafe-parent');await fs.mkdir(parent,{mode:0o777});await fs.chmod(parent,0o777);const config=JSON.parse(await fs.readFile(f.config,'utf8'));config.archiveDirectory=path.join(parent,'private-child');await fs.writeFile(f.config,JSON.stringify(config),{mode:0o600});const r=await f.run([record()]);assert.notEqual(r.code,0);assert.match(r.stderr,/ancestor cannot be writable/);assert.equal(await fs.stat(config.archiveDirectory).then(()=>true,()=>false),false);
});
test('NAS mount pin mismatch fails closed before creating an archive/catalog or accepting data',async t=>{
 const f=await fixture(t),config=JSON.parse(await fs.readFile(f.config,'utf8'));config.expectedArchiveMount={mountPoint:'/TEST_ONLY_missing_nas',source:'nas:/TEST_ONLY',filesystem:'nfs4'};await fs.writeFile(f.config,JSON.stringify(config));const r=await f.run([record()]);assert.notEqual(r.code,0);assert.match(r.stderr,/mount identity/);assert.equal(await fs.stat(f.archiveDirectory).then(()=>true,()=>false),false);assert.equal(await fs.stat(f.catalogDirectory).then(()=>true,()=>false),false);
});
test('Timescale projection stays disabled until explicitly configured; cold history does not depend on SQL availability',async t=>{
 const f=await fixture(t);await f.run([record()]);const denied=await launch(f.config,undefined,['--project-timescale']);assert.notEqual(denied.code,0);assert.match(denied.stderr,/not enabled/);assert.equal((await launch(f.config,undefined,['--verify'])).json().verified,true);const status=(await launch(f.config,undefined,['--status'])).json();assert.equal(status.timescalePendingSegments,1);
});
test('synthetic SQL failure/timeout keeps every cold segment pending and the local peer command contains no password',async t=>{
 const f=await fixture(t);await f.run([record()]);const source=`import importlib.util,sys,json,subprocess,types
spec=importlib.util.spec_from_file_location('archive_receiver',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
c=m.load_config(sys.argv[2]);c['timescale']={'enabled':True,'database':'codexcontrol_archive','psqlPath':'/TEST_ONLY/psql'}
calls=[]
def fail(command,**kwargs):
 calls.append(command)
 assert '--no-password' in command and '--host=/var/run/postgresql' in command
 assert not any(key.startswith('PGPASS') for key in kwargs['env'])
 assert b'COPY codexcontrol_projection_batch(value) FROM STDIN;' in kwargs['input']
 return types.SimpleNamespace(returncode=1)
m.subprocess.run=fail
try:m.project_timescale(c,1);raise Exception('unexpected projection success')
except m.Refusal:pass
def timeout(*args,**kwargs):raise subprocess.TimeoutExpired('TEST_ONLY_psql',60)
m.subprocess.run=timeout
try:m.project_timescale(c,1);raise Exception('unexpected timeout success')
except m.Refusal:pass
print(json.dumps({'calls':len(calls),'pending':m.status(c)['timescalePendingSegments'],'verified':m.verify(c)['verified']}))
`;const result=await new Promise((resolve,reject)=>{const p=spawn(PYTHON,['-c',source,script,f.config],{windowsHide:true});let stdout='',stderr='';p.on('error',reject);p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);p.on('close',code=>resolve({code,stdout,stderr}));});assert.equal(result.code,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{calls:1,pending:1,verified:true});
});
test('Timescale template guards the dedicated database, global item idempotency and indefinite compressed versions',async()=>{
 const sql=await fs.readFile(new URL('../scripts/archive-timescale.sql',import.meta.url),'utf8');assert.match(sql,/current_database\(\) <> 'codexcontrol_archive'/);assert.match(sql,/item_id text PRIMARY KEY/);assert.match(sql,/PRIMARY KEY\(recorded_at,item_id\)/);assert.match(sql,/add_columnstore_policy/);assert.match(sql,/add_compression_policy/);assert.match(sql,/INTERVAL ''7 days''/);assert.doesNotMatch(sql,/\b(?:add_retention_policy|drop_chunks|DELETE FROM|TRUNCATE)\b/i);assert.match(sql,/SECURITY INVOKER/);assert.match(sql,/pg_temp\.codexcontrol_projection_batch/);
});
test('Timescale latest-day view qualifies account source/day time and orders causal versions before capture/restore sequence ties',async()=>{
 const sql=await fs.readFile(new URL('../scripts/archive-timescale.sql',import.meta.url),'utf8'),view=sql.slice(sql.indexOf('CREATE OR REPLACE VIEW codexcontrol_archive.latest_daily_versions'),sql.indexOf('DO $permissions$'));assert.match(view,/WITH qualified AS/);assert.match(view,/source_table='usage_daily'\s+OR \(source_table='account_usage_daily'/);assert.match(view,/\(row_data->>'observed_ms'\)::bigint <= \(row_data->>'received_ms'\)::bigint/);assert.match(view,/\(row_data->>'day'\) <= to_char\(\s+to_timestamp\(\(row_data->>'received_ms'\)::numeric\/1000\) AT TIME ZONE 'UTC','YYYY-MM-DD'\)/);const columns=['recorded_at','item_id','source_sequence','source_table','source_row_key','host_id','project','row_data','record_sha256','segment_sha256'];
 const qualified=view.match(/WITH qualified AS\s*\(\s*SELECT\s+([\s\S]*?)\s+FROM codexcontrol_archive\.usage_versions/),latest=view.match(/SELECT DISTINCT ON \(source_table,source_row_key\)\s+([\s\S]*?)\s+FROM qualified/);
 assert.ok(qualified,'qualified rows must retain the version columns');assert.ok(latest,'latest rows must retain the version columns');
 assert.deepEqual(qualified[1].split(',').map(column=>column.trim()),columns);assert.deepEqual(latest[1].split(',').map(column=>column.trim()),columns);
 assert.match(view,/ORDER BY source_table,source_row_key,\s+CASE WHEN source_table='account_usage_daily' THEN \(row_data->>'observed_ms'\)::bigint\s+ELSE \(row_data->>'last_ms'\)::bigint END DESC,\s+CASE WHEN source_table='account_usage_daily' THEN \(row_data->>'received_ms'\)::bigint END DESC,\s+recorded_at DESC,source_sequence DESC,item_id DESC/);assert.doesNotMatch(view,/\b(?:DELETE|UPDATE|TRUNCATE|DROP)\b/i);
});
