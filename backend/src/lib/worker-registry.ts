// Tiny in-process registry of background workers (node-cron jobs, setInterval loops, the Binance socket):
// health visibility at GET /health/ready, plus a coordinated stop on graceful shutdown. Each worker keeps its own isRunning guard untouched; this only records timing and holds a handle to stop the task.

export type WorkerHealth = {
  name: string;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
  // Best-effort cadence in ms, drives staleness detection (stale past ~3x this); null for a non-periodic worker (e.g. Binance socket), never flagged stale.
  intervalMs: number | null;
};

// Anything the shutdown routine can stop: a node-cron ScheduledTask, a setInterval wrapper, or a socket closer all satisfy this, so the registry never depends on node-cron's concrete type.
type Stoppable = { stop: () => void | Promise<void> };

type Entry = WorkerHealth & { task: Stoppable };

const registry = new Map<string, Entry>();

// Parses a node-cron expression into an approximate interval in ms, good enough for staleness detection.
// Handles the forms this project uses (seconds, minutes, hourly, plain `*`); unknown shapes return null (never flagged stale).
export function cronIntervalMs(expr: string): number | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length === 6) {
    // Seconds-precision cron (node-cron extension): first field is seconds.
    const sec = parts[0];
    const m = sec.match(/^\*\/(\d+)$/);
    if (m) return Number(m[1]) * 1000;
    if (sec === '*') return 1000;
    if (/^\d+$/.test(sec)) return 60_000; // fires once a minute at that second
  }
  if (parts.length === 5) {
    const min = parts[0];
    const m = min.match(/^\*\/(\d+)$/);
    if (m) return Number(m[1]) * 60_000;
    if (min === '*') return 60_000;
    if (/^\d+$/.test(min)) return 3_600_000; // once an hour at that minute
  }
  return null;
}

// Registers (or re-registers) a worker with a stop handle, preserving any run history already recorded so a worker that reports before registering (e.g. the socket) doesn't lose its timing.
export function registerWorker(name: string, task: Stoppable, intervalMs: number | null = null): void {
  const prev = registry.get(name);
  registry.set(name, {
    name,
    task,
    intervalMs,
    lastRunAt: prev?.lastRunAt ?? null,
    lastSuccessAt: prev?.lastSuccessAt ?? null,
    lastError: prev?.lastError ?? null,
    lastDurationMs: prev?.lastDurationMs ?? null,
  });
}

// Records the outcome of one worker run, cheap enough to call on every tick. A run recorded for a name
// never registered still shows up in health (no stop handle), so a worker can report liveness even if it registers its stop handle elsewhere.
export function recordRun(name: string, ok: boolean, durationMs: number, error?: unknown): void {
  let e = registry.get(name);
  if (!e) {
    e = { name, task: { stop: () => {} }, intervalMs: null, lastRunAt: null, lastSuccessAt: null, lastError: null, lastDurationMs: null };
    registry.set(name, e);
  }
  const now = Date.now();
  e.lastRunAt = now;
  e.lastDurationMs = durationMs;
  if (ok) {
    e.lastSuccessAt = now;
    e.lastError = null;
  } else {
    e.lastError = error instanceof Error ? error.message : error != null ? String(error) : 'unknown error';
  }
}

// Snapshot of every registered worker's health, for GET /health/ready.
export function allWorkerHealth(): WorkerHealth[] {
  return [...registry.values()].map(({ task: _task, ...h }) => h);
}

// Stops every registered task (graceful shutdown); best-effort so one failing task never blocks the rest. In-flight runs finish on their own via each worker's isRunning guard.
export function stopAllWorkers(): void {
  for (const e of registry.values()) {
    try {
      void e.task.stop();
    } catch (err) {
      console.error(`[worker-registry] stop ${e.name} failed:`, err instanceof Error ? err.message : err);
    }
  }
}
