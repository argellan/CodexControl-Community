import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import {PassThrough, Writable} from 'node:stream';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {BoundedFrameChannel} from '../transport/framing.mjs';
import {acceptHostRequest, connectHostTransport} from '../transport/https-host.mjs';
import {ControlError} from '../lib/errors.mjs';
import {strictRecord, integer} from '../lib/privacy.mjs';
import {TEST_ONLY_KEY, TEST_ONLY_CERT, TEST_ONLY_WRONG_CA, TEST_ONLY_PIN} from './fixtures/transport-tls.mjs';

const PATH = '/api/control/v1/host-channel';
const TYPE = 'application/x-codexcontrol-frame';
const immediate = () => new Promise(resolve => setImmediate(resolve));
const validate = value => {
  strictRecord(value, ['n']);
  return Object.freeze({n: integer(value.n, 0, 1_000_000)});
};
const wire = value => {
  const bytes = Buffer.from(JSON.stringify(value)), packet = Buffer.alloc(bytes.length + 4);
  packet.writeUInt32BE(bytes.length); bytes.copy(packet, 4); return packet;
};
const byteFrame = bytes => {
  const packet = Buffer.alloc(bytes.length + 4);
  packet.writeUInt32BE(bytes.length); bytes.copy(packet, 4); return packet;
};
const refused = (operation, code) => assert.throws(operation, caught => caught instanceof ControlError &&
  (!code || caught.code === code) && caught.message === 'Control foundation request refused' && !Object.hasOwn(caught, 'cause'));
const rejects = (operation, code) => assert.rejects(operation, caught => caught instanceof ControlError &&
  (!code || caught.code === code) && caught.message === 'Control foundation request refused' && !Object.hasOwn(caught, 'cause'));
async function until(predicate, timeoutMs = 2000) {
  const end = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= end) assert.fail('TEST_ONLY bounded wait expired');
    await delay(5);
  }
}

function localChannel(t, options = {}) {
  const readable = new PassThrough({highWaterMark: 16_384});
  const packets = [], closes = [], messages = [];
  const writable = new Writable({write(packet, encoding, callback) { packets.push(Buffer.from(packet)); callback(); }});
  const channel = new BoundedFrameChannel({readable, writable, validate,
    onMessage: message => { messages.push(message); }, onClose: reason => closes.push(reason), ...options});
  t.after(() => channel.close());
  return {channel, readable, writable: options.writable ?? writable, packets, closes, messages};
}

async function listener(t, handler, secure = true) {
  const sockets = new Set();
  const server = secure ? https.createServer({key: TEST_ONLY_KEY, cert: TEST_ONLY_CERT,
    maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000}, handler) : http.createServer(handler);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  // Expected wrong-CA/pin/hostname handshakes are deliberately silent.
  server.on('tlsClientError', () => {});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return {server, port, endpoint: `https://localhost:${port}${PATH}`, sockets};
}

function clientOptions(endpoint, extra = {}) {
  return {endpoint, serverCertificateSha256: TEST_ONLY_PIN, ca: TEST_ONLY_CERT,
    validate, onMessage() {}, ...extra};
}

async function rawResponse(port, {secure = true, path = PATH, method = 'POST', headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const transport = secure ? https : http;
    const timer = setTimeout(() => { req.destroy(); reject(new Error('TEST_ONLY response deadline expired')); }, 2000);
    const req = transport.request({hostname: '127.0.0.1', port, method, path, agent: false,
      ...(secure ? {servername: 'localhost', ca: TEST_ONLY_CERT, rejectUnauthorized: true} : {}),
      headers: {'Content-Type': TYPE, ...headers}}, res => {
      const status = res.statusCode; res.resume(); res.once('end', () => { clearTimeout(timer); resolve(status); });
    });
    req.once('error', () => { clearTimeout(timer); reject(new Error('TEST_ONLY request failed')); }); req.end(body);
  });
}

