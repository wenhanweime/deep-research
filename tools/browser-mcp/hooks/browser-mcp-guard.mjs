#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const daemonExecution =
  /(?:^|[;&|]\s*|\b)(?:(?:\/[^\s;&|'"]+)*\/)?(?:node|bun)\s+[^\n;&|]*cdp_browser_daemon\.js\b/i;
const directDaemonScript = /(?:^|[;&|]\s*)["']?(?:~\/|\/)[^\s;&|'"]*cdp_browser_daemon\.js\b/i;
const rawChromeLaunch =
  /Google Chrome[^\n;&|]*--remote-debugging-port|--remote-debugging-port[^\n;&|]*Google Chrome/i;
const rawVersionProbe = /\b(?:curl|wget)\b[^\n;&|]*\/json\/version\b/i;
const rawCdpClient = /\b(?:node|bun|npx)\b[^\n;&|]*(?:connectOverCDP|chrome-remote-interface)\b/i;

const DENY_REASON =
  "Direct browser control is disabled for Agent shell calls. Use host browser-mcp tools when they are injected; otherwise run the browser-mcp CLI (browser-mcp). Do not call cdp_browser_daemon.js or raw CDP.";

export function shouldBlockBrowserCommand(command) {
  const text = String(command ?? "").replaceAll("\\\n", " ");
  return (
    daemonExecution.test(text) ||
    directDaemonScript.test(text) ||
    rawChromeLaunch.test(text) ||
    rawVersionProbe.test(text) ||
    rawCdpClient.test(text)
  );
}

export function browserGuardResponse(command) {
  if (!shouldBlockBrowserCommand(command)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: DENY_REASON,
    },
  };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);

  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    process.exit(0);
  }

  if (input?.hook_event_name !== "PreToolUse" || input?.tool_name !== "Bash") {
    process.exit(0);
  }

  const command = input?.tool_input?.command ?? input?.tool_input?.cmd ?? "";
  const denied = browserGuardResponse(command);
  if (denied) process.stdout.write(JSON.stringify(denied));
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
