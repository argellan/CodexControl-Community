// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {renderAccountHistory} from './account-history-view.mjs';
// Read-only account presentation. This module never reads credentials or changes worker state.
import {allowancePercent,allowanceChart} from './allowance-history.mjs';
import {mountProfileEditor} from './profile-editor.mjs';
import {DEFAULT_TOKEN_PALETTE} from './token-palette.mjs';
import {renderUsageAnalytics,renderObservedRatios} from './usage-analytics-view.mjs';
// SPDX-License-Identifier: MIT
// Author: Bishop Crockett; Owner: Argellan.com
// Reading state belongs to a disclosure's semantic identity, not its position.
const all=(root,selector)=>[...root.querySelectorAll(selector)];
function key(node){
 const card=node.closest('.native-chart-card'),section=node.closest('section[id]');
 return JSON.stringify([section?.id||'',card?.querySelector('h4')?.textContent||'',node.querySelector('summary')?.textContent?.replace(/\s*\([^)]*\)\s*$/,'').trim()]);
}
function scrollKey(node,root){
 const detail=node.closest('details'),parent=detail||root;
 return JSON.stringify([detail?key(detail):node.closest('section[id]')?.id||'',all(parent,'.usage-table-scroll').indexOf(node)]);
}
export function captureUsageReading(root,active,dialog){
 const details=all(root,'details'),scrolls=all(root,'.usage-table-scroll'),detail=active?.closest?.('details'),inside=root.contains?.(active)===true;
 const summary=inside&&active?.tagName==='SUMMARY',scroll=inside&&active?.matches?.('.usage-table-scroll');
 return {open:new Map(details.map(d=>[key(d),d.open])),scrolls:new Map(scrolls.map(d=>[scrollKey(d,root),{top:d.scrollTop,left:d.scrollLeft}])),scrollTop:dialog.scrollTop,
  focus:inside?{id:active.id,action:active.dataset?.accountAction,evidence:active.dataset?.usageFocus,chart:['data-account-days','data-account-heat','data-native-breakdown','data-native-messages'].map(k=>[k,active.getAttribute?.(k)]).find(([,v])=>v!==null&&v!==undefined),detail:detail?key(detail):null,summary,scroll:scroll?scrollKey(active,root):null}:null,
  anchorTop:inside?active.getBoundingClientRect?.().top:null};
}
export function restoreUsageReading(root,state,dialog,fallback){
 const details=all(root,'details'),scrolls=all(root,'.usage-table-scroll');
 for(const d of details)if(state.open.has(key(d)))d.open=state.open.get(key(d));
 for(const d of scrolls)if(state.scrolls.has(scrollKey(d,root))){const position=state.scrolls.get(scrollKey(d,root));d.scrollTop=position.top;d.scrollLeft=position.left;}
 const f=state.focus;let target;
 if(f){
  if(f.id)target=all(root,'[id]').find(n=>n.id===f.id);
  if(!target&&f.action)target=all(root,'[data-account-action]').find(n=>n.dataset.accountAction===f.action);
  if(!target&&f.evidence)target=all(root,'[data-usage-focus]').find(n=>n.dataset.usageFocus===f.evidence);
  if(!target&&f.chart)target=all(root,'['+f.chart[0]+']').find(n=>n.getAttribute(f.chart[0])===f.chart[1]);
  if(!target&&f.summary)target=details.find(d=>key(d)===f.detail)?.querySelector('summary');
  if(!target&&f.scroll)target=scrolls.find(n=>scrollKey(n,root)===f.scroll);
  // A genuinely removed reading returns to a surviving disclosure, then Refresh.
  if(!target&&f.detail)target=details.find(d=>key(d)===f.detail)?.querySelector('summary');
  target||=fallback;
  target?.focus({preventScroll:true});
 }
 dialog.scrollTop=state.scrollTop;
 // Keep a surviving reading at its previous visual position when content above expires.
 if(target&&target!==fallback&&Number.isFinite(state.anchorTop)){
  const top=target.getBoundingClientRect?.().top;
  if(Number.isFinite(top))dialog.scrollTop+=top-state.anchorTop;
 }
}

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const text=(value,max=160)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,max):'';
const count=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
const numeric=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const nonnegative=value=>{const n=numeric(value);return n!==null&&n>=0&&n<=Number.MAX_SAFE_INTEGER?n:null;};
const date=value=>{const n=typeof value==='string'||typeof value==='number'?new Date(value).getTime():NaN;return Number.isFinite(n)?n:null;};
const compact=value=>value===null?'—':new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(value);
const rate=value=>value===null?'—':new Intl.NumberFormat(undefined,{notation:value>=10000?'compact':'standard',maximumFractionDigits:value<10?1:0}).format(value);
const full=value=>value===null?'Unavailable':new Intl.NumberFormat().format(value);
const time=value=>value===null?'Unavailable':new Date(value).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});
const sourceAge=(value,now)=>{const at=date(value);return at===null?'No source reading':at>now?'Source clock ahead':now-at<60000?'Updated '+Math.max(0,Math.floor((now-at)/1000))+'s ago':'Updated '+Math.floor((now-at)/60000)+'m ago';};
const freshness=(value,status,now,maxAge=120000)=>{const at=date(value);return ['unavailable','restricted'].includes(status)?status:at===null||at>now?'unavailable':status==='stale'||now-at>maxAge?'stale':'available';};
const summaryFields=['lifetimeTokens','peakDailyTokens','longestRunningTurnSec','currentStreakDays','longestStreakDays'];

function normalizeAccount(raw={},now,quotaStaleMs=120000){
 const status=['available','partial','stale','unavailable','restricted'].includes(raw.status)?raw.status:'unavailable';
 const limitsAt=Object.hasOwn(raw,'limitsObservedAt')?raw.limitsObservedAt:raw.observedAt,usageAt=Object.hasOwn(raw,'usageObservedAt')?raw.usageObservedAt:raw.observedAt;
 const limits=Array.isArray(raw.limits)?raw.limits.slice(0,16):Object.values(raw.rateLimitsByLimitId||{}).slice(0,16);
 const candidates=[];
 for(const limit of limits){if(!limit||typeof limit!=='object')continue;for(const [slot,window] of Object.entries({primary:limit.primary,secondary:limit.secondary})){if(!window||numeric(window.windowDurationMins)!==10080||numeric(window.usedPercent)===null)continue;candidates.push({slot,usedPercent:window.usedPercent,limitId:text(limit.limitId||limit.limitName,80),remaining:Math.max(0,Math.min(100,100-window.usedPercent)),resetsAt:typeof window.resetsAt==='number'&&Number.isFinite(window.resetsAt)?window.resetsAt*1000:date(window.resetsAt)});}}
 candidates.sort((a,b)=>(a.limitId==='codex'?-1:0)-(b.limitId==='codex'?-1:0)||a.limitId.localeCompare(b.limitId));
 const weekly=candidates[0]||null;
 if(weekly){weekly.state=freshness(limitsAt,raw.limitsStatus||status,now,quotaStaleMs);if(weekly.resetsAt!==null&&weekly.resetsAt<=now)weekly.state='expired';weekly.observedAt=date(limitsAt);}
 const summary=Object.fromEntries(summaryFields.map(key=>[key,count(raw.summary?.[key])]));
 const days=Array.isArray(raw.dailyUsageBuckets)?raw.dailyUsageBuckets:[];
 const validDays=days.filter(row=>/^\d{4}-\d{2}-\d{2}$/.test(row?.startDate||'')&&Number.isFinite(Date.parse(row.startDate))&&count(row.tokens)!==null).sort((a,b)=>a.startDate.localeCompare(b.startDate));
 const daily=validDays.slice(-120).map(row=>({startDate:row.startDate,tokens:row.tokens}));
 return {nativeAnalytics:raw.nativeAnalytics??null,nativeAnalyticsData:raw.nativeAnalyticsData??null,accountKey:raw.accountKey??null,label:text(raw.label||raw.accountLabel||'Codex account',80),status,source:text(raw.source||'Codex account service',100),weekly,summary,daily,activityDays:validDays.slice(-366).map(row=>({startDate:row.startDate,tokens:row.tokens})),dailyCount:validDays.length,usageState:freshness(usageAt,raw.usageStatus||status,now),usageObservedAt:date(usageAt),limitsObservedAt:date(limitsAt),limitsAge:sourceAge(limitsAt,now),usageAge:sourceAge(usageAt,now),limitsState:freshness(limitsAt,raw.limitsStatus||status,now,quotaStaleMs),native:{limits:limits.filter(value=>value&&typeof value==='object').slice(0,8),ordinaryUsageAllowed:typeof raw.ordinaryUsageAllowed==='boolean'?raw.ordinaryUsageAllowed:null,ordinaryReported:Object.hasOwn(raw,'ordinaryUsageAllowed'),resetCredits:raw.rateLimitResetCredits&&typeof raw.rateLimitResetCredits==='object'?raw.rateLimitResetCredits:null,resetReported:Object.hasOwn(raw,'rateLimitResetCredits'),threadReported:Object.hasOwn(raw,'threadUsage')&&raw.threadUsage===null,dailyReported:Array.isArray(raw.dailyUsageBuckets)}};
}

