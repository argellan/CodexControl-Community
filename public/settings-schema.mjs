// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {installationName} from './installation-identity.mjs';
export const SCHEMA_VERSION=1;
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export const DEFAULT_CONFIGURATION=freeze({schemaVersion:1,general:{instanceName:'Codex Control',organization:'ARGELLAN',timezone:'UTC',timeFormat:'24h',installationRole:'standalone'},fleet:{hosts:[]},sources:[],history:{ageDays:7,maxEvents:200000,maxMiB:96,diskBudgetMiB:256},alerts:{minimumSeverity:'warning',thresholds:{sourceStaleSeconds:15,sourceOfflineSeconds:30,toolUnansweredSeconds:15,quotaRemainingPercent:10,cpuPercent:90,memoryPercent:90},quietHours:{enabled:false,start:'22:00',end:'07:00'},presentation:{ticker:true,glow:true,sound:false}},networking:{publicOrigin:null,listen:'127.0.0.1',port:4317,expectedTls:false}});
const f=(path,label,type,extra={})=>({path,label,type,restartRequired:/^(fleet|sources|history|networking)\.|^general.installationRole$/.test(path),...extra});
export const SETTINGS_SCHEMA=freeze([
 f('general.instanceName','Instance name','string',{min:1,max:120,codePoints:true}),f('general.organization','Organization','string',{min:1,max:80}),f('general.timezone','Time zone','timezone'),f('general.timeFormat','Clock format','enum',{options:['24h','12h']}),f('general.installationRole','Installation role','enum',{restartRequired:false,options:['standalone','hub','node','gateway','collector','execution-target']}),
 f('fleet.hosts','Fleet hosts','array',{max:64,fields:[f('id','Stable host ID','machine-id'),f('label','Device label','string',{min:1,max:120}),f('deviceClass','Device class','enum',{options:['laptop','workstation','rack-server','raspberry-pi','edge','cloud','unknown']}),...['site','rack','zone','group'].map(k=>f(k,k[0].toUpperCase()+k.slice(1),'string',{max:80})),f('preferredAddress','Preferred address','address',{nullable:true}),f('alternateAddresses','Alternate addresses','string-array',{max:8}),f('managedSources','Manage source profiles','boolean',{default:false,help:'Enabled: the hub owns this host’s exact source profile set; an empty set disables collection. Disabled with no profiles: preserve the collector’s local source policy.'})]}),
 f('sources','Observation sources','array',{max:256,restartRequired:true,fields:[f('id','Stable source ID','id'),f('hostId','Host ID','machine-id'),f('kind','Source kind','enum',{options:['codex-log','job-feed','execution-target']}),f('path','Source path on its owning host','path',{max:1024}),f('intervalMs','Poll interval (ms)','integer',{min:250,max:300000}),f('enabled','Enabled','boolean')]}),
 f('history.ageDays','Retention days','integer',{min:1,max:90}),f('history.maxEvents','Retained event limit','integer',{min:1000,max:1000000}),f('history.maxMiB','Event payload budget (MiB)','integer',{min:8,max:512}),f('history.diskBudgetMiB','History disk budget (MiB)','integer',{min:64,max:4096}),
 f('alerts.minimumSeverity','Minimum presentation severity','enum',{options:['info','warning','critical']}),f('alerts.thresholds.sourceStaleSeconds','Stale source after (seconds)','integer',{min:5,max:3600}),f('alerts.thresholds.sourceOfflineSeconds','Offline source after (seconds)','integer',{min:10,max:7200}),f('alerts.thresholds.toolUnansweredSeconds','Unanswered tool after (seconds)','integer',{min:5,max:3600}),f('alerts.thresholds.quotaRemainingPercent','Low quota threshold (%)','integer',{min:0,max:100}),f('alerts.thresholds.cpuPercent','Host CPU threshold (%)','integer',{min:0,max:100}),f('alerts.thresholds.memoryPercent','Host RAM threshold (%)','integer',{min:0,max:100}),f('alerts.quietHours.enabled','Quiet hours enabled','boolean'),f('alerts.quietHours.start','Quiet hours start','time'),f('alerts.quietHours.end','Quiet hours end','time'),...['ticker','glow','sound'].map(k=>f('alerts.presentation.'+k,k[0].toUpperCase()+k.slice(1),'boolean')),
 f('networking.publicOrigin','Public origin','origin',{nullable:true}),f('networking.listen','Listen address','listen'),f('networking.port','Port','integer',{min:1024,max:65535}),f('networking.expectedTls','TLS expected','boolean')
]);

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,min,max)=>typeof value==='string'&&value.length>=min&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const validId=value=>typeof value==='string'&&/^[a-z0-9][-a-z0-9_]{0,63}$/.test(value);
function validAddress(value){
 if(!text(value,1,253)||/[\s/@?#\\]/.test(value))return false;
 if(value.includes(':')){try{return !!new URL('http://['+value.replace(/^\[|\]$/g,'')+']/').hostname;}catch{return false;}}
 if(/^\d+(\.\d+){3}$/.test(value))return value.split('.').every(p=>Number(p)<=255);
 return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value)&&!value.includes('..');
}
function validSourcePath(value){
 if(!text(value,1,1024)||value.includes('://'))return false;
 if(!(/^[a-z]:[\\/]/i.test(value)||value.startsWith('/')||/^\\\\[^\\]+\\[^\\]+/.test(value)))return false;
 return !/(?:^|[\\/])(?:auth\.json|credentials?(?:\.[^\\/]*)?|tokens?(?:\.[^\\/]*)?|id_(?:rsa|ed25519)(?:\.pub)?|[^\\/]*\.(?:pem|pfx|p12|key))$/i.test(value);
}

// Validates full documents. Paths are inert admin metadata for an enrolled
// source; no commands, credential fields or environment expansion are accepted.
export function validateConfiguration(input){
 // Version-one deployments written before resource alerts keep their saved
 // thresholds; only these newly introduced fields receive compatible defaults.
 if(object(input?.alerts?.thresholds)&&(!Object.hasOwn(input.alerts.thresholds,'cpuPercent')||!Object.hasOwn(input.alerts.thresholds,'memoryPercent')))input={...input,alerts:{...input.alerts,thresholds:{cpuPercent:90,memoryPercent:90,...input.alerts.thresholds}}};
 // Existing hosts remain unmanaged until an administrator explicitly takes
 // ownership of their source set. An empty managed set is intentional disable.
 if(Array.isArray(input?.fleet?.hosts)&&input.fleet.hosts.length<=64&&input.fleet.hosts.some(host=>object(host)&&!Object.hasOwn(host,'managedSources')))input={...input,fleet:{...input.fleet,hosts:input.fleet.hosts.map(host=>object(host)&&!Object.hasOwn(host,'managedSources')?{...host,managedSources:false}:host)}};
 const errors=[],problem=(path,message)=>errors.push({path,message});
 const shape=(value,keys,prefix)=>{if(!object(value)){problem(prefix,'Expected an object');return false;}if(Object.keys(value).some(k=>!keys.includes(k)))problem(prefix,'Unsupported configuration field');for(const key of keys)if(!Object.hasOwn(value,key))problem(prefix?prefix+'.'+key:key,'Required field');return true;};
 const fieldCheck=(value,field,prefix)=>{
  if(value===null&&field.nullable)return;
  const {type,min=0,max=120}=field;
  if(type==='string'){if(field.codePoints){try{if(typeof value!=='string'||value.length>max*2)throw Error('Name bound');installationName(value);}catch{problem(prefix,'Expected a visible installation name of at most120 Unicode characters');}}else if(!text(value,min,max))problem(prefix,'Expected bounded text');}
  if(type==='integer'&&(!Number.isSafeInteger(value)||value<min||value>max))problem(prefix,`Expected an integer from ${min} to ${max}`);
  if(type==='boolean'&&typeof value!=='boolean')problem(prefix,'Expected true or false');
  if(type==='enum'&&!field.options.includes(value))problem(prefix,'Unsupported selection');
  if(type==='id'&&!validId(value))problem(prefix,'Expected a stable lowercase identity');
  if(type==='machine-id'&&!(typeof value==='string'&&/^[-a-z0-9]{1,64}$/.test(value)))problem(prefix,'Expected a collector host ID using lowercase letters, digits and hyphens');
  if(type==='address'&&!validAddress(value))problem(prefix,'Expected a hostname or IP address');
  if(type==='listen'&&!(value==='localhost'||validAddress(value)&&(!/[a-z]/i.test(value)||value.includes(':'))))problem(prefix,'Expected localhost or a literal IP listen address');
  if(type==='time'&&(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)))problem(prefix,'Expected HH:MM local time');
  if(type==='timezone'){try{if(!text(value,1,100))throw 0;new Intl.DateTimeFormat('en-US',{timeZone:value});}catch{problem(prefix,'Expected an available IANA time zone');}}
  if(type==='path'&&value!==''&&!validSourcePath(value))problem(prefix,'Expected an absolute source path; credentials and private keys are excluded');
  if(type==='origin'){try{const u=new URL(value);if(typeof value!=='string'||!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw 0;}catch{problem(prefix,'Expected an HTTP(S) origin without credentials, path or query');}}
  if(type==='string-array'&&(!Array.isArray(value)||value.length>max||value.some(v=>!validAddress(v))||new Set(value).size!==value.length))problem(prefix,'Expected distinct hostnames or IP addresses');
 };
 if(shape(input,Object.keys(DEFAULT_CONFIGURATION),'')){
  if(input.schemaVersion!==SCHEMA_VERSION)problem('schemaVersion','Unsupported schema version');
  for(const section of ['general','history','networking'])shape(input[section],Object.keys(DEFAULT_CONFIGURATION[section]),section);
  shape(input.fleet,['hosts'],'fleet');
  if(shape(input.alerts,Object.keys(DEFAULT_CONFIGURATION.alerts),'alerts'))for(const section of ['thresholds','quietHours','presentation'])shape(input.alerts[section],Object.keys(DEFAULT_CONFIGURATION.alerts[section]),'alerts.'+section);
  for(const field of SETTINGS_SCHEMA){
   const value=field.path.split('.').reduce((v,key)=>v?.[key],input);
   if(field.type!=='array'){fieldCheck(value,field,field.path);continue;}
   if(!Array.isArray(value)||value.length>field.max){problem(field.path,'Expected a bounded array');continue;}
   const seen=new Set();for(const [i,row] of value.entries()){const prefix=field.path+'.'+i;if(!shape(row,field.fields.map(f=>f.path),prefix))continue;for(const child of field.fields)fieldCheck(row[child.path],child,prefix+'.'+child.path);if(seen.has(row.id))problem(prefix+'.id','Duplicate stable identity');seen.add(row.id);}
  }
  if(Array.isArray(input.sources)&&Array.isArray(input.fleet?.hosts)){const hosts=new Set(input.fleet.hosts.map(h=>h?.id));for(const [i,s] of input.sources.entries())if(object(s)){if(!hosts.has(s.hostId))problem('sources.'+i+'.hostId','Source must reference a configured host');if(s.kind==='execution-target'?s.path!=='':!validSourcePath(s.path))problem('sources.'+i+'.path',s.kind==='execution-target'?'Execution targets do not read arbitrary source paths':'This source requires an absolute log or job-feed path');}}
  if(input.history?.diskBudgetMiB<input.history?.maxMiB*2)problem('history.diskBudgetMiB','Disk budget must be at least twice the event payload budget');
  if(input.alerts?.thresholds?.sourceOfflineSeconds<=input.alerts?.thresholds?.sourceStaleSeconds)problem('alerts.thresholds.sourceOfflineSeconds','Offline threshold must exceed the stale threshold');
  const n=input.networking;if(object(n)){if(!['127.0.0.1','::1','localhost'].includes(n.listen)&&(!n.expectedTls||!n.publicOrigin))problem('networking','Network listening requires expected TLS and a fixed public origin');if(n.expectedTls&&n.publicOrigin&&typeof n.publicOrigin==='string'&&!n.publicOrigin.startsWith('https://'))problem('networking.publicOrigin','Expected TLS requires an HTTPS origin');}
 }
 if(errors.length){const failure=new Error('Invalid deployment configuration');failure.status=400;failure.errors=errors.slice(0,64);throw failure;}
 const result=structuredClone(input);if(result.networking.publicOrigin)result.networking.publicOrigin=new URL(result.networking.publicOrigin).origin;return result;
}
