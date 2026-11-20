import "server-only";
import { authenticateReadKey, type OperatorKeyContext } from "./access";
import { parsePeriodKey, PERIODS, type Period, resolvePeriod } from "./period";
import { truncatedClientIp } from "./client-ip";
import { takeToken } from "./rate-limit";
import { readKeyFromHeader } from "./read-key";

// Base of the SCF read API routes (#48, ADR 0006): key authentication, per-key
// limit and uncached JSON responses. Errors do not say why the key was
// rejected.

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json(body, { status: init.status ?? 200, headers: { ...HEADERS, ...init.headers } });
}

export function error(status: number, code: string, message: string, headers: Record<string, string> = {}) {
  return json({ error: { code, message } }, { status, headers });
}

// `?period=` accepts the dashboard's keys (24h, 7d, 30d, 90d, 12m); without the
// parameter the dashboard default applies. An unknown value is an error, not the default.
function periodOf(url: URL): Period | null {
  const raw = url.searchParams.get("period");
  if (raw === null) return resolvePeriod(parsePeriodKey(undefined));
  return Object.hasOwn(PERIODS, raw) ? resolvePeriod(parsePeriodKey(raw)) : null;
}

// Database lookups per minute and per truncated IP, before knowing whether the
// key is valid. Whoever uses a good key makes at most READ_API_LIMIT (60) per
// minute; the rest is slack for several clients behind the same IP.
export const LOOKUP_LIMIT_PER_IP = 120;

const UNAUTHORIZED = () =>
  error(401, "unauthorized", "Missing or invalid API key.", { "WWW-Authenticate": 'Bearer realm="stellytics"' });

export async function handleRead(
  request: Request,
  handler: (ctx: OperatorKeyContext, period: Period) => Promise<unknown>,
): Promise<Response> {
  const authorization = request.headers.get("authorization");
  // Header without the key format: 401 without touching the database or the limit.
  if (!readKeyFromHeader(authorization)) return UNAUTHORIZED();
  // Per-IP limit BEFORE the lookup, so key guesses do not cost an unthrottled
  // join per request.
  const ip = takeToken(`ip:${truncatedClientIp(request.headers.get("x-forwarded-for"))}`, Date.now(), LOOKUP_LIMIT_PER_IP);
  if (!ip.ok) {
    return error(429, "rate_limited", "Too many requests. Try again later.", {
      "Retry-After": String(ip.retryAfterSeconds),
    });
  }
  const ctx = await authenticateReadKey(authorization);
  if (!ctx) return UNAUTHORIZED();
  const rate = takeToken(`key:${ctx.keyId}`);
  if (!rate.ok) {
    return error(429, "rate_limited", "Too many requests. Try again later.", {
      "Retry-After": String(rate.retryAfterSeconds),
    });
  }
  const period = periodOf(new URL(request.url));
  if (!period) {
    return error(400, "invalid_period", `period must be one of: ${Object.keys(PERIODS).join(", ")}.`);
  }
  try {
    return json(await handler(ctx, period));
  } catch (e) {
    // Only the error name: the log carries no key, URL or Umami detail.
    console.error("Read API failure", (e as Error).name);
    return error(500, "internal_error", "Something went wrong.");
  }
}

export function periodBody(period: Period) {
  return { key: period.key, startAt: period.startAt.toISOString(), endAt: period.endAt.toISOString() };
}
