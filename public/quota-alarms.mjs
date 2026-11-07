// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// Account allowance rates use source observations, never token counters.
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const stamp=v=>typeof v==='string'?Date.parse(v):NaN;
export const ALARM_CONDITIONS=Object.freeze([
 ['weeklyBurn','Weekly quota burn','Quota rate above the configured percentage points/hour threshold'],
 ['lowAllowance','Low weekly quota','Fresh account allowance below its remaining-percent threshold'],
 ['quotaStale','Quota source stale / unavailable','No current, trustworthy weekly quota reading'],
 ['telemetryStale','Stale host telemetry','Connected source telemetry older than the configured age'],
 ['disconnected','Disconnected hosts','Known hosts reporting a disconnected state'],
 ['failure','Recorded failures','Captured failures requiring review'],
 ['input','Input requests','Captured requests without a matching resolution']
]);
export const ALARM_DEFAULTS=Object.freeze({
 quotaHistoryRange:'24h',quotaBurnThreshold:15,quotaBurnLookbackMinutes:60,quotaStaleSeconds:120,alarmLowRemaining:15,alarmTelemetrySeconds:60,
 alarmAudioEnabled:false,alarmAudioMuted:false,alarmVolume:25,alarmCooldownSeconds:120,
 ...Object.fromEntries(ALARM_CONDITIONS.flatMap(([key])=>[['alarm'+key+'Enabled',true],['alarm'+key+'Visual',true],['alarm'+key+'Audible',false]]))
});
export const ALARM_FIELDS=Object.freeze([
 {key:'quotaHistoryRange',label:'Quota graph range',type:'select',options:['24h','48h','7d'],optionLabels:{'24h':'Last 24 hours','48h':'Last 48 hours','7d':'Last 7 days'}},
 {key:'quotaBurnThreshold',label:'Weekly burn threshold',type:'number',min:0.1,max:1000,unit:'percentage points / hour',help:'An endpoint rate over adequately covered, same-account source samples. Tokens are never converted to quota.'},
 {key:'quotaBurnLookbackMinutes',label:'Quota rate lookback',type:'number',min:5,max:180,unit:'minutes',help:'Requires at least 3 distinct samples, 80% time coverage and no source gap longer than the quota stale age. Two new readings confirm a threshold transition; recovery uses 80% of the threshold.'},
 {key:'quotaStaleSeconds',label:'Quota stale age / maximum sample gap',type:'number',min:90,max:120,unit:'seconds',help:'The account observer normally samples every 60 seconds. The server also enforces a 120-second freshness ceiling. Explicit source failures become stale immediately. Bursts cannot be detected before new source evidence arrives.'},
 {key:'alarmLowRemaining',label:'Low allowance threshold',type:'number',min:0,max:100,unit:'% remaining'},
 {key:'alarmTelemetrySeconds',label:'Telemetry stale age',type:'number',min:15,max:3600,unit:'seconds'},
 {key:'alarmAudioEnabled',label:'Allow browser alarm sound',type:'boolean',help:'Save this preference, then use Enable & test sound in each browser session. Sound requires an open running page, current evidence and browser audio permission.'},
 {key:'alarmAudioMuted',label:'Mute alarm sound',type:'boolean',help:'Visual warnings and captured evidence remain available.'},
 {key:'alarmVolume',label:'Alarm volume',type:'number',min:0,max:100,unit:'%'},
 {key:'alarmCooldownSeconds',label:'Sound repeat cooldown',type:'number',min:15,max:3600,unit:'seconds',help:'One shared cooldown prevents simultaneous conditions from producing an alarm storm.'},
 ...ALARM_CONDITIONS.flatMap(([key,label])=>[
  {key:'alarm'+key+'Enabled',label:label+' enabled',type:'boolean',condition:key},
  {key:'alarm'+key+'Visual',label:label+' visual warning',type:'boolean',condition:key},
  {key:'alarm'+key+'Audible',label:label+' audible warning',type:'boolean',condition:key}
 ])
].map(f=>({...f,section:'alerts'})));
export function weeklyReading(payload,now=Date.now(),staleSeconds=120){
 const raw=payload?.accountUsage;if(raw?.status==='restricted')return {state:'restricted',reason:'Administrator account required'};
 const accounts=Array.isArray(raw?.accounts)?raw.accounts:raw?[raw]:[];
 if(accounts.length!==1)return {state:'unknown',reason:accounts.length?'Multiple accounts; inspect separately':'No quota source'};
 const account=accounts[0],at=stamp(account.limitsObservedAt);
 const status=account.limitsStatus||account.status||raw.status;
 if(!finite(at)||at>now)return {state:'unknown',reason:'Source time missing or ahead'};
 const candidates=[];
 for(const limit of account.limits||[])for(const slot of ['primary','secondary']){
  const w=limit?.[slot];if(w?.windowDurationMins!==10080||!finite(w.usedPercent)||w.usedPercent<0||w.usedPercent>100||!Number.isSafeInteger(w.resetsAt))continue;
  candidates.push({accountKey:account.accountKey,limitId:limit.limitId,slot,reset:w.resetsAt*1000,used:w.usedPercent,remaining:100-w.usedPercent,at});
 }
 candidates.sort((a,b)=>Number(b.limitId==='codex')-Number(a.limitId==='codex')||String(a.limitId).localeCompare(String(b.limitId))||a.slot.localeCompare(b.slot));
 const reading=candidates[0];if(!reading)return {state:'unknown',reason:'Weekly window unavailable'};
 if(reading.reset<=now)return {...reading,state:'expired',reason:'Reset passed; waiting for new source reading'};
 if(['stale','unavailable'].includes(status)||now-at>staleSeconds*1000)return {...reading,state:'stale',reason:'Quota source is stale; check the enabled source observer'};
 return {...reading,state:'fresh',reason:'Source observation current'};
}
export class WeeklyQuotaTracker{
 constructor(){this.clear();}
 clear(){this.key=null;this.samples=[];this.high=0;this.low=0;this.latched=false;this.result={state:'unknown',reason:'Waiting for quota samples',rate:null};}
 observe(payload,preferences={},now=Date.now()){
  const p={...ALARM_DEFAULTS,...preferences},r=weeklyReading(payload,now,p.quotaStaleSeconds);
  this.reading=r;
  if(r.state!=='fresh'){this.high=this.low=0;this.latched=false;return this.result={...r,rate:null};}
  if(!/^[a-f0-9]{64}$/.test(r.accountKey||'')){this.clear();this.reading=r;return this.result={...r,state:'unknown',rate:null,reason:'Account identity unlinked; quota rate unknown'};}
  const key=JSON.stringify([r.accountKey,r.limitId,r.slot,r.reset,p.quotaBurnLookbackMinutes,p.quotaBurnThreshold,p.quotaStaleSeconds]);
  if(key!==this.key){this.clear();this.key=key;this.reading=r;}
  const last=this.samples.at(-1);
  if(last&&r.at<last.at)return this.result={...r,state:'unknown',rate:null,reason:'Out-of-order source sample'};
  if(last&&r.at===last.at){
   if(r.used!==last.used){this.clear();this.reading=r;return this.result={...r,state:'unknown',rate:null,reason:'Conflicting source samples'};}
   return this.current(now,p);
  }
  if(last&&(r.at-last.at>p.quotaStaleSeconds*1000||r.used<last.used)){this.samples=[];this.high=this.low=0;this.latched=false;}
  this.samples.push(r);
  const lookback=p.quotaBurnLookbackMinutes*60000;
  this.samples=this.samples.filter(s=>s.at>=r.at-lookback).slice(-4096); // Browser projection only; durable source observations are untouched.
  const first=this.samples[0],elapsed=r.at-first.at;
  if(this.samples.length<3||elapsed<lookback*.8)return this.result={...r,state:'warming',rate:null,coverageMs:elapsed,reason:'Need 80% lookback coverage and 3 distinct source samples'};
  const rate=(r.used-first.used)/(elapsed/3600000);
  if(rate>p.quotaBurnThreshold){this.high++;this.low=0;if(this.high>=2)this.latched=true;}
  else if(rate<p.quotaBurnThreshold*.8){this.low++;this.high=0;if(this.low>=2)this.latched=false;}
  else{this.high=this.low=0;}
  return this.result={...r,state:this.latched?'exceeded':'normal',rate,coverageMs:elapsed,sampleCount:this.samples.length,threshold:p.quotaBurnThreshold,reason:this.latched?'Weekly quota burn threshold exceeded':this.high?'Confirming high rate with next source reading':'Covered source rate'};
 }
 current(now=Date.now(),p=ALARM_DEFAULTS){
  if(this.reading?.at&&now-this.reading.at>p.quotaStaleSeconds*1000)return {...this.result,state:'stale',rate:null,reason:'Quota source stale; rate unknown'};
  return this.result;
 }
}
export class AlarmAudio{
 constructor({createContext=()=>new (globalThis.AudioContext||globalThis.webkitAudioContext)(),hidden=()=>globalThis.document?.hidden===true}={}){this.createContext=createContext;this.hidden=hidden;this.context=null;this.state='gesture-required';this.lastPlayed=-Infinity;}
 async enable(volume=25){try{this.context??=this.createContext();await this.context.resume();this.state=this.context.state==='running'?'ready':'blocked';if(this.state==='ready')this.tone(volume);return this.state;}catch{this.state='blocked';return this.state;}}
 status(p={}){return !p.alarmAudioEnabled?'Sound disabled':p.alarmAudioMuted?'Sound muted':p.alarmVolume===0?'Sound volume is zero':this.hidden()?'Sound suspended while page hidden':this.context?.state==='running'&&this.state==='ready'?'Sound ready in this open tab':this.state==='blocked'?'Browser audio blocked; use Enable & test sound':'Sound needs Enable & test gesture';}
 tone(volume){if(this.context?.state!=='running')return false;try{const ctx=this.context,osc=ctx.createOscillator(),gain=ctx.createGain();osc.type='sine';osc.frequency.value=660;gain.gain.setValueAtTime(0,ctx.currentTime);gain.gain.linearRampToValueAtTime(Math.max(0,Math.min(100,volume))/100*.15,ctx.currentTime+.03);gain.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+.35);osc.connect(gain);gain.connect(ctx.destination);osc.start();osc.stop(ctx.currentTime+.36);osc.onended=()=>{osc.disconnect();gain.disconnect();};return true;}catch{this.state='blocked';return false;}}
 notify(items,p,now=Date.now()){if(!p.alarmAudioEnabled||p.alarmAudioMuted||this.hidden()||now-this.lastPlayed<p.alarmCooldownSeconds*1000)return false;if(p.alarmVolume<=0)return false;const wanted=items.some(item=>{const k=alarmCondition(item);return k&&p['alarm'+k+'Enabled']&&p['alarm'+k+'Audible'];});if(!wanted||this.context?.state!=='running'||this.state!=='ready')return false;const played=this.tone(p.alarmVolume);if(played)this.lastPlayed=now;return played;}
}
export function alarmCondition(item){return item?.alarmCondition||({'weekly-quota-burn':'weeklyBurn','account-quota-alert':'lowAllowance','quota-stale':'quotaStale','telemetry-stale':'telemetryStale','source-gap':'disconnected','collector-unavailable':'disconnected',approval:'input'})[item?.kind]||(item?.attention&&['error','failure'].includes(item.kind)?'failure':item?.outcome==='failed'||item?.outcome==='interrupted'?'failure':null);}
export function configureAlarmItems(items,p){
 return items.filter(item=>{const k=alarmCondition(item);return !k||p['alarm'+k+'Enabled'];}).map(item=>{const k=alarmCondition(item);return k?{...item,alarmCondition:k,visualAlarm:p['alarm'+k+'Visual']===true}:item;});
}
export class BrowserAlarms{
 constructor(){this.quota=new WeeklyQuotaTracker();this.audio=new AlarmAudio();this.state=this.quota.result;}
 clear(){this.quota.clear();this.state=this.quota.result;}
 observeQuota(payload,p,now=Date.now()){this.state=this.quota.observe(payload,p,now);return this.state;}
 items({items=[],hosts=[],payload,preferences={},now=Date.now()}={}){
  const p={...ALARM_DEFAULTS,...preferences},q=this.quota.current(now,p),at=new Date(now).toISOString();
  this.state=q;
  const make=(id,kind,label,extra={})=>({id,kind,label,at,sourceAt:q.at?new Date(q.at).toISOString():null,category:'error',priority:0,attention:true,severity:'warning',...extra});
  // The account observer owns the weekly value. Session quota reports remain separate.
  const r=weeklyReading(payload,now,p.quotaStaleSeconds);
  let out=items.filter(i=>!(r.limitId&&i.kind==='account-quota-alert'&&i.window===r.slot&&i.label?.includes(r.limitId))); 
  if(q.state==='exceeded')out.push(make('alarm:weekly-burn:'+this.quota.key,'weekly-quota-burn','Weekly quota burning at '+q.rate.toFixed(1)+' percentage points/hour (limit '+p.quotaBurnThreshold+')',{target:'weekly'}));
  if(r.state==='fresh'&&r.remaining<p.alarmLowRemaining)out.push(make('alarm:weekly-low:'+r.limitId+':'+r.reset,'account-quota-alert','Low weekly quota · '+r.remaining.toFixed(1)+'% remaining',{target:'weekly'}));
  if(['stale','unknown','expired'].includes(r.state))out.push(make('alarm:quota-stale','quota-stale','Quota '+r.state+' · '+r.reason,{target:'weekly'}));
  const disconnected=hosts.filter(h=>['disconnected','not connected'].includes(h.status));
  if(disconnected.length&&!out.some(i=>i.kind==='source-gap'))out.push(make('alarm:hosts-disconnected','collector-unavailable',disconnected.length+' source(s) not reporting · machine power state unknown',{hostId:disconnected[0].id}));
  const stale=hosts.filter(h=>h.status==='online'&&(!finite(stamp(h.sourceObservedAt))||now-stamp(h.sourceObservedAt)>p.alarmTelemetrySeconds*1000));
  if(stale.length)out.push(make('alarm:telemetry-stale','telemetry-stale',stale.length+' connected host(s) with stale / unknown telemetry',{hostId:stale[0].id}));
  this.activeConditions=new Set(out.map(alarmCondition).filter(Boolean));
  return configureAlarmItems(out,p);
 }
}
export const browserAlarms=new BrowserAlarms();

