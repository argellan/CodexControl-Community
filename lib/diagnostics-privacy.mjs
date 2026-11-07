// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import {LIMITS, DIAGNOSTICS_SCHEMA, sanitizedEvent, validLocalEvent, localExport, exact} from '../public/diagnostics-schema.mjs';

export class LocalDiagnostics {
  #events=[]; #pending=null; #dirty=false; #closed=false; #window=0; #admitted=0; #storageAvailable=true; #retention=null; #observer=null;
  constructor(directory, now) {this.directory=directory;this.now=now;}
  static async open({directory,now=Date.now}) {
    const d=new LocalDiagnostics(directory,now);
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    const file=path.join(directory,'diagnostics.json');
    try {
      if((await fs.stat(file)).size<=LIMITS.localBytes) {
        const saved=JSON.parse(await fs.readFile(file,'utf8'));
        if(exact(saved,['schemaVersion','applicationVersion','events']) && saved.schemaVersion===DIAGNOSTICS_SCHEMA && Array.isArray(saved.events) && saved.events.length<=LIMITS.events && saved.events.every(validLocalEvent)) d.#events=saved.events;
      }
    } catch(error) {if(error.code!=='ENOENT') d.#storageAvailable=false;}
    let unclean=false;
    try {unclean=(await fs.readFile(path.join(directory,'run-state'),'utf8'))==='running';}catch{}
    await fs.writeFile(path.join(directory,'run-state'),'running',{mode:0o600});
    d.#prune();
    if(unclean) await d.capture({kind:'unclean-shutdown',category:'unclean-shutdown',site:'runtime:startup'});
    await d.flush();
    d.#retention=setInterval(()=>{d.#prune();if(d.#dirty)void d.flush();},3600000);d.#retention.unref();
    return d;
  }
  #prune() {
    const hour=Math.floor(this.now()/3600000);
    const count=this.#events.length;
    this.#events=this.#events.filter(e=>e.hour<=hour && (hour-e.hour)*3600000<LIMITS.localAgeMs).slice(-LIMITS.events);
    if(this.#events.length!==count)this.#dirty=true;
  }
  observe(observer) {if(this.#observer)throw new Error("Diagnostic observer already installed");this.#observer=observer;return ()=>{if(this.#observer===observer)this.#observer=null;};}
  capture(input) {
    if(this.#closed)return Promise.resolve(false);
    const second=Math.floor(this.now()/1000);
    if(second!==this.#window){this.#window=second;this.#admitted=0;}
    if(this.#admitted++>=20)return Promise.resolve(false);
    this.#prune();const event=sanitizedEvent(input,this.now());this.#events.push(event);try{this.#observer?.(event);}catch{}this.#events=this.#events.slice(-LIMITS.events);this.#dirty=true;
    return this.flush().then(()=>true);
  }
  flush() {
    if(this.#pending)return this.#pending;
    this.#pending=(async()=>{
      // One pending flush, bounded ring and no promise chain per captured event.
      while(this.#dirty){this.#dirty=false;const text=this.preview();
        try {const file=path.join(this.directory,'diagnostics.json'),temporary=file+'.pending';await fs.writeFile(temporary,text,{mode:0o600});await fs.rename(temporary,file);this.#storageAvailable=true;}
        catch {this.#storageAvailable=false;break;}
      }
    })().finally(()=>{this.#pending=null;});return this.#pending;
  }
  preview() {this.#prune();return localExport(this.#events);}
  status() {this.#prune();return {events:this.#events.length,storageAvailable:this.#storageAvailable,sharing:false,uncleanShutdownMeaning:'Previous run did not record a clean close; cause unknown; detection incomplete'};}
  async close() {this.#closed=true;this.#observer=null;clearInterval(this.#retention);this.#prune();await this.flush();await fs.writeFile(path.join(this.directory,'run-state'),'clean',{mode:0o600});}
}