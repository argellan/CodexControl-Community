// TEST_ONLY qualification runner guard. Imports never start a process or acquire a lease.
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {ControlError} from '../../lib/errors.mjs';
const fail=code=>{throw new ControlError(code);};
export function acquireQualificationLease(filename){
  let fd;
  try{fd=fs.openSync(filename,'wx',0o600);}catch{fail('CONFLICT');}
  const token=randomUUID();let released=false;
  try{fs.writeFileSync(fd,token);fs.fsyncSync(fd);}catch{fs.closeSync(fd);throw new ControlError('STORAGE_UNAVAILABLE');}
  function assertCurrent(){
    if(released)fail('CLOSED');
    try{const held=fs.fstatSync(fd),current=fs.lstatSync(filename);if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1||current.dev!==held.dev||current.ino!==held.ino||fs.readFileSync(filename,'utf8')!==token)fail('STALE_CONTEXT');}catch{fail('STALE_CONTEXT');}
  }
  return Object.freeze({assertCurrent,release(){if(released)return;try{assertCurrent();fs.unlinkSync(filename);}finally{released=true;fs.closeSync(fd);}}});
}
export async function runQualifiedDispatch({budget,readUsage,isStopped,acquireLease,dispatch}){
  if(!budget||typeof budget.observe!=='function'||typeof budget.unavailable!=='function'||[readUsage,isStopped,acquireLease,dispatch].some(fn=>typeof fn!=='function'))fail('INVALID_INPUT');
  let lease;
  const check=()=>{
    if(isStopped()!==false)fail('CONTROL_DISABLED');
    let sample;try{sample=readUsage();}catch{budget.unavailable();}
    budget.observe(sample);lease?.assertCurrent();
  };
  check(); // First quota/stop/deadline check precedes even lease acquisition.
  try{
    lease=acquireLease();
    if(!lease||typeof lease.assertCurrent!=='function'||typeof lease.release!=='function')fail('INVALID_INPUT');
    check(); // Re-read current usage after acquisition, on the spawn call stack.
    return await dispatch(check);
  }finally{lease?.release();}
}