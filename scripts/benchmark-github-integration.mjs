// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// TEST_ONLY: synthetic in-memory HTTP responses; never contacts GitHub.
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {GitHubIntegration} from '../lib/github-integration.mjs';

const directory=await mkdtemp(path.join(os.tmpdir(),'cc-github-benchmark-'));
const configuration={sourceId:'synthetic',hostId:'synthetic',project:'Synthetic',repository:'example/synthetic',repositoryId:42,pullNumbers:[1],intervalMs:60000};
const head='a'.repeat(40),base='b'.repeat(40);let clock=Date.parse('2030-01-01T00:00:00Z');
const memoryBefore=process.memoryUsage(), json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json',etag:'"synthetic"'}});
const integration=new GitHubIntegration({file:path.join(directory,'metadata.sqlite'),configuration,now:()=>clock,tokenProvider:async()=>'github_pat_SYNTHETIC_000000000000',fetchImpl:async(url,options)=>{
  if(options.headers['If-None-Match'])return new Response(null,{status:304});
  const endpoint=new URL(url).pathname;
  if(endpoint.endsWith('/example/synthetic'))return json({id:42,full_name:'example/synthetic',private:true,archived:false});
  if(endpoint.endsWith('/pulls/1'))return json({id:1,number:1,state:'open',base:{repo:{id:42},sha:base},head:{repo:{id:42},sha:head}});
  if(endpoint.endsWith('/check-runs'))return json({total_count:50,check_runs:Array.from({length:50},(_,i)=>({id:i+1,head_sha:head,status:'completed',conclusion:'success'}))});
  if(endpoint.endsWith('/statuses'))return json(Array.from({length:50},(_,i)=>({id:i+1,state:'success'})));
  if(endpoint.endsWith('/actions/runs'))return json({total_count:50,workflow_runs:Array.from({length:50},(_,i)=>({id:i+1,repository:{id:42},head_sha:head,workflow_id:1,run_number:i+1,run_attempt:1,status:'completed',conclusion:'success'}))});
  if(endpoint.endsWith('/artifacts'))return json({total_count:1,artifacts:[{id:Number(endpoint.split('/').at(-2)),size_in_bytes:1024,expired:false}]});
  throw new Error('Unexpected synthetic endpoint');
}});
try {
  const cycles=[];
  for(let i=0;i<11;i++){
    const start=performance.now();let requests=0,responseBytes=0,result;
    do{result=await integration.poll();requests+=result.requests;responseBytes+=result.responseBytes||0;}while(result.state==='collecting');
    if(result.state!=='current')throw new Error('Synthetic collection incomplete');
    cycles.push({kind:i?'conditional':'initial',requests,responseBytes,elapsedMs:performance.now()-start});clock+=60001;
  }
  const reads=[],viewer={id:'synthetic',hostIds:null,projectIds:null},hosts=[{id:'synthetic'}];let after=0,count=0,serializedBytes=0,page;
  do{const start=performance.now();page=integration.read({viewer,hosts,after});const serialized=JSON.stringify(page);reads.push(performance.now()-start);serializedBytes+=Buffer.byteLength(serialized);count+=page.observations.length;after=page.nextCursor;}while(!page.caughtUp);
  const summary=values=>{const sorted=[...values].sort((a,b)=>a-b);return {p50Ms:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]};};
  console.log(JSON.stringify({testOnly:true,node:process.version,platform:process.platform,fixture:{pulls:1,checks:50,statuses:50,runs:50,artifactsPerRun:1,cycles:11},initial:cycles[0],conditional:{cycles:10,requests:cycles.slice(1).reduce((n,c)=>n+c.requests,0),responseBytes:cycles.slice(1).reduce((n,c)=>n+c.responseBytes,0),...summary(cycles.slice(1).map(c=>c.elapsedMs))},read:{pages:reads.length,observations:count,serializedBytes,...summary(reads)},memory:{rssBefore:memoryBefore.rss,rssAfter:process.memoryUsage().rss,peakRssKiB:process.resourceUsage().maxRSS},archive:page.archive,framePacing:'NOT_MEASURED_BY_THIS_BACKEND_BENCHMARK',liveNetwork:'NOT_RUN'},null,2));
} finally {integration.close();await rm(directory,{recursive:true,force:true});}
