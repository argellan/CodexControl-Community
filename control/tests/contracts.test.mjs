import test from 'node:test';
import assert from 'node:assert/strict';
import {ControlError, isControlError, safeControlError, CONTROL_ERROR_CODES, CONTROL_REASON_CODES} from '../lib/errors.mjs';
import {canonicalJson, sanitizeMetadataEvent} from '../lib/privacy.mjs';
import {validateOperation, MAX_OPERATION_TIMEOUT_MS} from '../contracts/operations.mjs';
import {foundationCapabilities, validateControlGrant} from '../contracts/capabilities.mjs';
import {validateNativeReference, validateNativeRequest, validateRequestDecision} from '../contracts/requests.mjs';
import {validateTerminalReference, validateTerminalFrameMetadata, MAX_TERMINAL_FRAME_BYTES} from '../contracts/terminal.mjs';
import {transitionOperationState, OPERATION_STATES, TERMINAL_OPERATION_STATES} from '../lib/state-machine.mjs';
import {createTransientContentStore} from '../lib/transient-content.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const secret = 'PRIVATE_CONTROL_CONTENT_SENTINEL_18f5';
const context = () => ({entityRevision: 0, policyRevision: 1, grantRevision: 1,
  authorityGeneration: 1, ownershipFence: 1, connectionEpoch: id(20)});
const operation = () => ({version: 1, operationId: id(1), requestKey: id(2), actorId: id(3),
  action: 'turn.start', target: {hostId: id(4), projectId: id(5), providerProfileId: id(6),
    runtimeId: id(7), sessionId: id(8), turnId: null, terminalId: null, requestId: null},
  context: context(), createdAtMs: 1000, deadlineAtMs: 2000, timeoutMs: 1000});
const nativeRequest = () => ({version: 1, requestId: id(30), operationId: id(1), hostId: id(4),
  projectId: id(5), providerProfileId: id(6), runtimeId: id(7), sessionId: id(8), turnId: id(9),
  context: context(), native: {requestId: {type: 'number', value: 7}, itemId: 'item:7'},
  kind: 'COMMAND_APPROVAL', state: 'PENDING', createdAtMs: 1000, expiresAtMs: 2000,
  consentRevision: 0, availableDecisions: ['ALLOW_ONCE', 'DENY', 'CANCEL']});
const decision = () => ({version: 1, decisionId: id(31), requestId: id(30), actorId: id(3),
  decision: 'ALLOW_ONCE', expectedConsentRevision: 0, context: context()});
const grant = () => ({version: 1, grantId: id(32), actorId: id(3), hostId: id(4), projectId: id(5),
  providerProfileId: null, sessionId: null, actions: ['turn.start', 'turn.interrupt'],
  grantRevision: 1, policyRevision: 1, authorityGeneration: 1, createdAtMs: 1000, expiresAtMs: 2000, enabled: true});
const terminal = () => ({version: 1, terminalId: id(40), hostId: id(4), projectId: id(5),
  runtimeId: null, ownerId: id(3), epoch: id(41), ownershipFence: 1, state: 'ATTACHED'});
const frame = () => ({version: 1, terminalId: id(40), epoch: id(41), attachmentId: id(42), sequence: 0,
  type: 'INPUT', inputLeaseId: id(43), byteLength: 1, columns: null, rows: null, acknowledgedSequence: null});
const reservation = (n, extra = {}) => ({id: id(n), scopeId: id(80), kind: 'transport', ttlMs: 100,
  bytes: Buffer.from(secret), ...extra});

function refusal(action, code = 'INVALID_INPUT') {
  assert.throws(action, error => {
    assert.ok(error instanceof ControlError);
    assert.equal(error.code, code);
    assert.equal(error.message, 'Control foundation request refused');
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(String(error.stack).includes(secret), false);
    return true;
  });
}

test('operation normalization creates an independent, deeply immutable metadata envelope', () => {
  const original = operation();
  original.operationId = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
  const checked = validateOperation(original);
  assert.equal(checked.operationId, original.operationId.toLowerCase());
  assert.notEqual(checked.target, original.target);
  assert.notEqual(checked.context, original.context);
  original.context.ownershipFence = 99;
  original.target.hostId = id(99);
  assert.equal(checked.context.ownershipFence, 1);
  assert.equal(checked.target.hostId, id(4));
  for (const value of [checked, checked.context, checked.target]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { checked.context.grantRevision = 2; }, TypeError);
});

