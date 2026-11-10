#!/usr/bin/env node
"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const net = require("net");
const dns = require("dns").promises;
const { spawn, execFile, execFileSync } = require("child_process");
const execFileP = (cmd, args, opts) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 8000, ...opts }, (err, stdout, stderr) =>
    resolve({ err, stdout, stderr })
  );
});

const HOME = os.homedir();
const BUILTIN_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_CHROME_PATH = process.env.CDP_BROWSER_CHROME || BUILTIN_CHROME_PATH;
/** Official skill-owned profile root (NOT under ~/.openclaw). */
const DAEMON_HOME = process.env.CDP_BROWSER_HOME
  ? path.resolve(expandHomeEarly(process.env.CDP_BROWSER_HOME))
  : path.join(HOME, ".cdp-browser-daemon");
const PROFILE_ROOT =
  process.env.CDP_BROWSER_PROFILE_ROOT
    ? path.resolve(expandHomeEarly(process.env.CDP_BROWSER_PROFILE_ROOT))
    : path.join(DAEMON_HOME, "profiles");
/** Default shared profile. Explicit --id/--profile values create isolated profiles. */
const OFFICIAL_LANE = "cdp-browser-daemon";
const PROTECTED_OPENCLAW_PROFILE = path.join(HOME, ".openclaw", "browser", "openclaw", "user-data");
const REGISTRY_ROOT = path.join(DAEMON_HOME, "registry");
/** Optional daemon config: { forceIpv4Hosts: [...], extraChromeArgs: [...] }. */
const DAEMON_CONFIG_PATH = path.join(DAEMON_HOME, "config.json");
/** Per-profile launch options file, stored next to profile.json (NOT inside user-data). */
const LAUNCH_OPTIONS_FILE = "launch-options.json";
const DEFAULT_TIMEOUT_MS = Number(process.env.CDP_BROWSER_TIMEOUT_MS || 30000);
const DEFAULT_LOCK_TIMEOUT_MS = Number(process.env.CDP_BROWSER_LOCK_TIMEOUT_MS || 30000);
const DEFAULT_LOCK_STALE_MS = Number(process.env.CDP_BROWSER_LOCK_STALE_MS || 120000);
const DEFAULT_RETRIES = Number(process.env.CDP_BROWSER_RETRIES || 1);
/** Legacy --lane names collapse onto the official profile to preserve existing login state. */
const LEGACY_LANE_ALIASES = new Set([
  "default",
  "douyin",
  "linkedin",
  "gemini-search",
  "deepresearch",
  "pi-linuxdo",
  "firecrawl",
  "personal",
  "jobs",
  "social",
  "appleapply",
  "applesearch",
  "nvidia",
  "x-marketmemo",
  "zhipu-maas-research",
  "checkout-ui",
  "personal-workbench",
  "search-api-signup",
  "linkedin-retry-0617",
  "linkedin-review",
  "linkedin-profile-update",
  "jobscan",
]);

function expandHomeEarly(value) {
  if (!value) return value;
  if (value === "~") return HOME;
  if (value.startsWith("~/")) return path.join(HOME, value.slice(2));
  return value;
}

class DaemonError extends Error {
  constructor(message, code = "DAEMON_ERROR") {
    super(message);
    this.name = "DaemonError";
    this.code = code;
  }
}

class CdpClient {
  constructor(wsUrl, timeoutMs) {
    this.wsUrl = wsUrl;
    this.timeoutMs = timeoutMs;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new DaemonError(`Timed out connecting to CDP WebSocket: ${this.wsUrl}`, "CDP_TIMEOUT"));
        try {
          ws.close();
        } catch (_) {
          // Ignore close errors during timeout cleanup.
        }
      }, this.timeoutMs);

      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new DaemonError(`CDP WebSocket error: ${event.message || "unknown error"}`, "CDP_SOCKET"));
      });
      ws.addEventListener("message", (event) => this._onMessage(event.data));
      ws.addEventListener("close", () => this._onClose());
    });
  }

  _onMessage(data) {
    let text = data;
    if (Buffer.isBuffer(data)) text = data.toString("utf8");
    if (typeof text !== "string") text = String(text);
    let message;
    try {
      message = JSON.parse(text);
    } catch (_) {
      return;
    }
    if (!message.id || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(
        new DaemonError(
          `CDP ${pending.method} failed: ${message.error.message || JSON.stringify(message.error)}`,
          "CDP_METHOD",
        ),
      );
    } else {
      pending.resolve(message.result || {});
    }
  }

  _onClose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new DaemonError(`CDP WebSocket closed while waiting for ${pending.method}`, "CDP_CLOSED"));
    }
    this.pending.clear();
  }

  async send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new DaemonError("CDP WebSocket is not open", "CDP_CLOSED");
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DaemonError(`CDP ${method} timed out after ${this.timeoutMs}ms`, "CDP_TIMEOUT"));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
    });
    this.ws.send(payload);
    return promise;
  }

  close() {
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch (_) {
      // Best effort only.
    }
  }
}

function usage() {
  return [
    "Usage: cdp_browser_daemon.js <command> [options] [args...]",
    "",
    "Lifecycle:",
    "  profiles [--json]",
    "  status [--id profile-id|--all] [--json]",
    "  start [--id profile-id] [--label text] [--port n] [--headless] [--stealth]",
    "  health [--id profile-id] [--restart-on-fail] [--json]",
    "  recover [--id profile-id]",
    "  restart [--id profile-id|--all] [--no-restore-tabs]",
    "  stop [--id profile-id|--all]",
    "",
    `Default profile: ${OFFICIAL_LANE}`,
    `Named profiles: ${PROFILE_ROOT}/<id>/user-data`,
    "Use a stable account identity for --id; do not create per-task or retry ids.",
    "--profile is an alias for --id. --lane remains for legacy callers.",
    "",
    "Profile configuration:",
    "  launch-options --id profile-id [--get]",
    "  launch-options --id profile-id --set '{json}' [--clear]",
    "    Supported: proxy, userAgent, lang, windowSize, webrtcPolicy,",
    "    extraChromeArgs[], initScript (installed before first navigation).",
    "",
    "Browser actions:",
    "  tabs --id profile-id",
    "  open --id profile-id <url> [--background]",
    "  navigate --id profile-id <url> [--target tab]",
    "  snapshot --id profile-id [--target tab]",
    "  click --id profile-id [--target tab] <ref-or-selector>",
    "  type --id profile-id [--target tab] <ref-or-selector> <text>",
    "  upload --id profile-id [--target tab] <css-selector> <absolute-file> [...]",
    "  evaluate --id profile-id [--target tab] --fn '() => document.title'",
    "  wait --id profile-id [--load complete|interactive] [--timeout ms]",
    "  screenshot --id profile-id [--target tab] [--full-page] [--path file]",
    "  close-tab --id profile-id [--target tab]",
  ].join("\n");
}

