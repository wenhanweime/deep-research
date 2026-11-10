import { promises as fs } from "node:fs";
import path from "node:path";

const home = process.env.FAKE_DAEMON_HOME;
if (!home) throw new Error("FAKE_DAEMON_HOME is required");
const statePath = path.join(home, "state.json");
const eventsPath = path.join(home, "events.jsonl");

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { nextTarget: 1, targets: {} };
    throw error;
  }
}

async function saveState(state) {
  await fs.mkdir(home, { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(state));
  await fs.rename(temporaryPath, statePath);
}

async function event(phase, command, profileId, targetId, details = {}) {
  await fs.mkdir(home, { recursive: true });
  await fs.appendFile(
    eventsPath,
    `${JSON.stringify({ phase, command, profileId, targetId, time: Date.now(), pid: process.pid, ...details })}\n`,
  );
}

function parse(argv) {
  const command = argv[0];
  const options = {};
  const positionals = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--id", "--target", "--load", "--timeout", "--path", "--set"].includes(arg)) {
      options[arg.slice(2)] = argv[++index];
    } else if (["--json", "--full-page", "--clear", "--no-restore-tabs", "--background", "--foreground"].includes(arg)) {
      options[arg.slice(2)] = true;
    } else {
      positionals.push(arg);
    }
  }
  return { command, options, positionals };
}

function fail(code, message) {
  console.error(`cdp-browser-daemon error [${code}]: ${message}`);
  process.exit(1);
}

const { command, options, positionals } = parse(process.argv.slice(2));
const profileId = options.id || "cdp-browser-daemon";
await event("start", command, profileId, options.target, { options, positionals });
let commandDelays = {};
try {
  commandDelays = JSON.parse(process.env.FAKE_DAEMON_COMMAND_DELAYS || "{}");
} catch {
  fail("ARGUMENT", "FAKE_DAEMON_COMMAND_DELAYS must be JSON");
}
const delayMs = Number(commandDelays[command] ?? process.env.FAKE_DAEMON_DELAY_MS ?? 0);
if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));

const state = await loadState();
let result;
if (command === "health") {
  const stopped = Boolean(state.stopped && state.stopped[profileId]);
  const healthy = process.env.FAKE_DAEMON_UNHEALTHY !== "1" && !stopped;
  result = {
    ok: healthy,
    pidAlive: healthy,
    httpOk: healthy,
    websocketOk: healthy,
    port: 9222,
    wsUrl: "ws://secret",
  };
} else if (command === "stop") {
  const hadTargets = Object.entries(state.targets).some(([, target]) => target.profileId === profileId);
  for (const [targetId, target] of Object.entries(state.targets)) {
    if (target.profileId === profileId) delete state.targets[targetId];
  }
  state.stopped = { ...(state.stopped || {}), [profileId]: true };
  result = hadTargets
    ? { stopped: true, lane: profileId, pid: 12345, port: 9222 }
    : { stopped: false };
} else if (command === "recover") {
  for (const [targetId, target] of Object.entries(state.targets)) {
    if (target.profileId === profileId) delete state.targets[targetId];
  }
  if (state.stopped) delete state.stopped[profileId];
  result = { recovered: true, profileId, pid: 12345, port: 9222, wsUrl: "ws://secret" };
} else if (command === "tabs") {
  result = {
    tabs: Object.entries(state.targets)
      .filter(([, target]) => target.profileId === profileId)
      .map(([id, target]) => ({ id, title: target.title || "Fake page", url: target.url, type: "page" })),
  };
} else if (command === "launch-options") {
  const optionsPath = path.join(home, "launch-options", `${profileId}.json`);
  if (options.clear) {
    await fs.rm(optionsPath, { force: true });
    result = { profileId, launchOptions: {} };
  } else if (options.set !== undefined) {
    const parsed = JSON.parse(options.set);
    await fs.mkdir(path.dirname(optionsPath), { recursive: true });
    await fs.writeFile(optionsPath, JSON.stringify(parsed));
    result = { profileId, launchOptions: parsed };
  } else {
    let launchOptions = {};
    try {
      launchOptions = JSON.parse(await fs.readFile(optionsPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    result = { profileId, launchOptions };
  }
} else if (command === "open") {
  const targetId = `target-${state.nextTarget++}`;
  const url = positionals[0];
  if (state.stopped) delete state.stopped[profileId];
  state.targets[targetId] = { profileId, url, title: "Fake page" };
  result = { targetId, url, lane: profileId, port: 9222, wsUrl: "ws://secret" };
} else {
  const target = state.targets[options.target];
  if (!target || target.profileId !== profileId) fail("NO_TARGET", `No page target matched ${options.target}`);
  if (command === "navigate") {
    target.url = positionals[0];
    result = { targetId: options.target, url: target.url, port: 9222 };
  } else if (command === "snapshot") {
    result = {
      snapshot: true,
      targetId: options.target,
      title: "Fake page",
      url: target.url,
      elements: [{ ref: "r1", tag: "input", text: "" }],
      text: "Fake body",
      port: 9222,
    };
  } else if (command === "click") {
    const ref = positionals[0];
    if (ref && ref !== "r1") fail("REF_STALE", `Element ref is stale: ${ref}`);
    result = { targetId: options.target, ok: true, text: "Clicked", url: target.url, port: 9222 };
  } else if (command === "type") {
    const ref = positionals[0];
    if (ref && ref !== "r1") fail("REF_STALE", `Element ref is stale: ${ref}`);
    result = { targetId: options.target, ok: true, text: positionals[1], url: target.url, port: 9222 };
  } else if (command === "upload") {
    result = {
      targetId: options.target,
      ok: true,
      fileCount: Math.max(0, positionals.length - 1),
      url: target.url,
      port: 9222,
    };
  } else if (command === "wait") {
    result = { targetId: options.target, readyState: options.load, waitedMs: delayMs, port: 9222 };
  } else if (command === "screenshot") {
    const outputPath = options.path || path.join(home, `${options.target}.png`);
    await fs.writeFile(outputPath, "fake png");
    result = { targetId: options.target, path: outputPath, port: 9222 };
  } else if (command === "close-tab") {
    delete state.targets[options.target];
    result = { targetId: options.target, closed: true, url: target.url, port: 9222 };
  } else if (command === "evaluate") {
    result = { targetId: options.target, value: "fake-value", url: target.url, port: 9222 };
  } else {
    fail("ARGUMENT", `Unsupported command ${command}`);
  }
}

await saveState(state);
await event("end", command, profileId, options.target, { options, positionals });
console.log(JSON.stringify(result));
