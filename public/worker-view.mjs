// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// ARGELLAN inspection fragments. Inputs are metadata projections, never source
// messages, arguments, file contents, transcripts or provider control objects.
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const formatter=new Intl.NumberFormat('en-US',{maximumFractionDigits:0});
const count=value=>number(value)===null?'—':formatter.format(value);
const percent=value=>number(value)===null?null:Math.max(0,Math.min(100,value));
const elapsed=value=>{const n=number(value);if(n===null)return'age unavailable';if(n<1000)return'<1s';if(n<60000)return Math.floor(n/1000)+'s';if(n<3600000)return Math.floor(n/60000)+'m';if(n<86400000)return Math.floor(n/3600000)+'h';return Math.floor(n/86400000)+'d';};
const stateClass=value=>['active','quiet','waiting','completed','interrupted','source-unavailable','unconfirmed','observed','expired','stale'].includes(value)?value:'unknown';
const sessionKey=s=>s.key||[s.hostId||'local',s.id].join('/');

function meter(label,value,qualifier='',state='observed'){
 const amount=percent(value),kind=stateClass(state);
 return `<div class="worker-meter ${kind}"><div><span>${esc(label)}</span><b>${amount===null?'Unavailable':amount.toFixed(amount%1?1:0)+'%'}</b></div>${amount===null?'<span class="worker-meter-unknown" aria-hidden="true"></span>':`<meter min="0" max="100" value="${amount}" aria-label="${esc(label+' '+qualifier)}">${amount}%</meter>`}${qualifier?`<small>${esc(qualifier)}</small>`:''}</div>`;
}

function relationButton(s,prefix=''){
 return `<button type="button" class="worker-relation" data-session="${esc(sessionKey(s))}"><span class="worker-relation-icon" aria-hidden="true">${prefix?'↰':'↳'}</span><span><b>${esc(s.nickname||s.id?.slice(0,8)||'Unknown worker')}</b><small>${esc(s.model||'Model unavailable')}</small></span><span class="worker-state state-${stateClass(s.lifecycle?.state)}">${esc(s.lifecycle?.label||'Unknown state')}</span></button>`;
}