function normalizeBurn(raw={},now,failed){
 const reported=['available','observed','partial','stale','unavailable','warming','warmup','baseline','idle','gap'].includes(raw.status)?raw.status:'unavailable';
 const at=date(raw.observedAt),windowMs=count(raw.windowMs),age=at===null?null:now-at;
 const state=failed?'stale':reported==='unavailable'?'unavailable':at===null||age < -30000?'unavailable':age>120000?'stale':reported==='observed'?'available':['warmup','baseline'].includes(reported)?'warming':reported;
 const known=!['unavailable','warming','gap'].includes(state);
 const fields=['inputTokens','cachedInputTokens','uncachedInputTokens','outputTokens','totalTokens'];
 const rates=['inputPerSecond','cachedInputPerSecond','uncachedInputPerSecond','outputPerSecond'];
 const workers=Array.isArray(raw.workers)?raw.workers.filter(row=>row&&typeof row==='object').slice(0,100).map(row=>({mixedDimensions:row.mixedDimensions===true,...Object.fromEntries(['label','nickname','sessionId','hostLabel','hostId','project'].map(key=>[key,text(row[key],100)])),...Object.fromEntries(fields.map(key=>[key,known?count(row[key]):null])),...Object.fromEntries(rates.map(key=>[key,known?nonnegative(row[key]):null]))})):[];
 return {state,ratios:raw.ratios&&typeof raw.ratios==='object'?raw.ratios:null,observedAt:at,windowMs:windowMs&&windowMs<=3600000?windowMs:null,workers,workerCount:count(raw.workerCount)??(Array.isArray(raw.workers)?raw.workers.length:count(raw.workers)),...Object.fromEntries(fields.map(key=>[key,known?count(raw[key]):null])),...Object.fromEntries(rates.map(key=>[key,known?nonnegative(raw[key]):null]))};
}


const advisoryLabels=Object.freeze({OBSERVING:'Observing',CLOSEOUT_RECOMMENDED:'Closeout recommended',STOP_RECOMMENDED:'Stop recommended'});
const advisoryReasons=Object.freeze({
 WEEKLY_LIMIT:'Weekly limit reached',DEADLINE:'Deadline reached',TELEMETRY_STALE_OR_UNKNOWN:'Usage source stale or unavailable',
 TELEMETRY_RESET_OR_REPLENISHMENT:'Allowance reset or replenished',TELEMETRY_WINDOW_ENDED:'Allowance window ended',
 ACCOUNT_BINDING_CHANGED:'Account binding changed',PROVIDER_USAGE_DISALLOWED:'Provider usage unavailable',
 USAGE_SOURCE_CHANGED:'Usage source changed',USAGE_TIME_UNCERTAIN:'Usage time uncertain',OBSERVED_USAGE_UNKNOWN:'Token usage unknown',
 OBSERVED_USAGE_INVALID:'Token reading invalid',OBSERVED_USAGE_CONFLICT:'Token readings conflict',OBSERVED_IDENTITY_CONFLICT:'Usage identity conflict',
 CLOCK_ROLLBACK:'Clock moved backwards',TOKEN_LIMIT:'Token allowance reached',OWNER_STOP:'Owner stop recorded',
 CLOSEOUT_TIME_RESERVED:'Time reserved for closeout',CLOSEOUT_WEEKLY_RESERVED:'Allowance reserved for closeout'
});
export function normalizeSpendingAdvisory(read={}, {now=Date.now(),restricted=false}={}){
 const empty=(kind,label,reason)=>({kind,label,reason,weeklyIncrease:null,weeklyBudget:null,deadline:null,retained:false});
 if(restricted||read.state==='restricted')return empty('restricted','Administrator access required','Available to unrestricted administrators');
 const raw=read.value;
 if(!raw)return read.state==='loading'?empty('loading','Checking…','Reading the local advisory'):empty('unavailable','Unavailable','No current advisory reading');
 const evaluated=date(raw.evaluatedAt),limitsAt=date(raw.limitsObservedAt),deadline=count(raw.deadlineMs),weeklyIncrease=nonnegative(raw.weeklyIncreasePoints),weeklyBudget=nonnegative(raw.weeklyPointBudget);
 const valid=raw.mode==='ADVISORY'&&Object.hasOwn(advisoryLabels,raw.state)&&typeof raw.stopped==='boolean'&&
  (raw.state==='STOP_RECOMMENDED')===raw.stopped&&raw.nativeDispatchEnforcement==='UNSUPPORTED'&&
  raw.providerAccountSpendingGuarantee===false&&raw.modelStepInterruption===false&&raw.coverage?.complete===false&&
  evaluated!==null&&evaluated<=now&&deadline!==null&&deadline>0&&weeklyBudget!==null&&weeklyBudget>0&&weeklyBudget<=100&&
  (raw.weeklyIncreasePoints===null||weeklyIncrease!==null&&weeklyIncrease<=100);
 if(!valid)return empty('unavailable','Unavailable','No valid advisory reading');
 const sourceStale=limitsAt===null||limitsAt>now||now-limitsAt>120000;
 const stale=['failed','stale'].includes(read.state)||now-evaluated>60000||(sourceStale&&raw.state!=='STOP_RECOMMENDED');
 let label=advisoryLabels[raw.state],kind=raw.state==='STOP_RECOMMENDED'?'stop':raw.state==='CLOSEOUT_RECOMMENDED'?'closeout':'observing';
 let reason=advisoryReasons[raw.reason]||(raw.reason?'Recorded advisory condition':'');
 if(stale){label='Stale · last reading: '+label;kind='stale';reason='Refresh readings to check the current state';}
 else if(deadline<=now&&raw.state!=='STOP_RECOMMENDED'){label='Stop recommended';kind='stop';reason='Deadline passed since the last reading';}
 if(read.state==='refreshing'&&!stale)label+=' · refreshing';
 return {kind,label,reason,weeklyIncrease,weeklyBudget,deadline,retained:stale};
}
export function renderSpendingAdvisory(value){
 const view=value||normalizeSpendingAdvisory();
 const points=view.weeklyIncrease===null?'': ' · Weekly +'+new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(view.weeklyIncrease)+' / '+new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(view.weeklyBudget)+' points';
 const deadline=view.deadline===null?'':' · Deadline '+new Date(view.deadline).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
 const warning=['stop','closeout','stale'].includes(view.kind);
 return `<p id="usage-advisory" class="${warning?'account-status-warning':'account-usage-intro'}" role="note" aria-label="Spending advisory"><strong>Spending advisory · ${esc(view.label)}</strong>${esc(points+deadline)}${view.reason?' · '+esc(view.reason):''}<br>Cannot stop Codex or cap spending · token history incomplete.</p>`;
}

export function buildAccountUsageView(payload={}, {now=Date.now(),failed=false,quotaStaleSeconds=120}={}){
 const account=payload.accountUsage||{},restricted=account.status==='restricted';
 const raw=restricted?[]:Array.isArray(account.accounts)?account.accounts.slice(0,16):[account];
 const accounts=raw.map((value,index)=>normalizeAccount({...value,label:value.label||value.accountLabel||(raw.length>1?'Codex account '+(index+1):'Codex account'),status:failed?'stale':value.status||account.status,...(failed?{limitsStatus:'stale',usageStatus:'stale'}:{}),source:value.source||account.source},now,Math.max(90,Math.min(120,Number(quotaStaleSeconds)||120))*1000));
 const active=payload.activeUsage||{},activeAt=date(active.observedAt),sourceState=freshness(active.observedAt,failed?'stale':active.status,now),activeState=active.status==='idle'&&!failed?'idle':active.status==='partial'&&sourceState==='available'?'partial':sourceState;
 return {accounts,restricted,reason:restricted?'Account-wide compute is available to administrators.':text(account.reason||'',180),accountState:restricted?'restricted':account.status||'unavailable',active:{sessions:count(active.sessions),inputTokens:count(active.inputTokens),cachedInputTokens:count(active.cachedInputTokens),outputTokens:count(active.outputTokens),totalTokens:count(active.totalTokens),scope:'Visible active sessions · observed cumulative counters',observedAt:activeAt,state:activeState},burn:normalizeBurn(payload.burnUsage,now,failed),history:payload.usageHistory&&typeof payload.usageHistory==='object'?payload.usageHistory:null,sampleAnalytics:payload.sampleAnalytics&&typeof payload.sampleAnalytics==='object'?payload.sampleAnalytics:null,sampleAnalyticsState:payload.sampleAnalyticsState||'unavailable',advisory:normalizeSpendingAdvisory(payload.spendingAdvisory,{now,restricted}),observedAt:date(payload.observedAt),failed,now};
}

