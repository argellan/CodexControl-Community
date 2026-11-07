#!/usr/bin/env node
// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import {runtimeDigest,validatePerformanceEvidence} from './performance-gate.mjs';
import {ADMINISTRATION_FORMAT} from '../lib/administration-format.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
// These paths still require explicit manifest inclusion and human publication review.
const documentationMedia=new Set(['docs/images/overview.png','docs/images/replay.png','docs/images/export-preview.png','docs/media/walkthrough.mp4']);
function validateDocumentationMedia(name,bytes){
 if(!documentationMedia.has(name))return;
 const valid=name.endsWith('.png')?bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):bytes.length>=12&&bytes.subarray(4,8).toString('ascii')==='ftyp';
 if(!valid)throw new Error('Invalid documentation media signature');
}
export function validateReleasePath(value){if(typeof value!=='string'||!value||value.includes('\\')||path.posix.isAbsolute(value)||value.split('/').some(p=>!p||p==='.'||p==='..')||/^[a-z]:/i.test(value))throw new Error('Invalid release path');if(value.split('/').some(p=>/^(?:\.local|\.git|\.codex|node_modules|logs?|backups?|enrollment|researchcache|research|validation|data|history|sessions|secrets|credentials|snapshots)$/i.test(p))||/\.(?:sqlite(?:-wal|-shm)?|db(?:-wal|-shm)?|outbox|jsonl|pem|key|crt|cer|csr|pfx|p12|log|zip|tar|tgz|gz|7z|bak|backup|jpg)$/i.test(value)||/install-hp|viewer-access\.txt|collector\.json$|hub\.json$/i.test(value))throw new Error('Forbidden operational release path');if(/\.(?:mp4|png)$/i.test(value)&&!documentationMedia.has(value))throw new Error('Forbidden operational release path');return value;}
export function scanPublicContent(name,content){const findings=[];const text=String(content);if(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text))findings.push('private-key material');if(/(?:"token"|"tokenHash"|"password"|"secret")\s*:\s*"[^"\r\n]+"/i.test(text))findings.push('literal credential field');if(/Bearer\s+[A-Za-z0-9_=-]{24,}/.test(text)||/\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,})\b/.test(text))findings.push('literal bearer/provider credential');if(/[A-Z]:[\\/]+Users[\\/]+[^\\/\s]+|(?:^|[\s\x22\x27\x60=>(])\/(?:Users|home)\/[^/\s\x22\x27\x60<>]+/i.test(text))findings.push('private user path');for(const address of text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)||[]){const [a,b]=address.split('.').map(Number);if(a===10||a===192&&b===168||a===172&&b>=16&&b<=31){findings.push('private network address');break;}}if(/\b(?:gea-s-\d+|bv-(?:edge|exec|pi)-[a-z0-9-]+)\b/i.test(text))findings.push('private machine identity');return findings.map(reason=>({path:name,reason}));}
async function regularSource(root,relative){validateReleasePath(relative);const absolute=path.resolve(root,...relative.split('/'));if(!absolute.startsWith(path.resolve(root)+path.sep))throw new Error('Source escapes candidate root');let current=path.resolve(root);for(const part of relative.split('/')){current=path.join(current,part);const stat=await fs.lstat(current);if(stat.isSymbolicLink())throw new Error('Release source symlinks are forbidden');}const stat=await fs.stat(absolute);if(!stat.isFile()||stat.size>8388608)throw new Error('Release source is not a bounded regular file');return fs.readFile(absolute);}
// Distribution aliases must not silently override newer public source documents.
// These paths are inside the selected source root, never an outer private checkpoint.
export async function validateMappedReleaseDocuments(root,documents){
 const pairs=[['release/README.md','README.md'],['release/STATUS.md','RELEASE_STATUS.md'],['release/UPDATE.md','UPDATE.md'],['release/CHECKPOINT.md','docs/CHECKPOINT.md'],['release/SUPPORT_MATRIX.md','SUPPORT_MATRIX.md'],['release/T3_CARRYOVER.md','T3_CARRYOVER.md']];
 for(const [source,target] of pairs){
  if(!Object.hasOwn(documents,source))continue;
  if(documents[source]!==target)throw new Error('Unexpected public document mapping: '+source);
  const [mapped,canonical]=await Promise.all([regularSource(root,source),regularSource(root,target)]);
  if(!mapped.equals(canonical))throw new Error('Mapped public document drift: '+source+' / '+target);
 }
 if(Object.hasOwn(documents,'release/STATUS.md')){
  const build=(await regularSource(root,'public/build-info.mjs')).toString('utf8');
  const version=build.match(/export\s+const\s+APPLICATION_VERSION\s*=\s*['"]([^'"]+)['"]/),label=build.match(/export\s+const\s+APPLICATION_LABEL\s*=\s*['"]([^'"]+)['"]/);
  const status=(await regularSource(root,'RELEASE_STATUS.md')).toString('utf8').match(/^Version\s+(\S+)\s/m);
  if(!version||!label||!status||version[1]!==label[1]||version[1]!==status[1])throw new Error('Application and release status versions differ');
 }
}
export async function buildCandidate({sourceRoot=ROOT,destination,manifest,finalRuntime=false,performanceEvidence}={}){
 const root=path.resolve(sourceRoot);if(!destination||!path.isAbsolute(destination))throw new Error('Explicit absolute candidate destination required');const output=path.resolve(destination);if(output===root||root.startsWith(output+path.sep))throw new Error('Candidate destination cannot replace or contain the source');try{await fs.lstat(output);throw new Error('Candidate destination already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
 const sourceManifest=manifest||JSON.parse((await regularSource(root,'release/runtime-files.json')).toString('utf8'));if(sourceManifest.schemaVersion!==1||!Array.isArray(sourceManifest.runtime)||!Array.isArray(sourceManifest.support)||!sourceManifest.documents||typeof sourceManifest.documents!=='object')throw new Error('Invalid explicit release allowlist');
 const entries=[...sourceManifest.runtime,...sourceManifest.support].map(source=>({source,target:source})).concat(Object.entries(sourceManifest.documents).map(([source,target])=>({source,target})));const targets=new Set(),files=[],missing=[],findings=[];
 for(const entry of entries){validateReleasePath(entry.source);validateReleasePath(entry.target);if(targets.has(entry.target))throw new Error('Duplicate candidate target');targets.add(entry.target);let bytes;try{bytes=await regularSource(root,entry.source);}catch(error){if(error.code==='ENOENT'){missing.push(entry.source);continue;}throw error;}validateDocumentationMedia(entry.source,bytes);validateDocumentationMedia(entry.target,bytes);if(!/\.woff2$/i.test(entry.target))findings.push(...scanPublicContent(entry.target,bytes.toString('utf8')));files.push({...entry,bytes,sha256:sha(bytes)});}
 // Static relative imports must resolve to an explicitly included runtime file.
 for(const entry of files.filter(f=>/\.(?:mjs|js)$/.test(f.target))){for(const match of entry.bytes.toString('utf8').matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g)){const specifier=match[1];if(!specifier.startsWith('.')&&!specifier.startsWith('/'))continue;const resolved=specifier.startsWith('/')?path.posix.normalize('public'+specifier):path.posix.normalize(path.posix.join(path.posix.dirname(entry.target),specifier));if(!targets.has(resolved))findings.push({path:entry.target,reason:'import outside explicit candidate: '+resolved});}}
 if(findings.length)throw Object.assign(new Error('Candidate content check rejected '+findings.length+' finding(s)'),{findings});if(finalRuntime&&missing.length)throw new Error('Final runtime incomplete: '+missing.join(', '));
 await validateMappedReleaseDocuments(root,sourceManifest.documents);
 const administrationRuntime=sourceManifest.runtime.includes('lib/administration.mjs');if(administrationRuntime)for(const name of ['lib/administration-format.mjs','scripts/verify-administration.mjs'])if(!sourceManifest.runtime.includes(name))throw new Error('Administration runtime requires explicit compatible reader probe closure');
 const qualifiedPaths=[...sourceManifest.runtime,...sourceManifest.support.filter(name=>['scripts/performance-gate.mjs','scripts/package-release.mjs','scripts/setup-instance.mjs'].includes(name))];
 let performanceGate;
 if(finalRuntime&&sourceManifest.runtime.includes('public/app.js')){const evidence=typeof performanceEvidence==='string'?JSON.parse(await fs.readFile(performanceEvidence,'utf8')):performanceEvidence;performanceGate=validatePerformanceEvidence(evidence,{candidateDigest:runtimeDigest(files,qualifiedPaths)});const bytes=Buffer.from(JSON.stringify(evidence,null,2)+'\n');if(scanPublicContent('PERFORMANCE_EVIDENCE.json',bytes).length)throw new Error('Performance evidence contains private material');files.push({source:'PERFORMANCE_EVIDENCE.json',target:'PERFORMANCE_EVIDENCE.json',bytes,sha256:sha(bytes)});}
 await fs.mkdir(output,{recursive:true,mode:0o700});for(const entry of files){const target=path.join(output,...entry.target.split('/'));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,entry.bytes,{flag:'wx'});}
 const receipt={...(administrationRuntime?{administrationFormat:ADMINISTRATION_FORMAT}:{}),...(performanceGate?{performanceGate,runtimePaths:qualifiedPaths}:{}),schemaVersion:1,status:finalRuntime?'READY_FOR_REVIEW_NOT_PUBLISHED':'PROVISIONAL_NOT_PUBLISHED',finalRuntime,generatedAt:new Date().toISOString(),license:'MIT; publication requires separate Owner authorization',missing,contentChecks:{explicitAllowlist:true,noSymlinks:true,staticImportClosure:true,forbiddenArtifacts:true,literalSecretsAndPrivatePaths:true,humanReviewRequired:true},files:files.map(f=>({path:f.target,sha256:f.sha256,bytes:f.bytes.length})).sort((a,b)=>a.path.localeCompare(b.path))};
 const manifestBytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n');await fs.writeFile(path.join(output,'RELEASE_MANIFEST.json'),manifestBytes,{flag:'wx'});const checksumRows=[...receipt.files,{path:'RELEASE_MANIFEST.json',sha256:sha(manifestBytes)}].sort((a,b)=>a.path.localeCompare(b.path));await fs.writeFile(path.join(output,'SHA256SUMS'),checksumRows.map(r=>r.sha256+'  '+r.path).join('\n')+'\n',{flag:'wx'});return receipt;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{let destination,finalRuntime=false,performanceEvidence;for(const argument of process.argv.slice(2)){if(argument==='--final-runtime')finalRuntime=true;else if(argument.startsWith('--performance-evidence='))performanceEvidence=argument.slice(23);else if(argument.startsWith('--destination='))destination=argument.slice(14);else if(argument!=='--provisional')throw new Error('Use --destination=ABSOLUTE_NEW_DIRECTORY [--provisional|--final-runtime --performance-evidence=ABSOLUTE_JSON]');}const result=await buildCandidate({destination,finalRuntime,performanceEvidence});console.log(JSON.stringify({...result,files:result.files.length}));}catch(error){console.error(JSON.stringify({status:'REJECTED',error:error.message,findings:error.findings||[]}));process.exitCode=1;}}
