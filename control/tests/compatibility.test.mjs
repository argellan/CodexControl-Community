import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
 CODEX_SCHEMA_PROFILE,MAX_SCHEMA_BYTES,parseSchema,inspectMethodFamily,
 checkControlSchemaContract,assessCodexCompatibility,sha256
} from '../lib/compatibility.mjs';
import {parseProbeArguments,passiveArguments,probeCodexSchema} from '../scripts/probe-codex-schema.mjs';

function fixture() {
 const definitions = {ClientRequest:{oneOf:[]},ServerRequest:{oneOf:[]},v2:{}};
 const add = (family,method,name,required,optional=[]) => {
  const nested = family === 'ClientRequest';
  const target = nested ? definitions.v2 : definitions;
  target[name] = {type:'object',required,properties:Object.fromEntries([...required,...optional].map(key => [key,{type:'string'}]))};
  definitions[family].oneOf.push({properties:{method:{enum:[method]},params:{$ref:`#/definitions/${nested ? 'v2/' : ''}${name}`}}});
 };
 add('ClientRequest','thread/start','ThreadStartParams',[],['cwd','model','modelProvider','approvalPolicy','sandbox','serviceTier']);
 add('ClientRequest','thread/resume','ThreadResumeParams',['threadId'],['approvalPolicy','sandbox']);
 add('ClientRequest','turn/start','TurnStartParams',['input','threadId'],['sandboxPolicy','serviceTier','effort']);
 add('ClientRequest','turn/steer','TurnSteerParams',['expectedTurnId','input','threadId']);
 add('ClientRequest','turn/interrupt','TurnInterruptParams',['threadId','turnId']);
 add('ClientRequest','command/exec','CommandExecParams',['command'],['cwd','processId','tty','size','streamStdin','streamStdoutStderr','sandboxPolicy','timeoutMs','outputBytesCap']);
 add('ClientRequest','command/exec/write','CommandExecWriteParams',['processId'],['deltaBase64','closeStdin']);
 add('ClientRequest','command/exec/resize','CommandExecResizeParams',['processId','size']);
 add('ClientRequest','command/exec/terminate','CommandExecTerminateParams',['processId']);
 add('ServerRequest','item/commandExecution/requestApproval','CommandExecutionRequestApprovalParams',['itemId','startedAtMs','threadId','turnId'],['approvalId','kind']);
 add('ServerRequest','item/fileChange/requestApproval','FileChangeRequestApprovalParams',['itemId','startedAtMs','threadId','turnId']);
 add('ServerRequest','item/permissions/requestApproval','PermissionsRequestApprovalParams',['cwd','itemId','permissions','startedAtMs','threadId','turnId']);
 add('ServerRequest','item/tool/requestUserInput','ToolRequestUserInputParams',['isBlocking','itemId','questions','threadId','turnId']);
 return {definitions};
}

const declaredIdentity = () => ({version:CODEX_SCHEMA_PROFILE.version,platform:'win32',arch:'x64',executableSha256:CODEX_SCHEMA_PROFILE.executableSha256});

test('schema-only evidence never authorizes execution, even when caller claims qualification',()=>{
 const result = assessCodexCompatibility({...declaredIdentity(),status:'QUALIFIED_PREVIEW',executionAllowed:true,runtimeVerification:'PASS',qualifiedOperations:['turn.start']});
 assert.equal(result.status,'UNAVAILABLE');
 assert.equal(result.executionAllowed,false);
 assert.equal(result.runtimeVerification,'NOT_RUN');
 assert.equal(result.accountCapability,'UNKNOWN');
 assert.deepEqual(result.qualifiedOperations,[]);
 assert.equal(result.reasons.length,4);
 assert.equal(result.declarations,null);
});

