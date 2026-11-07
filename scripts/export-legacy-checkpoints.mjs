#!/usr/bin/env node
// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
// Explicit rollback aid: read an existing journal without changing it and write
// bounded observer0.5 checkpoints to a NEW private directory. Never removes data.
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export async function exportLegacyCheckpoints(journalFile,outputDirectory){
 const source=path.resolve(journalFile),output=path.resolve(outputDirectory);
 if(!(await fs.stat(source)).isFile())throw new Error('Existing history.sqlite required');
 await fs.mkdir(output,{mode:0o700}); // fails instead of overwriting any directory
 const db=new DatabaseSync(source,{readOnly:true}),exports=[];
 try{for(const row of db.prepare('SELECT host_id,payload FROM host_state').iterate()){
  if(!/^[-a-z0-9]{1,64}$/.test(row.host_id))continue;
  const metadata=JSON.parse(row.payload);if(metadata.host||!metadata.id)continue; // local hub state has a different contract
  const events=db.prepare('SELECT payload FROM events WHERE host_id=? ORDER BY sequence DESC LIMIT 12000').all(row.host_id).map(r=>JSON.parse(r.payload)).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  const file=row.host_id+'.json';await fs.writeFile(path.join(output,file),JSON.stringify({...metadata,events}),{mode:0o600,flag:'wx'});exports.push({hostId:row.host_id,records:events.length,file});
 }}finally{db.close();}
 return {output,classification:'bounded rollback checkpoints; original journal preserved',hosts:exports};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==4)throw new Error('Use: node scripts/export-legacy-checkpoints.mjs EXISTING_HISTORY_SQLITE NEW_OUTPUT_DIRECTORY');
 console.log(JSON.stringify(await exportLegacyCheckpoints(process.argv[2],process.argv[3])));
}
