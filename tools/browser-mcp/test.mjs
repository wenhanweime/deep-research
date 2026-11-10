import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BrowserService, BrowserServiceError, sanitizeLastUrl } from "./service.mjs";
import { startBrowserMcpServer } from "./server.mjs";
import { parseCliArgv, resolveToolName, runBrowserMcpCli } from "./cli.mjs";
import { browserGuardResponse, shouldBlockBrowserCommand } from "./hooks/browser-mcp-guard.mjs";
import {
  DENY_REASON,
  applyEvent,
  idleMs,
  isBrowserMcpHostTool,
  shouldDenyHostCall,
  uuidv7Ms,
} from "./hooks/grok-bridge-circuit.mjs";
import {
  FETCH_FAIL_FALLBACK_URLS,
  TIKTOK_MEDIA_BLOCK_URLS,
  assertWebcastPatternsHostScoped,
  webcastPatternMatchesQueryParam,
} from "./media-block.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDaemon = path.join(here, "fake-daemon.mjs");

async function fixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "browser-mcp-test-"));
  const home = path.join(root, "mcp");
  const fakeHome = path.join(root, "fake");
  await fs.mkdir(fakeHome, { recursive: true });
  if (options.routes) {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "routes.json"), JSON.stringify(options.routes));
  }
  const service = await BrowserService.create({
    home,
    daemonScript: fakeDaemon,
    uploadRoots: [root],
    daemonEnv: {
      FAKE_DAEMON_HOME: fakeHome,
      FAKE_DAEMON_DELAY_MS: String(options.delayMs || 0),
      FAKE_DAEMON_COMMAND_DELAYS: JSON.stringify(options.commandDelays || {}),
      ...(options.unhealthy ? { FAKE_DAEMON_UNHEALTHY: "1" } : {}),
    },
    sessionTtlMs: options.sessionTtlMs,
    sessionRetentionMs: options.sessionRetentionMs,
    statusTimeoutMs: options.statusTimeoutMs,
    queueWaitTimeoutMs: options.queueWaitTimeoutMs,
    maxQueued: options.maxQueued,
    now: options.now,
    mediaGuardianFactory: options.mediaGuardianFactory,
  });
  return {
    root,
    home,
    fakeHome,
    service,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

function noRawCdp(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /targetId|target_id|wsUrl|webSocket|9222|\"port\"/i);
}

test("TikTok media block patterns preserve JSON API webcast query parameters", () => {
  assert.ok(TIKTOK_MEDIA_BLOCK_URLS.some((pattern) => pattern.includes(".mp4")));
  assert.ok(TIKTOK_MEDIA_BLOCK_URLS.some((pattern) => pattern.includes("webcast")));
  assertWebcastPatternsHostScoped(TIKTOK_MEDIA_BLOCK_URLS);
  assertWebcastPatternsHostScoped(FETCH_FAIL_FALLBACK_URLS);
  assert.equal(webcastPatternMatchesQueryParam("*://webcast.*"), false);
  assert.equal(webcastPatternMatchesQueryParam("*webcast.tiktok.com*"), false);
  assert.equal(webcastPatternMatchesQueryParam("*webcast*"), true);
});

test("session mapping, routing, persistence, and output filtering", async (t) => {
  const f = await fixture({ routes: { "daily-publish": "douyin-publisher" } });
  t.after(f.cleanup);

  const opened = await f.service.open(
    { url: "https://example.com/start", taskId: "daily-publish" },
    { clientName: "unit-client" },
  );
  assert.match(opened.session_id, /^session-/);
  assert.equal(opened.profile_id, "douyin-publisher");
  noRawCdp(opened);

  const navigated = await f.service.navigate({ sessionId: opened.session_id, url: "https://example.com/next" });
  assert.equal(navigated.url, "https://example.com/next");
  noRawCdp(navigated);

  const restarted = await BrowserService.create({
    home: f.home,
    daemonScript: fakeDaemon,
    daemonEnv: { FAKE_DAEMON_HOME: f.fakeHome },
  });
  const snapshot = await restarted.snapshot({ sessionId: opened.session_id });
  assert.equal(snapshot.title, "Fake page");
  assert.equal(snapshot.url, "https://example.com/next");
  noRawCdp(snapshot);
});

test("background tabs are opt-in and forwarded to the daemon", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const eventsPath = path.join(f.fakeHome, "events.jsonl");

  const foreground = await f.service.open({ url: "https://example.com/visible" });
  assert.equal(foreground.background, false);
  const background = await f.service.open({ url: "https://example.com/hidden", background: true });
  assert.equal(background.background, true);
  const ignored = await f.service.open({ url: "https://example.com/typed", background: "yes" });
  assert.equal(ignored.background, false);

  const opens = (await fs.readFile(eventsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter(({ command, phase }) => command === "open" && phase === "start");
  assert.deepEqual(opens.map(({ options }) => options.background ?? false), [false, true, false]);
  assert.deepEqual(opens.map(({ positionals }) => positionals), [
    ["https://example.com/visible"],
    ["https://example.com/hidden"],
    ["https://example.com/typed"],
  ]);
});

test("same-profile actions are serialized", async (t) => {
  const f = await fixture({ delayMs: 80 });
  t.after(f.cleanup);
  const opened = await f.service.open({ url: "https://example.com" });
  const eventsPath = path.join(f.fakeHome, "events.jsonl");
  await fs.writeFile(eventsPath, "");

  await Promise.all([
    f.service.snapshot({ sessionId: opened.session_id }),
    f.service.snapshot({ sessionId: opened.session_id }),
  ]);
  const events = (await fs.readFile(eventsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(events.map(({ phase }) => phase), ["start", "end", "start", "end"]);
  assert.ok(events[2].time >= events[1].time);
});

test("different profiles can run concurrently", async (t) => {
  const f = await fixture({ delayMs: 100 });
  t.after(f.cleanup);
  const first = await f.service.open({ url: "https://example.com/one", profileId: "account-one" });
  const second = await f.service.open({ url: "https://example.com/two", profileId: "account-two" });
  const eventsPath = path.join(f.fakeHome, "events.jsonl");
  await fs.writeFile(eventsPath, "");

  await Promise.all([
    f.service.snapshot({ sessionId: first.session_id }),
    f.service.snapshot({ sessionId: second.session_id }),
  ]);
  const events = (await fs.readFile(eventsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(events.slice(0, 2).map(({ phase }) => phase), ["start", "start"]);
  assert.notEqual(events[0].profileId, events[1].profileId);
});

test("a missing target invalidates only its session", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const first = await f.service.open({ url: "https://example.com/one" });
  const second = await f.service.open({ url: "https://example.com/two" });
  const fakeStatePath = path.join(f.fakeHome, "state.json");
  const fakeState = JSON.parse(await fs.readFile(fakeStatePath, "utf8"));
  const stored = JSON.parse(await fs.readFile(path.join(f.home, "sessions.json"), "utf8"));
  const firstInternal = stored.sessions.find((item) => item.sessionId === first.session_id);
  delete fakeState.targets[firstInternal.targetId];
  await fs.writeFile(fakeStatePath, JSON.stringify(fakeState));

  await assert.rejects(
    () => f.service.snapshot({ sessionId: first.session_id }),
    (error) =>
      error instanceof BrowserServiceError &&
      error.code === "TAB_GONE" &&
      error.details.last_url === "https://example.com/one" &&
      error.details.session_id === first.session_id,
  );
  const secondSnapshot = await f.service.snapshot({ sessionId: second.session_id });
  assert.equal(secondSnapshot.title, "Fake page");
  const persisted = JSON.parse(await fs.readFile(path.join(f.home, "sessions.json"), "utf8"));
  assert.equal(persisted.sessions.find((item) => item.sessionId === first.session_id).status, "invalid");
  assert.equal(persisted.sessions.find((item) => item.sessionId === second.session_id).status, "active");
});

test("a uniquely replaced exact-URL target is rebound without exposing its id", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const opened = await f.service.open({ url: "https://example.com/replaced", taskId: "publish" });
  const fakeStatePath = path.join(f.fakeHome, "state.json");
  const fakeState = JSON.parse(await fs.readFile(fakeStatePath, "utf8"));
  const stored = JSON.parse(await fs.readFile(path.join(f.home, "sessions.json"), "utf8"));
  const internal = stored.sessions.find((item) => item.sessionId === opened.session_id);
  delete fakeState.targets[internal.targetId];
  fakeState.targets["target-99"] = {
    profileId: "cdp-browser-daemon",
    url: "https://example.com/replaced",
    title: "Replacement",
  };
  await fs.writeFile(fakeStatePath, JSON.stringify(fakeState));

  const snapshot = await f.service.snapshot({ sessionId: opened.session_id });
  assert.equal(snapshot.url, "https://example.com/replaced");
  noRawCdp(snapshot);
  const rebound = JSON.parse(await fs.readFile(path.join(f.home, "sessions.json"), "utf8"));
  assert.equal(rebound.sessions.find((item) => item.sessionId === opened.session_id).targetId, "target-99");
});

test("typed text is absent from audit and action output", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const opened = await f.service.open({ url: "https://example.com/login", taskId: "login-check" });
  const secret = "secret-password-123";
  const result = await f.service.type({ sessionId: opened.session_id, ref: "r1", text: secret });
  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  const audit = await fs.readFile(path.join(f.home, "audit.jsonl"), "utf8");
  assert.doesNotMatch(audit, new RegExp(secret));
  assert.doesNotMatch(audit, /target-|ws:\/\/|9222/);
  const records = audit.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.at(-1).tool, "browser_type");
  assert.equal(records.at(-1).task_id, "login-check");
});

test("uploads are root-restricted and local paths stay out of audit output", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const opened = await f.service.open({ url: "https://example.com/upload", taskId: "upload-check" });
  const uploadPath = path.join(f.root, "video.mp4");
  await fs.writeFile(uploadPath, "fake video");

  const result = await f.service.upload({
    sessionId: opened.session_id,
    selector: "input[type=file]",
    paths: [uploadPath],
  });
  assert.deepEqual(result, {
    session_id: opened.session_id,
    ok: true,
    file_count: 1,
    url: "https://example.com/upload",
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(uploadPath));
  const audit = await fs.readFile(path.join(f.home, "audit.jsonl"), "utf8");
  assert.doesNotMatch(audit, new RegExp(uploadPath));
  assert.match(audit, /"tool":"browser_upload"/);

  await assert.rejects(
    () => f.service.upload({
      sessionId: opened.session_id,
      selector: "input[type=file]",
      paths: ["/etc/hosts"],
    }),
    (error) => error instanceof BrowserServiceError && error.code === "UPLOAD_PATH_NOT_ALLOWED",
  );
});

test("persistent media blocking is session-scoped, idempotent, and cleaned up", async (t) => {
  const guardians = [];
  const f = await fixture({
    mediaGuardianFactory: async (options) => {
      const guardian = {
        options,
        layersActive: { network_blocked: true, fetch_fail: true, media_neuter: true },
        armCount: 1,
        closeCount: 0,
        alive: true,
        isAlive() { return this.alive; },
        async arm() {
          this.armCount += 1;
          return this.layersActive;
        },
        async close() {
          this.closeCount += 1;
          this.alive = false;
        },
      };
      guardians.push(guardian);
      return guardian;
    },
  });
  t.after(f.cleanup);
  const opened = await f.service.open({ url: "about:blank", taskId: "radar" });

  const first = await f.service.networkBlockMedia({ sessionId: opened.session_id });
  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  assert.equal(first.mode, "tiktok-media-save-persistent");
  assert.equal(guardians.length, 1);
  assert.equal(guardians[0].options.targetId, "target-1");
  noRawCdp(first);

  const second = await f.service.networkBlockMedia({ sessionId: opened.session_id });
  assert.equal(second.reused, true);
  assert.equal(guardians[0].armCount, 2);

  const cleared = await f.service.networkClearBlocked({ sessionId: opened.session_id });
  assert.equal(cleared.stopped, true);
  assert.equal(guardians[0].closeCount, 1);
  assert.equal((await f.service.networkClearBlocked({ sessionId: opened.session_id })).stopped, false);

  await f.service.networkBlockMedia({ sessionId: opened.session_id });
  assert.equal(guardians.length, 2);
  await f.service.close({ sessionId: opened.session_id });
  assert.equal(guardians[1].closeCount, 1);
});

test("media-block intent is restored after browser-mcp restarts", async (t) => {
  const guardians = [];
  const factory = async (options) => {
    const guardian = {
      options,
      layersActive: { network_blocked: true, fetch_fail: true, media_neuter: true },
      alive: true,
      isAlive() { return this.alive; },
      async arm() { return this.layersActive; },
      async close() { this.alive = false; },
    };
    guardians.push(guardian);
    return guardian;
  };
  const f = await fixture({ mediaGuardianFactory: factory });
  t.after(f.cleanup);
  const opened = await f.service.open({ url: "https://www.tiktok.com/@skater", taskId: "radar" });
  await f.service.networkBlockMedia({ sessionId: opened.session_id });
  assert.equal(guardians.length, 1);
  assert.equal((await f.service.listSessions({ taskId: "radar" })).sessions[0].media_block_active, true);
  await f.service.shutdown();

  const restarted = await BrowserService.create({
    home: f.home,
    daemonScript: fakeDaemon,
    daemonEnv: { FAKE_DAEMON_HOME: f.fakeHome },
    mediaGuardianFactory: factory,
  });
  assert.equal(guardians.length, 2);
  assert.equal((await restarted.listSessions({ taskId: "radar" })).sessions[0].media_block_active, true);
  await restarted.close({ sessionId: opened.session_id });
});

test("close is idempotent", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const opened = await f.service.open({ url: "https://example.com" });
  assert.equal((await f.service.close({ sessionId: opened.session_id })).already_closed, false);
  assert.equal((await f.service.close({ sessionId: opened.session_id })).already_closed, true);
});

test("recover restarts one profile without exposing daemon internals", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const result = await f.service.recover({ profileId: "douyin-publisher" }, { clientName: "unit-client" });
  assert.equal(result.profile_id, "douyin-publisher");
  assert.equal(result.generation, 2);
  assert.equal(result.invalidated_sessions, 0);
  assert.equal(result.recovered, true);
  assert.equal(result.healthy, true);
  assert.deepEqual(result.checks, { pid_alive: true, http_ok: true, browser_ok: true });
  assert.equal(result.queue.queued, 0);
  noRawCdp(result);
  const events = (await fs.readFile(path.join(f.fakeHome, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const recoverStart = events.find((event) => event.command === "recover" && event.phase === "start");
  assert.equal(recoverStart.options["no-restore-tabs"], true);
});

test("MCP Streamable HTTP initializes, lists, and calls tools", async (t) => {
  const f = await fixture();
  const running = await startBrowserMcpServer({ service: f.service, port: 0 });
  const client = new Client({ name: "protocol-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(running.url));
  t.after(async () => {
    await client.close().catch(() => undefined);
    await running.close();
    await f.cleanup();
  });

  await client.connect(transport);
  assert.match(client.getInstructions(), /exclusive Agent interface/);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map(({ name }) => name).sort(),
    [
      "browser_claim",
      "browser_click",
      "browser_close",
      "browser_close_task_sessions",
      "browser_configure",
      "browser_evaluate",
      "browser_navigate",
      "browser_network_block_media",
      "browser_network_clear_blocked",
      "browser_open",
      "browser_recover",
      "browser_screenshot",
      "browser_sessions",
      "browser_snapshot",
      "browser_status",
      "browser_stop",
      "browser_type",
      "browser_upload",
      "browser_wait",
    ],
  );
  const result = await client.callTool({ name: "browser_open", arguments: { url: "https://example.com" } });
  assert.equal(result.isError, undefined);
  assert.match(result.structuredContent.session_id, /^session-/);
  noRawCdp(result);

  const stale = await client.callTool({
    name: "browser_click",
    arguments: { session_id: result.structuredContent.session_id, ref: "r99" },
  });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.code, "REF_STALE");
  assert.equal(stale.structuredContent.session_id, result.structuredContent.session_id);
  assert.equal(stale.structuredContent.last_url, "https://example.com/");

  const uploadPath = path.join(f.root, "protocol-upload.mp4");
  await fs.writeFile(uploadPath, "fake video");
  const uploaded = await client.callTool({
    name: "browser_upload",
    arguments: {
      session_id: result.structuredContent.session_id,
      selector: "input[type=file]",
      paths: [uploadPath],
    },
  });
  assert.equal(uploaded.structuredContent.file_count, 1);
  noRawCdp(uploaded);

  const audit = await fs.readFile(path.join(f.home, "audit.jsonl"), "utf8");
  assert.match(audit, /"client_name":"protocol-test"/);
});

test("configure sets, reads, clears, and validates per-profile launch options", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  const readEmpty = await f.service.configure({ profileId: "anyrouter-a" }, { clientName: "unit-client" });
  assert.deepEqual(readEmpty, { profile_id: "anyrouter-a", launch_options: {} });

  const set = await f.service.configure(
    {
      profileId: "anyrouter-a",
      options: {
        proxy: "socks5://127.0.0.1:19101",
        userAgent: "Mozilla/5.0",
        lang: "zh-CN",
        windowSize: "1280,900",
        extraChromeArgs: ["--disable-features=AutomationControlled"],
        initScript: "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});",
      },
    },
    { clientName: "unit-client" },
  );
  assert.deepEqual(set.launch_options.proxy, "socks5://127.0.0.1:19101");
  assert.deepEqual(set.launch_options.extraChromeArgs, ["--disable-features=AutomationControlled"]);

  const read = await f.service.configure({ profileId: "anyrouter-a" }, { clientName: "unit-client" });
  assert.deepEqual(read.launch_options.lang, "zh-CN");

  const status = await f.service.status({ profileId: "anyrouter-a" }, { clientName: "unit-client" });
  assert.deepEqual(status.launch_options.proxy, "socks5://127.0.0.1:19101");

  await assert.rejects(
    f.service.configure({ profileId: "anyrouter-a", options: { unknownKey: true } }, { clientName: "unit-client" }),
    /Unsupported launch option: unknownKey/,
  );

  const cleared = await f.service.configure(
    { profileId: "anyrouter-a", clear: true },
    { clientName: "unit-client" },
  );
  assert.deepEqual(cleared.launch_options, {});
  const readAfterClear = await f.service.configure({ profileId: "anyrouter-a" }, { clientName: "unit-client" });
  assert.deepEqual(readAfterClear.launch_options, {});
});

test("configure keeps explicit stable profile ids isolated", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);

  const shared = await f.service.configure(
    { profileId: "douyin", options: { proxy: "socks5://127.0.0.1:19101" } },
    { clientName: "unit-client" },
  );
  assert.deepEqual(shared.profile_id, "douyin");
});

