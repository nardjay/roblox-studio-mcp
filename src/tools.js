/**
 * MCP tool surface.
 *
 * Every handler receives the normalized argument object plus `{ bridge }` and
 * returns a JSON-serializable value. Paths are Roblox instance paths in the
 * same syntax Studio shows in the Explorer / command bar:
 *
 *   game.Workspace.Model.Part
 *   Workspace.Model.Part
 *   game.Workspace["My Part"].Model
 *
 * Read-only tools have no side effects on the place. Mutating tools are wrapped
 * by the plugin in a single ChangeHistoryService recording, so one tool call is
 * one Ctrl+Z step.
 */

const PATH_DESCRIPTION =
  'Instance path. Accepts "Workspace.Model.Part", "game.Workspace.Model.Part" or ' +
  '"game.Workspace[\\"My Part\\"].Model". Use "game" or omit for the DataModel root.';

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const MUTATING = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

function tool(name, title, description, inputSchema, options = {}) {
  return {
    name,
    title,
    description,
    inputSchema: { type: 'object', additionalProperties: false, ...inputSchema },
    annotations: options.annotations ?? MUTATING,
    timeoutMs: options.timeoutMs,
    handler: options.handler,
  };
}

export const TOOLS = [
  tool(
    'studio_status',
    'Studio status',
    'Check whether the Roblox Studio plugin is connected, which place is open, and the bridge port. ' +
      'Call this first when a tool reports that Studio is disconnected: it tells you whether the plugin is ' +
      'missing, stale (protocol mismatch) or simply not polling.',
    {
      properties: {
        ping: { type: 'boolean', description: 'Also round-trip a ping to the plugin to verify it is responsive. Default true.' },
      },
    },
    {
      annotations: READ_ONLY,
      timeoutMs: 12_000,
      async handler(args, { bridge }) {
        const status = bridge.status();
        const result = { ...status, plugin: status.plugin };
        if (status.connected && args.ping !== false) {
          const started = Date.now();
          try {
            result.ping = await bridge.call('ping', {}, { timeoutMs: 8000 });
            result.roundTripMs = Date.now() - started;
          } catch (error) {
            result.pingError = error.message;
          }
        }
        return result;
      },
    },
  ),

  tool(
    'get_tree',
    'Read Explorer tree',
    'Read the instance hierarchy under a path, breadth-first, with class names and paths. ' +
      'Use this to discover what exists before editing. Returns child counts plus a truncated flag when the ' +
      'tree is larger than maxNodes.',
    {
      properties: {
        path: { type: 'string', description: `${PATH_DESCRIPTION} Default "game".` },
        depth: { type: 'integer', minimum: 1, maximum: 6, description: 'Levels to descend. Default 2.' },
        maxNodes: { type: 'integer', minimum: 1, maximum: 2000, description: 'Node budget. Default 250.' },
        includeProperties: {
          type: 'boolean',
          description: 'Include a small property snapshot per node (slower). Default false.',
        },
        servicesOnly: {
          type: 'boolean',
          description: 'Only list the direct children of the DataModel (services). Default false.',
        },
      },
    },
    {
      annotations: READ_ONLY,
      timeoutMs: 45_000,
      handler: (args, { bridge }) =>
        bridge.call('getTree', {
          path: asString(args.path ?? 'game', 'game'),
          depth: asNumber(args.depth, 2),
          maxNodes: asNumber(args.maxNodes, 250),
          includeProperties: Boolean(args.includeProperties),
          servicesOnly: Boolean(args.servicesOnly),
        }),
    },
  ),

  tool(
    'search_instances',
    'Search instances',
    'Find instances by name substring and/or class name under a subtree, traversing descendants. ' +
      'This is the fastest way to locate a script, part or GUI by name when you do not know its full path.',
    {
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring of Instance.Name. Omit to match all names.' },
        under: { type: 'string', description: `${PATH_DESCRIPTION} Default "game".` },
        className: {
          type: 'string',
          description: 'Exact ClassName filter, or a trailing-* wildcard such as "Script" / "*Script".',
        },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max matches. Default 50.' },
      },
    },
    {
      annotations: READ_ONLY,
      timeoutMs: 60_000,
      handler: (args, { bridge }) =>
        bridge.call('searchInstances', {
          query: asString(args.query, ''),
          under: asString(args.under ?? 'game', 'game'),
          className: asString(args.className, ''),
          limit: asNumber(args.limit, 50),
        }),
    },
  ),

  tool(
    'get_instance',
    'Read instance',
    'Read one instance: ClassName, parent path, attributes, and property values encoded as readable JSON. ' +
      'Datatypes come back tagged, e.g. {"__type":"Vector3","x":1,"y":2,"z":3} or ' +
      '{"__type":"CFrame","components":[...]}. Omit "properties" to get a curated snapshot.',
    {
      properties: {
        path: { type: 'string', description: PATH_DESCRIPTION },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact property names to read. Omit for an automatic snapshot of the most useful ones.',
        },
      },
      required: ['path'],
    },
    {
      annotations: READ_ONLY,
      timeoutMs: 30_000,
      handler: (args, { bridge }) => {
        if (!args.path) throw new Error('path is required');
        return bridge.call('getInstance', {
          path: String(args.path),
          properties: Array.isArray(args.properties) ? args.properties.map(String) : null,
        });
      },
    },
  ),

  tool(
    'create_instance',
    'Create instance',
    'Create a new instance of a ClassName under a parent and optionally set properties in the same call. ' +
      'Typical use: Part in Workspace, TextLabel in a ScreenGui, Script with a Source property, Folder for grouping. ' +
      'Property values use the same tagged JSON that get_instance returns; plain strings are accepted for enums ' +
      '("Neon"), Color3 ("#ff8800" or {"__type":"Color3",...}) and instance references.',
    {
      properties: {
        className: { type: 'string', description: 'Roblox ClassName, e.g. "Part", "Model", "Script", "TextLabel".' },
        parent: { type: 'string', description: `${PATH_DESCRIPTION} Default "Workspace".` },
        name: { type: 'string', description: 'Instance name. Defaults to the ClassName.' },
        properties: {
          type: 'object',
          description: 'Property map applied after creation. Unknown or read-only properties are reported, not fatal.',
          additionalProperties: true,
        },
        attributes: {
          type: 'object',
          description: 'Attribute map applied after creation (string/number/boolean values).',
          additionalProperties: true,
        },
      },
      required: ['className'],
    },
    {
      annotations: MUTATING,
      timeoutMs: 30_000,
      handler: (args, { bridge }) => {
        if (!args.className) throw new Error('className is required');
        return bridge.call('createInstance', {
          className: String(args.className),
          parent: asString(args.parent ?? 'Workspace', 'Workspace'),
          name: args.name == null ? null : String(args.name),
          properties: args.properties && typeof args.properties === 'object' ? args.properties : {},
          attributes: args.attributes && typeof args.attributes === 'object' ? args.attributes : {},
        });
      },
    },
  ),

  tool(
    'set_properties',
    'Set properties',
    'Set one or more properties on an existing instance. Values may be primitives or tagged datatypes such as ' +
      '{"__type":"Vector3","x":0,"y":10,"z":0}, {"__type":"CFrame","components":[...]}, ' +
      '{"__type":"UDim2","xs":0,"xo":0,"ys":0,"yo":0}, "Enum.Material.Neon" or a plain enum name. ' +
      'Read-only properties and type mismatches are reported individually and do not abort the rest.',
    {
      properties: {
        path: { type: 'string', description: PATH_DESCRIPTION },
        properties: { type: 'object', additionalProperties: true, description: 'Property name -> value map.' },
        attributes: {
          type: 'object',
          additionalProperties: true,
          description: 'Attribute name -> value map. Passing null removes an attribute.',
        },
      },
      required: ['path', 'properties'],
    },
    {
      annotations: MUTATING,
      timeoutMs: 30_000,
      handler: (args, { bridge }) => {
        if (!args.path) throw new Error('path is required');
        if (!args.properties || typeof args.properties !== 'object') throw new Error('properties must be an object');
        return bridge.call('setProperties', {
          path: String(args.path),
          properties: args.properties,
          attributes: args.attributes && typeof args.attributes === 'object' ? args.attributes : {},
        });
      },
    },
  ),

  tool(
    'delete_instance',
    'Delete instance',
    'Destroy an instance and its descendants. Recoverable with the history tool (undo) until the place is closed.',
    {
      properties: { path: { type: 'string', description: PATH_DESCRIPTION } },
      required: ['path'],
    },
    {
      annotations: DESTRUCTIVE,
      timeoutMs: 30_000,
      handler: (args, { bridge }) => {
        if (!args.path) throw new Error('path is required');
        return bridge.call('deleteInstance', { path: String(args.path) });
      },
    },
  ),

  tool(
    'clone_instance',
    'Clone instance',
    'Deep-clone an instance (Archivable is set on the clone), optionally renaming it and placing it under a new parent.',
    {
      properties: {
        path: { type: 'string', description: PATH_DESCRIPTION },
        parent: { type: 'string', description: 'New parent path. Defaults to the original parent.' },
        name: { type: 'string', description: 'Name for the clone.' },
      },
      required: ['path'],
    },
    {
      annotations: MUTATING,
      timeoutMs: 30_000,
      handler: (args, { bridge }) => {
        if (!args.path) throw new Error('path is required');
        return bridge.call('cloneInstance', {
          path: String(args.path),
          parent: args.parent == null ? null : String(args.parent),
          name: args.name == null ? null : String(args.name),
        });
      },
    },
  ),

  tool(
    'reparent_instance',
    'Move instance',
    'Move an existing instance under a different parent, optionally renaming it.',
    {
      properties: {
        path: { type: 'string', description: PATH_DESCRIPTION },
        parent: { type: 'string', description: 'Destination parent path.' },
        name: { type: 'string', description: 'Optional new name.' },
      },
      required: ['path', 'parent'],
    },
    {
      annotations: MUTATING,
      timeoutMs: 30_000,
      handler: (args, { bridge }) => {
        if (!args.path || !args.parent) throw new Error('path and parent are required');
        return bridge.call('reparentInstance', {
          path: String(args.path),
          parent: String(args.parent),
          name: args.name == null ? null : String(args.name),
        });
      },
    },
  ),

  tool(
    'get_script_source',
    'Read script source',
    'Read the full Source of a Script, LocalScript or ModuleScript. Line numbers are 1-based in the returned text.',
    {
      properties: { path: { type: 'string', description: PATH_DESCRIPTION } },
      required: ['path'],
    },
    {
      annotations: READ_ONLY,
      timeoutMs: 30_000,
      handler: (args, { bridge }) => {
        if (!args.path) throw new Error('path is required');
        return bridge.call('getScriptSource', { path: String(args.path) });
      },
    },
  ),

  tool(
    'set_script_source',
    'Write script source',
    'Replace the entire Source of a script. Prefer edit_script for small changes: rewriting a file from memory ' +
      'risks losing code you have not read. If the script is open in Studio, the editor buffer is updated through ' +
      'ScriptEditorService so Studio does not show a stale file.',
    {
      properties: {
        path: { type: 'string', description: PATH_DESCRIPTION },
        source: { type: 'string', description: 'Complete new source text.' },
      },
      required: ['path', 'source'],
    },
    {
      annotations: MUTATING,
      timeoutMs: 45_000,
      handler: (args, { bridge }) => {
        if (!args.path) throw new Error('path is required');
        if (typeof args.source !== 'string') throw new Error('source must be a string');
        return bridge.call('setScriptSource', { path: String(args.path), source: args.source });
      },
    },
  ),

  tool(
    'edit_script',
    'Edit script text',
    'Apply an exact literal string replacement inside a script. Fails if find is missing, so a bad edit cannot ' +
      'silently corrupt the file. Set all=true to replace every occurrence, otherwise the occurrence must be unique ' +
      'unless occurrence (1-based) is given.',
    {
      properties: {
        path: { type: 'string', description: PATH_DESCRIPTION },
        find: { type: 'string', description: 'Exact literal text to find (not a pattern).' },
        replace: { type: 'string', description: 'Replacement text.' },
        all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
        occurrence: { type: 'integer', minimum: 1, description: 'Which 1-based occurrence to replace when all=false.' },
      },
      required: ['path', 'find', 'replace'],
    },
    {
      annotations: MUTATING,
      timeoutMs: 45_000,
      handler: (args, { bridge }) => {
        if (!args.path) throw new Error('path is required');
        if (typeof args.find !== 'string' || args.find.length === 0) throw new Error('find must be a non-empty string');
        if (typeof args.replace !== 'string') throw new Error('replace must be a string');
        return bridge.call('editScript', {
          path: String(args.path),
          find: args.find,
          replace: args.replace,
          all: Boolean(args.all),
          occurrence: args.occurrence == null ? null : asNumber(args.occurrence, 1),
        });
      },
    },
  ),

  tool(
    'get_selection',
    'Read selection',
    'Read the instances currently selected in Studio. This reflects what the user is looking at right now, ' +
      'which is often a better anchor than guessing a path.',
    { properties: {} },
    {
      annotations: READ_ONLY,
      timeoutMs: 15_000,
      handler: (_args, { bridge }) => bridge.call('getSelection', {}),
    },
  ),

  tool(
    'set_selection',
    'Set selection',
    'Select instances in Studio so the user can see what you changed. focus=true also moves the camera to them ' +
      '(only works for 3D instances).',
    {
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Instance paths to select.' },
        focus: { type: 'boolean', description: 'Move the Studio camera to the selection. Default false.' },
      },
      required: ['paths'],
    },
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      timeoutMs: 20_000,
      handler: (args, { bridge }) => {
        if (!Array.isArray(args.paths)) throw new Error('paths must be an array of instance paths');
        return bridge.call('setSelection', { paths: args.paths.map(String), focus: Boolean(args.focus) });
      },
    },
  ),

  tool(
    'insert_asset',
    'Insert asset',
    'Insert a Roblox asset (model, mesh part, tool) by asset id using InsertService. Requires the asset to be ' +
      'public or owned by the signed-in account, and needs an internet connection in Studio.',
    {
      properties: {
        assetId: { type: 'integer', minimum: 1, description: 'Roblox asset id, e.g. 1033714.' },
        parent: { type: 'string', description: `${PATH_DESCRIPTION} Default "Workspace".` },
        name: { type: 'string', description: 'Optional name override for the inserted instance.' },
      },
      required: ['assetId'],
    },
    {
      annotations: MUTATING,
      timeoutMs: 90_000,
      handler: (args, { bridge }) => {
        const assetId = asNumber(args.assetId, 0);
        if (!assetId) throw new Error('assetId must be a positive integer');
        return bridge.call('insertAsset', {
          assetId: Math.trunc(assetId),
          parent: asString(args.parent ?? 'Workspace', 'Workspace'),
          name: args.name == null ? null : String(args.name),
        });
      },
    },
  ),

  tool(
    'history',
    'Undo / redo',
    'Undo or redo the last change in Studio, or write an explicit waypoint into the undo history. ' +
      'Each of your mutating tool calls is already a single undo step, so "undo" reverses the last tool call.',
    {
      properties: {
        action: { type: 'string', enum: ['undo', 'redo', 'waypoint'], description: 'Operation to perform.' },
      },
      required: ['action'],
    },
    {
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      timeoutMs: 20_000,
      handler: (args, { bridge }) => {
        const action = String(args.action ?? '');
        if (!['undo', 'redo', 'waypoint'].includes(action)) throw new Error('action must be undo, redo or waypoint');
        return bridge.call('history', { action });
      },
    },
  ),

  tool(
    'get_console_output',
    'Read Studio output',
    'Read recent Studio Output-window lines captured by the plugin (print/warn/error from Studio and from ' +
      'playtests that the plugin is attached to). Useful after loading a script or inserting a model.',
    {
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max lines to return, newest last. Default 50.' },
        clear: { type: 'boolean', description: 'Clear the buffer after reading. Default false.' },
        messageType: {
          type: 'string',
          enum: ['all', 'message', 'warning', 'error'],
          description: 'Filter by output type. Default all.',
        },
      },
    },
    {
      annotations: READ_ONLY,
      timeoutMs: 15_000,
      handler: (args, { bridge }) => {
        const limit = asNumber(args.limit, 50);
        const messageType = asString(args.messageType, 'all');
        if (args.clear === true) {
          const buffered = bridge.logs(limit);
          bridge.clearLogs();
          return { lines: buffered, cleared: true };
        }
        return bridge
          .call('getLogs', { limit, messageType }, { timeoutMs: 12_000 })
          .catch(() => ({ lines: bridge.logs(limit), source: 'server-buffer' }));
      },
    },
  ),

  tool(
    'run_selftest',
    'Plugin self-test',
    'Ask the plugin to verify its own capabilities inside this Studio build: source read/write, ChangeHistoryService ' +
      'recordings, InsertService, ScriptEditorService, Selection and HTTP. Use it when a tool misbehaves and you ' +
      'need to know which Studio API is unavailable instead of guessing.',
    { properties: {} },
    {
      annotations: READ_ONLY,
      timeoutMs: 30_000,
      handler: (_args, { bridge }) => bridge.call('selftest', {}),
    },
  ),
];

export const TOOL_BY_NAME = new Map(TOOLS.map((item) => [item.name, item]));