test('all durable operation levels reject content and unrecognized fields without exposing values', () => {
  const forbidden = ['prompt', 'command', 'arguments', 'rawOutput', 'privateReasoning',
    'contentHash', 'contentHmac', 'payloadCommitment', 'body', 'intent', 'path'];
  for (const key of forbidden) {
    for (const location of ['root', 'target', 'context']) {
      const value = operation();
      (location === 'root' ? value : value[location])[key] = secret;
      refusal(() => validateOperation(value));
    }
  }
  const badId = operation(); badId.actorId = secret;
  refusal(() => validateOperation(badId));
  const badAction = operation(); badAction.action = secret;
  refusal(() => validateOperation(badAction));
});

test('prototype-shaped, accessor, proxy, hidden and symbolic inputs cannot execute during validation', () => {
  let invoked = 0;
  const accessor = operation();
  Object.defineProperty(accessor, 'action', {enumerable: true, get() { invoked++; throw new Error(secret); }});
  const hidden = operation(); Object.defineProperty(hidden, 'prompt', {value: secret});
  const symbolic = operation(); symbolic[Symbol(secret)] = secret;
  const polluted = operation(); Object.defineProperty(polluted, '__proto__', {enumerable: true, value: {prompt: secret}});
  const proxy = new Proxy(operation(), {get() { invoked++; throw new Error(secret); },
    getPrototypeOf() { invoked++; throw new Error(secret); }, ownKeys() { invoked++; throw new Error(secret); }});
  for (const value of [accessor, hidden, symbolic, polluted, proxy, [],
    Object.assign(Object.create(null), operation()), Object.assign(Object.create({prompt: secret}), operation())]) {
    refusal(() => validateOperation(value));
  }
  const nested = operation(); nested.context = new Proxy(context(), {get() { invoked++; throw new Error(secret); }});
  refusal(() => validateOperation(nested));
  assert.equal(invoked, 0);
});

test('revoked proxies are rejected with fixed errors before any native inspection can throw', () => {
  const record = Proxy.revocable(operation(), {});
  record.revoke();
  refusal(() => validateOperation(record.proxy));
  const actions = Proxy.revocable(['turn.start'], {});
  actions.revoke();
  refusal(() => validateControlGrant({...grant(), actions: actions.proxy}));
  refusal(() => canonicalJson(record.proxy));
});

