import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CoordinatorError, OperationCoordinator } from "./coordinator.mjs";
import { TIKTOK_MEDIA_BLOCK_URLS, TikTokMediaGuardian } from "./media-block.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_PROFILE_ID = "cdp-browser-daemon";
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_ID_PATTERN = /^session-[0-9a-f-]{36}$/;
const INVALID_TARGET_CODES = new Set(["NO_TARGET"]);
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_QUEUED = 100;
const DEFAULT_STATUS_TIMEOUT_MS = 10_000;
const DEFAULT_MEDIA_BLOCK_REAPPLY_MS = 15_000;
const DEFAULT_UPLOAD_ROOTS = [path.join(path.sep, "tmp", "openclaw", "uploads")];
const CONFIGURABLE_LAUNCH_KEYS = new Set([
  "proxy",
  "userAgent",
  "lang",
  "windowSize",
  "webrtcPolicy",
  "extraChromeArgs",
  "initScript",
  "chromePath",
]);

export class BrowserServiceError extends Error {
  constructor(message, code = "BROWSER_MCP_ERROR", cause, details = {}) {
    super(message, { cause });
    this.name = "BrowserServiceError";
    this.code = code;
    this.details = details && typeof details === "object" ? details : {};
  }
}

class DaemonInvocationError extends Error {
  constructor(code, cause) {
    super(`Browser daemon command failed (${code}).`, { cause });
    this.name = "DaemonInvocationError";
    this.code = code;
  }
}

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function validateProfileId(profileId) {
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    throw new BrowserServiceError(
      "profile_id must be a stable name using letters, numbers, dots, underscores, or hyphens.",
      "INVALID_PROFILE_ID",
    );
  }
  return profileId;
}

function validateTaskId(taskId) {
  if (taskId !== undefined && !TASK_ID_PATTERN.test(taskId)) {
    throw new BrowserServiceError(
      "task_id must use letters, numbers, dots, underscores, colons, or hyphens.",
      "INVALID_TASK_ID",
    );
  }
  return taskId;
}

function validateSessionId(sessionId) {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new BrowserServiceError("Unknown browser session.", "SESSION_NOT_FOUND");
  }
  return sessionId;
}

function validateUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserServiceError("url must be a valid HTTP, HTTPS, or about:blank URL.", "INVALID_URL");
  }
  if (parsed.href === "about:blank") return parsed.href;
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new BrowserServiceError("url must use HTTP, HTTPS, or exact about:blank.", "INVALID_URL");
  }
  return parsed.toString();
}

function originOf(value) {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

export function sanitizeLastUrl(value) {
  if (!value || typeof value !== "string") return null;
  if (value === "about:blank") return "about:blank";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function tabGoneError(session, cause) {
  return new BrowserServiceError(
    "The tab for this session is gone; call browser_open for a new tab. Do not retry this session_id.",
    "TAB_GONE",
    cause,
    {
      session_id: session.sessionId,
      last_url: sanitizeLastUrl(session.url),
      invalid_reason: session.invalidReason || "target_missing",
    },
  );
}

function sessionFailureError(session) {
  if (session.status === "closed") {
    return new BrowserServiceError(
      "Browser session is closed; open a new session.",
      "SESSION_CLOSED",
      undefined,
      {
        session_id: session.sessionId,
        last_url: sanitizeLastUrl(session.url),
        invalid_reason: "closed",
      },
    );
  }
  if (["target_missing", "target_missing_at_startup"].includes(session.invalidReason)) {
    return tabGoneError(session);
  }
  return new BrowserServiceError(
    "Browser session is invalid; open or claim a new session. Do not retry this session_id.",
    "SESSION_INVALID",
    undefined,
    {
      session_id: session.sessionId,
      last_url: sanitizeLastUrl(session.url),
      invalid_reason: session.invalidReason || session.status,
    },
  );
}

export function publicErrorPayload(error) {
  const err = error instanceof BrowserServiceError ? error : asPublicError(error);
  return {
    error: true,
    code: err.code,
    message: err.message,
    ...err.details,
  };
}

function pathIsWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function publicSession(session) {
  return {
    session_id: session.sessionId,
    task_id: session.taskId ?? null,
    profile_id: session.profileId,
    url: session.url,
    status: session.status,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    expires_at: session.expiresAt ?? null,
    invalid_reason: session.invalidReason ?? null,
    media_block_active: session.mediaBlockActive === true,
    background: session.background === true,
  };
}

function asPublicError(error) {
  if (error instanceof BrowserServiceError) return error;
  if (error instanceof CoordinatorError) {
    return new BrowserServiceError(error.message, error.code, error);
  }
  if (error instanceof DaemonInvocationError) {
    if (error.code === "REF_STALE") {
      return new BrowserServiceError(
        "Element ref is stale; take a new snapshot, then click or type the new ref.",
        "REF_STALE",
        error,
      );
    }
    return new BrowserServiceError(
      `Browser daemon could not complete the action (${error.code}).`,
      `DAEMON_${error.code}`,
      error,
    );
  }
  return new BrowserServiceError("Browser action failed.", "BROWSER_ACTION_FAILED", error);
}

async function writePrivateJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(filePath), 0o700);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, 0o600);
}

async function readJsonIfPresent(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new BrowserServiceError(`Could not read ${path.basename(filePath)}.`, "INVALID_STATE_FILE", error);
  }
}

export class BrowserService {
  static async create(options = {}) {
    const service = new BrowserService(options);
    await service.initialize();
    return service;
  }