export function renderWorkerDetails(summary){
 if(!summary)return'<p class="empty">Select a worker to inspect recorded activity.</p>';
 const s=summary,context=s.context||{},counts=s.toolCounts||{},tools=Array.isArray(s.openTools)?s.openTools.slice(0,16):[],children=Array.isArray(s.children)?s.children.slice(0,24):[];
 const totalChildren=number(s.childrenTotal)??children.length;
 const usage=number(s.tokens?.total_tokens),contextReading=percent(context.usedPercent),sourceLabel=s.sourceStatus||'unknown';
 const counter=(label,value,kind='')=>`<span class="worker-counter ${kind}"><b>${count(value)}</b><small>${esc(label)}</small></span>`;
 return `<div class="worker-details">
  <div class="worker-detail-title"><span aria-hidden="true">◈</span><h3>${esc(s.nickname||s.project||s.id?.slice(0,8)||'Worker')}</h3><span class="worker-state state-${stateClass(s.lifecycle?.state)}">${esc(s.lifecycle?.label||'Unknown state')}</span></div>
  <div class="worker-source-state"><span>Source ${esc(sourceLabel)}</span><span>${esc(elapsed(s.ageMs))} since activity</span></div>
  <dl class="worker-metadata"><dt>Model</dt><dd>${esc(s.model||'Model unavailable')}</dd><dt>Effort</dt><dd>${esc(s.effort||'Not reported')}</dd></dl>
  ${meter('Last reported model context',contextReading,contextReading===null?'Context unavailable':count(context.usedTokens)+' / '+count(context.maxTokens)+' tokens',contextReading===null?'unknown':'observed')}
  <div class="worker-token-line"><span>${usage===null?'Token reading unavailable':count(usage)+' observed cumulative tokens'}</span><small>not subscription billing</small></div>
  ${s.forkedFrom?'<p class="worker-caveat">Inherited fork counter · excluded from fleet token totals.</p>':''}
  <div class="worker-counters" role="group" aria-label="Retained event counts">${counter('Tool starts',counts.started)}${counter('Returns',counts.returned)}${counter('Failures',counts.failed,'failure')}${counter('Input waits',s.waitingCount,'wait')}</div>
  ${s.captureIncomplete?'<p class="worker-caveat">Partial capture · counts and state may be incomplete.</p>':''}
  ${s.lastLabel?`<p class="worker-last-label">${esc(s.lastLabel)}</p>`:''}
  <div class="worker-section-heading"><b>Tool observations</b><span>${count(s.unresolvedTools)} without paired results</span></div>
  ${tools.length?`<div class="worker-tool-list">${tools.map(t=>`<button type="button" data-event="${esc(t.id)}" class="worker-tool-row"><span aria-hidden="true">${s.lifecycle?.state==='active'?'◆':'◇'}</span><b>${esc(t.label||'Tool call')}</b><time>${esc(elapsed(t.ageMs))}</time></button>`).join('')}</div>`:`<p class="worker-empty">${s.unresolvedTools?'Earlier calls have no captured result. Terminal turn evidence is shown above.':'No open tool record in this capture.'}</p>`}
  ${s.parent?`<div class="worker-section-heading"><b>Explicit parent</b></div>${relationButton(s.parent,'parent')}`:s.parentMissing?'<p class="worker-caveat">Explicit parent is outside this capture.</p>':''}
  <div class="worker-section-heading"><b>Explicit subagents</b><span>${count(totalChildren)}</span></div>
  ${children.length?`<div class="worker-relation-list">${children.map(c=>relationButton(c)).join('')}</div>`:'<p class="worker-empty">No child relationship recorded.</p>'}
  ${totalChildren>children.length?`<p class="worker-empty">${count(totalChildren-children.length)} more children in the worker list.</p>`:''}
  <details class="worker-identities"><summary>Source identity and capture</summary><dl><dt>Host</dt><dd>${esc(s.hostName||s.hostId||'Unknown')}</dd><dt>Worker</dt><dd>${esc(s.id)}</dd><dt>Last event</dt><dd>${esc(s.lastEventId||'Unavailable')}</dd><dt>Recorded</dt><dd>${esc(s.lastEventAt||'Unavailable')}</dd><dt>Tool counter</dt><dd>${count(s.reportedToolCount)} source-reported</dd><dt>Changes</dt><dd>${count(s.reportedChangeCount)} source-reported</dd></dl></details>
 </div>`;
}

function quotaWindow(window,name){
 if(!window)return `<div class="usage-window unknown"><span>${name}</span><p class="worker-empty">Not reported</p></div>`;
 const state=stateClass(window.state),remaining=percent(window.remainingPercent),duration=number(window.windowDurationMins);
 const label=duration!==null&&duration>0?(duration<60?duration+' min':duration%1440===0?duration/1440+' day':duration%60===0?duration/60+' hour':duration+' min'):name;
 const reset=state==='expired'?'Reset time passed · awaiting a fresh reading':number(window.resetInMs)===null?'Reset time unavailable':'Reset in '+elapsed(window.resetInMs);
 const qualification=state==='observed'?'Source observed':state==='expired'?'Expired reading':state==='stale'?'Stale reading':'Unavailable';
 return `<div class="usage-window ${state}"><div class="usage-window-title"><b>${esc(label)}</b><span>${qualification}</span></div>${meter('Remaining allowance',remaining,(remaining===null?'Unavailable':remaining.toFixed(remaining%1?1:0)+'% last reported remaining'),state)}<small>${esc(reset)}</small><small>${esc(elapsed(window.ageMs))} since sample</small></div>`;
}

function quotaSighting(q,linked){
 return `<section class="usage-sighting ${linked?'is-linked':'is-unlinked'}"><header><div><b>${esc(q.limitName||q.limitId||'Quota reading')}</b><small>${linked?'Explicit account quota':'Account-unlinked · source reading'}</small></div><button type="button" data-session="${esc([q.hostId||'local',q.sessionId].join('/'))}">${esc(q.hostId||'Source')} ↗</button></header><div class="usage-windows">${quotaWindow(q.primary,'Primary')}${quotaWindow(q.secondary,'Secondary')}</div>${linked?`<small>${count(q.sourceCount)} source reports · shared account counted once</small>`:''}</section>`;
}

