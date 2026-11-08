// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// These are projections of already-authorized response records. They do not
// infer provider billing, quota consumption, causation or complete collection.

export const USAGE_PERIODS=Object.freeze({'1h':3600000,'6h':21600000,'24h':86400000,'7d':604800000});
export const USAGE_DIMENSIONS=Object.freeze(['project','worker','host','model']);
const responseColumns=Object.freeze(['sampleKey','hostId','sessionId','project','sourceId','sourceRecordKey','sourceOffset','sourceKind','sourceVersion','turnId','responseId','sourceAt','receivedAt','timeBasis','accountAttribution','configuredModel','configuredEffort','input','cached','cacheWrite','output','reasoning','total','reportedMask','providerReportedMask','synthesizedMask']);
const wireValue=value=>value===null||typeof value==='string'||Number.isSafeInteger(value)&&value>=0;
export function encodeUsageRecords(records){
 if(!Array.isArray(records)||records.length>5000)throw new Error('Invalid response record projection');
 return {schema:'usage-response-columns-v1',columns:[...responseColumns],rows:records.map(row=>{
  if(!row||typeof row!=='object'||Object.keys(row).length!==responseColumns.length||responseColumns.some(key=>!Object.hasOwn(row,key)||!wireValue(row[key])))throw new Error('Invalid response record projection');
  return responseColumns.map(key=>row[key]);
 })};
}
export function decodeUsageRecords(value){
 if(!value||value.schema!=='usage-response-columns-v1'||!Array.isArray(value.columns)||value.columns.length!==responseColumns.length||responseColumns.some((key,index)=>value.columns[index]!==key)||!Array.isArray(value.rows)||value.rows.length>5000)throw new Error('Invalid response record projection');
 return value.rows.map(row=>{
  if(!Array.isArray(row)||row.length!==responseColumns.length||row.some(value=>!wireValue(value)))throw new Error('Invalid response record projection');
  return Object.fromEntries(responseColumns.map((key,index)=>[key,row[index]]));
 });
}
const integer=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const instant=value=>{const number=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(number)?number:null;};
const safeText=value=>typeof value==='string'&&value.length?value:'';
const safeAdd=(a,b)=>Number.isSafeInteger(a)&&Number.isSafeInteger(b)&&Number.isSafeInteger(a+b)?a+b:null;

export function responseMeasure(row){
 const input=integer(row?.input),cached=integer(row?.cached),output=integer(row?.output),reasoning=integer(row?.reasoning),reportedTotal=integer(row?.total);
 const cacheComparable=input!==null&&cached!==null&&cached<=input;
 const reasoningComparable=output!==null&&reasoning!==null&&reasoning<=output;
 const computed=input===null||output===null?null:safeAdd(input,output);
 const total=computed!==null&&reportedTotal!==null&&computed===reportedTotal?computed:null;
 return {input,cached:cacheComparable?cached:null,newInput:cacheComparable?input-cached:null,output,reasoning:reasoningComparable?reasoning:null,total,
  cacheInvalid:input!==null&&cached!==null&&cached>input,reasoningInvalid:output!==null&&reasoning!==null&&reasoning>output,
  totalMismatch:computed!==null&&reportedTotal!==null&&computed!==reportedTotal};
}

function strictSum(rows,field){
 if(!rows.length)return null;let value=0;
 for(const row of rows){const part=row.measure[field];if(part===null)return null;value=safeAdd(value,part);if(value===null)return null;}
 return value;
}
function groupIdentity(row,dimension){
 if(dimension==='worker')return JSON.stringify([safeText(row.hostId)||null,safeText(row.sessionId)||null]);
 if(dimension==='host')return JSON.stringify([safeText(row.hostId)||null]);
 if(dimension==='model')return JSON.stringify([safeText(row.configuredModel)||null]);
 return JSON.stringify([safeText(row.project)||null]);
}
function groupLabel(row,dimension){
 if(dimension==='worker')return safeText(row.sessionId)||'Unknown worker';
 if(dimension==='host')return safeText(row.hostId)||'Unknown machine';
 if(dimension==='model')return safeText(row.configuredModel)||'Unknown configured model';
 return safeText(row.project)||'Unknown project';
}
function isUnknown(row,dimension){
 return dimension==='worker'?!safeText(row.hostId)||!safeText(row.sessionId):dimension==='host'?!safeText(row.hostId):dimension==='model'?!safeText(row.configuredModel):!safeText(row.project);
}

// A record can use receipt time when source time is absent. A source clock
// later than its receipt is excluded from the temporal projection, not moved.
function temporalRecord(row,from,to){
 const received=instant(row?.receivedAt),source=instant(row?.sourceAt),basis=row?.timeBasis;
 if(received===null||!['source','receipt'].includes(basis)||basis==='source'&&source===null||basis==='receipt'&&source!==null)return null;
 const at=basis==='source'?source:received;
 if(at<from||at>to||basis==='source'&&source>received)return null;
 return {...row,at,measure:responseMeasure(row)};
}

