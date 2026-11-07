// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// Presentation policy only: no source event, approval state or collector record is modified.
const formats=new Map(),SEVERITY={info:0,warning:1,critical:2};
function timestamp(value){if(value===null||value===undefined||value==='')return NaN;const n=typeof value==='number'?value:value instanceof Date?value.getTime():typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(n)&&Number.isFinite(new Date(n).getTime())?n:NaN;}
function zone(value){return !value||value==='local'?Intl.DateTimeFormat().resolvedOptions().timeZone:value;}
function formatter(key,options,locale='en-GB'){if(!formats.has(key)){if(formats.size>=64)formats.delete(formats.keys().next().value);formats.set(key,new Intl.DateTimeFormat(locale,options));}return formats.get(key);}
function timeFormat(at,timeZone,prefs){const twelve=prefs.clockFormat==='12h',millis=prefs.clockMilliseconds!==false,options={timeZone,hour:'2-digit',minute:'2-digit',second:'2-digit',...(twelve?{hour12:true}:{hourCycle:'h23'}),...(millis?{fractionalSecondDigits:3}:{})};return formatter('clock|'+timeZone+'|'+twelve+'|'+millis,options,twelve?'en-US':'en-GB').format(at);}
export function presentationClocks(at,preferences={}){
 const n=timestamp(at);if(!Number.isFinite(n))return {local:'—',utc:'—',zone:'UNAVAILABLE',date:'Unavailable'};
 const prefs=preferences||{},utc=timeFormat(n,'UTC',prefs);try{const tz=zone(prefs.clockTimezone),local=timeFormat(n,tz,prefs),label=formatter('zone|'+tz,{timeZone:tz,timeZoneName:'short'},'en-US').formatToParts(n).find(p=>p.type==='timeZoneName')?.value||tz,date=formatter('date|'+tz,{timeZone:tz,day:'2-digit',month:'short'}).format(n);return {local,utc,zone:label,date};}catch{return {local:'—',utc,zone:'UNAVAILABLE',date:formatter('date|UTC',{timeZone:'UTC',day:'2-digit',month:'short'}).format(n)};}
}
export function presentationMotion(preferences={},systemReduced=false){const mode=preferences?.motionMode;return {reduced:Boolean(systemReduced)||mode==='reduced',paused:mode==='paused'};}
function alertSeverity(item){if(item?.kind==='approval'||item?.category==='approval'||['input','input-request'].includes(item?.kind))return SEVERITY.critical;if(item?.kind==='source-gap')return SEVERITY.info;if(['error','service-alert','resource-alert','quota-alert','tool-unanswered'].includes(item?.kind)||['failed','interrupted'].includes(item?.outcome))return SEVERITY.warning;return Object.hasOwn(SEVERITY,item?.severity)?SEVERITY[item.severity]:SEVERITY.info;}
function minuteOfDay(value){const match=/^([01]\d|2[0-3]):([0-5]\d)$/.exec(value||'');return match?Number(match[1])*60+Number(match[2]):null;}
function inQuietHours(policy,now,timeZone){if(policy?.enabled!==true||!Number.isFinite(now))return false;const start=minuteOfDay(policy.start),end=minuteOfDay(policy.end);if(start===null||end===null||start===end)return false;try{const tz=zone(timeZone),parts=formatter('minutes|'+tz,{timeZone:tz,hourCycle:'h23',hour:'2-digit',minute:'2-digit'}).formatToParts(now),minute=Number(parts.find(p=>p.type==='hour').value)*60+Number(parts.find(p=>p.type==='minute').value);return start<end?minute>=start&&minute<end:minute>=start||minute<end;}catch{return false;}}
export function presentationAlerts(attention=[],{policy={},preferences={},now=Date.now(),timezone}={}){
 const prefs=preferences||{},configuration=policy||{},clock=timestamp(now),minimum=Object.hasOwn(SEVERITY,configuration.minimumSeverity)?SEVERITY[configuration.minimumSeverity]:SEVERITY.warning;
 const quieted=new Set();if(Number.isFinite(clock)&&Array.isArray(prefs.acknowledgedAlerts))for(const ack of prefs.acknowledgedAlerts.slice(0,64)){const until=timestamp(ack?.until);if(typeof ack?.id==='string'&&ack.id.length>0&&ack.id.length<=240&&typeof ack.until==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(ack.until)&&Number.isFinite(until)&&until>clock&&until<=clock+86400000)quieted.add(ack.id);}
 // The caller supplies current attention evidence. Old or unclocked input requests
 // do not become resolved merely because a presentation clock cannot date them.
 const eligible=(Array.isArray(attention)?attention:[]).filter(item=>item&&alertSeverity(item)>=minimum),visibleItems=eligible.filter(item=>!quieted.has(item.id)&&!quieted.has(item.eventId));
 const quietHours=inQuietHours(configuration.quietHours,clock,timezone||prefs.clockTimezone),tickerVisible=configuration.presentation?.ticker!==false&&prefs.alertTicker!==false;
 return {visibleItems,quietedCount:eligible.length-visibleItems.length,tickerVisible,glow:visibleItems.length>0&&configuration.presentation?.glow!==false&&prefs.alertGlow!==false&&!quietHours,quietHours};
}
