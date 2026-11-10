import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { Bridge } from './bridge.js';
import { McpServer } from './mcp.js';
import { TOOLS } from './tools.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
export const VERSION = pkg.version;
export const ENTRY = fileURLToPath(new URL('../bin/roblox-mcp.js', import.meta.url));

const HELP = `
roblox-studio-mcp ${VERSION} - MCP server for a live Roblox Studio session

Usage:
  roblox-mcp [options]

Options:
  --port <n>          Bridge port for the Studio plugin (default 44755, env ROBLOX_MCP_PORT)
  --host <addr>       Interface to bind (default 127.0.0.1)
  --token <secret>    Shared secret the plugin must send (env ROBLOX_MCP_TOKEN)
  --timeout <ms>      Default per-request timeout (default 30000, env ROBLOX_MCP_TIMEOUT)
  --http-only         Run only the HTTP bridge (no MCP stdio), for debugging with curl
  --keep-alive        Do not exit when stdin closes (for background/service use)
  --print-config      Print an MCP client config snippet and exit
  --verbose           Log every bridge request and tool call to stderr
  --version           Print the version and exit
  --help              Show this help

MCP stdio is the transport: JSON-RPC 2.0 messages, one per line, on stdin/stdout.
Logs always go to stderr so they never corrupt the protocol stream.
`.trim();

function fail(message) {
  process.stderr.write(`roblox-mcp: ${message}\n`);
  process.exit(1);
}

export function parseArgs(argv) {
  const options = {
    port: Number(process.env.ROBLOX_MCP_PORT ?? 44755),
    host: '127.0.0.1',
    token: process.env.ROBLOX_MCP_TOKEN ?? null,
    timeout: Number(process.env.ROBLOX_MCP_TIMEOUT ?? 30000),
    httpOnly: false,
    keepAlive: false,
    printConfig: false,
    verbose: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--port':
        options.port = Number(next());
        break;
      case '--host':
        options.host = next();
        break;
      case '--token':
        options.token = next();
        break;
      case '--timeout':
        options.timeout = Number(next());
        break;
      case '--http-only':
        options.httpOnly = true;
        break;
      case '--keep-alive':
        options.keepAlive = true;
        break;
      case '--print-config':
        options.printConfig = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--version':
        options.version = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        fail(`unknown option ${arg} (try --help)`);
    }
  }

  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) fail('--port must be 0-65535');
  if (!Number.isFinite(options.timeout) || options.timeout < 1000) fail('--timeout must be at least 1000ms');
  return options;
}

export function clientConfig(options = parseArgs([])) {
  const args = [ENTRY];
  if (options.port !== 44755) args.push('--port', String(options.port));
  if (options.token) args.push('--token', options.token);
  return {
    mcpServers: {
      'roblox-studio': {
        command: process.execPath,
        args,
        env: {},
      },
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (options.printConfig) {
    process.stdout.write(`${JSON.stringify(clientConfig(options), null, 2)}\n`);
    return;
  }

  // stderr only: stdout is the MCP protocol stream.
  const log = (message) => {
    if (options.verbose || !/^tool /i.test(message)) {
      process.stderr.write(`[roblox-mcp] ${message}\n`);
    }
  };

  const bridge = new Bridge({
    host: options.host,
    port: options.port,
    token: options.token,
    requestTimeoutMs: options.timeout,
    serverVersion: VERSION,
    log,
  });

  let port;
  try {
    port = await bridge.start();
  } catch (error) {
    fail(`cannot start bridge on ${options.host}:${options.port}: ${error.message}`);
  }

  if (options.port !== port) {
    log(`port ${options.port} was busy, using ${port} instead (set the same port in the plugin widget)`);
  }
  const pluginHint = `install the RobloxMCP plugin, open Studio, then Plugins -> RobloxMCP -> port ${port} -> Connect`;
  log(`ready: ${pluginHint}`);

  const shutdown = async (signal) => {
    log(`received ${signal}, shutting down`);
    try {
      mcp?.stop();
      await bridge.stop();
    } finally {
      process.exit(0);
    }
  };

  let mcp = null;
  if (!options.httpOnly) {
    mcp = new McpServer({ tools: TOOLS, bridge, version: VERSION, log: (m) => log(m) }).start();
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // In normal MCP use stdin closing means the client went away. Background and
  // HTTP-only runs have no stdin, so they must not treat that as a shutdown.
  if (!options.httpOnly && !options.keepAlive) {
    process.stdin.on('end', () => void shutdown('stdin end'));
  }

  // Keep the process alive while the bridge is open.
  await new Promise(() => {});
}