const metric=(label,value,detail,klass='')=>`<span class="account-metric-copy ${klass}"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(detail)}</small></span>`;
const spark=(daily)=>{const rows=daily.slice(-30),max=Math.max(1,...rows.map(row=>row.tokens));return `<span class="usage-spark" aria-hidden="true">${rows.map(row=>`<i style="height:${Math.max(2,row.tokens/max*100)}%"></i>`).join('')}</span>`;};
const burnNote=burn=>burn.state==='warming'?'Warming up · waiting for a second reading':burn.state==='gap'?'Observation gap · rate unavailable':burn.state==='unavailable'?'Waiting for token observations':(burn.state==='stale'?'STALE · ':burn.state==='partial'?'PARTIAL · ':'')+'Visible scope · '+(burn.windowMs?Math.round(burn.windowMs/1000)+'s':'observed window')+(burn.workerCount===null?'':' · '+burn.workerCount+' worker'+(burn.workerCount===1?'':'s'));
function burnMeters(burn){
 const meters=[['input','Input new',burn.uncachedInputPerSecond],['output','Output',burn.outputPerSecond],['cache','Cached',burn.cachedInputPerSecond]],max=Math.max(1,...meters.map(row=>row[2]??0));
 return `<span class="burn-meters">${meters.map(([kind,label,value])=>`<span class="burn-meter burn-${kind}"><span><b aria-hidden="true">${kind==='input'?'I':kind==='output'?'O':'C'}</b> ${label}</span><b>${rate(value)}<small> t/s</small></b><i aria-hidden="true"><em style="width:${value===null?0:Math.round(value/max*100)}%"></em></i></span>`).join('')}</span>`;
}
export function renderAccountHighlights(account){
 const summary=account?.summary||{},known=account&&['available','stale'].includes(account.usageState);
 const duration=seconds=>seconds==null?'—':seconds>=3600?Math.floor(seconds/3600)+'h '+Math.floor(seconds%3600/60)+'m':Math.floor(seconds/60)+'m';
 const items=[['Lifetime tokens',known?compact(summary.lifetimeTokens??null):'—'],['Longest task',known?duration(summary.longestRunningTurnSec):'—'],['Current streak',known&&summary.currentStreakDays!=null?summary.currentStreakDays+'d':'—'],['Longest streak',known&&summary.longestStreakDays!=null?summary.longestStreakDays+'d':'—']];
 return `<button type="button" class="account-metric account-highlights" data-account-view="usage" data-account-target="lifetime" aria-label="Account highlights. Open usage" title="${esc(account?.usageAge||'No account reading')}">${items.map(([label,value])=>`<span><small>${esc(label)}</small><b>${esc(value)}</b></span>`).join('')}</button>`;
}
export function renderAccountStrip(view,{alarm={},preferences={},history=null,selectedBarIndex=null}={}){
 const account=view.accounts.length===1?view.accounts[0]:null,multiple=view.accounts.length>1,weekly=account?.weekly;
 const available=weekly&&weekly.state==='available',weeklyKnown=weekly&&['available','stale'].includes(weekly.state),percent=weeklyKnown?weekly.remaining:null;
 const burning=available&&alarm.state==='exceeded'&&preferences.alarmweeklyBurnEnabled!==false&&preferences.alarmweeklyBurnVisual!==false;
 const weeklyValue=view.restricted?'Restricted':multiple?view.accounts.length+' accounts':weekly?.state==='stale'?'Quota stale':weekly?.state==='expired'?'Awaiting quota':weeklyKnown?(burning?'⚠ FAST BURN · ':'')+allowancePercent(percent,weekly.usedPercent)+' remaining':'Quota unavailable';
 const weeklyNote=view.restricted?'Administrator view':multiple?'Inspect each allowance':!weekly?(view.reason||'Account collector unavailable'):weekly.state==='expired'?'Reset passed · awaiting refresh':weekly.state==='unavailable'?'Source time unavailable':(weekly.state==='stale'?'STALE · Last known '+allowancePercent(percent,weekly.usedPercent)+' · ':'')+(account?.limitsAge||'No source reading')+' · Reset '+time(weekly.resetsAt);
 const burn=view.burn,note=burnNote(burn),burnLabel=`Observed token burn. New input ${rate(burn.uncachedInputPerSecond)}, output ${rate(burn.outputPerSecond)}, cached input ${rate(burn.cachedInputPerSecond)} tokens per second. ${note}. Input new excludes cached input. Inspect token burn`;
 const peak=account&&['available','stale'].includes(account.usageState)?account.summary.peakDailyTokens:null,peakValue=view.restricted?'Restricted':multiple?view.accounts.length+' accounts':compact(peak);
 return `<div class="account-metric weekly-allowance ${weekly?.state||'unavailable'} ${burning?'quota-burning':''}" role="group" aria-label="Weekly quota and retained history">${`<div class="weekly-summary"><button type="button" class="weekly-main" data-account-view="usage" data-account-target="weekly" aria-label="Weekly compute: ${esc(weeklyValue)}. ${esc(weeklyNote)}. Inspect account usage"><span class="weekly-caption">Weekly quota ${burning?'<strong>⚠ FAST BURN</strong>':''}</span><span class="weekly-value"><b class="weekly-number ${available?'is-number':'is-state'}">${esc(available?allowancePercent(percent,weekly.usedPercent):weeklyValue)}</b>${available?'<span>remaining</span>':''}</span></button>`}<small class="weekly-source" title="${esc(weeklyNote)}">${esc((burning?alarm.rate.toFixed(1)+' pp/hour · ':'')+weeklyNote+(available?(Number.isInteger(weekly.usedPercent)?' · Whole-point source':' · Reported fractional value'):''))}</small><span class="allowance-track" aria-hidden="true"><i style="width:${percent??0}%" class="${available&&percent<(preferences.alarmLowRemaining??15)&&preferences.alarmlowAllowanceEnabled!==false&&preferences.alarmlowAllowanceVisual!==false?'low':''}"></i></span></div>${allowanceChart(history,{range:preferences.quotaHistoryRange||'24h',account,now:view.now,selectedIndex:selectedBarIndex})}</div><button type="button" class="account-metric live-token-burn ${burn.state}" data-account-view="usage" data-account-target="active" aria-label="${esc(burnLabel)}"><span class="burn-heading"><b>Token burn</b><small>${esc(note)}</small></span>${burnMeters(burn)}</button>${renderAccountHighlights(account)}<button type="button" class="account-metric peak-token-use ${account?.usageState||'unavailable'}" data-account-view="usage" data-account-target="peak" aria-label="Peak daily token use: ${esc(multiple?'inspect per account':full(peak))}. Inspect account history"><span class="peak-summary" title="${esc(view.restricted?'Administrator view':multiple?'Separate account histories':'Largest reported day'+(account?.usageState==='stale'?' · Stale reading':''))}"><span>Peak daily</span><b>${esc(peakValue)}</b></span>${spark(account?.daily||[])}</button>`;
}

