const BASE = 'http://127.0.0.1:44755/v1/rpc';

async function rpc(method, params = {}) {
  const response = await fetch(BASE, {
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

// Clean slate for the demo.
for (const path of ['Workspace.Hello_from_RobloxMCP', 'Workspace.MCP_Demo']) {
  try {
    await rpc('deleteInstance', { path });
  } catch (error) {
    if (!error.message.includes('invalid_path')) throw error;
  }
}

const folder = await rpc('createInstance', { className: 'Folder', parent: 'Workspace', name: 'MCP_Demo' });
const root = folder.path;

await rpc('createInstance', {
  className: 'Part',
  parent: root,
  name: 'Base',
  properties: {
    Size: v3(26, 1, 26),
    CFrame: at(0, 0, 0),
    Material: 'SmoothPlastic',
    Color: '#232733',
    Anchored: true,
  },
});

const pillars = [
  { x: -11, z: -11, color: '#ff3d78' },
  { x: 11, z: -11, color: '#33d6ff' },
  { x: -11, z: 11, color: '#ffd23d' },
  { x: 11, z: 11, color: '#4dff88' },
];

for (const [index, pillar] of pillars.entries()) {
  await rpc('createInstance', {
    className: 'Part',
    parent: root,
    name: `Pillar${index + 1}`,
    properties: {
      Size: v3(2, 9, 2),
      CFrame: at(pillar.x, 4.5, pillar.z),
      Material: 'Neon',
      Color: pillar.color,
      Anchored: true,
    },
  });
}

const spin = await rpc('createInstance', {
  className: 'Part',
  parent: root,
  name: 'Spinner',
  properties: {
    Size: v3(18, 0.6, 2),
    CFrame: at(0, 9.5, 0),
    Material: 'Neon',
    Color: '#7c5cff',
    Anchored: true,
  },
});

await rpc('createInstance', {
  className: 'Script',
  parent: spin.path,
  name: 'Spin',
  properties: {
    Source: [
      'local part = script.Parent',
      'local angle = 0',
      '',
      'while true do',
      '    angle += math.rad(1.2)',
      '    part.CFrame = CFrame.new(0, 9.5, 0) * CFrame.Angles(0, angle, 0)',
      '    task.wait()',
      'end',
      '',
    ].join('\n'),
  },
});

const sign = await rpc('createInstance', {
  className: 'Part',
  parent: root,
  name: 'Sign',
  properties: {
    Size: v3(1, 1, 1),
    CFrame: at(0, 12.5, 0),
    Transparency: 1,
    CanCollide: false,
    Anchored: true,
  },
});

const billboard = await rpc('createInstance', {
  className: 'BillboardGui',
  parent: sign.path,
  name: 'Board',
  properties: {
    Size: udim2(0, 380, 0, 110),
    AlwaysOnTop: true,
    LightInfluence: 0,
    MaxDistance: 300,
  },
});

await rpc('createInstance', {
  className: 'TextLabel',
  parent: billboard.path,
  name: 'Caption',
  properties: {
    Size: udim2(1, 0, 1, 0),
    BackgroundColor3: '#11131a',
    BackgroundTransparency: 0.15,
    TextColor3: '#ffffff',
    Text: 'RobloxMCP\nbuilt live from this chat',
    TextScaled: true,
    TextWrapped: true,
    Font: 'GothamBold',
  },
});

await rpc('setProperties', {
  path: 'Lighting',
  properties: { ClockTime: 16.5, Brightness: 2.4, Ambient: { __type: 'Color3', r: 0.25, g: 0.25, b: 0.3 } },
});

await rpc('setSelection', { paths: [`${root}.Spinner`, `${root}.Sign`], focus: false });

const tree = await rpc('getTree', { path: root, depth: 3, maxNodes: 60 });
console.log(JSON.stringify({ root, nodes: tree.nodes.length, paths: tree.nodes.map((node) => node.name) }, null, 1));
