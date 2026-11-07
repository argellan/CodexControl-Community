#!/usr/bin/env node
// Author: Bishop Crockett; Owner: Argellan.com; License: MIT; SPDX-License-Identifier: MIT
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {planInstallation} from '../lib/platform-installation.mjs';

export function setupApplication(args=process.argv.slice(2)){
 const aliases={'root':'root','data-dir':'dataDirectory','executable':'executable','platform':'platform','role':'role','port':'port'},options={};
 for(const argument of args){if(argument==='--discovery'){options.discovery=true;continue;}if(argument==='--test-only'){continue;}const match=/^--([a-z-]+)=(.+)$/.exec(argument);if(!match||!Object.hasOwn(aliases,match[1])||Object.hasOwn(options,aliases[match[1]]))throw new Error('Use --root=ABSOLUTE --data-dir=LOCAL_ABSOLUTE --executable=NODE_PATH [--platform=win32|darwin|linux] [--role=standalone|hub|node] [--port=4317] [--discovery]; planning only');options[aliases[match[1]]]=match[1]==='port'?Number(match[2]):match[2];}
 return planInstallation(options);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{console.log(JSON.stringify(setupApplication(),null,2));}catch(error){console.error(JSON.stringify({status:'FAILED_NOT_APPLIED',error:error.message}));process.exitCode=1;}}