test('version, platform and binary changes independently fail closed',()=>{
 for (const [change,reason] of [
  [{version:'0.163.0'},'UNRECOGNIZED_VERSION'],[{platform:'linux'},'UNRECOGNIZED_PLATFORM'],
  [{arch:'arm64'},'UNRECOGNIZED_PLATFORM'],[{executableSha256:'0'.repeat(64)},'UNRECOGNIZED_EXECUTABLE']
 ]) {
  const result = assessCodexCompatibility({...declaredIdentity(),...change});
  assert.ok(result.reasons.includes(reason));
  assert.equal(result.executionAllowed,false);
 }
});

test('equal-size modified schema bytes and caller-supplied digests cannot bypass pins',()=>{
 const schemas = Object.fromEntries(Object.entries(CODEX_SCHEMA_PROFILE.schemas).map(([key,pin]) => [key,Buffer.alloc(pin.bytes,32)]));
 const result = assessCodexCompatibility({...declaredIdentity(),schemas,schemaDigests:Object.fromEntries(Object.entries(CODEX_SCHEMA_PROFILE.schemas).map(([key,pin]) => [key,pin.sha256]))});
 assert.equal(result.status,'UNAVAILABLE');
 assert.deepEqual(Object.keys(result.schemaDigests),[]);
 assert.equal(result.reasons.filter(reason => reason.startsWith('SCHEMA_PIN_MISMATCH:')).length,4);
});

test('an unknown schema variant is not implicitly enabled',()=>{
 const result = assessCodexCompatibility({...declaredIdentity(),schemas:{future:Buffer.from('{}')}});
 assert.ok(result.reasons.includes('UNRECOGNIZED_SCHEMA_VARIANT'));
 assert.equal(result.executionAllowed,false);
});

test('compatibility evidence and schema containers do not invoke hostile getters or proxy traps',()=>{
 let invoked = 0;
 const accessor = Object.defineProperty({},'version',{get(){ invoked++; throw new Error('PRIVATE_CONTENT'); }});
 const proxy = new Proxy({}, {get(){ invoked++; throw new Error('PRIVATE_CONTENT'); }});
 const schemaAccessor = Object.defineProperty({},'normalCombined',{get(){ invoked++; throw new Error('PRIVATE_CONTENT'); }});
 for (const evidence of [accessor,proxy,{...declaredIdentity(),schemas:schemaAccessor}]) {
  assert.equal(assessCodexCompatibility(evidence).status,'UNAVAILABLE');
 }
 assert.equal(invoked,0);
});

