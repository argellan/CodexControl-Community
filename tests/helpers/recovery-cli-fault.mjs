// TEST_ONLY CLI lost-publication acknowledgement fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const [instance,target]=process.argv.slice(2),script=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../scripts/setup-instance.mjs'),rename=fs.rename;
fs.rename=async(a,b)=>{await rename(a,b);if(b===path.join(instance,'installation.json'))throw Object.assign(new Error('TEST_ONLY lost acknowledgement'),{code:'EIO'});};
process.argv=[process.execPath,script,'--instance-dir='+instance,'--recover-app='+target];await import(pathToFileURL(script));