function parseArgs(argv) {
  const command = argv[0];
  if (!command || command === "-h" || command === "--help") {
    return { command: "help", options: {}, positionals: [] };
  }

  const options = {
    lane: process.env.CDP_BROWSER_LANE || OFFICIAL_LANE,
    profileId: process.env.CDP_BROWSER_PROFILE_ID || undefined,
    chromePath: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
    lockStaleMs: DEFAULT_LOCK_STALE_MS,
    retries: DEFAULT_RETRIES,
    restoreTabs: true,
    stealth: undefined,
    headless: undefined,
    background: false,
    json: false,
    all: false,
    restartOnFail: false,
    fullPage: false,
    load: "complete",
  };
  const positionals = [];

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = (name) => {
      if (i + 1 >= argv.length) throw new DaemonError(`${name} requires a value`, "ARGUMENT");
      i += 1;
      return argv[i];
    };

    if (arg === "--id" || arg === "--profile") options.profileId = readValue(arg);
    else if (arg === "--lane") options.lane = readValue(arg);
    else if (arg === "--profile-dir") options.profileDir = readValue(arg);
    else if (arg === "--label") options.label = readValue(arg);
    else if (arg === "--port") options.port = Number(readValue(arg));
    else if (arg === "--chrome") {
      options.chromePath = expandHome(readValue(arg));
      options.chromePathFromCli = true;
    }
    else if (arg === "--target") options.target = readValue(arg);
    else if (arg === "--timeout") options.timeoutMs = Number(readValue(arg));
    else if (arg === "--lock-timeout") options.lockTimeoutMs = Number(readValue(arg));
    else if (arg === "--retries") options.retries = Number(readValue(arg));
    else if (arg === "--path") options.path = expandHome(readValue(arg));
    else if (arg === "--fn") options.fn = readValue(arg);
    else if (arg === "--format") options.format = readValue(arg);
    else if (arg === "--load") options.load = readValue(arg);
    else if (arg === "--json") options.json = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--headless") options.headless = true;
    else if (arg === "--headed") options.headless = false;
    else if (arg === "--background") options.background = true;
    else if (arg === "--foreground") options.background = false;
    else if (arg === "--stealth") options.stealth = true;
    else if (arg === "--no-stealth") options.stealth = false;
    else if (arg === "--set") options.set = readValue(arg);
    else if (arg === "--clear") options.clear = true;
    else if (arg === "--restart-on-fail") options.restartOnFail = true;
    else if (arg === "--restore-tabs") options.restoreTabs = true;
    else if (arg === "--no-restore-tabs") options.restoreTabs = false;
    else if (arg === "--full-page") options.fullPage = true;
    else if (arg.startsWith("--")) throw new DaemonError(`Unknown option: ${arg}`, "ARGUMENT");
    else positionals.push(arg);
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new DaemonError("--timeout must be a positive number of milliseconds", "ARGUMENT");
  }
  if (!Number.isFinite(options.retries) || options.retries < 0) {
    throw new DaemonError("--retries must be zero or greater", "ARGUMENT");
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    throw new DaemonError("--port must be an integer between 1 and 65535", "ARGUMENT");
  }
  if (options.label !== undefined && (!options.label.trim() || options.label.length > 200)) {
    throw new DaemonError("--label must be between 1 and 200 characters", "ARGUMENT");
  }

  return { command, options, positionals };
}

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return HOME;
  if (value.startsWith("~/")) return path.join(HOME, value.slice(2));
  return value;
}

function safeLaneName(name) {
  const cleaned = String(name || OFFICIAL_LANE)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new DaemonError("Profile ID is empty or unsafe after normalization", "ARGUMENT");
  }
  return cleaned.slice(0, 80);
}

function pathIsWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Map legacy --lane callers onto the official cookie-sharing profile. */
function resolveLaneName(rawLane) {
  const cleaned = safeLaneName(rawLane || OFFICIAL_LANE);
  if (cleaned === OFFICIAL_LANE) return cleaned;
  if (LEGACY_LANE_ALIASES.has(cleaned)) return OFFICIAL_LANE;
  // Retain the old opt-in behavior for unknown --lane values. New callers use --id.
  if (process.env.CDP_BROWSER_ALLOW_ISOLATED_LANES === "1") return cleaned;
  return OFFICIAL_LANE;
}

function resolveProfileDir(options) {
  const profileId = options.profileId
    ? safeLaneName(options.profileId)
    : resolveLaneName(options.lane);
  options.profileId = profileId;
  options.lane = profileId;
  const profileDir = options.profileDir
    ? path.resolve(expandHome(options.profileDir))
    : path.join(PROFILE_ROOT, profileId, "user-data");
  if (pathIsWithin(profileDir, PROTECTED_OPENCLAW_PROFILE)) {
    throw new DaemonError(
      `Refusing to use protected OpenClaw profile: ${PROTECTED_OPENCLAW_PROFILE}`,
      "PROTECTED_PROFILE",
    );
  }
  return profileDir;
}

function profileMetadataPath(profileDir) {
  const normalized = path.resolve(profileDir);
  if (!pathIsWithin(normalized, PROFILE_ROOT)) return null;
  return path.join(path.dirname(normalized), "profile.json");
}

async function ensureProfileMetadata(profileDir, options) {
  const metadataPath = profileMetadataPath(profileDir);
  if (!metadataPath) return null;
  const existing = (await readJson(metadataPath)) || {};
  const now = new Date().toISOString();
  const metadata = {
    id: options.profileId || options.lane,
    label: options.label !== undefined ? options.label.trim() : existing.label || null,
    profileDir: path.resolve(profileDir),
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
  await writeJsonAtomic(metadataPath, metadata);
  return metadata;
}

const LAUNCH_OPTION_KEYS = new Set([
  "proxy",
  "userAgent",
  "lang",
  "windowSize",
  "webrtcPolicy",
  "extraChromeArgs",
  "initScript",
  "chromePath",
]);

function launchOptionsPath(profileDir) {
  const normalized = path.resolve(profileDir);
  if (!pathIsWithin(normalized, PROFILE_ROOT)) return null;
  return path.join(path.dirname(normalized), LAUNCH_OPTIONS_FILE);
}

function normalizeLaunchOptions(raw) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new DaemonError("launch options must be a JSON object", "ARGUMENT");
  }
  const out = {};
  for (const key of LAUNCH_OPTION_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (key === "extraChromeArgs") {
      if (!Array.isArray(value) || !value.every((a) => typeof a === "string" && a.startsWith("--"))) {
        throw new DaemonError("extraChromeArgs must be an array of Chrome flags", "ARGUMENT");
      }
      out.extraChromeArgs = [...value];
    } else if (typeof value !== "string" || !value.trim()) {
      throw new DaemonError(`${key} must be a non-empty string`, "ARGUMENT");
    } else {
      out[key] = value.trim();
    }
  }
  return out;
}

