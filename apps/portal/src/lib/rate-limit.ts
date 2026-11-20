// Request limit of the read API (#48, ADR 0006): a fixed one-minute window per
// key, in memory. With more than one portal instance the limit applies per
// instance; for the expected use (a few SCF keys) that is enough.

export const READ_API_LIMIT = 60;
const WINDOW_MS = 60_000;

type Entry = { windowStart: number; used: number };
const entries = new Map<string, Entry>();

export type RateResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export function takeToken(key: string, now: number = Date.now(), limit: number = READ_API_LIMIT): RateResult {
  // Discards expired windows when the map grows (there is one entry per key and
  // per truncated IP), so memory does not grow without bound.
  if (entries.size > 10_000) {
    for (const [k, e] of entries) if (now - e.windowStart >= WINDOW_MS) entries.delete(k);
  }
  const current = entries.get(key);
  if (!current || now - current.windowStart >= WINDOW_MS) {
    entries.set(key, { windowStart: now, used: 1 });
    return { ok: true };
  }
  if (current.used >= limit) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((current.windowStart + WINDOW_MS - now) / 1000)) };
  }
  current.used++;
  return { ok: true };
}

export function resetRateLimits() {
  entries.clear();
}