  constructor(options = {}) {
    this.home = expandHome(options.home || process.env.BROWSER_MCP_HOME || "~/.browser-mcp");
    this.sessionsPath = path.join(this.home, "sessions.json");
    this.routesPath = path.join(this.home, "routes.json");
    this.auditPath = path.join(this.home, "audit.jsonl");
    this.daemonScript = expandHome(
      options.daemonScript ||
        process.env.BROWSER_MCP_DAEMON_SCRIPT ||
        fileURLToPath(new URL("./cdp_browser_daemon.cjs", import.meta.url)),
    );
    this.defaultProfileId = validateProfileId(
      options.defaultProfileId || process.env.BROWSER_MCP_DEFAULT_PROFILE || DEFAULT_PROFILE_ID,
    );
    this.daemonTimeoutMs = options.daemonTimeoutMs ?? 120_000;
    this.statusTimeoutMs = options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? Number(process.env.BROWSER_MCP_SESSION_TTL_MS || DEFAULT_SESSION_TTL_MS);
    this.sessionRetentionMs = options.sessionRetentionMs ?? Number(
      process.env.BROWSER_MCP_SESSION_RETENTION_MS || DEFAULT_SESSION_RETENTION_MS,
    );
    this.queueWaitTimeoutMs = options.queueWaitTimeoutMs ?? Number(
      process.env.BROWSER_MCP_QUEUE_WAIT_TIMEOUT_MS || DEFAULT_QUEUE_WAIT_TIMEOUT_MS,
    );
    this.maxQueued = options.maxQueued ?? Number(process.env.BROWSER_MCP_MAX_QUEUED || DEFAULT_MAX_QUEUED);
    this.mediaBlockReapplyMs = options.mediaBlockReapplyMs ?? Number(
      process.env.BROWSER_MCP_MEDIA_BLOCK_REAPPLY_MS || DEFAULT_MEDIA_BLOCK_REAPPLY_MS,
    );
    this.now = options.now || (() => Date.now());
    for (const [name, value] of Object.entries({
      daemonTimeoutMs: this.daemonTimeoutMs,
      statusTimeoutMs: this.statusTimeoutMs,
      sessionTtlMs: this.sessionTtlMs,
      sessionRetentionMs: this.sessionRetentionMs,
      queueWaitTimeoutMs: this.queueWaitTimeoutMs,
      maxQueued: this.maxQueued,
      mediaBlockReapplyMs: this.mediaBlockReapplyMs,
    })) {
      if (!Number.isInteger(value) || value < 1) {
        throw new BrowserServiceError(`${name} must be a positive integer.`, "INVALID_CONFIGURATION");
      }
    }
    this.daemonEnv = { ...process.env, ...(options.daemonEnv || {}) };
    const configuredUploadRoots =
      options.uploadRoots ||
      process.env.BROWSER_MCP_UPLOAD_ROOTS?.split(path.delimiter).filter(Boolean) ||
      DEFAULT_UPLOAD_ROOTS;
    this.uploadRoots = configuredUploadRoots.map((root) => path.resolve(expandHome(root)));
    this.sessions = new Map();
    this.profileGenerations = new Map();
    this.routes = {};
    this.profileCoordinators = new Map();
    this.sessionCoordinators = new Map();
    this.mediaGuardians = new Map();
    this.mediaGuardianFactory = options.mediaGuardianFactory || ((guardianOptions) =>
      TikTokMediaGuardian.create(guardianOptions));
    this.persistTail = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    await fs.chmod(this.home, 0o700);

    const stored = await readJsonIfPresent(this.sessionsPath, { version: 2, profileGenerations: {}, sessions: [] });
    if (![1, 2].includes(stored.version) || !Array.isArray(stored.sessions)) {
      throw new BrowserServiceError("sessions.json has an unsupported format.", "INVALID_STATE_FILE");
    }
    if (stored.version === 2 && (
      !stored.profileGenerations || Array.isArray(stored.profileGenerations) || typeof stored.profileGenerations !== "object"
    )) {
      throw new BrowserServiceError("sessions.json has invalid profile generations.", "INVALID_STATE_FILE");
    }
    for (const [profileId, generation] of Object.entries(stored.profileGenerations || {})) {
      validateProfileId(profileId);
      if (!Number.isInteger(generation) || generation < 1) {
        throw new BrowserServiceError("sessions.json has an invalid profile generation.", "INVALID_STATE_FILE");
      }
      this.profileGenerations.set(profileId, generation);
    }
    let stateChanged = stored.version === 1;
    const now = this.now();
    for (const session of stored.sessions) {
      if (
        typeof session?.sessionId !== "string" ||
        typeof session?.profileId !== "string" ||
        typeof session?.targetId !== "string" ||
        !new Set(["active", "invalid", "closed"]).has(session?.status) ||
        !Number.isFinite(Date.parse(session?.createdAt)) ||
        !Number.isFinite(Date.parse(session?.updatedAt))
      ) {
        throw new BrowserServiceError("sessions.json contains an invalid session.", "INVALID_STATE_FILE");
      }
      validateProfileId(session.profileId);
      const generation = this.profileGenerations.get(session.profileId) || 1;
      this.profileGenerations.set(session.profileId, generation);
      if (!Number.isInteger(session.profileGeneration)) {
        session.profileGeneration = generation;
        stateChanged = true;
      }
      if (session.status === "active" && session.profileGeneration !== generation) {
        this.invalidateSession(session, "profile_generation_mismatch");
        stateChanged = true;
      }
      if (!session.expiresAt) {
        const updatedAt = Date.parse(session.updatedAt || session.createdAt);
        const ttlBase = session.status === "active" ? now : (Number.isFinite(updatedAt) ? updatedAt : now);
        session.expiresAt = new Date(ttlBase + this.sessionTtlMs).toISOString();
        stateChanged = true;
      }
      if (typeof session.mediaBlockActive !== "boolean") {
        session.mediaBlockActive = false;
        stateChanged = true;
      }
      if (typeof session.background !== "boolean") {
        session.background = false;
        stateChanged = true;
      }
      if (session.status === "active" && Date.parse(session.expiresAt) <= now) {
        this.invalidateSession(session, "ttl_expired");
        stateChanged = true;
      }
      if (
        session.status !== "active" &&
        Number.isFinite(Date.parse(session.updatedAt)) &&
        now - Date.parse(session.updatedAt) > this.sessionRetentionMs
      ) {
        stateChanged = true;
        continue;
      }
      this.sessions.set(session.sessionId, session);
    }

    const routes = await readJsonIfPresent(this.routesPath, {});
    if (!routes || Array.isArray(routes) || typeof routes !== "object") {
      throw new BrowserServiceError("routes.json must be a task-to-profile object.", "INVALID_ROUTES_FILE");
    }
    for (const [taskId, profileId] of Object.entries(routes)) {
      validateTaskId(taskId);
      validateProfileId(profileId);
    }
    this.routes = routes;
    if (await this.validateStoredSessions()) stateChanged = true;
    if (await this.restoreMediaGuardians()) stateChanged = true;
    if (stateChanged) await this.persistSessions();
  }

  resolveProfile(taskId, explicitProfileId) {
    validateTaskId(taskId);
    if (explicitProfileId) return validateProfileId(explicitProfileId);
    if (taskId && this.routes[taskId]) return validateProfileId(this.routes[taskId]);
    return this.defaultProfileId;
  }

  profileGeneration(profileId) {
    return this.profileGenerations.get(profileId) || 1;
  }

  coordinator(map, key, name) {
    let coordinator = map.get(key);
    if (!coordinator) {
      coordinator = new OperationCoordinator({
        name,
        maxQueued: this.maxQueued,
        waitTimeoutMs: this.queueWaitTimeoutMs,
        now: this.now,
      });
      map.set(key, coordinator);
    }
    return coordinator;
  }

  profileCoordinator(profileId) {
    return this.coordinator(this.profileCoordinators, profileId, `profile ${profileId}`);
  }