async function loadLaunchOptions(profileDir) {
  const optionsPath = launchOptionsPath(profileDir);
  if (!optionsPath) return {};
  try {
    return normalizeLaunchOptions(await readJson(optionsPath));
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function saveLaunchOptions(profileDir, launchOptions) {
  const optionsPath = launchOptionsPath(profileDir);
  if (!optionsPath) {
    throw new DaemonError("launch options are only supported for profiles under the daemon profile root", "ARGUMENT");
  }
  const normalized = normalizeLaunchOptions(launchOptions);
  await fsp.mkdir(path.dirname(optionsPath), { recursive: true });
  if (Object.keys(normalized).length === 0) {
    try {
      await fsp.unlink(optionsPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return {};
  }
  const tmp = `${optionsPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(tmp, optionsPath);
  return normalized;
}

function registryFor(profileDir) {
  const normalized = path.resolve(profileDir);
  const key = crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 12);
  const dir = path.join(REGISTRY_ROOT, key);
  return {
    key,
    dir,
    statePath: path.join(dir, "state.json"),
    lockPath: path.join(REGISTRY_ROOT, `${key}.lock`),
    profileDir: normalized,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, filePath);
}

async function withLock(entry, options, fn) {
  await fsp.mkdir(REGISTRY_ROOT, { recursive: true });
  const start = Date.now();
  while (true) {
    try {
      await fsp.mkdir(entry.lockPath);
      await fsp.writeFile(
        path.join(entry.lockPath, "owner.json"),
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), profileDir: entry.profileDir }),
      );
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const owner = await readJson(path.join(entry.lockPath, "owner.json"));
        if (!owner || !pidAlive(Number(owner.pid))) stale = true;
      } catch (_) {
        stale = true;
      }
      if (!stale) {
        try {
          const stat = await fsp.stat(entry.lockPath);
          stale = Date.now() - stat.mtimeMs > options.lockStaleMs;
        } catch (_) {
          stale = true;
        }
      }
      if (stale) {
        await fsp.rm(entry.lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - start > options.lockTimeoutMs) {
        throw new DaemonError(`Timed out waiting for lane lock: ${entry.lockPath}`, "LOCK_TIMEOUT");
      }
      await sleep(100);
    }
  }

  try {
    return await fn();
  } finally {
    await fsp.rm(entry.lockPath, { recursive: true, force: true });
  }
}

async function readState(entry) {
  return readJson(entry.statePath);
}

async function writeState(entry, state) {
  await writeJsonAtomic(entry.statePath, state);
}

async function removeState(entry) {
  await fsp.rm(entry.statePath, { force: true });
}

function readPidState(pid) {
  try {
    return execFileSync("/bin/ps", ["-o", "state=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (_) {
    return "";
  }
}

function pidIsDefunct(pid) {
  const state = readPidState(pid);
  // Z = zombie. E = exiting (macOS shows this as STAT Es / ?Es with
  // command "(Google Chrome)"). Both still satisfy kill(pid, 0).
  return !state || /^[ZE]/i.test(state);
}

function pidIsZombie(pid) {
  return pidIsDefunct(pid);
}

function pidAlive(pid) {
  if (!pid || !Number.isInteger(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
  } catch (error) {
    return error.code === "EPERM";
  }
  return !pidIsDefunct(pid);
}

function isChromeMainCommand(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return false;
  // macOS exiting stubs look like "(Google Chrome)" and must not count as live.
  if (/^\(.*\)$/.test(cmd)) return false;
  if (/Google Chrome Helper/i.test(cmd)) return false;
  if (/chrome_crashpad_handler/i.test(cmd)) return false;
  if (/--type=/i.test(cmd)) return false;
  return /MacOS\/Google Chrome|MacOS\/Chromium|\/chrome(\s|$)/i.test(cmd);
}

function parseRemoteDebuggingPort(command) {
  const match = String(command || "").match(/--remote-debugging-port=(\d+)/);
  return match ? Number(match[1]) : null;
}

function parseSingletonLockPid(target) {
  const match = String(target || "").match(/-(\d+)$/);
  return match ? Number(match[1]) : null;
}

async function listChromeMainPids(profileDir) {
  const marker = `user-data-dir=${profileDir}`;
  const { err, stdout } = await execFileP("/usr/bin/pgrep", ["-f", marker]);
  if (err || !stdout.trim()) return [];
  const pids = [];
  for (const pid of stdout.trim().split(/\s+/).filter(Boolean)) {
    const { stdout: command } = await execFileP("/bin/ps", ["-o", "command=", "-p", pid]);
    if (isChromeMainCommand(command)) pids.push(Number(pid));
  }
  return pids;
}

async function findLiveChromeForProfile(profileDir) {
  for (const pid of await listChromeMainPids(profileDir)) {
    if (!pidAlive(pid)) continue;
    const { stdout: command } = await execFileP("/bin/ps", ["-o", "command=", "-p", String(pid)]);
    const port = parseRemoteDebuggingPort(command);
    if (port) return { pid, port, command: String(command || "").trim() };
  }
  return null;
}

async function pidListeningOnPort(port) {
  if (!port) return null;
  const { stdout } = await execFileP("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  const pid = Number(String(stdout || "").trim().split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function clearStaleSingletonLocks(profileDir) {
  const live = (await listChromeMainPids(profileDir)).filter((pid) => pidAlive(pid));
  const lockPath = path.join(profileDir, "SingletonLock");
  let lockPid = null;
  try {
    lockPid = parseSingletonLockPid(await fsp.readlink(lockPath));
  } catch (error) {
    if (error && error.code === "ENOENT" && live.length) return false;
  }
  // Only keep the lock when its PID is a live main Chrome for this profile.
  if (lockPid && live.includes(lockPid)) return false;
  if (!lockPid && live.length) return false;
  for (const name of [
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    "RunningChromeVersion",
    "DevToolsActivePort",
  ]) {
    try {
      await fsp.unlink(path.join(profileDir, name));
    } catch (_) {
      // already gone
    }
  }
  return true;
}

async function adoptLiveChromeIfReady(entry, state, options) {
  const live = await findLiveChromeForProfile(entry.profileDir);
  if (!live) return null;
  try {
    const version = await waitForVersion(live.port, Math.min(options.timeoutMs || DEFAULT_TIMEOUT_MS, 10000));
    if (!version?.webSocketDebuggerUrl || !pidAlive(live.pid)) return null;
    const now = new Date().toISOString();
    const next = {
      ...(state || {}),
      key: entry.key,
      lane: safeLaneName(options.lane),
      profileId: safeLaneName(options.profileId || options.lane),
      pid: live.pid,
      port: live.port,
      wsUrl: version.webSocketDebuggerUrl,
      httpUrl: `http://127.0.0.1:${live.port}`,
      profileDir: entry.profileDir,
      chromePath: resolveChromePath(options, state),
      headless: Boolean(options.headless ?? state?.headless),
      stealth: Boolean(options.stealth ?? state?.stealth),
      launchOptions: state?.launchOptions || {},
      startedAt: state?.startedAt || now,
      updatedAt: now,
      lastTabs: state?.lastTabs || [],
    };
    await writeState(entry, next);
    return next;
  } catch (_) {
    return null;
  }
}

async function persistAdoptedState(entry, state, health) {
  if (!state || !health?.ok || !health.adoptedPid) return state;
  const port = Number(health.adoptedPort || state.port);
  if (Number(health.adoptedPid) === Number(state.pid) && port === Number(state.port)) {
    return state;
  }
  const next = {
    ...state,
    pid: Number(health.adoptedPid),
    port,
    wsUrl: health.wsUrl || state.wsUrl,
    httpUrl: `http://127.0.0.1:${port}`,
    chromePath: resolveChromePath({}, state),
    updatedAt: new Date().toISOString(),
  };
  await writeState(entry, next);
  return next;
}

async function fetchJson(url, timeoutMs, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new DaemonError(`HTTP ${response.status} from ${url}`, "HTTP_ERROR");
    }
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new DaemonError(`Timed out fetching ${url}`, "HTTP_TIMEOUT");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForVersion(port, timeoutMs) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`, Math.min(3000, timeoutMs));
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new DaemonError(
    `Chrome CDP endpoint did not become ready on port ${port}: ${lastError ? lastError.message : "timeout"}`,
    "START_TIMEOUT",
  );
}

async function getBrowserWsUrl(state, timeoutMs) {
  if (state && state.wsUrl) return state.wsUrl;
  const version = await fetchJson(`http://127.0.0.1:${state.port}/json/version`, timeoutMs);
  return version.webSocketDebuggerUrl;
}

async function listTargetsByPort(port, timeoutMs) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, timeoutMs);
  return Array.isArray(targets) ? targets : [];
}

function normalizeTabs(targets) {
  return targets
    .filter((target) => target.type === "page")
    .map((target) => ({
      id: target.id,
      title: target.title || "",
      url: target.url || "",
      type: target.type,
      webSocketDebuggerUrl: target.webSocketDebuggerUrl,
    }));
}

function restorableTabs(tabs) {
  const seen = new Set();
  const blocked = /^(about:blank|chrome:\/\/|devtools:\/\/|edge:\/\/|chrome-error:\/\/)/i;
  const urls = [];
  for (const tab of tabs || []) {
    const url = tab.url || "";
    if (!url || blocked.test(url) || seen.has(url)) continue;
    seen.add(url);
    urls.push({ url, title: tab.title || "" });
  }
  return urls.slice(0, 30);
}

async function captureTabs(state, options) {
  if (!state || !state.port) return [];
  try {
    const targets = await listTargetsByPort(state.port, Math.min(options.timeoutMs, 5000));
    return restorableTabs(normalizeTabs(targets));
  } catch (_) {
    return Array.isArray(state.lastTabs) ? state.lastTabs : [];
  }
}