test('malformed or oversized schemas are rejected before inspection',()=>{
 for (const value of [null,'{}',Buffer.from('{'),Buffer.from('{}'),Buffer.alloc(MAX_SCHEMA_BYTES+1)]) {
  assert.throws(()=>parseSchema(value),/INVALID_SCHEMA/);
 }
 assert.equal(sha256(Buffer.from('abc')),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('inspection supports the combined schema v2 namespace without losing required fields',()=>{
 const schema = parseSchema(Buffer.from(JSON.stringify(fixture())));
 assert.equal(checkControlSchemaContract(schema),true);
 const steer = inspectMethodFamily(schema,'ClientRequest').find(item => item.method === 'turn/steer');
 assert.deepEqual(steer.required,['expectedTurnId','input','threadId']);
 assert.equal(steer.params,'TurnSteerParams');
});

test('missing steering guard, request blocking flag and approval identity fields refuse the contract',()=>{
 for (const [nested,name,field] of [
  [true,'TurnSteerParams','expectedTurnId'],[false,'ToolRequestUserInputParams','isBlocking'],
  [false,'CommandExecutionRequestApprovalParams','approvalId'],[false,'CommandExecutionRequestApprovalParams','kind']
 ]) {
  const schema = fixture();
  const definition = (nested ? schema.definitions.v2 : schema.definitions)[name];
  delete definition.properties[field];
  definition.required = definition.required.filter(item => item !== field);
  assert.equal(checkControlSchemaContract(schema),false);
 }
});

test('missing methods and a new required native argument refuse the contract',()=>{
 const missing = fixture();
 missing.definitions.ClientRequest.oneOf = missing.definitions.ClientRequest.oneOf.filter(item => item.properties.method.enum[0] !== 'turn/interrupt');
 assert.equal(checkControlSchemaContract(missing),false);
 const changed = fixture();
 changed.definitions.v2.ThreadResumeParams.properties.profileId = {type:'string'};
 changed.definitions.v2.ThreadResumeParams.required.push('profileId');
 assert.equal(checkControlSchemaContract(changed),false);
});

test('duplicate methods, external references and missing local definitions are rejected',()=>{
 const duplicate = fixture();
 duplicate.definitions.ClientRequest.oneOf.push(duplicate.definitions.ClientRequest.oneOf[0]);
 assert.throws(()=>inspectMethodFamily(duplicate,'ClientRequest'),/INVALID_SCHEMA/);
 for (const ref of ['https://example.invalid/ThreadStartParams','#/definitions/absent','#/definitions/__proto__/x']) {
  const schema = fixture();
  schema.definitions.ClientRequest.oneOf[0].properties.params.$ref = ref;
  assert.throws(()=>inspectMethodFamily(schema,'ClientRequest'),/INVALID_SCHEMA/);
 }
});

test('uninspected union parameters cannot satisfy a control contract',()=>{
 const schema = fixture();
 schema.definitions.v2.ThreadStartParams = {oneOf:[{type:'object'}]};
 assert.equal(inspectMethodFamily(schema,'ClientRequest').find(item => item.method === 'thread/start').uninspectedUnion,true);
 assert.equal(checkControlSchemaContract(schema),false);
});

test('normal export presence does not broaden the reviewed control methods',()=>{
 const schema = fixture();
 schema.definitions.v2.UnsafeParams = {type:'object',properties:{command:{type:'string'}},required:['command']};
 schema.definitions.ClientRequest.oneOf.push({properties:{method:{enum:['thread/shellCommand']},params:{$ref:'#/definitions/v2/UnsafeParams'}}});
 assert.equal(checkControlSchemaContract(schema),true);
 // Synthetic contract success is not an accepted native schema, nor an execution grant.
 const result = assessCodexCompatibility({...declaredIdentity(),schemas:{normalCombined:Buffer.from(JSON.stringify(schema))}});
 assert.equal(result.status,'UNAVAILABLE');
 assert.equal(result.executionAllowed,false);
});

test('declaration pins cannot be mutated by a caller',()=>{
 assert.throws(()=>{ CODEX_SCHEMA_PROFILE.version='latest'; },TypeError);
 assert.throws(()=>{ CODEX_SCHEMA_PROFILE.schemas.normalV2.sha256='0'.repeat(64); },TypeError);
});

test('probe command construction contains only four fixed passive stages',()=>{
 const output = path.resolve('directory with spaces & symbols');
 assert.deepEqual(passiveArguments('version'),['--version']);
 assert.deepEqual(passiveArguments('schemaHelp'),['app-server','generate-json-schema','--help']);
 assert.deepEqual(passiveArguments('normal',output),['app-server','generate-json-schema','--out',output]);
 assert.deepEqual(passiveArguments('experimental',output),['app-server','generate-json-schema','--out',output,'--experimental']);
 for (const stage of ['initialize','app-server','exec','login','process/spawn','turn/start']) {
  assert.throws(()=>passiveArguments(stage,output),/INVALID_PASSIVE_STAGE/);
 }
 assert.throws(()=>passiveArguments('normal','relative'),/INVALID_PASSIVE_STAGE/);
});

test('probe CLI rejects command injection surfaces and incomplete evidence pairs',()=>{
 const executable = path.resolve('codex.exe');
 for (const args of [[],['--executable','codex.exe'],['--executable',executable,'--listen','stdio://'],
  ['--executable',executable,'--config','x=y'],['--executable',executable,'--executable',executable],
  ['--executable',executable,'--reuse-normal',path.resolve('normal')],['--executable',executable,'exec']]) {
  assert.throws(()=>parseProbeArguments(args),/INVALID_PROBE_ARGUMENTS/);
 }
 assert.equal(parseProbeArguments(['--executable',executable]).executable,executable);
});

test('programmatic probe rejects hostile option getters and proxies without invoking them',async()=>{
 let invoked = 0;
 const accessor = Object.defineProperty({},'executable',{enumerable:true,get(){ invoked++; throw new Error('PRIVATE_CONTENT'); }});
 await assert.rejects(probeCodexSchema(accessor),{message:'INVALID_PROBE_ARGUMENTS'});
 const proxy = new Proxy({executable:path.resolve('codex.exe')},{get(){ invoked++; throw new Error('PRIVATE_CONTENT'); },ownKeys(){ invoked++; return []; },getPrototypeOf(){ invoked++; return Object.prototype; }});
 await assert.rejects(probeCodexSchema(proxy),{message:'INVALID_PROBE_ARGUMENTS'});
 assert.equal(invoked,0);
});

test('probe argument arrays reject accessors, proxies, holes and oversized values without coercion',()=>{
 let invoked = 0;
 const accessor = ['--executable',path.resolve('codex.exe')];
 Object.defineProperty(accessor,'1',{get(){ invoked++; return 'PRIVATE_CONTENT'; }});
 const proxy = new Proxy(['--help'],{get(){ invoked++; return 'PRIVATE_CONTENT'; }});
 for (const args of [accessor,proxy,new Array(2),['--executable','x'.repeat(4097)]]) {
  assert.throws(()=>parseProbeArguments(args),{message:'INVALID_PROBE_ARGUMENTS'});
 }
 assert.equal(invoked,0);
});

test('a file merely named codex.exe is rejected without spawning it',async t=>{
 const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../.local/compatibility-tests');
 await fs.mkdir(root,{recursive:true});
 const directory = await fs.mkdtemp(path.join(root,'fixture-'));
 t.after(async()=>{
  assert.equal(path.dirname(path.resolve(directory)),root);
  assert.ok(path.basename(directory).startsWith('fixture-'));
  await fs.rm(directory,{recursive:true,force:true});
 });
 const file = path.join(directory,'codex.exe');
 await assert.rejects(probeCodexSchema({executable:file}),error=>{
  assert.match(error.message,/^(PROBE_FAILED|UNRECOGNIZED_PLATFORM|UNQUALIFIED_NODE_MAJOR)$/);
  assert.equal(error.message.includes(directory),false);
  return true;
 });
 await fs.writeFile(file,'This is not an executable.');
 await assert.rejects(probeCodexSchema({executable:file}),/UNRECOGNIZED_EXECUTABLE|UNRECOGNIZED_PLATFORM|UNQUALIFIED_NODE_MAJOR/);
});

test('revoked argument proxies are refused with the fixed probe error',()=>{
 const {proxy,revoke} = Proxy.revocable(['--help'],{});
 revoke();
 assert.throws(()=>parseProbeArguments(proxy),{message:'INVALID_PROBE_ARGUMENTS'});
});

test('decorated and revoked schema buffers cannot run caller hooks or escape unavailable assessment',()=>{
 let invoked = 0;
 const decorated = Buffer.from('{}');
 Object.defineProperty(decorated,'length',{get(){ invoked++; throw new Error('PRIVATE_CONTENT'); }});
 const revoked = Proxy.revocable(Buffer.from('{}'),{});
 revoked.revoke();
 for (const bytes of [decorated,revoked.proxy]) {
  const result = assessCodexCompatibility({...declaredIdentity(),schemas:{normalCombined:bytes}});
  assert.equal(result.status,'UNAVAILABLE');
  assert.equal(result.executionAllowed,false);
 }
 assert.equal(assessCodexCompatibility(revoked.proxy).status,'UNAVAILABLE');
 assert.equal(invoked,0);
});