const fact=(label,value)=>`<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`;
const unknown=(reported)=>reported?'Unavailable (reported unknown)':'Not reported';
const reportedBoolean=(value,reported)=>typeof value==='boolean'?(value?'Yes':'No'):unknown(reported);
const creditBalance=value=>typeof value==='string'&&value.length<=64&&/^\d+(?:\.\d+)?$/.test(value)?value.replace(/^\d+/,digits=>digits.replace(/\B(?=(\d{3})+(?!\d))/g,',')):null;
function renderNativeAccount(account){
 const native=account.native,windows=[];
 const buckets=native.limits.map(limit=>{
  const id=text(limit.limitId||limit.limitName||'Codex',80),credit=limit.credits&&typeof limit.credits==='object'?limit.credits:null,balance=creditBalance(credit?.balance);
  for(const key of ['primary','secondary']){const value=limit[key];if(!value||typeof value!=='object')continue;const used=numeric(value.usedPercent),valid=used!==null&&used>=0&&used<=100,duration=count(value.windowDurationMins),reset=count(value.resetsAt);windows.push(`<tr><th scope="row">${esc(id)} · ${key}</th><td>${valid?esc(used)+'%':'Unavailable'}</td><td>${valid?esc(Math.round((100-used)*100)/100)+'%':'Unavailable'}</td><td>${duration===null?'Unavailable':full(duration)+' min'}</td><td>${time(reset===null?null:reset*1000)}</td></tr>`);}
  const reached=typeof limit.rateLimitReachedType==='string'&&['rate_limit_reached','workspace_owner_credits_depleted','workspace_member_credits_depleted','workspace_owner_usage_limit_reached','workspace_member_usage_limit_reached'].includes(limit.rateLimitReachedType)?limit.rateLimitReachedType.replaceAll('_',' '):unknown(Object.hasOwn(limit,'rateLimitReachedType'));
  const model=typeof limit.normalModelSlug==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(limit.normalModelSlug)?limit.normalModelSlug:unknown(Object.hasOwn(limit,'normalModelSlug'));
  const balanceReported=credit?Object.hasOwn(credit,'balance'):limit.credits===null;
  return `<h4>${esc(id)}</h4><dl class="account-facts">${fact('Credit balance',balance===null?unknown(balanceReported):balance+' · source units unspecified')}${fact('Has credits',reportedBoolean(credit?.hasCredits,Object.hasOwn(limit,'credits')))}${fact('Credit pool unlimited',reportedBoolean(credit?.unlimited,Object.hasOwn(limit,'credits')))}${fact('Spend control reached',reportedBoolean(limit.spendControlReached,Object.hasOwn(limit,'spendControlReached')))}${fact('Individual spend limit',unknown(Object.hasOwn(limit,'individualLimit')))}${fact('Reached reason',reached)}${fact('Normal quota model',model)}</dl>`;
 }).join('');
 const resets=native.resetCredits,resetCount=count(resets?.availableCount),resetDetails=Array.isArray(resets?.credits)&&resets.credits.length===0?'0 rows reported':unknown(resets?Object.hasOwn(resets,'credits'):native.resetReported);
 const coverage=summaryFields.filter(key=>account.summary[key]!==null).length;
 const table=windows.length?`<div class="usage-table-scroll"><table><caption>Separate allowance windows · remaining = 100 − reported used</caption><thead><tr><th scope="col">Source / window</th><th scope="col">Used (reported)</th><th scope="col">Remaining (derived)</th><th scope="col">Duration</th><th scope="col">Reset (reported)</th></tr></thead><tbody>${windows.join('')}</tbody></table></div>`:'<p class="note">No allowance windows reported.</p>';
 const warning=native.ordinaryUsageAllowed===false?'<p class="account-status-warning">The source reports ordinary included usage is blocked. Percentages and reset times do not establish recovery.</p>':'';
 return `<details class="usage-history-table"><summary>Native account controls &amp; coverage · ${coverage}/5 summary values available</summary><p class="note">Account-wide reported source values · allowance state ${esc(account.limitsState)} · ${esc(account.limitsAge)}. Credit units are unspecified by the source; they are not displayed as USD or added to tokens. Each allowance window stays separate.</p>${warning}<dl class="account-facts">${fact('Ordinary included usage allowed',reportedBoolean(native.ordinaryUsageAllowed,native.ordinaryReported))}${fact('Reset credits available',resetCount===null?unknown(native.resetReported):full(resetCount))}${fact('Reset-credit details',resetDetails)}</dl>${buckets}${table}<dl class="account-facts">${fact('Longest reported turn',account.summary.longestRunningTurnSec===null?'Unavailable':full(account.summary.longestRunningTurnSec)+' sec')}${fact('Current reported streak',account.summary.currentStreakDays===null?'Unavailable':full(account.summary.currentStreakDays)+' days')}${fact('Longest reported streak',account.summary.longestStreakDays===null?'Unavailable':full(account.summary.longestStreakDays)+' days')}${fact('Summary source coverage',coverage+' of 5 values reported')}${fact('Daily source coverage',native.dailyReported?account.dailyCount+' valid rows reported':'Unavailable (reported unknown or absent)')}${fact('Native thread estimate',native.threadReported?'Unavailable (reported unknown)':'Unavailable (not captured)')}${fact('Usage source age',account.usageAge)}</dl><p class="note">Summary and daily history describe only captured service readings. Native thread estimates are unavailable in this collector; no per-thread cost, currency estimate or producing-model attribution is inferred. A normal quota model describes an allowance alias, not the model producing a response.</p></details>`;
}
function renderOneAccount(account,index){
 const weekly=account.weekly,peak=account.summary.peakDailyTokens;
 const quota=weekly?`<p class="usage-quota-value ${weekly.state}" id="usage-account-${index}-weekly" tabindex="-1"><b>${weekly.state==='expired'?'Awaiting refresh':weekly.state==='unavailable'?'Unavailable':weekly.state==='stale'?'Quota stale':allowancePercent(weekly.remaining,weekly.usedPercent)+' remaining'}</b><span>7-day quota${weekly.state==='stale'?' · STALE · Last known '+allowancePercent(weekly.remaining,weekly.usedPercent)+' remaining':weekly.state==='expired'?' · reset passed':''}</span></p>${['available','stale'].includes(weekly.state)?`<div class="allowance-track" role="meter" aria-label="${weekly.state==='stale'?'Last known weekly quota remaining':'Weekly quota remaining'}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${weekly.remaining}" aria-valuetext="${weekly.remaining}% remaining${weekly.state==='stale'?' in a stale reading':''}"><i style="width:${weekly.remaining}%"></i></div>`:''}<dl class="account-facts">${fact('Allowance resets',time(weekly.resetsAt))}${fact('Limit source',weekly.limitId||'Codex')}${fact('Allowance observed',time(account.limitsObservedAt))}</dl>`:'<p class="note">Weekly quota unavailable from this account source.</p>';
 const daily=account.daily.slice(-30),dailyMax=Math.max(1,...daily.map(row=>row.tokens));
 const graph=daily.length?`<div class="usage-history-chart" aria-hidden="true">${daily.map(row=>`<span title="${esc(row.startDate)} · ${full(row.tokens)} tokens"><i style="height:${Math.max(1,row.tokens/dailyMax*100)}%"></i></span>`).join('')}</div><p class="usage-chart-caption">${esc(daily[0].startDate)} — ${esc(daily.at(-1).startDate)} · latest ${daily.length} reported days</p><details class="usage-history-table"><summary>Daily token readings (${account.daily.length} days${account.dailyCount>account.daily.length?' of '+account.dailyCount+' reported':''})</summary><div class="usage-table-scroll"><table><thead><tr><th scope="col">Date (service day)</th><th scope="col">Tokens</th></tr></thead><tbody>${account.daily.map(row=>`<tr><th scope="row">${esc(row.startDate)}</th><td>${full(row.tokens)}</td></tr>`).join('')}</tbody></table></div></details>`:'<p class="note">Daily history unavailable from this account source.</p>';
 return `<section class="account-usage-section" aria-labelledby="usage-account-${index}"><h3 id="usage-account-${index}">${esc(account.label)}${account.usageState==='stale'?' · STALE':account.usageState==='unavailable'?' · SOURCE UNAVAILABLE':''}</h3>${quota}<div class="account-summary-grid" id="usage-account-${index}-peak" tabindex="-1" aria-label="Peak and lifetime account token usage">${metric('Peak daily tokens',full(peak),'Largest reported day')}${metric('Lifetime tokens',full(account.summary.lifetimeTokens),'Account-wide service total')}</div>${graph}${renderNativeAccount(account)}<dl class="account-facts">${fact('Usage observed',time(account.usageObservedAt))}${fact('Source',account.source)}</dl></section>`;
}
export function renderAccountUsageDetails(view,{palette=DEFAULT_TOKEN_PALETTE,evidence={},section="all",historyRange=30,heatMode="daily",breakdown="feature",messageBreakdown="model"}={}){
 const active=view.active,burn=view.burn,windowSeconds=burn.windowMs?Math.round(burn.windowMs/1000):null;
 const legend=`<p class="burn-legend">${palette.legend.map(series=>`<span class="${series.className}"><i class="token-line token-${series.kind}" aria-hidden="true"></i> ${series.glyph} · ${series.colorName} · ${series.label.toLowerCase()}</span>`).join('')}</p>`;
 const workers=burn.workers.slice().sort((a,b)=>(count(b.totalTokens)??0)-(count(a.totalTokens)??0)).slice(0,12);
 const workerTable=workers.length?`<details class="usage-history-table"><summary>Burn by worker (${workers.length}${burn.workers.length>workers.length?' of '+burn.workers.length+' in this response':''})</summary><div class="usage-table-scroll"><table><caption class="sr-only">Observed tokens per second over the current ${windowSeconds||'reported'} second window</caption><thead><tr><th scope="col">Worker</th><th scope="col">I · Input new t/s</th><th scope="col">O · Output t/s</th><th scope="col">C · Cached t/s</th></tr></thead><tbody>${workers.map(row=>{const worker=text(row.label||row.nickname||row.sessionId||'Worker',80),host=text(row.hostLabel||row.hostId||'',80),project=row.mixedDimensions?'Multiple projects/models in window':text(row.project||'',100);return `<tr><th scope="row"><b>${esc(worker)}</b><small>${esc([host,project].filter(Boolean).join(' · '))}</small></th><td class="burn-input">${rate(numeric(row.uncachedInputPerSecond))}</td><td class="burn-output">${rate(numeric(row.outputPerSecond))}</td><td class="burn-cache">${rate(numeric(row.cachedInputPerSecond))}</td></tr>`;}).join('')}</tbody></table></div></details>`:'';
 const burnSection=`<section class="account-usage-section" id="usage-active" tabindex="-1" aria-labelledby="usage-active-title"><h3 id="usage-active-title">Observed token burn${burn.state==='stale'?' · STALE':burn.state==='partial'?' · PARTIAL':''}</h3><p class="note">${esc(burnNote(burn))}. Rates are newly observed counter increases divided by the ${windowSeconds||'reported'}-second window. Usage arrives in sampled batches, not a provider token stream. Gaps, resets and first readings do not become artificial traffic.</p><div class="burn-detail-meters">${burnMeters(burn)}</div>${legend}${renderObservedRatios(burn.ratios)}<p class="note">Input new excludes cached input. Input including cache is ${rate(burn.inputPerSecond)} t/s; cache is its subset. Never add cached input to inclusive input. Bars compare rates within this reading, not account quota.</p><dl class="account-facts">${fact('New input in window',full(burn.uncachedInputTokens))}${fact('Cached input in window',full(burn.cachedInputTokens))}${fact('Input including cache',full(burn.inputTokens))}${fact('Output in window',full(burn.outputTokens))}${fact('Workers with readings',full(burn.workerCount))}${fact('Last token observation',time(burn.observedAt))}</dl>${workerTable}<details class="usage-history-table"><summary>Previous active-session counter view</summary>${active.state==='partial'?'<p class="account-status-warning">Some active sessions have missing or stale token readings. These counters cover only the fresh observations available.</p>':''}<p class="note">The former “Active observed” value summed cumulative counters from recently active sessions. It was not the amount burned during the current turn or a live rate. ${esc(active.scope)}. Input includes its cached subset; counters are not tokens per second.</p><dl class="account-facts">${fact('Active sessions',full(active.sessions))}${fact('Cumulative input tokens',full(active.inputTokens))}${fact('Cumulative cached input (subset)',full(active.cachedInputTokens))}${fact('Cumulative output tokens',full(active.outputTokens))}${fact('Total tokens',full(active.totalTokens))}${fact('Last cumulative observation',time(active.observedAt))}</dl></details><button type="button" data-account-action="retained">Inspect observed workers & retained counters ↗</button></section>`;
 if(section==="active")return burnSection;
 if(["lifetime","peak"].includes(section))return renderAccountHistory(view,{days:historyRange,heatMode,breakdown,messageBreakdown});
 return `${renderSpendingAdvisory(view.advisory)}<p class="account-usage-intro">Live account readings stay separate from the observation plane’s replay clock. Tokens are observed usage, not a monetary balance.</p>${view.failed?'<p class="account-status-warning" role="status">Refresh failed. Previous readings are retained and marked stale.</p>':''}${burnSection}${renderUsageAnalytics(view.sampleAnalytics,{now:view.now,state:view.sampleAnalyticsState,allowQuotaPace:!view.restricted,...evidence})}<button type="button" data-account-action="export" ${view.sampleAnalytics?'':'disabled'}>Preview local export ↗</button>${renderUsageStorage(view.history)}${view.restricted?'<p class="account-status-warning">Account-wide weekly, lifetime and peak usage are private to administrators. Your visible session counters remain available.</p>':view.accounts.length?view.accounts.map(renderOneAccount).join(''):'<p class="note">Account service readings are unavailable. Collection and event history continue independently.</p>'}<p class="note">Account allowances are shared across machines using that account. Each account is displayed once; separate allowances and peak days are never added together.</p>`;
}