async function probeCdpPort(port, options, result) {
  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`, Math.min(options.timeoutMs, 5000));
  result.httpOk = true;
  result.wsUrl = version.webSocketDebuggerUrl || result.wsUrl;
  const client = new CdpClient(result.wsUrl, Math.min(options.timeoutMs, 5000));
  await client.connect();
  const browserVersion = await client.send("Browser.getVersion");
  client.close();
  result.websocketOk = true;
  result.browser = browserVersion.product || version.Browser;
  result.ok = true;
  result.port = port;
  return result;
}

async function adoptReachableChrome(state, options, result) {
  const candidates = [];
  if (state.port) candidates.push({ pid: state.pid, port: Number(state.port) });
  const live = await findLiveChromeForProfile(state.profileDir);
  if (live && !candidates.some((candidate) => candidate.port === live.port)) {
    candidates.push(live);
  }
  for (const candidate of candidates) {
    try {
      await probeCdpPort(candidate.port, options, result);
      const listenerPid = (await pidListeningOnPort(candidate.port)) || live?.pid || candidate.pid;
      if (listenerPid && pidAlive(Number(listenerPid))) {
        result.pidAlive = true;
        result.pid = Number(listenerPid);
        result.adoptedPid = Number(listenerPid);
        result.adoptedPort = Number(candidate.port);
      }
      if (result.ok) {
        result.error = null;
        return result;
      }
    } catch (error) {
      result.error = error.message;
      result.ok = false;
      result.httpOk = false;
      result.websocketOk = false;
    }
  }
  return null;
}

async function checkHealth(state, options) {
  const result = {
    ok: false,
    lane: state?.lane,
    pid: state?.pid,
    port: state?.port,
    profileDir: state?.profileDir,
    wsUrl: state?.wsUrl,
    pidAlive: false,
    httpOk: false,
    websocketOk: false,
    error: null,
  };
  if (!state) {
    result.error = "No state file";
    return result;
  }
  result.pidAlive = pidAlive(Number(state.pid));
  if (!result.pidAlive) {
    const adopted = await adoptReachableChrome(state, options, result);
    if (adopted) return adopted;
    result.error = result.error || `PID is not alive: ${state.pid}`;
    return result;
  }
  try {
    return await probeCdpPort(state.port, options, result);
  } catch (error) {
    const adopted = await adoptReachableChrome(state, options, result);
    if (adopted) return adopted;
    result.error = error.message;
    return result;
  }
}

function chromeArgs({ profileDir, port, options, launchOptions = {} }) {
  const args = [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--remote-allow-origins=*",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
  ];
  if (options.headless) args.push("--headless=new", "--disable-gpu");
  if (options.stealth) args.push("--disable-blink-features=AutomationControlled");
  if (Array.isArray(options.networkArgs)) args.push(...options.networkArgs);
  if (launchOptions.proxy) {
    args.push(`--proxy-server=${launchOptions.proxy}`);
    // Never let WebRTC leak the real local IP when the profile routes via a proxy.
    args.push(`--force-webrtc-ip-handling-policy=${launchOptions.webrtcPolicy || "disable_non_proxied_udp"}`);
  }
  if (launchOptions.userAgent) args.push(`--user-agent=${launchOptions.userAgent}`);
  if (launchOptions.lang) args.push(`--lang=${launchOptions.lang}`);
  if (launchOptions.windowSize) args.push(`--window-size=${launchOptions.windowSize}`);
  if (Array.isArray(launchOptions.extraChromeArgs)) args.push(...launchOptions.extraChromeArgs);
  // Chrome 151+ binds --remote-debugging-port only after the first
  // window exists. parkBlankTab needs CDP, so it cannot create that window.
  // Headed launches must put a real startup URL on the argv.
  if (!options.headless) {
    const hasStartupUrl = args.some((arg) => arg && !String(arg).startsWith("--"));
    if (!hasStartupUrl) {
      if (!args.includes("--new-window")) args.push("--new-window");
      args.push("about:blank");
    }
  }
  return args;
}

function macAppBundleForExecutable(executable) {
  const match = String(executable || "").match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/);
  return match ? match[1] : null;
}

function loadDaemonConfig() {
  try {
    const raw = fs.readFileSync(DAEMON_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * Resolve the Chrome binary without moving or rewriting user-data.
 * --chrome > CDP_BROWSER_CHROME > config.json chromePath > previous launch > built-in stable.
 * Config/env must beat registry state so a binary change is not undone by recover.
 */
function resolveChromePath(options = {}, previousState = null, launchOptions = {}) {
  if (options.chromePathFromCli && options.chromePath) return options.chromePath;
  const fromLaunch = launchOptions?.chromePath;
  if (typeof fromLaunch === "string" && fromLaunch.trim()) return expandHome(fromLaunch.trim());
  const fromEnv = process.env.CDP_BROWSER_CHROME;
  if (fromEnv && String(fromEnv).trim()) return expandHome(String(fromEnv).trim());
  const fromConfig = loadDaemonConfig().chromePath;
  if (typeof fromConfig === "string" && fromConfig.trim()) return expandHome(fromConfig.trim());
  if (options.chromePath) return options.chromePath;
  if (previousState?.chromePath) return previousState.chromePath;
  return BUILTIN_CHROME_PATH;
}

/**
 * Build extra Chrome network args from the daemon config. Hosts listed in
 * forceIpv4Hosts are resolved to their first A record at launch and pinned via
 * --host-resolver-rules. This works around networks where the IPv6 path to a
 * host is broken (TCP connects, TLS/transfer stalls) — Chrome's Happy Eyeballs
 * only falls back on connect failure, so a half-broken v6 route otherwise
 * yields empty resource bodies and blank SPA shells. Pins refresh on every
 * browser (re)launch; a lane restart is the remedy for a rotated CDN IP.
 */
async function buildNetworkArgs() {
  const config = loadDaemonConfig();
  const args = [];
  if (Array.isArray(config.extraChromeArgs)) {
    args.push(...config.extraChromeArgs.filter((a) => typeof a === "string" && a.startsWith("--")));
  }
  const envHosts = (process.env.CDP_BROWSER_FORCE_IPV4_HOSTS || "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const hosts = [...new Set([...(config.forceIpv4Hosts || []), ...envHosts])].filter(
    (h) => typeof h === "string" && /^[a-z0-9.*-]+$/i.test(h),
  );
  if (!hosts.length) return args;
  const rules = [];
  for (const host of hosts) {
    // Wildcard patterns need a concrete host to resolve; "*.example.com" uses example.com.
    const lookupHost = host.replace(/^\*\./, "");
    try {
      const addrs = await Promise.race([
        dns.resolve4(lookupHost),
        new Promise((_, reject) => setTimeout(() => reject(new Error("dns timeout")), 4000)),
      ]);
      if (addrs && addrs.length) {
        const ip = String(addrs[0]);
        // Clash/mihomo fake-ip (198.18.0.0/15) is not a real A record.
        // Pinning it into headed Chrome without a matching proxy leaves
        // startup/CDN fetches black-holed.
        if (/^198\.1[89]\./.test(ip)) {
          process.stderr.write(`force-ipv4: skipping ${host} (fake-ip ${ip})\n`);
          continue;
        }
        rules.push(`MAP ${host} ${ip}`);
      }
    } catch (error) {
      process.stderr.write(`force-ipv4: skipping ${host} (${error.message})\n`);
    }
  }
  if (rules.length) args.push(`--host-resolver-rules=${rules.join(",")}`);
  return args;
}

async function killChromeForProfile(profileDir) {
  // Kill only Chrome *main* processes for this user-data-dir. pgrep -f also
  // matches Helpers; killing those first can leave a zombie main process that
  // still owns SingletonLock, so the next launch hands off and START_FAILED.
  const pids = (await listChromeMainPids(profileDir)).map(String);
  if (!pids.length) {
    await clearStaleSingletonLocks(profileDir);
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
      console.error(`cdp-browser-daemon: killing Chrome pid ${pid} for ${profileDir}`);
    } catch (error) {
      /* already gone */
    }
  }
  for (let i = 0; i < 8 && pids.length; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const { stdout: alive } = await execFileP("/bin/ps", ["-o", "pid=", "-p", pids.join(",")]);
    const aliveSet = new Set(alive.trim().split(/\s+/).filter(Boolean));
    if (!aliveSet.size) break;
    const remaining = pids.filter((pid) => aliveSet.has(pid));
    for (const pid of remaining) {
      try {
        process.kill(Number(pid), "SIGKILL");
        console.error(`cdp-browser-daemon: SIGKILL Chrome pid ${pid} for ${profileDir}`);
      } catch (error) { /* gone */ }
    }
    pids.splice(0, pids.length, ...remaining.filter((pid) => aliveSet.has(pid)));
  }
  await new Promise((r) => setTimeout(r, 800));
  await clearStaleSingletonLocks(profileDir);
}

async function killOrphansForProfile(profileDir, keepPid) {
  // Backward-compatible wrapper: kill all except the tracked PID.
  const marker = `user-data-dir=${profileDir}`;
  const { err, stdout } = await execFileP("/usr/bin/pgrep", ["-f", marker]);
  if (err || !stdout.trim()) return;
  const keep = new Set(keepPid ? [String(keepPid)] : []);
  const orphans = stdout.trim().split(/\s+/).filter((pid) => pid && !keep.has(pid));
  if (!orphans.length) return;
  await killChromeForProfile(profileDir);
}

async function persistLaunchedChrome({
  entry,
  options,
  previousState,
  effectiveOptions,
  launchOptions,
  port,
  version,
  chromePid,
}) {
  const now = new Date().toISOString();
  const state = {
    key: entry.key,
    lane: safeLaneName(options.lane),
    profileId: safeLaneName(options.profileId || options.lane),
    pid: chromePid,
    port,
    wsUrl: version.webSocketDebuggerUrl,
    httpUrl: `http://127.0.0.1:${port}`,
    profileDir: entry.profileDir,
    chromePath: effectiveOptions.chromePath,
    headless: effectiveOptions.headless,
    stealth: effectiveOptions.stealth,
    launchOptions,
    startedAt: now,
    updatedAt: now,
    lastTabs: previousState?.lastTabs || [],
  };
  await writeState(entry, state);
  if (!effectiveOptions.headless && loadDaemonConfig().parkBlankTab !== false) {
    try {
      await createTarget(state, "about:blank", options);
    } catch (_) {
      // Best-effort: a failed blank tab must not fail the launch.
    }
  }
  return state;
}

