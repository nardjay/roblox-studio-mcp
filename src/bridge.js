import http from 'node:http';
import crypto from 'node:crypto';

/** Wire protocol spoken between the MCP server and the Studio plugin. */
export const BRIDGE_PROTOCOL = 1;

export class BridgeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const LOG_BUFFER = 500;

function json(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(text);
}

function noContent(res) {
  res.writeHead(204, { 'cache-control': 'no-store' });
  res.end();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Loopback HTTP bridge.
 *
 * The Studio plugin cannot listen on a socket, so it long-polls this server for
 * work. A tool call is queued, handed to the plugin on its next poll, and the
 * plugin POSTs the result back. Inbound calls are correlated with an id.
 */
export class Bridge {
  constructor({
    host = '127.0.0.1',
    port = 44755,
    token = null,
    log = () => {},
    requestTimeoutMs = 30000,
    serverVersion = '0.0.0',
  } = {}) {
    this.host = host;
    this.requestedPort = port;
    this.token = token || null;
    this.log = log;
    this.defaultTimeoutMs = requestTimeoutMs;
    this.serverVersion = serverVersion;

    /** @type {Array<{id: string, method: string, params: object, createdAt: number}>} */
    this.queued = [];
    /** @type {Array<{res: import('node:http').ServerResponse, timer: NodeJS.Timeout}>} */
    this.waiters = [];
    /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout, method: string, id: string}>} */
    this.pending = new Map();
    this.events = { logs: [], selection: [] };
    this.plugin = null;
    this.lastPollAt = 0;
    this.startedAt = Date.now();
    this.requestsServed = 0;
    this.nextId = 1;
    this.server = null;
    this.port = null;
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    if (this.server) return this.port;
    const server = http.createServer((req, res) => {
      this.#onRequest(req, res).catch((error) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        const status = error instanceof BridgeError && error.code === 'bad_request' ? 400 : 500;
        json(res, status, {
          ok: false,
          error: { code: error.code ?? 'internal_error', message: error.message },
        });
      });
    });
    server.keepAliveTimeout = 90_000;
    server.headersTimeout = 95_000;
    this.server = server;

    const tryPorts = this.requestedPort === 0 ? [0] : Array.from({ length: 10 }, (_, i) => this.requestedPort + i);
    let lastError;
    for (const candidate of tryPorts) {
      try {
        this.port = await this.#listen(candidate);
        this.log(`bridge listening on http://${this.host}:${this.port}`);
        return this.port;
      } catch (error) {
        lastError = error;
        if (error.code !== 'EADDRINUSE') break;
      }
    }
    this.server = null;
    throw lastError ?? new Error('could not bind bridge port');
  }

  #listen(port) {
    return new Promise((resolve, reject) => {
      const server = this.server;
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, this.host);
    });
  }

  async stop() {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeError('bridge_closed', 'MCP server shut down before Roblox Studio replied.'));
    }
    this.pending.clear();
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      if (!waiter.res.writableEnded) noContent(waiter.res);
    }
    this.queued.length = 0;
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  // ------------------------------------------------------------------- state

  isConnected() {
    return Boolean(this.plugin) && Date.now() - this.lastPollAt < 15_000;
  }

  status() {
    const connected = this.isConnected();
    return {
      service: 'roblox-studio-mcp',
      serverVersion: this.serverVersion,
      protocol: BRIDGE_PROTOCOL,
      connected,
      port: this.port,
      plugin: connected ? this.plugin : null,
      lastPollAgoMs: this.lastPollAt ? Date.now() - this.lastPollAt : null,
      queued: this.queued.length,
      pending: this.pending.size,
      requestsServed: this.requestsServed,
      uptimeMs: Date.now() - this.startedAt,
      tokenRequired: Boolean(this.token),
      logCount: this.events.logs.length,
    };
  }

  /** Recent plugin-forwarded output lines, oldest first. */
  logs(limit = 50) {
    const count = clamp(Number(limit) || 50, 1, LOG_BUFFER);
    return this.events.logs.slice(-count);
  }

  clearLogs() {
    this.events.logs.length = 0;
  }

  // -------------------------------------------------------------------- call

  /**
   * Ask the connected Studio plugin to run `method`.
   * Rejects fast with a helpful code when no plugin is attached.
   */
  call(method, params = {}, { timeoutMs } = {}) {
    if (!this.isConnected()) {
      return Promise.reject(
        new BridgeError(
          'studio_disconnected',
          'Roblox Studio is not connected. Open a place in Studio, make sure HttpService requests are allowed for plugins, and enable the "RobloxMCP" plugin (Plugins toolbar -> RobloxMCP -> Connect).',
        ),
      );
    }
    if (this.queued.length >= 200) {
      return Promise.reject(new BridgeError('bridge_busy', 'Too many queued Studio requests; try again shortly.'));
    }

    const id = `req-${this.nextId++}`;
    const timeout = clamp(Number(timeoutMs) || this.defaultTimeoutMs, 1000, 300_000);
    const request = { id, method, params: params ?? {}, createdAt: Date.now() };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const queuedIndex = this.queued.findIndex((item) => item.id === id);
        if (queuedIndex !== -1) this.queued.splice(queuedIndex, 1);
        reject(
          new BridgeError(
            'studio_timeout',
            `Roblox Studio did not answer "${method}" within ${Math.round(timeout / 1000)}s. ` +
              'The plugin may be busy, blocked by a modal dialog, or disconnected.',
          ),
        );
      }, timeout);

      this.pending.set(id, { id, method, resolve, reject, timer });
      this.queued.push(request);
      this.#dispatchQueued();
    });
  }

  #dispatchQueued() {
    while (this.waiters.length > 0 && this.queued.length > 0) {
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      const request = this.queued.shift();
      this.requestsServed += 1;
      json(waiter.res, 200, {
        request: { id: request.id, method: request.method, params: request.params },
      });
    }
  }

  // ------------------------------------------------------------------- http

  async #onRequest(req, res) {
    const url = new URL(req.url ?? '/', `http://${this.host}:${this.port ?? 0}`);
    const { pathname } = url;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, x-roblox-mcp-token',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      });
      res.end();
      return;
    }

    if (pathname === '/health') {
      json(res, 200, { ok: true, service: 'roblox-studio-mcp', protocol: BRIDGE_PROTOCOL });
      return;
    }

    if (!this.#isLoopback(req)) {
      json(res, 403, { ok: false, error: { code: 'forbidden', message: 'This bridge only accepts loopback connections.' } });
      return;
    }

    if (pathname === '/v1/status' && req.method === 'GET') {
      json(res, 200, this.status());
      return;
    }

    if (!pathname.startsWith('/v1/')) {
      json(res, 404, { ok: false, error: { code: 'not_found', message: `No route for ${req.method} ${pathname}` } });
      return;
    }

    if (!this.#checkToken(req, url)) {
      json(res, 401, { ok: false, error: { code: 'unauthorized', message: 'Missing or invalid x-roblox-mcp-token header.' } });
      return;
    }

    if (pathname === '/v1/hello' && req.method === 'POST') {
      const body = await this.#readJson(req);
      const protocol = Number(body.protocol) || 0;
      this.plugin = {
        placeName: String(body.placeName ?? 'Unknown place'),
        placeId: Number(body.placeId) || 0,
        pluginVersion: String(body.pluginVersion ?? '0.0.0'),
        studioVersion: String(body.studioVersion ?? ''),
        protocol,
        userId: Number(body.userId) || 0,
        connectedAt: new Date().toISOString(),
      };
      this.lastPollAt = Date.now();
      this.log(`plugin connected: ${this.plugin.placeName} (plugin ${this.plugin.pluginVersion})`);
      if (protocol !== BRIDGE_PROTOCOL) {
        this.log(`warning: plugin protocol ${protocol} does not match server protocol ${BRIDGE_PROTOCOL}; update both halves.`);
      }
      json(res, 200, {
        ok: true,
        protocol: BRIDGE_PROTOCOL,
        serverVersion: this.serverVersion,
        port: this.port,
        requestTimeoutMs: this.defaultTimeoutMs,
        protocolMismatch: protocol !== BRIDGE_PROTOCOL,
      });
      return;
    }

    if (pathname === '/v1/poll' && req.method === 'GET') {
      this.lastPollAt = Date.now();
      const seconds = clamp(Number(url.searchParams.get('timeout') ?? 20) || 0, 1, 25);
      this.#servePoll(res, seconds * 1000);
      return;
    }

    if (pathname === '/v1/result' && req.method === 'POST') {
      const body = await this.#readJson(req);
      const id = String(body.id ?? '');
      const entry = this.pending.get(id);
      if (!entry) {
        json(res, 200, { ok: true, ignored: true });
        return;
      }
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (body.ok === false) {
        const error = body.error ?? {};
        entry.reject(new BridgeError(String(error.code ?? 'studio_error'), String(error.message ?? 'Roblox Studio reported an error.'), error.details));
      } else {
        entry.resolve(body.result ?? null);
      }
      json(res, 200, { ok: true });
      return;
    }

    if (pathname === '/v1/event' && req.method === 'POST') {
      const body = await this.#readJson(req);
      this.#recordEvent(String(body.type ?? 'unknown'), body.data ?? null);
      json(res, 200, { ok: true });
      return;
    }

    if (pathname === '/v1/rpc' && req.method === 'POST') {
      const body = await this.#readJson(req);
      if (typeof body.method !== 'string') {
        throw new BridgeError('bad_request', 'Body must include a string "method".');
      }
      try {
        const result = await this.call(body.method, body.params ?? {}, { timeoutMs: body.timeoutMs });
        json(res, 200, { ok: true, result });
      } catch (error) {
        const code = error.code ?? 'studio_error';
        const clientError = new Set([
          'invalid_argument',
          'invalid_path',
          'invalid_parent',
          'invalid_class',
          'not_a_script',
          'not_found',
          'ambiguous_match',
          'occurrence_out_of_range',
          'source_unavailable',
        ]);
        const status = code === 'studio_disconnected' ? 503 : code === 'studio_timeout' ? 504 : clientError.has(code) ? 400 : 502;
        json(res, status, { ok: false, error: { code, message: error.message } });
      }
      return;
    }

    json(res, 404, { ok: false, error: { code: 'not_found', message: `No route for ${req.method} ${pathname}` } });
  }

  #servePoll(res, timeoutMs) {
    if (this.queued.length > 0) {
      const request = this.queued.shift();
      this.requestsServed += 1;
      json(res, 200, { request: { id: request.id, method: request.method, params: request.params } });
      return;
    }

    const waiter = { res, timer: null };
    const cleanup = () => {
      clearTimeout(waiter.timer);
      const index = this.waiters.indexOf(waiter);
      if (index !== -1) this.waiters.splice(index, 1);
    };
    waiter.timer = setTimeout(() => {
      cleanup();
      if (!res.writableEnded) noContent(res);
    }, timeoutMs);
    res.on('close', cleanup);
    this.waiters.push(waiter);
  }

  #recordEvent(type, data) {
    if (type === 'log') {
      this.events.logs.push({ at: new Date().toISOString(), ...data });
      if (this.events.logs.length > LOG_BUFFER) this.events.logs.splice(0, this.events.logs.length - LOG_BUFFER);
    } else if (type === 'selection') {
      this.events.selection = Array.isArray(data) ? data : [];
    }
  }

  #isLoopback(req) {
    const address = req.socket.remoteAddress ?? '';
    return LOOPBACK.has(address);
  }

  #checkToken(req, url) {
    if (!this.token) return true;
    const header = req.headers['x-roblox-mcp-token'];
    const provided = (Array.isArray(header) ? header[0] : header) || url.searchParams.get('token') || '';
    const a = Buffer.from(String(provided));
    const b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async #readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new BridgeError('bad_request', 'Request body is too large.');
      chunks.push(chunk);
    }
    if (size === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new BridgeError('bad_request', 'Request body is not valid JSON.');
    }
  }
}
