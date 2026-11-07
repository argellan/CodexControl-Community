// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// Shared scheduling state only: callers retain ownership of requests, commits and
// timers. Monotonic time schedules attempts; wall time interprets HTTP dates.
export function retryAfterDelay(error,{now=Date.now(),maxMs=60000}={}){
 if(![429,503].includes(error?.status)||typeof error.retryAfter!=='string'||error.retryAfter.length>128)return 0;
 const value=error.retryAfter.trim();let delay;
 if(/^\d+$/.test(value))delay=Number(value)*1000;
 else if(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value))delay=Date.parse(value)-now;
 else return 0;
 return Number.isNaN(delay)?0:Math.max(0,Math.min(maxMs,delay));
}

export class RetryPolicy {
 constructor({intervalMs=1000,maxMs=60000,clock=()=>performance.now(),wallClock=Date.now,random=Math.random}={}){
  this.intervalMs=Math.max(250,Math.min(60000,Number.isFinite(intervalMs)?Math.round(intervalMs):1000));
  this.maxMs=Math.max(this.intervalMs,Math.min(60000,Number.isFinite(maxMs)?Math.round(maxMs):60000));
  this.clock=clock;this.wallClock=wallClock;this.random=random;this.failures=0;this.inFlight=false;this.nextAt=0;
 }
 remaining(){return Math.max(0,Math.min(this.maxMs,this.nextAt-this.clock()));}
 begin(){if(this.inFlight||this.remaining()>0)return false;this.inFlight=true;this.startedAt=this.clock();return true;}
 succeed({cadence=false}={}){this.inFlight=false;this.failures=0;const now=this.clock();this.nextAt=cadence&&Number.isFinite(this.startedAt)?Math.max(now+Math.min(250,this.intervalMs),this.startedAt+this.intervalMs):now+this.intervalMs;return this.remaining();}
 fail(error){
  this.inFlight=false;this.failures=Math.min(16,this.failures+1);
  const reading=this.random(),jitter=Number.isFinite(reading)?Math.max(0,Math.min(1,reading)):.5;
  const ceiling=Math.min(this.maxMs,this.intervalMs*2**this.failures);
  const delay=Math.max(this.intervalMs,Math.round(ceiling*(.75+.25*jitter)),retryAfterDelay(error,{now:this.wallClock(),maxMs:this.maxMs}));
  this.nextAt=this.clock()+delay;return delay;
 }
}