async function launchChrome(entry, options, previousState = null) {
  await fsp.mkdir(entry.profileDir, { recursive: true });
  const launchOptions = await loadLaunchOptions(entry.profileDir);
  const effectiveOptions = {
    ...options,
    headless: options.headless ?? Boolean(previousState?.headless),
    stealth: options.stealth ?? Boolean(previousState?.stealth),
    chromePath: resolveChromePath(options, previousState, launchOptions),
  };

  if (!(await pathExists(effectiveOptions.chromePath))) {
    throw new DaemonError(`Chrome executable not found: ${effectiveOptions.chromePath}`, "CHROME_NOT_FOUND");
  }

  await killChromeForProfile(entry.profileDir);
  const networkArgs = await buildNetworkArgs();
  let preferredPort = options.port || previousState?.port || null;
  let lastError = null;
  const maxAttempts = options.port ? 1 : 3;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // Kill any Chrome still alive for this profile (from a previous attempt or a
    // prior run): a live instance holds the SingletonLock and new launches hand
    // off to it, so waitForVersion on our own port would never succeed.
    await killChromeForProfile(entry.profileDir);
    const port = preferredPort || (await findFreePort());
    const args = chromeArgs({
      profileDir: entry.profileDir,
      port,
      options: { ...effectiveOptions, networkArgs },
      launchOptions,
    });
    let proc = null;
    let stderr = "";

    try {
      const appBundle =
        process.platform === "darwin" && !effectiveOptions.headless
          ? macAppBundleForExecutable(effectiveOptions.chromePath)
          : null;
      if (appBundle) {
        // Prefer LaunchServices so a background LaunchAgent is not the TCC
        // responsible process. If Chrome 151+ still never binds CDP
        // (windowless or fopen stall), fall back to a detached spawn of
        // the same argv.
        // Do not pass open -g: that starts the app unactivated and windowless.
        const launched = await execFileP(
          "/usr/bin/open",
          ["-n", "-a", appBundle, "--args", ...args],
          { timeout: 10000 },
        );
        stderr = String(launched.stderr || "");
        if (launched.err) {
          throw new DaemonError(`LaunchServices could not start Chrome: ${stderr || launched.err.message}`, "START_FAILED");
        }
        try {
          const version = await waitForVersion(port, Math.min(options.timeoutMs || DEFAULT_TIMEOUT_MS, 8000));
          proc = null;
          const liveChrome = await findLiveChromeForProfile(entry.profileDir);
          const chromePid = liveChrome?.pid;
          if (!chromePid) {
            throw new DaemonError("Chrome CDP started but its profile process could not be identified", "START_FAILED");
          }
          return await persistLaunchedChrome({
            entry,
            options,
            previousState,
            effectiveOptions,
            launchOptions,
            port,
            version,
            chromePid,
          });
        } catch (lsError) {
          lastError = lsError;
          console.error(`cdp-browser-daemon: LaunchServices CDP not ready (${lsError.message}); falling back to spawn`);
          await killChromeForProfile(entry.profileDir);
        }
      }
      proc = spawn(effectiveOptions.chromePath, args, {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      proc.unref();
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > 20000) stderr = stderr.slice(-20000);
      });

      const version = await waitForVersion(port, options.timeoutMs);
      if (proc?.stderr) proc.stderr.destroy();
      const liveChrome = await findLiveChromeForProfile(entry.profileDir);
      const chromePid = liveChrome?.pid || proc?.pid;
      if (!chromePid) {
        throw new DaemonError("Chrome CDP started but its profile process could not be identified", "START_FAILED");
      }
      return persistLaunchedChrome({
        entry,
        options,
        previousState,
        effectiveOptions,
        launchOptions,
        port,
        version,
        chromePid,
      });
    } catch (error) {
      lastError = error;
      if (proc?.pid) await killPid(proc.pid, 1500);
      // A handed-off or exiting Chrome can remain as "(Google Chrome)" / STAT Es
      // and keep SingletonLock. Clear the profile before the next port attempt.
      await killChromeForProfile(entry.profileDir);
      if (options.port) break;
      preferredPort = null;
      if (stderr.includes("DevToolsActivePort") || stderr.includes("Address already in use")) {
        continue;
      }
    }
  }

  throw new DaemonError(`Failed to launch Chrome: ${lastError ? lastError.message : "unknown error"}`, "START_FAILED");
}

async function killPid(pid, graceMs = 3000) {
  if (!pidAlive(Number(pid))) return;
  const signals = ["SIGTERM", "SIGKILL"];
  for (const signal of signals) {
    try {
      if (process.platform !== "win32") process.kill(-Number(pid), signal);
      else process.kill(Number(pid), signal);
    } catch (_) {
      try {
        process.kill(Number(pid), signal);
      } catch (_) {
        // Process is already gone or not owned by us.
      }
    }
    const start = Date.now();
    while (Date.now() - start < graceMs) {
      if (!pidAlive(Number(pid))) return;
      await sleep(100);
    }
  }
}

async function closeBrowser(state, options) {
  if (!state) return;
  try {
    const wsUrl = await getBrowserWsUrl(state, Math.min(options.timeoutMs, 3000));
    const client = new CdpClient(wsUrl, Math.min(options.timeoutMs, 3000));
    await client.connect();
    await client.send("Browser.close");
    client.close();
    await sleep(800);
  } catch (_) {
    // Fall through to process termination.
  }
  // Never terminate the registry PID blindly. A stale Chrome PID can be
  // reused by an unrelated long-lived process (including browser-mcp itself),
  // and killPid() intentionally signals the whole process group. Re-resolve
  // the profile's current Chrome main process from its user-data-dir instead;
  // this preserves targeted recovery without trusting recycled PID state.
  const profileDir = state.profileDir || resolveProfileDir(options);
  await killChromeForProfile(profileDir);
}

async function ensureStarted(options) {
  const profileDir = resolveProfileDir(options);
  const entry = registryFor(profileDir);
  return withLock(entry, options, async () => {
    await ensureProfileMetadata(profileDir, options);
    const state = await readState(entry);
    if (state) {
      const health = await checkHealth(state, options);
      const wantsPinnedPort =
        Number.isInteger(options.port) && Number(state.port) !== Number(options.port);
      if (health.ok && !wantsPinnedPort) {
        const adopted = await persistAdoptedState(entry, state, health);
        return { ...adopted, wsUrl: health.wsUrl || adopted.wsUrl };
      }
      if (!wantsPinnedPort) {
        const live = await adoptLiveChromeIfReady(entry, state, options);
        if (live) return live;
      }
      const captured = await captureTabs(state, options);
      const nextState = { ...state, lastTabs: captured, updatedAt: new Date().toISOString() };
      await writeState(entry, nextState);
      await closeBrowser(nextState, options);
      return launchChrome(entry, options, nextState);
    }
    const live = await adoptLiveChromeIfReady(entry, null, options);
    if (live) return live;
    return launchChrome(entry, options, null);
  });
}

