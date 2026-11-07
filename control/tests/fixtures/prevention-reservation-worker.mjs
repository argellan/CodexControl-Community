import {parentPort,workerData} from 'node:worker_threads';
import {LocalOwnerBoundary} from '../../broker/local-owner.mjs';
import {PreventionLedger} from '../../prevention/ledger.mjs';
let ledger;
try{
 const owner=LocalOwnerBoundary.open({directory:workerData.directory,account:workerData.account});
 ledger=PreventionLedger.open({directory:workerData.directory,owner,now:()=>workerData.now,maxTelemetryAgeMs:1000});
 parentPort.postMessage({ready:true});
 Atomics.wait(new Int32Array(workerData.gate),0,0,10000);
 try{ledger.reserve(workerData.taskId,workerData.operationId,60);parentPort.postMessage({admitted:true});}
 catch(error){parentPort.postMessage({admitted:false,code:error.code??'CONTROL_ERROR'});}
}finally{ledger?.close();}