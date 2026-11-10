#!/usr/bin/env node
/**
 * Manual smoke test against a live Roblox Studio session.
 *
 *   1. npm start                     (in one terminal)
 *   2. open Studio, enable the RobloxMCP plugin, press Connect
 *   3. node scripts/smoke-studio.mjs
 *
 * Exercises every bridge method and cleans up the instances it creates.
 */
const BASE = process.env.ROBLOX_MCP_URL ?? 'http://127.0.0.1:44755';
const results = [];

async function rpc(method, params = {}, timeoutMs = 30_000) {
  const response = await fetch(`${BASE}/v1/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params, timeoutMs }),
  });
  const body = await response.json();
  if (!body.ok) {
    const error = new Error(`${method}: ${body.error?.message ?? 'unknown error'}`);
    error.code = body.error?.code;
    throw error;
  }
  return body.result;
}

async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    process.stdout.write(`PASS  ${name} (${Date.now() - started}ms)${detail ? ` — ${detail}` : ''}\n`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, detail: error.message });
    process.stdout.write(`FAIL  ${name} (${Date.now() - started}ms) — ${error.message}\n`);
  }
}

const status = await fetch(`${BASE}/v1/status`).then((response) => response.json());
if (!status.connected) {
  console.error(`Roblox Studio is not connected to ${BASE}. Start the server and press Connect in the plugin.`);
  process.exit(2);
}
console.log(`connected to "${status.plugin.placeName}" (server ${status.serverVersion}, port ${status.port})\n`);

const suffix = Date.now().toString(36).slice(-4);
const partName = `McpSmokePart_${suffix}`;
const scriptName = `McpSmokeScript_${suffix}`;
const cloneName = `McpSmokeClone_${suffix}`;
const modelName = `McpSmokeModel_${suffix}`;

await step('ping', async () => (await rpc('ping')).placeName);
await step('get_tree', async () => {
  const tree = await rpc('getTree', { path: 'game', depth: 1, maxNodes: 25 });
  return `${tree.nodes.length} nodes, truncated=${tree.truncated}`;
});
await step('run_selftest', async () => {
  const test = await rpc('selftest');
  const failed = test.checks.filter((check) => !check.ok);
  if (failed.length > 0) throw new Error(`failing checks: ${failed.map((check) => check.name).join(', ')}`);
  return `${test.checks.length} checks ok`;
});

await step('create_instance (Part)', async () => {
  const created = await rpc('createInstance', {
    className: 'Part',
    parent: 'Workspace',
    name: partName,
    properties: {
      Size: { __type: 'Vector3', x: 4, y: 1, z: 2 },
      Anchored: true,
      Color: '#ff8800',
      Material: 'Neon',
    },
  });
  if (created.errors.length > 0) throw new Error(JSON.stringify(created.errors));
  return created.path;
});

await step('get_instance (enum + datatype round-trip)', async () => {
  const part = await rpc('getInstance', {
    path: `Workspace.${partName}`,
    properties: ['Size', 'Color', 'Material', 'Anchored', 'Name'],
  });
  const material = part.properties.Material;
  if (material?.name !== 'Neon') throw new Error(`Material is ${JSON.stringify(material)}`);
  if (part.properties.Size?.x !== 4) throw new Error(`Size is ${JSON.stringify(part.properties.Size)}`);
  return `Material=${material.name}, Size.x=${part.properties.Size.x}`;
});

await step('set_properties (CFrame + enum + color)', async () => {
  const result = await rpc('setProperties', {
    path: `Workspace.${partName}`,
    properties: {
      CFrame: { __type: 'CFrame', components: [0, 5, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
      Material: 'Enum.Material.Glass',
      Color: { __type: 'Color3', r: 0.1, g: 0.6, b: 1 },
    },
  });
  if (result.errors.length > 0) throw new Error(JSON.stringify(result.errors));
  const part = await rpc('getInstance', { path: `Workspace.${partName}`, properties: ['Material', 'Position'] });
  if (part.properties.Material?.name !== 'Glass') throw new Error('Material did not change');
  return `applied ${result.applied.join(', ')}`;
});

await step('search_instances', async () => {
  const found = await rpc('searchInstances', { query: partName, limit: 5 });
  if (found.count !== 1) throw new Error(`expected 1 match, got ${found.count}`);
  return found.matches[0].path;
});

await step('create_instance (Script with Source)', async () => {
  const created = await rpc('createInstance', {
    className: 'Script',
    parent: 'ServerScriptService',
    name: scriptName,
    properties: { Source: 'local greeting = "hello"\nprint(greeting)\n' },
  });
  return created.path;
});

await step('get_script_source', async () => {
  const script = await rpc('getScriptSource', { path: `ServerScriptService.${scriptName}` });
  if (!script.source.includes('hello')) throw new Error('source did not round-trip');
  return `${script.lineCount} lines`;
});

await step('edit_script', async () => {
  const edited = await rpc('editScript', {
    path: `ServerScriptService.${scriptName}`,
    find: 'local greeting = "hello"',
    replace: 'local greeting = "hello from MCP"',
  });
  if (edited.replaced !== 1) throw new Error(`replaced ${edited.replaced}`);
  const check = await rpc('getScriptSource', { path: `ServerScriptService.${scriptName}` });
  if (!check.source.includes('hello from MCP')) throw new Error('edit not visible');
  return 'replaced 1 occurrence';
});

await step('edit_script (missing text is rejected)', async () => {
  try {
    await rpc('editScript', { path: `ServerScriptService.${scriptName}`, find: '__nope__', replace: 'x' });
  } catch (error) {
    if (error.code !== 'not_found') throw error;
    return error.code;
  }
  throw new Error('expected a not_found error');
});

await step('clone_instance', async () => {
  const clone = await rpc('cloneInstance', {
    path: `Workspace.${partName}`,
    parent: 'Workspace',
    name: cloneName,
  });
  return clone.path;
});

await step('reparent_instance', async () => {
  const model = await rpc('createInstance', { className: 'Model', parent: 'Workspace', name: modelName });
  const moved = await rpc('reparentInstance', {
    path: `Workspace.${cloneName}`,
    parent: model.path,
  });
  return moved.path;
});

await step('set_selection / get_selection', async () => {
  await rpc('setSelection', { paths: [`Workspace.${partName}`], focus: false });
  const selection = await rpc('getSelection');
  if (selection.count !== 1 || selection.selection[0].name !== partName) throw new Error('selection mismatch');
  return `${selection.count} selected`;
});

await step('get_console_output', async () => {
  const logs = await rpc('getLogs', { limit: 5 });
  return `${logs.lines.length} of ${logs.total} lines`;
});

await step('history (undo + redo)', async () => {
  await rpc('history', { action: 'undo' });
  const afterUndo = await rpc('searchInstances', { query: cloneName, limit: 5 });
  await rpc('history', { action: 'redo' });
  const afterRedo = await rpc('searchInstances', { query: cloneName, limit: 5 });
  return `undo→${afterUndo.count} redo→${afterRedo.count}`;
});

await step('cleanup', async () => {
  for (const path of [`Workspace.${partName}`, `Workspace.${cloneName}`, `Workspace.${modelName}`, `ServerScriptService.${scriptName}`]) {
    try {
      await rpc('deleteInstance', { path });
    } catch (error) {
      if (error.code !== 'invalid_path') throw error;
    }
  }
  const remaining = await rpc('searchInstances', { query: suffix, limit: 20 });
  return `${remaining.count} leftovers`;
});

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
process.exit(failed.length === 0 ? 0 : 1);
