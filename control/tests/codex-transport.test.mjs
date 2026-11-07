import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {CodexStdioTransport} from '../providers/codex/transport.mjs';
import {ControlError} from '../lib/errors.mjs';

const guard = () => {};
const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const refused = (promise, code) => assert.rejects(promise, error => {
  assert.ok(error instanceof ControlError);
  assert.equal(error.message, 'Control foundation request refused');
  if (code) assert.equal(error.code, code);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
});

class Wire extends EventEmitter {
  frames = []; callbacks = []; ready = true; destroyed = false;
  write(frame, callback) {
    this.frames.push(Buffer.from(frame)); this.callbacks.push(callback); return this.ready;
  }
  finish(error) { const cb = this.callbacks.shift(); assert.ok(cb); cb(error); }
  destroy() { this.destroyed = true; this.emit('close'); }
}
function setup(t, options = {}) {
  const readable = new PassThrough();
  const writable = new Wire();
  const closes = [];
  const transport = new CodexStdioTransport({readable, writable,
    onClose: error => { closes.push(error); }, ...options});
  t.after(() => transport.close());
  const send = value => readable.write(Buffer.from(JSON.stringify(value) + '\n'));
  const request = (params = {}, beforeWrite = guard) => transport.request('account/read', params, {beforeWrite});
  const frame = index => JSON.parse(writable.frames[index].toString('utf8'));
  return {readable, writable, transport, closes, send, request, frame};
}

test('correlates out-of-order replies, copies input, and omits JSON-RPC version', async t => {
  const h = setup(t); const input = {nested: ['original']};
  const one = h.request(input); input.nested[0] = 'changed';
  const two = h.transport.request('model/list', {}, {beforeWrite: guard});
  h.writable.finish(); h.writable.finish();
  assert.deepEqual(h.frame(0), {id: 1, method: 'account/read', params: {nested: ['original']}});
  assert.equal(h.frame(1).id, 2); assert.equal(Object.hasOwn(h.frame(1), 'jsonrpc'), false);
  h.send({id: 2, result: ['second']}); h.send({id: 1, result: {first: true}});
  assert.deepEqual(await two, ['second']); assert.deepEqual(await one, {first: true});
  assert.equal(h.transport.closed, false);
});

test('all closed-allowlist methods dispatch once; initialized has no ID', async t => {
  const h = setup(t);
  for (const method of ['initialize', 'account/read', 'config/read', 'model/list',
    'thread/start', 'thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt']) {
    const result = h.transport.request(method, {}, {beforeWrite: guard});
    h.writable.finish(); const last = h.frame(h.writable.frames.length - 1);
    h.send({id: last.id, result: null}); assert.equal(await result, null);
  }
  const initialized = h.transport.initialized({beforeWrite: guard});
  assert.deepEqual(h.frame(9), {method: 'initialized'});
  h.writable.finish(); await initialized;
  assert.equal(h.writable.frames.length, 10);
});

test('requires guards, rejects unsupported methods, preserves sequence after authority refusal', async t => {
  const h = setup(t);
  await refused(h.transport.request('account/read', {}), 'INVALID_INPUT');
  await refused(h.transport.initialized(), 'INVALID_INPUT');
  await refused(h.transport.request('shell/exec', {}, {beforeWrite: guard}), 'INVALID_INPUT');
  const error = new ControlError('CONTROL_DISABLED');
  await assert.rejects(h.request({}, () => { throw error; }), value => value === error);
  assert.equal(h.writable.frames.length, 0); assert.equal(h.transport.closed, false);
  const next = h.request(); h.writable.finish();
  assert.ok(h.frame(0).id > 1); h.send({id: h.frame(0).id, result: null}); await next;
});

