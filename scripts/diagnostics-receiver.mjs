// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openSyntheticReceiver} from '../lib/diagnostics-telemetry.mjs';
import {exact} from '../public/diagnostics-schema.mjs';
export async function startLocalSyntheticReceiver(options){
 const configuration={port:0,...options};
 if(!exact(configuration,['directory','port'])||typeof configuration.directory!=='string'||!path.isAbsolute(configuration.directory)||configuration.directory.startsWith('\\\\')||configuration.directory.startsWith('//'))throw new Error('Use an absolute new local receiver directory');
 if(!Number.isSafeInteger(configuration.port)||configuration.port<0||configuration.port>65535)throw new Error('Use a valid loopback port');
 // Never reuse or remove an existing directory; no network request selects files.
 await fs.mkdir(configuration.directory,{mode:0o700});
 return openSyntheticReceiver(configuration);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const arguments_=process.argv.slice(2);let directory,port=0;const seen=new Set();
  for(const argument of arguments_){const key=argument.split('=')[0];if(seen.has(key))throw new Error('Duplicate option');seen.add(key);if(argument.startsWith('--directory='))directory=argument.slice(12);else if(argument.startsWith('--port=')&&/^\d+$/.test(argument.slice(7)))port=Number(argument.slice(7));else throw new Error('Unsupported option');}
  const receiver=await startLocalSyntheticReceiver({directory,port});
  console.log(JSON.stringify({mode:'LOCAL_SYNTHETIC_ONLY',listen:'127.0.0.1',port:receiver.port,path:'/v1/synthetic-reports',realReports:false}));
  let closing=false;const close=async()=>{if(closing)return;closing=true;await receiver.close();};process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
 }catch{console.error('Synthetic receiver failed. Use --directory=ABSOLUTE_NEW_LOCAL_DIRECTORY [--port=4319]; verify the new directory and available loopback port.');process.exitCode=1;}
}