  sessionCoordinator(sessionId) {
    return this.coordinator(this.sessionCoordinators, sessionId, `session ${sessionId}`);
  }

  operationMetadata(operation, context, details = {}) {
    return {
      operation,
      clientName: context?.clientName || "unknown",
      taskId: details.taskId ?? null,
      sessionId: details.sessionId ?? null,
      queueWaitMs: 0,
    };
  }

  auditDetails(operation, context, details = {}) {
    details.metadata = this.operationMetadata(operation, context, details);
    return details;
  }

  runProfile(profileId, mode, metadata, operation) {
    return this.profileCoordinator(profileId).run(mode, metadata, operation);
  }

  runSession(sessionId, metadata, operation) {
    return this.sessionCoordinator(sessionId).run("exclusive", metadata, operation);
  }

  queueSnapshot(profileId) {
    const profile = this.profileCoordinator(profileId).snapshot();
    const sessionSnapshots = [...this.sessions.values()]
      .filter((session) => session.profileId === profileId)
      .map((session) => this.sessionCoordinators.get(session.sessionId)?.snapshot())
      .filter(Boolean);
    return {
      active: profile.active,
      queued: profile.queued + sessionSnapshots.reduce((sum, snapshot) => sum + snapshot.queued, 0),
      oldest_queued_ms: Math.max(profile.oldest_queued_ms, ...sessionSnapshots.map((item) => item.oldest_queued_ms), 0),
      max_queued_per_queue: this.maxQueued,
      wait_timeout_ms: this.queueWaitTimeoutMs,
    };
  }

  sessionCounts() {
    const counts = { active: 0, invalid: 0, closed: 0, total: 0 };
    for (const session of this.sessions.values()) {
      counts.total += 1;
      if (Object.hasOwn(counts, session.status)) counts[session.status] += 1;
    }
    return counts;
  }

  pruneInactiveSessions() {
    const now = this.now();
    let changed = false;
    for (const [sessionId, session] of this.sessions) {
      if (session.status === "active" && Date.parse(session.expiresAt) <= now) {
        this.invalidateSession(session, "ttl_expired");
        void this.stopMediaGuardian(sessionId);
        changed = true;
      }
      if (
        session.status !== "active" &&
        Number.isFinite(Date.parse(session.updatedAt)) &&
        now - Date.parse(session.updatedAt) > this.sessionRetentionMs
      ) {
        this.sessions.delete(sessionId);
        changed = true;
      }
    }
    return changed;
  }