test('guard executes only after callback AND drain, immediately before the write', async t => {
  const h = setup(t); h.writable.ready = false;
  const order = [];
  const write = h.writable.write.bind(h.writable);
  h.writable.write = (frame, cb) => { order.push('write'); return write(frame, cb); };
  const first = h.request({}, () => { order.push('guard1'); });
  let authority = true;
  const second = h.request({}, () => { order.push('guard2'); if (!authority) throw new ControlError('CONTROL_DISABLED'); });
  const secondCheck = refused(second, 'CONTROL_DISABLED');
  authority = false; h.writable.finish();
  assert.deepEqual(order, ['guard1', 'write']);
  h.writable.emit('drain'); await secondCheck;
  assert.deepEqual(order, ['guard1', 'write', 'guard2']);
  h.send({id: 1, result: null}); await first;
  assert.equal(h.writable.frames.length, 1); assert.equal(h.transport.closed, false);
});

test('rejects asynchronous guards and consumes rejected native promise', async t => {
  const h = setup(t);
  await refused(h.request({}, async () => { throw new Error('PRIVATE'); }), 'INVALID_INPUT');
  let invoked = false;
  await refused(h.request({}, () => ({then() { invoked = true; }})), 'INVALID_INPUT');
  await tick(); assert.equal(invoked, false); assert.equal(h.writable.frames.length, 0);
  assert.equal(h.transport.closed, false);
});

test('defensive JSON copy rejects descriptors, hooks, proxies, cycles, decorations and bounds', async t => {
  const h = setup(t); let touched = 0;
  const getter = Object.defineProperty({}, 'secret', {enumerable: true, get() { touched++; return 1; }});
  const proxy = new Proxy({}, {ownKeys() { touched++; throw new Error('PRIVATE'); }});
  const cyclic = {}; cyclic.child = cyclic;
  const hidden = Object.defineProperty({}, 'hidden', {value: 1});
  const array = [1]; array.extra = 2;
  const symbol = {[Symbol('secret')]: 1};
  const hook = {toJSON() { touched++; return {}; }};
  let deep = {}; for (let i = 0; i < 34; i++) deep = {child: deep};
  const wide = Object.fromEntries(Array.from({length: 129}, (_, i) => ['k' + i, null]));
  for (const value of [getter, proxy, cyclic, hidden, array, symbol, hook, new Date(),
    Object.create(null), {bad: undefined}, {bad: Infinity}, {bad: -0}, new Array(2), deep, wide,
    Array(1025).fill(null), JSON.parse('{"__proto__":{}}')]) await refused(h.request(value));
  assert.equal(touched, 0); assert.equal(h.writable.frames.length, 0);
});

test('pending cap and immutable copied queued payload', async t => {
  const h = setup(t, {maxPending: 2});
  const first = h.request(); const params = {value: 'before'}; const second = h.request(params);
  params.value = 'after'; await refused(h.request(), 'CAPACITY');
  h.writable.finish(); assert.equal(h.frame(1).params.value, 'before'); h.writable.finish();
  h.send({id: h.frame(0).id, result: 1}); h.send({id: h.frame(1).id, result: 2});
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
});

test('output frame and combined queued-byte budgets refuse without closing', async t => {
  const h = setup(t, {maxFrameBytes: 128, maxBufferedBytes: 160});
  await refused(h.request({value: 'x'.repeat(200)}), 'CAPACITY');
  const first = h.request({value: 'x'.repeat(40)});
  await refused(h.request({value: 'x'.repeat(40)}), 'CAPACITY');
  assert.equal(h.writable.frames.length, 1); assert.equal(h.transport.closed, false);
  h.writable.finish(); h.send({id: h.frame(0).id, result: null}); await first;
});

test('queued timeouts expire before guard/write; stalled timed-out write still occupies capacity', async t => {
  const h = setup(t, {maxPending: 2, timeoutMs: 20});
  let guarded = false;
  const first = refused(h.request(), 'EXPIRED');
  const second = refused(h.request({}, () => { guarded = true; }), 'EXPIRED');
  await Promise.all([first, second]);
  assert.equal(guarded, false); assert.equal(h.writable.frames.length, 1);
  const third = refused(h.request(), 'EXPIRED'); await third;
  assert.equal(h.writable.frames.length, 1); assert.equal(h.transport.closed, false);
});

