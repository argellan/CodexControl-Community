// TEST_ONLY qualification admission. No provider, filesystem, timer or network effects.
import {ControlError} from '../../lib/errors.mjs';
import {strictRecord,integer,deepFreeze,enumValue} from '../../lib/privacy.mjs';
const stages=['PREPARE','LAUNCH_CREATE','TURN_STEER_INTERRUPT','STOP_RELAUNCH_RESUME','FOLLOWUP'];
export function createNativeQualificationBudget({now=Date.now,startedAtMs=Date.now(),durationMs=600000,maxAgeMs=90000,initialBaseline=null,initialResetAt=null,quotaPoints=1}={}){
  if(typeof now!=='function')throw new ControlError('INVALID_INPUT');integer(startedAtMs);integer(durationMs,1,2700000);integer(quotaPoints,1,5);integer(maxAgeMs,1,90000);
  if((initialBaseline===null)!==(initialResetAt===null)||initialBaseline!==null&&(!Number.isFinite(initialBaseline)||initialBaseline<0||initialBaseline>100))throw new ControlError('INVALID_INPUT');if(initialResetAt!==null)integer(initialResetAt,1);
  let baseline=initialBaseline,reset=initialResetAt,reason=null,lastRemaining=initialBaseline;
  const stop=why=>{reason??=why;throw new ControlError('CONTROL_DISABLED');};
  return Object.freeze({
    observe(sample){
      if(reason)stop(reason);
      const at=now();if(!Number.isSafeInteger(at)||at<startedAtMs)stop('CLOCK_INVALID');
      if(at>=startedAtMs+durationMs)stop('DURATION_BOUND');
      try{strictRecord(sample,['stage','remaining','resetAt','observedAtMs']);enumValue(sample.stage,stages);integer(sample.observedAtMs);integer(sample.resetAt,1);
        if(typeof sample.remaining!=='number'||!Number.isFinite(sample.remaining)||Object.is(sample.remaining,-0)||sample.remaining<0||sample.remaining>100)stop('INVALID_USAGE');
      }catch{stop('INVALID_USAGE');}
      if(sample.observedAtMs>at||at-sample.observedAtMs>maxAgeMs)stop('STALE_USAGE');
      if(sample.resetAt*1000<=at)stop('RESET_INVALID');
      baseline??=sample.remaining;reset??=sample.resetAt;
      if(sample.resetAt!==reset)stop('RESET_CHANGED');if(lastRemaining!==null&&sample.remaining>lastRemaining)stop('REPLENISHMENT');lastRemaining=sample.remaining;if(sample.remaining<5)stop('BELOW_FLOOR');if(sample.remaining<=baseline-quotaPoints)stop('QUOTA_BOUND');
      return deepFreeze({stage:sample.stage,baselineRemaining:baseline,remaining:sample.remaining,resetAt:reset});
    },
    unavailable(){stop('USAGE_UNAVAILABLE');},
    status(){return deepFreeze({stopped:reason!==null,reason,baselineRemaining:baseline,resetAt:reset,deadlineAtMs:startedAtMs+durationMs,quotaPoints});}
  });
}
