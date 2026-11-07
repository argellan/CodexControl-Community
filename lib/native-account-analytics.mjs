// Author: Bishop Crockett | Owner: Argellan.com | SPDX-License-Identifier: MIT
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
const fail=()=>{throw new Error('Invalid native account analytics');};
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v);
const text=v=>{if(typeof v!=='string'||!v||v.length>160||/[\x00-\x1f\x7f]/.test(v))fail();return v;};
const number=v=>{if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>Number.MAX_SAFE_INTEGER)fail();return v;};
const day=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)fail();return v;};
const rows=(v,max)=>{if(!Array.isArray(v)||v.length>max)fail();return v;};
const stamp=v=>{if(typeof v!=='string'||!Number.isFinite(Date.parse(v)))fail();return new Date(v).toISOString();};
const sha=v=>createHash('sha256').update(v).digest('hex');
const numericMap=v=>{if(!obj(v)||Object.keys(v).length>256)fail();return Object.fromEntries(Object.entries(v).map(([k,n])=>[text(k),number(n)]));};
// Keep measured values and category provenance, excluding private identifiers.
export function normalizeNativeDataset(kind,raw){
 if(!obj(raw)||raw.group_by!=='day')fail();
 const data=rows(raw.data,366).map(d=>{
  const date=day(d.date);
  if(kind==='usage')return {date,attribution:rows(d.attribution,10000).map(a=>({thread_source:text(a.thread_source),turn_trigger:text(a.turn_trigger),model:text(a.model),surface:text(a.surface),value:number(a.value)})),product_surface_usage_values:numericMap(d.product_surface_usage_values),models:rows(d.models??[],256).map(m=>({model:text(m.model),speed:text(m.speed),credits:number(m.credits)}))};
  if(kind==='skills'||kind==='plugins'){const key=kind==='skills'?'skill_usage_overviews':'plugin_usage_overviews';return {date,entries:rows(d[key],256).map(e=>({name:text(kind==='skills'?e.skill_name:e.plugin_name),label:text(e.display_name),count:number(e.invocation_counts)}))};}
  if(kind==='messages'){const allowed=['users','threads','turns','credits','uncached_text_input_tokens','cached_text_input_tokens','text_output_tokens','text_total_tokens'];const values=e=>Object.fromEntries(allowed.filter(k=>e[k]!==undefined).map(k=>[k,number(e[k])]));return {date,totals:values(d.totals),clients:rows(d.clients??[],256).map(e=>({client:text(e.client_id),...values(e)})),models:rows(d.models??[],256).map(e=>({model:text(e.model),...values(e)}))};}fail();
 });
 if(new Set(data.map(d=>d.date)).size!==data.length)fail();
 return {kind,collectedAt:stamp(raw.collectedAt||new Date().toISOString()),units:kind==='usage'?(['percent','credits'].includes(raw.units)?raw.units:fail()):'count',freshness:raw.data_freshness_ts?stamp(raw.data_freshness_ts):null,data};
}
export function encodeNativeAnalytics(datasets,{observedAt=new Date().toISOString()}={}){
 const body=Buffer.from(JSON.stringify({version:1,source:'codex-native-analytics',observedAt:stamp(observedAt),datasets}));
 if(body.length>2097152)fail();const data=gzipSync(body).toString('base64');if(data.length>98304)fail();
 return {digest:sha(body),observedAt:stamp(observedAt),encoding:'gzip-base64',data};
}
export function sanitizeNativeEnvelope(v){
 if(!obj(v)||Object.keys(v).some(k=>!['digest','observedAt','encoding','data'].includes(k))||!/^[a-f0-9]{64}$/.test(v.digest)||v.encoding!=='gzip-base64')fail();
 const result={digest:v.digest,observedAt:stamp(v.observedAt),encoding:v.encoding};
 if(Object.hasOwn(v,'data')){if(typeof v.data!=='string'||v.data.length>98304||!v.data.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(v.data))fail();result.data=v.data;decodeNativeAnalytics(result);}return result;
}
export function decodeNativeAnalytics(envelope){
 const body=gunzipSync(Buffer.from(envelope.data,'base64'),{maxOutputLength:2097152});if(sha(body)!==envelope.digest)fail();
 const value=JSON.parse(body);if(Object.keys(value).some(k=>!['version','source','observedAt','datasets'].includes(k))||value.version!==1||value.source!=='codex-native-analytics'||stamp(value.observedAt)!==envelope.observedAt||!obj(value.datasets)||Object.keys(value.datasets).some(k=>!['usage','skills','plugins','messages'].includes(k)))fail();
 // The canonical allowlisted shape is revalidated on ingestion/archive restore.
 for(const [kind,d] of Object.entries(value.datasets)){
  const raw={group_by:'day',collectedAt:d.collectedAt,units:d.units,data_freshness_ts:d.freshness,data:d.data?.map(row=>kind==='skills'||kind==='plugins'?{date:row.date,[kind==='skills'?'skill_usage_overviews':'plugin_usage_overviews']:row.entries.map(e=>({skill_name:e.name,plugin_name:e.name,display_name:e.label,invocation_counts:e.count}))}:kind==='messages'?{...row,clients:row.clients.map(e=>({...e,client_id:e.client}))}:row)};
  if(JSON.stringify(normalizeNativeDataset(kind,raw))!==JSON.stringify(d))fail();
 }return value;
}
export function nativeAnalyticsReference(envelope){if(!envelope)return null;const {data,...reference}=envelope;return reference;}
const routes=[['usage','usage/daily-token-usage-breakdown',{}],['skills','analytics/daily-skill-usage-metrics',{top_skill_limit:'10',workspace_user:'true'}],['plugins','analytics/daily-plugin-usage-metrics',{top_plugin_limit:'10',workspace_user:'true'}],['messages','analytics/daily-workspace-usage-counts',{workspace_user:'true'}]];
export class NativeAccountAnalytics {
 constructor({readAuth=()=>readFile(path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'auth.json'),'utf8'),fetchImpl=fetch,clock=Date.now}={}){this.readAuth=readAuth;this.fetchImpl=fetchImpl;this.clock=clock;this.next=0;this.value=null;this.identity=null;this.ack=null;this.stopped=false;}
 clear(){this.controller?.abort();this.value=null;this.identity=null;this.ack=null;this.next=0;}
 acknowledge(digest){if(this.value?.digest===digest)this.ack=digest;}
 snapshot(){return this.value?structuredClone(this.ack===this.value.digest?nativeAnalyticsReference(this.value):this.value):null;}
 async poll(account){
  if(this.stopped)return null;
  if(account?.type!=='chatgpt'||typeof account.email!=='string'){this.clear();return null;}
  // Clear immediately on account changes, even inside the five-minute cache.
  if(this.identity!==account.email){this.clear();this.identity=account.email;}
  if(this.clock()<this.next)return this.snapshot();this.next=this.clock()+300000;
  const identity=this.identity;this.controller=new AbortController();const timer=setTimeout(()=>this.controller?.abort(),20000);
  try{
   const authText=await this.readAuth(),auth=JSON.parse(authText),token=auth.tokens?.access_token,idToken=auth.tokens?.id_token;
   const claims=JSON.parse(Buffer.from(idToken?.split('.')[1]||'','base64url').toString('utf8'));
   if(claims.email!==identity||typeof token!=='string'||!token)throw new Error('Account mismatch');
   const end=new Date(this.clock()),start=new Date(this.clock()-29*86400000),query={start_date:start.toISOString().slice(0,10),end_date:end.toISOString().slice(0,10),group_by:'day'};
   const headers={Authorization:'Bearer '+token,Accept:'application/json','x-openai-codex-usage-categories':'1',...(auth.tokens.account_id?{'ChatGPT-Account-Id':auth.tokens.account_id}:{})};
   const results=await Promise.allSettled(routes.map(async([kind,route,extra])=>{
    const url=new URL('https://chatgpt.com/backend-api/wham/'+route);url.search=new URLSearchParams({...query,...extra});
    const response=await this.fetchImpl(url,{headers,method:'GET',redirect:'error',signal:this.controller.signal});
    if(!response.ok)throw Object.assign(new Error('Analytics request unavailable'),{denied:response.status===401||response.status===403});
    const chunks=[];let length=0;for await(const chunk of response.body){length+=chunk.length;if(length>4194304)throw new Error('Analytics response bound');chunks.push(chunk);}
    return [kind,normalizeNativeDataset(kind,JSON.parse(Buffer.concat(chunks).toString('utf8')))];
   }));
   if(this.stopped||this.identity!==identity)return null;if(await this.readAuth()!==authText){this.clear();return null;}
   if(results.some(r=>r.status==='rejected'&&r.reason.denied)){this.value=null;this.ack=null;return null;}
   const datasets=Object.fromEntries(results.filter(r=>r.status==='fulfilled').map(r=>r.value));
   // Failed datasets retain their own original source timestamp; never relabel stale data fresh.
   for(const [kind,d]of Object.entries(this.value?decodeNativeAnalytics(this.value).datasets:{}))if(!datasets[kind])datasets[kind]=d;
   if(results.some(r=>r.status==='fulfilled'))this.value=encodeNativeAnalytics(datasets,{observedAt:new Date(this.clock()).toISOString()});
  }catch{this.value=null;this.ack=null;}finally{clearTimeout(timer);this.controller=null;}
  return this.snapshot();
 }
 stop(){this.stopped=true;this.controller?.abort();}
}
export function readNativeAnalytics(db,{digest,accountKey,hostIds=[]}={}){
 if(!/^[a-f0-9]{64}$/.test(digest||'')||!/^[a-f0-9]{64}$/.test(accountKey||'')||!hostIds.length)return null;
 const sql=`SELECT payload FROM account_usage_observations WHERE account_identity=? AND json_extract(payload,'$.nativeAnalytics.digest')=? AND json_extract(payload,'$.nativeAnalytics.data') IS NOT NULL AND host_id IN (${hostIds.map(()=>'?').join(',')}) ORDER BY sequence DESC LIMIT 1`;
 const row=db.prepare(sql).get(accountKey,digest,...hostIds);if(!row)return null;return decodeNativeAnalytics(JSON.parse(row.payload).nativeAnalytics);
}