test('unresolved expired write remains bounded until callback, with no retry', async t => {
  const h = setup(t, {maxPending: 1, timeoutMs: 15});
  await refused(h.request(), 'EXPIRED');
  for (let i = 0; i < 10; i++) await refused(h.request(), 'CAPACITY');
  assert.equal(h.writable.frames.length, 1);
  h.writable.finish(); const next = h.request(); h.writable.finish();
  const id = h.frame(1).id; h.send({id, result: true}); assert.equal(await next, true);
  assert.equal(h.writable.frames.length, 2);
});

test('lost completed write times out once; late reply closes without resend', async t => {
  const h = setup(t, {timeoutMs: 15});
  const request = refused(h.request(), 'EXPIRED'); h.writable.finish(); await request;
  assert.equal(h.writable.frames.length, 1); h.send({id: 1, result: 'late'});
  assert.equal(h.transport.closed, true); assert.equal(h.closes.length, 1);
});

test('fatal UTF-8 permits every byte split including a multibyte character and CRLF', async t => {
  const h = setup(t); const request = h.request(); h.writable.finish();
  const line = Buffer.from('{"id":1,"result":"é🛰"}\r\n');
  for (const byte of line) h.readable.write(Buffer.from([byte]));
  assert.equal(await request, 'é🛰'); assert.equal(h.transport.closed, false);
});

for (const [name, bytes] of [
  ['empty line', Buffer.from('\n')], ['malformed JSON', Buffer.from('{\n')],
  ['invalid UTF-8', Buffer.from([0x22, 0xc3, 0x28, 0x22, 10])],
  ['unfinished UTF-8 at newline', Buffer.from([0x22, 0xf0, 10])],
  ['BOM', Buffer.from('\ufeff{}\n')], ['oversized unfinished line', Buffer.alloc(65, 120)]
]) test(name + ' closes and settles pending', async t => {
  const h = setup(t, {maxFrameBytes: 64});
  const pending = refused(h.request()); h.readable.write(bytes); await pending;
  assert.equal(h.transport.closed, true); assert.equal(h.closes.length, 1);
});

test('read chunk budget includes pending output bytes', async t => {
  const h = setup(t, {maxFrameBytes: 128, maxBufferedBytes: 128});
  const pending = refused(h.request(), 'CAPACITY');
  h.readable.write(Buffer.alloc(100, 32)); await pending; assert.equal(h.transport.closed, true);
});

for (const [name, response] of [
  ['string ID is distinct', {id: '1', result: null}], ['unknown ID', {id: 999, result: null}],
  ['both result and error', {id: 1, result: null, error: {code: 1, message: 'PRIVATE'}}],
  ['neither result nor error', {id: 1}], ['decorated response', {id: 1, result: null, jsonrpc: '2.0'}],
  ['null ID', {id: null, result: null}], ['unsafe ID', {id: 9007199254740992, result: null}],
  ['decorated error', {id: 1, error: {code: 1, message: 'PRIVATE', extra: true}}],
  ['invalid error schema', {id: 1, error: {code: 'PRIVATE', message: 'PRIVATE'}}],
  ['decorated notification', {method: 'event', params: {}, extra: true}],
  ['nested prototype key', {id: 1, result: JSON.parse('{"constructor":{}}')}]
]) test(name + ' fails closed', async t => {
  const h = setup(t); const pending = refused(h.request()); h.writable.finish();
  h.send(response); await pending; assert.equal(h.transport.closed, true);
});

test('duplicate response and response for a queued unsent ID fail closed', async t => {
  const h = setup(t); const first = h.request(); h.writable.finish();
  h.send({id: 1, result: null}); await first; h.send({id: 1, result: null});
  assert.equal(h.transport.closed, true);
  const other = setup(t); const a = refused(other.request()); const b = refused(other.request());
  other.send({id: 2, result: null}); await Promise.all([a, b]); assert.equal(other.transport.closed, true);
});