  async persistSessions() {
    this.pruneInactiveSessions();
    const snapshot = {
      version: 2,
      profileGenerations: Object.fromEntries([...this.profileGenerations.entries()].sort()),
      sessions: [...this.sessions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    };
    const write = this.persistTail
      .catch(() => undefined)
      .then(() => writePrivateJsonAtomic(this.sessionsPath, snapshot));
    this.persistTail = write;
    return write;
  }

  async appendAudit(entry) {
    const line = `${JSON.stringify(entry)}\n`;
    try {
      await fs.appendFile(this.auditPath, line, { mode: 0o600 });
      await fs.chmod(this.auditPath, 0o600);
    } catch (error) {
      console.error(`browser-mcp audit write failed: ${error.message}`);
    }
  }

  async audited(tool, context, details, operation) {
    const startedAt = Date.now();
    try {
      const result = await operation();
      await this.appendAudit({
        timestamp: new Date().toISOString(),
        client_name: context?.clientName || "unknown",
        tool,
        task_id: details.taskId ?? null,
        session_id: details.sessionId ?? null,
        profile_id: details.profileId ?? null,
        origin: details.origin ?? null,
        ...(details.background === undefined ? {} : { background: details.background }),
        result: "ok",
        duration_ms: Date.now() - startedAt,
        queue_wait_ms: details.metadata?.queueWaitMs || 0,
      });
      return result;
    } catch (error) {
      const publicError = asPublicError(error);
      await this.appendAudit({
        timestamp: new Date().toISOString(),
        client_name: context?.clientName || "unknown",
        tool,
        task_id: details.taskId ?? null,
        session_id: details.sessionId ?? null,
        profile_id: details.profileId ?? null,
        origin: details.origin ?? null,
        ...(details.background === undefined ? {} : { background: details.background }),
        result: publicError.code,
        duration_ms: Date.now() - startedAt,
        queue_wait_ms: details.metadata?.queueWaitMs || 0,
        last_url: publicError.details?.last_url ?? null,
        invalid_reason: publicError.details?.invalid_reason ?? null,
        error_detail: String(publicError.message || "").slice(0, 240) || null,
      });
      throw publicError;
    }
  }

  async invokeDaemon(command, profileId, args = [], { timeoutMs = this.daemonTimeoutMs } = {}) {
    const argv = [this.daemonScript, command, "--id", profileId, ...args, "--json"];
    try {
      const { stdout } = await execFileAsync(process.execPath, argv, {
        env: this.daemonEnv,
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
        encoding: "utf8",
      });
      return JSON.parse(stdout);
    } catch (error) {
      const match = String(error.stderr || error.message).match(/error \[([A-Z0-9_]+)\]/);
      const code = match?.[1] || (error.killed ? "TIMEOUT" : "FAILED");
      throw new DaemonInvocationError(code, error);
    }
  }

  requireActiveSession(sessionId) {
    validateSessionId(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) throw new BrowserServiceError("Unknown browser session.", "SESSION_NOT_FOUND");
    if (session.status !== "active") {
      throw sessionFailureError(session);
    }
    if (session.profileGeneration !== this.profileGeneration(session.profileId)) {
      this.invalidateSession(session, "profile_recovered");
      void this.stopMediaGuardian(session.sessionId, { clearNetwork: false });
      void this.persistSessions();
      throw sessionFailureError(session);
    }
    if (Date.parse(session.expiresAt) <= this.now()) {
      this.invalidateSession(session, "ttl_expired");
      void this.stopMediaGuardian(session.sessionId);
      void this.persistSessions();
      throw sessionFailureError(session);
    }
    return session;
  }

  invalidateSession(session, reason) {
    session.status = "invalid";
    session.invalidReason = reason;
    session.mediaBlockActive = false;
    session.updatedAt = new Date(this.now()).toISOString();
  }

  touchSession(session) {
    const now = this.now();
    session.updatedAt = new Date(now).toISOString();
    session.expiresAt = new Date(now + this.sessionTtlMs).toISOString();
  }

  async markInvalid(session, reason = "target_missing") {
    this.invalidateSession(session, reason);
    await this.stopMediaGuardian(session.sessionId, { clearNetwork: false });
    await this.persistSessions();
  }

  async stopMediaGuardian(sessionId, options) {
    const guardian = this.mediaGuardians.get(sessionId);
    if (!guardian) return false;
    this.mediaGuardians.delete(sessionId);
    await guardian.close(options).catch(() => undefined);
    return true;
  }

  async stopProfileMediaGuardians(profileId, options) {
    const sessionIds = [...this.mediaGuardians.keys()].filter(
      (sessionId) => this.sessions.get(sessionId)?.profileId === profileId,
    );
    await Promise.all(sessionIds.map((sessionId) => this.stopMediaGuardian(sessionId, options)));
  }

  async shutdown() {
    await Promise.all([...this.mediaGuardians.keys()].map((sessionId) => this.stopMediaGuardian(sessionId)));
  }

  async restoreMediaGuardians() {
    let changed = false;
    const healthByProfile = new Map();
    for (const session of this.sessions.values()) {
      if (session.status !== "active" || session.mediaBlockActive !== true) continue;
      try {
        let health = healthByProfile.get(session.profileId);
        if (!health) {
          health = await this.invokeDaemon("health", session.profileId, [], { timeoutMs: this.statusTimeoutMs });
          healthByProfile.set(session.profileId, health);
        }
        if (!health.ok || !Number.isInteger(Number(health.port)) || Number(health.port) < 1) {
          throw new Error("profile is not healthy");
        }
        const guardian = await this.mediaGuardianFactory({
          port: Number(health.port),
          targetId: session.targetId,
          reapplyMs: this.mediaBlockReapplyMs,
        });
        this.mediaGuardians.set(session.sessionId, guardian);
      } catch {
        await this.invokeDaemon("close-tab", session.profileId, ["--target", session.targetId], {
          timeoutMs: this.statusTimeoutMs,
        }).catch(() => undefined);
        this.invalidateSession(session, "media_block_restore_failed");
        changed = true;
      }
    }
    return changed;
  }

  async tryExactSessionRebind(session) {
    let result;
    try {
      result = await this.invokeDaemon("tabs", session.profileId, [], { timeoutMs: this.statusTimeoutMs });
    } catch {
      return false;
    }
    const ownedTargetIds = new Set(
      [...this.sessions.values()]
        .filter((item) => item.sessionId !== session.sessionId && item.status === "active")
        .map((item) => item.targetId),
    );
    const matches = (result.tabs || []).filter((tab) =>
      (tab.id || tab.targetId) &&
      !ownedTargetIds.has(tab.id || tab.targetId) &&
      tab.url === session.url
    );
    if (matches.length !== 1) return false;
    const restoreMediaBlock = session.mediaBlockActive === true;
    await this.stopMediaGuardian(session.sessionId, { clearNetwork: false });
    session.targetId = matches[0].id || matches[0].targetId;
    if (restoreMediaBlock) {
      try {
        const health = await this.invokeDaemon("health", session.profileId, [], { timeoutMs: this.statusTimeoutMs });
        if (!health.ok || !Number.isInteger(Number(health.port)) || Number(health.port) < 1) return false;
        const guardian = await this.mediaGuardianFactory({
          port: Number(health.port),
          targetId: session.targetId,
          reapplyMs: this.mediaBlockReapplyMs,
        });
        this.mediaGuardians.set(session.sessionId, guardian);
      } catch {
        await this.invokeDaemon("close-tab", session.profileId, ["--target", session.targetId], {
          timeoutMs: this.statusTimeoutMs,
        }).catch(() => undefined);
        this.invalidateSession(session, "media_block_rebind_failed");
        await this.persistSessions();
        return false;
      }
    }
    this.touchSession(session);
    await this.persistSessions();
    return true;
  }

  async validateStoredSessions() {
    let changed = false;
    const activeByProfile = new Map();
    for (const session of this.sessions.values()) {
      if (session.status !== "active") continue;
      const list = activeByProfile.get(session.profileId) || [];
      list.push(session);
      activeByProfile.set(session.profileId, list);
    }
    await Promise.all([...activeByProfile].map(async ([profileId, sessions]) => {
      let health;
      try {
        health = await this.invokeDaemon("health", profileId, [], { timeoutMs: this.statusTimeoutMs });
      } catch {
        return;
      }
      if (!health.ok) {
        for (const session of sessions) this.invalidateSession(session, "profile_unhealthy_at_startup");
        changed = true;
        return;
      }
      let tabs;
      try {
        tabs = await this.invokeDaemon("tabs", profileId, [], { timeoutMs: this.statusTimeoutMs });
      } catch {
        return;
      }
      const targetIds = new Set((tabs.tabs || []).map((tab) => tab.id || tab.targetId).filter(Boolean));
      for (const session of sessions) {
        if (!targetIds.has(session.targetId)) {
          this.invalidateSession(session, "target_missing_at_startup");
          changed = true;
        }
      }
    }));
    return changed;
  }

  async runSessionAction(sessionId, command, args, transform, metadata) {
    const session = this.requireActiveSession(sessionId);
    metadata ||= this.operationMetadata(command, {}, { taskId: session.taskId, sessionId });
    return this.runSession(sessionId, metadata, () =>
      this.runProfile(session.profileId, "shared", metadata, async () => {
        this.requireActiveSession(sessionId);
        try {
          let result;
          try {
            result = await this.invokeDaemon(command, session.profileId, ["--target", session.targetId, ...args]);
          } catch (error) {
            if (
              error instanceof DaemonInvocationError &&
              INVALID_TARGET_CODES.has(error.code) &&
              await this.tryExactSessionRebind(session)
            ) {
              result = await this.invokeDaemon(command, session.profileId, ["--target", session.targetId, ...args]);
            } else {
              throw error;
            }
          }
          this.touchSession(session);
          if (result.url) session.url = result.url;
          await this.persistSessions();
          return await transform(result, session);
        } catch (error) {
          if (error instanceof DaemonInvocationError && INVALID_TARGET_CODES.has(error.code)) {
            await this.markInvalid(session, "target_missing");
            throw tabGoneError(session, error);
          }
          if (error instanceof DaemonInvocationError && error.code === "REF_STALE") {
            throw new BrowserServiceError(
              "Element ref is stale; take a new snapshot, then click or type the new ref.",
              "REF_STALE",
              error,
              {
                session_id: session.sessionId,
                last_url: sanitizeLastUrl(session.url),
              },
            );
          }
          throw error;
        }
      }),
    );
  }

  async status({ profileId } = {}, context = {}) {
    const selectedProfile = validateProfileId(profileId || this.defaultProfileId);
    const details = { profileId: selectedProfile };
    details.metadata = this.operationMetadata("browser_status", context, details);
    return this.audited(
      "browser_status",
      context,
      details,
      async () => {
        const queue = this.queueSnapshot(selectedProfile);
        let health = {};
        let healthError = null;
        let launchOptions = {};
        let launchOptionsError = null;
        try {
          health = await this.invokeDaemon("health", selectedProfile, [], { timeoutMs: this.statusTimeoutMs });
        } catch (error) {
          healthError = asPublicError(error).code;
        }
        try {
          launchOptions = await this.invokeDaemon("launch-options", selectedProfile, [], {
            timeoutMs: this.statusTimeoutMs,
          });
        } catch (error) {
          launchOptionsError = asPublicError(error).code;
        }
        const sessions = [...this.sessions.values()].filter((item) => item.profileId === selectedProfile);
        return {
          profile_id: selectedProfile,
          healthy: Boolean(health.ok),
          health_error: healthError,
          checks: {
            pid_alive: Boolean(health.pidAlive),
            http_ok: Boolean(health.httpOk),
            browser_ok: Boolean(health.websocketOk),
          },
          launch_options: launchOptions.launchOptions || {},
          launch_options_error: launchOptionsError,
          sessions: {
            active: sessions.filter((item) => item.status === "active").length,
            invalid: sessions.filter((item) => item.status === "invalid").length,
            closed: sessions.filter((item) => item.status === "closed").length,
          },
          queue,
        };
      },
    );
  }

  async recover({ profileId } = {}, context = {}) {
    const selectedProfile = validateProfileId(profileId || this.defaultProfileId);
    const details = { profileId: selectedProfile };
    details.metadata = this.operationMetadata("browser_recover", context, details);
    return this.audited(
      "browser_recover",
      context,
      details,
      () => this.runProfile(selectedProfile, "exclusive", details.metadata, async () => {
        await this.stopProfileMediaGuardians(selectedProfile, { clearNetwork: false });
        const generation = this.profileGeneration(selectedProfile) + 1;
        this.profileGenerations.set(selectedProfile, generation);
        let invalidatedSessions = 0;
        for (const session of this.sessions.values()) {
          if (session.profileId === selectedProfile && session.status === "active") {
            this.invalidateSession(session, "profile_recovered");
            invalidatedSessions += 1;
          }
        }
        await this.persistSessions();
        await this.invokeDaemon("recover", selectedProfile, ["--no-restore-tabs"]);
        const health = await this.invokeDaemon("health", selectedProfile);
        return {
          profile_id: selectedProfile,
          generation,
          invalidated_sessions: invalidatedSessions,
          recovered: Boolean(health.ok),
          healthy: Boolean(health.ok),
          checks: {
            pid_alive: Boolean(health.pidAlive),
            http_ok: Boolean(health.httpOk),
            browser_ok: Boolean(health.websocketOk),
          },
          queue: this.queueSnapshot(selectedProfile),
        };
      }),
    );
  }

  /**
   * Stop the persistent browser for one profile: every tab of that profile's
   * Chrome process is closed and the process is terminated, its MCP sessions
   * are invalidated, and the profile generation is bumped so stale session ids
   * fail closed. Cookies, logins and launch options stay on disk, so the next
   * browser_open restarts the very same profile.
   *
   * Rationale (2026-09-20): browser_close / browser_close_task_sessions only
   * close tabs. Chrome keeps running with zero tabs, so deterministic jobs that
   * use an automation-only profile (the four anyrouter-password* lanes) left one
   * Chrome instance alive after every run — four instances / ~3 GB after two
   * runs a day. Such jobs call browser_stop when they finish.
   */
  async stop({ profileId } = {}, context = {}) {
    const selectedProfile = validateProfileId(profileId || this.defaultProfileId);
    const details = { profileId: selectedProfile };
    details.metadata = this.operationMetadata("browser_stop", context, details);
    return this.audited(
      "browser_stop",
      context,
      details,
      () => this.runProfile(selectedProfile, "exclusive", details.metadata, async () => {
        await this.stopProfileMediaGuardians(selectedProfile, { clearNetwork: false });
        const generation = this.profileGeneration(selectedProfile) + 1;
        this.profileGenerations.set(selectedProfile, generation);
        let invalidatedSessions = 0;
        for (const session of this.sessions.values()) {
          if (session.profileId === selectedProfile && session.status === "active") {
            this.invalidateSession(session, "profile_stopped");
            invalidatedSessions += 1;
          }
        }
        await this.persistSessions();
        const result = await this.invokeDaemon("stop", selectedProfile);
        // Keep daemon internals (pid/port) out of the MCP surface, same as recover.
        const browserRunning = await this.daemonPidAlive(selectedProfile);
        return {
          profile_id: selectedProfile,
          generation,
          invalidated_sessions: invalidatedSessions,
          stopped: result?.stopped !== false,
          browser_running: browserRunning,
        };
      }),
    );
  }

  async daemonPidAlive(profileId) {
    try {
      const health = await this.invokeDaemon("health", profileId, [], { timeoutMs: this.statusTimeoutMs });
      return Boolean(health?.pidAlive);
    } catch {
      return false;
    }
  }

  /**
   * Read or overwrite per-profile Chrome launch options. Pass `options` to set
   * (whole-set overwrite, validated against CONFIGURABLE_LAUNCH_KEYS), `clear`
   * to wipe, or neither to read. Launch options apply at the next browser
   * start; stop/restart the profile to apply changes.
   */
  async configure({ profileId, options, clear = false } = {}, context = {}) {
    const selectedProfile = validateProfileId(profileId || this.defaultProfileId);
    if (!clear && options !== undefined && options !== null) {
      if (typeof options !== "object" || Array.isArray(options)) {
        throw new BrowserServiceError("options must be a JSON object.", "ARGUMENT");
      }
      for (const key of Object.keys(options)) {
        if (!CONFIGURABLE_LAUNCH_KEYS.has(key)) {
          throw new BrowserServiceError(`Unsupported launch option: ${key}`, "ARGUMENT");
        }
      }
    }
    const daemonArgs =
      clear ? ["--clear"] : options !== undefined && options !== null ? ["--set", JSON.stringify(options)] : [];
    const details = { profileId: selectedProfile, clear, hasOptions: options !== undefined && options !== null };
    details.metadata = this.operationMetadata("browser_configure", context, details);
    return this.audited(
      "browser_configure",
      context,
      details,
      () =>
        this.runProfile(selectedProfile, "exclusive", details.metadata, async () => {
          const result = await this.invokeDaemon("launch-options", selectedProfile, daemonArgs);
          return { profile_id: result.profileId, launch_options: result.launchOptions ?? {} };
        }),
    );
  }

  async profileNeedsExclusiveLaunch(profileId) {
    try {
      const health = await this.invokeDaemon("health", profileId, [], { timeoutMs: this.statusTimeoutMs });
      return health?.ok !== true;
    } catch {
      return true;
    }
  }

  async open({ url, taskId, profileId, background } = {}, context = {}) {
    const normalizedUrl = validateUrl(url);
    const backgroundTab = background === true;
    const selectedProfile = this.resolveProfile(taskId, profileId);
    const details = {
      taskId,
      profileId: selectedProfile,
      origin: originOf(normalizedUrl),
      background: backgroundTab,
    };
    details.metadata = this.operationMetadata("browser_open", context, details);
    return this.audited("browser_open", context, details, async () => {
      const mode = (await this.profileNeedsExclusiveLaunch(selectedProfile)) ? "exclusive" : "shared";
      return this.runProfile(selectedProfile, mode, details.metadata, async () => {
        const result = await this.invokeDaemon("open", selectedProfile, [
          normalizedUrl,
          ...(backgroundTab ? ["--background"] : []),
        ]);
        if (typeof result.targetId !== "string") {
          throw new BrowserServiceError("Browser daemon did not return a tab.", "INVALID_DAEMON_RESPONSE");
        }
        const nowMs = this.now();
        const now = new Date(nowMs).toISOString();
        if (!this.profileGenerations.has(selectedProfile)) this.profileGenerations.set(selectedProfile, 1);
        const session = {
          sessionId: `session-${randomUUID()}`,
          taskId: taskId ?? null,
          profileId: selectedProfile,
          targetId: result.targetId,
          profileGeneration: this.profileGeneration(selectedProfile),
          url: result.url || normalizedUrl,
          status: "active",
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(nowMs + this.sessionTtlMs).toISOString(),
          invalidReason: null,
          mediaBlockActive: false,
          background: backgroundTab,
        };
        this.sessions.set(session.sessionId, session);
        details.sessionId = session.sessionId;
        await this.persistSessions();
        return publicSession(session);
      });
    });
  }

  async listSessions({ profileId, taskId, status, urlPrefix } = {}, context = {}) {
    validateTaskId(taskId);
    const selectedProfile = profileId ? validateProfileId(profileId) : null;
    const allowedStatuses = new Set(["active", "invalid", "closed"]);
    if (status && !allowedStatuses.has(status)) {
      throw new BrowserServiceError("status must be active, invalid, or closed.", "INVALID_SESSION_STATUS");
    }
    if (urlPrefix !== undefined && (typeof urlPrefix !== "string" || !urlPrefix)) {
      throw new BrowserServiceError("url_prefix must be a non-empty string.", "INVALID_URL_PREFIX");
    }
    if (this.pruneInactiveSessions()) await this.persistSessions();
    const details = this.auditDetails("browser_sessions", context, {
      taskId,
      profileId: selectedProfile,
      origin: urlPrefix ? originOf(urlPrefix) : null,
    });
    return this.audited("browser_sessions", context, details, async () => ({
      sessions: [...this.sessions.values()]
        .filter((session) => !selectedProfile || session.profileId === selectedProfile)
        .filter((session) => taskId === undefined || session.taskId === taskId)
        .filter((session) => !status || session.status === status)
        .filter((session) => !urlPrefix || session.url.startsWith(urlPrefix))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(publicSession),
    }));
  }

  async claim({ url, title, taskId, profileId } = {}, context = {}) {
    const normalizedUrl = validateUrl(url);
    validateTaskId(taskId);
    if (title !== undefined && (typeof title !== "string" || !title)) {
      throw new BrowserServiceError("title must be a non-empty exact title.", "INVALID_TITLE");
    }
    const selectedProfile = this.resolveProfile(taskId, profileId);
    const details = this.auditDetails("browser_claim", context, {
      taskId,
      profileId: selectedProfile,
      origin: originOf(normalizedUrl),
    });
    return this.audited("browser_claim", context, details, () =>
      this.runProfile(selectedProfile, "exclusive", details.metadata, async () => {
        const result = await this.invokeDaemon("tabs", selectedProfile);
        const matches = (result.tabs || []).filter((tab) =>
          (tab.type === undefined || tab.type === "page") && tab.url === normalizedUrl &&
          (title === undefined || tab.title === title),
        );
        if (matches.length === 0) {
          throw new BrowserServiceError("No tab exactly matched the requested URL and title.", "TAB_NOT_FOUND");
        }
        if (matches.length > 1) {
          throw new BrowserServiceError("More than one tab matched; add an exact title or close duplicates.", "TAB_AMBIGUOUS");
        }
        const targetId = matches[0].id || matches[0].targetId;
        if (typeof targetId !== "string") {
          throw new BrowserServiceError("Browser daemon returned an invalid tab.", "INVALID_DAEMON_RESPONSE");
        }
        let releasedExpiredClaim = false;
        for (const session of this.sessions.values()) {
          if (session.profileId !== selectedProfile || session.targetId !== targetId || session.status !== "active") continue;
          if (session.profileGeneration !== this.profileGeneration(selectedProfile)) {
            this.invalidateSession(session, "profile_generation_mismatch");
            releasedExpiredClaim = true;
          } else if (Date.parse(session.expiresAt) <= this.now()) {
            this.invalidateSession(session, "ttl_expired");
            releasedExpiredClaim = true;
          }
        }
        if (releasedExpiredClaim) await this.persistSessions();
        const existing = [...this.sessions.values()].find(
          (session) => session.profileId === selectedProfile && session.targetId === targetId && session.status === "active",
        );
        if (existing) {
          throw new BrowserServiceError("The matching tab is already claimed by an active session.", "TAB_ALREADY_CLAIMED");
        }
        const nowMs = this.now();
        const now = new Date(nowMs).toISOString();
        if (!this.profileGenerations.has(selectedProfile)) this.profileGenerations.set(selectedProfile, 1);
        const session = {
          sessionId: `session-${randomUUID()}`,
          taskId: taskId ?? null,
          profileId: selectedProfile,
          targetId,
          profileGeneration: this.profileGeneration(selectedProfile),
          url: matches[0].url,
          status: "active",
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(nowMs + this.sessionTtlMs).toISOString(),
          invalidReason: null,
          mediaBlockActive: false,
        };
        this.sessions.set(session.sessionId, session);
        details.sessionId = session.sessionId;
        details.metadata.sessionId = session.sessionId;
        await this.persistSessions();
        return publicSession(session);
      }),
    );
  }

  async closeTaskSessions({ taskId, profileId } = {}, context = {}) {
    if (!taskId) throw new BrowserServiceError("task_id is required.", "INVALID_TASK_ID");
    validateTaskId(taskId);
    const selectedProfile = profileId ? validateProfileId(profileId) : null;
    const details = this.auditDetails("browser_close_task_sessions", context, {
      taskId,
      profileId: selectedProfile,
    });
    return this.audited("browser_close_task_sessions", context, details, async () => {
      const sessions = [...this.sessions.values()].filter(
        (session) => session.taskId === taskId && (!selectedProfile || session.profileId === selectedProfile),
      );
      let closed = 0;
      let alreadyClosed = 0;
      for (const session of sessions) {
        const result = await this.close({ sessionId: session.sessionId }, context);
        if (result.already_closed) alreadyClosed += 1;
        else closed += 1;
      }
      return {
        task_id: taskId,
        profile_id: selectedProfile,
        matched: sessions.length,
        closed,
        already_closed: alreadyClosed,
      };
    });
  }

  async navigate({ sessionId, url } = {}, context = {}) {
    const normalizedUrl = validateUrl(url);
    const session = this.requireActiveSession(sessionId);
    const details = this.auditDetails("browser_navigate", context, {
      taskId: session.taskId,
      sessionId,
      profileId: session.profileId,
      origin: originOf(normalizedUrl),
    });
    return this.audited(
      "browser_navigate",
      context,
      details,
      () => this.runSessionAction(sessionId, "navigate", [normalizedUrl], (result, current) => ({
        session_id: current.sessionId,
        url: result.url || current.url,
        status: current.status,
      }), details.metadata),
    );
  }

  async snapshot({ sessionId } = {}, context = {}) {
    const session = this.requireActiveSession(sessionId);
    const details = this.auditDetails("browser_snapshot", context, {
      taskId: session.taskId,
      sessionId,
      profileId: session.profileId,
      origin: originOf(session.url),
    });
    return this.audited(
      "browser_snapshot",
      context,
      details,
      () => this.runSessionAction(sessionId, "snapshot", [], (result, current) => ({
        session_id: current.sessionId,
        title: result.title || "",
        url: result.url || current.url,
        elements: Array.isArray(result.elements) ? result.elements : [],
        text: result.text || "",
      }), details.metadata),
    );
  }

  async click({ sessionId, ref } = {}, context = {}) {
    if (!ref || typeof ref !== "string") {
      throw new BrowserServiceError("ref is required.", "INVALID_REF");
    }
    const session = this.requireActiveSession(sessionId);
    const details = this.auditDetails("browser_click", context, {
      taskId: session.taskId,
      sessionId,
      profileId: session.profileId,
      origin: originOf(session.url),
    });
    return this.audited(
      "browser_click",
      context,
      details,
      () => this.runSessionAction(sessionId, "click", [ref], (result, current) => ({
        session_id: current.sessionId,
        ok: Boolean(result.ok),
        url: result.url || current.url,
      }), details.metadata),
    );
  }

  async type({ sessionId, ref, text } = {}, context = {}) {
    if (!ref || typeof ref !== "string") {
      throw new BrowserServiceError("ref is required.", "INVALID_REF");
    }
    if (!text || typeof text !== "string") {
      throw new BrowserServiceError("text is required.", "INVALID_TEXT");
    }
    const session = this.requireActiveSession(sessionId);
    const details = this.auditDetails("browser_type", context, {
      taskId: session.taskId,
      sessionId,
      profileId: session.profileId,
      origin: originOf(session.url),
    });
    return this.audited(
      "browser_type",
      context,
      details,
      () => this.runSessionAction(sessionId, "type", [ref, text], (result, current) => ({
        session_id: current.sessionId,
        ok: Boolean(result.ok),
        url: result.url || current.url,
      }), details.metadata),
    );
  }

  async validateUploadPaths(paths) {
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 10) {
      throw new BrowserServiceError("paths must contain between 1 and 10 files.", "INVALID_UPLOAD_PATHS");
    }
    const allowedRoots = await Promise.all(
      this.uploadRoots.map(async (root) => {
        try {
          return await fs.realpath(root);
        } catch (error) {
          if (error.code === "ENOENT") return root;
          throw error;
        }
      }),
    );
    const validated = [];
    for (const rawPath of paths) {
      if (typeof rawPath !== "string" || !rawPath.trim()) {
        throw new BrowserServiceError("Every upload path must be a non-empty string.", "INVALID_UPLOAD_PATH");
      }
      const expanded = expandHome(rawPath.trim());
      if (!path.isAbsolute(expanded)) {
        throw new BrowserServiceError("Upload paths must be absolute.", "INVALID_UPLOAD_PATH");
      }
      let realPath;
      let stat;
      try {
        realPath = await fs.realpath(expanded);
        stat = await fs.stat(realPath);
      } catch (error) {
        if (error.code === "ENOENT") {
          throw new BrowserServiceError("An upload file does not exist.", "UPLOAD_FILE_NOT_FOUND", error);
        }
        throw error;
      }
      if (!stat.isFile()) {
        throw new BrowserServiceError("Upload paths must point to regular files.", "INVALID_UPLOAD_FILE");
      }
      if (!allowedRoots.some((root) => pathIsWithin(realPath, root))) {
        throw new BrowserServiceError(
          "Upload file is outside the configured upload roots.",
          "UPLOAD_PATH_NOT_ALLOWED",
        );
      }
      validated.push(realPath);
    }
    return validated;
  }