function renderArchiveHealth(raw){
 if(!raw||raw.status==='restricted')return '<p class="note">Full-fidelity usage is protected from eviction until verified archival. Archive health requires an unrestricted administrator.</p>';
 const pending=count(raw.pendingRecords),at=date(raw.lastSuccessAt),old=at!==null&&Date.now()-at>300000,pressure=raw.storage?.pressure===true;
 const label=pressure?'Archive storage needs attention':raw.status==='unconfigured'?'Archive destination not configured':raw.status==='failed'?'Archive transfer needs attention':old?'Archive verification is stale':raw.status==='sending'?'Archive transfer in progress':raw.status==='healthy'?'Latest archive transfer verified':raw.status==='idle'?'Archive ready':'Archive status unavailable';
 const warn=['unconfigured','failed'].includes(raw.status)||old||pressure,bytes=value=>{const n=count(value);return n===null?'Unavailable':(n/1073741824).toFixed(2)+' GiB';};
 return `<div class="${warn?'account-status-warning':'account-usage-intro'}" role="status"><b>${esc(label)}</b><br>${pending===null?'Pending count unavailable':full(pending)+' record versions pending'} · Unarchived records stay on the Pi.</div><dl class="account-facts">${fact('Archive bootstrap',raw.bootstrapComplete?'Complete':'Seeding retained history')}${fact('Oldest pending version',time(date(raw.oldestPendingAt)))}${fact('Latest verified transfer',time(at))}${fact('Local receipt batches',full(count(raw.receipts)))}${fact('Local database and journal',bytes(raw.storage?.databaseBytes))}${fact('Pi disk available',bytes(raw.storage?.availableBytes))}</dl>`;
}

function renderUsageStorage(history){
 if(!history)return '<section class="account-usage-section" id="usage-storage" tabindex="-1"><h3>Usage database</h3><p class="note">Waiting for database retention and coverage information.</p></section>';
 const storage=history.storage||{},retained=count(storage.retainedObservations),rawDays=count(storage.rawRetentionDays),dailyDays=count(storage.dailyRetentionDays),rawMax=count(storage.maxRawObservations),dailyMax=count(storage.maxDailyRows);
 if(['unavailable','restricted'].includes(history.status)||retained===null)return '<section class="account-usage-section" id="usage-storage" tabindex="-1"><h3>Usage database</h3><p class="note">Database retention and coverage information is unavailable for this view.</p></section>';
 const rows=Array.isArray(history.daily)?history.daily.filter(row=>row&&typeof row==='object'&&/^\d{4}-\d{2}-\d{2}$/.test(row.day||'')).slice().sort((a,b)=>b.day.localeCompare(a.day)||String(b.lastAt||'').localeCompare(String(a.lastAt||''))):[],shown=rows.slice(0,30);
 const table=shown.length?`<details class="usage-history-table"><summary>Retained daily worker deltas (${shown.length}${rows.length>shown.length?' of '+rows.length+' returned rows':''})</summary><p class="note">Sampled increases captured for each worker and service day. These are daily token totals, not rates. Partial rows contain gaps or unmeasurable changes.</p><div class="usage-table-scroll"><table><thead><tr><th scope="col">Day / worker</th><th scope="col">I · Input new</th><th scope="col">O · Output</th><th scope="col">C · Cached</th></tr></thead><tbody>${shown.map(row=>`<tr><th scope="row"><b>${esc(row.day)}${count(row.partialObservations)>0||row.overflow?' · partial':''}</b><small>${esc([text(row.hostId,80),text(row.project,100),text(row.sessionId,80)].filter(Boolean).join(' · '))}</small></th><td class="burn-input">${full(count(row.uncachedInputTokens))}</td><td class="burn-output">${full(count(row.outputTokens))}</td><td class="burn-cache">${full(count(row.cachedInputTokens))}</td></tr>`).join('')}</tbody></table></div></details>`:'';
 return `<section class="account-usage-section" id="usage-storage" tabindex="-1"><h3>Usage database</h3><p class="note">Durable local usage history · ${storage.scope==='fleet'?'fleet scope':'authorized observations'}. A first reading establishes a baseline; only comparable subsequent readings contribute burn. Account daily readings and sampled worker observations are different sources and are not added together.</p><dl class="account-facts">${fact('Stored worker observations',full(retained))}${fact('Worker daily rows',full(count(storage.retainedDailyRows)))}${fact('Retained worker baselines',full(count(storage.retainedBaselines)))}${storage.accountHistoryIncluded?fact('Account source observations',full(count(storage.retainedAccountObservations)))+fact('Account daily rows',full(count(storage.retainedAccountDailyRows))):''}${fact('Raw hot-cache target',rawDays===null?'Unavailable':rawDays+' days'+(rawMax===null?'':' / '+full(rawMax)+' rows'))}${fact('Daily hot-cache target',dailyDays===null?'Unavailable':dailyDays+' days'+(dailyMax===null?'':' / '+full(dailyMax)+' rows'))}</dl><p class="note">Hot-cache targets apply only after the exact record version has a verified durable archive receipt${storage.limitsApplyAcrossFleet?' across the fleet':''}. Full-fidelity archive history has no automatic age-based deletion. If replication fails, pending versions remain on the Pi even beyond cache targets. ${storage.accountHistoryIncluded?'Account-wide source history is included.':'Account-wide source history is not included in this view.'} History reflects captured observations, not a reconstructed billing ledger. Missing collectors, copied sessions and gaps can limit coverage.</p>${renderArchiveHealth(history.archive)}${table}</section>`;
}