test('framing: split headers, bytewise payload and multiple frames retain serial order', async t => {
  const local = localChannel(t);
  const first = wire({n: 11}), second = wire({n: 12});
  for (const byte of first) { local.readable.write(Buffer.from([byte])); await immediate(); }
  local.readable.write(Buffer.concat([second, wire({n: 13})]));
  await until(() => local.messages.length === 3);
  assert.deepEqual(local.messages, [{n: 11}, {n: 12}, {n: 13}]);
  await local.channel.send({n: 14});
  assert.deepEqual(local.packets, [wire({n: 14})]);
  await until(() => local.channel.status().pendingMessages === 0);
  assert.equal(local.channel.status().bufferedBytes, 4);
  assert.equal(local.channel.status().receivedMessages, 3);
  assert.equal(local.channel.status().sentMessages, 1);
  assert.ok(Object.isFrozen(local.channel.status()));
  local.channel.close(); local.channel.close();
  assert.deepEqual(local.closes, ['CLOSED']);
  assert.equal(local.channel.status().bufferedBytes, 0);
  await rejects(() => local.channel.send({n: 15}), 'CLOSED');
});

test('framing: multibyte UTF-8 split at every byte boundary decodes exactly', async t => {
  const seen = [], value = {n: 1, tag: 'TEST_ONLY-λ-🛰️'};
  const local = localChannel(t, {validate: frame => {
    strictRecord(frame, ['n', 'tag']);
    if (typeof frame.tag !== 'string' || frame.tag.length > 64) throw new ControlError('INVALID_INPUT');
    return {n: integer(frame.n), tag: frame.tag};
  }, onMessage: frame => seen.push(frame)});
  for (const byte of wire(value)) { local.readable.write(Buffer.from([byte])); await immediate(); }
  await until(() => seen.length === 1);
  assert.deepEqual(seen, [value]);
});

test('framing: option getters, proxies, unknown keys and hard-limit violations are inert refusals', t => {
  const readable = new PassThrough(), writable = new PassThrough();
  const options = {readable, writable, validate, onMessage() {}};
  t.after(() => { readable.destroy(); writable.destroy(); });
  let touched = 0;
  const proxy = new Proxy(options, {get() { touched++; throw 0; }, ownKeys() { touched++; throw 0; }});
  refused(() => new BoundedFrameChannel(proxy), 'INVALID_INPUT');
  const getter = {...options}; Object.defineProperty(getter, 'onClose', {enumerable: true, get() { touched++; throw 0; }});
  refused(() => new BoundedFrameChannel(getter), 'INVALID_INPUT');
  refused(() => new BoundedFrameChannel({...options, extra: true}), 'INVALID_INPUT');
  refused(() => new BoundedFrameChannel({...options, validate: new Proxy(validate, {apply() { touched++; }})}), 'INVALID_INPUT');
  for (const extra of [{maxFrameBytes: 1_048_577}, {maxBufferedBytes: 4_194_305}, {maxMessages: 65},
    {maxMessages: Infinity}, {maxFrameBytes: -1}, {maxBufferedBytes: 1}, {maxMessages: 0},
    {maxMessages: null}, {maxFrameBytes: null}, {maxBufferedBytes: null},
    {validate: async () => ({n: 1})}, {validate: function* () { yield {n: 1}; }}]) {
    refused(() => new BoundedFrameChannel({...options, ...extra}), 'INVALID_INPUT');
  }
  assert.equal(touched, 0);
});

test('framing: malformed UTF-8, JSON, zero/oversized length and invalid metadata fail closed', async t => {
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(65_537);
  const inputs = [byteFrame(Buffer.from([0x7b, 0xc0, 0xaf, 0x7d])), byteFrame(Buffer.from('{')),
    byteFrame(Buffer.from('\ufeff{"n":1}')), Buffer.alloc(4), oversized, wire({n: 'TEST_ONLY-invalid'})];
  for (const input of inputs) {
    const local = localChannel(t);
    local.readable.write(input);
    await until(() => local.channel.status().closed);
    assert.equal(local.messages.length, 0);
    assert.equal(local.closes.length, 1);
    assert.equal(local.channel.status().bufferedBytes, 0);
    await rejects(() => local.channel.send({n: 1}), 'CLOSED');
  }
});

