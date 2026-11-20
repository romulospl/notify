# 0006. SCF read API with operator keys

- **Status:** Accepted
- **Date:** 15/11/2026
- **Issue:** [#48](https://github.com/romulospl/stellytics/issues/48)

## Context

SCF operators see the metrics of all projects in the portal dashboards. Issue #48 asks that they can generate, list and revoke API keys and that other systems (spreadsheets, Grafana, SCF reports) can read the same metrics through an API authenticated by the key. The key is a read key: it writes nothing, and it must not be confused with the ingest key (`ntf_`, accepted only by the collector).

ADR 0003 makes the portal the owner of isolation: data access goes through functions that receive a typed context created from the session. The read API has to follow the same rule, with the key in place of the session.

## Decision

- **Format:** `nrk_<prefix>_<secret>`, the same structure as the ingest key (8-character base32 prefix, 32-byte secret in base64url). The `nrk_` marker is different from `ntf_`: the collector rejects it by format and the read API also rejects `ntf_`. The database stores only the prefix and the SHA-256; the full key exists only in the creation response.
- **Table `operator_api_key`** (migration 0006, privileges in 0007): name given by the creator, unique prefix, hash, creator, dates and last use (at most one write per day). `stellytics_ingest` and `stellytics_collector` have no permission on the table. Creating and revoking go to the `audit_log` (`operator_api_key.created` and `.revoked`, without a tenant, with the prefix and the name, never the key).
- **Single scope:** every key reads the global metrics of the active projects, exactly what the `/operator/web` and `/operator/api` dashboards show, and nothing beyond that (no email, Umami ID or visitor data). A removed or pending project does not appear, as in the dashboards. There is no per-project scope and no write scope.
- **The key is valid while the operator who created it is an operator.** Authentication checks the creator's `user.role = 'operator'` on every call, so demoting an operator disables their keys without an extra step. Any operator sees and revokes everyone's keys (there is a single team; the `audit_log` says who did what). Maximum of 20 active keys.
- **Where it runs:** in the portal itself, in `/api/v1/*` routes (Next.js Route Handlers). `authenticateReadKey` (in `src/lib/access.ts`, the only place that creates contexts) returns an `OperatorContext`, and the routes use the same functions from `src/lib/data/operator/` and `src/lib/umami/overview.ts` as the dashboards. The boundaries lint still applies.
- **Routes (v1), `GET` only:** `/api/v1/projects` (active projects with counts), `/api/v1/web?period=` (views, visitors, visits, bounces and time, with the previous period) and `/api/v1/api?period=` (requests, 4xx, 5xx, p50 and p95 in seconds). `period` accepts `24h`, `7d` (default), `30d`, `90d` and `12m`, in UTC; an unknown value answers 400 (unlike the screen, which falls back to the default).
- **No pagination in v1.** The responses have one row per active project, and the number of projects in the ecosystem is small (tens to a few hundred). If it grows beyond that, v2 gets cursor pagination; the `/v1` prefix exists for that.
- **Request limit, in memory, per instance:**
  - per key: 60 per minute once authenticated (fixed window), 429 with `Retry-After`. `/web` makes one call to Umami per site, so the limit protects Umami;
  - per truncated IP, **before** the database query: 120 key lookups per minute (IPv4 /24, IPv6 /48). Only a header in the `nrk_<8>_<43>` format counts; everything else gets 401 without touching the database or the limit. The IP comes from the last entry of `X-Forwarded-For`, the one Caddy writes (it has no `trusted_proxies`, so it discards the one the client sent, and the portal does not publish a port in `prod.yaml`). Outside Caddy, without the header, everyone falls into a single bucket.
- **Error responses** do not say why the key was rejected: 401 with the same status, body and headers for missing, malformed, unknown, wrong, revoked or belonging to a former operator (tested). The `Bearer` scheme is case-insensitive (RFC 7235). All of them carry `Cache-Control: no-store`.
- **No CORS, on purpose:** the API is server to server. The portal does not answer the preflight or send `Access-Control-Allow-Origin`, so a browser from another origin does not read the responses, and the key must never go into browser code.
- **Last use** (`last_used_on`) is written on a best-effort basis: if the write fails, the call continues with 200 and the log carries only the error name.

## Alternatives considered

| Alternative | Pros | Cons |
|---|---|---|
| Separate service (Go or Node) for the read API | Scales and deploys separately | A second data access path outside the single layer of ADR 0003; duplicates the dashboard queries |
| Reuse the ingest key (`ntf_`) with a scope | A single key per concept | The ingest key belongs to a tenant and sits in public apps; the read key is global and sensitive. Mixing them risks one opening the door for the other |
| Better Auth session token (API key plugin) | Ready-made, with a built-in limit | Better Auth telemetry and sign-up are limited on purpose (#60); the plugin would bring a second key model different from the ingest one |
| Per-project key (per-tenant scope) | Smaller reach | It is not what the issue asks for (global consumption by the SCF); the tenant already has its own dashboard |
| Redis or a table for the request limit | Holds across instances | One more piece for a few keys; it can come later without changing the API |

## Consequences

- Easier: the SCF feeds other systems without accessing Umami or the database, and each key can be revoked without affecting the others. The API numbers are the same as the dashboards'.
- Revocation takes effect on the next call (no key cache).
- The read key is a high-reach credential: it gives a global view. It stays out of any view accessible to the gateway and the collector, and the hash never leaves the database.

### Risks and open items

- **Open item: Caddy does not limit per IP.** The `Caddyfile` and the Caddy image in `prod.yaml` have no request limit module, and this decision changed neither of them. Caddy does only two things here: forward `/api/v1` to the portal (the portal host route covers everything) and write the real IP in `X-Forwarded-For`. The per-IP limit belongs to the portal, in memory and per instance: it is lost on restart and does not add up across instances. A distributed attack (many IPs) is not contained by it. If this becomes a problem, the next step is a limit at the proxy (a Caddy image with a rate limit module, or a firewall) or a shared limit; it was not done.
- **What the rejection reveals.** The path for a nonexistent prefix, a revoked key or a former operator's key answers without computing the SHA-256, so an attacker with fine-grained timing measurement can tell "active prefix" from "nonexistent or inactive prefix". This reveals only whether the prefix exists and is active, and the prefix is already public (it appears on the `/operator/keys` screen for every operator). The secret is compared in constant time.
- **Single, global scope:** leaking a key exposes the metrics of all active projects until revocation. Mitigation: immediate revocation, 20 keys at most, auditing of creation and revocation. There is no read auditing (only `last_used_on`, daily).
- The per-key limit is also per instance.
- `/web` depends on Umami: with Umami down, the project comes with null `totals` and `unavailable` greater than zero, instead of an error.

### Tests

- `apps/portal/test/read-api.test.ts`: format, key lifecycle, hash and audit_log, identical 401 in all cases, case-insensitive Bearer, failure writing the last use, per-key and per-IP limit (no database query after the limit), responses and invalid period.
- `apps/portal/test/isolation.test.ts`: a tenant and a user without a project neither generate nor revoke a key, an ingest key does not read the API, a read key does not exist for the collector and the `stellytics_ingest` and `stellytics_collector` roles do not read the table, a removed tenant disappears.
- `services/collector/components/ingestkeyauth/auth_test.go`: the collector rejects `nrk_`.
