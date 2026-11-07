// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// Read-only, bounded projections of captured account allowance; never token estimates.
export const ALLOWANCE_RANGES=Object.freeze({'24h':86400000,'48h':172800000,'7d':604800000});
const number=v=>typeof v==='number'&&Number.isFinite(v);
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function allowancePercent(remaining,used=100-remaining){
 if(!number(remaining)||remaining<0||remaining>100)return '—';
 return (Number.isInteger(used)?remaining.toFixed(0):remaining.toFixed(2))+'%';
}
export function projectAllowanceHistory(samples,{now=Date.now(),range='24h',maxPoints=480,scanLimited=false}={}){
 const duration=ALLOWANCE_RANGES[range];if(!duration||!Number.isSafeInteger(now)||!Number.isSafeInteger(maxPoints)||maxPoints<8||maxPoints>600)throw new Error('Invalid quota history range');
 const from=now-duration,byTime=new Map();let invalid=0;
 for(const r of samples){
  if(!Number.isSafeInteger(r.at)||r.at<from||r.at>now||!number(r.used)||r.used<0||r.used>100||!Number.isSafeInteger(r.reset)||r.reset<=r.at||!['available','partial'].includes(r.status)){invalid++;continue;}
  const p={at:r.at,remaining:100-r.used,reset:r.reset,used:r.used},old=byTime.get(p.at);
  if(old&&(old.used!==p.used||old.reset!==p.reset)){old.conflict=true;continue;}if(!old)byTime.set(p.at,p);
 }
 const all=[...byTime.values()].sort((a,b)=>a.at-b.at),points=[];let previous=null,pending=false,gaps=0,resets=0,increases=0,coveredMs=0;
 for(const p of all){
  if(p.conflict){invalid++;pending=true;continue;}
  const gap=previous&&p.at-previous.at>120000,reset=previous&&p.reset!==previous.reset;
  p.breakBefore=!!(pending||gap||reset);p.boundary=reset?'reset':gap||pending?'gap':null;
  if(gap)gaps++;if(reset)resets++;if(previous&&p.remaining>previous.remaining&&!reset)increases++;
  if(previous&&!p.breakBefore)coveredMs+=p.at-previous.at;
  p.breakCount=(previous?.breakCount||0)+(p.breakBefore?1:0);points.push(p);previous=p;pending=false;
 }
 let selected=points;
 if(points.length>maxPoints){
  const bins=Math.floor(maxPoints/4),groups=new Map();
  for(const [i,p]of points.entries()){const k=Math.min(bins-1,Math.floor((p.at-from)/duration*bins));if(!groups.has(k))groups.set(k,[]);groups.get(k).push(i);}
  const indices=new Set();
  for(const group of groups.values()){
   indices.add(group[0]);indices.add(group.at(-1));
   indices.add(group.reduce((a,b)=>points[a].remaining<points[b].remaining?a:b));indices.add(group.reduce((a,b)=>points[a].remaining>points[b].remaining?a:b));
  }
  selected=[...indices].sort((a,b)=>a-b).map(i=>({...points[i]}));
  for(let i=1;i<selected.length;i++)if(selected[i].breakCount!==selected[i-1].breakCount){selected[i].breakBefore=true;selected[i].boundary||='gap';}
 }
 return {bars:projectAllowanceBars(points,{from,to:now,range}),status:points.length?'observed':'unavailable',range,from,to:now,observedAt:new Date(now).toISOString(),points:selected.map(({breakCount,...p})=>p),
  coverage:{sourceRows:samples.length,validReadings:points.length,invalidReadings:invalid,returnedPoints:selected.length,downsampled:selected.length<points.length,scanLimited,gaps,resets,increases,coveredPercent:Math.min(100,coveredMs/duration*100),firstAt:points[0]?.at??null,lastAt:points.at(-1)?.at??null},
  reason:points.length?null:'No retained allowance samples for this account and range.',basis:'Captured native allowance readings; gaps and reset boundaries are not interpolated. Local retained history only; archived segments are not queried.'};
}
export function projectAllowanceBars(points,{from,to,range='24h'}={}){
 const count=range==='7d'?7:range==='48h'?48:24,duration=ALLOWANCE_RANGES[range];if(!duration||!number(from)||!number(to)||to-from!==duration)throw new Error('Invalid allowance bar interval');
 const step=duration/count,bars=Array.from({length:count},(_,index)=>({index,from:from+index*step,to:from+(index+1)*step,state:'missing',at:null,remaining:null,used:null,readings:0,gap:false,reset:false}));
 for(const point of points){if(!number(point.at)||point.at<from||point.at>to||!number(point.remaining)||point.remaining<0||point.remaining>100)continue;const bar=bars[Math.min(count-1,Math.floor((point.at-from)/step))];bar.readings++;bar.gap||=point.boundary==='gap';bar.reset||=point.boundary==='reset';if(bar.at===null||point.at>=bar.at){bar.at=point.at;bar.remaining=point.remaining;bar.used=number(point.used)?point.used:100-point.remaining;bar.state='observed';}}
 return bars;
}
const hourFormat=new Intl.DateTimeFormat([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const barTime=at=>hourFormat.format(new Date(at));
const shortHour=new Intl.DateTimeFormat([],{hour:'2-digit',minute:'2-digit',hour12:false}),shortDay=new Intl.DateTimeFormat([],{month:'short',day:'numeric'});
export function allowanceBarDescription(bar,{range='24h'}={}){return barTime(bar.from)+' to '+barTime(bar.to)+': '+(bar.state==='missing'?'no captured reading':allowancePercent(bar.remaining,bar.used)+' remaining, last captured '+barTime(bar.at))+(bar.reset?'; allowance reset in this interval':'')+(bar.gap?'; capture gap in this interval':'')+(range==='7d'?'; 24-hour interval':'');}
export function allowanceChart(history,{range='24h',account=null,now=Date.now(),selectedIndex=null}={}){
 const duration=ALLOWANCE_RANGES[range]||ALLOWANCE_RANGES['24h'],validBounds=number(history?.from)&&number(history?.to)&&history.to-history.from===duration&&history.to<=now,to=validBounds?history.to:now,from=to-duration;
 const weekly=account?.weekly,compatible=typeof history?.accountKey==='string'&&history.accountKey===account?.accountKey&&history.limitId===weekly?.limitId&&history.slot===weekly?.slot&&(!history.range||history.range===range);
 let bars=projectAllowanceBars(compatible&&Array.isArray(history.points)?history.points:[],{from,to,range});
 if(compatible&&validBounds&&Array.isArray(history.bars)&&history.bars.length===bars.length){bars=history.bars.map((bar,index)=>{const basis=bars[index];if(bar?.index!==index||bar.from!==basis.from||bar.to!==basis.to||!number(bar.at)||bar.at<bar.from||bar.at>bar.to||!number(bar.remaining)||bar.remaining<0||bar.remaining>100)return basis;return {...basis,state:'observed',at:bar.at,remaining:bar.remaining,used:number(bar.used)?bar.used:100-bar.remaining,readings:Number.isSafeInteger(bar.readings)&&bar.readings>0?bar.readings:1,gap:bar.gap===true,reset:bar.reset===true};});}
 const observed=bars.filter(bar=>bar.state==='observed'),index=Number.isInteger(selectedIndex)?Math.max(0,Math.min(bars.length-1,selectedIndex)):observed.at(-1)?.index??bars.length-1,selected=bars[index],description=allowanceBarDescription(selected,{range}),summary=bars.length+(range==='7d'?' daily':' hourly')+' bars. Last captured remaining percentage in each interval; missing intervals are not estimated. '+(history?.coverage?.gaps??0)+' capture gaps; '+(history?.coverage?.resets??0)+' reset boundaries.';
 const controls=Object.keys(ALLOWANCE_RANGES).map(r=>'<button type="button" data-quota-range="'+r+'" aria-pressed="'+(r===range)+'" aria-label="Quota history: last '+({'24h':'24 hours','48h':'48 hours','7d':'7 days'})[r]+'">'+r+'</button>').join(''),step=216/bars.length,width=Math.max(1,step-(bars.length===7?6:1.5));
 const columns=bars.map(bar=>{const missing=bar.state==='missing',height=missing?32:Math.max(1,bar.remaining/100*32),x=22+bar.index*step+.75,y=36-height;return '<g><title>'+escape(allowanceBarDescription(bar,{range}))+'</title><rect data-quota-index="'+bar.index+'" class="quota-bar '+(missing?'missing':'observed')+(bar.gap?' partial':'')+(bar.index===index?' selected':'')+'" x="'+x.toFixed(2)+'" y="'+y.toFixed(2)+'" width="'+width.toFixed(2)+'" height="'+height.toFixed(2)+'"/>'+(bar.reset?'<path class="quota-reset" d="M'+x.toFixed(2)+',2v34"/>':'')+'</g>';}).join('');
 return '<section class="allowance-history" aria-label="Weekly quota history"><div class="allowance-history-controls"><span>Quota history</span><div role="group" aria-label="Quota graph range">'+controls+'</div></div><div class="allowance-plot quota-bars" role="slider" tabindex="0" data-quota-bars="'+range+'" data-quota-selected="'+index+'" data-quota-count="'+bars.length+'" aria-label="'+escape(summary)+'" aria-orientation="horizontal" aria-valuemin="1" aria-valuemax="'+bars.length+'" aria-valuenow="'+(index+1)+'" aria-valuetext="'+escape(description)+'"><div class="quota-axis" aria-hidden="true"><span>100</span><span>50</span><span>0</span></div><svg viewBox="18 0 222 40" preserveAspectRatio="none" aria-hidden="true"><path class="quota-grid" d="M22,4H238 M22,20H238 M22,36H238"/>'+columns+(!observed.length?'<text class="quota-empty" x="40" y="24">'+escape(history?.status==='loading'?'Reading history…':'No captured history')+'</text>':'')+'</svg></div><div class="allowance-chart-caption"><span>'+escape((range==='7d'?shortDay:shortHour).format(new Date(selected.to)))+'</span><span class="quota-selected-reading" title="'+escape(description)+'">'+escape(selected.state==='missing'?'No reading':allowancePercent(selected.remaining,selected.used))+'</span><span>'+(history?.status==='failed'?'History unavailable':selected.reset?'Reset':selected.gap?'Gap':selectedIndex===null?'Latest':'Selected')+'</span></div></section>';
}
