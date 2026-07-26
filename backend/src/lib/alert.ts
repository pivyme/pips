// Opt-in Discord/Slack webhook alert for unrecoverable events (fatal crash, leader-lock conflict, a
// worker giving up). No-op if PIPS_ALERT_WEBHOOK_URL is unset; fire-and-forget with a 3s timeout so a broken webhook can't wedge the caller, and same-message throttled via ALERT_DEDUPE_MS.

import { ALERT_WEBHOOK_URL, ALERT_DEDUPE_MS } from '../config/main-config.ts';

// Last-sent timestamp per dedupe key. Bounded below so a long-lived process emitting many distinct
// keys can't grow it without limit.
const lastSent = new Map<string, number>();

// `key` is the dedupe identity: a fingerprint or a detector key, never the message. Our messages carry
// play ids and amounts, so every occurrence of one bug is a unique string and message-text dedupe silently
// never fires (L-021). Callers with a genuinely static message can omit it.
export function alert(level: 'warn' | 'critical', message: string, context?: Record<string, unknown>, key?: string): void {
  if (!ALERT_WEBHOOK_URL) return; // feature off: silent no-op
  const dedupeKey = key ?? message;
  const now = Date.now();
  const prev = lastSent.get(dedupeKey);
  if (prev != null && now - prev < ALERT_DEDUPE_MS) return; // throttle a repeating alert
  lastSent.set(dedupeKey, now);
  if (lastSent.size > 500) {
    for (const [k, t] of lastSent) if (now - t >= ALERT_DEDUPE_MS) lastSent.delete(k);
  }

  const tag = level === 'critical' ? '\u{1F6A8} CRITICAL' : '⚠️ WARN';
  const ctx = context && Object.keys(context).length ? `\n\`\`\`${safeJson(context)}\`\`\`` : '';
  const text = `[PIPS] ${tag}: ${message}${ctx}`;
  // Discord reads `content`, Slack reads `text`; sending both keys renders on either platform (each
  // ignores the key it doesn't know) with no per-platform format flag.
  const body = JSON.stringify({ content: text, text });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  timer.unref?.();
  void fetch(ALERT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: controller.signal,
  })
    .catch((e) => console.warn('[alert] webhook post failed:', e instanceof Error ? e.message : e))
    .finally(() => clearTimeout(timer));
}

function safeJson(obj: Record<string, unknown>): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}
