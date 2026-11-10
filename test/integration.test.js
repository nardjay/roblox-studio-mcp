import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

import { FakePlugin } from './fake-plugin.js';

const ENTRY = fileURLToPath(new URL('../bin/roblox-mcp.js', import.meta.url));

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function startServer(args) {
  const child = spawn(process.execPath, [ENTRY, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const port = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server never reported a port. stderr:\n${stderr}`)), 10_000);
    child.stderr.on('data', () => {
      const match = stderr.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  return { child, port, stderr: () => stderr };
}

function createClient(child) {
  const messages = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (line.trim()) messages.push(JSON.parse(line));
  });
  let nextId = 1;
  return {
    messages,
    async request(method, params, timeoutMs = 8000) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const response = messages.find((message) => message.id === id);
        if (response) return response;
        await delay(10);
      }
      throw new Error(`no response to ${method}. stderr:\n${child.stderr.read() ?? ''}`);
    },
  };
}

test('end-to-end: MCP stdio -> bridge -> plugin -> back', async (t) => {
  const server = startServer(['--port', '0']);
  const port = await server.port;
  const plugin = new FakePlugin({
    port,
    handlers: {
      ping: () => ({ placeName: 'Integration Place', placeId: 7, pluginVersion: '1.0.0', mode: 'edit' }),
      getTree: (params) => ({
        root: { name: 'Workspace', className: 'Workspace', path: 'Workspace', childCount: 1 },
        nodes: [{ name: 'Part', className: 'Part', path: 'Workspace.Part', childCount: 0, depth: 1 }],
        truncated: false,
        requestedDepth: params.depth,
      }),
      setProperties: (params) => ({ path: params.path, applied: Object.keys(params.properties ?? {}) }),
    },
  });

  t.after(async () => {
    await plugin.stop();
    server.child.kill();
  });

  await plugin.hello();
  plugin.start();
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/status`);
    return (await response.json()).connected === true;
  });

  const client = createClient(server.child);

  const init = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'integration-test', version: '1.0.0' },
  });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.instructions.includes('studio_status'));

  const list = await client.request('tools/list', {});
  const names = list.result.tools.map((tool) => tool.name);
  for (const expected of ['studio_status', 'get_tree', 'set_properties', 'get_script_source', 'run_selftest']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  assert.ok(names.length >= 15);

  const status = await client.request('tools/call', { name: 'studio_status', arguments: {} });
  const statusPayload = JSON.parse(status.result.content[0].text);
  assert.equal(statusPayload.connected, true);
  assert.equal(statusPayload.plugin.placeName, 'Test Place');
  assert.equal(statusPayload.roundTripMs >= 0, true);
  assert.equal(status.result.isError, undefined);

  const tree = await client.request('tools/call', { name: 'get_tree', arguments: { path: 'Workspace', depth: 1 } });
  assert.equal(tree.result.isError, undefined);
  assert.equal(JSON.parse(tree.result.content[0].text).nodes[0].path, 'Workspace.Part');

  const set = await client.request('tools/call', {
    name: 'set_properties',
    arguments: { path: 'Workspace.Part', properties: { Anchored: true, Color: '#ff8800' } },
  });
  assert.equal(set.result.isError, undefined);
  const forwarded = plugin.requests.find((request) => request.method === 'setProperties');
  assert.deepEqual(forwarded.params, {
    path: 'Workspace.Part',
    properties: { Anchored: true, Color: '#ff8800' },
    attributes: {},
  });
});

test('end-to-end: disconnected Studio produces a helpful tool error', async (t) => {
  const server = startServer(['--port', '0']);
  await server.port;
  t.after(() => server.child.kill());
  const client = createClient(server.child);

  const response = await client.request('tools/call', { name: 'get_tree', arguments: {} });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /studio_disconnected/);
  assert.match(response.result.content[0].text, /RobloxMCP/);
});

test('--print-config emits a usable client snippet', () => {
  const result = spawnSync(process.execPath, [ENTRY, '--print-config'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  const config = JSON.parse(result.stdout);
  const entry = config.mcpServers['roblox-studio'];
  assert.equal(entry.command, process.execPath);
  assert.equal(entry.args[0], ENTRY);
});

test('rejects an unknown CLI flag', () => {
  const result = spawnSync(process.execPath, [ENTRY, '--nope'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown option/);
});
