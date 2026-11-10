#!/usr/bin/env node
/**
 * Builds the clicker game in the open Studio place through the MCP bridge.
 *
 * Uses examples/clicker/*.luau as the script sources, so the files on disk stay
 * the source of truth. Re-running rebuilds the game from scratch.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.ROBLOX_MCP_URL ?? 'http://127.0.0.1:44755';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.join(HERE, '..', 'examples', 'clicker');

async function rpc(method, params = {}) {
  const response = await fetch(`${BASE}/v1/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params, timeoutMs: 30000 }),
  });
  const body = await response.json();
  if (!body.ok) throw new Error(`${method}: ${body.error?.code} ${body.error?.message}`);
  return body.result;
}

const v3 = (x, y, z) => ({ __type: 'Vector3', x, y, z });
const at = (x, y, z) => ({ __type: 'CFrame', components: [x, y, z, 1, 0, 0, 0, 1, 0, 0, 0, 1] });
const udim2 = (xs, xo, ys, yo) => ({ __type: 'UDim2', xs, xo, ys, yo });
const rgb = (r, g, b) => ({ __type: 'Color3', r, g, b });

const origin = { x: 0, y: 0.5, z: 18 };
const place = (dx, dy, dz) => at(origin.x + dx, origin.y + dy, origin.z + dz);

async function create(className, parent, name, properties = {}) {
  return rpc('createInstance', { className, parent, name, properties });
}

async function removeIfPresent(pathToInstance) {
  try {
    await rpc('deleteInstance', { path: pathToInstance });
  } catch (error) {
    if (!error.message.includes('invalid_path')) throw error;
  }
}

console.log('cleaning up previous build...');
for (const old of [
  'Workspace.ClickerGame',
  'StarterGui.ClickerGui',
  'ServerScriptService.ClickerServer',
  'ServerScriptService.ClickerLogic',
  'ReplicatedStorage.CoinsChanged',
  'ReplicatedStorage.BuyUpgrade',
  'ReplicatedStorage.GetClickerState',
  'ReplicatedStorage.RequestClick',
]) {
  await removeIfPresent(old);
}

console.log('building arena...');
const folder = await create('Folder', 'Workspace', 'ClickerGame');
const root = folder.path;

await create('Part', root, 'Base', {
  Size: v3(26, 1, 26),
  CFrame: place(0, 0, 0),
  Material: 'SmoothPlastic',
  Color: rgb(0.11, 0.13, 0.19),
  Anchored: true,
});

const button = await create('Part', root, 'Button', {
  Size: v3(12, 8, 1),
  CFrame: place(0, 4.5, -6),
  Material: 'Neon',
  Color: '#33d6ff',
  Anchored: true,
});

await create('ClickDetector', button.path, 'ClickDetector', { MaxActivationDistance: 40 });

for (const [index, corner] of [
  [-11, -11],
  [11, -11],
  [-11, 11],
  [11, 11],
].entries()) {
  await create('Part', root, `Lamp${index + 1}`, {
    Size: v3(1, 3, 1),
    CFrame: place(corner[0], 1.5, corner[1]),
    Material: 'Neon',
    Color: '#ffd23d',
    Anchored: true,
  });
}

// Spawn on the platform, facing the button. The place's original spawn is
// disabled (not deleted) so players do not spawn behind the billboard.
await create('SpawnLocation', root, 'PlayerSpawn', {
  Size: v3(6, 1, 6),
  CFrame: place(0, 1.0, 6),
  Anchored: true,
  Neutral: true,
  Duration: 0,
  Transparency: 0.5,
  Material: 'SmoothPlastic',
  Color: rgb(0.2, 0.25, 0.35),
});

try {
  await rpc('setProperties', { path: 'Workspace.SpawnLocation', properties: { Enabled: false } });
} catch (error) {
  console.log('note: could not disable the original SpawnLocation:', error.message);
}

console.log('wiring remotes...');
await create('RemoteEvent', 'ReplicatedStorage', 'CoinsChanged');
await create('RemoteEvent', 'ReplicatedStorage', 'BuyUpgrade');
await create('RemoteEvent', 'ReplicatedStorage', 'RequestClick');
await create('RemoteFunction', 'ReplicatedStorage', 'GetClickerState');

console.log('building UI...');
const gui = await create('ScreenGui', 'StarterGui', 'ClickerGui', {
  IgnoreGuiInset: true,
  ResetOnSpawn: false,
  DisplayOrder: 5,
});

const panel = await create('Frame', gui.path, 'Panel', {
  Size: udim2(0, 300, 0, 196),
  Position: udim2(0, 20, 0, 64),
  BackgroundColor3: rgb(0.07, 0.08, 0.11),
  BackgroundTransparency: 0.08,
  BorderSizePixel: 0,
});
await create('UICorner', panel.path, 'Corner', { CornerRadius: { __type: 'UDim', scale: 0, offset: 10 } });

await create('TextLabel', panel.path, 'Title', {
  Size: udim2(1, -32, 0, 22),
  Position: udim2(0, 16, 0, 10),
  BackgroundTransparency: 1,
  Font: 'GothamBold',
  Text: 'COIN CLICKER',
  TextColor3: rgb(0.85, 0.88, 0.95),
  TextSize: 16,
  TextXAlignment: 'Left',
});

await create('TextLabel', panel.path, 'Coins', {
  Size: udim2(1, -32, 0, 44),
  Position: udim2(0, 16, 0, 34),
  BackgroundTransparency: 1,
  Font: 'GothamBlack',
  Text: '0',
  TextColor3: '#ffd23d',
  TextSize: 40,
  TextXAlignment: 'Left',
});

await create('TextLabel', panel.path, 'Stats', {
  Size: udim2(1, -32, 0, 18),
  Position: udim2(0, 16, 0, 80),
  BackgroundTransparency: 1,
  Font: 'Gotham',
  Text: '+1 per click   ·   0 per second',
  TextColor3: rgb(0.55, 0.6, 0.7),
  TextSize: 13,
  TextXAlignment: 'Left',
});

const clickButton = await create('TextButton', panel.path, 'ClickUpgrade', {
  Size: udim2(1, -32, 0, 32),
  Position: udim2(0, 16, 0, 108),
  BackgroundColor3: '#4c91ff',
  BorderSizePixel: 0,
  Font: 'GothamBold',
  Text: 'Better Click   →   10',
  TextColor3: rgb(1, 1, 1),
  TextSize: 14,
});
await create('UICorner', clickButton.path, 'Corner', { CornerRadius: { __type: 'UDim', scale: 0, offset: 8 } });

const autoButton = await create('TextButton', panel.path, 'AutoUpgrade', {
  Size: udim2(1, -32, 0, 32),
  Position: udim2(0, 16, 0, 148),
  BackgroundColor3: '#4cc88c',
  BorderSizePixel: 0,
  Font: 'GothamBold',
  Text: 'Auto Clicker   →   25',
  TextColor3: rgb(1, 1, 1),
  TextSize: 14,
});
await create('UICorner', autoButton.path, 'Corner', { CornerRadius: { __type: 'UDim', scale: 0, offset: 8 } });

await create('TextLabel', gui.path, 'Hint', {
  Size: udim2(0, 460, 0, 20),
  Position: udim2(0, 20, 1, -52),
  BackgroundTransparency: 1,
  Font: 'Gotham',
  Text: 'Click the neon block. Upgrades are permanent for this session.',
  TextColor3: rgb(0.6, 0.65, 0.75),
  TextSize: 12,
  TextXAlignment: 'Left',
});

await create('TextLabel', gui.path, 'Popup', {
  Size: udim2(0, 200, 0, 56),
  Position: udim2(0.5, -100, 0.62, 0),
  BackgroundTransparency: 1,
  Font: 'GothamBlack',
  Text: '+1',
  TextColor3: '#ffd23d',
  TextSize: 34,
  TextTransparency: 1,
});

const clickArea = await create('TextButton', gui.path, 'ClickArea', {
  Size: udim2(0, 220, 0, 64),
  Position: udim2(0.5, -110, 1, -132),
  BackgroundColor3: '#4c91ff',
  BorderSizePixel: 0,
  Font: 'GothamBlack',
  Text: 'CLICK',
  TextColor3: rgb(1, 1, 1),
  TextSize: 26,
});
await create('UICorner', clickArea.path, 'Corner', { CornerRadius: { __type: 'UDim', scale: 0, offset: 14 } });

console.log('pushing scripts...');
const logicSource = await readFile(path.join(EXAMPLES, 'ClickerLogic.luau'), 'utf8');
const serverSource = await readFile(path.join(EXAMPLES, 'ClickerServer.server.luau'), 'utf8');
const clientSource = await readFile(path.join(EXAMPLES, 'ClickerClient.client.luau'), 'utf8');

await create('ModuleScript', 'ServerScriptService', 'ClickerLogic', { Source: logicSource });
await create('Script', 'ServerScriptService', 'ClickerServer', { Source: serverSource });
await create('LocalScript', gui.path, 'ClickerClient', { Source: clientSource });

await rpc('setSelection', { paths: [button.path], focus: true });

const tree = await rpc('getTree', { path: root, depth: 2, maxNodes: 60 });
const summary = {
  gameFolder: root,
  instances: tree.nodes.map((node) => `${node.name} (${node.className})`),
  logicScriptLines: logicSource.split('\n').length,
  serverScriptLines: serverSource.split('\n').length,
  clientScriptLines: clientSource.split('\n').length,
};
console.log(JSON.stringify(summary, null, 1));