test('framing: validate before serialization; never invoke a rejected value getter or toJSON', async t => {
  let touched = 0;
  const secret = {get n() { touched++; return 1; }, toJSON() { touched++; return {n: 1}; }};
  const local = localChannel(t);
  await rejects(() => local.channel.send(secret), 'INVALID_INPUT');
  assert.equal(touched, 0);
  assert.equal(local.packets.length, 0);
  const raw = new Proxy({}, {get() { touched++; throw 0; }, ownKeys() { touched++; throw 0; }});
  const next = localChannel(t);
  await rejects(() => next.channel.send(raw), 'INVALID_INPUT');
  assert.equal(touched, 0);
  const unsafeValidator = localChannel(t, {validate: () => ({get n() { touched++; return 1; }})});
  await rejects(() => unsafeValidator.channel.send({n: 1}), 'INVALID_INPUT');
  assert.equal(touched, 0);
  const asyncValidator = localChannel(t, {validate: () => Promise.reject(new Error('TEST_ONLY-private-error'))});
  await rejects(() => asyncValidator.channel.send({n: 1}), 'INVALID_INPUT');
});

test('framing: tiny-frame flood and byte flood are bounded with no later callbacks', async t => {
  const local = localChannel(t);
  local.readable.write(Buffer.concat(Array.from({length: 4000}, () => wire({n: 1}))));
  let yielded = false; setImmediate(() => { yielded = true; });
  await until(() => local.channel.status().closed);
  assert.equal(local.closes[0], 'CAPACITY'); assert.ok(yielded);
  assert.ok(local.messages.length <= 1);
  const after = local.messages.length; await immediate(); assert.equal(local.messages.length, after);
  assert.equal(local.channel.status().bufferedBytes, 0);
  const huge = localChannel(t);
  huge.readable.write(Buffer.alloc(262_145));
  await until(() => huge.channel.status().closed);
  assert.equal(huge.closes[0], 'CAPACITY'); assert.equal(huge.messages.length, 0);
});

test('framing: callbacks serialize; closure during await invalidates queued frames', async t => {
  let release, running = 0, peak = 0; const seen = [];
  const blocked = new Promise(resolve => { release = resolve; });
  const local = localChannel(t, {onMessage: async message => {
    seen.push(message.n); running++; peak = Math.max(peak, running); await blocked; running--;
  }});
  local.readable.write(Buffer.concat([wire({n: 1}), wire({n: 2}), wire({n: 3})]));
  await until(() => seen.length === 1);
  assert.equal(local.channel.status().pendingMessages, 3);
  local.channel.close(); release(); await immediate(); await immediate();
  assert.deepEqual(seen, [1]); assert.equal(peak, 1);
  assert.equal(local.channel.status().pendingMessages, 0);
  const sequential = [], completed = [];
  const next = localChannel(t, {onMessage: async frame => {
    sequential.push(frame.n); await delay(10); completed.push(frame.n);
    assert.equal(sequential.length, completed.length);
  }});
  next.readable.write(Buffer.concat([wire({n: 4}), wire({n: 5}), wire({n: 6})]));
  await until(() => completed.length === 3);
  assert.deepEqual(completed, [4, 5, 6]);
});

test('framing: callback rejection, read end/error and write error close once without raw errors', async t => {
  for (const kind of ['callback', 'end', 'read-error', 'write-error']) {
    const rawError = new Error('TEST_ONLY-private-error-must-not-escape');
    const local = localChannel(t, kind === 'callback' ? {onMessage: async () => { throw rawError; }} :
      kind === 'write-error' ? {writable: new Writable({write(data, encoding, done) { done(rawError); }})} : {});
    if (kind === 'callback') local.readable.write(Buffer.concat([wire({n: 1}), wire({n: 2})]));
    if (kind === 'end') local.readable.end(wire({n: 1}));
    if (kind === 'read-error') local.readable.destroy(rawError);
    if (kind === 'write-error') await rejects(() => local.channel.send({n: 1}), 'CONTROL_ERROR');
    await until(() => local.channel.status().closed);
    assert.equal(local.closes.length, 1);
    assert.equal(local.channel.status().bufferedBytes, 0);
    assert.ok(!JSON.stringify(local.channel.status()).includes('private'));
    local.channel.close(); assert.equal(local.closes.length, 1);
  }
});