  async upload({ sessionId, selector = "input[type=file]", paths } = {}, context = {}) {
    if (typeof selector !== "string" || !selector.trim()) {
      throw new BrowserServiceError("selector is required.", "INVALID_SELECTOR");
    }
    const validatedPaths = await this.validateUploadPaths(paths);
    const session = this.requireActiveSession(sessionId);
    const details = this.auditDetails("browser_upload", context, {
      taskId: session.taskId,
      sessionId,
      profileId: session.profileId,
      origin: originOf(session.url),
    });
    return this.audited(
      "browser_upload",
      context,
      details,
      () => this.runSessionAction(
        sessionId,
        "upload",
        [selector.trim(), ...validatedPaths],
        async (result, current) => {
          // DOM.setFileInputFiles updates FileList, but Douyin's React upload
          // component also listens for input/change. Dispatch both while the
          // exact session is still locked so the upload cannot race another
          // page action.
          const selectorJson = JSON.stringify(selector.trim());
          const eventFn = `() => {
            const input = document.querySelector(${selectorJson});
            if (!input) return { ok: false, reason: 'file_input_missing_after_set' };
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, files: input.files ? input.files.length : 0 };
          }`;
          await this.invokeDaemon(
            "evaluate",
            current.profileId,
            ["--target", current.targetId, "--fn", eventFn],
          ).catch(() => undefined);
          return {
            session_id: current.sessionId,
            ok: Boolean(result.ok),
            file_count: Number(result.fileCount || validatedPaths.length),
            url: result.url || current.url,
          };
        },
        details.metadata,
      ),
    );
  }

