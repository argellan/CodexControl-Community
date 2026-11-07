// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
const element=(document,tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);if(className)node.className=className;return node;};
const outcome=record=>record.conclusion||record.status||record.state||'unknown';
const tone=value=>['success','merged'].includes(value)?'success':['failure','error','timed_out','action_required'].includes(value)?'danger':['in_progress','pending','queued','waiting'].includes(value)?'pending':'neutral';
export function githubRecordUrl(repository,record){
  if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository||''))return null;
  const root='https://github.com/'+repository;
  if(['pull','pull-list'].includes(record.kind)&&Number.isSafeInteger(record.number))return root+'/pull/'+record.number;
  if(record.kind==='run'&&Number.isSafeInteger(record.id))return root+'/actions/runs/'+record.id;
  if(record.kind==='artifact'&&Number.isSafeInteger(record.runId))return root+'/actions/runs/'+record.runId;
  if(/^[a-f0-9]{40}$/.test(record.headSha||''))return root+'/commit/'+record.headSha;
  return root;
}
export function githubGroups(records=[]){
  const groups={branches:[],pulls:[],checks:[],runs:[],artifacts:[]},pulls=new Map();
  for(const record of records){
    if(record.kind==='branch')groups.branches.push(record);
    else if(['pull','pull-list'].includes(record.kind)){if(record.kind==='pull'||!pulls.has(record.number))pulls.set(record.number,record);}
    else if(['check','status'].includes(record.kind))groups.checks.push(record);
    else if(record.kind==='run')groups.runs.push(record);
    else if(record.kind==='artifact')groups.artifacts.push(record);
  }
  groups.pulls=[...pulls.values()];return groups;
}

const readable=value=>String(value||'Not reported').replaceAll('_',' ').replace(/^./,letter=>letter.toUpperCase());
const shortRevision=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)?value.slice(0,8):value;
const observedTime=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString():'Not reported';
export const githubHistoryStatus=(sources,updated='')=>sources?'Captured history · refreshed '+updated:'No captured history for this project.';

export function githubRecordSummary(record){
  const facts=[],add=(key,value)=>{if(value!==undefined&&value!==null)facts.push([key,String(value)]);};
  let label,state=readable(record.conclusion||record.status||record.state),stateTone=tone(record.conclusion||record.status||record.state);
  if(record.kind==='branch'){
    label=record.name||'Branch';state=record.protected===true?'Protected':record.protected===false?'Unprotected':'Protection not reported';add('Commit',record.headSha);
  }else if(['pull','pull-list'].includes(record.kind)){
    label='Pull request #'+record.number;state=record.merged===true||record.merged_at?'Merged':(record.draft?'Draft · ':'')+readable(record.state);stateTone=state==='Merged'?'success':record.state==='open'?'pending':'neutral';add('Base commit',record.base?.sha);add('Head commit',record.head?.sha);add('Updated',record.updated_at?observedTime(record.updated_at):null);
  }else if(record.kind==='run'){
    label='Workflow run #'+record.runNumber;add('Attempt',record.attempt);add('Commit',record.headSha);add('Started',record.run_started_at?observedTime(record.run_started_at):null);
  }else if(record.kind==='artifact'){
    label='Artifact #'+record.id;state=record.expired===true?'Expired':record.expired===false?'Available':'Availability not reported';stateTone=record.expired?'pending':'neutral';
    add('Size',Number.isSafeInteger(record.sizeBytes)?(record.sizeBytes<1024?record.sizeBytes+' B':(record.sizeBytes/1024).toLocaleString(undefined,{maximumFractionDigits:1})+' KiB'):null);add('Workflow run',record.runId);add('Attempt',record.observedRunAttempt);
  }else{label=(record.kind==='check'?'Check #':'Commit status #')+record.id;add('Commit',record.headSha);add('Completed',record.completed_at?observedTime(record.completed_at):null);}
  return {label,state,tone:stateTone,facts};
}

