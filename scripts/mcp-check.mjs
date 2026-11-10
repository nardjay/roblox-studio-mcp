#!/usr/bin/env node
/**
 * Verifies the MCP layer itself: speaks JSON-RPC over stdio to the server,
 * asks for the tool list, and runs a few read-only tools against Studio.
 *
 * Requires the server to be free to bind its port and the Studio plugin to be
 * connected (the plugin reconnects automatically when the server restarts).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const ENTRY = fileURLToPath(new URL('../bin/roblox-mcp.js', import.meta.url));
const PORT = Number(process.env.ROBLOX_MCP_PORT ?? 44755);
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [ENTRY, '--port', String(PORT)], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  if (process.env.DEBUG) process.stderr.write(chunk);
});

const messages = [];
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  if (line.trim()) messages.push(JSON.parse(line));
});

let nextId = 1;
async function request(method, params, timeoutMs = 20000) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find((message) => message.id === id);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no response to ${method}`);
}

async function waitForStudio(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await fetch(`${BASE}/v1/status`).then((response) => response.json());
      if (status.connected) return status;
    } catch {
      /* server still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

try {
  const status = await waitForStudio();
  if (!status) throw new Error('the RobloxMCP plugin never connected; is Studio open with the plugin enabled?');

  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-check', version: '1.0.0' },
  });
  check('initialize', init.result?.protocolVersion === '2025-06-18', init.result?.serverInfo?.name);
  check('instructions mention studio_status', /studio_status/.test(init.result?.instructions ?? ''));

  const list = await request('tools/list', {});
  const names = (list.result?.tools ?? []).map((tool) => tool.name);
  check('tools/list', names.length >= 15, `${names.length} tools`);
  check('has core tools', ['get_tree', 'set_properties', 'edit_script', 'run_selftest'].every((name) => names.includes(name)));

  const toolStatus = await request('tools/call', { name: 'studio_status', arguments: {} });
  const statusPayload = JSON.parse(toolStatus.result.content[0].text);
  check('studio_status tool', statusPayload.connected === true, statusPayload.plugin?.placeName);

  const tree = await request('tools/call', { name: 'get_tree', arguments: { depth: 1, maxNodes: 6 } });
  check('get_tree tool', tree.result.isError !== true, `${JSON.parse(tree.result.content[0].text).nodes.length} nodes`);

  const selection = await request('tools/call', { name: 'get_selection', arguments: {} });
  check('get_selection tool', selection.result.isError !== true, selection.result.content[0].text.slice(0, 60));

  const selfTest = await request('tools/call', { name: 'run_selftest', arguments: {} });
  const selfTestPayload = JSON.parse(selfTest.result.content[0].text);
  const failing = (selfTestPayload.checks ?? []).filter((item) => !item.ok);
  check('run_selftest tool', failing.length === 0, `${selfTestPayload.checks?.length ?? 0} checks`);
} catch (error) {
  failures.push(error.message);
  console.error(`ERROR ${error.message}`);
} finally {
  child.kill();
}

console.log(failures.length === 0 ? '\nMCP layer OK' : `\n${failures.length} failure(s)`);
process.exit(failures.length === 0 ? 0 : 1);
