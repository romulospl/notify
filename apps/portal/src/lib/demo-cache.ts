// Short in-memory cache for the public demo pages (/, /demo, /operator).
// They are open to anyone, so without it every anonymous request would turn
// into several Umami and Postgres reads. Keys are built by the pages from the
// demo tenant, the period key and the resource ID, never from free text, so
// the map stays small. Per process, like src/lib/rate-limit.ts.

const TTL_MS = 60_000;

const entries = new Map<string, { at: number; value: Promise<unknown> }>();

export function cachedDemo<T>(key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = entries.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value as Promise<T>;
  const value = load();
  entries.set(key, { at: now, value });
  // A failure is not kept: the next request tries again.
  value.catch(() => {
    if (entries.get(key)?.value === value) entries.delete(key);
  });
  return value;
}

export function resetDemoCache() {
  entries.clear();
}
