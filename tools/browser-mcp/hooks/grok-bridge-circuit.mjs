#!/usr/bin/env node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULT_MAX_IDLE_MS = 20 * 60 * 1000;
export const STATE_RETENTION_MS = 7 * 24 * 60 * 1000;

export const DENY_REASON =
  "Grok host MCP bridge for browser-mcp is stale (HTTP sessions expire after 30m idle; this session has no successful host call in 20m). Do not retry use_tool or browser-mcp__*. The request will hang in the Grok client and never reach 127.0.0.1:19451. Use the CLI, which opens a fresh HTTP session each call: browser-mcp browser_open --url <url>. CLI health only proves the daemon is up — after a successful health/status, still do not retry use_tool.";

function eventName(event) {
  return String(event?.hook_event_name || event?.hookEventName || "");
}

function sessionIdFrom(event) {
  return String(event?.sessionId || event?.session_id || "").trim();
}

function toolNamesFrom(event) {
  const toolName = event?.toolName || event?.tool_name || "";
  const input = event?.toolInput || event?.tool_input || {};
  const nested = input?.tool_name || input?.toolName || "";
  return [toolName, nested].map((value) => String(value || "")).filter(Boolean);
}

export function isBrowserMcpToolName(name) {
  const value = String(name || "");
  return (
    value === "browser-mcp" ||
    value.startsWith("browser-mcp__") ||
    value.startsWith("mcp__browser-mcp__") ||
    value.startsWith("mcp__browser_mcp__")
  );
}

export function isBrowserMcpHostTool(event) {
  return toolNamesFrom(event).some(isBrowserMcpToolName);
}

export function uuidv7Ms(sessionId) {
  if (!sessionId) return null;
  const hex = String(sessionId).replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  const ms = Number.parseInt(hex.slice(0, 12), 16);
  if (!Number.isFinite(ms)) return null;
  if (ms < 1_577_836_800_000 || ms > 2_051_222_400_000) return null;
  return ms;
}

export function sessionStartMs({ record, sessionId, now }) {
  const fromId = uuidv7Ms(sessionId);
  const fromRecord = Date.parse(record?.startedAt);
  const candidates = [fromId, fromRecord].filter((value) => Number.isFinite(value));
  if (!candidates.length) return now;
  return Math.min(...candidates);
}

export function idleMs({ record, sessionId, now }) {
  const start = sessionStartMs({ record, sessionId, now });
  const lastOk = Date.parse(record?.lastOkAt);
  const lastActivity = Number.isFinite(lastOk) ? Math.max(lastOk, start) : start;
  return now - lastActivity;
}

export function shouldDenyHostCall({ record, sessionId, now, maxIdleMs = DEFAULT_MAX_IDLE_MS }) {
  return idleMs({ record, sessionId, now }) > maxIdleMs;
}

export function denyResponse(reason = DENY_REASON) {
  return {
    decision: "deny",
    reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function isPreToolUse(name) {
  return name === "PreToolUse" || name === "pre_tool_use";
}

function isPostToolUse(name) {
  return name === "PostToolUse" || name === "post_tool_use";
}

function isSessionStart(name) {
  return name === "SessionStart" || name === "session_start";
}

export function defaultStatePath() {
  return (
    process.env.BROWSER_MCP_GROK_BRIDGE_STATE ||
    path.join(os.homedir(), ".browser-mcp", "grok-bridge-state.json")
  );
}

async function readStateFile(statePath) {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return { sessions: {} };
    throw error;
  }
}

function pruneSessions(sessions, now) {
  const kept = {};
  for (const [id, record] of Object.entries(sessions || {})) {
    const idle = idleMs({ record, sessionId: id, now });
    if (idle <= STATE_RETENTION_MS) kept[id] = record;
  }
  return kept;
}

async function writeStateFile(statePath, state, now) {
  const next = {
    sessions: pruneSessions(state.sessions, now),
  };
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await fs.rename(tmp, statePath);
  return next;
}

export async function applyEvent(event, options = {}) {
  const now = options.now ?? Date.now();
  const maxIdleMs = options.maxIdleMs ?? Number(process.env.BROWSER_MCP_GROK_BRIDGE_MAX_IDLE_MS || DEFAULT_MAX_IDLE_MS);
  const statePath = options.statePath ?? defaultStatePath();
  const name = eventName(event);
  const sessionId = sessionIdFrom(event);

  if (!sessionId) return null;

  const state = options.state ?? (await readStateFile(statePath));
  const sessions = state.sessions || (state.sessions = {});
  const record = sessions[sessionId] || (sessions[sessionId] = {});
  let dirty = false;

  if (!record.startedAt) {
    record.startedAt = new Date(sessionStartMs({ record, sessionId, now })).toISOString();
    dirty = true;
  }

  if (isSessionStart(name)) {
    if (dirty && !options.state) await writeStateFile(statePath, state, now);
    return null;
  }

  if (!isBrowserMcpHostTool(event)) {
    if (dirty && !options.state) await writeStateFile(statePath, state, now);
    return null;
  }

  if (isPreToolUse(name) && shouldDenyHostCall({ record, sessionId, now, maxIdleMs })) {
    if (dirty && !options.state) await writeStateFile(statePath, state, now);
    return denyResponse();
  }

  if (isPostToolUse(name)) {
    record.lastOkAt = new Date(now).toISOString();
    dirty = true;
  }

  if (dirty && !options.state) await writeStateFile(statePath, state, now);
  return null;
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let event;
  try {
    event = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    process.exit(0);
  }

  try {
    const response = await applyEvent(event);
    if (response) process.stdout.write(JSON.stringify(response));
  } catch {
    // Fail open: a broken circuit must not freeze every browser call.
  }
}

function isMainModule() {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await main();
}