  async networkBlockMedia({ sessionId } = {}, context = {}) {
    const session = this.requireActiveSession(sessionId);
    const details = this.auditDetails("browser_network_block_media", context, {
      taskId: session.taskId,
      sessionId,
      profileId: session.profileId,
      origin: originOf(session.url),
    });
    return this.audited("browser_network_block_media", context, details, () =>
      this.runSession(sessionId, details.metadata, () =>
        this.runProfile(session.profileId, "shared", details.metadata, async () => {
          this.requireActiveSession(sessionId);
          let guardian = this.mediaGuardians.get(sessionId);
          let reused = false;
          let layersActive;
          if (guardian?.isAlive()) {
            layersActive = await guardian.arm();
            reused = true;
          } else {
            if (guardian) await this.stopMediaGuardian(sessionId, { clearNetwork: false });
            const health = await this.invokeDaemon("health", session.profileId, [], {
              timeoutMs: this.statusTimeoutMs,
            });
            if (!health.ok || !Number.isInteger(Number(health.port))) {
              throw new BrowserServiceError(
                "Browser profile is not healthy enough to attach the media blocker.",
                "BROWSER_UNHEALTHY",
              );
            }
            guardian = await this.mediaGuardianFactory({
              port: Number(health.port),
              targetId: session.targetId,
              reapplyMs: this.mediaBlockReapplyMs,
            });
            this.mediaGuardians.set(sessionId, guardian);
            layersActive = guardian.layersActive || await guardian.arm();
          }
          session.mediaBlockActive = true;
          this.touchSession(session);
          await this.persistSessions();
          return {
            session_id: sessionId,
            ok: true,
            blocked: TIKTOK_MEDIA_BLOCK_URLS.length,
            mode: "tiktok-media-save-persistent",
            reused,
            layers: ["Network.setBlockedURLs", "Fetch.failRequest", "HTMLMediaElement.neuter"],
            layers_active: layersActive,
          };
        }),
      ),
    );
  }

