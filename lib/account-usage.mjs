// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {sanitizeNativeEnvelope,nativeAnalyticsReference} from './native-account-analytics.mjs';
// Credential-free account observations. Account totals never enter scoped snapshots.
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const summaryFields=['lifetimeTokens','peakDailyTokens','longestRunningTurnSec','currentStreakDays','longestStreakDays'];
const statuses=new Set(['available','partial','stale','unavailable']);
const errors=new Set(['spawn-failed','process-exited','output-limit','invalid-response','unexpected-request','unsupported-method','rpc-unavailable','timeout','stopped','account-unavailable','method-refused']);
const reachedTypes=new Set(['rate_limit_reached','workspace_owner_credits_depleted','workspace_member_credits_depleted','workspace_owner_usage_limit_reached','workspace_member_usage_limit_reached']);
const limitOptionalKeys=['credits','spendControlReached','individualLimit','normalModelSlug','rateLimitReachedType'],limitStateKeys=['ordinaryUsageAllowed','rateLimitResetCredits'],usageOptionalKeys=['threadUsage'];
const fail=()=>{throw Object.assign(new Error('Invalid account observation'),{status:400});};
function shape(v,keys){if(!object(v)||Object.keys(v).some(k=>!keys.includes(k)))fail();return v;}
function count(v){if(v===undefined||v===null)return null;if(!Number.isSafeInteger(v)||v<0)fail();return v;}
function text(v,max=128){if(v===undefined||v===null)return null;if(typeof v!=='string'||!v||v.length>max||!v.isWellFormed()||/[\x00-\x1f\x7f]/.test(v))fail();return v;}
function stamp(v){if(v===undefined||v===null)return null;if(typeof v!=='string'||v.length>40||!Number.isFinite(Date.parse(v)))fail();return new Date(v).toISOString();}
function windowOf(v){if(v===undefined||v===null)return null;shape(v,['usedPercent','windowDurationMins','resetsAt']);if(v.usedPercent!==null&&v.usedPercent!==undefined&&(typeof v.usedPercent!=='number'||!Number.isFinite(v.usedPercent)||v.usedPercent<0||v.usedPercent>100))fail();return {usedPercent:v.usedPercent??null,windowDurationMins:count(v.windowDurationMins),resetsAt:count(v.resetsAt)};}
const nullableBoolean=v=>{if(v!==null&&typeof v!=='boolean')fail();return v;};
const reportedNull=v=>{if(v!==null)fail();return null;};
function creditsOf(v){
 if(v===null)return null;shape(v,['hasCredits','unlimited','balance']);if(typeof v.hasCredits!=='boolean'||typeof v.unlimited!=='boolean')fail();
 const result={hasCredits:v.hasCredits,unlimited:v.unlimited};if(Object.hasOwn(v,'balance')){if(v.balance!==null&&(typeof v.balance!=='string'||v.balance.length>64||!/^\d+(?:\.\d+)?$/.test(v.balance)))fail();result.balance=v.balance;}return result;
}
function resetCreditsOf(v){
 if(v===null)return null;shape(v,['availableCount','credits']);const availableCount=count(v.availableCount);if(availableCount===null)fail();const result={availableCount};
 if(Object.hasOwn(v,'credits')){if(v.credits!==null&&(!Array.isArray(v.credits)||v.credits.length!==0))fail();result.credits=v.credits===null?null:[];}return result;
}
function optionalLimitFields(v){
 const result={};for(const key of limitOptionalKeys)if(Object.hasOwn(v,key)){
  const value=v[key];if(key==='credits')result[key]=creditsOf(value);else if(key==='spendControlReached')result[key]=nullableBoolean(value);else if(key==='individualLimit')result[key]=reportedNull(value);
  else if(key==='normalModelSlug'){if(value!==null&&(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value)))fail();result[key]=value;}
  else{if(value!==null&&!reachedTypes.has(value))fail();result[key]=value;}
 }return result;
}
function copyOptionalSection(target,source,keys){for(const key of keys){if(Object.hasOwn(source,key))target[key]=source[key];else delete target[key];}}
export function sanitizeAccountUsage(v){
 if(v===undefined||v===null)return null;
 shape(v,['version','source','status','observedAt','lastAttemptAt','accountKey','planType','limitsObservedAt','usageObservedAt','limits','summary','dailyUsageBuckets','errorCode','nativeAnalytics',...limitStateKeys,...usageOptionalKeys]);
 if(v.version!==1||v.source!=='codex-app-server'||!statuses.has(v.status))fail();
 if(v.accountKey!==null&&v.accountKey!==undefined&&(typeof v.accountKey!=='string'||!/^[a-f0-9]{64}$/.test(v.accountKey)))fail();
 if(!Array.isArray(v.limits)||v.limits.length>8)fail();
 const limits=v.limits.map(q=>{shape(q,['limitId','limitName','planType','primary','secondary',...limitOptionalKeys]);return {limitId:text(q.limitId),limitName:text(q.limitName),planType:text(q.planType),primary:windowOf(q.primary),secondary:windowOf(q.secondary),...optionalLimitFields(q)};});
 if(new Set(limits.map(q=>q.limitId)).size!==limits.length||limits.some(q=>!q.limitId))fail();
 shape(v.summary,summaryFields);const summary=Object.fromEntries(summaryFields.map(k=>[k,count(v.summary[k])]));
 let dailyUsageBuckets=null;
 if(v.dailyUsageBuckets!==null&&v.dailyUsageBuckets!==undefined){if(!Array.isArray(v.dailyUsageBuckets)||v.dailyUsageBuckets.length>366)fail();const dates=new Set();dailyUsageBuckets=v.dailyUsageBuckets.map(b=>{shape(b,['startDate','tokens']);if(typeof b.startDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(b.startDate)||!Number.isFinite(Date.parse(b.startDate+'T00:00:00Z'))||new Date(b.startDate+'T00:00:00Z').toISOString().slice(0,10)!==b.startDate||dates.has(b.startDate))fail();dates.add(b.startDate);const tokens=count(b.tokens);if(tokens===null)fail();return {startDate:b.startDate,tokens};}).sort((a,b)=>a.startDate.localeCompare(b.startDate));}
 if(v.errorCode!==null&&v.errorCode!==undefined&&!errors.has(v.errorCode))fail();
 const result={version:1,source:v.source,status:v.status,observedAt:stamp(v.observedAt),lastAttemptAt:stamp(v.lastAttemptAt),accountKey:v.accountKey??null,planType:text(v.planType),limitsObservedAt:stamp(v.limitsObservedAt),usageObservedAt:stamp(v.usageObservedAt),limits,summary,dailyUsageBuckets,errorCode:v.errorCode??null};
 // Append only reported keys. Old canonical observations keep their exact byte
 // shape, so existing durable receipts still cover the same record versions.
 if(Object.hasOwn(v,'ordinaryUsageAllowed'))result.ordinaryUsageAllowed=nullableBoolean(v.ordinaryUsageAllowed);
 if(Object.hasOwn(v,'rateLimitResetCredits'))result.rateLimitResetCredits=resetCreditsOf(v.rateLimitResetCredits);
 if(Object.hasOwn(v,'nativeAnalytics'))result.nativeAnalytics=sanitizeNativeEnvelope(v.nativeAnalytics);
 if(Object.hasOwn(v,'threadUsage'))result.threadUsage=reportedNull(v.threadUsage);
 return result;
}