test('framing: send waits for write callback AND drain, with shared outbound backlog bounds', async t => {
  let acknowledge;
  const writable = new Writable({highWaterMark: 1, write(packet, encoding, done) { acknowledge = done; }});
  const local = localChannel(t, {writable});
  let resolved = false;
  const sent = local.channel.send({n: 1}).then(() => { resolved = true; });
  await until(() => !!acknowledge); await immediate(); assert.equal(resolved, false);
  // A synthetic drain alone cannot complete a write whose callback is pending.
  writable.emit('drain'); await immediate(); assert.equal(resolved, false);
  acknowledge(); await sent; assert.equal(resolved, true);
  const stall = localChannel(t, {writable: new Writable({write() {}}), maxMessages: 2});
  const a = rejects(() => stall.channel.send({n: 1}), 'CAPACITY');
  const b = rejects(() => stall.channel.send({n: 2}), 'CAPACITY');
  await rejects(() => stall.channel.send({n: 3}), 'CAPACITY'); await Promise.all([a, b]);
  assert.equal(stall.channel.status().bufferedBytes, 0);
});

test('framing: total byte budget includes the active inbound callback and outbound queue', async t => {
  const local = localChannel(t, {maxFrameBytes: 32, maxBufferedBytes: 40,
    onMessage: () => new Promise(() => {}), writable: new Writable({write() {}})});
  local.readable.write(wire({n: 1}));
  await until(() => local.channel.status().receivedMessages === 1);
  assert.equal(local.channel.status().bufferedBytes, 15);
  const pending = [rejects(() => local.channel.send({n: 2}), 'CAPACITY'),
    rejects(() => local.channel.send({n: 3}), 'CAPACITY')];
  assert.equal(local.channel.status().bufferedBytes, 37);
  await rejects(() => local.channel.send({n: 4}), 'CAPACITY');
  await Promise.all(pending);
  assert.deepEqual(local.closes, ['CAPACITY']);
  assert.equal(local.channel.status().bufferedBytes, 0);
});

test('framing: partial bytes, stalled callback and stalled write have absolute finite deadlines', {timeout: 8000}, async t => {
  const partial = localChannel(t); partial.readable.write(Buffer.from([0]));
  const callback = localChannel(t, {onMessage: () => new Promise(() => {})}); callback.readable.write(wire({n: 1}));
  const write = localChannel(t, {writable: new Writable({write() {}})});
  const pending = rejects(() => write.channel.send({n: 1}), 'EXPIRED');
  await until(() => [partial, callback, write].every(local => local.channel.status().closed), 6500);
  await pending;
  for (const local of [partial, callback, write]) {
    assert.deepEqual(local.closes, ['EXPIRED']);
    assert.equal(local.channel.status().bufferedBytes, 0);
    assert.equal(local.channel.status().pendingMessages, 0);
  }
});

test('HTTPS: actual pinned TLS duplex exchanges multiple frames before either request body ends', {timeout: 6000}, async t => {
  let host, requestEnded = false; const serverFrames = [], clientFrames = [], clientCloses = [];
  const local = await listener(t, (req, res) => {
    req.on('end', () => { requestEnded = true; });
    host = acceptHostRequest(req, res, {validate, onMessage: async frame => {
      serverFrames.push(frame.n); await host.send({n: frame.n + 100});
    }});
    assert.ok(host instanceof BoundedFrameChannel);
  });
  const channel = await connectHostTransport(clientOptions(local.endpoint,
    {onMessage: frame => clientFrames.push(frame.n), onClose: reason => clientCloses.push(reason)}));
  t.after(() => channel.close());
  await channel.send({n: 1}); await channel.send({n: 2});
  await until(() => clientFrames.length === 2);
  assert.deepEqual(serverFrames, [1, 2]); assert.deepEqual(clientFrames, [101, 102]); assert.equal(requestEnded, false);
  host.close(); await until(() => channel.status().closed);
  assert.deepEqual(clientCloses, ['TRANSPORT_LOST']);
  assert.equal(channel.status().bufferedBytes, 0);
});

test('HTTPS: wrong pin, CA, hostname and default-untrusted fixture never reach application callbacks', {timeout: 6000}, async t => {
  let requests = 0, callbacks = 0;
  const local = await listener(t, (req, res) => {
    requests++; acceptHostRequest(req, res, {validate, onMessage() { callbacks++; }});
  });
  for (const extra of [{serverCertificateSha256: '0'.repeat(64)}, {ca: TEST_ONLY_WRONG_CA},
    {endpoint: local.endpoint.replace('localhost', '127.0.0.1')}]) {
    await rejects(() => connectHostTransport(clientOptions(local.endpoint, extra)), 'CONTROL_ERROR');
  }
  const defaultTrust = clientOptions(local.endpoint); delete defaultTrust.ca;
  await rejects(() => connectHostTransport(defaultTrust), 'CONTROL_ERROR');
  assert.equal(requests, 0); assert.equal(callbacks, 0);
});