export function renderGitHubOverview({document,repository,records=[],observedAt,state,coverage={}}){
  const el=(...args)=>element(document,...args),overview=el('section',undefined,'github-overview');overview.setAttribute('aria-label',repository+' repository overview');
  const heading=el('div',undefined,'github-overview-heading'),link=el('a','Open repository ↗');link.href=githubRecordUrl(repository,{});link.target='_blank';link.rel='noopener noreferrer';heading.append(el('h3',repository),link);overview.append(heading);
  const repositoryRecord=records.find(record=>record.kind==='repository'),visibility=repositoryRecord?.private===true?'Private':repositoryRecord?.private===false?'Public':'';
  const stamp=el('p',[visibility,repositoryRecord?.archived?'Archived':'','Fetched '+observedTime(observedAt),state==='partial'?'Partial coverage':''].filter(Boolean).join(' · '),'github-overview-stamp');stamp.title='On-demand repository metadata; counts describe this returned view.';overview.append(stamp);
  if(coverage.unavailable?.length)overview.append(el('p','Unavailable: '+coverage.unavailable.map(readable).join(', '),'github-empty'));
  const groups=githubGroups(records),metrics=el('dl',undefined,'github-overview-counts');
  const sections=[['branches','Branches','No branches returned'],['pulls','Pull requests','No pull requests returned'],['checks','Checks & statuses','No checks or statuses returned'],['runs','Workflow runs','No workflow runs returned'],['artifacts','Artifacts','No artifacts returned']];
  for(const [key,label] of sections){const metric=el('div');metric.append(el('dt',label),el('dd',groups[key].length));metrics.append(metric);}overview.append(metrics);
  for(const [key,label,empty] of sections){
    const section=el('details',undefined,'github-overview-group');section.open=['branches','pulls','checks'].includes(key);section.append(el('summary',label+' · '+groups[key].length));
    if(!groups[key].length)section.append(el('p',empty,'github-empty'));
    for(const record of groups[key]){
      const model=githubRecordSummary(record),row=el('article',undefined,'github-record github-overview-record'),heading=el('div',undefined,'github-record-heading'),badge=el('span',model.state,'github-badge');badge.dataset.tone=model.tone;heading.append(el('h4',model.label),badge);row.append(heading);
      const facts=el('dl',undefined,'github-overview-facts');for(const [label,value] of model.facts){const item=el('div'),detail=el('dd',shortRevision(value));detail.title=value;item.append(el('dt',label),detail);facts.append(item);}if(model.facts.length)row.append(facts);
      const actions=el('div',undefined,'github-record-actions'),url=githubRecordUrl(repository,record);if(url){const link=el('a','Open in GitHub ↗');link.href=url;link.target='_blank';link.rel='noopener noreferrer';actions.append(link);}
      const raw=el('details',undefined,'github-technical');raw.setAttribute('aria-label',model.label+' technical details');raw.append(el('summary','Technical details'));let rendered=false;
      raw.addEventListener('toggle',()=>{if(raw.open&&!rendered){raw.append(el('pre',JSON.stringify(record,null,2)));rendered=true;}});actions.append(raw);row.append(actions);section.append(row);
    }
    overview.append(section);
  }
  if(repositoryRecord){const details=el('details',undefined,'github-technical github-repository-technical');details.append(el('summary','Repository technical details'));let rendered=false;details.addEventListener('toggle',()=>{if(details.open&&!rendered){details.append(el('pre',JSON.stringify({repository:repositoryRecord,coverage},null,2)));rendered=true;}});overview.append(details);}
  return overview;
}

