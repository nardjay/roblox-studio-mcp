import readline from 'node:readline';

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

const INSTRUCTIONS = [
  'This server controls a live Roblox Studio session through the companion "RobloxMCP" Studio plugin.',
  'Start with studio_status: it reports whether Studio is attached and which place is open.',
  'Discover before editing: get_tree lists services/children, search_instances finds things by name or class,',
  'and get_selection reads what the user has selected. Paths look like Workspace.Model.Part.',
  'Mutating calls (create_instance, set_properties, delete_instance, clone_instance, reparent_instance,',
  'set_script_source, edit_script, insert_asset) are each one undo step in Studio, so history undo reverses',
  'the last call. Prefer edit_script over set_script_source for small changes, and read source before rewriting it.',
  'Datatype values are tagged JSON: {"__type":"Vector3","x":0,"y":5,"z":0}, {"__type":"CFrame","components":[...]}',
  'and plain strings such as "Neon" or "#ff8800" are accepted for enums and Color3.',
].join(' ');

function errorResponse(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function resultResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0).
 * Implements initialize / ping / tools / empty resource+prompt catalogs.
 */
export class McpServer {
  constructor({ tools, bridge, version = '0.0.0', input = process.stdin, output = process.stdout, log = () => {} }) {
    this.tools = tools;
    this.toolByName = new Map(tools.map((item) => [item.name, item]));
    this.bridge = bridge;
    this.version = version;
    this.input = input;
    this.output = output;
    this.log = log;
    this.readline = null;
    this.initialized = false;
  }

  start() {
    this.readline = readline.createInterface({ input: this.input, crlfDelay: Infinity, terminal: false });
    this.readline.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      this.#onLine(trimmed);
    });
    this.readline.on('close', () => this.log('mcp input closed'));
    return this;
  }

  stop() {
    this.readline?.close();
    this.readline = null;
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#write(errorResponse(null, -32700, 'Parse error: stdin line is not valid JSON.'));
      return;
    }
    if (Array.isArray(message)) {
      if (message.length === 0) {
        this.#write(errorResponse(null, -32600, 'Invalid request: empty batch.'));
        return;
      }
      for (const item of message) this.#onMessage(item);
      return;
    }
    this.#onMessage(message);
  }

  #onMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.#write(errorResponse(null, -32600, 'Invalid request.'));
      return;
    }
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;

    if (typeof method !== 'string') {
      if (isRequest) this.#write(errorResponse(id, -32600, 'Invalid request: missing method.'));
      return;
    }

    if (!isRequest) {
      // Notifications (initialized, cancelled, roots/list_changed, ...) need no reply.
      if (method === 'notifications/initialized') this.initialized = true;
      return;
    }

    Promise.resolve()
      .then(() => this.#dispatch(method, params ?? {}))
      .then((result) => this.#write(resultResponse(id, result)))
      .catch((error) => {
        if (error && error.mcpCode) {
          this.#write(errorResponse(id, error.mcpCode, error.message, error.data));
        } else {
          this.log(`internal error handling ${method}: ${error?.stack ?? error}`);
          this.#write(errorResponse(id, -32603, String(error?.message ?? error)));
        }
      });
  }

  async #dispatch(method, params) {
    switch (method) {
      case 'initialize':
        return this.#initialize(params);
      case 'ping':
        return {};
      case 'tools/list':
        return this.#listTools();
      case 'tools/call':
        return this.#callTool(params);
      case 'resources/list':
        return { resources: [] };
      case 'resources/templates/list':
        return { resourceTemplates: [] };
      case 'prompts/list':
        return { prompts: [] };
      case 'logging/setLevel':
        return {};
      default: {
        const error = new Error(`Method not found: ${method}`);
        error.mcpCode = -32601;
        throw error;
      }
    }
  }

  #initialize(params) {
    const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : LATEST_PROTOCOL;
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL;
    const client = params?.clientInfo ?? {};
    this.log(`initialize from ${client.name ?? 'unknown client'} ${client.version ?? ''} (protocol ${protocolVersion})`);
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'roblox-studio-mcp', title: 'Roblox Studio MCP', version: this.version },
      instructions: INSTRUCTIONS,
    };
  }

  #listTools() {
    return {
      tools: this.tools.map((item) => ({
        name: item.name,
        title: item.title,
        description: item.description,
        inputSchema: item.inputSchema,
        annotations: item.annotations,
      })),
    };
  }

  async #callTool(params) {
    const name = params?.name;
    if (typeof name !== 'string') {
      const error = new Error('tools/call requires a string "name".');
      error.mcpCode = -32602;
      throw error;
    }
    const tool = this.toolByName.get(name);
    if (!tool) {
      const error = new Error(`Unknown tool: ${name}`);
      error.mcpCode = -32602;
      throw error;
    }
    const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};

    try {
      const result = await tool.handler(args, { bridge: this.bridge });
      return this.#successResult(result);
    } catch (error) {
      const code = error?.code ?? 'tool_error';
      const details = error?.details !== undefined ? `\nDetails: ${JSON.stringify(error.details)}` : '';
      this.log(`tool ${name} failed [${code}]: ${error?.message ?? error}`);
      return {
        content: [{ type: 'text', text: `Error [${code}]: ${error?.message ?? String(error)}${details}` }],
        isError: true,
      };
    }
  }

  #successResult(result) {
    const text = typeof result === 'string' ? result : JSON.stringify(result ?? null, null, 2);
    const response = { content: [{ type: 'text', text }] };
    if (result && typeof result === 'object' && !Array.isArray(result)) response.structuredContent = result;
    return response;
  }

  #write(message) {
    try {
      this.output.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.log(`failed to write MCP response: ${error?.message ?? error}`);
    }
  }
}
