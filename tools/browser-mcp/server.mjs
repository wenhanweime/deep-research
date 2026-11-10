import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { BrowserService, publicErrorPayload } from "./service.mjs";

const MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_HTTP_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_HTTP_SESSION_SWEEP_MS = 15_000;
const DEFAULT_HTTP_SESSION_MAX = 32;

function envInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return Number(raw);
}

function requireInteger(value, name, { allowZero = false } = {}) {
  const min = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer.`);
  }
  return value;
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function runTool(operation) {
  return Promise.resolve()
    .then(operation)
    .then(toolResult, (error) => {
      const payload = publicErrorPayload(error);
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    });
}

function createToolServer(service) {
  const server = new McpServer(
    { name: "browser-mcp", version: "0.1.0" },
    {
      instructions:
        "Use this server as the exclusive Agent interface for every real browser and web automation action. Prefer host-injected browser-mcp tools when they are present. If the host did not inject them or a call hangs in a stale client bridge, use the browser-mcp CLI against this same HTTP endpoint. Never invoke cdp_browser_daemon.js, raw Chrome CDP endpoints, Playwright, Puppeteer, or another browser MCP directly. Start each task-owned tab with browser_open, or use browser_claim only when an exact existing tab must be adopted; retain the returned session_id and use that exact session for later actions. TAB_GONE means the tab is gone — open a new session instead of retrying. REF_STALE means take a new snapshot before clicking or typing. If this HTTP server itself is down, start com.pot.browser-mcp and retry; do not bypass the facade. Reuse the default profile unless a stable account or fixed automation requires a named long-term profile.",
    },
  );
  const context = () => ({ clientName: server.server.getClientVersion()?.name || "unknown" });

  server.registerTool(
    "browser_status",
    {
      description: "Check one persistent browser profile, count its MCP sessions, and show current bounded queue occupancy.",
      inputSchema: {
        profile_id: z.string().optional().describe("Stable profile name; omit for the shared default profile."),
      },
    },
    async ({ profile_id }) => runTool(() => service.status({ profileId: profile_id }, context())),
  );

  server.registerTool(
    "browser_recover",
    {
      description:
        "Targetedly restart one persistent browser profile, preserving its user-data, cookies, and login state. All prior MCP sessions for that profile are invalidated.",
      inputSchema: {
        profile_id: z.string().optional().describe("Stable profile name; omit for the shared default profile."),
      },
    },
    async ({ profile_id }) => runTool(() => service.recover({ profileId: profile_id }, context())),
  );

  server.registerTool(
    "browser_stop",
    {
      description:
        "Stop one persistent browser profile: closes every tab of that profile's Chrome process, terminates the process, and invalidates its MCP sessions. Cookies, logins and launch options stay on disk, so the next browser_open restarts the same profile. Use this (not browser_close_task_sessions) at the end of a job that owns a dedicated automation profile, so Chrome instances do not pile up.",
      inputSchema: {
        profile_id: z.string().optional().describe("Stable profile name; omit for the shared default profile."),
      },
    },
    async ({ profile_id }) => runTool(() => service.stop({ profileId: profile_id }, context())),
  );

  server.registerTool(
    "browser_open",
    {
      description:
        "Open a new task-owned tab and return session_id. Omit profile_id for normal work; only use a stable long-term account or automation profile, never a run-specific name.",
      inputSchema: {
        url: z.string().describe("HTTP/HTTPS URL, or exact about:blank, to open."),
        task_id: z.string().optional().describe("Stable task label used for routing and audit metadata."),
        profile_id: z.string().optional().describe("Stable account/purpose profile; omit to reuse the default login state."),
        background: z
          .boolean()
          .optional()
          .describe(
            "Open the tab in the background so Chrome does not raise its window or steal focus. Use it for unattended automation; leave unset when a human must see or interact with the page."
          ),
      },
    },
    async ({ url, task_id, profile_id, background }) =>
      runTool(() => service.open({ url, taskId: task_id, profileId: profile_id, background }, context())),
  );

  server.registerTool(
    "browser_sessions",
    {
      description: "List MCP-owned browser sessions without exposing daemon target or CDP identifiers.",
      inputSchema: {
        profile_id: z.string().optional(),
        task_id: z.string().optional(),
        status: z.enum(["active", "invalid", "closed"]).optional(),
        url_prefix: z.string().optional(),
      },
    },
    async ({ profile_id, task_id, status, url_prefix }) => runTool(() => service.listSessions({
      profileId: profile_id,
      taskId: task_id,
      status,
      urlPrefix: url_prefix,
    }, context())),
  );

  server.registerTool(
    "browser_claim",
    {
      description:
        "Claim exactly one existing unowned tab by exact URL and optional exact title. Fails closed when no tab, multiple tabs, or an already-claimed tab matches.",
      inputSchema: {
        url: z.string().describe("Exact HTTP/HTTPS URL or about:blank."),
        title: z.string().optional().describe("Optional exact page title to disambiguate duplicate URLs."),
        task_id: z.string().optional(),
        profile_id: z.string().optional(),
      },
    },
    async ({ url, title, task_id, profile_id }) => runTool(() => service.claim({
      url,
      title,
      taskId: task_id,
      profileId: profile_id,
    }, context())),
  );

  server.registerTool(
    "browser_navigate",
    {
      description: "Navigate the exact tab owned by a browser session.",
      inputSchema: {
        session_id: z.string(),
        url: z.string(),
      },
    },
    async ({ session_id, url }) =>
      runTool(() => service.navigate({ sessionId: session_id, url }, context())),
  );

  server.registerTool(
    "browser_snapshot",
    {
      description: "Read the accessible elements and page text from the session's exact tab.",
      inputSchema: { session_id: z.string() },
    },
    async ({ session_id }) => runTool(() => service.snapshot({ sessionId: session_id }, context())),
  );

  server.registerTool(
    "browser_click",
    {
      description:
        "Click an element reference from a recent snapshot, or a CSS selector, in the session's exact tab. REF_STALE means snapshot again before retrying.",
      inputSchema: {
        session_id: z.string(),
        ref: z.string(),
      },
    },
    async ({ session_id, ref }) => runTool(() => service.click({ sessionId: session_id, ref }, context())),
  );

  server.registerTool(
    "browser_type",
    {
      description: "Type text into an element in the session's exact tab. Input text is never written to the MCP audit log.",
      inputSchema: {
        session_id: z.string(),
        ref: z.string(),
        text: z.string(),
      },
    },
    async ({ session_id, ref, text }) =>
      runTool(() => service.type({ sessionId: session_id, ref, text }, context())),
  );

  server.registerTool(
    "browser_upload",
    {
      description:
        "Attach one or more local files to a file input in the session's exact tab. Files must be inside the server's configured upload roots; local paths are not written to the audit log.",
      inputSchema: {
        session_id: z.string(),
        selector: z.string().default("input[type=file]").describe("CSS selector for the real file input."),
        paths: z.array(z.string()).min(1).max(10).describe("Absolute local file paths inside an allowed upload root."),
      },
    },
    async ({ session_id, selector, paths }) =>
      runTool(() => service.upload({ sessionId: session_id, selector, paths }, context())),
  );

  server.registerTool(
    "browser_network_block_media",
    {
      description:
        "Attach a persistent, session-scoped TikTok media blocker before navigation. It blocks playback/CDN traffic while preserving page HTML and JSON APIs, and is automatically removed when the MCP session closes or its profile recovers.",
      inputSchema: { session_id: z.string() },
    },
    async ({ session_id }) => runTool(() => service.networkBlockMedia({ sessionId: session_id }, context())),
  );

  server.registerTool(
    "browser_network_clear_blocked",
    {
      description: "Remove the persistent media blocker from the exact browser session. Safe to repeat.",
      inputSchema: { session_id: z.string() },
    },
    async ({ session_id }) => runTool(() => service.networkClearBlocked({ sessionId: session_id }, context())),
  );

  server.registerTool(
    "browser_evaluate",
    {
      description:
        "Run a JavaScript function in the session's exact tab and return the JSON-serializable result. Prefer snapshot/click/type for normal interaction; use evaluate for extraction when the accessibility tree cannot expose full content (e.g. long transcripts, authenticated API calls in-page).",
      inputSchema: {
        session_id: z.string(),
        fn: z
          .string()
          .describe("JS expression or function body, e.g. '() => document.body.innerText' or 'document.title'."),
      },
    },
    async ({ session_id, fn }) =>
      runTool(() => service.evaluate({ sessionId: session_id, fn }, context())),
  );

  server.registerTool(
    "browser_wait",
    {
      description: "Wait for the session's page load state.",
      inputSchema: {
        session_id: z.string(),
        load: z.enum(["complete", "interactive", "networkidle"]).default("complete")
          .describe("networkidle is currently a compatibility alias for complete."),
        timeout_ms: z.number().int().min(1).max(120_000).default(30_000),
      },
    },
    async ({ session_id, load, timeout_ms }) =>
      runTool(() => service.wait({ sessionId: session_id, load, timeoutMs: timeout_ms }, context())),
  );

  server.registerTool(
    "browser_screenshot",
    {
      description: "Capture a screenshot of the session's exact tab.",
      inputSchema: {
        session_id: z.string(),
        full_page: z.boolean().default(false),
        output_path: z.string().optional(),
      },
    },
    async ({ session_id, full_page, output_path }) =>
      runTool(() =>
        service.screenshot(
          { sessionId: session_id, fullPage: full_page, outputPath: output_path },
          context(),
        ),
      ),
  );

  server.registerTool(
    "browser_close",
    {
      description: "Close the exact tab owned by a browser session. Repeated close calls are safe.",
      inputSchema: { session_id: z.string() },
    },
    async ({ session_id }) => runTool(() => service.close({ sessionId: session_id }, context())),
  );

  server.registerTool(
    "browser_close_task_sessions",
    {
      description:
        "Close only MCP-owned sessions with the exact task_id, optionally limited to one stable profile. Does not close arbitrary matching Chrome tabs.",
      inputSchema: {
        task_id: z.string(),
        profile_id: z.string().optional(),
      },
    },
    async ({ task_id, profile_id }) => runTool(() => service.closeTaskSessions({
      taskId: task_id,
      profileId: profile_id,
    }, context())),
  );

  server.registerTool(
    "browser_configure",
    {
      description:
        "Read or set per-profile launch options. Pass `options` to set (proxy, userAgent, lang, windowSize, webrtcPolicy, extraChromeArgs[], initScript - whole-set overwrite), `clear` to wipe, or neither to read the current set. Options apply the next time that profile's browser starts; stop/restart the profile to apply.",
      inputSchema: {
        profile_id: z.string().optional().describe("Stable profile name; omit for the shared default profile."),
        options: z
          .object({
            proxy: z.string().optional().describe("Per-profile --proxy-server, e.g. socks5://127.0.0.1:19101."),
            userAgent: z.string().optional().describe("Custom --user-agent for this profile."),
            lang: z.string().optional().describe("--lang locale, e.g. zh-CN / en-US."),
            windowSize: z.string().optional().describe("--window-size WxH or W,H."),
            webrtcPolicy: z.string().optional().describe("WebRTC IP handling policy (default disable_non_proxied_udp when proxy is set)."),
            extraChromeArgs: z.array(z.string()).optional().describe("Extra Chrome flags, each starting with --."),
            initScript: z.string().optional().describe("JS installed via Page.addScriptToEvaluateOnNewDocument before first navigation (webdriver/canvas stealth overrides)."),
            chromePath: z.string().optional().describe("Per-profile Chrome executable; beats config.json and CDP_BROWSER_CHROME."),
          })
          .optional()
          .describe("Launch options; omit to read the current set."),
        clear: z.boolean().optional().describe("Clear all launch options for the profile."),
      },
    },
    async ({ profile_id, options, clear }) =>
      runTool(() => service.configure({ profileId: profile_id, options, clear }, context())),
  );

  return server;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, value, extraHeaders = {}) {
  response.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  response.end(JSON.stringify(value));
}

export async function startBrowserMcpServer({
  service,
  host = "127.0.0.1",
  port = 19451,
  now = () => Date.now(),
  httpSessionTtlMs = envInteger("BROWSER_MCP_HTTP_SESSION_TTL_MS", DEFAULT_HTTP_SESSION_TTL_MS),
  httpSessionSweepMs = envInteger("BROWSER_MCP_HTTP_SESSION_SWEEP_MS", DEFAULT_HTTP_SESSION_SWEEP_MS),
  httpSessionMax = envInteger("BROWSER_MCP_HTTP_SESSION_MAX", DEFAULT_HTTP_SESSION_MAX),
} = {}) {
  const browserService = service || (await BrowserService.create());
  requireInteger(httpSessionTtlMs, "httpSessionTtlMs");
  requireInteger(httpSessionSweepMs, "httpSessionSweepMs", { allowZero: true });
  requireInteger(httpSessionMax, "httpSessionMax");
  const clients = new Map();
  const closing = new Set();

  async function closeHttpClient(sessionId) {
    const record = clients.get(sessionId);
    if (!record || closing.has(sessionId)) return;
    closing.add(sessionId);
    clients.delete(sessionId);
    try {
      await record.mcpServer.close();
    } catch {
      // Client may already have dropped the transport.
    }
    closing.delete(sessionId);
  }

  function touchHttpClient(sessionId) {
    const record = clients.get(sessionId);
    if (record) record.lastSeen = now();
  }

  async function evictOldestHttpClient() {
    let oldestId;
    let oldestSeen = Infinity;
    for (const [sessionId, record] of clients) {
      if (record.lastSeen < oldestSeen) {
        oldestSeen = record.lastSeen;
        oldestId = sessionId;
      }
    }
    if (oldestId) await closeHttpClient(oldestId);
  }

  async function sweepHttpSessions() {
    const cutoff = now() - httpSessionTtlMs;
    const expired = [...clients.entries()]
      .filter(([, record]) => record.lastSeen <= cutoff)
      .map(([sessionId]) => sessionId);
    await Promise.all(expired.map((sessionId) => closeHttpClient(sessionId)));
    while (clients.size > httpSessionMax) await evictOldestHttpClient();
  }

  function healthPayload() {
    const memory = process.memoryUsage();
    return {
      ok: true,
      service: "browser-mcp",
      mcp_clients: clients.size,
      mcp_clients_max: httpSessionMax,
      http_session_ttl_ms: httpSessionTtlMs,
      browser_sessions: browserService.sessionCounts(),
      memory: {
        rss_bytes: memory.rss,
        heap_used_bytes: memory.heapUsed,
        heap_total_bytes: memory.heapTotal,
        external_bytes: memory.external,
        array_buffers_bytes: memory.arrayBuffers,
      },
    };
  }

  const httpServer = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, `http://${host}`);
      if (requestUrl.pathname === "/health" && request.method === "GET") {
        await sweepHttpSessions();
        sendJson(response, 200, healthPayload());
        return;
      }
      if (requestUrl.pathname !== "/mcp") {
        sendJson(response, 404, { error: "not_found" });
        return;
      }

      const sessionId = request.headers["mcp-session-id"];
      let record = sessionId ? clients.get(sessionId) : undefined;
      if (record) touchHttpClient(sessionId);

      if (request.method === "POST") {
        const body = await readJsonBody(request);
        if (!record && !sessionId && isInitializeRequest(body)) {
          await sweepHttpSessions();
          if (clients.size >= httpSessionMax) await evictOldestHttpClient();
          const mcpServer = createToolServer(browserService);
          let transport;
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (newSessionId) => {
              clients.set(newSessionId, { transport, mcpServer, lastSeen: now() });
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) clients.delete(transport.sessionId);
          };
          await mcpServer.connect(transport);
          await transport.handleRequest(request, response, body);
          return;
        }
        if (!record) {
          sendJson(response, 400, {
            jsonrpc: "2.0",
            error: { code: -32000, message: "Invalid or missing MCP session." },
            id: null,
          });
          return;
        }
        await record.transport.handleRequest(request, response, body);
        return;
      }

      if (request.method === "GET" || request.method === "DELETE") {
        if (!record) {
          sendJson(response, 400, { error: "invalid_mcp_session" });
          return;
        }
        await record.transport.handleRequest(request, response);
        return;
      }

      sendJson(response, 405, { error: "method_not_allowed" }, { allow: "GET, POST, DELETE" });
    } catch (error) {
      console.error(`browser-mcp request failed: ${error.message}`);
      if (!response.headersSent) {
        sendJson(response, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error." },
          id: null,
        });
      } else {
        response.end();
      }
    }
  });

  httpServer.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });
  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const sweepTimer = httpSessionSweepMs > 0
    ? setInterval(() => {
        void sweepHttpSessions();
      }, httpSessionSweepMs)
    : null;
  if (sweepTimer) sweepTimer.unref();

  return {
    service: browserService,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}/mcp`,
    httpClientCount: () => clients.size,
    sweepHttpSessions,
    close: async () => {
      if (sweepTimer) clearInterval(sweepTimer);
      await Promise.allSettled([...clients.keys()].map((sessionId) => closeHttpClient(sessionId)));
      await browserService.shutdown();
      await new Promise((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function main() {
  const host = process.env.BROWSER_MCP_HOST || "127.0.0.1";
  const port = Number(process.env.BROWSER_MCP_PORT || 19451);
  const running = await startBrowserMcpServer({ host, port });
  console.log(`browser-mcp listening at ${running.url}`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await running.close();
  };
  process.on("SIGINT", () => stop().finally(() => process.exit(0)));
  process.on("SIGTERM", () => stop().finally(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}