const age=(at,now)=>{const n=Date.parse(at);return Number.isFinite(n)&&n<=now?now-n:null;};
function accountProjection(sources,now){
 const groups=new Map();
 const sectionTime=value=>{const at=Date.parse(value);return Number.isFinite(at)&&at<=now?at:-Infinity;};
 for(const source of sources.slice(0,65)){
  let value;try{value=sanitizeAccountUsage(source.accountUsage);}catch{continue;}if(!value)continue;
  if(value.nativeAnalytics)value.nativeAnalytics=nativeAnalyticsReference(value.nativeAnalytics);
  const key=value.accountKey||'unlinked:'+source.hostId,previous=groups.get(key);
  const candidate={...value,hostIds:[source.hostId],linked:!!value.accountKey};
  if(!previous){groups.set(key,candidate);continue;}
  previous.hostIds.push(source.hostId);
  if(value.nativeAnalytics&&sectionTime(value.nativeAnalytics.observedAt)>sectionTime(previous.nativeAnalytics?.observedAt))previous.nativeAnalytics=value.nativeAnalytics;
  // Each section chooses its own most recent report; a partial poll cannot
  // refresh older limits or token history by borrowing another section's date.
  if(sectionTime(value.limitsObservedAt)>sectionTime(previous.limitsObservedAt)){previous.limits=value.limits;previous.limitsObservedAt=value.limitsObservedAt;copyOptionalSection(previous,value,limitStateKeys);}
  if(sectionTime(value.usageObservedAt)>sectionTime(previous.usageObservedAt)){previous.summary=value.summary;previous.dailyUsageBuckets=value.dailyUsageBuckets;previous.usageObservedAt=value.usageObservedAt;copyOptionalSection(previous,value,usageOptionalKeys);}
  if(sectionTime(value.lastAttemptAt)>sectionTime(previous.lastAttemptAt)){previous.lastAttemptAt=value.lastAttemptAt;previous.status=value.status;previous.errorCode=value.errorCode;}
  if(sectionTime(value.observedAt)>sectionTime(previous.observedAt)){previous.observedAt=value.observedAt;previous.status=value.status;previous.planType=value.planType;previous.errorCode=value.errorCode;}
 }
 const accounts=[...groups.values()].map(value=>{
  const limitsAge=age(value.limitsObservedAt,now),usageAge=age(value.usageObservedAt,now);
  const stale=limitsAge===null||usageAge===null||limitsAge>120000||usageAge>120000;
  const limitsStatus=limitsAge===null||limitsAge>120000||value.status==='stale'||value.status==='unavailable'?'stale':'available';
  const usageStatus=usageAge===null||usageAge>120000?'stale':'available';
  return {...value,limitsStatus,usageStatus,status:value.observedAt?(stale?'stale':value.status):'unavailable',limitsAgeMs:limitsAge,usageAgeMs:usageAge};
 });
 const one=accounts.length===1?accounts[0]:null;
 const rateLimitsByLimitId=one?Object.fromEntries(one.limits.map(q=>[q.limitId,{...q,observedAt:one.limitsObservedAt}])):{};
 return {scope:'account-wide',status:one?.status||(accounts.length?'multiple':'unavailable'),source:'codex-app-server',observedAt:one?.observedAt??null,limitsObservedAt:one?.limitsObservedAt??null,usageObservedAt:one?.usageObservedAt??null,accountCount:accounts.length,accounts,rateLimitsByLimitId,summary:one?.summary??null,dailyUsageBuckets:one?.dailyUsageBuckets??null,reason:accounts.length?null:'No enabled account observer has reported. Account credentials remain on the source machine.'};
}

