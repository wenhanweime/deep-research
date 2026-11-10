const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_REAPPLY_MS = 15_000;

// TikTok discovery only needs HTML/JSON/API responses. Keep media and playback
// traffic out of the long-lived browser profile; intentional video downloads
// use a separate downloader outside this browser session.
export const TIKTOK_MEDIA_BLOCK_URLS = Object.freeze([
  "*v16-webapp-prime*",
  "*://*v16-webapp-prime*",
  "*v16-webapp*",
  "*v16m.*",
  "*v19-webapp*",
  "*v19.*tiktok*",
  "*.mp4*",
  "*.m3u8*",
  "*.m4s*",
  "*mime_type=video*",
  "*pull-flv*",
  "*pull-hls*",
  "*pull-cmaf*",
  "*tiktokcdn.com*",
  "*://*.tiktokcdn.com/*",
  "*://*tiktokcdn.com/*",
  "*p16-common-sign*",
  "*p19-common-sign*",
  "*tiktokcdn-us.com*",
  "*tiktokcdn-eu.com*",
  "*ttlivecdn.com*",
  // Keep webcast matches host-scoped. A generic *webcast* also matches the
  // webcast_language query parameter on TikTok's JSON API.
  "*://webcast.*",
  "*webcast.tiktok.com*",
  "*://*webcast.tiktok.com/*",
  "*byteoversea.com*",
  "*://*.byteoversea.com/*",
  "*ibytedtos.com*",
  "*bytevcloud*",
  "*muscdn.com*",
  "*ibyteimg.com*",
  "*mcs-sg.tiktokv.com*",
  "*mcs.tiktokv.com*",
  "*mon-sg.tiktokv.com*",
  "*mon.tiktokv.com*",
  "*tiktokv.com*",
  "*://*.tiktokv.com/*",
]);

export const FETCH_FAIL_FALLBACK_URLS = Object.freeze([
  "*tiktokcdn*",
  "*webapp-prime*",
  "*://webcast.*",
  "*webcast.tiktok.com*",
  "*.mp4*",
  "*.m3u8*",
  "*byteoversea*",
]);

export function webcastPatternMatchesQueryParam(pattern) {
  const text = String(pattern || "").toLowerCase();
  if (!text.includes("webcast")) return false;
  return !text.includes("webcast.") && !text.includes("://webcast");
}

export function assertWebcastPatternsHostScoped(patterns) {
  const unsafe = patterns.filter(webcastPatternMatchesQueryParam);
  if (unsafe.length) throw new Error(`webcast URL patterns must be host-scoped: ${unsafe.join(", ")}`);
}

assertWebcastPatternsHostScoped(TIKTOK_MEDIA_BLOCK_URLS);
assertWebcastPatternsHostScoped(FETCH_FAIL_FALLBACK_URLS);

const MEDIA_NEUTER_SOURCE = String.raw`
(() => {
  try {
    const proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
    if (proto && !proto.__browserMcpMediaSave) {
      proto.__browserMcpMediaSave = true;
      proto.play = function() { try { this.pause(); } catch {} return Promise.resolve(); };
      proto.load = function() { return undefined; };
    }
    const neuter = (media) => {
      try {
        media.autoplay = false;
        media.preload = 'none';
        media.muted = true;
        if (media.pause) media.pause();
        if (media.tagName === 'VIDEO' && media.currentSrc && /tiktokcdn|webapp-prime|byteoversea|\.mp4|\.m3u8/i.test(media.currentSrc)) {
          media.removeAttribute('src');
          while (media.firstChild) media.removeChild(media.firstChild);
          if (media.load) media.load();
        }
      } catch {}
    };
    document.querySelectorAll('video,audio').forEach(neuter);
    if (!window.__browserMcpMediaObserver) {
      window.__browserMcpMediaObserver = new MutationObserver(() => {
        document.querySelectorAll('video,audio').forEach(neuter);
      });
      try {
        window.__browserMcpMediaObserver.observe(document.documentElement || document.body, {
          childList: true,
          subtree: true,
        });
      } catch {}
    }
  } catch {}
})();
`;

