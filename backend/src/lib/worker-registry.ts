// Tiny in-process registry of background workers (node-cron jobs, setInterval loops, the Binance socket):
// health visibility at GET /health/ready, plus a coordinated stop on graceful shutdown. Each worker keeps its own isRunning guard untouched; this only records timing and holds a handle to stop the task.

import { captureError } from './analytics.ts';

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
// opts lets a worker mark an expected failure (upstream backpressure, not a bug) so it lands as one warn
// group instead of an error group counting every tick.
export function recordRun(name: string, ok: boolean, durationMs: number, error?: unknown, opts?: { level?: 'warn' | 'error'; fingerprint?: string; title?: string }): void {
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
    // Every registered worker reports through here, so this instruments all of them at once. Fire-and-
    // forget by contract, so a failing capture never affects the tick that just failed.
    captureError(error, { kind: 'worker', level: opts?.level, fingerprint: opts?.fingerprint, title: opts?.title, context: { worker: name, durationMs } });
  }
}

// Snapshot of every registered worker's health, for GET /health/ready.
export function allWorkerHealth(): WorkerHealth[] {
  return [...registry.values()].map(({ task: _task, ...h }) => h);
}

// A worker is only stale once it has been quiet for BOTH 3x its own cadence and a full minute. The minute
// floor matters: market-sync runs every 2s and price-history every 500ms, and lastRunAt is stamped when a
// tick FINISHES, so a single slow chain read trips a bare 3x rule. That is a false alarm on a healthy
// system, and a monitor that cries wolf is the fastest way to teach everyone to ignore the dashboard.
const STALE_FLOOR_MS = 60_000;

export function isWorkerStale(w: Pick<WorkerHealth, 'intervalMs' | 'lastRunAt'>, now = Date.now()): boolean {
  // A worker with no cadence (the Binance socket) or one that has not run yet is never stale.
  if (w.intervalMs == null || w.lastRunAt == null) return false;
  return now - w.lastRunAt > Math.max(3 * w.intervalMs, STALE_FLOOR_MS);
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
