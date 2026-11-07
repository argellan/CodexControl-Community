import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {types} from 'node:util';
import {CODEX_SCHEMA_PROFILE,assessCodexCompatibility,sha256} from '../lib/compatibility.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const MAX_EXPORT_FILES = 2048;
const PASSIVE_TIMEOUT_MS = 15000;
const PASSIVE_OUTPUT_BYTES = 128 * 1024;

const probeErrorCodes = new Set([
 'INVALID_PROBE_ARGUMENTS','INVALID_PASSIVE_STAGE','UNSAFE_PROBE_FILE','UNRECOGNIZED_EXECUTABLE',
 'PASSIVE_COMMAND_FAILED','EXPORT_LIMIT_EXCEEDED','UNSAFE_EXPORT_TREE','SCHEMA_PIN_MISMATCH',
 'UNQUALIFIED_NODE_MAJOR','UNRECOGNIZED_PLATFORM','UNSAFE_EVIDENCE_DIRECTORY','UNRECOGNIZED_VERSION',
 'SCHEMA_EXPORT_UNAVAILABLE','SCHEMA_CONTRACT_MISMATCH','PROBE_FAILED'
]);
const issuedErrors = new WeakMap();
function fail(code) {
 const safeCode = probeErrorCodes.has(code) ? code : 'PROBE_FAILED';
 const error = new Error(safeCode);
 issuedErrors.set(error,safeCode);
 throw error;
}
function reasonFor(error) { return issuedErrors.get(error) ?? 'PROBE_FAILED'; }

function argumentValues(args) {
 if (types.isProxy(args) || !Array.isArray(args) || Object.getPrototypeOf(args) !== Array.prototype) fail('INVALID_PROBE_ARGUMENTS');
 const descriptors = Object.getOwnPropertyDescriptors(args);
 const length = descriptors.length.value;
 if (length > 6 || Reflect.ownKeys(descriptors).length !== length+1) fail('INVALID_PROBE_ARGUMENTS');
 const values = [];
 for (let index=0; index<length; index++) {
  const descriptor = descriptors[index];
  if (!descriptor || !Object.hasOwn(descriptor,'value') || typeof descriptor.value !== 'string' || descriptor.value.length > 4096) fail('INVALID_PROBE_ARGUMENTS');
  values.push(descriptor.value);
 }
 return values;
}

function optionArguments(options) {
 if (!options || typeof options !== 'object' || types.isProxy(options)) fail('INVALID_PROBE_ARGUMENTS');
 const prototype = Object.getPrototypeOf(options);
 if (prototype !== Object.prototype && prototype !== null) fail('INVALID_PROBE_ARGUMENTS');
 const descriptors = Object.getOwnPropertyDescriptors(options);
 const names = new Map([['executable','--executable'],['reuseNormal','--reuse-normal'],['reuseExperimental','--reuse-experimental']]);
 const args = [];
 for (const key of Reflect.ownKeys(descriptors)) {
  const descriptor = descriptors[key];
  if (!names.has(key) || !Object.hasOwn(descriptor,'value') || typeof descriptor.value !== 'string') fail('INVALID_PROBE_ARGUMENTS');
  args.push(names.get(key),descriptor.value);
 }
 return args;
}

export function parseProbeArguments(args) {
 args = argumentValues(args);
 if (args.length === 1 && args[0] === '--help') return {help:true};
 const options = {};
 const names = new Map([['--executable','executable'],['--reuse-normal','reuseNormal'],['--reuse-experimental','reuseExperimental']]);
 for (let index=0; index<args.length; index+=2) {
  const name = names.get(args[index]);
  const value = args[index+1];
  if (!name || Object.hasOwn(options,name) || typeof value !== 'string' || !value || value.startsWith('--') ||
      value.includes('\0') || !path.isAbsolute(value)) fail('INVALID_PROBE_ARGUMENTS');
  options[name] = value;
 }
 if (!options.executable || Boolean(options.reuseNormal) !== Boolean(options.reuseExperimental)) fail('INVALID_PROBE_ARGUMENTS');
 return options;
}

export function passiveArguments(stage, outputDirectory) {
 if (stage === 'version') return ['--version'];
 if (stage === 'schemaHelp') return ['app-server','generate-json-schema','--help'];
 if (!['normal','experimental'].includes(stage) || typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory) || outputDirectory.includes('\0')) fail('INVALID_PASSIVE_STAGE');
 return ['app-server','generate-json-schema','--out',outputDirectory,...(stage === 'experimental' ? ['--experimental'] : [])];
}