test("v1 sessions migrate to v2 and startup preserves existing targets", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "browser-mcp-migrate-"));
  const home = path.join(root, "mcp");
  const fakeHome = path.join(root, "fake");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(fakeHome, { recursive: true });
  const now = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  await fs.writeFile(path.join(fakeHome, "state.json"), JSON.stringify({
    nextTarget: 2,
    targets: { "target-1": { profileId: "cdp-browser-daemon", url: "https://example.com/legacy", title: "Legacy" } },
  }));
  await fs.writeFile(path.join(home, "sessions.json"), JSON.stringify({
    version: 1,
    sessions: [{
      sessionId: "session-00000000-0000-4000-8000-000000000001",
      taskId: "legacy-task",
      profileId: "cdp-browser-daemon",
      targetId: "target-1",
      url: "https://example.com/legacy",
      status: "active",
      createdAt: now,
      updatedAt: now,
    }],
  }));

  const service = await BrowserService.create({
    home,
    daemonScript: fakeDaemon,
    daemonEnv: { FAKE_DAEMON_HOME: fakeHome },
  });
  const sessions = await service.listSessions({ status: "active" });
  assert.equal(sessions.sessions.length, 1);
  const stored = JSON.parse(await fs.readFile(path.join(home, "sessions.json"), "utf8"));
  assert.equal(stored.version, 2);
  assert.equal(stored.profileGenerations["cdp-browser-daemon"], 1);
  assert.equal(stored.sessions[0].profileGeneration, 1);
  assert.ok(stored.sessions[0].expiresAt);
});

