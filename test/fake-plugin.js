import { setTimeout as delay } from 'node:timers/promises';

/**
 * Stand-in for the Studio plugin: long-polls the bridge and answers requests
 * with the supplied handlers. Used by the test suite.
 */
export class FakePlugin {
  constructor({ port, token = null, handlers = {}, ignore = [], pollTimeout = 2 } = {}) {
    this.port = port;
    this.token = token;
    this.handlers = handlers;
    this.ignore = new Set(ignore);
    this.pollTimeout = pollTimeout;
    this.requests = [];
    this.running = false;
    this.loopPromise = null;
  }

  get base() {
    return `http://127.0.0.1:${this.port}`;
  }

  headers() {
    return {
      'content-type': 'application/json',
      ...(this.token ? { 'x-roblox-mcp-token': this.token } : {}),
    };
  }

  async hello(meta = {}) {
    const response = await fetch(`${this.base}/v1/hello`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        protocol: 1,
        placeName: 'Test Place',
        placeId: 42,
        pluginVersion: '1.0.0',
        studioVersion: 'test',
        ...meta,
      }),
    });
    return { status: response.status, body: await response.json() };
  }

  start() {
    this.running = true;
    this.loopPromise = this.#loop();
    return this;
  }

  async #loop() {
    while (this.running) {
      let response;
      try {
        response = await fetch(`${this.base}/v1/poll?timeout=${this.pollTimeout}`, { headers: this.headers() });
      } catch {
        if (!this.running) return;
        await delay(100);
        continue;
      }
      if (response.status === 204) continue;
      if (!response.ok) {
        await delay(150);
        continue;
      }
      const { request } = await response.json();
      this.requests.push(request);
      if (this.ignore.has(request.method)) continue;

      const handler = this.handlers[request.method];
      let payload;
      if (!handler) {
        payload = {
          id: request.id,
          ok: false,
          error: { code: 'unknown_method', message: `fake plugin has no handler for ${request.method}` },
        };
      } else {
        try {
          payload = { id: request.id, ok: true, result: await handler(request.params ?? {}, request) };
        } catch (error) {
          payload = { id: request.id, ok: false, error: { code: error.code ?? 'studio_error', message: error.message } };
        }
      }
      try {
        await fetch(`${this.base}/v1/result`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(payload),
        });
      } catch {
        /* bridge went away mid-test */
      }
    }
  }

  async stop() {
    this.running = false;
    await this.loopPromise?.catch(() => {});
    this.loopPromise = null;
  }
}