export function safeSignInUrl(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/'?url.href:null;}catch{return null;}}
export function renderProfile(account={}){
 const viewer=account.viewer,capabilities=account.capabilities||{},signedIn=capabilities.authenticated===true&&viewer;
 if(!signedIn){const hub=safeSignInUrl(capabilities.passwordLoginUrl);return `<p class="note">${hub?'Your password account is on the authoritative fleet hub.':'Sign in to use your observer profile.'}</p><a class="account-primary-link" href="${esc(hub||'/')}">Sign in${hub?' at fleet hub ↗':''}</a>`;}
 const gateway=safeSignInUrl(capabilities.passwordLoginUrl),personal=account.personal||{};
 return `<div class="profile-identity"><span class="profile-avatar" aria-hidden="true">${esc((viewer.username||viewer.label||'V').slice(0,1).toUpperCase())}</span><div><h3>${esc(text(personal.nickname||personal.name||viewer.label||viewer.username||'Viewer',100))}</h3><p>${esc(text(viewer.username||'Access-key viewer',64))} · <b>${esc(text(viewer.role||'viewer',24))}</b></p></div></div><p class="note">This observer account controls your dashboard access and saved presentation. Codex subscription usage comes from the connected Codex account source.</p><div id="profile-editor-slot"></div><div class="profile-actions"><a class="account-primary-link" href="/help/user-manual.pdf" target="_blank" rel="noopener">User manual (PDF)</a><a class="account-primary-link" href="/help/interface-atlas.pdf" target="_blank" rel="noopener">Interface atlas (PDF)</a><button type="button" data-account-action="settings">${capabilities.passwordChange?'Profile, password & access':'Profile & access settings'} ↗</button><button type="button" data-account-action="usage">Compute & token usage</button>${gateway?`<a class="account-primary-link" href="${esc(gateway)}">Open fleet-hub sign-in ↗</a>`:''}${capabilities.logout?'<button type="button" data-account-action="logout">Sign out</button>':''}</div>`;
}

export function patchAccountStrip(target,html,document){
 if(typeof document.createElement!=='function'){target.innerHTML=html;return;}
 const template=document.createElement('template');template.innerHTML=html;
 const patch=(current,next)=>{if(current.nodeType!==next.nodeType||current.nodeType===1&&(current.localName!==next.localName||current.namespaceURI!==next.namespaceURI)){current.replaceWith(next.cloneNode(true));return;}if(current.nodeType===3){if(current.nodeValue!==next.nodeValue)current.nodeValue=next.nodeValue;return;}if(current.nodeType!==1)return;
  for(const attr of [...current.attributes])if(!next.hasAttribute(attr.name))current.removeAttribute(attr.name);
  for(const attr of [...next.attributes])if(current.getAttribute(attr.name)!==attr.value)current.setAttribute(attr.name,attr.value);
  children(current,next);
 };
 const children=(current,next)=>{const wanted=[...next.childNodes];for(let i=0;i<wanted.length;i++){if(!current.childNodes[i])current.append(wanted[i].cloneNode(true));else patch(current.childNodes[i],wanted[i]);}while(current.childNodes.length>wanted.length)current.lastChild.remove();};
 children(target,template.content);
}
export function mountAccountUsage({document,window,request,openSettings,openRetained,onUsage,onAccount,getPalette=()=>DEFAULT_TOKEN_PALETTE,getEvidence=()=>({}),getScope=()=>'all',onHistoryRange=()=>{},getQuotaAlarm=()=>({}),getPreferences=()=>({}),onFocus,onScopeChange,onInvalidate,onExport,navigate=path=>window.location.assign(path),intervalMs=3000,now=Date.now}={}){
 const strip=document.getElementById('account-usage-strip'),profile=document.getElementById('profile-open'),profileDialog=document.getElementById('profile-dialog'),profileBody=document.getElementById('profile-content'),usageDialog=document.getElementById('account-usage-dialog'),usageBody=document.getElementById('account-usage-content'),status=document.getElementById('account-refresh-status');
 if(!strip||!profile||!profileDialog||!usageDialog)return {refresh:async()=>{},destroy(){}};
 let account={},payload={},failed=false,busy=false,timer=null,destroyed=false,suspended=false,accountReadAt=0,returnFocus=null,returnDialog=null,returnMetricIndex=-1,revision='',profileRevision='',suppressReturnFocus=false;
 let lastUsageHtml=null,historyRenderKey=null,historyRenderHtml=null;
 let receivedAt=null,usageSection="all",historyRange=30,heatMode="daily",breakdown="feature",messageBreakdown="model";
 let allowanceHistory=null,historyReadAt=0,historyRangeRead=null,historyRequest=0,historyAbort=null;
 const selectedRange=()=>['24h','48h','7d'].includes(getPreferences().quotaHistoryRange)?getPreferences().quotaHistoryRange:'24h';
 function clearHistory(){selectedBarIndex=null;historyRequest++;historyAbort?.abort();historyAbort=null;allowanceHistory=null;historyReadAt=0;historyRangeRead=null;}
 async function refreshHistory({force=false}={}){
  const range=selectedRange(),scope=scopeKey,generation=scopeRevision;
  if(destroyed||suspended||document.hidden||payload.accountUsage?.status==='restricted')return;
  if(!force&&historyRangeRead===range&&historyReadAt&&now()-historyReadAt<60000)return;
  historyAbort?.abort();const abort=new AbortController();historyAbort=abort;const requestId=++historyRequest;historyRangeRead=range;historyReadAt=now();
  if(!allowanceHistory)allowanceHistory={status:'loading',points:[]};paint();
  try{
   const value=await request('/api/account/allowance-history?range='+range,{signal:abort.signal});
   if(requestId!==historyRequest||destroyed||suspended||scope!==scopeKey||generation!==scopeRevision||range!==selectedRange())return;
   allowanceHistory=value;
  }catch(error){
   if(requestId!==historyRequest||abort.signal.aborted)return;
   allowanceHistory={...(allowanceHistory||{}),status:'failed',reason:'History refresh unavailable; last captured readings retained.'};
   if(error?.status===401||error?.status===403)invalidateAccess(error.status);
  }finally{if(requestId===historyRequest){historyAbort=null;if(!destroyed&&!suspended)paint();}}
 }

 let selectedBarIndex=null;
 let avatarRevision=null;
 async function paintAvatar(){const p=account.personal,tag=(account.viewer?.id||'')+':'+p?.revision;if(!p||avatarRevision===tag)return;avatarRevision=tag;const identity=account.viewer?.id,rev=p.revision;let image=profile.querySelector('[data-profile-photo]');if(!p.hasPhoto){image?.remove();return;}try{const value=await request('/api/profile/photo');if(identity!==account.viewer?.id||rev!==account.personal?.revision||!value.photo)return;if(!image){image=document.createElement('img');image.dataset.profilePhoto='';image.alt='';profile.prepend(image);}image.src=value.photo;}catch{/* Keep the name and default icon when a photo is unavailable. */}}
 const nativeDetails=new Map();
 let detailAnalytics=null,detailReadAt=0,detailBusy=false,detailFailed=false,scopeKey=String(getScope()),scopeRevision=0;
 let advisoryRead={state:'idle',value:null},advisoryGeneration=0,detailAbort=null,advisoryBlocked=false,advisoryAnnounced='';
 const canReadAdvisory=()=>!advisoryBlocked&&account.capabilities?.authenticated===true&&account.viewer?.role==='admin'&&typeof account.viewer.id==='string'&&account.viewer.id.length>0&&payload.accountUsage?.status!=='restricted';
 function clearAdvisory(state='idle'){advisoryGeneration++;detailAbort?.abort();detailReadAt=0;advisoryRead={state,value:null};advisoryAnnounced='';}
 function syncScope(){const current=String(getScope());if(current!==scopeKey){scopeKey=current;scopeRevision++;clearHistory();clearAdvisory();payload={};detailAnalytics=null;nativeDetails.clear();detailReadAt=0;detailFailed=false;try{onScopeChange?.();}catch{}}return current;}
 function invalidateAccess(code){clearHistory();advisoryBlocked=true;clearAdvisory('restricted');payload={};detailAnalytics=null;nativeDetails.clear();failed=detailFailed=true;scopeRevision++;if(code===401){account={capabilities:{authenticated:false}};accountReadAt=0;avatarRevision=null;try{onAccount?.(account);}catch{}profile.querySelector('[data-profile-photo]')?.remove();profileBody.innerHTML='';profileRevision='';}try{onInvalidate?.();}catch{}}
 const viewPayload=()=>({...payload,accountUsage:{...payload.accountUsage,accounts:(payload.accountUsage?.accounts||[]).map(a=>({...a,nativeAnalyticsData:nativeDetails.get(a.nativeAnalytics?.digest)??a.nativeAnalyticsData}))},spendingAdvisory:advisoryRead,sampleAnalytics:detailAnalytics,sampleAnalyticsState:detailBusy?'loading':detailFailed?'stale':'unavailable'});
 const schedule=()=>{clearTimeout(timer);if(!destroyed&&!suspended&&!document.hidden)timer=setTimeout(refresh,Math.max(3000,intervalMs));};
 const announce=message=>{if(status.textContent!==message)status.textContent=message;};
 function paintProfile(){if(profileBody.querySelector('[data-dirty="true"]'))return;const html=renderProfile(account);if(html===profileRevision)return;const focused=document.activeElement?.dataset?.accountAction;profileBody.innerHTML=html;profileRevision=html;const slot=profileBody.querySelector('#profile-editor-slot');if(slot)mountProfileEditor(slot,{request,onSaved:()=>{accountReadAt=0;void refresh({forceAccount:true});}});if(focused)profileBody.querySelector('[data-account-action="'+focused+'"]')?.focus();}
 function detailMarkup(view){
  const history=usageSection==='lifetime'||usageSection==='peak';
  if(history){const key=JSON.stringify([view.restricted,new Date(view.now).toISOString().slice(0,10),historyRange,heatMode,breakdown,messageBreakdown,view.accounts.map(a=>[a.accountKey,a.label,a.summary,a.activityDays,a.usageObservedAt,a.usageState,a.nativeAnalytics?.digest,!!a.nativeAnalyticsData])]);if(key===historyRenderKey)return historyRenderHtml;historyRenderKey=key;historyRenderHtml=renderAccountUsageDetails(view,{palette:getPalette(),evidence:getEvidence(),section:usageSection,historyRange,heatMode,breakdown,messageBreakdown});return historyRenderHtml;}
  return '<p class="scope-note">'+esc(getEvidence().scopeLabel||'Authorized visible scope')+' · account quota uses wall clock; worker evidence uses the selected source window.</p>'+renderAccountUsageDetails(view,{palette:getPalette(),evidence:getEvidence(),section:usageSection,historyRange,heatMode,breakdown,messageBreakdown});
 }
 function paint(){syncScope();const view=buildAccountUsageView(viewPayload(),{now:now(),failed,quotaStaleSeconds:getPreferences().quotaStaleSeconds});const html=renderAccountStrip(view,{selectedBarIndex,alarm:getQuotaAlarm(),preferences:getPreferences(),history:historyRangeRead===selectedRange()?allowanceHistory:{status:'loading',points:[]}});if(html!==revision){const focusedIndex=[...strip.querySelectorAll('button')].indexOf(document.activeElement);patchAccountStrip(strip,html,document);revision=html;if(focusedIndex>=0)strip.querySelectorAll('button')[focusedIndex]?.focus();}const viewer=account.viewer,signedIn=account.capabilities?.authenticated===true&&viewer;profile.querySelector('[data-profile-label]').textContent=signedIn?'Profile':'Sign in';profile.querySelector('[data-profile-name]').textContent=signedIn?text(account.personal?.nickname||account.personal?.name||viewer.username||viewer.label||viewer.role,64):'';profile.setAttribute('aria-label',signedIn?'Open profile for '+text(viewer.username||viewer.label||'viewer',80):'Open sign-in options');if(usageDialog.open){const nextUsageHtml=detailMarkup(view);if(lastUsageHtml!==nextUsageHtml){const reading=captureUsageReading(usageBody,document.activeElement,usageDialog);usageBody.innerHTML=nextUsageHtml;lastUsageHtml=nextUsageHtml;restoreUsageReading(usageBody,reading,usageDialog,document.getElementById('account-usage-refresh'));}}if(profileDialog.open)paintProfile();}
 function open(dialog,section){syncScope();if(dialog===usageDialog){usageSection=["active","lifetime","peak","weekly","analytics","storage"].includes(section)?section:"all";const heading=document.getElementById("account-usage-title");if(heading)heading.textContent=usageSection==="active"?"Token burn":usageSection==="lifetime"||usageSection==="peak"?"Account usage & activity":"Compute & token usage";}returnFocus=document.activeElement;returnDialog=dialog;returnMetricIndex=[...strip.querySelectorAll('button')].indexOf(returnFocus);if(dialog===profileDialog)paintProfile();else {lastUsageHtml=detailMarkup(buildAccountUsageView(viewPayload(),{now:now(),failed,quotaStaleSeconds:getPreferences().quotaStaleSeconds}));usageBody.innerHTML=lastUsageHtml;}dialog.showModal();dialog.querySelector('[data-account-close]')?.focus();if(section){const target=usageBody.querySelector(['active','analytics','storage'].includes(section)?'#usage-'+section:'#usage-account-0-'+section);target?.focus({preventScroll:true});target?.scrollIntoView({block:'start',behavior:'instant'});}if(dialog===usageDialog)void refreshDetails();}
 async function refreshDetails(){
  const scope=syncScope(),generation=scopeRevision,identity=account.viewer?.id;
  if(detailBusy||destroyed||suspended||document.hidden||!usageDialog.open||detailReadAt&&now()-detailReadAt<15000)return;
  const readAdvisory=canReadAdvisory(),advisoryRevision=advisoryGeneration,abort=new AbortController();detailAbort=abort;
  detailBusy=true;detailReadAt=now();
  if(readAdvisory)advisoryRead={...advisoryRead,state:advisoryRead.value?'refreshing':'loading'};
  else if(account.viewer?.role!=='admin'||payload.accountUsage?.status==='restricted')advisoryRead={state:'restricted',value:null};
  paint();
  try{
   const wantsNative=usageSection==='lifetime'||usageSection==='peak',missingNative=wantsNative&&(payload.accountUsage?.accounts||[]).some(item=>item.nativeAnalytics?.digest&&!nativeDetails.has(item.nativeAnalytics.digest));const results=await Promise.allSettled([request('/api/account/usage?details=1'+(missingNative?'&native=1':''),{signal:abort.signal}),
    ...(readAdvisory?[request('/api/account/spending-status',{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(8000)])})]:[])]);
   if(destroyed||suspended||document.hidden||!usageDialog.open||abort.signal.aborted||scope!==String(getScope())||generation!==scopeRevision||identity!==account.viewer?.id)return;
   const denied=results.some(value=>value.status==='rejected'&&value.reason?.status===401)?401:results.some(value=>value.status==='rejected'&&value.reason?.status===403)?403:null;
   if(denied){invalidateAccess(denied);return;}
   if(results[0].status==='fulfilled'){
    const value=results[0].value;if(value?.usageHistory&&typeof value.usageHistory==='object')payload={...payload,usageHistory:value.usageHistory};
    detailAnalytics=value?.sampleAnalytics&&typeof value.sampleAnalytics==='object'?value.sampleAnalytics:null;if(value?.accountUsage?.status==='restricted'){nativeDetails.clear();}else for(const item of value?.accountUsage?.accounts||[])if(item.nativeAnalyticsData&&item.nativeAnalytics?.digest){if(nativeDetails.size>=16)nativeDetails.clear();nativeDetails.set(item.nativeAnalytics.digest,item.nativeAnalyticsData);}detailFailed=false;
   }else detailFailed=true;
   if(readAdvisory&&advisoryRevision===advisoryGeneration&&canReadAdvisory()){
    advisoryRead=results[1].status==='fulfilled'?{state:'available',value:results[1].value}:{...advisoryRead,state:'failed'};
    const advisory=normalizeSpendingAdvisory(advisoryRead,{now:now()}),key=advisory.kind+':'+advisory.label+':'+advisory.reason;
    if(key!==advisoryAnnounced){advisoryAnnounced=key;announce('Spending advisory: '+advisory.label+(advisory.reason?' · '+advisory.reason:''));}
   }
  }catch{detailFailed=true;if(readAdvisory&&advisoryRevision===advisoryGeneration)advisoryRead={...advisoryRead,state:'failed'};}
  finally{
   if(detailAbort===abort)detailAbort=null;detailBusy=false;
   if(abort.signal.aborted&&advisoryRevision===advisoryGeneration)advisoryRead={...advisoryRead,state:advisoryRead.value?'stale':'idle'};
   if(!destroyed&&!suspended)paint();
  }
 }

 async function refresh({forceAccount=false}={}){
  const scope=syncScope(),generation=scopeRevision;if(busy||destroyed||suspended||document.hidden)return;busy=true;clearTimeout(timer);const refreshButton=document.getElementById('account-usage-refresh'),restoreRefreshFocus=document.activeElement===refreshButton;refreshButton.disabled=true;
  try{
   const readAccount=forceAccount||!accountReadAt||now()-accountReadAt>=60000,results=await Promise.allSettled([request(usageDialog.open?'/api/account/usage':'/api/account/usage?summary=1'),...(readAccount?[request('/api/account')]:[])]);
   if(destroyed||suspended||scope!==String(getScope())||generation!==scopeRevision)return;
   // A concurrent successful response can predate a permission change. Reject
   // the whole read before publishing either result when access is known lost.
   const denied=results.some(result=>result.status==='rejected'&&result.reason?.status===401)?401:results.some(result=>result.status==='rejected'&&result.reason?.status===403)?403:null;
   if(denied){invalidateAccess(denied);paint();announce(denied===401?'Sign in to refresh usage · cached readings cleared':'Usage access refused · cached readings cleared');return;}
   if(readAccount&&results[1].status==='fulfilled'&&account.viewer?.id&&JSON.stringify([account.viewer.id,account.viewer.role])!==JSON.stringify([results[1].value.viewer?.id,results[1].value.viewer?.role])){invalidateAccess(401);paint();announce('Account identity or authority changed · cached readings cleared');return;}
   if(results[0].status==='fulfilled'){payload=results[0].value;if(payload.accountUsage?.status==='restricted'){clearHistory();clearAdvisory('restricted');nativeDetails.clear();}receivedAt=now();strip.dataset.receivedAt=new Date(receivedAt).toISOString();failed=false;try{onUsage?.(payload);}catch{/* A map rendering failure must not stop usage refresh. */}}else{failed=true;try{onUsage?.({...payload,accountUsage:{...(payload.accountUsage||{}),accounts:(payload.accountUsage?.accounts||[]).map(a=>({...a,status:'stale',limitsStatus:'stale'})),status:'stale'}});}catch{}}
   if(readAccount&&results[1].status==='fulfilled'){if(account.viewer?.id!==results[1].value.viewer?.id){clearAdvisory();nativeDetails.clear();profileBody.innerHTML='';profileRevision='';avatarRevision=null;profile.querySelector('[data-profile-photo]')?.remove();}account=results[1].value;advisoryBlocked=false;if(account.viewer?.role!=='admin'||account.capabilities?.authenticated!==true)clearAdvisory('restricted');accountReadAt=now();try{onAccount?.(account);}catch{}void paintAvatar();}
   paint();if(!failed&&payload.accountUsage?.status!=='restricted')void refreshHistory();if(usageDialog.open)void refreshDetails();announce(failed?'Usage request failed · last known readings retained; automatic retry scheduled':'Usage received '+time(receivedAt)+' · source times determine freshness');
  }finally{busy=false;refreshButton.disabled=false;if(restoreRefreshFocus&&!destroyed&&!suspended&&!document.hidden&&usageDialog.open&&refreshButton.isConnected&&(document.activeElement===document.body||document.activeElement===document.documentElement||!document.activeElement))refreshButton.focus({preventScroll:true});schedule();}
 }
 function selectHistoryBar(event){const chart=event.target?.closest?.('[data-quota-bars]');if(!chart)return;const count=Number(chart.dataset.quotaCount);if(!Number.isInteger(count)||count<1||count>48)return;let index=Number(chart.dataset.quotaSelected);if(event.type==='keydown'){const movement={ArrowLeft:-1,ArrowRight:1,ArrowDown:-1,ArrowUp:1};if(event.key==='Home')index=0;else if(event.key==='End')index=count-1;else if(Object.hasOwn(movement,event.key))index+=movement[event.key];else return;event.preventDefault();}else{const box=(chart.querySelector('svg')||chart).getBoundingClientRect(),left=box.left+box.width*4/222,width=box.width*216/222;index=Math.floor((event.clientX-left)/width*count);}selectedBarIndex=Math.max(0,Math.min(count-1,index));paint();chart.focus?.({preventScroll:true});}
 strip.addEventListener('keydown',selectHistoryBar);strip.addEventListener('pointerdown',selectHistoryBar);
 function click(event){const target=event.target.closest('[data-account-action],[data-account-view],[data-account-close],[data-usage-focus],[data-quota-range],[data-account-days],[data-account-heat],[data-account-section]');if(!target)return;if(target.dataset.accountDays||target.dataset.accountHeat){if(target.dataset.accountDays)historyRange=target.dataset.accountDays==='7'?7:30;if(target.dataset.accountHeat)heatMode=['daily','weekly','cumulative'].includes(target.dataset.accountHeat)?target.dataset.accountHeat:'daily';const selector=target.dataset.accountDays?'[data-account-days="'+historyRange+'"]':'[data-account-heat="'+heatMode+'"]';paint();usageBody.querySelector(selector)?.focus({preventScroll:true});return;}if(target.dataset.accountSection==='all'){open(usageDialog);return;}if(target.dataset.quotaRange){event.stopPropagation();clearHistory();onHistoryRange(target.dataset.quotaRange);paint();void refreshHistory({force:true});return;}if(target.dataset.usageFocus){event.stopPropagation?.();let evidence;try{evidence=JSON.parse(target.dataset.usageFocus);}catch{return;}if(evidence&&typeof evidence==='object'&&onFocus){suppressReturnFocus=true;usageDialog.close();onFocus(evidence);}return;}if(target.dataset.accountClose){document.getElementById(target.dataset.accountClose)?.close();return;}if(target.dataset.accountView==='usage'||target.dataset.accountAction==='usage'){if(profileDialog.open)profileDialog.close();open(usageDialog,target.dataset.accountTarget);return;}if(target.dataset.accountAction==='export'){syncScope();if(detailAnalytics)onExport?.(viewPayload());return;}if(target.dataset.accountAction==='settings'){profileDialog.close();openSettings?.('access');return;}if(target.dataset.accountAction==='retained'){usageDialog.close();openRetained?.();return;}if(target.dataset.accountAction==='logout')signOut(target);}
 function nativeChange(event){const target=event.target;if(target?.dataset?.nativeBreakdown!==undefined){breakdown=['feature','model','surface','turn-start'].includes(target.value)?target.value:'feature';}else if(target?.dataset?.nativeMessages!==undefined){messageBreakdown=target.value==='surface'?'surface':'model';}else return;const selector=target.dataset.nativeBreakdown!==undefined?'[data-native-breakdown]':'[data-native-messages]';paint();usageBody.querySelector(selector)?.focus({preventScroll:true});}
 usageDialog.addEventListener('change',nativeChange);
 async function signOut(button){button.disabled=true;announce('Signing out…');try{await request('/api/session/logout',{method:'POST'});payload={};account={};detailAnalytics=null;nativeDetails.clear();scopeRevision++;try{onInvalidate?.();}catch{}navigate('/');}catch{announce('Sign-out could not be confirmed. Try again.');button.disabled=false;}}
 const profileClick=()=>open(profileDialog),usageClick=()=>open(usageDialog),activityClick=()=>open(usageDialog,'lifetime'),visibility=()=>{if(document.hidden){detailAbort?.abort();detailReadAt=0;clearTimeout(timer);timer=null;}else refresh();},close=()=>{detailAbort?.abort();detailReadAt=0;if(suppressReturnFocus){suppressReturnFocus=false;return;}const usable=node=>node&&node.isConnected!==false&&!node.disabled&&!node.closest?.('[hidden],[inert]')&&(!node.getClientRects||node.getClientRects().length>0)&&window.getComputedStyle?.(node)?.visibility!=='hidden';let target=usable(returnFocus)?returnFocus:null;if(!target&&returnDialog===profileDialog)target=[profile,document.querySelector?.('[data-mobile-action="profile-open"]'),document.querySelector?.('[data-mobile-view="more"]')].find(usable);if(!target&&returnMetricIndex>=0){const metric=strip.querySelectorAll('button')[returnMetricIndex];if(usable(metric))target=metric;}target?.focus({preventScroll:true});},manual=()=>{detailReadAt=0;return refresh({forceAccount:true});},pagehide=()=>{suspended=true;detailAbort?.abort();detailReadAt=0;historyAbort?.abort();clearTimeout(timer);timer=null;},pageshow=()=>{suspended=false;refresh();};
 profile.addEventListener('click',profileClick);document.getElementById('usage-open')?.addEventListener('click',usageClick);document.getElementById('account-activity-open')?.addEventListener('click',activityClick);document.getElementById('refresh')?.addEventListener('click',manual);document.getElementById('account-usage-refresh')?.addEventListener('click',manual);strip.addEventListener('click',click);profileDialog.addEventListener('click',click);usageDialog.addEventListener('click',click);profileDialog.addEventListener('close',close);usageDialog.addEventListener('close',close);document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',pagehide);window.addEventListener('pageshow',pageshow);
 paint();const ready=refresh();
 return {ready,refresh,refreshDetails,repaint:paint,openUsage:section=>open(usageDialog,section),destroy(){destroyed=true;clearAdvisory();nativeDetails.clear();usageDialog.removeEventListener('change',nativeChange);strip.removeEventListener('keydown',selectHistoryBar);strip.removeEventListener('pointerdown',selectHistoryBar);clearHistory();clearTimeout(timer);profile.removeEventListener('click',profileClick);document.getElementById('usage-open')?.removeEventListener('click',usageClick);document.getElementById('account-activity-open')?.removeEventListener('click',activityClick);document.getElementById('refresh')?.removeEventListener('click',manual);document.getElementById('account-usage-refresh')?.removeEventListener('click',manual);strip.removeEventListener('click',click);profileDialog.removeEventListener('click',click);usageDialog.removeEventListener('click',click);profileDialog.removeEventListener('close',close);usageDialog.removeEventListener('close',close);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',pagehide);window.removeEventListener('pageshow',pageshow);}};
}