test('native errors are fixed ControlError values without raw content; channel stays usable', async t => {
  const h = setup(t); const pending = refused(h.request(), 'CONTROL_ERROR'); h.writable.finish();
  h.send({id: 1, error: {code: -32000, message: 'PRIVATE NATIVE MESSAGE', data: {secret: 'PRIVATE'}}});
  await pending; assert.equal(h.transport.closed, false);
  const next = h.request(); h.writable.finish(); h.send({id: 2, result: true}); await next;
});

test('notification delivery and server requests expose only metadata, never write replies', async t => {
  const notifications = [], serverRequests = [];
  const h = setup(t, {onNotification: value => { notifications.push(value); },
    onServerRequest: value => { serverRequests.push(value); }});
  h.send({method: 'thread/updated', params: {value: 'transient'}});
  assert.deepEqual(notifications, [{method: 'thread/updated', params: {value: 'transient'}}]);
  h.send({method: 'approval', id: 1, params: {secret: 'PRIVATE'}});
  h.send({method: 'approval', id: '1', params: {secret: 'PRIVATE'}});
  assert.deepEqual(serverRequests, [{method: 'approval', id: 1}, {method: 'approval', id: '1'}]);
  assert.ok(serverRequests.every(Object.isFrozen)); assert.equal(h.writable.frames.length, 0);
  for (let id = 2; id <= 7; id++) h.send({method: 'approval', id});
  assert.equal(h.transport.closed, false); h.send({method: 'approval', id: 8});
  assert.equal(h.transport.closed, true); assert.equal(serverRequests.length, 8);
  assert.equal(h.writable.frames.length, 0);
});

test('duplicate server request closes without automatic reply', t => {
  const h = setup(t); h.send({method: 'approval', id: 1}); h.send({method: 'approval', id: 1});
  assert.equal(h.transport.closed, true); assert.equal(h.writable.frames.length, 0);
});

for (const callback of [() => { throw new Error('PRIVATE'); }, async () => { throw new Error('PRIVATE'); },
  () => ({then() { throw new Error('MUST NOT EXECUTE'); }})]) {
  for (const kind of ['notification', 'server']) test(kind + ' callback throw/async closes safely', async t => {
    const h = setup(t, kind === 'notification' ? {onNotification: callback} : {onServerRequest: callback});
    const pending = refused(h.request());
    h.send(kind === 'notification' ? {method: 'event'} : {method: 'approval', id: 'server'});
    await pending; await tick(); assert.equal(h.transport.closed, true);
    assert.equal(h.closes.length, 1);
  });
}

for (const source of ['end', 'read-close', 'read-error', 'write-close', 'write-error', 'explicit']) {
  test(source + ' settles everything and detaches readers/timers', async t => {
    const h = setup(t, {timeoutMs: 15});
    const a = refused(h.request(), 'CLOSED'); const b = refused(h.request(), 'CLOSED');
    const c = refused(h.transport.initialized({beforeWrite: guard}), 'CLOSED');
    if (source === 'end') h.readable.end(Buffer.from('{"unfinished":'));
    else if (source === 'read-close') h.readable.emit('close');
    else if (source === 'read-error') h.readable.emit('error', new Error('PRIVATE'));
    else if (source === 'write-close') h.writable.emit('close');
    else if (source === 'write-error') h.writable.emit('error', new Error('PRIVATE'));
    else h.transport.close();
    await Promise.all([a, b, c]);
    h.transport.close(); h.writable.finish(); await sleep(25);
    assert.equal(h.closes.length, 1); assert.ok(h.closes[0] instanceof ControlError);
    assert.equal(h.readable.listenerCount('data'), 0); assert.equal(h.readable.listenerCount('end'), 0);
    assert.equal(h.writable.listenerCount('drain'), 0); assert.equal(h.writable.frames.length, 1);
    await refused(h.request(), 'CLOSED'); await refused(h.transport.initialized({beforeWrite: guard}), 'CLOSED');
  });
}

