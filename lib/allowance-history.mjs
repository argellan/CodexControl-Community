// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {ALLOWANCE_RANGES,projectAllowanceHistory} from '../public/allowance-history.mjs';
const bad=()=>{throw Object.assign(new Error('Invalid allowance history request'),{status:400});};
export function selectWeeklyAllowance(account){
 const candidates=[];
 for(const limit of account?.limits||[])for(const slot of ['primary','secondary']){
  const w=limit?.[slot];if(w?.windowDurationMins===10080&&typeof w.usedPercent==='number'&&Number.isFinite(w.usedPercent))candidates.push({limitId:limit.limitId,slot});
 }
 return candidates.sort((a,b)=>Number(b.limitId==='codex')-Number(a.limitId==='codex')||String(a.limitId).localeCompare(String(b.limitId))||a.slot.localeCompare(b.slot))[0]||null;
}
export function readAllowanceHistory(db,{now=Date.now(),range='24h',accountKey,limitId,slot,hostIds=[]}={}){
 if(!ALLOWANCE_RANGES[range]||!Number.isSafeInteger(now)||! /^[a-f0-9]{64}$/.test(accountKey||'')||typeof limitId!=='string'||!limitId||limitId.length>128||!['primary','secondary'].includes(slot)||!Array.isArray(hostIds)||hostIds.length>65||hostIds.some(h=>typeof h!=='string'||!h||h.length>240))bad();
 const empty=()=>({...projectAllowanceHistory([],{now,range}),accountKey,limitId,slot});
 if(!hostIds.length)return empty();
 // Indexed identity/source-time range bounds first. JSON1 extracts only the
 // selected native window. The scan and rendered projection have separate caps.
 const window='$.'+slot,where=hostIds.map(()=>'?').join(',');
 const rows=db.prepare('SELECT o.limits_ms AS at,o.received_ms AS received,json_extract(o.payload,\'$.status\') AS status,json_extract(l.value,?) AS used,json_extract(l.value,?) AS reset FROM account_usage_observations o,json_each(o.payload,\'$.limits\') l WHERE o.account_identity=? AND o.limits_ms>=? AND o.limits_ms<=? AND o.host_id IN ('+where+') AND json_extract(l.value,\'$.limitId\')=? AND json_extract(l.value,?)=10080 ORDER BY o.limits_ms DESC,o.sequence DESC LIMIT 50001').all(window+'.usedPercent',window+'.resetsAt',accountKey,now-ALLOWANCE_RANGES[range],now,...hostIds,limitId,window+'.windowDurationMins');
 const scanLimited=rows.length>50000,samples=rows.slice(0,50000).map(r=>({at:r.at,used:r.used,reset:typeof r.reset==='number'?r.reset*1000:null,status:r.status}));
 return {...projectAllowanceHistory(samples,{now,range,scanLimited}),accountKey,limitId,slot};
}

