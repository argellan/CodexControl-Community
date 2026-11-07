import {createHash} from 'node:crypto';
import {types} from 'node:util';

function freeze(value) {
 for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
 return Object.freeze(value);
}

// This is a declaration pin, never a runtime allowlist or an authorization grant.
export const CODEX_SCHEMA_PROFILE = freeze({
 id:'codex-cli-0.163.0-alpha.11-win32-x64',
 version:'0.163.0-alpha.11', platform:'win32', arch:'x64',
 executableSha256:'00c0f1e4099246fddcd67ec620ca8ed50827c7d70e113b7224f7a2933cf2d67c',
 maturity:'EXPERIMENTAL_PREVIEW', runtimeVerification:'NOT_RUN',
 schemas:{
  normalCombined:{file:'codex_app_server_protocol.schemas.json',bytes:730500,sha256:'408e09849d5d4931992a4227a7f3eb80b15d24901f84aca0562e816634651a82'},
  normalV2:{file:'codex_app_server_protocol.v2.schemas.json',bytes:628192,sha256:'d204b96d8560d56600127423b89df9db471b3e22338e8809bb91d5a952998978'},
  experimentalCombined:{file:'codex_app_server_protocol.schemas.json',bytes:890285,sha256:'af491b61b83ff04943f2207268d2539d09b6e4bea7aef9972adb9eda2026d1be'},
  experimentalV2:{file:'codex_app_server_protocol.v2.schemas.json',bytes:776767,sha256:'f826863e71e4e5678d6900a87c916414a1c5a06ca805d42037e8f91a762688e9'}
 }
});

export const MAX_SCHEMA_BYTES = 2 * 1024 * 1024;
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const equalSet = (left,right) => left.length === right.length && left.every(item => right.includes(item));
const byteLengthOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength').get;
const setBytes = Uint8Array.prototype.set;

function schemaBytes(value) {
 try {
  if (types.isProxy(value) || !types.isUint8Array(value) || Object.getPrototypeOf(value) !== Buffer.prototype) return null;
  const length = byteLengthOf.call(value);
  if (!length || length > MAX_SCHEMA_BYTES) return null;
  const copy = Buffer.alloc(length);
  setBytes.call(copy,value);
  return copy;
 } catch { return null; }
}

function dataRecord(value) {
 if (types.isProxy(value) || !object(value)) return null;
 const prototype = Object.getPrototypeOf(value);
 if (prototype !== Object.prototype && prototype !== null) return null;
 const descriptors = Object.getOwnPropertyDescriptors(value);
 const copy = Object.create(null);
 for (const key of Reflect.ownKeys(descriptors)) {
  if (typeof key !== 'string' || !Object.hasOwn(descriptors[key],'value')) return null;
  copy[key] = descriptors[key].value;
 }
 return copy;
}

function invalidSchema() { throw new Error('INVALID_SCHEMA'); }

export function parseSchema(bytes) {
 bytes = schemaBytes(bytes);
 if (!bytes) invalidSchema();
 let schema;
 try { schema = JSON.parse(bytes.toString('utf8')); } catch { invalidSchema(); }
 if (!object(schema) || !object(schema.definitions)) invalidSchema();
 return schema;
}

// Only a bounded local-reference subset is needed to inspect the pinned export.
// This is deliberately not a generic JSON Schema validator or native RPC router.
export function inspectMethodFamily(schema, family) {
 if (!['ClientRequest','ServerRequest'].includes(family)) invalidSchema();
 const definitions = schema?.definitions;
 const variants = definitions?.[family]?.oneOf;
 if (!object(definitions) || !Array.isArray(variants) || variants.length > 512) invalidSchema();
 const seen = new Set();
 return variants.map(variant => {
  const names = variant?.properties?.method?.enum;
  if (!Array.isArray(names) || names.length !== 1 || typeof names[0] !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_\/-]{0,127}$/.test(names[0]) || seen.has(names[0])) invalidSchema();
  const method = names[0];
  seen.add(method);
  const params = variant.properties.params;
  if (params === undefined || (object(params) && params.type === 'null')) return {method,params:null,fields:[],required:[]};
  if (!object(params)) invalidSchema();
  let ref = params.$ref;
  if (!ref && Array.isArray(params.anyOf) && params.anyOf.length === 2 && params.anyOf.some(item => item.type === 'null')) {
   ref = params.anyOf.find(item => typeof item.$ref === 'string')?.$ref;
  }
  if (typeof ref !== 'string' || !/^#\/definitions\/(?:v2\/)?[A-Za-z0-9_]+$/.test(ref)) invalidSchema();
  const parts = ref.slice('#/definitions/'.length).split('/');
  const name = parts.at(-1);
  const definition = parts.reduce((value,key) => Object.hasOwn(value ?? {},key) ? value[key] : undefined,definitions);
  if (object(definition) && !definition.type && Array.isArray(definition.oneOf) &&
      definition.oneOf.length > 0 && definition.oneOf.length <= 32 && definition.oneOf.every(object)) {
   return {method,params:name,fields:[],required:[],uninspectedUnion:true};
  }
  if (!object(definition) || definition.type !== 'object' || (definition.properties !== undefined && !object(definition.properties))) invalidSchema();
  const fields = Object.keys(definition.properties ?? {}).sort();
  const required = definition.required ?? [];
  if (fields.length > 256 || !strings(required) || new Set(required).size !== required.length ||
      required.some(field => !fields.includes(field))) invalidSchema();
  return {method,params:name,fields,required:[...required].sort()};
 }).sort((left,right) => left.method.localeCompare(right.method));
}