  async networkClearBlocked({ sessionId } = {}, context = {}) {
    const session = this.requireActiveSession(sessionId);
    const details = this.auditDetails("browser_network_clear_blocked", context, {
      taskId: session.taskId,
      sessionId,
      profileId: session.profileId,
      origin: originOf(session.url),
    });
    return this.audited("browser_network_clear_blocked", context, details, () =>
      this.runSession(sessionId, details.metadata, () =>
        this.runProfile(session.profileId, "shared", details.metadata, async () => {
          const stopped = await this.stopMediaGuardian(sessionId);
          session.mediaBlockActive = false;
          this.touchSession(session);
          await this.persistSessions();
          return {
            session_id: sessionId,
            ok: true,
            blocked: 0,
            mode: "cleared",
            stopped,
          };
        }),
      ),
    );
  }

  async evaluate({ sessionId, fn } = {}, context = {}) {
    if (!fn || typeof fn !== "string") {
      throw new BrowserServiceError("fn is required.", "INVALID_FN");
    }
    const session = this.requireActiveSession(sessionId);
    const details = this.auditDetails("browser_evaluate", context, {
      taskId: session.taskId,
      sessionId,
      profileId: session.profileId,
      origin: originOf(session.url),
    });
    return this.audited(
      "browser_evaluate",
      context,
      details,
      () => this.runSessionAction(sessionId, "evaluate", ["--fn", fn], (result, current) => ({
        session_id: current.sessionId,
        url: result.url || current.url,
        value: result.value,
      }), details.metadata),
    );
  }

