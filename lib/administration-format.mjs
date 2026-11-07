// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// A recovery runtime must preserve this whole authority model, not project an old snapshot.
export const ADMINISTRATION_FORMAT=Object.freeze({readerVersion:2,writeVersion:2,readVersions:Object.freeze([1,2]),features:Object.freeze(['credential-generation','durable-enrollment-receipts','explicit-replacement','current-authority-recovery','mandatory-first-sign-in-password'])});

export function validateAdministrationFormat(value){
 if(!value||JSON.stringify(Object.keys(value).sort())!==JSON.stringify(['features','readVersions','readerVersion','writeVersion'])||value.readerVersion!==2||value.writeVersion!==2||!Array.isArray(value.readVersions)||JSON.stringify(value.readVersions)!=='[1,2]'||!Array.isArray(value.features)||JSON.stringify(value.features)!==JSON.stringify(ADMINISTRATION_FORMAT.features))throw new Error('Compatible administration reader and writer required');
 return value;
}