export const CONTROL_SCHEMA_CONTRACTS = freeze([
 {family:'ClientRequest',method:'thread/start',params:'ThreadStartParams',required:[],fields:['cwd','model','modelProvider','approvalPolicy','sandbox','serviceTier']},
 {family:'ClientRequest',method:'thread/resume',params:'ThreadResumeParams',required:['threadId'],fields:['threadId','approvalPolicy','sandbox']},
 {family:'ClientRequest',method:'turn/start',params:'TurnStartParams',required:['input','threadId'],fields:['input','threadId','sandboxPolicy','serviceTier','effort']},
 {family:'ClientRequest',method:'turn/steer',params:'TurnSteerParams',required:['expectedTurnId','input','threadId'],fields:['expectedTurnId','input','threadId']},
 {family:'ClientRequest',method:'turn/interrupt',params:'TurnInterruptParams',required:['threadId','turnId'],fields:['threadId','turnId']},
 {family:'ClientRequest',method:'command/exec',params:'CommandExecParams',required:['command'],fields:['command','cwd','processId','tty','size','streamStdin','streamStdoutStderr','sandboxPolicy','timeoutMs','outputBytesCap']},
 {family:'ClientRequest',method:'command/exec/write',params:'CommandExecWriteParams',required:['processId'],fields:['processId','deltaBase64','closeStdin']},
 {family:'ClientRequest',method:'command/exec/resize',params:'CommandExecResizeParams',required:['processId','size'],fields:['processId','size']},
 {family:'ClientRequest',method:'command/exec/terminate',params:'CommandExecTerminateParams',required:['processId'],fields:['processId']},
 {family:'ServerRequest',method:'item/commandExecution/requestApproval',params:'CommandExecutionRequestApprovalParams',required:['itemId','startedAtMs','threadId','turnId'],fields:['approvalId','kind','itemId','startedAtMs','threadId','turnId']},
 {family:'ServerRequest',method:'item/fileChange/requestApproval',params:'FileChangeRequestApprovalParams',required:['itemId','startedAtMs','threadId','turnId'],fields:['itemId','startedAtMs','threadId','turnId']},
 {family:'ServerRequest',method:'item/permissions/requestApproval',params:'PermissionsRequestApprovalParams',required:['cwd','itemId','permissions','startedAtMs','threadId','turnId'],fields:['cwd','permissions','itemId','startedAtMs','threadId','turnId']},
 {family:'ServerRequest',method:'item/tool/requestUserInput',params:'ToolRequestUserInputParams',required:['isBlocking','itemId','questions','threadId','turnId'],fields:['isBlocking','questions','itemId','threadId','turnId']}
]);

export function checkControlSchemaContract(schema) {
 try {
  const families = Object.fromEntries(['ClientRequest','ServerRequest'].map(family => [family,inspectMethodFamily(schema,family)]));
  return CONTROL_SCHEMA_CONTRACTS.every(contract => {
   const declared = families[contract.family].find(item => item.method === contract.method);
   return !declared?.uninspectedUnion && declared?.params === contract.params && equalSet(declared.required,contract.required) &&
    contract.fields.every(field => declared.fields.includes(field));
  });
 } catch { return false; }
}

export function assessCodexCompatibility(evidence) {
 const reasons = [];
 const profile = CODEX_SCHEMA_PROFILE;
 evidence = dataRecord(evidence) ?? {};
 if (evidence.version !== profile.version) reasons.push('UNRECOGNIZED_VERSION');
 if (evidence.platform !== profile.platform || evidence.arch !== profile.arch) reasons.push('UNRECOGNIZED_PLATFORM');
 if (evidence.executableSha256 !== profile.executableSha256) reasons.push('UNRECOGNIZED_EXECUTABLE');
 const schemas = dataRecord(evidence.schemas) ?? {};
 const parsed = {};
 const schemaDigests = {};
 for (const [key,pin] of Object.entries(profile.schemas)) {
  const bytes = schemaBytes(schemas[key]);
  if (!bytes || bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) {
   reasons.push(`SCHEMA_PIN_MISMATCH:${key}`);
   continue;
  }
  schemaDigests[key] = pin.sha256;
  try { parsed[key] = parseSchema(bytes); } catch { reasons.push(`INVALID_SCHEMA:${key}`); }
 }
 if (Object.keys(schemas).some(key => !Object.hasOwn(profile.schemas,key))) reasons.push('UNRECOGNIZED_SCHEMA_VARIANT');
 let declarations = null;
 if (reasons.length === 0) {
  if (!checkControlSchemaContract(parsed.normalCombined)) reasons.push('CONTROL_SCHEMA_CONTRACT_MISMATCH');
  else {
   try {
    const normal = inspectMethodFamily(parsed.normalCombined,'ClientRequest');
    const experimental = inspectMethodFamily(parsed.experimentalCombined,'ClientRequest');
    declarations = {
     normalClientMethodCount:normal.length,experimentalClientMethodCount:experimental.length,
     control:CONTROL_SCHEMA_CONTRACTS.map(contract => ({family:contract.family,
      ...inspectMethodFamily(parsed.normalCombined,contract.family).find(item => item.method === contract.method)})),
     experimentalOnlyMethods:experimental.filter(item => !normal.some(other => other.method === item.method)).map(item => item.method)
    };
   } catch { reasons.push('CONTROL_SCHEMA_CONTRACT_MISMATCH'); }
  }
 }
 return {
  profileId:profile.id,status:reasons.length ? 'UNAVAILABLE' : 'DECLARED_ONLY',reasons,
  upstreamMaturity:profile.maturity,runtimeVerification:'NOT_RUN',accountCapability:'UNKNOWN',
  executionAllowed:false,qualifiedOperations:[],schemaDigests,declarations:reasons.length ? null : declarations
 };
}