async function plainFile(file,maximumBytes) {
 const stat = await fs.lstat(file);
 if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximumBytes || await fs.realpath(file) !== path.resolve(file)) fail('UNSAFE_PROBE_FILE');
 return stat;
}

async function executableHash(file) {
 await plainFile(file,MAX_EXECUTABLE_BYTES);
 const hash = createHash('sha256');
 for await (const chunk of createReadStream(file)) hash.update(chunk);
 return hash.digest('hex');
}

async function requirePinnedExecutable(executable) {
 if (!path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== 'codex.exe') fail('UNRECOGNIZED_EXECUTABLE');
 if (await executableHash(executable) !== CODEX_SCHEMA_PROFILE.executableSha256) fail('UNRECOGNIZED_EXECUTABLE');
}

function passiveEnvironment(directory) {
 // Do not inherit API tokens, provider routing, Node preload flags or credential variables.
 const environment = {TEMP:directory,TMP:directory};
 for (const name of ['SystemRoot','WINDIR']) if (process.env[name]) environment[name] = process.env[name];
 if (environment.SystemRoot) environment.PATH = path.join(environment.SystemRoot,'System32');
 return environment;
}

async function runPassiveStage(executable,stage,directory,outputDirectory,records) {
 await requirePinnedExecutable(executable);
 const result = spawnSync(executable,passiveArguments(stage,outputDirectory),{
  cwd:directory,env:passiveEnvironment(directory),shell:false,windowsHide:true,
  stdio:['ignore','pipe','pipe'],timeout:PASSIVE_TIMEOUT_MS,killSignal:'SIGKILL',maxBuffer:PASSIVE_OUTPUT_BYTES
 });
 // Output content and its fingerprints are excluded; keep counts/status only.
 records.push({stage,exitCode:result.status,signal:result.signal,
  stdoutBytes:result.stdout?.length ?? 0,stderrBytes:result.stderr?.length ?? 0});
 if (result.error || result.status !== 0 || result.signal) fail('PASSIVE_COMMAND_FAILED');
 await requirePinnedExecutable(executable);
 return result.stdout.toString('utf8');
}

async function inspectExportTree(directory) {
 const queue = [directory];
 let bytes = 0,files = 0,directories = 0;
 while (queue.length) {
  const current = queue.pop();
  if (++directories > 32) fail('EXPORT_LIMIT_EXCEEDED');
  const stat = await fs.lstat(current);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_EXPORT_TREE');
  for (const entry of await fs.readdir(current,{withFileTypes:true})) {
   const target = path.join(current,entry.name);
   if (entry.isSymbolicLink()) fail('UNSAFE_EXPORT_TREE');
   if (entry.isDirectory()) { queue.push(target); continue; }
   if (!entry.isFile() || !entry.name.endsWith('.json')) fail('UNSAFE_EXPORT_TREE');
   const info = await fs.lstat(target);
   files++;
   bytes += info.size;
   if (files > MAX_EXPORT_FILES || bytes > MAX_EXPORT_BYTES || info.size > 2*1024*1024) fail('EXPORT_LIMIT_EXCEEDED');
  }
 }
 return {files,bytes};
}

async function readBundles(normalDirectory,experimentalDirectory) {
 const schemas = {};
 for (const [key,pin] of Object.entries(CODEX_SCHEMA_PROFILE.schemas)) {
  const directory = key.startsWith('normal') ? normalDirectory : experimentalDirectory;
  if (!path.isAbsolute(directory)) fail('INVALID_PROBE_ARGUMENTS');
  const file = path.join(directory,pin.file);
  await plainFile(file,2*1024*1024);
  const bytes = await fs.readFile(file);
  if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) fail('SCHEMA_PIN_MISMATCH');
  schemas[key] = bytes;
 }
 return schemas;
}

