import { isIP } from "node:net";

// Truncated client IP, only for the in-memory request limit of the read API
// (#48). It is never stored or logged.
//
// In production the portal is only reached through Caddy, which has no
// trusted_proxies: it discards the incoming X-Forwarded-For and writes the
// connection's IP. That is why the LAST entry of the header counts (the one
// Caddy added), never the first, which the client controls. If the portal were
// exposed without Caddy, the header could be forged and the per-IP limit would
// not hold. With no header (local development), everyone falls in the same bucket.

export function truncatedClientIp(forwardedFor: string | null): string {
  const last = forwardedFor?.split(",").at(-1)?.trim() ?? "";
  const family = isIP(last);
  if (family === 4) return `${last.split(".").slice(0, 3).join(".")}.0`;
  if (family === 6) {
    // /48: the first three groups, after expanding the "::".
    const [head, tail = ""] = last.split("::");
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
    return `${groups.slice(0, 3).join(":")}::/48`;
  }
  return "unknown";
}