export function mountGitHub({document,window,request,getScope=()=>({}),container=null}){
  const el=(...args)=>element(document,...args),dialog=el(container?'section':'dialog',undefined,container?'github-embedded':'account-dialog github-dialog');dialog.id='github-dialog';dialog.setAttribute('aria-labelledby','github-title');
  const heading=el('div',undefined,'panel-heading'),title=el('h2','GitHub · repository evidence');title.id='github-title';
  const close=el('button','×');close.type='button';close.setAttribute('aria-label','Close GitHub evidence');heading.append(title,close);
  const body=el('div',undefined,'github-body'),toolbar=el('div',undefined,'github-toolbar'),sourceLabel=el('label','Repository '),select=el('select');select.setAttribute('aria-label','GitHub repository');sourceLabel.append(select);
  const refresh=el('button','Refresh view'),autoLabel=el('label',''),auto=el('input');auto.type='checkbox';auto.checked=true;autoLabel.append(auto,' Update while open');
  const history=el('button','Captured history'),notice=el('p','Latest captured repository metadata','note');notice.title='Independent of the map replay clock; checks are reported results, not an approval to merge.';
  for(const button of [refresh,history])button.type='button';toolbar.append(sourceLabel,refresh,history,autoLabel);
  const status=el('p','Loading…','github-status');status.setAttribute('role','status');const content=el('div');body.append(toolbar,notice,status,content);dialog.append(heading,body);(container||document.body).append(dialog);if(container){heading.hidden=true;dialog.hidden=true;}
  let timer=null,busy=false,generation=0,last='',returnFocus=null,sources=[],historyCursor=0,historyEpoch=null,historyMode=false;
  let active=false;const isOpen=()=>container?active:dialog.open;
  const stop=()=>{if(timer!==null)window.clearTimeout(timer);timer=null;};
  const schedule=()=>{stop();if(isOpen()&&!document.hidden&&auto.checked&&!historyMode)timer=window.setTimeout(load,15000);};
  const selected=()=>sources.find(source=>source.sourceId===select.value);
  const formatTime=value=>value?new Date(value).toLocaleString():'Not yet observed';
  function rows(section,records,source){
    if(!records.length){section.append(el('p','No matching records in this captured cycle.','note'));return;}
    for(const record of records.slice(0,40)){
      const details=el('details',undefined,'github-record'),summary=el('summary'),label=record.kind==='branch'?record.name:record.kind==='pull'||record.kind==='pull-list'?'PR #'+record.number:record.kind==='artifact'?'Artifact #'+record.id:record.kind==='run'?'Run #'+record.runNumber+' · attempt '+record.attempt:(record.kind==='check'?'Check #':'Status #')+record.id;
      const value=record.kind==='branch'?(record.protected?'protected branch':'branch'):record.kind==='artifact'?(record.expired?'expired':Math.ceil(record.sizeBytes/1024)+' KiB'):record.merged?'merged':outcome(record);
      const badge=el('span',value,'github-badge');badge.dataset.tone=tone(value);summary.append(el('strong',label),badge);details.append(summary);
      const facts=el('dl',undefined,'github-facts');
      const add=(label,value)=>{facts.append(el('dt',label),el('dd',value??'Not reported'));};
      if(record.base){add('Base SHA',record.base.sha);add('Head SHA',record.head?.sha);add('Head repository ID',record.head?.repositoryId);}
      else if(record.headSha)add('Head SHA',record.headSha);
      if(record.kind==='artifact'){add('GitHub-reported digest',record.digest);add('Run / observed attempt',record.runId+' / '+record.observedRunAttempt);add('Digest verification','Metadata only; artifact bytes are not downloaded');}
      add('Observed',formatTime(record.observedAt));add('Last validated',formatTime(record.verifiedAt));details.append(facts);
      const url=githubRecordUrl(source.repository,record);if(url){const link=el('a','Open in GitHub ↗');link.href=url;link.target='_blank';link.rel='noopener noreferrer';details.append(link);}
      const raw=el('details'),rawSummary=el('summary','Exact captured metadata'),pre=el('pre',JSON.stringify(record,null,2));raw.append(rawSummary,pre);details.append(raw);section.append(details);
    }
    if(records.length>40)section.append(el('p',`Showing 40 of ${records.length} records in this group. Full captured pages remain available in history.`,'note'));
  }
  function render(){
    const source=selected();content.replaceChildren();history.disabled=!source;
    if(!source){const guide=el('a','History collector setup ↗');guide.href='/help/github';guide.target='_blank';guide.rel='noopener noreferrer';content.append(guide);return;}
    const scope=getScope(),scopeNote=el('p',`${source.project} · ${source.hostId} · ${source.repository}`,'github-scope');
    if(scope.project&&scope.project!==source.project||scope.hostId&&scope.hostId!==source.hostId)scopeNote.append(' · This repository differs from the current map filter.');content.append(scopeNote);
    const groups=githubGroups(source.records),metrics=el('div',undefined,'github-metrics');
    for(const [label,value] of [['PRs',groups.pulls.length],[source.coverage?.checks==='disabled'?'Commit statuses':'Checks / statuses',groups.checks.length],['Workflow runs',groups.runs.length],['Artifacts',groups.artifacts.length]]){const metric=el('div');metric.append(el('strong',value),el('span',label));metrics.append(metric);}content.append(metrics);
    const state=el('p',`${source.state.toUpperCase()}${source.reason?' · '+source.reason.replaceAll('_',' '):''} · last complete cycle ${formatTime(source.completedAt)}`,'github-state');state.dataset.tone=source.stale?'pending':tone(source.state);content.append(state);
    const archive=source.archive||{};content.append(el('p',`Archive: ${archive.status||'unknown'} · ${archive.archivedPages??0} pages acknowledged · ${archive.pendingPages??0} pending. Local captured data is preserved.`,'note'));
    if(source.coverage?.checks==='disabled')content.append(el('p','Checks unavailable: this source uses partial monitoring. Repository, branch, PR, commit-status, workflow-run and artifact collection remain enabled. A read-only GitHub App is required for Checks.','github-warning'));
    if(source.displayTruncated||source.reason==='collection_bound')content.append(el('p','Partial coverage: configured collection or display limits were reached. This view is not complete repository history.','github-warning'));
    const outcomes=new Map();for(const record of groups.checks){const key=outcome(record);outcomes.set(key,(outcomes.get(key)||0)+1);}
    if(outcomes.size){const bar=el('div',undefined,'github-outcomes');bar.setAttribute('aria-label','Observed check outcomes');for(const [key,count] of outcomes){const item=el('span',`${key} ${count}`);item.dataset.tone=tone(key);item.style.flexGrow=String(count);bar.append(item);}content.append(bar);}
    for(const [key,label] of [['branches','Tracked branch'],['pulls','Pull requests'],['checks',source.coverage?.checks==='disabled'?'Commit statuses · Checks unavailable':'Checks & commit statuses'],['runs','Workflow runs'],['artifacts','Artifacts']]){const group=el('details',undefined,'github-group');group.open=['branches','pulls','checks'].includes(key);group.append(el('summary',`${label} · ${groups[key].length}`));rows(group,groups[key],source);content.append(group);}
    content.append(el('p','Open PR discovery is bounded; fork-only checks are not searched. Artifact attempts and digests are source metadata, not independently verified provenance. Collection occurs on the hub even when this window is closed.','note'));
  }
  async function load(){
    stop();if(!isOpen()||document.hidden||busy)return;busy=true;refresh.disabled=true;const turn=generation;
    try{const payload=await request('/api/integrations/github?view=summary');if(turn!==generation||!isOpen())return;
      const scope=getScope(),next=(payload.sources||(payload.sourceId?[payload]:[])).filter(source=>(!scope.project||source.project===scope.project)&&(!scope.hostId||source.hostId===scope.hostId)),fingerprint=JSON.stringify([scope,payload]);
      if(last!==fingerprint){const previous=select.value;sources=next;select.replaceChildren();for(const source of sources){const option=el('option',source.repository);option.value=source.sourceId;select.append(option);}if(sources.some(s=>s.sourceId===previous))select.value=previous;render();last=fingerprint;}
      status.textContent=githubHistoryStatus(sources.length,new Date().toLocaleTimeString());
    }catch(error){if(turn===generation){if([401,403].includes(error.status)){sources=[];select.replaceChildren();content.replaceChildren();last='';}status.textContent=[401,403].includes(error.status)?'Sign in with an individual account permitted to view this source.':'GitHub view unavailable. Previously rendered readings may be stale.';}}
    finally{if(turn===generation){busy=false;refresh.disabled=false;schedule();}}
  }
  async function loadHistory(){
    const source=selected();if(!source||busy)return;stop();historyMode=true;busy=true;history.disabled=true;const turn=generation;
    try{const query=new URLSearchParams({view:'history',source:source.sourceId,after:String(historyCursor),limit:'25'});if(historyEpoch)query.set('epoch',historyEpoch);const page=await request('/api/integrations/github?'+query);if(turn!==generation||!isOpen())return;
      historyCursor=page.nextCursor;historyEpoch=page.epoch;content.replaceChildren();content.append(el('p',`Captured source pages · ${page.gap?'journal changed; cursor reset · ':''}${page.observations.length} returned · ${page.caughtUp?'caught up':'more available'}`,'note'));
      for(const obs of page.observations){const details=el('details',undefined,'github-record');details.append(el('summary',`#${obs.sequence} · ${formatTime(obs.observedAt)} · ${obs.httpStatus===304?'unchanged / validated':'captured'} · cycle ${obs.cycle}`),el('pre',JSON.stringify(obs,null,2)));content.append(details);}
      status.textContent='History view · automatic refresh paused; Refresh view returns to latest.';history.textContent=page.caughtUp?'History caught up':'Next captured pages';history.disabled=page.caughtUp;
    }catch(error){if(turn===generation){if([401,403].includes(error.status)){sources=[];select.replaceChildren();content.replaceChildren();last='';}status.textContent='History unavailable; no captured data was changed.';history.disabled=false;}}finally{if(turn===generation)busy=false;}
  }
  refresh.addEventListener('click',()=>{generation++;busy=false;historyMode=false;historyCursor=0;historyEpoch=null;history.textContent='Captured history';last='';void load();});
  history.addEventListener('click',loadHistory);select.addEventListener('change',()=>{generation++;busy=false;refresh.disabled=false;historyMode=false;historyCursor=0;historyEpoch=null;history.textContent='Captured history';render();schedule();});
  auto.addEventListener('change',schedule);document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else schedule();});
  close.addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>{stop();generation++;busy=false;last='';sources=[];content.replaceChildren();select.replaceChildren();if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});});
  const reset=()=>{stop();generation++;busy=false;last='';sources=[];content.replaceChildren();select.replaceChildren();};
  return {setActive(value){if(!container)return;reset();active=!!value;dialog.hidden=!active;historyMode=false;historyCursor=0;historyEpoch=null;history.textContent='Captured history';if(active)void load();},open(){for(const other of document.querySelectorAll('dialog[open]'))other.close();generation++;returnFocus=document.activeElement;historyMode=false;historyCursor=0;historyEpoch=null;history.textContent='Captured history';dialog.showModal();close.focus();void load();},invalidate(){if(container){active=false;dialog.hidden=true;reset();}else if(isOpen())dialog.close();},dialog};
}
