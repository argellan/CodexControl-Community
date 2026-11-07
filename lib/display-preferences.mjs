// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {DEFAULT_PREFERENCES,normalizePreferences} from '../public/ui-model.mjs';

export function validateDisplayPreferences(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(DEFAULT_PREFERENCES,k)))throw Object.assign(new Error('Display settings only'),{status:400});
 return value;
}
export class DisplayPreferences {
 constructor(directory,profile='local-viewer'){this.directory=directory;this.file=path.join(directory,crypto.createHash('sha256').update(profile).digest('hex')+'.json');this.queue=Promise.resolve();}
 async read(){try{const value=JSON.parse(await fs.readFile(this.file,'utf8'));return {exists:true,revision:value.revision,preferences:normalizePreferences(value.preferences)};}catch(error){if(error.code==='ENOENT')return {exists:false,revision:0,preferences:null};throw error;}}
 write(value){validateDisplayPreferences(value);const job=this.queue.then(async()=>{
  const previous=await this.read(),result={exists:true,revision:previous.revision+1,preferences:normalizePreferences({...previous.preferences,...value})};
  await fs.mkdir(this.directory,{recursive:true,mode:0o700});const temporary=this.file+'.'+crypto.randomBytes(6).toString('hex')+'.tmp',file=await fs.open(temporary,'wx',0o600);
  try{await file.writeFile(JSON.stringify(result));await file.sync();}finally{await file.close();}await fs.rename(temporary,this.file);
  if(process.platform!=='win32'){const directory=await fs.open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}}
  return result;
 });this.queue=job.catch(()=>{});return job;}
}