  async wait({ sessionId, load = "complete", timeoutMs = 30_000 } = {}, context = {}) {
    if (!["complete", "interactive", "networkidle"].includes(load)) {
      throw new BrowserServiceError("load must be complete, interactive, or networkidle.", "INVALID_LOAD_STATE");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new BrowserServiceError("timeout_ms must be between 1 and 120000.", "INVALID_TIMEOUT");
    }
    const session = this.requireActiveSession(sessionId);
    const details = this.auditDetails("browser_wait", context, {
      taskId: session.taskId,
      sessionId,
      profileId: session.profileId,
      origin: originOf(session.url),
    });
    const daemonLoad = load === "networkidle" ? "complete" : load;
    return this.audited(
      "browser_wait",
      context,
      details,
      () => this.runSessionAction(
        sessionId,
        "wait",
        ["--load", daemonLoad, "--timeout", String(timeoutMs)],
        (result, current) => ({
          session_id: current.sessionId,
          ready_state: result.readyState,
          waited_ms: result.waitedMs,
          requested_state: load,
        }),
        details.metadata,
      ),
    );
  }

  async screenshot({ sessionId, fullPage = false, outputPath } = {}, context = {}) {
    const session = this.requireActiveSession(sessionId);
    const args = [];
    if (fullPage) args.push("--full-page");
    if (outputPath) args.push("--path", expandHome(outputPath));
    const details = this.auditDetails("browser_screenshot", context, {
      taskId: session.taskId,
      sessionId,
      profileId: session.profileId,
      origin: originOf(session.url),
    });
    return this.audited(
      "browser_screenshot",
      context,
      details,
      () => this.runSessionAction(sessionId, "screenshot", args, (result, current) => ({
        session_id: current.sessionId,
        path: result.path,
      }), details.metadata),
    );
  }

  async close({ sessionId } = {}, context = {}) {
    validateSessionId(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) throw new BrowserServiceError("Unknown browser session.", "SESSION_NOT_FOUND");
    const details = {
      taskId: session.taskId,
      sessionId,
      profileId: session.profileId,
      origin: originOf(session.url),
    };
    details.metadata = this.operationMetadata("browser_close", context, details);
    return this.audited("browser_close", context, details, () => {
      if (session.status === "closed") {
        return { session_id: sessionId, status: "closed", already_closed: true };
      }
      return this.runSession(sessionId, details.metadata, () =>
        this.runProfile(session.profileId, "shared", details.metadata, async () => {
          if (session.status === "closed") {
            return { session_id: sessionId, status: "closed", already_closed: true };
          }
          if (session.status === "active") {
            await this.stopMediaGuardian(sessionId);
            try {
              await this.invokeDaemon("close-tab", session.profileId, ["--target", session.targetId]);
            } catch (error) {
              if (!(error instanceof DaemonInvocationError && INVALID_TARGET_CODES.has(error.code))) throw error;
            }
          }
          session.status = "closed";
          session.invalidReason = null;
          session.mediaBlockActive = false;
          session.updatedAt = new Date(this.now()).toISOString();
          await this.persistSessions();
          return { session_id: sessionId, status: "closed", already_closed: false };
        }),
      );
    });
  }
}