test('real Node writable error ordering and throwing close callback stay contained', async t => {
  const readable = new PassThrough();
  const writable = new Writable({write(_chunk, _encoding, callback) { callback(new Error('PRIVATE')); }});
  let closes = 0;
  const transport = new CodexStdioTransport({readable, writable, onClose(error) {
    closes++; assert.ok(error instanceof ControlError); throw new Error('PRIVATE');
  }});
  t.after(() => transport.close());
  await refused(transport.request('account/read', {}, {beforeWrite: guard}), 'CLOSED');
  await tick(); assert.equal(transport.closed, true); assert.equal(closes, 1);
});

test('invalid configuration and already closed streams reject safely', t => {
  assert.throws(() => new CodexStdioTransport({readable: new PassThrough(), writable: new Wire(), timeoutMs: 0}), ControlError);
  const readable = new PassThrough(); readable.destroy();
  const h = setup(t, {readable}); assert.equal(h.transport.closed, true); assert.equal(h.closes.length, 1);
});

test('native startup notifications with emittedAtMs do not close the initialized handshake', async t => {
  const notifications = [];
  const h = setup(t, {onNotification: value => { notifications.push(value); }});
  const initialized = h.transport.request('initialize', {}, {beforeWrite: guard});
  h.writable.finish();
  h.readable.write(Buffer.from([
    {id: 1, result: {userAgent: 'TEST_ONLY'}},
    {method: 'configWarning', params: {}, emittedAtMs: 1792899924486},
    {method: 'remoteControl/status/changed', params: {}, emittedAtMs: 1792899924487}
  ].map(value => JSON.stringify(value) + '\n').join('')));
  await initialized;
  assert.equal(h.transport.closed, false);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].emittedAtMs, 1792899924486);
  const ack = h.transport.initialized({beforeWrite: guard});
  h.writable.finish(); await ack;
  assert.deepEqual(h.frame(1), {method: 'initialized'});
  const probe = h.request(); h.writable.finish();
  h.send({id: h.frame(2).id, result: null}); await probe;
  assert.equal(h.closes.length, 0);
});

test('notification emittedAtMs accepts optional safe integers without granting authority', t => {
  const notifications = [];
  const h = setup(t, {onNotification: value => { notifications.push(value); }});
  for (const emittedAtMs of [0, -1, Number.MAX_SAFE_INTEGER]) {
    h.send({method: 'configWarning', params: {}, emittedAtMs});
  }
  h.send({method: 'configWarning', params: {}});
  assert.equal(notifications.length, 4);
  assert.equal(h.transport.closed, false);
  assert.equal(h.writable.frames.length, 0);
});

for (const emittedAtMs of [null, '1792899924486', true, {}, [], 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test('malformed notification timestamp is refused: ' + JSON.stringify(emittedAtMs), t => {
    let delivered = false;
    const h = setup(t, {onNotification: () => { delivered = true; }});
    h.send({method: 'configWarning', params: {}, emittedAtMs});
    assert.equal(h.transport.closed, true);
    assert.equal(h.closes[0].code, 'SCHEMA_MISMATCH');
    assert.equal(delivered, false);
  });
}

for (const envelope of [
  {method: 'approval', id: 3, params: {}, emittedAtMs: 1},
  {method: 'configWarning', params: {}, emittedAtMs: 1, unexpected: true},
  {id: 1, result: null, emittedAtMs: 1}
]) test('timestamp exception does not widen request/response/unknown-field shapes: ' + JSON.stringify(envelope), async t => {
  let delivered = false;
  const h = setup(t, {onServerRequest: () => { delivered = true; }, onNotification: () => { delivered = true; }});
  const pending = refused(h.request(), 'SCHEMA_MISMATCH'); h.writable.finish();
  h.send(envelope); await pending;
  assert.equal(h.transport.closed, true);
  assert.equal(delivered, false);
});