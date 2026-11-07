// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Administration} from '../lib/administration.mjs';
import {validateAdministrationFormat} from '../lib/administration-format.mjs';
export async function verifyCurrentAdministration({directory,expectedSha256,expectedInstanceId}={}){
 if(!/^[a-f0-9]{64}$/.test(expectedSha256||'')||typeof expectedInstanceId!=='string'||!expectedInstanceId||expectedInstanceId.length>128)throw new Error('Exact current authority identity and checksum required');
 const result=await Administration.inspect({directory});validateAdministrationFormat(result.format);
 if(result.sha256!==expectedSha256)throw new Error('Current administration changed during recovery verification');
 if(result.instanceId!==expectedInstanceId)throw new Error('Administration instance identity mismatch');
 return {protocolVersion:1,status:'COMPATIBLE_CURRENT_AUTHORITY',...result};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const options={};for(const arg of process.argv.slice(2)){const match=/^--(directory|sha256|instance)=(.+)$/.exec(arg);if(!match||Object.hasOwn(options,match[1]))throw new Error('Use exact directory, sha256 and instance arguments');options[match[1]]=match[2];}
  const result=await verifyCurrentAdministration({directory:options.directory,expectedSha256:options.sha256,expectedInstanceId:options.instance});process.stdout.write(JSON.stringify(result)+'\n');
 }catch{process.stderr.write('Current administration compatibility verification failed; no state was initialized or repaired.\n');process.exitCode=1;}
}