async function resolveTargetWebSocket({ port, targetId, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal });
    if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`);
    const targets = await response.json();
    const target = (Array.isArray(targets) ? targets : []).find(
      (item) => String(item?.id || "").toLowerCase() === String(targetId).toLowerCase(),
    );
    if (!target?.webSocketDebuggerUrl) throw new Error("The browser session target is no longer available.");
    return target.webSocketDebuggerUrl;
  } finally {
    clearTimeout(timer);
  }
}

class CdpConnection {
  constructor({ wsUrl, WebSocketImpl, commandTimeoutMs }) {
    this.wsUrl = wsUrl;
    this.WebSocketImpl = WebSocketImpl;
    this.commandTimeoutMs = commandTimeoutMs;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.blockedRequests = 0;
  }

  async connect(timeoutMs) {
    if (this.closed) throw new Error("CDP media guardian is closed.");
    const ws = new this.WebSocketImpl(this.wsUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting media guardian to CDP.")), timeoutMs);
      timer.unref?.();
      const finish = (callback, value) => {
        clearTimeout(timer);
        callback(value);
      };
      ws.addEventListener("open", () => finish(resolve));
      ws.addEventListener("error", (event) => finish(reject, new Error(event?.message || "CDP socket error.")));
    });
    ws.addEventListener("message", (event) => this.onMessage(event));
    ws.addEventListener("close", () => this.onClose());
  }

  onMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.method === "Fetch.requestPaused" && message.params?.requestId) {
      this.blockedRequests += 1;
      void this.send("Fetch.failRequest", {
        requestId: message.params.requestId,
        errorReason: "BlockedByClient",
      }).catch(() => undefined);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else pending.resolve(message.result || {});
  }

  onClose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP media guardian connection closed."));
    }
    this.pending.clear();
  }

  isOpen() {
    return !this.closed && this.ws?.readyState === this.WebSocketImpl.OPEN;
  }

  send(method, params = {}) {
    if (!this.isOpen()) return Promise.reject(new Error("CDP media guardian is not connected."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP media guardian timed out: ${method}`));
      }, this.commandTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async close({ clearNetwork = true } = {}) {
    if (this.closed) return;
    // Network/Fetch state is scoped to this CDP connection and disappears when
    // it closes. Do not wait for cleanup commands here: a wedged target must not
    // turn session close or profile recovery into another 30-second stall.
    void clearNetwork;
    this.closed = true;
    try {
      this.ws?.close();
    } catch {}
    this.onClose();
  }
}

export class TikTokMediaGuardian {
  static async create(options) {
    const guardian = new TikTokMediaGuardian(options);
    await guardian.initialize();
    return guardian;
  }

  constructor({
    port,
    targetId,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    reapplyMs = DEFAULT_REAPPLY_MS,
  }) {
    if (!fetchImpl || !WebSocketImpl) throw new Error("Browser MCP requires fetch and WebSocket support.");
    this.port = port;
    this.targetId = targetId;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.connectTimeoutMs = connectTimeoutMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this.reapplyMs = Math.max(5_000, reapplyMs);
    this.connection = null;
    this.interval = null;
    this.injectRegistered = false;
    this.consecutiveArmFailures = 0;
    this.layersActive = null;
  }

  async initialize() {
    const wsUrl = await resolveTargetWebSocket({
      port: this.port,
      targetId: this.targetId,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.connectTimeoutMs,
    });
    this.connection = new CdpConnection({
      wsUrl,
      WebSocketImpl: this.WebSocketImpl,
      commandTimeoutMs: this.commandTimeoutMs,
    });
    await this.connection.connect(this.connectTimeoutMs);
    await this.arm();
    this.interval = setInterval(() => {
      this.arm().catch(() => {
        this.consecutiveArmFailures += 1;
        if (this.consecutiveArmFailures >= 3) void this.close({ clearNetwork: false });
      });
    }, this.reapplyMs);
    this.interval.unref?.();
  }

  isAlive() {
    return Boolean(this.connection?.isOpen());
  }

  async arm() {
    if (!this.isAlive()) throw new Error("Persistent media blocker is not connected.");
    const active = { network_blocked: false, fetch_fail: false, media_neuter: false };
    await this.connection.send("Network.enable");
    await this.connection.send("Network.setBlockedURLs", { urls: TIKTOK_MEDIA_BLOCK_URLS });
    active.network_blocked = true;
    const fullPatterns = TIKTOK_MEDIA_BLOCK_URLS.map((urlPattern) => ({
      urlPattern,
      requestStage: "Request",
    }));
    try {
      await this.connection.send("Fetch.enable", { patterns: fullPatterns, handleAuthRequests: false });
      active.fetch_fail = true;
    } catch {
      const fallbackPatterns = FETCH_FAIL_FALLBACK_URLS.map((urlPattern) => ({
        urlPattern,
        requestStage: "Request",
      }));
      await this.connection.send("Fetch.enable", { patterns: fallbackPatterns, handleAuthRequests: false });
      active.fetch_fail = true;
    }
    await this.connection.send("Page.enable");
    if (!this.injectRegistered) {
      await this.connection.send("Page.addScriptToEvaluateOnNewDocument", { source: MEDIA_NEUTER_SOURCE });
      this.injectRegistered = true;
    }
    try {
      await this.connection.send("Runtime.evaluate", {
        expression: MEDIA_NEUTER_SOURCE,
        returnByValue: true,
      });
      active.media_neuter = true;
    } catch {}
    this.consecutiveArmFailures = 0;
    this.layersActive = active;
    return active;
  }

  async close(options) {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    await this.connection?.close(options);
  }
}