function hostContribution(row){
 const name=row.hostName||row.hostId||'Unknown source',reading=number(row.totalTokens),share=percent(row.sharePercent);
 return `<div class="usage-host-row"><span class="usage-host-name">${esc(name)}<small>Source ${esc(row.sourceStatus||'unknown')}</small></span><b>${reading===null?'Token reading unavailable':count(reading)+' observed tokens'}</b>${share===null?'<span class="usage-host-unknown" aria-hidden="true"></span>':`<meter min="0" max="100" value="${share}" aria-label="${esc(name+' share of observed session tokens')}">${share.toFixed(1)}%</meter>`}<small>${count(row.sessionsWithReadings)} sessions · ${count(row.unknownSessions)} unread · ${count(row.excludedForks)} forks excluded${share===null?'':' · '+share.toFixed(share%1?1:0)+'% of observations'}</small></div>`;
}

export function renderUsageDetails(summary){
 const s=summary||{},tokens=s.tokens||{},quota=s.quota||{},pools=Array.isArray(quota.pools)?quota.pools:[],unlinked=Array.isArray(quota.unlinked)?quota.unlinked:[],models=Array.isArray(s.models)?s.models:[],hosts=Array.isArray(s.hosts)?s.hosts:[];
 const sightings=[...pools.map(q=>({q,linked:true})),...unlinked.map(q=>({q,linked:false}))],shown=sightings.slice(0,32),modelRows=models.slice(0,20),hostRows=hosts.slice(0,20),maxTokens=Math.max(1,...modelRows.map(m=>number(m.totalTokens)??0));
 return `<div class="usage-details"><div class="usage-overview"><div><small>Observed session tokens</small><b>${count(tokens.observedTotal)}</b><span>tokens / ${count(tokens.sessionsWithReadings)} distinct host sessions</span></div><div><small>Subscription billing</small><b>Unavailable</b><span>Subscription billing unavailable</span></div></div>
  <p class="worker-caveat">Observed metadata is incomplete. Fork totals excluded: ${count(tokens.excludedForks)}. Sessions without a reading: ${count(tokens.unknownSessions)}. No subscription bill or API cost is inferred.</p>
  <div class="worker-section-heading"><b>Observed tokens by machine</b><span>${count(hosts.length)} machines</span></div>
  <p class="worker-empty">One newest counter per host and session; observations can overlap when a thread is copied between machines. Bar shares describe captured tokens, not account quota.</p>
  ${hostRows.length?`<div class="usage-hosts">${hostRows.map(hostContribution).join('')}</div>`:'<p class="worker-empty">No machine token observations captured.</p>'}
  ${hostRows.length<hosts.length?`<p class="worker-empty">Top ${hostRows.length} of ${count(hosts.length)} machines shown.</p>`:''}
  <div class="worker-section-heading"><b>Quota observations</b><span>${count(sightings.length)} readings</span></div>
  ${unlinked.length?'<p class="usage-account-warning">Account-unlinked source reports. Do not add these allowances; account identity has not been established across machines.</p>':''}
  ${shown.length?`<div class="usage-quota-list">${shown.map(({q,linked})=>quotaSighting(q,linked)).join('')}</div>`:'<p class="worker-empty">Quota unavailable · no compatible source reading captured.</p>'}
  ${shown.length<sightings.length?`<p class="worker-empty">${shown.length} of ${count(sightings.length)} source readings shown; newest within each source group.</p>`:''}
  <div class="worker-section-heading"><b>Current-model attribution</b><span>${count(models.length)} models</span></div>
  <p class="worker-empty">Thread counters use the latest recorded model label; a model change can span the same cumulative counter.</p>
  ${modelRows.length?`<div class="usage-models">${modelRows.map(m=>`<div class="usage-model-row"><span>${esc(m.model||'Unknown model')}</span><b>${count(m.totalTokens)}</b><span class="usage-model-track" aria-hidden="true"><i style="width:${Math.max(0,Math.min(100,(number(m.totalTokens)??0)/maxTokens*100))}%"></i></span><small>${count(m.sessions)} threads</small></div>`).join('')}</div>`:'<p class="worker-empty">No compatible token counters captured.</p>'}
  ${modelRows.length<models.length?`<p class="worker-empty">Top ${modelRows.length} of ${count(models.length)} model labels shown.</p>`:''}
 </div>`;
}
