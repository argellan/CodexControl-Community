// Author: Bishop Crockett | Owner: Argellan.com | SPDX-License-Identifier: MIT
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colors=['#3687df','#f6a353','#77ce92','#e77eb1','#a48ae6','#53c7c2','#f0d563','#aebcc8'];
const labels={user:'Chats',agent_created_thread:'Agent-created chats',aeon_child:'Agent-created chats',subagent:'Subagents',security_scan:'Security scans',memory_consolidation:'Memory updates',guardian_review:'Auto review',chatgpt_handoff:'ChatGPT handoffs',composer:'User messages',app_tool_send_message:'Agent follow-ups',automation_heartbeat_scheduled:'Scheduled follow-ups',app_tool_create_thread:'Agent-created chats',send_user_message_async_question:'Replies to agent questions',desktop_app:'Desktop app',work_desktop:'Desktop (Work)',work_web:'Web (Work)',work_mobile:'Mobile (Work)',remote_android:'Remote Android',remote_ios:'Remote iOS',sdk:'SDK',exec:'Exec',cli:'CLI',CODEX_DESKTOP_APP:'Desktop app',CODEX_WORK_DESKTOP:'Desktop (Work)',CODEX_CLI:'CLI',CODEX_WEB:'Web',CODEX_WORK_WEB:'Web (Work)',CODEX_WORK_MOBILE:'Mobile (Work)',CODEX_IDE_VSCODE:'VS Code',unknown:'Unknown'};
const name=v=>labels[v]||String(v).replaceAll('_',' ').replace(/^./,c=>c.toUpperCase());
const format=n=>new Intl.NumberFormat(undefined,{maximumFractionDigits:2,notation:n>=10000?'compact':'standard'}).format(n);
const valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const add=(o,k,v)=>{if(valid(v))o[k]=(o[k]||0)+v;};
export function nativeSeries(dataset,{days=30,now=Date.now(),dimension='feature'}={}){
 const end=new Date(now).toISOString().slice(0,10),start=new Date(Date.parse(end)-(days-1)*86400000).toISOString().slice(0,10);
 const rows=(dataset?.data||[]).filter(r=>r.date>=start&&r.date<=end).map(r=>{const values={};
  if(dataset.kind==='usage')for(const a of r.attribution||[]){let k=dimension==='model'?a.model:dimension==='surface'?a.surface:dimension==='turn-start'?a.turn_trigger:a.thread_source;if(dimension==='feature'&&k==='aeon_child')k='agent_created_thread';add(values,k,a.value);}
  else if(dataset.kind==='skills'||dataset.kind==='plugins')for(const e of r.entries||[])add(values,e.label||e.name,e.count);
  else if(dataset.kind==='messages'){for(const e of dimension==='surface'?r.clients||[]:r.models||[])add(values,dimension==='surface'?e.client:e.model,e.turns);const known=Object.values(values).reduce((n,v)=>n+v,0);if(valid(r.totals?.turns)&&r.totals.turns>known)add(values,'other',r.totals.turns-known);}
  return {date:r.date,values};
 });
 const totals={};for(const r of rows)for(const[k,v]of Object.entries(r.values))add(totals,k,v);
 const keys=Object.keys(totals).sort((a,b)=>totals[b]-totals[a]||a.localeCompare(b));
 const selected=keys.slice(0,7),extra=keys.slice(7);if(extra.length)selected.push('__grouped_other');
 const table=new Map(rows.map(r=>[r.date,r]));
 const dates=Array.from({length:days},(_,i)=>{const date=new Date(Date.parse(start)+i*86400000).toISOString().slice(0,10),row=table.get(date);if(!row)return {date,values:null};const values=Object.fromEntries(selected.filter(k=>k!=='__grouped_other').map(k=>[k,row.values[k]||0]));if(extra.length)values.__grouped_other=extra.reduce((n,k)=>n+(row.values[k]||0),0);return {date,values};});
 const series=selected.map((key,i)=>({key,label:key==='__grouped_other'?'Other ('+extra.length+' categories)':name(key),total:key==='__grouped_other'?extra.reduce((n,k)=>n+totals[k],0):totals[key],color:colors[i]}));
 return {dates,series,total:Object.values(totals).reduce((n,v)=>n+v,0),reported:rows.length,units:dataset?.units||'count',allSeries:keys.map(key=>({key,label:name(key),total:totals[key]}))};
}
function chart(data,{title,line=false}={}){
 const totals=data.dates.map(r=>r.values?Object.values(r.values).reduce((n,v)=>n+v,0):null),max=Math.max(1,...(line?data.dates.flatMap(r=>Object.values(r.values||{})):totals.filter(n=>n!==null))),unit=data.units==='percent'?'%':data.units==='credits'?' credits':'';
 const legend=`<div class="native-series-legend">${data.series.map(s=>`<div><i style="background:${s.color}"></i><span>${esc(s.label)}</span><b>${format(line?s.total:data.total?s.total/data.total*100:0)}${line?'':'%'}</b></div>`).join('')}</div>`;
 let picture;
 if(line){const paths=data.series.map(s=>{let d='',previous=false;data.dates.forEach((r,i)=>{if(!r.values){previous=false;return;}d+=(previous?' L':' M')+(10+i*580/Math.max(1,data.dates.length-1)).toFixed(2)+' '+(160-(r.values[s.key]||0)/max*150).toFixed(2);previous=true;});return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" vector-effect="non-scaling-stroke"/>`;}).join('');picture=`<svg class="native-line-chart" viewBox="0 0 600 170" preserveAspectRatio="none" role="img" aria-label="${esc(title)} by day; ${data.reported} days reported"><path d="M0 10H600 M0 85H600 M0 160H600" class="native-grid-line"/>${paths}</svg>`;}
 else picture=`<div class="native-stacked-columns" role="img" aria-label="${esc(title)} by day; ${data.reported} days reported">${data.dates.map((r,i)=>`<div title="${esc(r.date+' · '+(r.values?format(totals[i])+unit:'No reading'))}" class="${r.values?'':'missing'}">${r.values?data.series.map(s=>`<i style="height:${(r.values[s.key]||0)/max*100}%;background:${s.color}" title="${esc(s.label+' · '+format(r.values[s.key]||0)+unit)}"></i>`).join(''):'<span>—</span>'}</div>`).join('')}</div>`;
 return `<div class="native-analytics-plot"><div class="native-chart-scale"><span>${format(max)}${unit}</span><span>${format(max/2)}</span><span>0</span></div>${picture}</div><footer><span>${data.dates[0].date}</span><span>${data.reported}/${data.dates.length} days reported</span><span>${data.dates.at(-1).date}</span></footer>${legend}<details><summary>All categories</summary><div class="native-category-list">${data.allSeries.map(s=>`<div><span>${esc(s.label)}</span><b>${format(s.total)}${unit}</b></div>`).join('')}</div></details><details><summary>Chart readings</summary><div class="usage-table-scroll"><table><thead><tr><th>Date</th>${data.series.map(s=>`<th>${esc(s.label)}</th>`).join('')}</tr></thead><tbody>${data.dates.map(r=>`<tr><th>${r.date}</th>${data.series.map(s=>`<td>${r.values?format(r.values[s.key]||0)+unit:'No reading'}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}
const picker=(key,options,selected)=>`<label class="native-dimension-picker"><span class="sr-only">${key==='breakdown'?'Usage breakdown':'Messages breakdown'}</span><select data-native-${key}>${options.map(([value,label])=>`<option value="${value}" ${selected===value?'selected':''}>${label}</option>`).join('')}</select></label>`;
export function renderNativeAnalytics(value,{days=30,now=Date.now(),breakdown='feature',messageBreakdown='model'}={}){
 const datasets=value?.datasets;if(!datasets)return '';
 const source=d=>`<small>Updated ${esc(new Date(d.freshness||d.collectedAt||value.observedAt).toLocaleString())}</small>`;
 const cards=[];
 if(datasets.usage){const data=nativeSeries(datasets.usage,{days,now,dimension:breakdown});cards.push(`<section class="native-chart-card"><header><div><h4>Usage history</h4>${source(datasets.usage)}</div>${picker('breakdown',[['feature','By feature'],['model','By model'],['surface','By surface'],['turn-start','By turn start']],breakdown)}</header>${chart(data,{title:'Usage history'})}</section>`);}
 for(const[k,title]of[['plugins','Plugins called'],['skills','Skills used'],['messages','Messages']])if(datasets[k]){const data=nativeSeries(datasets[k],{days,now,dimension:messageBreakdown});cards.push(`<section class="native-chart-card"><header><div><h4>${title}</h4><strong>${format(data.total)}</strong> ${source(datasets[k])}</div>${k==='messages'?picker('messages',[['model','By model'],['surface','By surface']],messageBreakdown):''}</header>${chart(data,{title,line:true})}</section>`);}
 return `<div class="native-analytics-cards">${cards.join('')}</div>`;
}
