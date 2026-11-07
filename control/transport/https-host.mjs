import {Agent, request} from 'node:https';
import {IncomingMessage, ServerResponse} from 'node:http';
import {TLSSocket, checkServerIdentity} from 'node:tls';
import {createHash, timingSafeEqual} from 'node:crypto';
import {types} from 'node:util';
import {ControlError} from '../lib/errors.mjs';
import {strictRecord, integer} from '../lib/privacy.mjs';
import {BoundedFrameChannel} from './framing.mjs';

const PATH = '/api/control/v1/host-channel';
const CONTENT_TYPE = 'application/x-codexcontrol-frame';
const CHANNEL_KEYS = ['validate', 'onMessage', 'onClose', 'maxFrameBytes', 'maxBufferedBytes', 'maxMessages'];
const CONNECT_KEYS = ['endpoint', 'serverCertificateSha256', 'ca', ...CHANNEL_KEYS, 'timeoutMs'];
const error = code => new ControlError(code);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;

function certificateAuthority(value) {
  if (typeof value === 'string') {
    if (!value.length || Buffer.byteLength(value) > 65_536) throw error('INVALID_INPUT');
    return value;
  }
  if (value === null || typeof value !== 'object' || types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Buffer.prototype) throw error('INVALID_INPUT');
  let size;
  try { size = typedArrayByteLength.call(value); } catch { throw error('INVALID_INPUT'); }
  if (!size || size > 65_536 || Reflect.ownKeys(value).length !== size) throw error('INVALID_INPUT');
  // Intrinsics avoid caller-defined length/copy/toString accessors on a Buffer.
  const copy = Buffer.allocUnsafeSlow(size); Uint8Array.prototype.set.call(copy, value);
  return copy;
}

function channelOptions(options, allowed = CHANNEL_KEYS, required = ['validate', 'onMessage']) {
  strictRecord(options, allowed, required);
  for (const value of Object.values(options)) if (types.isProxy(value)) throw error('INVALID_INPUT');
  if (typeof options.validate !== 'function' || types.isAsyncFunction(options.validate) || types.isGeneratorFunction(options.validate) ||
      typeof options.onMessage !== 'function' ||
      (options.onClose !== undefined && typeof options.onClose !== 'function')) throw error('INVALID_INPUT');
  const maxFrameBytes = integer(options.maxFrameBytes === undefined ? 65_536 : options.maxFrameBytes, 1, 1_048_576);
  const maxBufferedBytes = integer(options.maxBufferedBytes === undefined ? 262_144 : options.maxBufferedBytes, maxFrameBytes + 8, 4_194_304);
  const maxMessages = integer(options.maxMessages === undefined ? 8 : options.maxMessages, 1, 64);
  return {validate: options.validate, onMessage: options.onMessage, onClose: options.onClose,
    maxFrameBytes, maxBufferedBytes, maxMessages};
}

// Raw HTTP headers are trusted Node-parser output, not a caller options bag.
// Bound inspection and reject duplicates instead of relying on merged headers.
function headersOf(message) {
  if (message.rawHeaders.length > 128) return null;
  const headers = new Map(); let bytes = 0;
  for (let i = 0; i < message.rawHeaders.length; i += 2) {
    const name = message.rawHeaders[i].toLowerCase(), value = message.rawHeaders[i + 1];
    bytes += name.length + value.length;
    if (bytes > 8192 || headers.has(name)) return null;
    headers.set(name, value);
  }
  return headers;
}

function refuse(req, res, status) {
  // No body reflection, request-body parsing, callback or auth fallback.
  try {
    req.pause(); res.shouldKeepAlive = false;
    res.writeHead(status, {'Content-Length': '0', 'Connection': 'close', 'Cache-Control': 'no-store'});
    res.end();
  } catch { req.destroy(); res.destroy(); }
  return null;
}

/**
 * Call from the authoritative HTTPS listener BEFORE browser/collector/gateway
 * authentication or routing. This supplies server-authenticated encryption only.
 * The parent's signed challenge MUST establish host authority on this channel.
 * No separate listener and no client-certificate/mutual-TLS claim is made here.
 */
export function acceptHostRequest(req, res, options) {
  if (!(req instanceof IncomingMessage) || !(res instanceof ServerResponse)) throw error('INVALID_INPUT');
  if (!(req.socket instanceof TLSSocket) || req.socket.encrypted !== true) return refuse(req, res, 400);
  if (req.method !== 'POST') return refuse(req, res, 405);
  if (req.url !== PATH) return refuse(req, res, 404);
  const headers = headersOf(req);
  if (!headers || !headers.has('host')) return refuse(req, res, 400);
  for (const name of headers.keys()) {
    if (['origin', 'authorization', 'proxy-authorization', 'cookie', 'forwarded'].includes(name) ||
        name.startsWith('x-') || name.startsWith('sec-')) return refuse(req, res, 403);
    if (['content-encoding', 'accept-encoding', 'expect', 'upgrade', 'trailer'].includes(name)) return refuse(req, res, 415);
  }
  if (headers.get('content-type') !== CONTENT_TYPE) return refuse(req, res, 415);
  if (headers.has('transfer-encoding') && headers.get('transfer-encoding') !== 'chunked') return refuse(req, res, 400);
  if (req.aborted || req.destroyed || res.headersSent || res.writableEnded || res.destroyed) return refuse(req, res, 400);
  let configured;
  try { configured = channelOptions(options); }
  catch { return refuse(req, res, 400); }
  let channel;
  try {
    req.pause();
    res.shouldKeepAlive = false;
    res.writeHead(200, {'Content-Type': CONTENT_TYPE, 'Cache-Control': 'no-store', 'Connection': 'close'});
    channel = new BoundedFrameChannel({readable: req, writable: res, ...configured});
    res.flushHeaders();
    return channel;
  } catch {
    channel?.close(); req.destroy(); res.destroy(); return null;
  }
}

