export class CoordinatorError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CoordinatorError";
    this.code = code;
  }
}

function publicOperation(entry, now) {
  return {
    mode: entry.mode,
    operation: entry.metadata.operation || "unknown",
    client_name: entry.metadata.clientName || "unknown",
    task_id: entry.metadata.taskId ?? null,
    session_id: entry.metadata.sessionId ?? null,
    started_at: entry.startedAt ? new Date(entry.startedAt).toISOString() : null,
    queued_at: new Date(entry.queuedAt).toISOString(),
    age_ms: Math.max(0, now - (entry.startedAt || entry.queuedAt)),
  };
}

export class OperationCoordinator {
  constructor({ name, maxQueued = 100, waitTimeoutMs = 30_000, now = () => Date.now() } = {}) {
    this.name = name || "coordinator";
    this.maxQueued = maxQueued;
    this.waitTimeoutMs = waitTimeoutMs;
    this.now = now;
    this.sequence = 0;
    this.queue = [];
    this.activeShared = new Map();
    this.activeExclusive = null;
  }

  get idle() {
    return this.queue.length === 0 && this.activeShared.size === 0 && this.activeExclusive === null;
  }

  snapshot() {
    const now = this.now();
    const active = [
      ...(this.activeExclusive ? [this.activeExclusive] : []),
      ...this.activeShared.values(),
    ].map((entry) => publicOperation(entry, now));
    const queued = this.queue.map((entry) => publicOperation(entry, now));
    return {
      active,
      queued: queued.length,
      oldest_queued_ms: queued.length ? Math.max(...queued.map((entry) => entry.age_ms)) : 0,
      max_queued: this.maxQueued,
      wait_timeout_ms: this.waitTimeoutMs,
    };
  }

  async run(mode, metadata, operation, { timeoutMs } = {}) {
    if (!new Set(["shared", "exclusive"]).has(mode)) {
      throw new CoordinatorError(`Unsupported coordinator mode: ${mode}`, "QUEUE_ARGUMENT");
    }
    if (this.queue.length >= this.maxQueued) {
      throw new CoordinatorError(`${this.name} queue is full.`, "QUEUE_FULL");
    }

    const queuedAt = this.now();
    const entry = {
      id: ++this.sequence,
      mode,
      metadata,
      queuedAt,
      startedAt: null,
      timer: null,
      resolve: null,
      reject: null,
    };
    const effectiveTimeout = timeoutMs ?? this.waitTimeoutMs;
    const release = await new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
      if (effectiveTimeout > 0) {
        entry.timer = setTimeout(() => {
          const index = this.queue.indexOf(entry);
          if (index < 0) return;
          this.queue.splice(index, 1);
          metadata.queueWaitMs = (metadata.queueWaitMs || 0) + Math.max(0, this.now() - queuedAt);
          reject(new CoordinatorError(`${this.name} queue wait timed out.`, "QUEUE_TIMEOUT"));
          this.drain();
        }, effectiveTimeout);
      }
      this.queue.push(entry);
      this.drain();
    });

    metadata.queueWaitMs = (metadata.queueWaitMs || 0) + Math.max(0, entry.startedAt - queuedAt);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  grant(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.startedAt = this.now();
    if (entry.mode === "exclusive") this.activeExclusive = entry;
    else this.activeShared.set(entry.id, entry);
    entry.resolve(() => {
      if (entry.mode === "exclusive") {
        if (this.activeExclusive?.id === entry.id) this.activeExclusive = null;
      } else {
        this.activeShared.delete(entry.id);
      }
      this.drain();
    });
  }

  drain() {
    if (this.activeExclusive || this.queue.length === 0) return;

    if (this.activeShared.size > 0) {
      while (this.queue[0]?.mode === "shared") this.grant(this.queue.shift());
      return;
    }

    if (this.queue[0].mode === "exclusive") {
      this.grant(this.queue.shift());
      return;
    }
    while (this.queue[0]?.mode === "shared") this.grant(this.queue.shift());
  }
}
