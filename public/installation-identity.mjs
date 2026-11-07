// Author: Bishop Crockett; Owner: Argellan.com; License: MIT; SPDX-License-Identifier: MIT
/** Full product name contract shared by authenticated identity and public-hint producers. */
export function installationName(value){
 if(typeof value!=='string'||!value.isWellFormed()||/[\x00-\x1f\x7f-\x9f]/.test(value))throw new TypeError('Display name must contain 1–120 visible characters');
 const trimmed=value.trim();
 if(!trimmed||[...trimmed].length>120)throw new TypeError('Display name must contain 1–120 visible characters');
 return trimmed;
}
