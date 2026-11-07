// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
let previousCpu,previousAt,previousLoop;
// On-demand measurements of this observer only. No process-table/command-line
// enumeration or job attribution is inferred from a machine's resource totals.
export async function runtimeDiagnostics(journal,{diskBudgetMiB}={}){
 const now=performance.now(),cpu=process.cpuUsage(),loop=performance.eventLoopUtilization(),elapsed=previousAt===undefined?null:now-previousAt;
 const result={observedAt:new Date().toISOString(),scope:'observer process only',runtime:{node:process.version,platform:process.platform,pid:process.pid,uptimeSeconds:process.uptime(),rssBytes:process.memoryUsage().rss,heapUsedBytes:process.memoryUsage().heapUsed,cpuPercent:elapsed>0?(cpu.user+cpu.system-previousCpu.user-previousCpu.system)/1000/elapsed*100:null,eventLoopUtilization:previousLoop?performance.eventLoopUtilization(loop,previousLoop).utilization:null},journal:journal?journal.status():null,storage:null};
 previousCpu=cpu;previousAt=now;previousLoop=loop;
 if(journal){const sizes=await Promise.all(['','-wal','-shm'].map(async suffix=>{try{return (await fs.stat(journal.file+suffix)).size;}catch{return 0;}}));result.storage={databaseBytes:sizes[0],walBytes:sizes[1],sharedMemoryBytes:sizes[2],totalBytes:sizes.reduce((a,b)=>a+b,0),...(Number.isFinite(diskBudgetMiB)?{planningBudgetBytes:diskBudgetMiB*1048576,budgetExceeded:sizes.reduce((a,b)=>a+b,0)>diskBudgetMiB*1048576,budgetEnforcement:"advisory; event payload retention is enforced separately"}:{})};}
 return result;
}