test('HTTPS: malformed UTF-8/JSON, oversized lengths and tiny-frame flood close actual TLS duplex channels', {timeout: 6000}, async t => {
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(65_537);
  for (const input of [byteFrame(Buffer.from([0xff])), byteFrame(Buffer.from('{')), oversized,
    Buffer.concat(Array.from({length: 200}, () => wire({n: 1})))]) {
    const closes = [], frames = []; let host;
    const local = await listener(t, (req, res) => {
      host = acceptHostRequest(req, res, {validate, onMessage: frame => frames.push(frame.n),
        onClose: reason => closes.push(reason)});
    });
    const req = https.request({hostname: '127.0.0.1', port: local.port, servername: 'localhost',
      path: PATH, method: 'POST', ca: TEST_ONLY_CERT, rejectUnauthorized: true, agent: false,
      headers: {'Content-Type': TYPE}}, res => { res.on('error', () => {}); res.resume(); req.write(input); });
    req.on('error', () => {}); req.flushHeaders(); t.after(() => req.destroy());
    await until(() => closes.length === 1);
    assert.ok(['INVALID_INPUT', 'CAPACITY'].includes(closes[0]));
    assert.ok(frames.length <= 1);
    assert.equal(host.status().bufferedBytes, 0);
    await until(() => local.sockets.size === 0);
  }
});

test('HTTPS: disconnect during async callback prevents queued TLS frames from reaching the handler', async t => {
  let release, host; const seen = [], closed = [];
  const blocked = new Promise(resolve => { release = resolve; });
  const local = await listener(t, (req, res) => {
    host = acceptHostRequest(req, res, {validate, onMessage: async frame => { seen.push(frame.n); await blocked; },
      onClose: reason => closed.push(reason)});
  });
  const channel = await connectHostTransport(clientOptions(local.endpoint)); t.after(() => channel.close());
  await channel.send({n: 1}); await channel.send({n: 2});
  await until(() => host.status().pendingMessages === 2 && seen.length === 1);
  channel.close(); await until(() => host.status().closed);
  release(); await immediate(); await immediate();
  assert.deepEqual(seen, [1]); assert.deepEqual(closed, ['TRANSPORT_LOST']);
  assert.equal(host.status().bufferedBytes, 0);
});

test('HTTPS: structural HTTP, method, origin, path, compression and bearer/cookie refusals invoke no options callbacks', async t => {
  let touched = 0, accepted = 0;
  const forbidden = new Proxy({}, {get() { touched++; throw 0; }, ownKeys() { touched++; throw 0; }});
  const handler = (req, res) => { if (acceptHostRequest(req, res, forbidden)) accepted++; };
  const tls = await listener(t, handler), plain = await listener(t, handler, false);
  const cases = [
    [{}, 400], // Eligible wire request still refuses the proxy options without traps.
    [{method: 'GET'}, 405], [{method: 'PUT'}, 405], [{method: 'OPTIONS'}, 405],
    [{path: PATH + '?query=1'}, 404], [{path: PATH + '#fragment'}, 404], [{path: PATH + '/'}, 404],
    [{path: '/api/other/../control/v1/host-channel'}, 404],
    [{headers: {Origin: 'https://localhost'}}, 403], [{headers: {Origin: ''}}, 403],
    [{headers: {Authorization: 'Bearer TEST_ONLY'}}, 403], [{headers: {Cookie: 'TEST_ONLY=1'}}, 403],
    [{headers: {'Proxy-Authorization': 'Bearer TEST_ONLY'}}, 403],
    [{headers: {'X-Gateway-Token': 'TEST_ONLY'}}, 403], [{headers: {'X-Collector-Token': 'TEST_ONLY'}}, 403],
    [{headers: {'Content-Encoding': 'gzip'}}, 415], [{headers: {'Accept-Encoding': 'gzip'}}, 415],
    [{headers: {'Content-Type': TYPE + '; charset=utf-8'}}, 415],
    [{headers: {'Content-Type': 'application/json'}}, 415]
  ];
  for (const [input, expected] of cases) assert.equal(await rawResponse(tls.port, input), expected);
  assert.equal(await rawResponse(plain.port, {secure: false}), 400);
  assert.equal(touched, 0); assert.equal(accepted, 0);
});