export function analyzeUsage(report,{dimension='project',contributor=null,interval=null,bucketCount=24}={}){
 const from=instant(report?.scope?.from),to=instant(report?.scope?.to),count=Number.isSafeInteger(bucketCount)&&bucketCount>=2&&bucketCount<=48?bucketCount:24;
 if(from===null||to===null||to<=from||!Array.isArray(report?.responses?.records))return {status:'unavailable',reason:'No scoped response record projection is available.',records:[],buckets:[],groups:[]};
 dimension=USAGE_DIMENSIONS.includes(dimension)?dimension:'project';
 const supplied=report.responses.records,all=[],unplaced=[];for(const row of supplied){const timed=temporalRecord(row,from,to);if(timed)all.push(timed);else unplaced.push({...row,at:null,measure:responseMeasure(row),timeIssue:true});}const excludedTime=unplaced.length;
 const duration=(to-from)/count,indexFor=at=>Math.min(count-1,Math.floor((at-from)/duration));
 const chosen=Number.isSafeInteger(interval)&&interval>=0&&interval<count?interval:null;
 // Contributor identity and share stay anchored to the selected historical
 // period, so choosing an empty interval cannot silently discard a filter.
 const forGroups=all,map=new Map();
 for(const row of forGroups){const key=groupIdentity(row,dimension);let group=map.get(key);if(!group){group={key,label:groupLabel(row,dimension),unknown:isUnknown(row,dimension),count:0,comparable:0,total:0,overflow:false};map.set(key,group);}group.count++;if(row.measure.total!==null){group.comparable++;const next=safeAdd(group.total,row.measure.total);if(next===null)group.overflow=true;else group.total=next;}}
 const groups=[...map.values()].map(group=>({...group,total:group.comparable&&!group.overflow?group.total:null})).sort((a,b)=>(b.total??-1)-(a.total??-1)||b.count-a.count||a.label.localeCompare(b.label));
 let denominator=0,overflow=false;for(const group of groups){if(group.overflow){overflow=true;break;}if(group.total!==null){denominator=safeAdd(denominator,group.total);if(denominator===null){overflow=true;break;}}}
 const keep=groups.slice(0,8),unknown=groups.find(group=>group.unknown);if(unknown&&!keep.includes(unknown)){if(keep.length===8)keep.pop();keep.push(unknown);}
 const shownKeys=new Set(keep.map(group=>group.key)),other=groups.filter(group=>!shownKeys.has(group.key));
 const display=keep.map(group=>({...group,share:!overflow&&denominator>0&&group.total!==null?group.total/denominator:null,members:[group.key]}));
 if(other.length){let total=0,valid=0,failed=false;for(const group of other){if(group.total!==null){valid++;total=safeAdd(total,group.total);if(total===null)failed=true;}}display.push({key:'__other__',label:'Other',unknown:false,count:other.reduce((n,g)=>n+g.count,0),comparable:other.reduce((n,g)=>n+g.comparable,0),total:valid&&!failed?total:null,share:valid&&!failed&&!overflow&&denominator>0?total/denominator:null,members:other.map(group=>group.key)});}
 const selected=display.find(group=>group.key===contributor),memberSet=selected?new Set(selected.members):null;
 const plotted=memberSet?all.filter(row=>memberSet.has(groupIdentity(row,dimension))):all;
 const buckets=Array.from({length:count},(_,index)=>({index,from:from+duration*index,to:index===count-1?to:from+duration*(index+1),rows:[]}));
 for(const row of plotted)buckets[indexFor(row.at)].rows.push(row);
 for(const bucket of buckets){bucket.count=bucket.rows.length;bucket.newInput=strictSum(bucket.rows,'newInput');bucket.cached=strictSum(bucket.rows,'cached');bucket.output=strictSum(bucket.rows,'output');bucket.total=strictSum(bucket.rows,'total');bucket.receiptFallback=bucket.rows.filter(row=>row.timeBasis==='receipt').length;}
 const unplacedInScope=memberSet?unplaced.filter(row=>memberSet.has(groupIdentity(row,dimension))):unplaced;
 const records=(chosen===null?[...plotted,...unplacedInScope]:buckets[chosen].rows).slice().sort((a,b)=>(b.at??-1)-(a.at??-1)||String(a.sampleKey).localeCompare(String(b.sampleKey)));
 const previous=chosen!==null&&chosen>0?buckets[chosen-1]:null,current=chosen===null?null:buckets[chosen];let comparison=null;
 if(current&&previous){const a=current.total,b=previous.total;comparison=a===null||b===null?{state:'unavailable'}:b===0?{state:'zero-baseline',current:a,previous:b}:{state:'comparable',current:a,previous:b,change:(a-b)/b};}
 return {status:all.length?'available':'unavailable',from,to,dimension,contributor:selected?.key??null,interval:chosen,buckets,groups:display,records,comparison,
  coverage:{...report.coverage,responseRecords:supplied.length,temporalRecords:all.length,excludedTime,unknownAccount:all.filter(row=>row.accountAttribution!=='linked').length,receiptFallback:all.filter(row=>row.timeBasis==='receipt').length,comparableContributions:forGroups.filter(row=>row.measure.total!==null).length,excludedContributions:forGroups.filter(row=>row.measure.total===null).length,denominator:overflow?null:denominator,cacheInvalid:all.filter(row=>row.measure.cacheInvalid).length,reasoningInvalid:all.filter(row=>row.measure.reasoningInvalid).length,totalMismatch:all.filter(row=>row.measure.totalMismatch).length}};
}