test("startup invalidates sessions whose targets disappeared", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const opened = await f.service.open({ url: "https://example.com/gone" });
  const statePath = path.join(f.fakeHome, "state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.targets = {};
  await fs.writeFile(statePath, JSON.stringify(state));

  const restarted = await BrowserService.create({
    home: f.home,
    daemonScript: fakeDaemon,
    daemonEnv: { FAKE_DAEMON_HOME: f.fakeHome },
  });
  const sessions = await restarted.listSessions({ status: "invalid" });
  assert.equal(sessions.sessions[0].session_id, opened.session_id);
  assert.equal(sessions.sessions[0].invalid_reason, "target_missing_at_startup");
});

test("idle TTL expires sessions and successful actions refresh it", async (t) => {
  let now = Date.now();
  const f = await fixture({ sessionTtlMs: 100, now: () => now });
  t.after(f.cleanup);
  const opened = await f.service.open({ url: "https://example.com/ttl" });
  now += 80;
  await f.service.snapshot({ sessionId: opened.session_id });
  now += 80;
  assert.equal((await f.service.listSessions({ status: "active" })).sessions.length, 1);
  now += 30;
  const invalid = await f.service.listSessions({ status: "invalid" });
  assert.equal(invalid.sessions[0].invalid_reason, "ttl_expired");
});