async function restartLane(options) {
  const profileDir = resolveProfileDir(options);
  const entry = registryFor(profileDir);
  return withLock(entry, options, async () => {
    await ensureProfileMetadata(profileDir, options);
    const state = await readState(entry);
    const captured = await captureTabs(state, options);
    if (state) {
      await writeState(entry, { ...state, lastTabs: captured, updatedAt: new Date().toISOString() });
      await closeBrowser(state, options);
    }
    const restarted = await launchChrome(entry, options, { ...(state || {}), lastTabs: captured });
    if (options.restoreTabs) await restoreTabs(restarted, captured, options);
    return restarted;
  });
}

async function stopLane(options) {
  const profileDir = resolveProfileDir(options);
  const entry = registryFor(profileDir);
  return withLock(entry, options, async () => {
    const state = await readState(entry);
    if (state) await closeBrowser(state, options);
    await removeState(entry);
    return state ? { stopped: true, lane: state.lane, pid: state.pid, port: state.port } : { stopped: false };
  });
}

async function restoreTabs(state, tabs, options) {
  if (!tabs || tabs.length === 0) return;
  let current = [];
  try {
    current = restorableTabs(normalizeTabs(await listTargetsByPort(state.port, Math.min(options.timeoutMs, 5000))));
  } catch (_) {
    current = [];
  }
  const existing = new Set(current.map((tab) => tab.url));
  for (const tab of tabs) {
    if (!tab.url || existing.has(tab.url)) continue;
    try {
      await createTarget(state, tab.url, options);
      existing.add(tab.url);
    } catch (_) {
      // Restoration is best effort.
    }
  }
}

async function readAllStates() {
  await fsp.mkdir(REGISTRY_ROOT, { recursive: true });
  const names = await fsp.readdir(REGISTRY_ROOT, { withFileTypes: true });
  const states = [];
  for (const dirent of names) {
    if (!dirent.isDirectory() || dirent.name.endsWith(".lock")) continue;
    const state = await readJson(path.join(REGISTRY_ROOT, dirent.name, "state.json"));
    if (state) states.push(state);
  }
  return states;
}

async function readAllProfiles(options) {
  await fsp.mkdir(PROFILE_ROOT, { recursive: true });
  const states = await readAllStates();
  const stateByProfile = new Map(states.map((state) => [path.resolve(state.profileDir), state]));
  const entries = await fsp.readdir(PROFILE_ROOT, { withFileTypes: true });
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profileDir = path.join(PROFILE_ROOT, entry.name, "user-data");
    if (!(await pathExists(profileDir))) continue;
    const metadata = (await readJson(path.join(PROFILE_ROOT, entry.name, "profile.json"))) || {};
    const state = stateByProfile.get(path.resolve(profileDir)) || null;
    const health = state ? await checkHealth(state, options) : null;
    profiles.push({
      id: metadata.id || state?.profileId || state?.lane || entry.name,
      label: metadata.label || null,
      profileDir,
      running: Boolean(health?.ok),
      pid: state?.pid || null,
      port: state?.port || null,
      health: health ? { ok: health.ok, error: health.error } : null,
      createdAt: metadata.createdAt || null,
      updatedAt: metadata.updatedAt || state?.updatedAt || null,
    });
  }
  profiles.sort((a, b) => a.id.localeCompare(b.id));
  return { profileRoot: PROFILE_ROOT, profiles };
}

async function forEachState(options, callback) {
  const states = await readAllStates();
  const results = [];
  for (const state of states) {
    const laneOptions = {
      ...options,
      lane: state.lane || options.lane,
      profileId: state.profileId || state.lane || options.profileId,
      profileDir: state.profileDir,
      port: undefined,
    };
    results.push(await callback(state, laneOptions));
  }
  return results;
}

async function withBrowserClient(state, options, fn) {
  const wsUrl = await getBrowserWsUrl(state, options.timeoutMs);
  const client = new CdpClient(wsUrl, options.timeoutMs);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

// Target.createTarget activates the tab (and therefore raises Chrome and steals
// the user's focus) unless `background: true` is passed. Automation lanes that
// must never interrupt the user opt in with `--background`; everything else keeps
// the historical foreground behavior.
function createTargetParams(url, options = {}) {
  return options.background ? { url, background: true } : { url };
}

async function createTarget(state, url, options) {
  return withBrowserClient(state, options, async (client) =>
    client.send("Target.createTarget", createTargetParams(url, options))
  );
}

async function getPageTargets(state, options) {
  const targets = normalizeTabs(await listTargetsByPort(state.port, options.timeoutMs));
  if (targets.length === 0) throw new DaemonError("No page targets are available", "NO_TARGET");
  return targets;
}

function targetMatches(target, selector, index) {
  if (!selector || selector === "active") return index === 0;
  if (/^\d+$/.test(selector)) return index === Number(selector) - 1;
  return (
    target.id === selector ||
    target.url.includes(selector) ||
    target.title.includes(selector)
  );
}

async function selectTarget(state, options) {
  const targets = await getPageTargets(state, options);
  const selector = options.target || "active";
  const target = targets.find((candidate, index) => targetMatches(candidate, selector, index));
  if (!target) {
    throw new DaemonError(`No page target matched ${selector}`, "NO_TARGET");
  }
  if (!target.webSocketDebuggerUrl) {
    target.webSocketDebuggerUrl = `ws://127.0.0.1:${state.port}/devtools/page/${target.id}`;
  }
  return target;
}

async function withPageClient(state, options, fn) {
  const target = await selectTarget(state, options);
  const client = new CdpClient(target.webSocketDebuggerUrl, options.timeoutMs);
  await client.connect();
  try {
    return await fn(client, target);
  } finally {
    client.close();
  }
}

function mapStaleElementEval(error) {
  if (error instanceof DaemonError && error.code === "EVALUATION" && /Element not found/i.test(error.message)) {
    return new DaemonError(
      "Element ref is stale; take a new snapshot before clicking or typing.",
      "REF_STALE",
    );
  }
  return error;
}

async function runtimeEval(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new DaemonError(`Evaluation failed: ${JSON.stringify(result.exceptionDetails)}`, "EVALUATION");
  }
  return result.result ? result.result.value : undefined;
}

function snapshotExpression() {
  return `(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style && style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const label = (el) => {
      const aria = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || "";
      const text = (el.innerText || el.value || el.textContent || "").replace(/\\s+/g, " ").trim();
      return (aria || text || el.href || el.name || el.id || el.tagName.toLowerCase()).slice(0, 160);
    };
    const cssPath = (el) => {
      const parts = [];
      while (el && el.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
        let part = el.tagName.toLowerCase();
        if (el.id) {
          part += "#" + CSS.escape(el.id);
          parts.unshift(part);
          break;
        }
        const cls = Array.from(el.classList || []).slice(0, 2).map((c) => "." + CSS.escape(c)).join("");
        part += cls;
        const parent = el.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((x) => x.tagName === el.tagName);
          if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(el) + 1) + ")";
        }
        parts.unshift(part);
        el = parent;
      }
      return parts.join(" > ");
    };
    const nodes = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true],summary"))
      .filter(visible)
      .slice(0, 200)
      .map((el, i) => ({
        ref: "r" + (i + 1),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        text: label(el),
        href: el.href || "",
        selector: cssPath(el)
      }));
    return {
      title: document.title,
      url: location.href,
      text: (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").trim().slice(0, 8000),
      elements: nodes
    };
  })()`;
}