export function activeTokenUsage(snapshot,now=Date.now()){
 const hosts=new Map((snapshot.hosts||[]).map(h=>[h.id,h])),seen=new Set(),rows=[];
 if(snapshot.host?.id&&!hosts.has(snapshot.host.id))hosts.set(snapshot.host.id,{status:'online'});
 for(const s of snapshot.sessions||[]){
  const key=JSON.stringify([s.hostId,s.id]);if(seen.has(key))continue;seen.add(key);
  const activityAge=age(s.lastEventAt,now),usageAge=age(s.usageObservedAt,now);
  const reportedActive=s.state==='Turn started';
  // Long-running files may be read from a bounded tail that omits turn/start.
  // Fresh usage plus fresh source activity is then a recent observation, not
  // evidence of a verified provider lifecycle. Terminal/waiting states stay out.
  const recentUnknown=s.state==='Unknown'&&activityAge!==null&&activityAge<=120000&&usageAge!==null&&usageAge<=120000;
  if(hosts.get(s.hostId)?.status!=='online'||s.forkedFrom||s.role==='execution-target'||!reportedActive&&!recentUnknown||activityAge===null||activityAge>300000)continue;
  const tokens={};for(const k of ['input_tokens','cached_input_tokens','output_tokens','total_tokens']){const n=s.tokens?.[k];tokens[k]=Number.isSafeInteger(n)&&n>=0?n:null;}
  rows.push({hostId:s.hostId,sessionId:s.id,project:s.project??null,activityBasis:reportedActive?'reported-turn':'recent-source-activity',observedAt:usageAge===null?null:s.usageObservedAt,ageMs:usageAge,tokens});
 }
 const sum=k=>{const values=rows.filter(r=>r.ageMs!==null&&r.ageMs<=120000&&r.tokens[k]!==null);if(!values.length)return null;const total=values.reduce((n,r)=>n+r.tokens[k],0);return Number.isSafeInteger(total)?total:null;};
 const dates=rows.map(r=>Date.parse(r.observedAt)).filter(Number.isFinite);
 const fresh=rows.filter(r=>r.ageMs!==null&&r.ageMs<=120000).length;
 return {status:rows.length?(fresh===rows.length?'observed':fresh?'partial':'stale'):'idle',scope:'visible active sessions',label:'Observed cumulative counters for recently active sessions; fork totals excluded; copied sessions may overlap',observedAt:dates.length?new Date(Math.max(...dates)).toISOString():null,sessions:rows.length,inputTokens:sum('input_tokens'),cachedInputTokens:sum('cached_input_tokens'),outputTokens:sum('output_tokens'),totalTokens:sum('total_tokens'),workers:rows,activityWindowMs:300000,complete:false};
}

export function buildAccountUsageResponse({sources=[],snapshot={},viewer,now=Date.now()}={}){
 const permitted=viewer?.role==='admin'&&viewer.hostIds===null&&viewer.projectIds===null;
 return {observedAt:new Date(now).toISOString(),accountUsage:permitted?accountProjection(sources,now):{status:'restricted',scope:'account-wide',observedAt:null,accountCount:0,accounts:[],rateLimitsByLimitId:{},summary:null,dailyUsageBuckets:null,reason:'Account-wide usage requires an administrator account.'},activeUsage:activeTokenUsage(snapshot,now)};
}
