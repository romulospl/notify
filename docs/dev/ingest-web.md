# Web gateway (`services/ingest-web`)

Routes, responses and variables are documented in the folder's `README.md`. Anti-bot layers and limits in `docs/anti-bot-e-cadeia-de-suprimentos.md`. There is no E3 spec; the contract is here and in the gateway and tracker READMEs.

- `main.go` only builds the configuration and the server; routes in `handler.go`; packages in `internal/` (`config`, `clientip`, `limit`, `site`, `relay`, `proof`, `fingerprint`).
- Routes: `POST /e` (JSON with `Content-Type` `text/plain` or `application/json`, open CORS, no cookies), `GET /c` (JS proof challenge), `GET /s/` (files from `SCRIPT_DIR`, one-year immutable cache) and `GET /healthz`.
- Order in `POST /e`: JS proof, `ingest_site`, fingerprints, relay.

## Layers

- **JS execution proof (#25, `internal/proof`):** `GET /c?s=<website>` returns an HMAC-signed token (`PROOF_SECRET`); the script finds a nonce with `PROOF_BITS` leading zero bits in SHA-256 and sends `p:{t,n}` with each event. Without a valid proof: `204` and drop. The proof is never relayed to Umami. In Go tests, `proof.Solve` plays the script's role.
- **`ingest_site` contract** (E2 spec, sections 4 and 6): the gateway connects as `stellytics_ingest` and only reads `ingest_site(umami_website_id, accepts_ingest)`, created by `apps/portal/drizzle/0002_ingest_views.sql`. A refused site gets the same response as success (`204`) and the event is dropped; cache of at most 1 minute.
- **Fingerprints per IP (#26, `internal/fingerprint`):** hash of UA, `Accept-Language`, language and screen, in memory only. Per truncated IP and site (separate per site so one tenant cannot exhaust others' quota), accepts up to `FINGERPRINT_LIMIT` distinct fingerprints in a sliding window (`FINGERPRINT_WINDOW`); new ones beyond that get `204` and are dropped.

## Relay to Umami

- The payload relayed to `UMAMI_URL/api/send` is rebuilt with only `website`, `hostname`, `url`, `referrer`, `title`, `language` and `screen`. Never relay the client's `ip`, `userAgent`, `id` or `timestamp`: Umami would accept them and the client could change IP or session.
- Umami only receives `Content-Type`, the original `User-Agent` and the **already truncated** IP (`clientip.Truncate`) in the `CLIENT_IP_HEADER` header. `X-Forwarded-For` is only trusted from `TRUSTED_PROXIES`.
- **Stale cache (#52, PR #127):** `SITE_STALE_TTL` (default `0`, max 1 h) in `internal/site`: with the database down, serves the last answer for an ACCEPTED site for up to that time (2 s circuit breaker); never seen, unknown or refused sites return 503 after the TTL. A tenant removed during the outage keeps accepting events for up to `SITE_CACHE_TTL` + `SITE_STALE_TTL`. Not passed in `prod.yaml` or `prod-ingest.yaml`.
- **Relay limit (PR #130, ADR 0011):** `RELAY_MAX_INFLIGHT` (default `0`, off) and `RELAY_QUEUE_WAIT` (default 250 ms) in `internal/relay/limited.go`: with no slot in time, `POST /e` answers `503` with `Retry-After`, the event is lost and the just-admitted fingerprint returns to the quota. The `503` only happens for an accepted site within quota, which reveals site status and quota under saturation: **maintainer decision pending** (ADR 0011), so do not enable it in production yet. Not passed in `prod.yaml` or `prod-ingest.yaml`.

## Privacy (#24)

- No log carries IP, `X-Forwarded-For` or `User-Agent`; no response sets a cookie.
- The e2e `services/ingest-web/e2e/privacy_test.go` scans the text columns of the `umami` and `stellytics` databases for the full IP and checks that geolocation uses the truncated IP. It requires the gateway to trust the test's `X-Forwarded-For` (`INGEST_TRUSTED_PROXIES`, set in the CI `compose` job).

## Image

`scratch` (no shell); the healthcheck is `ingest-web -healthcheck`. It copies `packages/tracker/published` to `/scripts` when the folder exists.