function actionElementExpression(refOrSelector, action, text = "") {
  const refJson = JSON.stringify(refOrSelector);
  const actionJson = JSON.stringify(action);
  const textJson = JSON.stringify(text);
  return `(() => {
    const refOrSelector = ${refJson};
    const action = ${actionJson};
    const text = ${textJson};
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style && style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const candidates = () => Array.from(document.querySelectorAll("a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true],summary")).filter(visible);
    let el = null;
    const match = /^r(\\d+)$/i.exec(refOrSelector);
    if (match) el = candidates()[Number(match[1]) - 1] || null;
    if (!el) el = document.querySelector(refOrSelector);
    if (!el) throw new Error("Element not found: " + refOrSelector);
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus({ preventScroll: true });
    if (action === "click") {
      el.click();
    } else if (action === "type") {
      if ("value" in el) {
        // React-compatible setter: direct el.value = text is reverted by React's
        // value tracker on controlled inputs, silently breaking forms.
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        document.execCommand("insertText", false, text);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
    }
    return {
      ok: true,
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160),
      url: location.href
    };
  })()`;
}

function evaluateExpression(fnSource) {
  const trimmed = String(fnSource || "").trim();
  if (!trimmed) throw new DaemonError("evaluate requires --fn", "ARGUMENT");
  if (
    trimmed.startsWith("function") ||
    trimmed.startsWith("async function") ||
    trimmed.startsWith("(") ||
    trimmed.includes("=>")
  ) {
    return `(${trimmed})()`;
  }
  return trimmed;
}

async function updateKnownTabs(state, options) {
  try {
    const entry = registryFor(state.profileDir);
    const tabs = restorableTabs(normalizeTabs(await listTargetsByPort(state.port, Math.min(options.timeoutMs, 5000))));
    await writeState(entry, { ...state, lastTabs: tabs, updatedAt: new Date().toISOString() });
  } catch (_) {
    // Non-critical.
  }
}

async function runActionWithRecovery(options, action) {
  let lastError = null;
  const attempts = options.retries + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await ensureStarted(options);
    try {
      const result = await action(state);
      await updateKnownTabs(state, options);
      return result;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts - 1 || !isRecoverable(error)) break;
      await restartLane(options);
    }
  }
  throw lastError;
}

function isRecoverable(error) {
  return (
    error instanceof DaemonError &&
    ["CDP_TIMEOUT", "CDP_SOCKET", "CDP_CLOSED", "HTTP_TIMEOUT", "START_TIMEOUT"].includes(error.code)
  );
}

function printResult(result, options) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (Array.isArray(result)) {
    for (const item of result) console.log(formatHuman(item));
    return;
  }
  console.log(formatHuman(result));
}

function formatHuman(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if (value.snapshot) {
    const lines = [
      `title: ${value.title}`,
      `url: ${value.url}`,
      "",
      "elements:",
      ...value.elements.map((el) => `  ${el.ref} ${el.tag}${el.role ? `[${el.role}]` : ""}: ${el.text}${el.href ? ` <${el.href}>` : ""}`),
      "",
      "text:",
      value.text || "",
    ];
    return lines.join("\n");
  }
  if (value.tabs) {
    return value.tabs
      .map((tab, index) => `${index + 1}. ${tab.title || "(untitled)"}\n   id: ${tab.id}\n   url: ${tab.url}`)
      .join("\n");
  }
  return Object.entries(value)
    .map(([key, val]) => `${key}: ${typeof val === "object" ? JSON.stringify(val) : val}`)
    .join("\n");
}

async function commandStatus(options) {
  if (options.all) {
    return forEachState(options, async (state) => ({ state, health: await checkHealth(state, options) }));
  }
  const entry = registryFor(resolveProfileDir(options));
  return withLock(entry, options, async () => {
    const state = await readState(entry);
    const launchOptions = await loadLaunchOptions(entry.profileDir);
    const health = await checkHealth(state, options);
    const nextState = await persistAdoptedState(entry, state, health);
    return { state: nextState, health, launchOptions };
  });
}

async function commandProfiles(options) {
  return readAllProfiles(options);
}

async function commandHealth(options) {
  const entry = registryFor(resolveProfileDir(options));
  const state = await readState(entry);
  const health = await checkHealth(state, options);
  if (!health.ok && options.restartOnFail) {
    const restarted = await restartLane(options);
    return { before: health, restarted, after: await checkHealth(restarted, options) };
  }
  await persistAdoptedState(entry, state, health);
  return health;
}

async function commandTabs(options) {
  return runActionWithRecovery(options, async (state) => {
    const tabs = normalizeTabs(await listTargetsByPort(state.port, options.timeoutMs));
    return { lane: state.lane, port: state.port, tabs };
  });
}

async function commandOpen(options, positionals) {
  const url = positionals[0];
  if (!url) throw new DaemonError("open requires a URL", "ARGUMENT");
  return runActionWithRecovery(options, async (state) => {
    const launchOptions = await loadLaunchOptions(resolveProfileDir(options));
    const created = launchOptions.initScript
      ? await createTargetWithInitScript(state, url, launchOptions.initScript, options)
      : await createTarget(state, url, options);
    return { lane: state.lane, port: state.port, targetId: created.targetId, url };
  });
}

/**
 * Create a tab with a per-profile init script installed before first navigation.
 * Used for stealth/fingerprint overrides (navigator.webdriver, canvas, UA checks)
 * that must be present on every page load of the profile.
 */