/** Explicit startup only; no proxy, redirects, credentials, retries or replay. */
export async function connectHostTransport(options) {
  const configured = channelOptions(options, CONNECT_KEYS,
    ['endpoint', 'serverCertificateSha256', 'validate', 'onMessage']);
  const timeoutMs = integer(options.timeoutMs === undefined ? 5_000 : options.timeoutMs, 1, 30_000);
  const endpoint = options.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length > 512 ||
      !/^https:\/\/(?:[A-Za-z0-9.-]+|\[[A-Fa-f0-9:.]+\])(?::[0-9]{1,5})?\/api\/control\/v1\/host-channel$/.test(endpoint)) throw error('INVALID_INPUT');
  let url;
  try { url = new URL(endpoint); } catch { throw error('INVALID_INPUT'); }
  if (url.protocol !== 'https:' || url.pathname !== PATH || url.username || url.password || url.search || url.hash || url.port === '0') throw error('INVALID_INPUT');
  if (typeof options.serverCertificateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(options.serverCertificateSha256)) throw error('INVALID_INPUT');
  let ca;
  if (Object.hasOwn(options, 'ca')) ca = certificateAuthority(options.ca);
  const pin = Buffer.from(options.serverCertificateSha256, 'hex');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  // An explicit private agent avoids the global agent and ambient proxy config,
  // session reuse, shared sockets and inherited request options/credentials.
  const agent = new Agent({keepAlive: false, maxSockets: 1, maxTotalSockets: 1,
    maxFreeSockets: 0, maxCachedSessions: 0, proxyEnv: Object.create(null)});
  return new Promise((resolve, reject) => {
    let req, socket, response, channel, settled = false, verified = false;
    const destroy = () => { response?.destroy(); req?.destroy(); socket?.destroy(); agent.destroy(); };
    const fail = code => {
      if (settled) return;
      settled = true; clearTimeout(timer); destroy(); reject(error(code));
    };
    const timer = setTimeout(() => fail('EXPIRED'), timeoutMs);
    try {
      req = request({protocol: 'https:', hostname, port: url.port || 443, method: 'POST', path: PATH,
        agent, rejectUnauthorized: true, minVersion: 'TLSv1.2',
        maxHeaderSize: 8192, highWaterMark: 16_384,
        headers: {'Content-Type': CONTENT_TYPE, 'Connection': 'close'},
        ...(ca === undefined ? {} : {ca}),
        checkServerIdentity: (host, certificate) => {
          if (checkServerIdentity(host, certificate) || !Buffer.isBuffer(certificate.raw)) return error('CONTROL_ERROR');
          const actual = createHash('sha256').update(certificate.raw).digest();
          return timingSafeEqual(pin, actual) ? undefined : error('CONTROL_ERROR');
        }
      });
      req.on('error', () => fail('CONTROL_ERROR'));
      req.once('close', () => { if (!settled) fail('CONTROL_ERROR'); });
      req.once('socket', owned => {
        socket = owned;
        if (settled) { socket.destroy(); return; }
        socket.once('secureConnect', () => {
          if (settled) { socket.destroy(); return; }
          if (!(socket instanceof TLSSocket) || socket.authorized !== true) { fail('CONTROL_ERROR'); return; }
          verified = true;
        });
      });
      req.once('response', incoming => {
        if (settled) { incoming.destroy(); return; }
        response = incoming;
        const headers = headersOf(response);
        if (!verified || response.socket !== socket || response.statusCode !== 200 || !headers ||
            headers.get('content-type') !== CONTENT_TYPE || headers.has('content-encoding') ||
            headers.has('location') || headers.has('set-cookie')) { fail('INVALID_INPUT'); return; }
        try {
          channel = new BoundedFrameChannel({readable: response, writable: req, ...configured,
            onClose: reason => { destroy(); return configured.onClose?.(reason); }});
        } catch { fail('CONTROL_ERROR'); return; }
        settled = true; clearTimeout(timer); resolve(channel);
      });
      // Keep the POST body open. Headers must reach the listener before either
      // side sends its first protocol frame/challenge.
      req.flushHeaders();
    } catch { fail('CONTROL_ERROR'); }
  });
}
