import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';

import { McpServer } from '../src/mcp.js';

const TOOLS = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Echo the arguments back.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    annotations: { readOnlyHint: true },
    handler: async (args) => ({ echoed: args.value, ok: true }),
  },
  {
    name: 'explode',
    title: 'Explode',
    description: 'Always fails.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    handler: async () => {
      const error = new Error('Studio is not connected');
      error.code = 'studio_disconnected';
      throw error;
    },
  },
];

function createServer() {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  readline.createInterface({ input: output }).on('line', (line) => messages.push(JSON.parse(line)));
  const server = new McpServer({ tools: TOOLS, bridge: {}, version: '9.9.9', input, output });
  server.start();
  return {
    messages,
    send: (message) => input.write(`${JSON.stringify(message)}\n`),
    stop: () => {
      server.stop();
      input.end();
      output.end();
    },
  };
}

async function waitForMessage(messages, predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no matching message; saw ${JSON.stringify(messages)}`);
}

test('initialize negotiates protocol and advertises tools', async (t) => {
  const client = createServer();
  t.after(() => client.stop());

  client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } } });
  const response = await waitForMessage(client.messages, (m) => m.id === 1);
  assert.equal(response.result.protocolVersion, '2025-06-18');
  assert.equal(response.result.serverInfo.name, 'roblox-studio-mcp');
  assert.equal(response.result.serverInfo.version, '9.9.9');
  assert.deepEqual(response.result.capabilities.tools, { listChanged: false });
  assert.match(response.result.instructions, /Roblox Studio/);
});

test('initialize falls back to the newest supported protocol', async (t) => {
  const client = createServer();
  t.after(() => client.stop());
  client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  const response = await waitForMessage(client.messages, (m) => m.id === 1);
  assert.equal(response.result.protocolVersion, '2025-06-18');
});

test('tools/list returns schemas and annotations', async (t) => {
  const client = createServer();
  t.after(() => client.stop());
  client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const response = await waitForMessage(client.messages, (m) => m.id === 2);
  assert.equal(response.result.tools.length, 2);
  assert.deepEqual(response.result.tools.map((tool) => tool.name), ['echo', 'explode']);
  assert.equal(response.result.tools[0].inputSchema.type, 'object');
  assert.equal(response.result.tools[0].annotations.readOnlyHint, true);
});

test('tools/call returns text and structured content', async (t) => {
  const client = createServer();
  t.after(() => client.stop());
  client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { value: 'hi' } } });
  const response = await waitForMessage(client.messages, (m) => m.id === 3);
  assert.equal(response.result.isError, undefined);
  assert.deepEqual(response.result.structuredContent, { echoed: 'hi', ok: true });
  assert.deepEqual(JSON.parse(response.result.content[0].text), { echoed: 'hi', ok: true });
});

test('tool failures become isError results, not protocol errors', async (t) => {
  const client = createServer();
  t.after(() => client.stop());
  client.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'explode', arguments: {} } });
  const response = await waitForMessage(client.messages, (m) => m.id === 4);
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /studio_disconnected/);
});

test('unknown tool is an invalid-params error', async (t) => {
  const client = createServer();
  t.after(() => client.stop());
  client.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  const response = await waitForMessage(client.messages, (m) => m.id === 5);
  assert.equal(response.error.code, -32602);
});

test('unknown method is -32601 and parse errors are -32700', async (t) => {
  const client = createServer();
  t.after(() => client.stop());

  client.send({ jsonrpc: '2.0', id: 6, method: 'does/not/exist' });
  const unknownMethod = await waitForMessage(client.messages, (m) => m.id === 6);
  assert.equal(unknownMethod.error.code, -32601);

  client.send({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
  await waitForMessage(client.messages, (m) => m.id === 7);
  client.messages.length = 0;
  client.send({ jsonrpc: '2.0', id: 8, method: 'ping' });
  const pong = await waitForMessage(client.messages, (m) => m.id === 8);
  assert.deepEqual(pong.result, {});
});

test('notifications get no reply', async (t) => {
  const client = createServer();
  t.after(() => client.stop());
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  client.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
  const pong = await waitForMessage(client.messages, (m) => m.id === 9);
  assert.deepEqual(pong.result, {});
  assert.equal(client.messages.filter((m) => m.id === undefined).length, 0);
});
