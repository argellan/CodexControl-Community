// TEST_ONLY abrupt-publication fixture. It exits only its own disposable child process.
import fs from 'node:fs/promises';
import path from 'node:path';
import {recoverApplication} from '../../lib/forward-recovery.mjs';
const [instanceDirectory,appDirectory,phase]=process.argv.slice(2),pointer=path.join(instanceDirectory,'installation.json'),rename=fs.rename;
if(!['before','after'].includes(phase))throw new Error('TEST_ONLY crash phase required');
fs.rename=async(a,b)=>{if(b===pointer){if(phase==='before')process.exit(86);await rename(a,b);process.exit(87);}return rename(a,b);};
await recoverApplication({instanceDirectory,appDirectory});throw new Error('TEST_ONLY crash hook was not reached');