test('every revision, generation, fence and epoch is required and bounded metadata', () => {
  for (const key of Object.keys(context())) {
    const missing = operation(); delete missing.context[key];
    refusal(() => validateOperation(missing));
    const malformed = operation(); malformed.context[key] = key === 'connectionEpoch' ? secret : -1;
    refusal(() => validateOperation(malformed));
  }
  for (const key of ['policyRevision', 'grantRevision', 'authorityGeneration', 'ownershipFence']) {
    const zero = operation(); zero.context[key] = 0;
    refusal(() => validateOperation(zero));
  }
  for (const value of [-0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const unsafe = operation(); unsafe.context.entityRevision = value;
    refusal(() => validateOperation(unsafe));
  }
  const next = operation(); next.context = {...context(), entityRevision: 1, authorityGeneration: 2,
    ownershipFence: 3, connectionEpoch: id(21)};
  assert.deepEqual(validateOperation(next).context, next.context);
  // This validates shape only. Matching/revocation belongs to journal and later authority enforcement.
});

test('action-specific targets refuse ambiguous runtime, turn and request control', () => {
  const validTargets = {...operation().target, turnId: id(9), terminalId: id(40), requestId: id(30)};
  const requirements = [
    ['runtime.launch', ['providerProfileId', 'runtimeId']],
    ['runtime.stop', ['providerProfileId', 'runtimeId']],
    ['session.create', ['providerProfileId', 'runtimeId', 'sessionId']],
    ['session.resume', ['providerProfileId', 'runtimeId', 'sessionId']],
    ['turn.start', ['providerProfileId', 'runtimeId', 'sessionId']],
    ['turn.steer', ['providerProfileId', 'runtimeId', 'sessionId', 'turnId']],
    ['turn.interrupt', ['providerProfileId', 'runtimeId', 'sessionId', 'turnId']],
    ['approval.respond', ['providerProfileId', 'runtimeId', 'sessionId', 'requestId']],
    ['request.respond', ['providerProfileId', 'runtimeId', 'sessionId', 'requestId']],
    ...['terminal.open', 'terminal.view', 'terminal.input', 'terminal.resize', 'terminal.terminate']
      .map(action => [action, ['terminalId']])
  ];
  for (const [action, keys] of requirements) {
    assert.equal(validateOperation({...operation(), action, target: validTargets}).action, action);
    for (const key of keys) {
      refusal(() => validateOperation({...operation(), action, target: {...validTargets, [key]: null}}));
    }
  }
  const hostProject = {...operation().target, providerProfileId: null, runtimeId: null, sessionId: null};
  refusal(() => validateOperation({...operation(), action: 'turn.steer', target: hostProject}));
  assert.equal(validateOperation({...operation(), action: 'terminal.input',
    target: {...hostProject, terminalId: id(40)}}).action, 'terminal.input');
});

test('operation deadlines bound admission metadata and reject unsafe durations', () => {
  for (const changes of [{timeoutMs: 0}, {timeoutMs: MAX_OPERATION_TIMEOUT_MS + 1},
    {deadlineAtMs: 999}, {deadlineAtMs: 1999}, {deadlineAtMs: 1001 + MAX_OPERATION_TIMEOUT_MS},
    {createdAtMs: Infinity}, {createdAtMs: -1}]) {
    refusal(() => validateOperation({...operation(), ...changes}));
  }
  assert.equal(validateOperation({...operation(), timeoutMs: MAX_OPERATION_TIMEOUT_MS,
    deadlineAtMs: 1000 + MAX_OPERATION_TIMEOUT_MS}).timeoutMs, MAX_OPERATION_TIMEOUT_MS);
  refusal(() => validateOperation({...operation(), version: 2}), 'SCHEMA_MISMATCH');
});

test('canonical metadata encoding is insertion-order independent and rejects executable or lossy values', () => {
  const checked = validateOperation(operation());
  const reversed = Object.fromEntries(Object.entries(checked).reverse());
  assert.equal(canonicalJson(checked), canonicalJson(reversed));
  assert.deepEqual(JSON.parse(canonicalJson(checked)), checked);
  let invoked = 0;
  const getter = {get code() { invoked++; throw new Error(secret); }};
  const cycle = {}; cycle.self = cycle;
  const sparse = new Array(2); sparse[1] = 'NONE';
  const decorated = ['NONE']; decorated.prompt = secret;
  for (const value of [getter, cycle, sparse, decorated, undefined, BigInt(1), NaN, Infinity, -0,
    {x: undefined}, {toJSON() { invoked++; throw new Error(secret); }},
    new Proxy({}, {ownKeys() { invoked++; throw new Error(secret); }})]) refusal(() => canonicalJson(value));
  assert.equal(invoked, 0);
});

test('safe error projections and closed reason codes never persist exception details', () => {
  for (const code of CONTROL_ERROR_CODES) {
    const projection = safeControlError(new ControlError(code));
    assert.equal(projection.code, code);
    assert.equal(projection.message, 'Control foundation request refused');
    assert.ok(Object.isFrozen(projection));
  }
  const raw = new Error(secret, {cause: {prompt: secret}});
  raw.code = secret;
  assert.deepEqual(safeControlError(raw), {code: 'CONTROL_ERROR', message: 'Control foundation request refused'});
  assert.equal(new ControlError(secret).code, 'CONTROL_ERROR');
  for (const code of CONTROL_REASON_CODES) {
    const event = sanitizeMetadataEvent({version: 1, eventId: id(50), operationId: id(1), code, atMs: 1000});
    assert.equal(event.code, code);
    assert.ok(Object.isFrozen(event));
  }
  const event = {version: 1, eventId: id(50), operationId: id(1), code: 'NONE', atMs: 1000};
  refusal(() => sanitizeMetadataEvent({...event, error: raw}));
  refusal(() => sanitizeMetadataEvent({...event, code: secret}));
});

test('safe error projection cannot invoke behavior on hostile exception objects', () => {
  let invoked = 0;
  const proxy = new Proxy({}, {get() { invoked++; throw new Error(secret); },
    getPrototypeOf() { invoked++; throw new Error(secret); }});
  const accessor = Object.create(ControlError.prototype);
  Object.defineProperty(accessor, 'code', {get() { invoked++; throw new Error(secret); }});
  for (const value of [proxy, Object.create(proxy), accessor, null, undefined, secret]) {
    assert.equal(isControlError(value), false);
    assert.deepEqual(safeControlError(value), {code: 'CONTROL_ERROR', message: 'Control foundation request refused'});
  }
  assert.equal(isControlError(new ControlError('INVALID_INPUT')), true);
  assert.equal(invoked, 0);
});

test('native request references preserve numeric versus string identity and reject content-shaped IDs', () => {
  const numeric = validateNativeReference({requestId: {type: 'number', value: 7}});
  const textual = validateNativeReference({requestId: {type: 'string', value: '7'}});
  assert.notEqual(canonicalJson(numeric), canonicalJson(textual));
  assert.equal(numeric.requestId.value, 7);
  assert.equal(textual.requestId.value, '7');
  assert.ok(Object.isFrozen(textual.requestId));
  assert.equal(validateNativeReference({threadId: 'thread:abc-123'}).threadId, 'thread:abc-123');
  for (const value of [{}, null, {requestId: {type: 'number', value: '7'}},
    {requestId: {type: 'string', value: 7}}, {requestId: {type: 'number', value: -0}},
    {requestId: {type: 'number', value: Number.MAX_SAFE_INTEGER + 1}},
    {threadId: 'C:\\private\\prompt'}, {threadId: 'prompt with spaces'},
    {turnId: 'x'.repeat(129)}, {requestId: {type: 'string', value: '7', prompt: secret}},
    {itemId: 'item-7', rawOutput: secret}]) refusal(() => validateNativeReference(value));
});

test('native approval and question schemas preserve broker, native, connection and consent identities', () => {
  const request = validateNativeRequest(nativeRequest());
  assert.equal(request.requestId, id(30));
  assert.equal(request.native.requestId.value, 7);
  assert.equal(request.context.connectionEpoch, id(20));
  assert.equal(request.consentRevision, 0);
  assert.ok(Object.isFrozen(request.availableDecisions));
  assert.equal(validateRequestDecision(decision()).expectedConsentRevision, 0);
  refusal(() => validateNativeRequest({...nativeRequest(), native: {itemId: 'item-7'}}));
  refusal(() => validateNativeRequest({...nativeRequest(), command: secret}));
  refusal(() => validateNativeRequest({...nativeRequest(), availableDecisions: ['ALLOW_ONCE', 'ALLOW_ONCE']}));
  refusal(() => validateNativeRequest({...nativeRequest(), availableDecisions: ['RESPOND']}));
  refusal(() => validateNativeRequest({...nativeRequest(), kind: 'USER_INPUT'}));
  assert.equal(validateNativeRequest({...nativeRequest(), kind: 'USER_INPUT',
    availableDecisions: ['RESPOND', 'CANCEL']}).kind, 'USER_INPUT');
  refusal(() => validateRequestDecision({...decision(), answer: secret}));
  refusal(() => validateRequestDecision({...decision(), expectedConsentRevision: -1}));
});

test('grant schemas cannot enable the foundation runtime or import prototype authority objects', () => {
  const checked = validateControlGrant(grant());
  assert.equal(checked.enabled, true);
  assert.ok(Object.isFrozen(checked.actions));
  refusal(() => validateControlGrant({...grant(), actions: ['turn.start', 'turn.start']}));
  refusal(() => validateControlGrant({...grant(), cwd: secret}));
  const actions = ['turn.start'];
  let invoked = 0;
  Object.defineProperty(actions, '0', {enumerable: true, get() { invoked++; throw new Error(secret); }});
  refusal(() => validateControlGrant({...grant(), actions}));
  assert.equal(invoked, 0);
  const capability = foundationCapabilities({enabled: true, grant: checked});
  assert.equal(capability.enabled, false);
  assert.equal(capability.authorizationEnforced, false);
  assert.equal(capability.nativeQualified, false);
  assert.equal(capability.terminalQualified, false);
  for (const action of capability.operations) {
    assert.equal(action.enabled, false);
    assert.equal(action.implemented, false);
    assert.equal(action.status, 'UNAVAILABLE');
    assert.ok(Object.isFrozen(action));
  }
  assert.throws(() => { capability.enabled = true; }, TypeError);
});

test('terminal metadata requires distinct ownership, epoch, attachment and input lease identities', () => {
  const ref = validateTerminalReference(terminal());
  assert.equal(ref.ownerId, id(3));
  assert.equal(ref.epoch, id(41));
  assert.equal(ref.ownershipFence, 1);
  const input = validateTerminalFrameMetadata(frame());
  assert.equal(input.inputLeaseId, id(43));
  assert.equal(input.attachmentId, id(42));
  refusal(() => validateTerminalFrameMetadata({...frame(), inputLeaseId: null}));
  refusal(() => validateTerminalFrameMetadata({...frame(), bytes: Buffer.from(secret)}));
  refusal(() => validateTerminalFrameMetadata({...frame(), byteLength: MAX_TERMINAL_FRAME_BYTES + 1}));
  refusal(() => validateTerminalFrameMetadata({...frame(), sequence: -1}));
  refusal(() => validateTerminalReference({...terminal(), ownershipFence: 0}));
  refusal(() => validateTerminalReference({...terminal(), shell: secret}));
  assert.equal(validateTerminalFrameMetadata({...frame(), type: 'OUTPUT', inputLeaseId: null}).type, 'OUTPUT');
  refusal(() => validateTerminalFrameMetadata({...frame(), type: 'OUTPUT'}));
  assert.equal(validateTerminalFrameMetadata({...frame(), type: 'RESIZE', byteLength: 0,
    columns: 120, rows: 40}).columns, 120);
  refusal(() => validateTerminalFrameMetadata({...frame(), type: 'RESIZE', byteLength: 0, columns: 120, rows: null}));
  assert.equal(validateTerminalFrameMetadata({...frame(), type: 'ACK', byteLength: 0,
    inputLeaseId: null, acknowledgedSequence: 0}).acknowledgedSequence, 0);
});

test('dispatch intent is a mandatory boundary before native acceptance or completion', () => {
  for (const type of ['NATIVE_ACCEPTED', 'RUNNING', 'INTERRUPT_REQUESTED', 'COMPLETED', 'FAILED', 'INTERRUPTED']) {
    refusal(() => transitionOperationState('ADMITTED', type), 'INVALID_TRANSITION');
  }
  let state = 'ADMITTED';
  for (const event of ['DISPATCH_INTENT', 'NATIVE_ACCEPTED', 'RUNNING', 'INTERRUPT_REQUESTED', 'INTERRUPTED']) {
    const projected = transitionOperationState(state, event);
    assert.equal(projected.state, event);
    assert.equal(projected.late, false);
    assert.ok(Object.isFrozen(projected));
    state = projected.state;
  }
});

test('final-before-ACK and late progress preserve native terminal state', () => {
  for (const terminalState of ['COMPLETED', 'FAILED', 'INTERRUPTED']) {
    assert.equal(transitionOperationState('DISPATCH_INTENT', terminalState).state, terminalState);
    for (const late of ['NATIVE_ACCEPTED', 'RUNNING', 'INTERRUPT_REQUESTED', terminalState]) {
      assert.deepEqual(transitionOperationState(terminalState, late), {state: terminalState, late: true});
    }
    refusal(() => transitionOperationState(terminalState, 'DISPATCH_INTENT'), 'INVALID_TRANSITION');
  }
  assert.deepEqual(transitionOperationState('INTERRUPT_REQUESTED', 'RUNNING'), {state: 'INTERRUPT_REQUESTED', late: true});
  assert.deepEqual(transitionOperationState('RUNNING', 'NATIVE_ACCEPTED'), {state: 'RUNNING', late: true});
});

test('cancel, expiry and lost authority never assert no effect after dispatch intent', () => {
  for (const type of ['CANCELLED', 'EXPIRED']) {
    assert.equal(transitionOperationState('ADMITTED', type).state, type);
    for (const state of ['DISPATCH_INTENT', 'NATIVE_ACCEPTED', 'RUNNING', 'INTERRUPT_REQUESTED']) {
      assert.equal(transitionOperationState(state, type).state, 'UNKNOWN');
    }
  }
  assert.equal(transitionOperationState('ADMITTED', 'NOT_DISPATCHED').state, 'NOT_DISPATCHED');
  for (const state of ['DISPATCH_INTENT', 'NATIVE_ACCEPTED', 'RUNNING', 'INTERRUPT_REQUESTED']) {
    refusal(() => transitionOperationState(state, 'NOT_DISPATCHED'), 'INVALID_TRANSITION');
  }
});

test('UNKNOWN cannot redispatch or settle from an unqualified late native observation', () => {
  for (const type of ['NATIVE_ACCEPTED', 'RUNNING', 'INTERRUPT_REQUESTED', 'COMPLETED', 'FAILED',
    'INTERRUPTED', 'CANCELLED', 'EXPIRED', 'UNKNOWN']) {
    assert.deepEqual(transitionOperationState('UNKNOWN', type), {state: 'UNKNOWN', late: true});
  }
  refusal(() => transitionOperationState('UNKNOWN', 'DISPATCH_INTENT'), 'INVALID_TRANSITION');
  refusal(() => transitionOperationState('UNKNOWN', 'NOT_DISPATCHED'), 'INVALID_TRANSITION');
  for (const final of ['COMPLETED', 'FAILED', 'INTERRUPTED', 'NOT_DISPATCHED']) {
    assert.deepEqual(transitionOperationState('UNKNOWN', `RECONCILED_${final}`), {state: final, late: false});
    refusal(() => transitionOperationState('RUNNING', `RECONCILED_${final}`), 'INVALID_TRANSITION');
  }
  // The journal must authenticate reconciliation evidence; this pure helper cannot do so.
});

test('terminal operations cannot be reopened and contradictory native events cannot erase no-dispatch proof', () => {
  for (const state of TERMINAL_OPERATION_STATES) {
    for (const event of ['DISPATCH_INTENT', 'UNKNOWN']) refusal(() => transitionOperationState(state, event), 'INVALID_TRANSITION');
  }
  for (const state of ['CANCELLED', 'EXPIRED', 'NOT_DISPATCHED']) {
    for (const event of ['NATIVE_ACCEPTED', 'RUNNING', 'COMPLETED']) refusal(() => transitionOperationState(state, event), 'INVALID_TRANSITION');
  }
  for (const state of OPERATION_STATES) refusal(() => transitionOperationState(state, secret), 'INVALID_TRANSITION');
});

test('separate transport and consent lifetimes preserve consent until its own resolution or invalidation', () => {
  let now = 0;
  const store = createTransientContentStore({clock: () => now});
  store.reserve(reservation(100, {ttlMs: 10}));
  store.reserve(reservation(101, {kind: 'turn-consent', ttlMs: 50}));
  store.reserve(reservation(102, {kind: 'approval-consent', ttlMs: 100}));
  assert.equal(store.consume(id(100)).toString(), secret);
  refusal(() => store.read(id(100)), 'REPLAY_UNAVAILABLE');
  assert.equal(store.read(id(101)).toString(), secret);
  now = 50;
  assert.equal(store.sweep(), 1);
  refusal(() => store.read(id(101)), 'REPLAY_UNAVAILABLE');
  assert.equal(store.read(id(102)).toString(), secret);
  assert.equal(store.invalidateScope(id(80)), 1);
  refusal(() => store.read(id(102)), 'REPLAY_UNAVAILABLE');
  assert.equal(store.stats().bytes, 0);
  store.close();
});

test('duplicate transient reservations cannot replace, extend expiry, change scope or rehydrate content', () => {
  let now = 0;
  const store = createTransientContentStore({clock: () => now});
  assert.equal(store.reserve(reservation(110, {ttlMs: 10})).created, true);
  now = 9;
  assert.deepEqual(store.reserve(reservation(110, {bytes: Buffer.from('replacement'),
    scopeId: id(81), kind: 'turn-consent', ttlMs: 100})), {created: false, id: id(110), available: true});
  assert.equal(store.read(id(110)).toString(), secret);
  assert.equal(store.invalidateScope(id(81)), 0);
  now = 10;
  assert.deepEqual(store.reserve(reservation(110)), {created: false, id: id(110), available: false});
  refusal(() => store.read(id(110)), 'REPLAY_UNAVAILABLE');
  store.reserve(reservation(111)); store.consume(id(111));
  assert.equal(store.reserve(reservation(111)).available, false);
  store.reserve(reservation(112)); store.invalidateScope(id(80));
  assert.equal(store.reserve(reservation(112)).available, false);
  assert.equal(store.stats().reservations, 3);
  store.close();
});

test('restart tombstones prevent content rehydration while a genuinely new reservation remains possible', () => {
  const store = createTransientContentStore({retiredIds: [id(120)], clock: () => 1});
  assert.deepEqual(store.reserve(reservation(120)), {created: false, id: id(120), available: false});
  refusal(() => store.read(id(120)), 'REPLAY_UNAVAILABLE');
  assert.equal(store.reserve(reservation(121)).created, true);
  store.close();
  // Supplying retired IDs requires the durable journal. This store does not claim restart authority itself.
});

test('transient byte, entry, reservation and TTL limits fail closed without evicting live content', () => {
  const store = createTransientContentStore({maxBytes: 4, maxEntries: 2, maxReservations: 3,
    maxTtlMs: 100, clock: () => 1});
  const small = n => reservation(n, {bytes: Buffer.from('ab')});
  store.reserve(small(130)); store.reserve(small(131));
  refusal(() => store.reserve(small(132)), 'CAPACITY');
  assert.equal(store.read(id(130)).toString(), 'ab');
  assert.equal(store.stats().bytes, 4);
  store.remove(id(130));
  store.reserve(small(132));
  store.remove(id(131)); store.remove(id(132));
  refusal(() => store.reserve(small(133)), 'CAPACITY');
  assert.equal(store.stats().reservations, 3);
  refusal(() => store.reserve(reservation(134, {bytes: Buffer.from('abcde')})));
  refusal(() => store.reserve(reservation(134, {bytes: Buffer.from('x'), ttlMs: 101})));
  assert.equal(store.stats().entries, 0);
  store.close();
});

test('transient copies are isolated and content is absent from exposed metadata and closed state', () => {
  const store = createTransientContentStore({clock: () => 1});
  const source = Buffer.from(secret);
  store.reserve(reservation(140, {bytes: source}));
  source.fill(0);
  const read = store.read(id(140));
  assert.equal(read.toString(), secret);
  read.fill(0);
  assert.equal(store.read(id(140)).toString(), secret);
  assert.equal(JSON.stringify(store.stats()).includes(secret), false);
  assert.equal(JSON.stringify(store).includes(secret), false);
  store.close(); store.close();
  assert.equal(store.stats().bytes, 0);
  assert.equal(store.stats().entries, 0);
  assert.equal(store.stats().closed, true);
  refusal(() => store.read(id(140)), 'CLOSED');
  refusal(() => store.reserve(reservation(141)), 'CLOSED');
});

test('transient Buffer copies ignore caller-supplied accessors and conversion hooks', () => {
  const store = createTransientContentStore({clock: () => 1});
  const source = Buffer.from(secret);
  let invoked = 0;
  Object.defineProperty(source, 'length', {get() { invoked++; throw new Error(secret); }});
  Object.defineProperty(source, 'valueOf', {value() { invoked++; throw new Error(secret); }});
  Object.defineProperty(source, Symbol.iterator, {value() { invoked++; throw new Error(secret); }});
  store.reserve(reservation(145, {bytes: source}));
  assert.equal(store.read(id(145)).toString(), secret);
  const proxy = new Proxy(source, {get() { invoked++; throw new Error(secret); }});
  for (const bytes of [proxy, Object.create(Buffer.prototype), new Uint8Array(1)]) {
    refusal(() => store.reserve(reservation(146, {bytes})));
  }
  assert.equal(invoked, 0);
  store.close();
});

test('monotonic clock failure clears live content and safely closes the transient store', () => {
  let now = 5;
  const store = createTransientContentStore({clock: () => now});
  store.reserve(reservation(150));
  now = 4;
  refusal(() => store.sweep(), 'CLOCK_INVALID');
  assert.equal(store.stats().closed, true);
  assert.equal(store.stats().bytes, 0);
  refusal(() => store.read(id(150)), 'CLOSED');
  let fail = false;
  const throwing = createTransientContentStore({clock: () => { if (fail) throw new Error(secret); return 1; }});
  throwing.reserve(reservation(151)); fail = true;
  refusal(() => throwing.sweep(), 'CLOCK_INVALID');
  assert.equal(throwing.stats().entries, 0);
});

test('scope invalidation revokes all affected content while preserving unrelated bounded content', () => {
  const store = createTransientContentStore({clock: () => 1});
  store.reserve(reservation(160, {kind: 'transport'}));
  store.reserve(reservation(161, {kind: 'turn-consent'}));
  store.reserve(reservation(162, {kind: 'approval-consent'}));
  store.reserve(reservation(163, {kind: 'approval-consent', scopeId: id(81)}));
  assert.equal(store.invalidateScope(id(80)), 3);
  for (const n of [160, 161, 162]) {
    refusal(() => store.read(id(n)), 'REPLAY_UNAVAILABLE');
    assert.equal(store.reserve(reservation(n)).available, false);
  }
  assert.equal(store.read(id(163)).toString(), secret);
  store.close();
});