async function waitForPageLoaded(pageClient, timeoutMs = 12000) {
  // Keep the CDP session alive until the target document reaches complete so a
  // Page.addScriptToEvaluateOnNewDocument registration stays active for this
  // load (closing the session unregisters the script). Tolerates the
  // execution-context churn of mid-navigation and WAF challenge reloads.
  const deadline = Date.now() + timeoutMs;
  await new Promise((r) => setTimeout(r, 600));
  while (Date.now() < deadline) {
    try {
      const { result } = await pageClient.send("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      if (result && result.value === "complete") {
        // The acw WAF challenge marks its tiny page complete, then reloads to
        // the real URL a second or two later; hold the session through that
        // window so the reloaded document still carries the init script.
        await new Promise((r) => setTimeout(r, 5000));
        return;
      }
    } catch (_) {
      // context destroyed mid-navigation; keep polling
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function createTargetWithInitScript(state, url, initScript, options) {
  return withBrowserClient(state, options, async (client) => {
    // Load the URL first, then register the init script and re-navigate so the
    // script runs on a committed document (registering on an uncommitted
    // about:blank can be silently dropped). Keep the session open until the
    // load finishes: closing it unregisters the script.
    const created = await client.send("Target.createTarget", createTargetParams(url, options));
    const targetId = created.targetId;
    const wsUrl = `ws://127.0.0.1:${state.port}/devtools/page/${targetId}`;
    const pageClient = new CdpClient(wsUrl, options.timeoutMs);
    await pageClient.connect();
    try {
      await pageClient.send("Page.enable");
      await pageClient.send("Page.addScriptToEvaluateOnNewDocument", { source: initScript });
      await new Promise((r) => setTimeout(r, 400));
      await pageClient.send("Page.navigate", { url });
      await waitForPageLoaded(pageClient, options.timeoutMs);
    } finally {
      pageClient.close();
    }
    return { targetId };
  });
}

async function commandLaunchOptions(options) {
  const profileDir = resolveProfileDir(options);
  await fsp.mkdir(path.dirname(profileDir), { recursive: true });
  const profileId = safeLaneName(options.profileId || options.lane);
  if (options.clear) {
    const launchOptions = await saveLaunchOptions(profileDir, {});
    return { profileId, launchOptions };
  }
  if (options.set !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(options.set);
    } catch (error) {
      throw new DaemonError(`--set requires a valid JSON object: ${error.message}`, "ARGUMENT");
    }
    const launchOptions = await saveLaunchOptions(profileDir, parsed);
    return { profileId, launchOptions };
  }
  const launchOptions = await loadLaunchOptions(profileDir);
  return { profileId, launchOptions };
}

async function commandNavigate(options, positionals) {
  const url = positionals[0];
  if (!url) throw new DaemonError("navigate requires a URL", "ARGUMENT");
  return runActionWithRecovery(options, async (state) =>
    withPageClient(state, options, async (client, target) => {
      const launchOptions = await loadLaunchOptions(resolveProfileDir(options));
      if (launchOptions.initScript) {
        // Re-register: Page.addScriptToEvaluateOnNewDocument registrations die
        // with the CDP session that created them (daemon is per-command).
        await client.send("Page.enable");
        await client.send("Page.addScriptToEvaluateOnNewDocument", { source: launchOptions.initScript });
      } else {
        await client.send("Page.enable");
      }
      const result = await client.send("Page.navigate", { url });
      if (launchOptions.initScript) await waitForPageLoaded(client, options.timeoutMs);
      return { lane: state.lane, targetId: target.id, frameId: result.frameId, url };
    }),
  );
}

async function commandWait(options) {
  const wanted = options.load === "interactive" ? "interactive" : "complete";
  return runActionWithRecovery(options, async (state) =>
    withPageClient(state, options, async (client, target) => {
      const start = Date.now();
      while (Date.now() - start < options.timeoutMs) {
        const readyState = await runtimeEval(client, "document.readyState");
        if (readyState === "complete" || (wanted === "interactive" && readyState === "interactive")) {
          return { lane: state.lane, targetId: target.id, readyState, waitedMs: Date.now() - start };
        }
        await sleep(250);
      }
      throw new DaemonError(`Timed out waiting for document.readyState=${wanted}`, "CDP_TIMEOUT");
    }),
  );
}

async function commandSnapshot(options) {
  return runActionWithRecovery(options, async (state) =>
    withPageClient(state, options, async (client) => {
      const snapshot = await runtimeEval(client, snapshotExpression());
      return { snapshot: true, ...snapshot };
    }),
  );
}

async function commandClick(options, positionals) {
  const ref = positionals[0];
  if (!ref) throw new DaemonError("click requires a ref or CSS selector", "ARGUMENT");
  return runActionWithRecovery(options, async (state) =>
    withPageClient(state, options, async (client, target) => {
      try {
        const result = await runtimeEval(client, actionElementExpression(ref, "click"));
        return { lane: state.lane, targetId: target.id, action: "click", ...result };
      } catch (error) {
        throw mapStaleElementEval(error);
      }
    }),
  );
}

async function commandType(options, positionals) {
  const ref = positionals[0];
  const text = positionals.slice(1).join(" ");
  if (!ref || !text) throw new DaemonError("type requires a ref/selector and text", "ARGUMENT");
  return runActionWithRecovery(options, async (state) =>
    withPageClient(state, options, async (client, target) => {
      try {
        const result = await runtimeEval(client, actionElementExpression(ref, "type", text));
        return { lane: state.lane, targetId: target.id, action: "type", ...result };
      } catch (error) {
        throw mapStaleElementEval(error);
      }
    }),
  );
}

async function commandUpload(options, positionals) {
  const selector = positionals[0];
  const rawFiles = positionals.slice(1);
  if (!selector || rawFiles.length === 0) {
    throw new DaemonError("upload requires a CSS selector and at least one absolute file path", "ARGUMENT");
  }
  const files = [];
  for (const rawFile of rawFiles) {
    const expanded = expandHome(rawFile);
    if (!path.isAbsolute(expanded)) {
      throw new DaemonError("upload file paths must be absolute", "ARGUMENT");
    }
    const realPath = await fsp.realpath(expanded).catch((error) => {
      if (error.code === "ENOENT") {
        throw new DaemonError("upload file does not exist", "FILE_NOT_FOUND");
      }
      throw error;
    });
    const stat = await fsp.stat(realPath);
    if (!stat.isFile()) throw new DaemonError("upload paths must point to regular files", "ARGUMENT");
    files.push(realPath);
  }
  return runActionWithRecovery(options, async (state) =>
    withPageClient(state, options, async (client, target) => {
      await client.send("DOM.enable");
      const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
      const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector });
      if (!nodeId) throw new DaemonError(`File input not found: ${selector}`, "NO_ELEMENT");
      await client.send("DOM.setFileInputFiles", { files, nodeId });
      const url = await runtimeEval(client, "location.href");
      return { lane: state.lane, targetId: target.id, ok: true, fileCount: files.length, url };
    }),
  );
}

async function commandEvaluate(options) {
  if (!options.fn) throw new DaemonError("evaluate requires --fn", "ARGUMENT");
  return runActionWithRecovery(options, async (state) =>
    withPageClient(state, options, async (client, target) => {
      const value = await runtimeEval(client, evaluateExpression(options.fn));
      return { lane: state.lane, targetId: target.id, value };
    }),
  );
}

async function commandScreenshot(options) {
  return runActionWithRecovery(options, async (state) =>
    withPageClient(state, options, async (client, target) => {
      await client.send("Page.enable");
      let captureOptions = { format: "png", fromSurface: true };
      if (options.fullPage) {
        const metrics = await client.send("Page.getLayoutMetrics");
        const size = metrics.cssContentSize || metrics.contentSize;
        captureOptions = {
          ...captureOptions,
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: Math.max(size.width, 1), height: Math.max(size.height, 1), scale: 1 },
        };
      }
      const result = await client.send("Page.captureScreenshot", captureOptions);
      const outputPath =
        options.path ||
        path.join(os.tmpdir(), `cdp-browser-daemon-${state.lane}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      await fsp.writeFile(outputPath, Buffer.from(result.data, "base64"));
      return { lane: state.lane, targetId: target.id, path: outputPath };
    }),
  );
}

async function commandCloseTab(options) {
  return runActionWithRecovery(options, async (state) => {
    const target = await selectTarget(state, options);
    // Never let the page-target count reach zero: on macOS, creating the FIRST
    // window of a windowless app activates it and steals the user's focus, so
    // park a background about:blank in the still-open window before closing
    // the last page. Disable via config {"parkBlankTab": false}.
    if (loadDaemonConfig().parkBlankTab !== false) {
      try {
        const targets = await listTargetsByPort(state.port, options.timeoutMs);
        const pages = targets.filter((t) => t.type === "page");
        if (pages.length <= 1) await createTarget(state, "about:blank", options);
      } catch (_) {
        // Best-effort guard; closing must still work if parking fails.
      }
    }
    await withBrowserClient(state, options, async (client) => client.send("Target.closeTarget", { targetId: target.id }));
    return { lane: state.lane, closed: true, targetId: target.id, url: target.url };
  });
}

async function main(argv) {
  const { command, options, positionals } = parseArgs(argv);
  let result;
  switch (command) {
    case "help":
      console.log(usage());
      return 0;
    case "profiles":
      result = await commandProfiles(options);
      break;
    case "status":
      result = await commandStatus(options);
      break;
    case "start":
      result = await ensureStarted(options);
      break;
    case "health":
      result = await commandHealth(options);
      break;
    case "recover":
      result = await restartLane(options);
      break;
    case "restart":
      result = options.all
        ? await forEachState(options, async (_state, laneOptions) => restartLane(laneOptions))
        : await restartLane(options);
      break;
    case "stop":
      result = options.all
        ? await forEachState(options, async (_state, laneOptions) => stopLane(laneOptions))
        : await stopLane(options);
      break;
    case "launch-options":
      result = await commandLaunchOptions(options);
      break;
    case "tabs":
    case "list":
      result = await commandTabs(options);
      break;
    case "open":
      result = await commandOpen(options, positionals);
      break;
    case "navigate":
      result = await commandNavigate(options, positionals);
      break;
    case "wait":
      result = await commandWait(options);
      break;
    case "snapshot":
      result = await commandSnapshot(options);
      break;
    case "click":
      result = await commandClick(options, positionals);
      break;
    case "type":
      result = await commandType(options, positionals);
      break;
    case "upload":
      result = await commandUpload(options, positionals);
      break;
    case "evaluate":
      result = await commandEvaluate(options);
      break;
    case "screenshot":
      result = await commandScreenshot(options);
      break;
    case "close-tab":
    case "close":
      result = await commandCloseTab(options);
      break;
    default:
      throw new DaemonError(`Unknown command: ${command}\n\n${usage()}`, "ARGUMENT");
  }
  printResult(result, options);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    if (error instanceof DaemonError) {
      console.error(`cdp-browser-daemon error [${error.code}]: ${error.message}`);
      process.exit(1);
    }
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
} else {
  module.exports = {
    chromeArgs,
    isChromeMainCommand,
    macAppBundleForExecutable,
    parseRemoteDebuggingPort,
    parseSingletonLockPid,
    pidIsZombie,
    resolveChromePath,
  };
}