async function runProbe(options) {
 // Inspect only data descriptors; reject proxies/accessors without invoking them.
 const validated = parseProbeArguments(optionArguments(options));
 if (process.versions.node.split('.')[0] !== '24') fail('UNQUALIFIED_NODE_MAJOR');
 if (process.platform !== CODEX_SCHEMA_PROFILE.platform || process.arch !== CODEX_SCHEMA_PROFILE.arch) fail('UNRECOGNIZED_PLATFORM');
 await requirePinnedExecutable(validated.executable);
 const local = path.join(repositoryRoot,'.local');
 const evidenceRoot = path.join(local,'control-compatibility');
 await fs.mkdir(local,{recursive:true});
 if (await fs.realpath(local) !== local) fail('UNSAFE_EVIDENCE_DIRECTORY');
 await fs.mkdir(evidenceRoot,{recursive:true});
 if (await fs.realpath(evidenceRoot) !== evidenceRoot) fail('UNSAFE_EVIDENCE_DIRECTORY');
 const directory = await fs.mkdtemp(path.join(evidenceRoot,'probe-'));
 const stages = [];
 try {
  let normalDirectory = validated.reuseNormal;
  let experimentalDirectory = validated.reuseExperimental;
  let exportInventory = null;
  const reused = Boolean(normalDirectory);
  if (!reused) {
   const version = (await runPassiveStage(validated.executable,'version',directory,undefined,stages)).trim();
   if (version !== `codex-cli ${CODEX_SCHEMA_PROFILE.version}`) fail('UNRECOGNIZED_VERSION');
   const help = await runPassiveStage(validated.executable,'schemaHelp',directory,undefined,stages);
   if (!help.includes('--out') || !help.includes('--experimental')) fail('SCHEMA_EXPORT_UNAVAILABLE');
   normalDirectory = path.join(directory,'normal');
   experimentalDirectory = path.join(directory,'experimental');
   for (const [stage,destination] of [['normal',normalDirectory],['experimental',experimentalDirectory]]) {
    await fs.mkdir(destination);
    await runPassiveStage(validated.executable,stage,directory,destination,stages);
   }
   exportInventory = {normal:await inspectExportTree(normalDirectory),experimental:await inspectExportTree(experimentalDirectory)};
  }
  const schemas = await readBundles(normalDirectory,experimentalDirectory);
  const result = assessCodexCompatibility({
   version:CODEX_SCHEMA_PROFILE.version,platform:process.platform,arch:process.arch,
   executableSha256:CODEX_SCHEMA_PROFILE.executableSha256,schemas
  });
  if (result.status !== 'DECLARED_ONLY') fail('SCHEMA_CONTRACT_MISMATCH');
  if (reused) {
   for (const [key,bytes] of Object.entries(schemas)) {
    await fs.writeFile(path.join(directory,`${key}.json`),bytes,{flag:'wx'});
   }
  }
  await requirePinnedExecutable(validated.executable);
  const report = {
   format:'codexcontrol-passive-schema-evidence-v1',observedAt:new Date().toISOString(),
   source:reused ? 'REVALIDATED_RETAINED_EXPORTS' : 'FRESH_PASSIVE_EXPORTS',
   version:CODEX_SCHEMA_PROFILE.version,
   versionEvidence:reused ? 'Prior version/help/schema observation; identical executable and schema bytes rehashed' : 'Exact passive --version response',
   platform:process.platform,arch:process.arch,nodeVersion:process.versions.node,nodeAbi:process.versions.modules,
   executableSha256:CODEX_SCHEMA_PROFILE.executableSha256,
   nativeCalls:stages,exportInventory,
   limits:{timeoutMs:PASSIVE_TIMEOUT_MS,stdioBytesPerStream:PASSIVE_OUTPUT_BYTES,exportBytes:MAX_EXPORT_BYTES,exportFiles:MAX_EXPORT_FILES},
   ...result
  };
  await fs.writeFile(path.join(directory,'probe-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  return {status:result.status,executionAllowed:false,runtimeVerification:'NOT_RUN',
   evidence:path.relative(repositoryRoot,directory).split(path.sep).join('/'),report};
 } catch (error) {
  const reason = reasonFor(error);
  await fs.writeFile(path.join(directory,'probe-failure.json'),JSON.stringify({status:'UNAVAILABLE',reason,nativeCalls:stages,executionAllowed:false})+'\n',{flag:'wx'});
  fail(reason);
 }
}

export async function probeCodexSchema(options) {
 try { return await runProbe(options); }
 catch (error) { fail(reasonFor(error)); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
 try {
  const options = parseProbeArguments(process.argv.slice(2));
  if (options.help) {
   console.log('Passive schema probe: --executable ABSOLUTE_CODEX_EXE [--reuse-normal ABSOLUTE_DIRECTORY --reuse-experimental ABSOLUTE_DIRECTORY]. Evidence stays in .local/control-compatibility. No RPC, authentication or provider session is started.');
  } else {
   const {report,...summary} = await probeCodexSchema(options);
   console.log(JSON.stringify(summary));
  }
 } catch (error) {
  console.error(JSON.stringify({status:'UNAVAILABLE',executionAllowed:false,reason:reasonFor(error)}));
  process.exitCode = 1;
 }
}