test('HTTPS: malformed connect options are refused before connection with no getters/proxies', async () => {
  let touched = 0;
  const base = clientOptions('https://localhost:1' + PATH);
  const bad = [
    {...base, endpoint: 'http://localhost:1' + PATH}, {...base, endpoint: base.endpoint + '?'},
    {...base, endpoint: base.endpoint + '#'}, {...base, endpoint: base.endpoint.replace('localhost', 'TEST_ONLY@localhost')},
    {...base, endpoint: base.endpoint.replace('localhost', '@localhost')},
    {...base, endpoint: base.endpoint.replace(PATH, '/api/other/../control/v1/host-channel')},
    {...base, endpoint: base.endpoint.replace('localhost', '%6cocalhost')}, {...base, endpoint: base.endpoint.replace(':1/', ':0/')},
    {...base, serverCertificateSha256: 'TEST_ONLY'}, {...base, rejectUnauthorized: false},
    {...base, headers: {}}, {...base, agent: false}, {...base, timeoutMs: Infinity}, {...base, timeoutMs: 30_001},
    {...base, timeoutMs: null}, {...base, validate: async () => ({n: 1})},
    {...base, ca: []}, {...base, ca: ''}, {...base, ca: Buffer.alloc(65_537)},
    {...base, onMessage: new Proxy(() => {}, {apply() { touched++; }})}
  ];
  const getter = {...base}; Object.defineProperty(getter, 'endpoint', {enumerable: true, get() { touched++; throw 0; }});
  const caGetter = Buffer.from(TEST_ONLY_CERT);
  Object.defineProperty(caGetter, 'length', {get() { touched++; throw 0; }});
  bad.push(getter, {...base, ca: caGetter}, {...base, ca: null},
    {...base, ca: new Proxy(Buffer.from(TEST_ONLY_CERT), {get() { touched++; throw 0; }})},
    new Proxy(base, {get() { touched++; throw 0; }, ownKeys() { touched++; throw 0; }}));
  for (const options of bad) await rejects(() => connectHostTransport(options), 'INVALID_INPUT');
  assert.equal(touched, 0);
});

test('HTTPS: explicit Buffer CA is copied before caller mutation', async t => {
  const local = await listener(t, (req, res) => acceptHostRequest(req, res, {validate, onMessage() {}}));
  const ca = Buffer.from(TEST_ONLY_CERT);
  const connected = connectHostTransport(clientOptions(local.endpoint, {ca}));
  ca.fill(0);
  const channel = await connected; channel.close();
});

test('HTTPS: child ignores ambient proxies and TLS bypass; imports start no timers/listeners/requests', {timeout: 6000}, async t => {
  let requests = 0, proxied = 0;
  const local = await listener(t, (req, res) => {
    requests++; acceptHostRequest(req, res, {validate, onMessage() {}});
  });
  const proxySockets = new Set();
  const proxy = net.createServer(socket => {
    proxied++; proxySockets.add(socket); socket.on('close', () => proxySockets.delete(socket)); socket.destroy();
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of proxySockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve)); });
  const moduleURL = new URL('../transport/https-host.mjs', import.meta.url).href;
  const code = `import https from 'node:https'; import net from 'node:net';
    import {syncBuiltinESMExports} from 'node:module';
    const originalTimeout = globalThis.setTimeout, originalInterval = globalThis.setInterval;
    const originalRequest = https.request, originalServer = net.createServer;
    let effects = 0;
    globalThis.setTimeout = globalThis.setInterval = https.request = net.createServer = () => { effects++; throw 0; };
    syncBuiltinESMExports();
    await import(${JSON.stringify(moduleURL)});
    if (effects) process.exit(2);
    globalThis.setTimeout = originalTimeout; globalThis.setInterval = originalInterval;
    https.request = originalRequest; net.createServer = originalServer; syncBuiltinESMExports();
    const {connectHostTransport} = await import(${JSON.stringify(moduleURL)});
    const trustChunks=[];let trustBytes=0;for await(const chunk of process.stdin){trustBytes+=chunk.length;if(trustBytes>8192)process.exit(5);trustChunks.push(chunk);}
    const {TEST_ONLY_CERT,TEST_ONLY_PIN}=JSON.parse(Buffer.concat(trustChunks).toString('utf8'));
    const base = {endpoint:${JSON.stringify(local.endpoint)}, serverCertificateSha256:TEST_ONLY_PIN,
      validate: value => ({n:value.n}),onMessage() {}};
    const channel = await connectHostTransport({...base,ca:TEST_ONLY_CERT}); channel.close();
    try { await connectHostTransport(base); process.exit(3); }
    catch (error) { if(error.code!=='CONTROL_ERROR') process.exit(4); }`;
  const proxyURL = `http://127.0.0.1:${proxy.address().port}`;
  const child = spawn(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', code],
    {windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env: {SystemRoot: process.env.SystemRoot ?? '',
      HTTPS_PROXY: proxyURL, HTTP_PROXY: proxyURL, ALL_PROXY: proxyURL, NO_PROXY: '',
      NODE_USE_ENV_PROXY: '1', NODE_TLS_REJECT_UNAUTHORIZED: '0'}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({TEST_ONLY_CERT,TEST_ONLY_PIN}));
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({code, signal})); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; });
  assert.deepEqual(await exited, {code: 0, signal: null});
  assert.equal(proxied, 0); assert.equal(requests, 1);
});

