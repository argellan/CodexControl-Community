// Author: Bishop Crockett; Owner: Argellan.com; License: MIT; SPDX-License-Identifier: MIT
const size = value => {if(!Number.isFinite(value))return 'Unknown';const gib=Math.abs(value)>=1073741824;return (value/(gib?1073741824:1048576)).toLocaleString(undefined,{maximumFractionDigits:1})+(gib?' GiB':' MiB');};
const time = value => value ? new Date(value).toLocaleString() : 'Not observed';
export function mountProcesses({document, window, request, getContext}) {
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, label) => {const node = el('button', text); node.type = 'button'; if (label) node.setAttribute('aria-label', label); return node;};
  const dialog = el('dialog', undefined, 'account-dialog process-workspace');
  dialog.id = 'process-dialog'; dialog.setAttribute('aria-labelledby', 'process-title');
  const heading = el('div', undefined, 'panel-heading'), title = el('h2', 'Process Explorer'); title.id = 'process-title';
  const close = button('×', 'Close Process Explorer'); heading.append(title, el('span', 'READ ONLY', 'badge'), close);
  const body = el('div', undefined, 'process-body'), toolbar = el('div', undefined, 'process-toolbar');
  function selector(label, values) {
    const wrap = el('label', label + ' '), input = el('select'); input.setAttribute('aria-label', 'Process ' + label.toLowerCase());
    for (const [value, text] of values) {const option = el('option', text); option.value = value; input.append(option);}
    wrap.append(input); toolbar.append(wrap); return input;
  }
  const host = selector('Host', []), view = selector('View', [['resources','Resource usage'],['tree','Process tree']]);
  const state = selector('Status', [['','All statuses'], ...['Active','Unknown','Exited','Waiting','Reusable idle','Task completed/process retained','Suspected leftover'].map(s=>[s,s])]);
  const search = el('input'); search.type = 'search'; search.placeholder = 'Executable, role or PID'; search.setAttribute('aria-label', 'Search processes');
  const refresh = button('Refresh'), autoLabel = el('label'), auto = el('input'); auto.type = 'checkbox'; auto.checked = true; autoLabel.append(auto, ' Update while open'); toolbar.append(search, refresh, autoLabel);
  const notice = el('p', 'OS processes, not separate Codex jobs. Task ownership is not yet attached. Private commit is not working set or reclaimable RAM.', 'note');
  const status = el('p', '', 'scope-note'); status.setAttribute('role','status');
  const metrics = el('div', undefined, 'diagnostic-cards process-metrics');
  const metricValues = [];
  for (const label of ['Matching processes','Private commit','Growth / minute','Unknown activity']) {const card=el('div'), value=el('b','—'); card.append(el('small',label),value);metrics.append(card);metricValues.push(value);}
  const tableWrap = el('div', undefined, 'process-table-wrap'), table = el('table', undefined, 'process-table');
  tableWrap.tabIndex=0;tableWrap.setAttribute('role','region');tableWrap.setAttribute('aria-label','Process resource table, scroll for more columns or rows');
  const caption = el('caption','Observed processes · select a row to inspect the evidence', 'sr-only'), thead=el('thead'), header=el('tr');
  for (const label of ['Process / observed role','Status','Private commit','Growth / min','CPU · 1 core']) {const th=el('th',label);th.scope='col';header.append(th);}
  thead.append(header); const rows = el('tbody'); table.append(caption,thead,rows);tableWrap.append(table);
  const pager=el('div',undefined,'process-pager'),previous=button('Previous'),next=button('Next'),range=el('span');pager.append(previous,range,next);
  const custody=el('details'),custodyTitle=el('summary','Coverage and retained history'),custodyText=el('p','No observation loaded.','note');custody.append(custodyTitle,custodyText);
  body.append(toolbar,notice,metrics,status,tableWrap,pager,custody);dialog.append(heading,body);document.body.append(dialog);

  const inspector=el('dialog',undefined,'account-dialog process-inspector'), detailHead=el('div',undefined,'panel-heading'),detailTitle=el('h2','Process evidence'),detailClose=button('×','Close process evidence'),detailBody=el('div',undefined,'process-body');
  detailTitle.id='process-evidence-title';inspector.setAttribute('aria-labelledby',detailTitle.id);detailHead.append(detailTitle,detailClose);inspector.append(detailHead,detailBody);document.body.append(inspector);
  let timer=null, debounce=null, generation=0, offset=0, busy=false, returnFocus=null, selected=null, detailFocus=null, signature='', contextStamp='',pendingRead=null,pendingDetail=null;
  const rowNodes=new Map(),collapsed=new Set();
  const contextKey=()=>{const c=getContext();return JSON.stringify([c.authorized,c.authority,c.host,c.project]);};
  const stop=()=>{if(timer!==null)window.clearTimeout(timer);timer=null;};
  function schedule(){stop();if(dialog.open&&!document.hidden&&auto.checked)timer=window.setTimeout(load,15000);}
  function clear(){rows.replaceChildren();rowNodes.clear();signature='';metricValues.forEach(n=>{n.textContent='—';});range.textContent='';previous.disabled=next.disabled=true;custodyText.textContent='No observation available for this scope.';if(inspector.open)inspector.close();}
  function query(mode='list'){const q=new URLSearchParams({host:host.value,view:view.value,status:state.value,q:search.value,limit:'50',offset:String(offset)});if(mode==='detail')q.set('key',selected);else for(const key of collapsed)q.append('collapsed',key);return '/api/processes'+(mode==='detail'?'/detail':'')+'?'+q;}
  function valid(turn){return turn===generation&&dialog.open&&contextKey()===contextStamp;}
  async function inspect(key, target){
    pendingDetail?.abort();const controller=new AbortController();pendingDetail=controller;selected=key;detailFocus=target;const turn=generation;detailTitle.textContent='Process evidence';detailBody.replaceChildren(el('p','Reading exact process identity…','note'));if(!inspector.open){inspector.showModal();detailClose.focus();}
    try {const data=await request(query('detail'),{signal:controller.signal});if(!valid(turn)||!inspector.open||selected!==key)return;const p=data.rows[0];detailTitle.textContent=p.executable+' · PID '+p.pid;
      const facts=el('dl',undefined,'map-station-details');
      for(const [name,value] of [['Observed role',p.role],['Application family',p.family],['Status',p.status],['Confidence',p.confidence],['Task ownership',p.ownershipConfidence],['Started',time(p.createdAt)],['Last observed',time(p.observedAt)],['Parent PID',p.parentPid??'Not established'],['Private commit',size(p.privateCommitBytes)],['Working set',size(p.workingSetBytes)],['Private growth / min',size(p.privateGrowthBytesPerMinute)],['CPU · one core',p.cpuOneCorePercent===null?'Unknown':p.cpuOneCorePercent.toFixed(1)+'%']])facts.append(el('dt',name),el('dd',String(value)));
      const reasons=el('ul');for(const reason of p.reasons)reasons.append(el('li',reason.replaceAll('_',' ').toLowerCase()));for(const reason of p.contradictions)reasons.append(el('li','Contradiction: '+reason.replaceAll('_',' ').toLowerCase()));
      const history=el('ol');for(const point of p.points)history.append(el('li',time(point.at)+' · '+size(point.privateCommitBytes)+' private commit'));
      const events=el('ol');for(const event of p.timeline)events.append(el('li',time(event.at)+' · '+event.type));
      detailBody.replaceChildren(el('h3','Why this status?'),el('p',p.explanation,'note'),reasons,facts,el('h3','Recent resource observations'),history,el('h3','Observed lifecycle'),events,el('p','OS telemetry cannot establish a task owner or whether termination is safe. No process controls are available.','note'));
    }catch(error){if(valid(turn)&&inspector.open&&selected===key)detailBody.replaceChildren(el('p',error.message||'Process evidence unavailable.','note'));}
  }
  function updateRows(data){
    const focused=document.activeElement,current=new Set(),peak=Math.max(1,...data.rows.map(p=>p.privateCommitBytes||0));
    for(const p of data.rows){current.add(p.key);let row=rowNodes.get(p.key);
      if(!row){row=el('tr');const main=el('td'),open=button(''),role=el('small'),identity=el('code'),branch=button('Collapse');branch.addEventListener('click',()=>{if(collapsed.has(p.key))collapsed.delete(p.key);else if(collapsed.size<100)collapsed.add(p.key);offset=0;refreshView();});main.append(open,role,identity,branch);row.append(main,...Array.from({length:4},()=>el('td')));open.addEventListener('click',()=>inspect(p.key,open));rowNodes.set(p.key,row);}
      const [main,activity,memory,growth,cpu]=row.children;main.children[0].textContent=p.executable;main.children[0].setAttribute('aria-label','Inspect '+p.executable+' PID '+p.pid);main.children[1].textContent=p.role+' · '+p.family;main.children[3].hidden=view.value!=='tree'||!p.childCount;main.children[3].textContent=collapsed.has(p.key)?'Expand':'Collapse';main.children[3].setAttribute('aria-expanded',String(!collapsed.has(p.key)));main.children[3].setAttribute('aria-label',(collapsed.has(p.key)?'Expand':'Collapse')+' children of PID '+p.pid);main.children[2].textContent='PID '+p.pid+(p.childCount?' · '+p.childCount+' children':'');main.style.paddingLeft=(10+Math.min(p.depth||0,8)*14)+'px';activity.textContent=p.status;activity.dataset.state=p.status;memory.textContent=size(p.privateCommitBytes);if(p.privateCommitBytes!==null){const meter=el('meter');meter.min=0;meter.max=peak;meter.value=p.privateCommitBytes;meter.setAttribute('aria-label','Private commit relative to the largest process on this page, not total RAM');memory.append(meter);}growth.textContent=size(p.privateGrowthBytesPerMinute);cpu.textContent=p.cpuOneCorePercent===null?'—':p.cpuOneCorePercent.toFixed(1)+'%';
    }
    for(const [key,node] of rowNodes)if(!current.has(key)){node.remove();rowNodes.delete(key);}
    // Stable keyed rows avoid replacing focused controls on unchanged refreshes.
    data.rows.forEach((p,i)=>{const node=rowNodes.get(p.key);if(rows.children[i]!==node)rows.insertBefore(node,rows.children[i]||null);});if(focused?.isConnected&&rows.contains(focused)&&document.activeElement!==focused)focused.focus({preventScroll:true});
  }
  async function load(){
    stop();if(!dialog.open||document.hidden||busy)return;
    if(contextKey()!==contextStamp){generation++;contextStamp=contextKey();clear();status.textContent='Dashboard scope changed. Close and reopen Process Explorer to inspect the new scope.';return;}
    if(getContext().project){clear();status.textContent='A project is selected. Process-to-project ownership is not available yet; choose All projects in the dashboard before inspecting host-wide processes.';return;}
    if(!host.value){clear();status.textContent='Select a host to inspect its process observations.';return;}
    busy=true;refresh.disabled=true;const turn=generation,controller=new AbortController();pendingRead=controller;
    try{const data=await request(query(),{signal:controller.signal});if(!valid(turn))return;
      const sum=data.summary;metricValues[0].textContent=sum.processes??'Unknown';metricValues[1].textContent=size(sum.privateCommitBytes);metricValues[2].textContent=size(sum.privateGrowthBytesPerMinute);metricValues[3].textContent=sum.unknown??'Unknown';
      const coverage=data.hostCoverage?.[0];status.textContent=data.status==='not-observed'?'No process observation received. Collection may be disabled or unsupported.':host.selectedOptions[0].textContent+' · Observed '+time(coverage?.observedAt)+' · '+(coverage?.observedAt&&Date.now()-Date.parse(coverage.observedAt)>30000?'STALE · ':'')+(coverage?.status||'unknown')+' coverage · '+(sum.privateCommitCoverage??0)+' measured';
      const nextSignature=JSON.stringify([data.projectionSequence,view.value,offset,search.value,state.value,data.rows]);if(nextSignature!==signature){updateRows(data);signature=nextSignature;}
      range.textContent=data.total?`${offset+1}–${Math.min(offset+50,data.visibleTreeCount??data.total)} of ${data.visibleTreeCount??data.total} visible · ${data.total} matching`:'No matching processes';previous.disabled=offset===0;next.disabled=!data.hasMore;
      custodyText.textContent=`${data.retained?.n??0} full observations retained on the hub. ${data.archive?.pendingObservations??'Unknown'} awaiting a verified archive receipt. Local eviction is disabled, including after verification. Display is limited to 50 rows and the latest three resource samples. Parent links use PID and creation-time checks. No task ownership is inferred.`;
    }catch(error){if(valid(turn)){clear();status.textContent=error.message||'Process telemetry unavailable. Previous usage is not zero.';}}
    finally{if(pendingRead===controller)pendingRead=null;if(turn===generation){busy=false;refresh.disabled=false;schedule();}}
  }
  function refreshView(){pendingRead?.abort();generation++;busy=false;void load();}
  function change(){offset=0;collapsed.clear();clear();refreshView();}
  for(const input of [host,view,state])input.addEventListener('change',change);
  search.addEventListener('input',()=>{if(debounce!==null)window.clearTimeout(debounce);debounce=window.setTimeout(change,250);});
  previous.addEventListener('click',()=>{offset=Math.max(0,offset-50);refreshView();});next.addEventListener('click',()=>{offset+=50;refreshView();});refresh.addEventListener('click',()=>{void load();});auto.addEventListener('change',schedule);
  close.addEventListener('click',()=>dialog.close());detailClose.addEventListener('click',()=>inspector.close());inspector.addEventListener('close',()=>{pendingDetail?.abort();pendingDetail=null;selected=null;if(dialog.open&&detailFocus?.isConnected)detailFocus.focus({preventScroll:true});});
  dialog.addEventListener('close',()=>{pendingRead?.abort();pendingRead=null;stop();if(debounce!==null)window.clearTimeout(debounce);generation++;busy=false;clear();if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});});
  document.addEventListener('visibilitychange',()=>{stop();if(!document.hidden&&dialog.open)void load();});
  return {dialog,async open(){returnFocus=document.activeElement;contextStamp=contextKey();const turn=++generation;offset=0;clear();host.replaceChildren();const prompt=el('option','Select a host');prompt.value='';host.append(prompt);dialog.showModal();close.focus();
    if(getContext().project){void load();return;}
    status.textContent='Reading authorized process sources…';
    const controller=new AbortController();pendingRead=controller;try{const sources=await request('/api/processes/hosts',{signal:controller.signal});if(!valid(turn))return;for(const h of sources.hosts){const option=el('option',h.label||h.id);option.value=h.id;host.append(option);}if(getContext().host)host.value=getContext().host;void load();}catch(error){if(valid(turn))status.textContent=error.message||'Process sources unavailable.';}
  },invalidate(){if(dialog.open)dialog.close();}};
}
