// Authority decisions must go through ControlAuthority, never an observer role.
export {ControlAuthority,assertionBody} from './authority.mjs';
export {validateControlGrant} from '../contracts/capabilities.mjs';