test('HTTPS: redirect, unexpected type/encoding/status close owned socket with no frame callbacks', async t => {
  for (const [status, headers] of [[302, {Location: 'https://TEST_ONLY.invalid/'}], [200, {'Content-Type': 'application/json'}],
    [200, {'Content-Type': TYPE, 'Content-Encoding': 'gzip'}], [401, {'Content-Type': TYPE}],
    [200, {'Content-Type': TYPE, 'Set-Cookie': 'TEST_ONLY=1'}]]) {
    let callbacks = 0;
    const local = await listener(t, (req, res) => { res.writeHead(status, headers); res.flushHeaders(); });
    await rejects(() => connectHostTransport(clientOptions(local.endpoint, {onMessage() { callbacks++; }})), 'INVALID_INPUT');
    await until(() => local.sockets.size === 0);
    assert.equal(callbacks, 0);
  }
});

test('HTTPS: absolute TCP/TLS and HTTP response deadlines destroy owned sockets', {timeout: 4000}, async t => {
  const sockets = new Set();
  const stalled = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.resume();
  });
  await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => stalled.close(resolve)); });
  await rejects(() => connectHostTransport(clientOptions(`https://localhost:${stalled.address().port}${PATH}`, {timeoutMs: 100})), 'EXPIRED');
  await until(() => sockets.size === 0);
  const local = await listener(t, () => {});
  await rejects(() => connectHostTransport(clientOptions(local.endpoint, {timeoutMs: 100})), 'EXPIRED');
  await until(() => local.sockets.size === 0);
});

test('inherited child pipes: same framing, 64 MiB child, duplex delivery and disconnect', {timeout: 6000}, async t => {
  const moduleURL = new URL('../transport/framing.mjs', import.meta.url).href;
  const code = `import {BoundedFrameChannel} from ${JSON.stringify(moduleURL)};
    const channel = new BoundedFrameChannel({readable:process.stdin,writable:process.stdout,
      validate: value => { if (!Number.isSafeInteger(value.n)) throw 0; return {n:value.n}; },
      onMessage: async value => { await channel.send({n:value.n+1}); }});`;
  const child = spawn(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', code],
    {windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: {SystemRoot: process.env.SystemRoot ?? ''}});
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({code, signal})); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exit; });
  const frames = [], closes = [];
  const channel = new BoundedFrameChannel({readable: child.stdout, writable: child.stdin, validate,
    onMessage: message => frames.push(message.n), onClose: reason => closes.push(reason)});
  t.after(() => channel.close());
  await channel.send({n: 40}); await channel.send({n: 41});
  await until(() => frames.length === 2);
  assert.deepEqual(frames, [41, 42]);
  child.kill(); await exit; await until(() => channel.status().closed);
  assert.deepEqual(closes, ['TRANSPORT_LOST']);
  assert.equal(channel.status().bufferedBytes, 0);
});
