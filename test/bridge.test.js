import test from 'node:test';
import assert from 'node:assert/strict';

import { Bridge } from '../src/bridge.js';
import { FakePlugin } from './fake-plugin.js';

async function setup({ token = null, requestTimeoutMs = 3000, handlers = {}, ignore = [] } = {}) {
  const bridge = new Bridge({ port: 0, token, requestTimeoutMs });
  await bridge.start();
  const plugin = new FakePlugin({ port: bridge.port, token, handlers, ignore });
  return { bridge, plugin };
}

async function waitFor(predicate, timeoutMs = 2000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('rejects a call when no plugin is connected', async () => {
  const bridge = new Bridge({ port: 0 });
  await bridge.start();
  try {
    await assert.rejects(bridge.call('ping'), (error) => {
      assert.equal(error.code, 'studio_disconnected');
      assert.match(error.message, /Roblox Studio is not connected/);
      return true;
    });
    assert.equal(bridge.status().connected, false);
  } finally {
    await bridge.stop();
  }
});

test('round-trips a call and reports connected status', async (t) => {
  const { bridge, plugin } = await setup({ handlers: { ping: () => ({ placeName: 'Round Trip', ok: true }) } });
  t.after(async () => {
    await plugin.stop();
    await bridge.stop();
  });

  const hello = await plugin.hello();
  assert.equal(hello.status, 200);
  assert.equal(hello.body.protocol, 1);
  plugin.start();

  await waitFor(() => bridge.isConnected(), 2000, 'connection');
  const result = await bridge.call('ping');
  assert.deepEqual(result, { placeName: 'Round Trip', ok: true });

  const status = bridge.status();
  assert.equal(status.connected, true);
  assert.equal(status.plugin.placeName, 'Test Place');
  assert.equal(status.pending, 0);
  assert.equal(status.queued, 0);
  assert.ok(status.requestsServed >= 1);
});

test('answers concurrent calls in order with distinct ids', async (t) => {
  const seen = [];
  const { bridge, plugin } = await setup({
    handlers: {
      echo: (params) => {
        seen.push(params.value);
        return { value: params.value };
      },
    },
  });
  t.after(async () => {
    await plugin.stop();
    await bridge.stop();
  });

  await plugin.hello();
  plugin.start();
  await waitFor(() => bridge.isConnected());

  const results = await Promise.all([1, 2, 3, 4, 5].map((value) => bridge.call('echo', { value })));
  assert.deepEqual(results.map((item) => item.value), [1, 2, 3, 4, 5]);
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  const ids = new Set(plugin.requests.map((request) => request.id));
  assert.equal(ids.size, 5);
});

test('surfaces plugin errors with their code', async (t) => {
  const { bridge, plugin } = await setup({
    handlers: {
      setProperties: () => {
        const error = new Error('Part is not a valid member of Workspace');
        error.code = 'invalid_path';
        throw error;
      },
    },
  });
  t.after(async () => {
    await plugin.stop();
    await bridge.stop();
  });

  await plugin.hello();
  plugin.start();
  await waitFor(() => bridge.isConnected());

  await assert.rejects(bridge.call('setProperties', { path: 'Workspace.Nope' }), (error) => {
    assert.equal(error.code, 'invalid_path');
    assert.match(error.message, /not a valid member/);
    return true;
  });
});

test('times out when the plugin never answers', async (t) => {
  const { bridge, plugin } = await setup({ requestTimeoutMs: 1200, ignore: ['slow'] });
  t.after(async () => {
    await plugin.stop();
    await bridge.stop();
  });

  await plugin.hello();
  plugin.start();
  await waitFor(() => bridge.isConnected());

  const started = Date.now();
  await assert.rejects(bridge.call('slow'), (error) => {
    assert.equal(error.code, 'studio_timeout');
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1000, `expected >1s timeout, got ${elapsed}ms`);
  assert.equal(bridge.status().pending, 0);
});

test('requires the shared token when configured', async () => {
  const bridge = new Bridge({ port: 0, token: 'sekret' });
  await bridge.start();
  try {
    const unauthenticated = await fetch(`http://127.0.0.1:${bridge.port}/v1/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 1 }),
    });
    assert.equal(unauthenticated.status, 401);

    const authenticated = await fetch(`http://127.0.0.1:${bridge.port}/v1/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-roblox-mcp-token': 'sekret' },
      body: JSON.stringify({ protocol: 1, placeName: 'Secure Place' }),
    });
    assert.equal(authenticated.status, 200);
    assert.equal((await authenticated.json()).ok, true);
  } finally {
    await bridge.stop();
  }
});

test('buffers forwarded studio output', async () => {
  const bridge = new Bridge({ port: 0 });
  await bridge.start();
  try {
    await fetch(`http://127.0.0.1:${bridge.port}/v1/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'log', data: { level: 'message', text: 'hello from studio' } }),
    });
    const logs = bridge.logs(10);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].text, 'hello from studio');
    bridge.clearLogs();
    assert.equal(bridge.logs().length, 0);
  } finally {
    await bridge.stop();
  }
});

test('serves /v1/rpc for REST clients', async (t) => {
  const { bridge, plugin } = await setup({ handlers: { ping: () => ({ placeName: 'REST' }) } });
  t.after(async () => {
    await plugin.stop();
    await bridge.stop();
  });

  await plugin.hello();
  plugin.start();
  await waitFor(() => bridge.isConnected());

  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'ping' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { ok: true, result: { placeName: 'REST' } });
});

test('health stays open and reports protocol', async () => {
  const bridge = new Bridge({ port: 0 });
  await bridge.start();
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).protocol, 1);
  } finally {
    await bridge.stop();
  }
});
