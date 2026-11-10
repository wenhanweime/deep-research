#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_MCP_URL = "http://127.0.0.1:19451/mcp";
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 3_000;
const CLIENT_NAME = "browser-mcp-cli";
const CLIENT_VERSION = "0.1.0";

const TOOL_ALIASES = new Map([
  ["status", "browser_status"],
  ["recover", "browser_recover"],
  ["stop", "browser_stop"],
  ["open", "browser_open"],
  ["sessions", "browser_sessions"],
  ["claim", "browser_claim"],
  ["navigate", "browser_navigate"],
  ["snapshot", "browser_snapshot"],
  ["click", "browser_click"],
  ["type", "browser_type"],
  ["upload", "browser_upload"],
  ["wait", "browser_wait"],
  ["screenshot", "browser_screenshot"],
  ["evaluate", "browser_evaluate"],
  ["close", "browser_close"],
  ["configure", "browser_configure"],
  ["block-media", "browser_network_block_media"],
  ["clear-blocked", "browser_network_clear_blocked"],
  ["close-task", "browser_close_task_sessions"],
]);

export function healthUrlFor(mcpUrl) {
  const url = new URL(mcpUrl);
  url.pathname = "/health";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function kebabToSnake(value) {
  return value.replaceAll("-", "_");
}

function looksJson(value) {
  const trimmed = String(value).trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function coerce(value) {
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (typeof value === "string" && looksJson(value)) return JSON.parse(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  if (typeof value === "string" && /^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

export function parseCliArgv(argv) {
  const cli = {
    help: false,
    mcpUrl: process.env.BROWSER_MCP_URL || DEFAULT_MCP_URL,
    timeoutMs: Number(process.env.BROWSER_MCP_TIMEOUT_MS || DEFAULT_TOOL_TIMEOUT_MS),
  };
  const toolArgs = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      cli.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
    let value;
    if (eq !== -1) {
      value = token.slice(eq + 1);
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) value = true;
      else {
        value = next;
        index += 1;
      }
    }

    if (key === "mcp-url") {
      cli.mcpUrl = String(value);
      continue;
    }
    if (key === "timeout-ms") {
      cli.timeoutMs = Number(value);
      continue;
    }
    if (key === "json") {
      Object.assign(toolArgs, JSON.parse(String(value)));
      continue;
    }
    toolArgs[kebabToSnake(key)] = coerce(value);
  }

  if (positionals.length && looksJson(positionals[positionals.length - 1])) {
    Object.assign(toolArgs, JSON.parse(positionals.pop()));
  }

  return { cli, positionals, toolArgs };
}

export function resolveToolName(name) {
  if (!name) return null;
  if (TOOL_ALIASES.has(name)) return TOOL_ALIASES.get(name);
  if (name.startsWith("browser_")) return name;
  const prefixed = `browser_${name}`;
  return prefixed;
}

function usage() {
  return `Usage: browser-mcp [--mcp-url URL] <command> [flags|--json '{}']

Commands:
  health                         GET /health (no MCP session)
  tools                          List server tools
  <tool> [--arg value]           Call one tool and exit
  call <tool> ['{...}']          Same, with a JSON argument object

Each invocation opens a fresh MCP HTTP session, calls one tool, then DELETE-s
the session. Host MCP tool bridges are optional.

Examples:
  browser-mcp health
  browser-mcp browser_open --url https://example.com
  browser-mcp browser_snapshot --session-id session-...
  browser-mcp call browser_configure '{"options":{"lang":"zh-CN"}}'

If the server is down: launchctl kickstart -k gui/$(id -u)/com.pot.browser-mcp
Do not call cdp_browser_daemon.js or raw CDP.
`;
}

function unreachableMessage(mcpUrl, cause) {
  return `browser-mcp unreachable at ${mcpUrl} (${cause}).
Start: launchctl kickstart -k gui/$(id -u)/com.pot.browser-mcp
Do not call cdp_browser_daemon.js or raw CDP.`;
}

async function readHealth(mcpUrl, timeoutMs = HEALTH_TIMEOUT_MS) {
  const response = await fetch(healthUrlFor(mcpUrl), {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`health HTTP ${response.status}`);
  }
  return response.json();
}

function printJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function withClient(mcpUrl, fn) {
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

export async function runBrowserMcpCli(argv, options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const { cli, positionals, toolArgs } = parseCliArgv(argv);
  if (options.mcpUrl) cli.mcpUrl = options.mcpUrl;
  if (options.timeoutMs) cli.timeoutMs = options.timeoutMs;

  const command = positionals[0];
  if (cli.help || !command) {
    stdout.write(usage());
    return { exitCode: command ? 0 : 2, stdout, stderr };
  }

  try {
    if (command === "health") {
      printJson(stdout, await readHealth(cli.mcpUrl, cli.timeoutMs));
      return { exitCode: 0, stdout, stderr };
    }

    await readHealth(cli.mcpUrl);

    if (command === "tools") {
      const tools = await withClient(cli.mcpUrl, (client) => client.listTools());
      printJson(stdout, tools.tools.map(({ name, description }) => ({ name, description })));
      return { exitCode: 0, stdout, stderr };
    }

    const toolName = command === "call"
      ? resolveToolName(positionals[1])
      : resolveToolName(command);
    if (!toolName) {
      stderr.write("Missing tool name.\n");
      stdout.write(usage());
      return { exitCode: 2, stdout, stderr };
    }

    const result = await withClient(cli.mcpUrl, (client) =>
      client.callTool(
        { name: toolName, arguments: toolArgs },
        undefined,
        { timeout: cli.timeoutMs },
      ),
    );

    const payload = result.structuredContent ?? result.content ?? result;
    printJson(stdout, payload);
    if (result.isError) return { exitCode: 2, stdout, stderr, result };
    return { exitCode: 0, stdout, stderr, result };
  } catch (error) {
    const cause = [error?.cause?.code, error?.code, error?.message, error?.cause?.message, error?.name]
      .filter(Boolean)
      .join(" ") || String(error);
    const unreachable = /ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ECONNRESET|fetch failed|health HTTP|timeout|AbortError/i.test(
      cause,
    );
    stderr.write(`${unreachable ? unreachableMessage(cli.mcpUrl, cause) : (error?.stack || String(error))}\n`);
    return { exitCode: 1, stdout, stderr, error };
  }
}

async function main() {
  const { exitCode } = await runBrowserMcpCli(process.argv.slice(2));
  process.exit(exitCode);
}

function isMainModule() {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
