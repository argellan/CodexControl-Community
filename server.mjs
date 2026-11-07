import {createLocalDesktopObservation} from './lib/local-desktop-observation.mjs';
// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {mergeDeviceHosts} from './public/device-enrollment.mjs';
import {createProjectReader} from './lib/project-reader.mjs';
import {atomicJSON} from './lib/installation-storage.mjs';
import http from 'node:http';
import {Installation} from './lib/installation.mjs';
import {createInstallationHandler} from './lib/installation-api.mjs';
import {presentInstallationNames} from './public/installation-names.mjs';
import https from 'node:https';
import {validateDisplayPreferences} from './lib/display-preferences.mjs';
import {PersonalPreferences} from './lib/personal-preferences.mjs';
import {UserProfile} from './lib/user-profile.mjs';
import {saveCompanion,readCompanionArtwork,COMPANION_MAX_WIRE} from './lib/desktop-companion.mjs';
import {createSettingsHandler} from './lib/settings-api.mjs';
import {ConfigurationStore} from './lib/configuration.mjs';
import {Administration} from './lib/administration.mjs';
import {seedDeployment,runtimeWithDeployment,validateRuntimeConfiguration} from './lib/runtime-configuration.mjs';
import {runtimeDiagnostics} from './lib/runtime-diagnostics.mjs';
import {LocalDiagnostics} from './lib/diagnostics-privacy.mjs';
import {ApplicationDiagnostics} from './lib/application-diagnostics.mjs';
import {ViewerAccess,filterSnapshot,projectEvent} from './lib/viewer-access.mjs';
import {PasswordRateLimiter} from './lib/password-auth.mjs';
import {createRequestOriginPolicy,validateProxyOrigins} from './lib/request-origin.mjs';
import {deliverRepresentation} from './lib/http-representation.mjs';
import {remoteJSON} from './lib/upstream-json.mjs';
import {FleetHub} from './lib/fleet.mjs';
import {readPrivateKeyFile} from './lib/private-key-file.mjs';
import {createGitHubConnections} from './lib/github-connections.mjs';
import {openGitHubRuntime} from './lib/github-runtime.mjs';
import {createHistoricalAnalytics,historicalQueryFromParams,validateHistoricalQuery} from './lib/historical-analytics.mjs';
import {selectWeeklyAllowance} from './lib/allowance-history.mjs';
import {buildAccountUsageResponse} from './lib/account-usage.mjs';
import {readSpendingUsagePage} from './lib/spending-advisory.mjs';
import {serviceHealth,readJobFeed} from './lib/targets.mjs';
import { promises as fs, watch } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SessionReader,UsageSourceReader } from './lib/observer.mjs';
export { SessionReader, summarizeRecords } from './lib/observer.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CODEX_CONTROL_PORT || 4317);
const SESSION_ROOT = process.env.CODEX_CONTROL_SESSION_ROOT || path.join(os.homedir(), '.codex', 'sessions');
let observationRoots=[SESSION_ROOT],observationInterval=1000,rootIntervals=new Map([[SESSION_ROOT,1000]]);
const fileReadCache=new Map();
let HOST_ID = process.env.CODEX_CONTROL_HOST_ID || os.hostname().toLowerCase().replace(/[^a-z0-9-]/g,'-');
const MAX_FILES = 128;
const staticFiles = new Map([['/', ['public/index.html','text/html']], ['/app.css',['public/app.css','text/css']], ['/app.js',['public/app.js','text/javascript']], ['/login.js',['public/login.js','text/javascript']], ['/event-model.mjs',['public/event-model.mjs','text/javascript']]]);
staticFiles.set('/device-enrollment.mjs',['public/device-enrollment.mjs','text/javascript']);
staticFiles.set('/ui-model.mjs',['public/ui-model.mjs','text/javascript']);
for(const file of ['diagnostics-workspace.mjs','diagnostics-schema.mjs','lazy-workspace.mjs','investigation-workspace.mjs','view-zoom.mjs','event-ribbon.mjs','dialog-interactions.mjs','mobile-workspace.mjs','profile-editor.mjs','companion-panel.mjs','account-history-view.mjs','native-analytics-view.mjs'])staticFiles.set('/'+file,['public/'+file,'text/javascript']);
staticFiles.set('/projects-workspace.mjs',['public/projects-workspace.mjs','text/javascript']);
staticFiles.set('/github-return.mjs',['public/github-return.mjs','text/javascript']);
staticFiles.set('/projects-workspace.css',['public/projects-workspace.css','text/css']);
staticFiles.set('/github-workspace.mjs',['public/github-workspace.mjs','text/javascript']);
staticFiles.set('/github-workspace.css',['public/github-workspace.css','text/css']);
staticFiles.set('/help/github-app',['docs/design/GITHUB_APP_CONNECTION.md','text/plain']);
staticFiles.set('/help/github',['docs/design/GITHUB_INTEGRATION.md','text/plain']);
staticFiles.set('/workspace-polish.css',['public/workspace-polish.css','text/css']);
staticFiles.set('/mobile-workspace.css',['public/mobile-workspace.css','text/css']);
staticFiles.set('/topology-view.css',['public/topology-view.css','text/css']);
for(const file of ['activity-map-model.mjs','activity-map.mjs','topology-view.mjs','worker-activity.mjs','topology-map.mjs','topology-motion.mjs','map-symbols.mjs','voice-concept.mjs','worker-model.mjs','worker-view.mjs','timeline-nav.mjs','recovery-model.mjs','retry-policy.mjs','settings-workspace.mjs','settings-view-model.mjs','settings-schema.mjs','presentation-runtime.mjs','render-scheduler.mjs','span-cache.mjs','timeline-visibility.mjs','native-timeline-motion.mjs','operational-alerts.mjs','quota-alarms.mjs','source-connection.mjs','allowance-history.mjs'])staticFiles.set('/'+file,['public/'+file,'text/javascript']);
for(const file of ['installation-workspace.mjs','installation-names.mjs','installation-identity.mjs'])staticFiles.set('/'+file,['public/'+file,'text/javascript']);
staticFiles.set('/installation-workspace.css',['public/installation-workspace.css','text/css']);
staticFiles.set('/settings-workspace.css',['public/settings-workspace.css','text/css']);
staticFiles.set('/build-info.mjs',['public/build-info.mjs','text/javascript']);
staticFiles.set('/first-sign-in.css',['public/first-sign-in.css','text/css']);
staticFiles.set('/first-sign-in.js',['public/first-sign-in.js','text/javascript']);
staticFiles.set('/account-usage.mjs',['public/account-usage.mjs','text/javascript']);
staticFiles.set('/token-motion.mjs',['public/token-motion.mjs','text/javascript']);
staticFiles.set('/token-palette.mjs',['public/token-palette.mjs','text/javascript']);
staticFiles.set('/usage-analytics-view.mjs',['public/usage-analytics-view.mjs','text/javascript']);
staticFiles.set('/usage-export.mjs',['public/usage-export.mjs','text/javascript']);
staticFiles.set('/help/user-manual.pdf',['public/assets/codexcontrol-user-manual.pdf','application/pdf']);
staticFiles.set('/help/interface-atlas.pdf',['public/assets/codexcontrol-interface-atlas.pdf','application/pdf']);
staticFiles.set('/synthetic-demo.mjs',['public/synthetic-demo.mjs','text/javascript']);
staticFiles.set('/usage-export-workspace.mjs',['public/usage-export-workspace.mjs','text/javascript']);
for(const file of ['handoff-export.mjs','handoff-workspace.mjs'])staticFiles.set('/'+file,['public/'+file,'text/javascript']);
staticFiles.set('/downloads/install-collector.ps1',['scripts/install-collector.ps1','text/plain']);
staticFiles.set('/activity-map.css',['public/activity-map.css','text/css']);
staticFiles.set('/worker-view.css',['public/worker-view.css','text/css']);
for(const name of ['argellan-symbol.svg','argellan-wordmark.svg'])staticFiles.set('/assets/'+name,['public/assets/'+name,'image/svg+xml']);
for(const name of ['JetBrainsMono-Regular.woff2','JetBrainsMono-SemiBold.woff2'])staticFiles.set('/assets/fonts/'+name,['public/assets/fonts/'+name,'font/woff2']);
staticFiles.set('/assets/fonts/OFL.txt',['public/assets/fonts/OFL.txt','text/plain']);
const documents = new Map([['spec','docs/design/CODEX_CONTROL_DESIGN_SPECIFICATION_R1.md'],['plan','docs/plans/CODEX_CONTROL_IMPLEMENTATION_PLAN_R1.md'],['checkpoint','docs/CHECKPOINT.md']]);
let cached, cacheAt = 0, previousCpu, pendingSnapshot;
let localJobsObserved=false;const localJobBootstrapIds=new Set();
const reader = new SessionReader();
const usageReader = new UsageSourceReader();
const cpuSample = () => {
  const totals = os.cpus().reduce((a,c)=>{a.idle+=c.times.idle;a.total+=Object.values(c.times).reduce((s,v)=>s+v,0);return a;},{idle:0,total:0});
  const result = previousCpu ? Math.max(0,Math.min(100,100*(1-(totals.idle-previousCpu.idle)/(totals.total-previousCpu.total || 1)))) : null;
  previousCpu=totals; return result;
};
let discoveryCache,discoveryAt=0;
let inventoryWatchers=[];
export function watchSessionInventory(){if(inventoryWatchers.length)return;for(const root of observationRoots)try{const watcher=watch(root,{recursive:true,persistent:false},event=>{if(event==='rename')discoveryAt=0;});watcher.on('error',()=>{});watcher.unref();inventoryWatchers.push(watcher);}catch{}}
export function configureObservation(sources){
 if(!Array.isArray(sources)||sources.length>256)throw new Error('Invalid observation sources');
 const logs=sources.filter(s=>s.enabled&&s.kind==='codex-log'),jobs=sources.filter(s=>s.enabled&&s.kind==='job-feed');
 if(logs.length>4||jobs.length>1||[...logs,...jobs].some(s=>!path.isAbsolute(s.path)||!Number.isInteger(s.intervalMs)||s.intervalMs<250||s.intervalMs>300000))throw new Error('Unsupported observation source configuration');
 observationRoots=[...new Set(logs.map(s=>path.resolve(s.path)))];rootIntervals=new Map(logs.map(s=>[path.resolve(s.path),s.intervalMs]));observationInterval=Math.min(300000,...[...logs,...jobs].map(s=>s.intervalMs),...(logs.length||jobs.length?[]:[1000]));
 if(jobs.length)process.env.CODEX_CONTROL_JOB_FILE=path.resolve(jobs[0].path);else delete process.env.CODEX_CONTROL_JOB_FILE;
 for(const watcher of inventoryWatchers)watcher.close();inventoryWatchers=[];discoveryAt=0;discoveryCache=null;cacheAt=0;cached=null;fileReadCache.clear();watchSessionInventory();
 return {roots:observationRoots.length,jobFeed:jobs.length>0,intervalMs:observationInterval};
}
export async function discoverSessions(root,limit=MAX_FILES){
 let entries;try{entries=await fs.readdir(root,{recursive:true,withFileTypes:true});}catch{return {files:[],discovered:0};}
 const candidates=entries.filter(e=>e.isFile()&&e.name.endsWith('.jsonl')).slice(0,20000),files=[];
 for(let offset=0;offset<candidates.length;offset+=64)await Promise.all(candidates.slice(offset,offset+64).map(async entry=>{const file=path.join(entry.parentPath||entry.path||root,entry.name);try{files.push({file,stat:await fs.stat(file)});}catch{}}));
 files.sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs);return {files:files.slice(0,limit),discovered:files.length,inventoryLimited:candidates.length===20000};
}
async function discover(){if(discoveryCache&&Date.now()-discoveryAt<10000)return discoveryCache;const scans=await Promise.all(observationRoots.map(root=>discoverSessions(root,20000))),files=[...new Map(scans.flatMap(s=>s.files).map(f=>[f.file,f])).values()].sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs);discoveryCache={files:files.slice(0,MAX_FILES),allFiles:files,discovered:scans.reduce((n,s)=>n+s.discovered,0),inventoryLimited:scans.some(s=>s.inventoryLimited)};discoveryAt=Date.now();return discoveryCache;}
export async function readUsageSamples(cursor){const inventory=await discover();const result=await usageReader.read(inventory.allFiles,cursor);if(inventory.inventoryLimited){result.coverage.inventoryLimited=true;result.coverage.backlogged=true;}return result;}
async function readScheduled(file){const root=observationRoots.find(r=>{const rel=path.relative(r,file);return rel&&!rel.startsWith('..')&&!path.isAbsolute(rel);}),interval=rootIntervals.get(root)||observationInterval,previous=fileReadCache.get(file);if(previous&&Date.now()-previous.at<interval)return previous.value;const value=await reader.read(file);fileReadCache.set(file,{at:Date.now(),value});return value;}
export async function snapshot() {
  if(cached&&Date.now()-cacheAt<Math.max(250,observationInterval))return cached;
  if(pendingSnapshot)return pendingSnapshot;
  pendingSnapshot=collectSnapshot();try{return await pendingSnapshot;}finally{pendingSnapshot=null;}
}
async function collectSnapshot(){
  const {files,discovered}=await discover(),keep=new Set(files.map(f=>f.file));reader.retain(keep);for(const f of fileReadCache.keys())if(!keep.has(f))fileReadCache.delete(f);const settled=await Promise.allSettled(files.map(({file})=>readScheduled(file)));
  const sessions=settled.filter(x=>x.status==='fulfilled'&&x.value).map(x=>({...x.value,hostId:HOST_ID,hostName:os.hostname(),events:x.value.events.map(e=>({...e,id:HOST_ID+':'+e.id,sourceId:HOST_ID+':'+e.sourceId,hostId:HOST_ID,hostName:os.hostname()}))}));
  if(process.env.CODEX_CONTROL_JOB_FILE){try{const jobs=await readJobFeed(process.env.CODEX_CONTROL_JOB_FILE,HOST_ID);if(!localJobsObserved){for(const e of jobs.events)localJobBootstrapIds.add(e.id);localJobsObserved=true;}for(const s of jobs.sessions)sessions.push({...s,hostName:os.hostname(),events:jobs.events.filter(e=>e.sessionId===s.id).map(e=>({...e,hostName:os.hostname(),delivery:localJobBootstrapIds.has(e.id)?'bootstrap':Date.now()-Date.parse(e.at)<10000?'live':'backfill'}))});}catch{}}
  let disk=null;try{const s=await fs.statfs(ROOT);disk={free:s.bavail*s.bsize,total:s.blocks*s.bsize};}catch{}
  cached={observedAt:new Date().toISOString(),mode:'read-only-log-observer',coverage:{days:null,allDatedFolders:true,discoveryMs:10000,limit:MAX_FILES,discovered,loaded:sessions.length,failed:settled.filter(x=>x.status==='rejected'||!x.value).length,tailBytes:262144,incremental:true,eventLimitPerSession:600,pollMs:1000,completeHistory:false,liveRuntimeAttached:false},host:{services:await serviceHealth(JSON.parse(process.env.CODEX_CONTROL_SERVICES||'[]')),deviceClass:process.env.CODEX_CONTROL_DEVICE_CLASS||'unknown',id:HOST_ID,name:os.hostname(),platform:os.platform(),node:process.version,cpu:cpuSample(),cores:os.cpus().length,totalMemory:os.totalmem(),freeMemory:os.freemem(),uptime:os.uptime(),disk},sessions,events:sessions.flatMap(s=>s.events).sort((a,b)=>String(b.at).localeCompare(String(a.at))).slice(0,12000)};
  cacheAt=Date.now();return cached;
}
async function readJSON(req,limit,{fingerprint=false}={}){
 const deadline=setTimeout(()=>req.destroy(Object.assign(new Error('Request body deadline exceeded'),{status:408})),10000);deadline.unref();try{
 if(req.headers['content-length']!==undefined&&(!/^\d+$/.test(req.headers['content-length'])||Number(req.headers['content-length'])>limit))throw Object.assign(new Error('Batch exceeds limit'),{status:413});
 if(req.headers['content-type']!=='application/json')throw Object.assign(new Error('JSON required'),{status:415});
 let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>limit)throw Object.assign(new Error('Batch exceeds limit'),{status:413});chunks.push(chunk);}try{const raw=Buffer.concat(chunks),body=JSON.parse(raw.toString('utf8'));return fingerprint?{body,wireSha256:crypto.createHash('sha256').update(raw).digest('hex')}:body;}catch{throw Object.assign(new Error('Valid JSON required'),{status:400});}
 }finally{clearTimeout(deadline);}
}
export function upstreamLoginUrl(upstream){
 try{const url=new URL(upstream?.url);if(url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))return null;url.pathname='/';return url.href;}catch{return null;}
}
export function remoteSnapshot(configuration){return remoteJSON(configuration,'/api/snapshot');}
async function captureForRead(hub,local,read){return hub?hub.captureRead(local,read):read(local);}
export function localPreviewSnapshot(local,configuration={}){return {...local,mode:'read-only-local-preview',hosts:[{id:local.host.id,name:configuration.name||local.host.name,role:'codex-source',status:'online',receivedAt:local.observedAt,sourceObservedAt:local.observedAt,telemetry:local.host}],coverage:{...local.coverage,fleetHubUnavailable:true,unavailableHub:configuration.unavailableHub||'unavailable'}};}
export function createServer({installation,hub,publicOrigin,proxyOrigins,tls,viewTokenHash,viewers=[],upstream,localPreview,preferencesDirectory,readSnapshot=snapshot,configuration,administration,securityState,deploymentState,instanceId='unconfigured',instanceName='Codex Control',validateRuntime,githubIntegration,githubConnections,historicalAnalytics,historicalAnalyticsDependencies,localDiagnostics,syntheticDiagnostics,spendingAdvisory,localObservation}={}){
 const requestOrigin=createRequestOriginPolicy({publicOrigin,proxyOrigins,tls,crossSiteNavigationPaths:githubConnections?['/api/integrations/github/callback']:[]});
 if(upstream&&(viewers.length||securityState?.viewers?.length))throw new Error('Individual viewers must authenticate at the authoritative hub');
 const viewerHashes=new Set([securityState?.viewTokenHash||viewTokenHash,...(securityState?.viewers||viewers).map(v=>v.tokenHash)].filter(v=>typeof v==='string').map(v=>v.toLowerCase()));
 if(hub?.hosts?.some(h=>viewerHashes.has(h.tokenHash.toLowerCase())))throw new Error('Viewer and collector credentials must remain separate');
 const sessionSecret=crypto.randomBytes(32),sessions=new Map(),loginAttempts=new PasswordRateLimiter(),collectorSources=new Set();let collectorReaders=0;let security=securityState||{viewTokenHash,viewers},access=new ViewerAccess({...security,secret:sessionSecret,sessions}),activeDeployment=deploymentState;
 const clearSession=(req,res)=>{const name='cc_local_'+String(req.headers.host).split(':').at(-1),secure=!!tls||publicOrigin?.startsWith('https://');res.setHeader('Set-Cookie',`${name}=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/${secure?'; Secure':''}`);};
 const profiles=new Map();let profileReaders=0,companionReader=false;
 const historical=createHistoricalAnalytics(historicalAnalytics,{...historicalAnalyticsDependencies,upstream});
 const companionHost=(id,current)=>id===localObservation?.hostId&&current.role==='admin'&&current.projectIds===null&&(current.hostIds===null||current.hostIds?.includes(id))?{id,label:os.hostname(),role:'codex-source'}:hub?.hosts.find(h=>h.id===id&&!h.disabled&&(!h.expiresAt||Date.parse(h.expiresAt)>Date.now())&&['codex-source','hub',undefined].includes(h.role)&&(current.hostIds===null||current.hostIds?.includes(id))&&current.projectIds===null);
 const desktopMetadata=id=>id===localObservation?.hostId?localObservation.metadata():hub?.states.get(id)?.desktopCompanion;
 const companionMetadata=current=>{if(current.role!=='admin'||!hub)return [];const hosts=[...hub.hosts];if(localObservation?.metadata()&&!hosts.some(h=>h.id===localObservation.hostId))hosts.unshift({id:localObservation.hostId,label:os.hostname()});return hosts.filter(h=>companionHost(h.id,current)).flatMap(h=>{const metadata=desktopMetadata(h.id);return metadata?[{hostId:h.id,hostName:h.label||h.id,...metadata}]:[];});};
 const displayStoreFor=viewer=>{if(!preferencesDirectory)return null;const id=['local','legacy'].includes(viewer.id)?security.viewTokenHash||'local-viewer':viewer.profileKey;if(!profiles.has(id))profiles.set(id,new PersonalPreferences(preferencesDirectory,id));return profiles.get(id);};
 const display=value=>installation?presentInstallationNames(value,installation.state()):value;
 const installationHandler=createInstallationHandler({installation,administration,readJSON});
 const publicApplication=()=>activeDeployment?{...activeDeployment.configuration.general,...(installation?{instanceName:installation.state().name,installationRole:installation.state().role}:{}),alerts:activeDeployment.configuration.alerts}:null;
 if(upstream&&syntheticDiagnostics)throw new Error('Synthetic application sharing is configured only on the authoritative local hub');
 const applicationDiagnostics=new ApplicationDiagnostics({configuration:syntheticDiagnostics,currentOwner:id=>{const owner=(security.viewers||[]).find(v=>v.id===id);return !!owner&&!owner.disabled&&(!owner.expiresAt||Date.parse(owner.expiresAt)>Date.now());}});
 const stopDiagnosticObserver=localDiagnostics?.observe(event=>applicationDiagnostics.captureBackend(event));
 const settingsHandler=createSettingsHandler({installation,applicationDiagnostics,localDiagnostics,hub,upstream,remoteJSON,readJSON,profileFor:displayStoreFor,configuration,administration,publicOrigin,certificate:tls?.cert,instanceId,validateRuntime,clearSession,onSecurityChanged:state=>{applicationDiagnostics.revokeAll();security=state;access=new ViewerAccess({...state,secret:sessionSecret,sessions});if(hub){const hosts=mergeDeviceHosts([...state.hosts,...hub.hosts.filter(h=>h.installationManaged&&!state.hosts.some(s=>s.id===h.id))],activeDeployment?.configuration.fleet.hosts);if(typeof hub.setHosts==='function')hub.setHosts(hosts);else hub.hosts=hosts;}},onConfigurationChanged:state=>{if(activeDeployment)activeDeployment={...activeDeployment,configuration:{...activeDeployment.configuration,general:{...state.configuration.general,installationRole:activeDeployment.configuration.general.installationRole},alerts:state.configuration.alerts}};if(hub)hub.healthThresholds=state.configuration.alerts.thresholds;},getSnapshot:async()=>{const local=await readSnapshot();return hub?hub.readProjection(local,owned=>hub.snapshot(owned,Date.now(),{includeEvents:false})):local;}});
 let projectReader;const readProjects=options=>{if(!hub?.journal?.file)return Promise.resolve(hub?.journal?.projectActivity(options));projectReader??=createProjectReader(hub.journal.file);return projectReader.read(options);};
 const supplementProjects=(result,project,current)=>{
  const sources=githubIntegration?.snapshot?.({viewer:current,hosts:hub?.hosts})?.sources||[],names=[...new Set(sources.map(source=>source.project).filter(name=>typeof name==='string'&&(!project||name===project)))];
  for(const name of names)if(!result.projects.some(p=>p.name===name))result.projects.push({name,firstCapturedAt:null,lastCapturedAt:null});
  if(project&&!result.selected&&names.includes(project))result.selected={name:project,firstCapturedAt:null,lastCapturedAt:null,calendarMs:null,codeMs:null,activeWallMs:null,completeTurns:0,incompleteTurns:0,tokens:{total:null,input:null,cached:null,output:null},quota:{value:null,unit:null,status:'not_project_attributed'},daily:[],activity:[],coverage:{basis:'configured-repository',partialTokenObservations:0,completeProjectLifetime:false}};
  return result;
 };
 const projectHosts=async current=>{
  const local=await readSnapshot(),now=Date.now(),enabled=hub?.hosts.filter(h=>!h.disabled&&(!h.expiresAt||Date.parse(h.expiresAt)>now)&&h.role!=='execution-target').map(h=>h.id)||[];
  if(local.host?.id&&!hub?.hosts.some(h=>h.id===local.host.id))enabled.push(local.host.id);
  return [...new Set(enabled)].filter(id=>current.hostIds===null||current.hostIds.includes(id));
 };
 const handler=async(req,res)=>{
  try{
   const host=req.headers.host,scheme=tls?'https':'http';
   res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');
   res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'");
   if(!requestOrigin.accepts(req)){res.writeHead(403);res.end('Same-origin access required');return;}
   if(req.method==='GET'&&req.url.split('?')[0]==='/api/integrations/github/callback'&&githubConnections){
    const result=await githubConnections.callback({query:new URL(req.url,'http://localhost').searchParams});
    if(!result.completionPath)throw Object.assign(new Error('GitHub authorization unavailable'),{status:503});
    // Commit a same-origin document before navigation so the Strict session
    // cookie is available again. A cross-site 303 chain cannot supply it.
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Returning to Projects</title><script type="module" src="/github-return.mjs"></script></head><body><p>Returning to Projectsâ€¦</p><a href="/?github=complete">Continue to Projects</a></body></html>');return;
   }
   const cookieName='cc_local_' +String(host).split(':').at(-1),secureCookie=!!tls||publicOrigin?.startsWith('https://'),cookie=viewer=>`${cookieName}=${access.issueCookie(viewer)}; HttpOnly; SameSite=Strict; Path=/${secureCookie?'; Secure':''}`;
   const bearer=String(req.headers.authorization||'').replace(/^Bearer /,'');
   const cookieValue=String(req.headers.cookie||'').split(';').find(c=>c.trim().startsWith(cookieName+'='))?.trim().slice(cookieName.length+1),viewer=access.authenticateBearer(bearer)||access.authenticateCookie(cookieValue),authorized=!!viewer;
   const url=new URL(req.url,`${scheme}://${host}`),staticEntry=staticFiles.get(url.pathname),representationRequest=authorized&&['GET','HEAD'].includes(req.method)&&(['/api/account/spending-status','/api/projects','/api/snapshot','/api/account/usage','/api/account/allowance-history','/api/events','/api/history','/api/integrations/github'].includes(url.pathname)||staticEntry?.[1].startsWith('text/')&&staticEntry[0]!=='public/login.js'&&!(url.pathname==='/'&&!access.requiredLogin));
   if(url.pathname==='/api/auth/first-sign-in'&&req.method==='GET'){
    if(!authorized)throw Object.assign(new Error('Sign in required'),{status:401});
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({required:viewer.passwordChangeRequired===true,username:viewer.username}));return;
   }
   if(authorized&&viewer.passwordChangeRequired){
    if(['/','/set-password'].includes(url.pathname)&&['GET','HEAD'].includes(req.method)){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(req.method==='HEAD'?'':await fs.readFile(path.join(ROOT,'public/first-sign-in.html')));return;}
    const permitted=['/api/session','/api/session/logout','/api/settings/password','/api/auth/capabilities','/api/identity','/first-sign-in.js','/first-sign-in.css','/app.css','/settings-workspace.css'].includes(url.pathname)||staticEntry&&url.pathname.startsWith('/assets/');
    if(!permitted)throw Object.assign(new Error('Set your personal password before continuing'),{status:403});
   }
   if(url.pathname==='/set-password'){res.writeHead(303,{Location:'/'});res.end();return;}
   const viewerScope=value=>JSON.stringify([value?.id,value?.role,value?.hostIds,value?.projectIds]),sourceScope=()=>JSON.stringify(hub?.hosts?.map(h=>[h.id,!!h.disabled,h.role,h.expiresAt,!!h.expiresAt&&Date.parse(h.expiresAt)<=Date.now()])),initialViewerScope=viewerScope(viewer),initialSourceScope=representationRequest?sourceScope():null;
   const verifyAuthority=()=>{const current=access.authenticateBearer(bearer)||access.authenticateCookie(cookieValue);if(!current)throw Object.assign(new Error('Viewer authentication required'),{status:401});if(viewerScope(current)!==initialViewerScope)throw Object.assign(new Error('Viewer permissions changed; refresh the dashboard'),{status:403});return current;};
   const diagnosticClientKey=()=>crypto.createHmac('sha256',sessionSecret).update(JSON.stringify(['diagnostic-client-v1',viewer.id,access.authenticateCookie(cookieValue)?.id===viewer.id?cookieValue.split('.')[3]:'bearer'])).digest('hex');
   const verifyDelivery=()=>{verifyAuthority();if(sourceScope()!==initialSourceScope)throw Object.assign(new Error('Viewer permissions changed; refresh the dashboard'),{status:403});};
   if(url.pathname.startsWith('/api/integrations/github/')&&url.pathname!=='/api/integrations/github/callback'){
    if(!authorized||!access.requiredLogin||['local','legacy'].includes(viewer.id))throw Object.assign(new Error('Individual viewer required'),{status:401});
    if(upstream)throw Object.assign(new Error('Connect GitHub on the authoritative hub'),{status:409});
    const action=url.pathname.slice('/api/integrations/github/'.length),methods={connect:'POST',complete:'POST',repositories:'GET',selection:'POST',disconnect:'POST',repository:'GET'};
    if(!methods[action])throw Object.assign(new Error('Not found'),{status:404});
    if(req.method!==methods[action]){res.writeHead(405,{Allow:methods[action]});res.end();return;}
    for(const key of url.searchParams.keys())if(!['project',...(action==='repository'?['installationId','repositoryId']:[])].includes(key)||url.searchParams.getAll(key).length!==1)throw Object.assign(new Error('Invalid GitHub query'),{status:400});
    const project=url.searchParams.get('project');if(!project||project.length>160)throw Object.assign(new Error('Project required'),{status:400});
    const githubSourceScope=sourceScope();
    const verifyGitHubAuthority=()=>{const current=verifyAuthority();if(sourceScope()!==githubSourceScope)throw Object.assign(new Error('Project access changed'),{status:403});return current;};
    const current=verifyGitHubAuthority();if(current.projectIds!==null&&!current.projectIds.includes(project))throw Object.assign(new Error('Project not permitted'),{status:403});
    const hostIds=await projectHosts(current);verifyGitHubAuthority();
    if(!supplementProjects(await readProjects({hostIds,projectIds:current.projectIds,project,catalogOnly:true})||{projects:[],selected:null},project,current).projects.some(p=>p.name===project))throw Object.assign(new Error('Project not permitted'),{status:403});
    const body=req.method==='POST'?await readJSON(req):{};
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>action!=='selection'||key!=='repositories'))throw Object.assign(new Error('Invalid GitHub request'),{status:400});
    const options={viewer:current,clientKey:diagnosticClientKey(),verifyAuthority:verifyGitHubAuthority,project};
    const method={connect:'startAuthorization',complete:'completeAuthorization',repositories:'listRepositories',selection:'selectRepositories',disconnect:'disconnect',repository:'readRepository'}[action];
    const result=githubConnections?await githubConnections[method]({...options,...body,...(action==='repository'?{installationId:Number(url.searchParams.get('installationId')),repositoryId:Number(url.searchParams.get('repositoryId'))}:{})}):{schemaVersion:1,configured:false,readOnly:true,state:'unconfigured',reason:'app_registration_required',repositories:[],selection:[]};
    verifyGitHubAuthority();res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
   }
   if(url.pathname==='/api/analytics/history'){
    if(!authorized||!access.requiredLogin)throw Object.assign(new Error('Viewer authentication required'),{status:401});
    if(localPreview||viewer.hostIds!==null||viewer.projectIds!==null||!upstream&&viewer.role!=='admin')throw Object.assign(new Error('Unrestricted administrator access required'),{status:403});
    if(req.method!=='GET'){res.writeHead(405,{'Allow':'GET'});res.end('Read only');return;}
    if(!upstream&&!hub)throw Object.assign(new Error('Historical analytics unavailable'),{status:503});
    const requested=historicalQueryFromParams(url.searchParams),initialAnalyticsSources=sourceScope();
    const verifyHistorical=()=>{const current=verifyAuthority();if(!access.requiredLogin||localPreview||current.hostIds!==null||current.projectIds!==null||!upstream&&current.role!=='admin'||sourceScope()!==initialAnalyticsSources)throw Object.assign(new Error('Viewer permissions changed; refresh the dashboard'),{status:403});};
    const allowedHostIds=upstream?undefined:hub.hosts.filter(h=>!h.disabled&&(!h.expiresAt||Date.parse(h.expiresAt)>Date.now())&&[undefined,'codex-source','hub'].includes(h.role)).map(h=>h.id);
    if(allowedHostIds!==undefined&&localObservation?.hostId&&!hub.hosts.some(host=>host.id===localObservation.hostId))allowedHostIds.push(localObservation.hostId);
    if(allowedHostIds!==undefined&&requested.hostId!==undefined&&!allowedHostIds.includes(requested.hostId))throw Object.assign(new Error('Host not permitted'),{status:403});
    const request=validateHistoricalQuery(requested,{allowedHostIds});
    const controller=new AbortController(),disconnect=()=>{if(!res.writableEnded)controller.abort();};res.once('close',disconnect);
    try{const result=await historical.query(request,{validate:verifyHistorical,signal:controller.signal});const encoded=JSON.stringify(result);verifyHistorical();res.setHeader('Content-Type','application/json');res.end(encoded);}
    catch(error){if(res.destroyed||res.writableEnded)return;if(error.status&&error.status<500)throw error;void localDiagnostics?.capture({kind:'backend',category:'request-failed',site:'backend:analytics'}).catch(()=>{});res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'unavailable',error:'Historical analytics unavailable',code:'ANALYTICS_UNAVAILABLE'}));}
    finally{res.removeListener('close',disconnect);}
    return;
   }
   if(url.pathname==='/api/identity'&&req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({deploymentId:instanceId,instanceName:publicApplication()?.instanceName||instanceName,protocolVersion:1,readOnly:true}));return;}
   if(url.pathname==='/api/auth/capabilities'&&req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({accessKey:access.requiredLogin,passwordLogin:!upstream&&!!administration&&access.requiredLogin,passwordChange:!upstream&&!!administration,...(upstream?{passwordUnavailableReason:'Your account is on the secure fleet hub. Open its sign-in page to use your username and password.',passwordLoginUrl:upstreamLoginUrl(upstream)}:{})}));return;}
   if(url.pathname==='/api/session/logout'&&req.method==='POST'){if(!authorized){res.writeHead(401);res.end('Authentication required');return;}applicationDiagnostics.revoke(viewer.id,diagnosticClientKey());access.revokeCookie(cookieValue);res.setHeader('Set-Cookie',`${cookieName}=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/${secureCookie?'; Secure':''}`);res.setHeader('Content-Type','application/json');res.end('{"signedOut":true}');return;}
   if(installation&&installation.state().role!=='hub'&&url.pathname.startsWith('/api/collector'))throw Object.assign(new Error('Node receipt requires Hub mode'),{status:409});
   if(url.pathname==='/api/collector/config'&&req.method==='GET'&&hub){const source=hub.authenticateCollector(bearer);if(!source){res.writeHead(401);res.end('Collector authentication required');return;}const sources=activeDeployment?.configuration.sources.filter(s=>s.hostId===source.id)||[];res.setHeader('Content-Type','application/json');res.end(JSON.stringify({revision:activeDeployment?.revision??0,managed:activeDeployment?.configuration.fleet.hosts.find(h=>h.id===source.id)?.managedSources===true||sources.length>0,sources}));return;}
   if(url.pathname.startsWith('/api/installation')){if(!authorized)throw Object.assign(new Error('Viewer authentication required'),{status:401});if(await installationHandler(req,res,url,viewer,{verifyAuthority,clientKey:diagnosticClientKey()}))return;}
   if(url.pathname.startsWith('/api/settings')||url.pathname.startsWith('/api/admin/')){if(!authorized){res.writeHead(401);res.end('Authentication required');return;}const settingsViewer={...viewer,_gatewayAuthenticated:access.requiredLogin,diagnosticClientKey:diagnosticClientKey(),diagnosticAuthorityUntil:Math.min(Date.now()+900000,access.authenticateCookie(cookieValue)?parseInt(cookieValue.split('.')[2],36):Infinity,viewer.expiresAt?Date.parse(viewer.expiresAt):Infinity)};if(await settingsHandler(req,res,url,settingsViewer,{verifyAuthority}))return;}
   if(url.pathname==='/api/session'&&req.method==='POST'&&access.requiredLogin){
    const body=await readJSON(req,4096),fields=body&&typeof body==='object'&&!Array.isArray(body)?Object.keys(body):[],keyMode=fields.length===1&&fields[0]==='token',passwordMode=fields.length===2&&fields.includes('username')&&fields.includes('password');
    if(!keyMode&&!passwordMode)throw Object.assign(new Error('Use an access key or a username and password'),{status:400});
    if(passwordMode&&(upstream||!administration))throw Object.assign(new Error('Password sign-in is available on the authoritative hub'),{status:503});
    const account=keyMode?'key:'+(access.authenticateBearer(body.token)?.id||'unknown-key'):'password:'+access.passwordAccount(body.username);
    loginAttempts.consume(req.socket.remoteAddress||'unknown',account);const authenticator=access,identity=keyMode?access.authenticateBearer(body.token):await access.authenticatePassword(body.username,body.password);
    if(!identity||authenticator!==access){res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":"Sign-in failed"}');return;}
    res.setHeader('Set-Cookie',cookie(identity));res.setHeader('Content-Type','application/json');res.end('{"signedIn":true}');return;
   }
   if(url.pathname==='/api/collector/companion'&&req.method==='POST'&&hub){
    const source=hub.authenticateCollector(bearer);if(!source||!['codex-source','hub',undefined].includes(source.role)){res.writeHead(401,{'Connection':'close'});res.end('Collector authentication required');return;}
    if(companionReader){res.writeHead(429,{'Connection':'close','Retry-After':'10'});res.end('Desktop artwork admission busy');return;}companionReader=true;
    try{const body=await readJSON(req,COMPANION_MAX_WIRE);if(!body||Object.keys(body).sort().join(',')!=='artwork,metadata')throw new Error('Invalid desktop artwork payload');const metadata=await saveCompanion(path.join(hub.directory,'desktop-companions',source.id),body.metadata,body.artwork,{storageAdmission:hub.journal.storageAdmission,validate:()=>{if(hub.authenticateCollector(bearer)?.id!==source.id||!['codex-source','hub',undefined].includes(hub.authenticateCollector(bearer)?.role))throw Object.assign(new Error('Collector revoked'),{status:401});}});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({artworkSha256:metadata.artworkSha256}));}finally{companionReader=false;}return;
   }
   if(url.pathname==='/api/desktop/companion/artwork'&&req.method==='GET'){
    if(!authorized||viewer.role!=='admin'){res.writeHead(403);res.end('Administrator access required');return;}
    const hostId=url.searchParams.get('hostId'),sha=url.searchParams.get('sha256');if(!/^[-a-z0-9]{1,64}$/.test(hostId||'')||!/^[a-f0-9]{64}$/.test(sha||''))throw Object.assign(new Error('Invalid artwork identity'),{status:400});
    if(companionReader)throw Object.assign(new Error('Desktop artwork admission busy'),{status:429});companionReader=true;
    try{let result;if(upstream)result=await remoteJSON(upstream,url.pathname+url.search,'GET',undefined,{validate:verifyAuthority});else{if(!companionHost(hostId,verifyAuthority()))throw Object.assign(new Error('Desktop source unavailable'),{status:403});const metadata=desktopMetadata(hostId);if(!metadata||metadata.artworkSha256!==sha)throw Object.assign(new Error('Desktop selection changed'),{status:409});result={metadata,artwork:await readCompanionArtwork(path.join(hub.directory,'desktop-companions',hostId),metadata)};if(!companionHost(hostId,verifyAuthority())||desktopMetadata(hostId)?.artworkSha256!==sha)throw Object.assign(new Error('Desktop selection changed'),{status:409});}const encoded=JSON.stringify(result);verifyAuthority();res.setHeader('Content-Type','application/json');res.end(encoded);}finally{companionReader=false;}return;
   }
   if(req.url==='/api/collector'&&req.method==='POST'&&hub){
    // Reserve a 2 MiB body slot through durable commit: at most 8 MiB
    // buffered input and four parsed/queued collector batches in this process.
    const collector=hub.authenticateCollector(bearer);if(!collector){res.writeHead(401,{'Connection':'close'});res.end('Unauthorized');return;}
    if(collectorReaders>=4||collectorSources.has(collector.id)){res.writeHead(429,{'Connection':'close','Retry-After':'1'});res.end('Collector admission busy');return;}
    collectorReaders++;collectorSources.add(collector.id);
    try{const {body,wireSha256}=await readJSON(req,2097152,{fingerprint:true}),result=await hub.ingest(bearer,body,{wireSha256});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));}catch(error){if(!error.status||error.status>=500)void localDiagnostics?.capture({kind:'backend',category:'collection-failed',site:'backend:collection'}).catch(()=>{});if(!res.destroyed){res.writeHead(error.status||400,{'Connection':'close',...([503,429].includes(error.status)?{'Retry-After':String(error.retryAfter||60)}:{})});res.end(error.status===401?'Unauthorized':'Collector batch refused');}}finally{collectorReaders--;collectorSources.delete(collector.id);}
    return;
   }
   if(req.url==='/api/preferences'&&['GET','PUT'].includes(req.method)){
    if(!authorized){res.writeHead(401);res.end('Viewer authentication required');return;}
    const displayStore=displayStoreFor(viewer);
    if(!upstream&&!displayStore){res.writeHead(503);res.end('Display profile unavailable');return;}
    const value=req.method==='PUT'?validateDisplayPreferences(await readJSON(req,4096)):undefined;
    verifyAuthority();const result=upstream?await remoteJSON(upstream,'/api/preferences',req.method,value,{validate:verifyAuthority}):value?await displayStore.write(value,{verifyAuthority}):await displayStore.read({verifyAuthority});
    const encoded=JSON.stringify(result);verifyAuthority();res.setHeader('Content-Type','application/json');res.end(encoded);return;
   }
   if(['/api/profile','/api/profile/photo'].includes(req.url)&&['GET','PUT'].includes(req.method)){
    if(!authorized){res.writeHead(401);res.end('Viewer authentication required');return;}
    if(req.url==='/api/profile/photo'&&req.method!=='GET'){res.writeHead(405);res.end('Read only');return;}
    if(profileReaders>=2)throw Object.assign(new Error('Profile service busy; try again shortly'),{status:429});profileReaders++;
    try{
    const body=req.method==='PUT'?await readJSON(req,720896):undefined;verifyAuthority();let result;
    if(upstream)result=await remoteJSON(upstream,req.url,req.method,body,{validate:verifyAuthority});
    else {const store=displayStoreFor(viewer);if(!store)throw Object.assign(new Error('Profile storage unavailable'),{status:503});const profile=new UserProfile(store.directory,path.basename(store.file));if(req.method==='PUT'){if(body?.viewerId!==viewer.id)throw Object.assign(new Error('Profile identity changed; reload before saving'),{status:409});const {viewerId,...update}=body;result=await profile.write(update,{verifyAuthority});}else result=await profile.read();result={...result,viewerId:viewer.id};if(req.url==='/api/profile/photo')result={revision:result.revision,photo:result.photo};}
    const encoded=JSON.stringify(result);verifyAuthority();res.setHeader('Content-Type','application/json');res.end(encoded);return;
    }finally{profileReaders--;}
   }
   if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, HEAD'});res.end('Read only');return;}
   if(url.pathname.startsWith('/api/')){
    if(!authorized){res.writeHead(401);res.end('Open the dashboard or sign in first');return;}
    if(url.pathname==='/api/projects'){
     const params=url.searchParams;
     for(const key of params.keys())if(key!=='project'||params.getAll(key).length!==1||!params.get(key)||params.get(key).length>256)throw Object.assign(new Error('Invalid project query'),{status:400});
     const project=params.get('project');if(project&&viewer.projectIds!==null&&!viewer.projectIds.includes(project))throw Object.assign(new Error('Project not permitted'),{status:403});
     let result;
     if(upstream)result=await remoteJSON(upstream,url.pathname+url.search,'GET',undefined,{validate:verifyAuthority});
     else if(hub?.journal){const hostIds=await projectHosts(viewer);verifyDelivery();result=supplementProjects(await readProjects({hostIds,projectIds:viewer.projectIds,project,now:Date.now()}),project,verifyAuthority());}
     else result={observedAt:new Date().toISOString(),projects:[],selected:null,state:'history_unavailable'};
     res.setHeader('Content-Type','application/json');await deliverRepresentation(req,res,req.method==='HEAD'?null:JSON.stringify(result),{validate:verifyDelivery});return;
    }
    if(url.pathname==='/api/integrations/github'){
     if(!upstream&&(!access.requiredLogin||['local','legacy'].includes(viewer.id)))throw Object.assign(new Error('Individual viewer required'),{status:403});
     const patterns={after:/^\d{1,16}$/,limit:/^\d{1,3}$/,epoch:/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/,source:/^[-a-z0-9]{1,64}$/,view:/^(summary|history)$/};
     for(const key of url.searchParams.keys())if(!patterns[key]||url.searchParams.getAll(key).length!==1||!patterns[key].test(url.searchParams.get(key)))throw Object.assign(new Error('Invalid GitHub query'),{status:400});
     const options={after:Number(url.searchParams.get('after')||0),limit:Number(url.searchParams.get('limit')||50),epoch:url.searchParams.get('epoch')||undefined,source:url.searchParams.get('source')||undefined,view:url.searchParams.get('view')||'history'};
     let result;
     if(upstream)result=await remoteJSON(upstream,url.pathname+url.search,'GET',undefined,{validate:verifyAuthority});
     else result=!githubIntegration?{state:'unavailable',reason:'not_configured',sources:[],observations:[]}:options.view==='summary'&&githubIntegration.snapshot?githubIntegration.snapshot({...options,viewer:verifyAuthority(),hosts:hub?.hosts}):githubIntegration.read({...options,viewer:verifyAuthority(),hosts:hub?.hosts});
     result.permissionStamp=crypto.createHmac('sha256',sessionSecret).update(JSON.stringify([initialViewerScope,sourceScope(),upstream?result.permissionStamp:null])).digest('hex');
     res.setHeader('Content-Type','application/json');await deliverRepresentation(req,res,req.method==='HEAD'?null:JSON.stringify(result),{validate:verifyDelivery});return;
    }
    if(url.pathname==='/api/account'){
     res.setHeader('Content-Type','application/json');if(req.method==='HEAD'){res.end();return;}
     const result=upstream?await remoteJSON(upstream,'/api/account'):{observedAt:new Date().toISOString(),viewer:{id:viewer.id,label:viewer.label,username:viewer.username,role:viewer.role,passwordEnabled:viewer.passwordEnabled},capabilities:{authenticated:access.requiredLogin,passwordLogin:!!administration&&access.requiredLogin,passwordChange:!!administration&&viewer.passwordEnabled,settings:true},desktopCompanions:companionMetadata(viewer)};
     if(!upstream){const display=displayStoreFor(viewer);if(display){const profile=await new UserProfile(display.directory,path.basename(display.file)).read();result.personal={name:profile.name,nickname:profile.nickname,revision:profile.revision,hasPhoto:!!profile.photo};result.capabilities.profileWrite=true;}}
     if(viewer.role!=='admin')result.desktopCompanions=[];
     result.capabilities={...result.capabilities,logout:access.requiredLogin,...(upstream?{passwordLogin:false,passwordLoginUrl:upstreamLoginUrl(upstream)}:{})};const encoded=JSON.stringify(result);verifyAuthority();res.end(encoded);return;
    }
    if(url.pathname==='/api/account/allowance-history'){
     res.setHeader('Content-Type','application/json');
     if(!['GET','HEAD'].includes(req.method))throw Object.assign(new Error('Read-only allowance history'),{status:405});
     const params=url.searchParams;
     for(const k of params.keys())if(k!=='range'||params.getAll(k).length!==1)throw Object.assign(new Error('Invalid allowance range'),{status:400});
     const range=params.get('range')||'24h';if(!['24h','48h','7d'].includes(range))throw Object.assign(new Error('Invalid allowance range'),{status:400});
     if(viewer.hostIds!==null||viewer.projectIds!==null)throw Object.assign(new Error('Account-wide history requires an administrator'),{status:403});
     if(upstream){await deliverRepresentation(req,res,req.method==='HEAD'?null:JSON.stringify(await remoteJSON(upstream,url.pathname+url.search)),{validate:verifyDelivery});return;}
     if(viewer.role!=='admin')throw Object.assign(new Error('Account-wide history requires an administrator'),{status:403});
     if(req.method==='HEAD'){await deliverRepresentation(req,res,null,{validate:verifyDelivery});return;}
     const result=await captureForRead(hub,await readSnapshot(),local=>{
     const now=Date.now(),sources=[];
     if(local.accountUsage)sources.push({hostId:local.host.id,accountUsage:local.accountUsage});
     if(hub)for(const host of hub.hosts)if(!host.disabled&&(!host.expiresAt||Date.parse(host.expiresAt)>now)&&host.role!=='execution-target'){const state=hub.states.get(host.id);if(state?.accountUsage)sources.push({hostId:host.id,accountUsage:state.accountUsage});}
     const account=buildAccountUsageResponse({sources,viewer,now}).accountUsage.accounts;
     const one=account.length===1?account[0]:null,selection=selectWeeklyAllowance(one);
     let result={status:'unavailable',range,points:[],reason:'No durable linked account history is available on this connection.'};
     if(one?.accountKey&&selection&&hub?.journal?.allowanceHistory){
      const enabled=[...(local.host?.id?[local.host.id]:[]),...hub.hosts.filter(h=>!h.disabled&&(!h.expiresAt||Date.parse(h.expiresAt)>now)&&h.role!=='execution-target').map(h=>h.id)];
      result=hub.journal.allowanceHistory({now,range,accountKey:one.accountKey,...selection,hostIds:[...new Set(enabled)]});
     }
     return result;
     });
     await deliverRepresentation(req,res,JSON.stringify(result),{validate:verifyDelivery});return;
    }

    if(url.pathname==='/api/account/spending-status'){
     res.setHeader('Content-Type','application/json');
     if(!access.requiredLogin||localPreview||viewer.role!=='admin'||viewer.hostIds!==null||viewer.projectIds!==null)throw Object.assign(new Error('Unrestricted administrator access required'),{status:403});
     if(!['GET','HEAD'].includes(req.method))throw Object.assign(new Error('Read-only spending status'),{status:405});
     if(url.searchParams.size)throw Object.assign(new Error('Spending status does not accept scope overrides'),{status:400});
     if(upstream||!spendingAdvisory){
      res.statusCode=503;await deliverRepresentation(req,res,req.method==='HEAD'?null:JSON.stringify({mode:'ADVISORY',state:'UNAVAILABLE',reason:upstream?'LOCAL_ONLY':'NOT_CONFIGURED',nativeDispatchEnforcement:'UNSUPPORTED'}),{validate:verifyDelivery});return;
     }
     if(req.method==='HEAD'){await deliverRepresentation(req,res,null,{validate:verifyDelivery});return;}
     const local=await readSnapshot(),now=Date.now(),sources=[];
     const enabled=h=>!h.disabled&&(!h.expiresAt||Date.parse(h.expiresAt)>now)&&h.role!=='execution-target';
     const localRegistration=hub?.hosts.find(h=>h.id===local.host?.id);
     if(local.accountUsage&&(!localRegistration||enabled(localRegistration)))sources.push({hostId:local.host.id,accountUsage:local.accountUsage});
     if(hub)for(const host of hub.hosts)if(host.id!==local.host?.id&&enabled(host)){
      const state=hub.states.get(host.id);if(state?.accountUsage)sources.push({hostId:host.id,accountUsage:state.accountUsage});
     }
     const result=await spendingAdvisory.readStatus({sources,viewer,
      readPage:criteria=>readSpendingUsagePage(hub?.journal,criteria)});
     await deliverRepresentation(req,res,JSON.stringify(result),{validate:verifyDelivery});return;
    }

    if(url.pathname==='/api/account/usage'){
     res.setHeader('Content-Type','application/json');if(req.method==='HEAD'){await deliverRepresentation(req,res,null,{validate:verifyDelivery});return;}
     if(upstream){await deliverRepresentation(req,res,JSON.stringify(await remoteJSON(upstream,url.pathname+url.search)),{validate:verifyDelivery});return;}
     const params=url.searchParams,options={};
     for(const k of params.keys())if(!['hostId','project','sessionId','details','summary','native'].includes(k)||params.getAll(k).length!==1||!params.get(k)||params.get(k).length>240||['details','summary','native'].includes(k)&&params.get(k)!=='1')throw Object.assign(new Error('Invalid usage query'),{status:400});
     if(params.has('hostId')&&viewer.hostIds!==null&&!viewer.hostIds.includes(params.get('hostId')))throw Object.assign(new Error('Host not permitted'),{status:403});
     if(params.has('project')&&viewer.projectIds!==null&&!viewer.projectIds.includes(params.get('project')))throw Object.assign(new Error('Project not permitted'),{status:403});
     const response=await captureForRead(hub,await readSnapshot(),local=>{
     const now=Date.now(),data=hub?hub.snapshot(local,now,{includeEvents:false}):local,filtered=filterSnapshot(data,viewer),sources=[];
     if(local.accountUsage)sources.push({hostId:local.host.id,accountUsage:local.accountUsage});
     if(hub)for(const host of hub.hosts)if(!host.disabled&&(!host.expiresAt||Date.parse(host.expiresAt)>Date.now())&&host.role!=='execution-target'){const state=hub.states.get(host.id);if(state?.accountUsage)sources.push({hostId:host.id,accountUsage:state.accountUsage});}
     // Selection narrows the already-authorized active-session projection. Account
     // allowances remain account-wide; durable burn keeps its own SQL time window.
     const selected={...filtered,sessions:filtered.sessions.filter(session=>
      (!params.has('hostId')||session.hostId===params.get('hostId'))&&
      (!params.has('project')||session.project===params.get('project'))&&
      (!params.has('sessionId')||session.id===params.get('sessionId')))};
     const response=buildAccountUsageResponse({sources,snapshot:selected,viewer,now});
     if(local.coverage?.captureDeferred)response.coverage={...response.coverage,captureDeferred:true};
     if(hub?.journal){
      // Restrict the SQL projection before aggregation. Disabled/expired sources
      // never remain visible just because old usage is retained on disk.
      const enabled=new Set([...(local.host?.id?[local.host.id]:[]),...hub.hosts.filter(h=>!h.disabled&&(!h.expiresAt||Date.parse(h.expiresAt)>now)&&h.role!=='execution-target').map(h=>h.id)]);
      options.hostIds=[...enabled].filter(id=>(viewer.hostIds===null||viewer.hostIds.includes(id))&&(!params.has('hostId')||params.get('hostId')===id));
      options.projectIds=params.has('project')?[params.get('project')]:viewer.projectIds;
      if(params.has('sessionId'))options.sessionId=params.get('sessionId');
      options.includeAccount=viewer.role==='admin'&&viewer.hostIds===null&&viewer.projectIds===null;
      const {burn,epoch,...history}=hub.journal.usage({...options,now,limit:200});
      response.burnUsage={...burn,epoch};response.usageHistory={...history,epoch};
      if(params.get('summary')==='1'){for(const field of ['daily','accountObservations','accountDaily'])delete response.usageHistory[field];response.usageHistory.projection='live-summary';}
      if(params.get('details')==='1'){response.sampleAnalytics=hub.journal.sampleAnalytics({...options,now});if(options.includeAccount&&params.get('native')==='1')for(const account of response.accountUsage.accounts||[]){const ref=account.nativeAnalytics;if(ref&&account.accountKey)account.nativeAnalyticsData=hub.journal.nativeAnalytics({digest:ref.digest,accountKey:account.accountKey,hostIds:account.hostIds.filter(id=>options.hostIds.includes(id))});}}
     }else{response.burnUsage={status:'unavailable',windowMs:60000,workers:[],reason:'Durable usage observation is unavailable on this connection.'};response.usageHistory={status:'unavailable'};}
     return response;
     });
     await deliverRepresentation(req,res,JSON.stringify(response),{validate:verifyDelivery});return;
    }
    if(url.pathname==='/api/snapshot'){
     res.setHeader('Content-Type','application/json');if(req.method==='HEAD'){await deliverRepresentation(req,res,null,{validate:verifyDelivery});return;}
     const projectSnapshot=data=>{
      const filtered=filterSnapshot(localPreview?localPreviewSnapshot(data,localPreview):data,viewer);
      if(hub?.journal&&(viewer.hostIds!==null||viewer.projectIds!==null))filtered.history={...filtered.history,...hub.journal.status(viewer.hostIds,viewer.projectIds)};
      filtered.viewer={id:viewer.id,label:viewer.label,role:viewer.role,scope:viewer.hostIds===null&&viewer.projectIds===null?'all-hosts':'authorized-sources',permissionStamp:crypto.createHmac('sha256',sessionSecret).update(JSON.stringify([initialViewerScope,sourceScope(),upstream?data.viewer?.permissionStamp:null])).digest('hex')};
      return display(filtered);
     };
     let filtered;
     if(upstream){const remote=await remoteJSON(upstream,url.pathname+url.search);filtered=hub?await hub.readProjection(remote,projectSnapshot):projectSnapshot(remote);}
     else filtered=await captureForRead(hub,await readSnapshot(),local=>{
      const data=hub?hub.snapshot(local,Date.now(),{includeEvents:url.searchParams.get('metadata')!=='1',hostIds:viewer.hostIds,projectIds:viewer.projectIds}):local;
      data.application=publicApplication();return projectSnapshot(data);
     });
     await deliverRepresentation(req,res,JSON.stringify(filtered),{validate:verifyDelivery});return;
    }
    if(['/api/events','/api/history'].includes(url.pathname)){
     res.setHeader('Content-Type','application/json');if(req.method==='HEAD'){await deliverRepresentation(req,res,null,{validate:verifyDelivery});return;}
     if(upstream){await deliverRepresentation(req,res,JSON.stringify(await remoteJSON(upstream,url.pathname+url.search)),{validate:verifyDelivery});return;}
     if(!hub?.journal){res.writeHead(503);res.end('Durable history unavailable');return;}
     const page=await captureForRead(hub,await readSnapshot(),local=>{const params=url.searchParams,options={};
     for(const k of params.keys())if(!['after','epoch','limit','before','beforeSequence','hostId','sessionId','project'].includes(k))throw Object.assign(new Error('Unsupported history query'),{status:400});
     for(const k of ['after','limit','beforeSequence'])if(params.has(k))options[k]=Number(params.get(k));
     for(const k of ['epoch','hostId','sessionId','project'])if(params.has(k)){if(params.get(k).length>240)throw Object.assign(new Error('History query exceeds bound'),{status:400});options[k]=params.get(k);}
     if(viewer.hostIds!==null){if(options.hostId&&!viewer.hostIds.includes(options.hostId))throw Object.assign(new Error('Host not permitted'),{status:403});options.hostIds=viewer.hostIds;}
     if(viewer.projectIds!==null){if(options.project&&!viewer.projectIds.includes(options.project))throw Object.assign(new Error('Project not permitted'),{status:403});options.projectIds=viewer.projectIds;}
     if(url.pathname==='/api/history')options.before=params.get('before')||new Date(Date.now()+1).toISOString();
     else if(params.has('before')||params.has('beforeSequence'))throw Object.assign(new Error('Use history endpoint'),{status:400});
     const page=hub.journal.read(options);if(local.coverage?.captureDeferred)page.coverage={captureDeferred:true};page.events=page.events.map(e=>projectEvent(e,viewer)).filter(Boolean);return page;});await deliverRepresentation(req,res,JSON.stringify(display(page)),{validate:verifyDelivery});return;
    }
    if(url.pathname==='/api/diagnostics'){if(viewer.hostIds!==null||viewer.projectIds!==null)throw Object.assign(new Error('Fleet diagnostics require fleet scope'),{status:403});res.setHeader('Content-Type','application/json');if(req.method==='HEAD'){res.end();return;}const encoded=JSON.stringify(upstream?await remoteJSON(upstream,'/api/diagnostics','GET',undefined,{validate:verifyAuthority}):await runtimeDiagnostics(hub?.journal,{diskBudgetMiB:hub?.diskBudgetMiB}));verifyAuthority();res.end(encoded);return;}
    if(url.pathname.startsWith('/api/documents/')){if(viewer.hostIds!==null||viewer.projectIds!==null)throw Object.assign(new Error('Project documents require fleet scope'),{status:403});const relative=documents.get(url.pathname.split('/').at(-1));if(relative){res.setHeader('Content-Type','text/plain; charset=utf-8');res.end(req.method==='HEAD'?'':await fs.readFile(path.join(ROOT,relative),'utf8'));return;}}
   }
   if(url.pathname==='/'&&access.requiredLogin&&!authorized){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(req.method==='HEAD'?'':await fs.readFile(path.join(ROOT,'public/login.html')));return;}
   const entry=staticEntry;
   if(entry){if(url.pathname==='/'&&!access.requiredLogin)res.setHeader('Set-Cookie',cookie(access.localViewer));res.setHeader('Content-Type',entry[1]+(entry[1].startsWith('font/')?'':'; charset=utf-8'));if(authorized&&entry[1].startsWith('text/')&&entry[0]!=='public/login.js'&&!res.hasHeader('Set-Cookie'))await deliverRepresentation(req,res,req.method==='HEAD'?null:await fs.readFile(path.join(ROOT,entry[0])),{validate:verifyDelivery});else res.end(req.method==='HEAD'?'':await fs.readFile(path.join(ROOT,entry[0])));return;}
   res.writeHead(404);res.end('Not found');
  }catch(error){if(!error.status||error.status>=500)void localDiagnostics?.capture({kind:'backend',category:'request-failed',site:'backend:request'}).catch(()=>{});if(res.destroyed||res.writableEnded)return;if(res.headersSent){res.destroy();return;}const status=error.status||503;res.writeHead(status,{'Content-Type':'application/json',...(status===429?{'Retry-After':String(error.retryAfter||60)}:{})});res.end(JSON.stringify({error:status<500?error.message:status===503&&error.message==='Password sign-in is available on the authoritative hub'?error.message:'Observation unavailable',...(status===400&&Array.isArray(error.errors)?{errors:error.errors.slice(0,64)}:{})}));}
 };
 const server=tls?https.createServer(tls,handler):http.createServer(handler);
 let releaseHistoryConnection,releaseJournalWriter,closeWork=Promise.resolve();
 server.on('listening',()=>{releaseHistoryConnection??=hub?.journal?.retainConnection?.();releaseJournalWriter??=hub?.retainJournalWriter?.();});
 server.on('close',()=>{
  const releaseHistory=releaseHistoryConnection,releaseWriter=releaseJournalWriter;releaseHistoryConnection=undefined;releaseJournalWriter=undefined;
  closeWork=(async()=>{try{await installation?.close();await releaseWriter?.();}finally{releaseHistory?.();stopDiagnosticObserver?.();applicationDiagnostics.close();await githubConnections?.close();await projectReader?.close();}})();
  void closeWork.catch(()=>{});
 });
 const nativeClose=server.close.bind(server);
 server.close=function(callback){return nativeClose(error=>{void closeWork.then(()=>server.runtimeCloseWork).then(()=>callback?.(error),failure=>{if(callback)callback(error||failure);else console.error('Journal shutdown failed');});});};
 return server;
}
export async function startRuntime(original,{recoveryAttempt=false}={}){
 const proxyOrigins=validateProxyOrigins(original.proxyOrigins);
 const dataDirectory=path.resolve(original.dataDirectory||'.local/fleet');await fs.mkdir(dataDirectory,{recursive:true,mode:0o700});
 try{await fs.access(path.join(dataDirectory,'restore.lock'));throw new Error('An offline restore is in progress; preserve the lock and finish or recover it before starting');}catch(error){if(error.code!=='ENOENT')throw error;}
 const pidFile=path.join(dataDirectory,original.upstream?'gateway-runtime.pid':'runtime.pid');
 try{const owner=JSON.parse(await fs.readFile(pidFile,'utf8'));if(owner.pid!==process.pid){try{process.kill(owner.pid,0);throw new Error('Another Codex-Control runtime owns this data directory');}catch(error){if(error.code!=='ESRCH')throw error;}}}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!process.env.CODEX_CONTROL_HOST_ID){try{const identity=JSON.parse(await fs.readFile(path.join(dataDirectory,'installation','installation.json'),'utf8'));if(/^[-a-z0-9]{1,64}$/.test(identity.hostId))HOST_ID=identity.hostId;}catch(error){if(error.code!=='ENOENT')throw error;}}
 let config={...original},configuration,administration,securityState,deploymentState,hub,collectTimer,githubIntegration,githubConnections,installation;
 if(!config.upstream){
  configuration=await ConfigurationStore.open({directory:path.join(dataDirectory,'configuration'),initial:seedDeployment(config,{hostId:HOST_ID,sessionRoot:SESSION_ROOT})});deploymentState=await configuration.read();
  try{await validateRuntimeConfiguration(deploymentState.configuration,{...original,installationRole:deploymentState.configuration.general.installationRole});}catch(error){if(!deploymentState.requiresRestart||recoveryAttempt)throw error;deploymentState=await configuration.rollback({revision:deploymentState.revision,actor:{id:'system',role:'system'}});await validateRuntimeConfiguration(deploymentState.configuration,{...original,installationRole:deploymentState.configuration.general.installationRole});console.error('A pending configuration failed validation; restored the previous configuration');}
  config=runtimeWithDeployment(original,deploymentState.configuration);
  administration=await Administration.open({directory:path.join(dataDirectory,'administration'),initial:{viewTokenHash:original.viewTokenHash,viewers:original.viewers||[],hosts:original.hosts||[],instanceId:original.instanceId}});securityState=await administration.state();
  config.viewTokenHash=securityState.viewTokenHash;config.viewers=securityState.viewers;config.instanceId=securityState.instanceId;
  config.hosts=mergeDeviceHosts(securityState.hosts,deploymentState.configuration.fleet.hosts);
  const source=deploymentState.configuration.sources.filter(s=>s.hostId===HOST_ID);configureObservation(source);
  hub=await FleetHub.open({directory:dataDirectory,hosts:config.hosts,historyOptions:{maxEvents:deploymentState.configuration.history.maxEvents,maxBytes:deploymentState.configuration.history.maxMiB*1048576,maxAgeMs:deploymentState.configuration.history.ageDays*86400000}});hub.healthThresholds=deploymentState.configuration.alerts.thresholds;hub.diskBudgetMiB=deploymentState.configuration.history.diskBudgetMiB;
 }
 if(config.deviceClass)process.env.CODEX_CONTROL_DEVICE_CLASS=config.deviceClass;
 if(config.jobFile&&!deploymentState)process.env.CODEX_CONTROL_JOB_FILE=config.jobFile;
 if(config.services)process.env.CODEX_CONTROL_SERVICES=JSON.stringify(config.services);
 watchSessionInventory();
 const listen=config.listen||'127.0.0.1',tls=config.tls?{key:await readPrivateKeyFile(config.tls.key),cert:await fs.readFile(config.tls.cert)}:undefined;
 if(config.syntheticDiagnostics&&!['127.0.0.1','::1'].includes(listen))throw new Error('Synthetic diagnostics application mode must remain on loopback');
 if(config.localPreview&&!['127.0.0.1','::1'].includes(listen))throw new Error('Local preview must remain on loopback');
 if(!['127.0.0.1','::1'].includes(listen)&&(!tls||(!config.viewTokenHash&&!config.viewers?.length)||!config.publicOrigin))throw new Error('Network access requires TLS, viewer authentication and a fixed origin');
 if(hub)githubIntegration=await openGitHubRuntime({configuration:original.github,dataDirectory,getHosts:()=>hub.hosts});
 if(hub)githubConnections=await createGitHubConnections({configuration:original.githubApp,directory:path.join(dataDirectory,'github-connections'),publicOrigin:config.publicOrigin});
 await atomicJSON(pidFile,{pid:process.pid,instanceId:config.instanceId||'gateway',startedAt:new Date().toISOString()});
 const localDiagnostics=await LocalDiagnostics.open({directory:path.join(dataDirectory,'diagnostics')}).catch(()=>null);
 if(hub){const legacyHosts=()=>hub.hosts.filter(h=>!h.installationManaged);installation=await Installation.open({directory:path.join(dataDirectory,'installation'),hostId:HOST_ID,name:config.instanceName||config.hostLabel||os.hostname(),instanceId:config.instanceId,legacyRole:deploymentState.configuration.general.installationRole,network:{listen:config.installationNetwork?.listen||'0.0.0.0',port:config.installationNetwork?.port??((config.port||PORT)+1),address:config.installationNetwork?.address,discovery:config.installationNetwork?.discovery!==false},applyRole:role=>configuration.applyInstallationRole(role),onNameChanged:name=>configuration.applyInstallationName(name),validatePeer:peer=>{if(peer.role==='node'&&(peer.hostId===HOST_ID||legacyHosts().some(h=>h.id===peer.hostId)))throw Object.assign(new Error('Paired host identity conflicts with an existing source'),{status:409});},onPeersChanged:async peers=>{const prior=hub.hosts.filter(h=>h.installationManaged).map(h=>({...h,disabled:true})),known=legacyHosts();for(const peer of peers){if(peer.role!=='node')continue;if(peer.hostId===HOST_ID||known.some(h=>h.id===peer.hostId))throw new Error('Paired host identity conflicts with an existing source');const next={id:peer.hostId,label:peer.name,role:'codex-source',tokenHash:crypto.createHash('sha256').update(peer.key).digest('hex'),installationManaged:true,disabled:false};const index=prior.findIndex(p=>p.id===peer.hostId);if(index<0)prior.push(next);else prior[index]=next;}hub.setHosts([...known,...prior]);},ingest:(peer,payload,wireSha256,{verifyGrant}={})=>{verifyGrant?.();return hub.ingest(peer.key,payload,{wireSha256});}});deploymentState=await configuration.read();}
 const localObservation=createLocalDesktopObservation(config,{directory:dataDirectory,hostId:HOST_ID,storageAdmission:hub?.journal?.storageAdmission}),readLocalSnapshot=()=>localObservation.read(snapshot);
 if(hub)hub.localCaptureHostId=HOST_ID;
 const server=createServer({localObservation,readSnapshot:readLocalSnapshot,installation,syntheticDiagnostics:config.syntheticDiagnostics,localDiagnostics,hub,preferencesDirectory:path.join(dataDirectory,'display-preferences'),publicOrigin:config.publicOrigin,proxyOrigins,tls,viewTokenHash:config.viewTokenHash,viewers:config.viewers,upstream:config.upstream,localPreview:config.localPreview,configuration,administration,securityState,deploymentState,instanceId:config.instanceId,instanceName:config.instanceName,validateRuntime:c=>validateRuntimeConfiguration(c,{...original,installationRole:installation?.state().role??deploymentState?.configuration.general.installationRole}),githubIntegration,githubConnections,historicalAnalytics:config.historicalAnalytics});
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port||PORT,listen,resolve);});}
 catch(error){await localObservation.close();await installation?.close();await localDiagnostics?.close().catch(()=>{});await githubIntegration?.close();await githubConnections?.close();if(configuration&&deploymentState.requiresRestart&&!recoveryAttempt){await configuration.rollback({revision:deploymentState.revision,actor:{id:'system',role:'system'}});console.error('A pending listener failed to start; restored the previous configuration');return startRuntime(original,{recoveryAttempt:true});}await fs.unlink(pidFile).catch(()=>{});throw error;}
 if(configuration&&deploymentState.requiresRestart)Object.assign(deploymentState,await configuration.activate({revision:deploymentState.revision,actor:{id:'system',role:'system'}}));
 if(hub){let collecting=false;const collect=async()=>{if(collecting)return;collecting=true;try{await installation?.recoverCaptures((local,options)=>hub.captureLocal(local,options));const local=await readLocalSnapshot(),usageCapture=await readUsageSamples(hub.journal.usageCursor(local.host.id));const ticket=await installation?.stageCapture(local,{usageCapture});await hub.captureLocal(local,{usageCapture});localObservation.committed(local);if(ticket)await installation.commitCapture(ticket.id).catch(()=>{});void installation?.flush().catch(()=>{});}catch{void localDiagnostics?.capture({kind:'backend',category:'collection-failed',site:'backend:collection'}).catch(()=>{});console.error('Local journal observation failed; retrying on next cycle');}finally{collecting=false;}};await collect();collectTimer=setInterval(collect,Math.min(1000,observationInterval));collectTimer.unref();}
 server.on('close',()=>{clearInterval(collectTimer);server.runtimeCloseWork=Promise.all([localObservation.close(),installation?.close(),localDiagnostics?.close(),githubIntegration?.close(),fs.readFile(pidFile,'utf8').then(text=>{const guard=JSON.parse(text);if(guard.pid===process.pid)return atomicJSON(pidFile,{...guard,stoppedAt:new Date().toISOString()});})]);void server.runtimeCloseWork.catch(()=>{});});
 return {server,hub,configuration,administration,installation,instanceId:config.instanceId};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const config=process.env.CODEX_CONTROL_CONFIG?JSON.parse(await fs.readFile(process.env.CODEX_CONTROL_CONFIG,'utf8')):{};
 const runtime=await startRuntime(config);console.log('Codex-Control observer ready on '+runtime.server.address().address+':'+runtime.server.address().port);
}