test("different sessions in one profile run concurrently", async (t) => {
  const f = await fixture({ commandDelays: { snapshot: 100 } });
  t.after(f.cleanup);
  const first = await f.service.open({ url: "https://example.com/one" });
  const second = await f.service.open({ url: "https://example.com/two" });
  const eventsPath = path.join(f.fakeHome, "events.jsonl");
  await fs.writeFile(eventsPath, "");

  await Promise.all([
    f.service.snapshot({ sessionId: first.session_id }),
    f.service.snapshot({ sessionId: second.session_id }),
  ]);
  const events = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.slice(0, 2).map(({ phase }) => phase), ["start", "start"]);
  assert.notEqual(events[0].targetId, events[1].targetId);
});

test("recover waits for inflight work, blocks later opens, and invalidates old sessions", async (t) => {
  const f = await fixture({ commandDelays: { snapshot: 120 } });
  t.after(f.cleanup);
  const opened = await f.service.open({ url: "https://example.com/inflight", profileId: "shared-profile" });
  const eventsPath = path.join(f.fakeHome, "events.jsonl");
  await fs.writeFile(eventsPath, "");
  const inflight = f.service.snapshot({ sessionId: opened.session_id });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const recovery = f.service.recover({ profileId: "shared-profile" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const laterOpen = f.service.open({ url: "about:blank", profileId: "shared-profile" });
  const [, recovered, newlyOpened] = await Promise.all([inflight, recovery, laterOpen]);
  assert.equal(recovered.invalidated_sessions, 1);
  assert.equal(newlyOpened.url, "about:blank");
  await assert.rejects(
    f.service.snapshot({ sessionId: opened.session_id }),
    (error) => error instanceof BrowserServiceError && error.code === "SESSION_INVALID",
  );
  const events = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const snapshotEnd = events.findIndex((event) => event.command === "snapshot" && event.phase === "end");
  const recoverStart = events.findIndex((event) => event.command === "recover" && event.phase === "start");
  const openStart = events.findIndex((event) => event.command === "open" && event.phase === "start");
  assert.ok(snapshotEnd >= 0 && recoverStart > snapshotEnd && openStart > recoverStart);
});

test("stop kills the profile browser, invalidates its sessions, and is idempotent", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const stoppedTarget = await f.service.open({ url: "https://example.com/daily", profileId: "job-profile" });
  const keptTarget = await f.service.open({ url: "https://example.com/other", profileId: "other-profile" });
  const result = await f.service.stop({ profileId: "job-profile" }, { clientName: "unit-client" });
  assert.equal(result.profile_id, "job-profile");
  assert.equal(result.generation, 2);
  assert.equal(result.invalidated_sessions, 1);
  assert.equal(result.stopped, true);
  assert.equal(result.browser_running, false);
  noRawCdp(result);
  await assert.rejects(
    f.service.snapshot({ sessionId: stoppedTarget.session_id }),
    (error) => error instanceof BrowserServiceError && error.code === "SESSION_INVALID",
  );
  // Sessions on other profiles are untouched.
  assert.equal((await f.service.snapshot({ sessionId: keptTarget.session_id })).title, "Fake page");
  // Stopping an already stopped profile is safe and reports stopped=false.
  const again = await f.service.stop({ profileId: "job-profile" });
  assert.equal(again.stopped, false);
  assert.equal(again.browser_running, false);
  // A later open restarts the same profile.
  const reopened = await f.service.open({ url: "about:blank", profileId: "job-profile" });
  assert.equal(reopened.profile_id, "job-profile");
  assert.equal((await f.service.snapshot({ sessionId: reopened.session_id })).title, "Fake page");
  const events = (await fs.readFile(path.join(f.fakeHome, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(events.filter((event) => event.command === "stop" && event.phase === "start").length, 2);
  assert.equal(events.find((event) => event.command === "stop").profileId, "job-profile");
});

test("sanitizeLastUrl strips credentials, query, and hash", () => {
  assert.equal(sanitizeLastUrl("about:blank"), "about:blank");
  assert.equal(
    sanitizeLastUrl("https://user:secret@example.com/path?token=1#frag"),
    "https://example.com/path",
  );
  assert.equal(sanitizeLastUrl("javascript:alert(1)"), null);
});

test("a missing click ref is REF_STALE and does not invalidate the session", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const opened = await f.service.open({ url: "https://example.com/form" });
  await assert.rejects(
    () => f.service.click({ sessionId: opened.session_id, ref: "r99" }),
    (error) =>
      error instanceof BrowserServiceError &&
      error.code === "REF_STALE" &&
      error.details.session_id === opened.session_id &&
      error.details.last_url === "https://example.com/form",
  );
  const snapshot = await f.service.snapshot({ sessionId: opened.session_id });
  assert.equal(snapshot.title, "Fake page");
  const clicked = await f.service.click({ sessionId: opened.session_id, ref: "r1" });
  assert.equal(clicked.ok, true);
});

test("unhealthy profile serializes open so two cold starts do not overlap", async (t) => {
  const f = await fixture({ commandDelays: { open: 80 }, unhealthy: true });
  t.after(f.cleanup);
  const eventsPath = path.join(f.fakeHome, "events.jsonl");
  await fs.writeFile(eventsPath, "");
  const [first, second] = await Promise.all([
    f.service.open({ url: "https://example.com/one", profileId: "cold-profile" }),
    f.service.open({ url: "https://example.com/two", profileId: "cold-profile" }),
  ]);
  assert.match(first.session_id, /^session-/);
  assert.match(second.session_id, /^session-/);
  const events = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const opens = events.filter((event) => event.command === "open");
  assert.deepEqual(opens.map(({ phase }) => phase), ["start", "end", "start", "end"]);
  assert.ok(opens[2].time >= opens[1].time);
});

test("healthy profile still opens tabs concurrently", async (t) => {
  const f = await fixture({ commandDelays: { open: 80 } });
  t.after(f.cleanup);
  const eventsPath = path.join(f.fakeHome, "events.jsonl");
  await fs.writeFile(eventsPath, "");
  await Promise.all([
    f.service.open({ url: "https://example.com/one", profileId: "warm-profile" }),
    f.service.open({ url: "https://example.com/two", profileId: "warm-profile" }),
  ]);
  const events = (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const opens = events.filter((event) => event.command === "open");
  assert.deepEqual(opens.slice(0, 2).map(({ phase }) => phase), ["start", "start"]);
});

test("queue timeout is bounded and audited", async (t) => {
  const f = await fixture({ commandDelays: { snapshot: 100 }, queueWaitTimeoutMs: 20 });
  t.after(f.cleanup);
  const opened = await f.service.open({ url: "https://example.com/queue" });
  const first = f.service.snapshot({ sessionId: opened.session_id });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(
    f.service.snapshot({ sessionId: opened.session_id }),
    (error) => error instanceof BrowserServiceError && error.code === "QUEUE_TIMEOUT",
  );
  await first;
  const records = (await fs.readFile(path.join(f.home, "audit.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const timeout = records.find((record) => record.result === "QUEUE_TIMEOUT");
  assert.ok(timeout.queue_wait_ms >= 20);
});

test("queue capacity rejects excess work instead of growing without bound", async (t) => {
  const f = await fixture({ commandDelays: { snapshot: 80 }, maxQueued: 1 });
  t.after(f.cleanup);
  const opened = await f.service.open({ url: "https://example.com/full" });
  const first = f.service.snapshot({ sessionId: opened.session_id });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = f.service.snapshot({ sessionId: opened.session_id });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(
    f.service.snapshot({ sessionId: opened.session_id }),
    (error) => error instanceof BrowserServiceError && error.code === "QUEUE_FULL",
  );
  await Promise.all([first, second]);
});

test("status reports queue state without waiting behind a long page action", async (t) => {
  const f = await fixture({ commandDelays: { snapshot: 150 } });
  t.after(f.cleanup);
  const opened = await f.service.open({ url: "https://example.com/status" });
  const inflight = f.service.snapshot({ sessionId: opened.session_id });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const startedAt = Date.now();
  const status = await f.service.status();
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 120, `status took ${elapsed}ms`);
  assert.equal(status.queue.active[0].operation, "browser_snapshot");
  await inflight;
});

test("status remains diagnostic when daemon health times out", async (t) => {
  const f = await fixture({ commandDelays: { health: 80 }, statusTimeoutMs: 10 });
  t.after(f.cleanup);
  const status = await f.service.status();
  assert.equal(status.healthy, false);
  assert.match(status.health_error, /^DAEMON_/);
  assert.equal(status.queue.queued, 0);
});

test("claim is exact and fail-closed for duplicates and active ownership", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const statePath = path.join(f.fakeHome, "state.json");
  await fs.writeFile(statePath, JSON.stringify({
    nextTarget: 4,
    targets: {
      "target-1": { profileId: "cdp-browser-daemon", url: "https://example.com/claim", title: "Claim me" },
      "target-2": { profileId: "cdp-browser-daemon", url: "https://example.com/duplicate", title: "One" },
      "target-3": { profileId: "cdp-browser-daemon", url: "https://example.com/duplicate", title: "Two" },
    },
  }));
  const claimed = await f.service.claim({ url: "https://example.com/claim", title: "Claim me", taskId: "claim-task" });
  assert.equal(claimed.task_id, "claim-task");
  noRawCdp(claimed);
  await assert.rejects(
    f.service.claim({ url: "https://example.com/claim", title: "Claim me" }),
    (error) => error instanceof BrowserServiceError && error.code === "TAB_ALREADY_CLAIMED",
  );
  await assert.rejects(
    f.service.claim({ url: "https://example.com/duplicate" }),
    (error) => error instanceof BrowserServiceError && error.code === "TAB_AMBIGUOUS",
  );
});

test("task cleanup closes only MCP-owned sessions for the exact task", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.service.open({ url: "https://example.com/a", taskId: "task-a" });
  await f.service.open({ url: "https://example.com/b", taskId: "task-a" });
  await f.service.open({ url: "https://example.com/c", taskId: "task-b" });
  const result = await f.service.closeTaskSessions({ taskId: "task-a" });
  assert.deepEqual(result, {
    task_id: "task-a",
    profile_id: null,
    matched: 2,
    closed: 2,
    already_closed: 0,
  });
  assert.equal((await f.service.listSessions({ taskId: "task-a", status: "closed" })).sessions.length, 2);
  assert.equal((await f.service.listSessions({ taskId: "task-b", status: "active" })).sessions.length, 1);
});

test("about:blank opens and networkidle remains a compatible complete wait", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const opened = await f.service.open({ url: "about:blank" });
  assert.equal(opened.url, "about:blank");
  const waited = await f.service.wait({ sessionId: opened.session_id, load: "networkidle" });
  assert.equal(waited.requested_state, "networkidle");
  assert.equal(waited.ready_state, "complete");
});

test("closed browser sessions older than retention are dropped", async (t) => {
  let now = Date.now();
  const f = await fixture({ sessionTtlMs: 60_000, sessionRetentionMs: 1_000, now: () => now });
  t.after(f.cleanup);
  const opened = await f.service.open({ url: "https://example.com/drop" });
  await f.service.close({ sessionId: opened.session_id });
  assert.equal((await f.service.listSessions({ status: "closed" })).sessions.length, 1);
  now += 1_001;
  await f.service.persistSessions();
  assert.equal((await f.service.listSessions()).sessions.length, 0);
  const stored = JSON.parse(await fs.readFile(path.join(f.home, "sessions.json"), "utf8"));
  assert.equal(stored.sessions.length, 0);
});

test("HTTP MCP client sessions expire after idle TTL and health reports counts", async (t) => {
  let now = Date.now();
  const f = await fixture();
  const running = await startBrowserMcpServer({
    service: f.service,
    port: 0,
    now: () => now,
    httpSessionTtlMs: 1_000,
    httpSessionSweepMs: 0,
    httpSessionMax: 8,
  });
  const client = new Client({ name: "ttl-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(running.url));
  t.after(async () => {
    await client.close().catch(() => undefined);
    await running.close();
    await f.cleanup();
  });

  await client.connect(transport);
  assert.equal(running.httpClientCount(), 1);
  const health = await (await fetch(`http://127.0.0.1:${running.port}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.mcp_clients, 1);
  assert.equal(health.http_session_ttl_ms, 1_000);
  assert.equal(health.browser_sessions.total, 0);
  assert.ok(health.memory.rss_bytes > 0);

  now += 1_001;
  await running.sweepHttpSessions();
  assert.equal(running.httpClientCount(), 0);
  const after = await (await fetch(`http://127.0.0.1:${running.port}/health`)).json();
  assert.equal(after.mcp_clients, 0);
  await assert.rejects(() => client.listTools());
});

test("HTTP MCP client cap evicts the oldest session", async (t) => {
  const f = await fixture();
  const running = await startBrowserMcpServer({
    service: f.service,
    port: 0,
    httpSessionTtlMs: 60_000,
    httpSessionSweepMs: 0,
    httpSessionMax: 2,
  });
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    await running.close();
    await f.cleanup();
  });

  for (let index = 0; index < 3; index += 1) {
    const client = new Client({ name: `cap-${index}`, version: "1.0.0" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
  }
  assert.equal(running.httpClientCount(), 2);
  await assert.rejects(() => clients[0].listTools());
  await clients[1].listTools();
  await clients[2].listTools();
});

function captureStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  stream.text = () => Buffer.concat(chunks).toString("utf8");
  return stream;
}

async function runCli(argv, mcpUrl) {
  const stdout = captureStream();
  const stderr = captureStream();
  const result = await runBrowserMcpCli(argv, { mcpUrl, stdout, stderr });
  return {
    ...result,
    stdoutText: stdout.text(),
    stderrText: stderr.text(),
    json: stdout.text().trim() ? JSON.parse(stdout.text()) : null,
  };
}

test("CLI argv maps aliases, kebab flags, and JSON blobs onto tool arguments", () => {
  assert.equal(resolveToolName("status"), "browser_status");
  assert.equal(resolveToolName("browser_open"), "browser_open");
  const parsed = parseCliArgv([
    "--mcp-url",
    "http://127.0.0.1:9/mcp",
    "browser_open",
    "--url",
    "https://example.com",
    "--profile-id",
    "acct",
    "--json",
    '{"task_id":"cli-test"}',
  ]);
  assert.equal(parsed.cli.mcpUrl, "http://127.0.0.1:9/mcp");
  assert.equal(parsed.positionals[0], "browser_open");
  assert.deepEqual(parsed.toolArgs, {
    url: "https://example.com",
    profile_id: "acct",
    task_id: "cli-test",
  });
});

test("CLI opens a tab over a fresh HTTP session and always DELETE-s it", async (t) => {
  const f = await fixture();
  const running = await startBrowserMcpServer({ service: f.service, port: 0 });
  t.after(async () => {
    await running.close();
    await f.cleanup();
  });

  const opened = await runCli(["browser_open", "--url", "https://example.com/cli"], running.url);
  assert.equal(opened.exitCode, 0, opened.stderrText);
  assert.match(opened.json.session_id, /^session-/);
  assert.equal(opened.json.url, "https://example.com/cli");
  noRawCdp(opened.json);
  assert.equal(running.httpClientCount(), 0);

  const snapshot = await runCli(["browser_snapshot", "--session-id", opened.json.session_id], running.url);
  assert.equal(snapshot.exitCode, 0, snapshot.stderrText);
  assert.equal(snapshot.json.title, "Fake page");
  assert.equal(running.httpClientCount(), 0);

  const audit = await fs.readFile(path.join(f.home, "audit.jsonl"), "utf8");
  assert.match(audit, /"client_name":"browser-mcp-cli"/);
});

test("CLI still works when a stale host MCP client is connected", async (t) => {
  const f = await fixture();
  const running = await startBrowserMcpServer({ service: f.service, port: 0 });
  const stuck = new Client({ name: "stale-host", version: "1.0.0" });
  t.after(async () => {
    await stuck.close().catch(() => undefined);
    await running.close();
    await f.cleanup();
  });

  await stuck.connect(new StreamableHTTPClientTransport(new URL(running.url)));
  assert.equal(running.httpClientCount(), 1);

  const opened = await runCli(["open", "--url", "https://example.com/fallback"], running.url);
  assert.equal(opened.exitCode, 0, opened.stderrText);
  assert.match(opened.json.session_id, /^session-/);
  assert.equal(running.httpClientCount(), 1);
  await stuck.listTools();
});

test("CLI health and tools do not leak HTTP sessions; down server fails closed", async (t) => {
  const f = await fixture();
  const running = await startBrowserMcpServer({ service: f.service, port: 0 });
  t.after(async () => {
    await running.close().catch(() => undefined);
    await f.cleanup();
  });

  const health = await runCli(["health"], running.url);
  assert.equal(health.exitCode, 0, health.stderrText);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.service, "browser-mcp");
  assert.equal(running.httpClientCount(), 0);

  const tools = await runCli(["tools"], running.url);
  assert.equal(tools.exitCode, 0, tools.stderrText);
  assert.ok(tools.json.some((tool) => tool.name === "browser_open"));
  assert.equal(running.httpClientCount(), 0);

  await running.close();
  const down = await runCli(["browser_status"], running.url);
  assert.equal(down.exitCode, 1);
  assert.match(down.stderrText, /unreachable/);
  assert.match(down.stderrText, /cdp_browser_daemon\.js/);
});

test("browser guard blocks daemon and raw CDP, but allows the facade CLI", () => {
  assert.equal(
    shouldBlockBrowserCommand("node /Users/example/.codex/skills/cdp-browser-daemon/scripts/cdp_browser_daemon.js open https://example.com"),
    true,
  );
  assert.equal(
    shouldBlockBrowserCommand("'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --remote-debugging-port=9222"),
    true,
  );
  assert.equal(shouldBlockBrowserCommand("curl http://127.0.0.1:9222/json/version"), true);
  assert.equal(
    shouldBlockBrowserCommand("node /Users/example/Workspace/browser-mcp/cli.mjs browser_status"),
    false,
  );
  assert.equal(shouldBlockBrowserCommand("browser-mcp browser_open --url https://example.com"), false);
  const denied = browserGuardResponse("node cdp_browser_daemon.js status");
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /browser-mcp CLI/);
});

test("Grok browser-mcp host tools are detected from use_tool and MCP names", () => {
  assert.equal(
    isBrowserMcpHostTool({
      toolName: "use_tool",
      toolInput: { tool_name: "browser-mcp__browser_open", tool_input: { url: "https://example.com" } },
    }),
    true,
  );
  assert.equal(isBrowserMcpHostTool({ toolName: "browser-mcp__browser_status" }), true);
  assert.equal(isBrowserMcpHostTool({ tool_name: "mcp__browser_mcp__browser_snapshot" }), true);
  assert.equal(isBrowserMcpHostTool({ toolName: "use_tool", toolInput: { tool_name: "context7__query-docs" } }), false);
  assert.equal(isBrowserMcpHostTool({ toolName: "run_terminal_command" }), false);
});

test("Grok UUID v7 session ids encode start time for the idle circuit", () => {
  assert.equal(uuidv7Ms("01a0a321-9140-7a10-93d9-0ac1e80e6417"), Date.parse("2026-09-15T03:34:41.216Z"));
  assert.equal(uuidv7Ms("not-a-session"), null);
});

test("Grok bridge circuit denies stale host calls and allows a fresh or recently used session", () => {
  const hangId = "01a0a321-9140-7a10-93d9-0ac1e80e6417";
  const now = Date.parse("2026-09-15T08:32:47.571Z");
  assert.equal(shouldDenyHostCall({ sessionId: hangId, now }), true);
  assert.ok(idleMs({ sessionId: hangId, now }) > 20 * 60 * 1000);

  const recentOk = { lastOkAt: "2026-09-15T08:20:00.000Z" };
  assert.equal(shouldDenyHostCall({ record: recentOk, sessionId: hangId, now }), false);

  const freshId = "01a0a44a-7b3c-7631-b068-e20d8c16583c";
  const freshNow = Date.parse("2026-09-15T08:59:15.000Z");
  assert.equal(shouldDenyHostCall({ sessionId: freshId, now: freshNow }), false);
});

test("Grok bridge circuit PreToolUse denies the 5h-idle hang session and PostToolUse refreshes it", async () => {
  const hangId = "01a0a321-9140-7a10-93d9-0ac1e80e6417";
  const now = Date.parse("2026-09-15T08:32:47.571Z");
  const state = { sessions: {} };
  const denied = await applyEvent(
    {
      hookEventName: "pre_tool_use",
      hook_event_name: "PreToolUse",
      sessionId: hangId,
      timestamp: "2026-09-15T08:32:47.571Z",
      toolName: "use_tool",
      toolInput: { tool_name: "browser-mcp__browser_open", tool_input: { url: "https://linux.do/" } },
    },
    { now, state },
  );
  assert.equal(denied.decision, "deny");
  assert.match(denied.reason, /browser-mcp browser_open/);
  assert.match(DENY_REASON, /do not retry use_tool/i);

  const later = now + 60_000;
  await applyEvent(
    {
      hookEventName: "post_tool_use",
      hook_event_name: "PostToolUse",
      sessionId: hangId,
      toolName: "browser-mcp__browser_status",
    },
    { now: later, state },
  );
  const allowed = await applyEvent(
    {
      hookEventName: "pre_tool_use",
      hook_event_name: "PreToolUse",
      sessionId: hangId,
      toolName: "browser-mcp__browser_open",
      toolInput: { url: "https://linux.do/" },
    },
    { now: later + 1_000, state },
  );
  assert.equal(allowed, null);
});

test("Grok bridge circuit ignores unrelated tools and persists session start to disk", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grok-bridge-"));
  const statePath = path.join(root, "grok-bridge-state.json");
  try {
    const sessionId = "01a0a44a-7b3c-7631-b068-e20d8c16583c";
    const now = Date.parse("2026-09-15T08:59:15.000Z");
    const ignored = await applyEvent(
      {
        hook_event_name: "PreToolUse",
        sessionId,
        toolName: "run_terminal_command",
        toolInput: { command: "browser-mcp health" },
      },
      { now, statePath },
    );
    assert.equal(ignored, null);
    const saved = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.ok(saved.sessions[sessionId].startedAt);
    const hostDenied = await applyEvent(
      {
        hook_event_name: "PreToolUse",
        sessionId: "01a0a321-9140-7a10-93d9-0ac1e80e6417",
        toolName: "use_tool",
        toolInput: { tool_name: "browser-mcp__browser_status" },
      },
      { now: Date.parse("2026-09-15T08:32:47.571Z"), statePath },
    );
    assert.equal(hostDenied.decision, "deny");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
