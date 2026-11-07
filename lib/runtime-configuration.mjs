// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {readPrivateKeyFile} from './private-key-file.mjs';
import {DEFAULT_CONFIGURATION,validateConfiguration} from '../public/settings-schema.mjs';
const classes=new Set(['laptop','workstation','rack-server','raspberry-pi','edge','cloud','unknown']);
export function seedDeployment(runtime,{hostId,sessionRoot}={}){
 const c=structuredClone(DEFAULT_CONFIGURATION);c.general={...c.general,instanceName:runtime.instanceName||'Codex Control',organization:runtime.organization||'ARGELLAN',timezone:runtime.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',installationRole:runtime.upstream?'gateway':runtime.installationRole||(runtime.instanceId||runtime.hosts?.length?'hub':'standalone')};
 const hosts=[...(runtime.hosts||[])];if(hostId&&!hosts.some(h=>h.id===hostId))hosts.unshift({id:hostId,label:runtime.hostLabel||os.hostname(),deviceClass:runtime.deviceClass||'unknown'});
 c.fleet.hosts=hosts.map(h=>({id:h.id,label:h.label||h.id,deviceClass:classes.has(h.deviceClass)?h.deviceClass:'unknown',site:'',rack:'',zone:'',group:'',preferredAddress:h.preferredAddress||null,alternateAddresses:h.alternateAddresses||[]}));
 if(hostId&&sessionRoot)c.sources.push({id:'local-codex',hostId,kind:'codex-log',path:path.resolve(sessionRoot),intervalMs:1000,enabled:true});
 if(hostId&&runtime.jobFile)c.sources.push({id:'local-jobs',hostId,kind:'job-feed',path:path.resolve(runtime.jobFile),intervalMs:1000,enabled:true});
 c.networking={listen:runtime.listen||'127.0.0.1',port:runtime.port||4317,publicOrigin:runtime.publicOrigin||null,expectedTls:!!runtime.tls};return validateConfiguration(c);
}
export async function validateRuntimeConfiguration(configuration,runtime={}){
 const c=validateConfiguration(configuration);
 if(c.general.installationRole!==(runtime.upstream?'gateway':runtime.installationRole||'standalone'))throw Object.assign(new Error('Runtime role changes require the dedicated setup workflow'),{status:400});
 for(const h of c.fleet.hosts){const sources=c.sources.filter(s=>s.hostId===h.id);if(sources.filter(s=>s.kind==='codex-log').length>4||sources.filter(s=>s.kind==='job-feed').length>1)throw Object.assign(new Error('Each source host supports at most four Codex log roots and one structured job feed'),{status:400});}
 if(c.alerts.presentation.sound)throw Object.assign(new Error('Sound notifications are unavailable; choose visual presentation'),{status:400});
 if(c.networking.expectedTls){if(!runtime.tls?.cert||!runtime.tls?.key)throw Object.assign(new Error('Install TLS material with the setup tool before enabling TLS'),{status:400});let cert;try{cert=new crypto.X509Certificate(await fs.readFile(runtime.tls.cert));const key=crypto.createPrivateKey(await readPrivateKeyFile(runtime.tls.key));if(!cert.checkPrivateKey(key))throw new Error('Pair mismatch');}catch{throw Object.assign(new Error('Configured TLS certificate and private key are unavailable, unprotected or do not match'),{status:400});}if(c.networking.publicOrigin){const host=new URL(c.networking.publicOrigin).hostname.replace(/^\[|\]$/g,'');const match=/^[\d.:]+$/.test(host)?cert.checkIP(host):cert.checkHost(host);if(!match)throw Object.assign(new Error('Configured certificate does not cover the proposed hub name or address'),{status:400});}}
 return c;
}
export function runtimeWithDeployment(runtime,configuration){const c=validateConfiguration(configuration);return {...runtime,listen:c.networking.listen,port:c.networking.port,publicOrigin:c.networking.publicOrigin||undefined,tls:c.networking.expectedTls?runtime.tls:undefined,instanceName:c.general.instanceName,organization:c.general.organization};}
