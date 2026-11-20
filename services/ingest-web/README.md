# services/ingest-web

Web ingestion gateway in Go (`net/http`). It sits between the tracking script (`packages/tracker`) and Umami, which must only be reachable on the internal network. Created in [#61](https://github.com/romulospl/stellytics/issues/61).

What it already does:

- receives the page view, checks the format and the `websiteId` and relays it to Umami's `/api/send`;
- relays the original `User-Agent`, so that Umami's bot detection keeps working;
- truncates the IP (last IPv4 octet, /48 for IPv6) before any use and hands Umami only the truncated IP, in the `CLIENT_IP_HEADER` header;
- limits the body size (16 KiB) and the rate per truncated IP;
- serves the script at `/s/vX.Y.Z/`.

Still to come: JS execution proof (#25), fingerprint limit per IP (#26), IP persistence tests (#24) and the check of the names against ad blockers (#23).

## Routes

| Route | What it does |
|---|---|
| `POST /e` | Receives the event. Accepts JSON with `Content-Type` `text/plain` (what the script uses, to avoid the CORS preflight) or `application/json`. Answers `204` when the event was relayed. |
| `GET /c?s=<website>` | Challenge of the JS execution proof (#25): `{"t":"<token>","d":<bits>}`, with `Cache-Control: no-store`. It does not query `ingest_site`, so it does not reveal whether the site exists. `400` without a UUID in `s`. |
| `OPTIONS /e` | CORS preflight, for clients that send `application/json`. |
| `GET /s/<path>` | Files from `SCRIPT_DIR`, with `Cache-Control: public, max-age=31536000, immutable` and `Access-Control-Allow-Origin: *` (SRI requires `crossorigin`). Directories and paths outside `SCRIPT_DIR` give `404`. |
| `GET /healthz` | `200 ok` when Postgres and Umami respond; otherwise `503`. The result is cached for 5 s, so that the public endpoint does not become a database query on every request. It is what external monitoring measures as web ingestion availability. |

No response sets a cookie.

### Accepted event

```json
{"type":"event","p":{"t":"<token>","n":"<nonce>"},"payload":{"website":"<uuid>","hostname":"...","url":"/path","referrer":"...","title":"...","language":"en-US","screen":"1920x1080"}}
```

- `p` is the JS execution proof (see below) and never reaches Umami. An event without a valid proof gets `204` and is dropped.

- `type` must be `event`, `website` a UUID and `url` cannot be missing.
- Maximum sizes: `url` and `referrer` 2048 bytes, `title` 500, `hostname` 253, `language` 35, `screen` 16.
- **Custom event (#50, ADR 0008):** `payload.name` and `payload.data` are optional. `name`: 1 to 50 characters `[A-Za-z0-9_.:-]`, starting with a letter or digit. `data`: flat object with up to 10 properties, key of up to 40 characters `[A-Za-z0-9_.-]` starting with a letter or digit, value a string (up to 100 bytes), a finite number (literal of up to 32 characters) or a boolean; null, list, nested object and `data` without `name` give `400`. Only these two fields, already validated, are relayed to Umami.
- The payload relayed to Umami is rebuilt with only these fields. Any other (`id`, `ip`, `userAgent`, `timestamp`...) is dropped, because Umami would let the client change the IP, the UA or the session identity with them.
- Only the `Content-Type` and `User-Agent` headers and the `CLIENT_IP_HEADER` one reach Umami.

### Error responses

| Status | When |
|---|---|
| `400` | Invalid JSON or JSON outside the format above |
| `413` | Body larger than 16 KiB |
| `415` | `Content-Type` other than `text/plain` and `application/json` |
| `429` | Rate above the limit for the truncated IP |
| `502` | Umami refused the event or did not respond |
| `503` | Failure querying `ingest_site` |

## JS execution proof (#25)

1. The script requests `GET /c?s=<website>` once per page load, and again every 5 minutes on pages left open for a long time.
2. The token is 32 bytes in base64url: the issue time, 8 random bytes and a truncated HMAC-SHA256 over both and the `website`, with the `PROOF_SECRET` key.
3. The script looks for a decimal `nonce` such that `SHA-256(token + ":" + nonce)` starts with `d` zero bits (12 by default, about 4,000 attempts with `crypto.subtle`, a few tens of milliseconds).
4. Each event carries `{"t": token, "n": nonce}`. The gateway checks the HMAC, the site, the validity (`PROOF_TTL`, with 1 minute of tolerance for a clock running ahead) and the work.

A `curl` that only repeats the `POST /e` has no valid token, and the event is dropped. Whoever reimplements the flow outside the browser gets the proof: the goal is to remove the cheap traffic and make the rest more expensive. Umami's bot detection keeps working, because the `User-Agent` is relayed. #26 completes it with the fingerprint limit per IP.

`crypto.subtle` only exists in a secure context (HTTPS or `localhost`). On a page served over plain HTTP, the script cannot get the proof and sends no events.

## Fingerprint limit per IP (#26)

The fingerprint is a hash of `User-Agent`, `Accept-Language`, and the event's language and screen. It stays only in memory and does not identify a person, because many people have the same combination.

- Per truncated IP and site, the gateway accepts up to `FINGERPRINT_LIMIT` distinct fingerprints seen within `FINGERPRINT_WINDOW`. The count is separate per site so that a bot in the same /24 (or behind the same CGNAT), filling the quota of its own site, does not take the slots of other tenants' sites.
- The window is sliding: each event renews its fingerprint, and those that stay idle for longer than the window free the slot.
- Events from a new fingerprint, beyond the limit, get `204` and are dropped. The fingerprints that were already on the IP keep counting.

This way, a bot that changes `User-Agent` on every request, from a single IP, does not inflate the metrics.

The default is generous (50 in 10 minutes) because the truncated IP groups a whole /24, and a company, university or carrier with CGNAT has many legitimate browsers. The cost of the rule is that, in a /24 with more than 50 active browsers on the same site, those that arrive later only start counting when slots stay idle for the whole window. With `0`, the check is off.

## Umami saturation (`RELAY_MAX_INFLIGHT`)

Umami saturates near 200 page views per second per instance (`docs/reports/load-1m-per-day.md`). Without a limit, the gateway holds each `POST /e` until Umami writes it: at 400/s the latency reached 5 to 10 s and the gateway's memory went past 350 MB. With `RELAY_MAX_INFLIGHT` greater than zero, only the **relay to Umami** goes through a semaphore; the JS proof, `GET /c`, `GET /s/`, `GET /healthz`, the per-IP limit, `ingest_site` and fingerprints do not change, and neither does their order.

- Whoever arrives without a free slot waits up to `RELAY_QUEUE_WAIT`; then gets `204` and the event is dropped. The loss is recorded in the aggregated log.
- A drop caused by saturation **does not spend the fingerprint quota** of the IP (the fingerprint that has just entered the count is removed).
- The operator sees the drop rate in one log warning per minute, only when the total changes: `events dropped because the relay to umami is saturated` with `dropped`, `total` and `in_flight` (no IP, `User-Agent` or site ID). The metrics dashboard does **not** show what was dropped: during saturation the visits are undercounted.
- The slot is returned on any exit (error, timeout, cancellation, panic). With `RELAY_MAX_INFLIGHT=0` the semaphore is not even built and the behaviour is the same as before.
- The `204` response avoids telling saturation apart, by status, from the drops by site or fingerprint; timing differences may still exist.
- The limit is per process: with several gateway instances, the total to Umami is the sum. With a limit of at least 2, each site can occupy at most one slot fewer than the total, reserving one slot for other sites. That reserve may stay idle; with a limit of 1 there is no protection between sites. Several sites can still exhaust the slots together ([ADR 0011](../../docs/decisions.md#0011-umami-relay-limit)).
- Historical measurement with a `503` response on saturation, at 400 page views/s for 60 s, on this machine: without a limit, 5.6 to 10 s of latency on the accepted ones, 16,192 of 23,907 in `502` and 355 MB; with `RELAY_MAX_INFLIGHT=16` and `RELAY_QUEUE_WAIT=50ms`, p99 of 202 ms on the accepted ones, 31 MB, and every event that got `204` was written to Umami (about 53% of the requests refused, because the limit does not increase Umami's capacity). At 116/s (the RFP peak) with 16 slots there was no `503`. Full table, tested values and what was not tested are in ADR 0011. There is no recommended default for production yet, and the variables are passed through by the production Compose.

## Database contract: `ingest_site`

The gateway connects to the `stellytics` database as the `stellytics_ingest` user and only reads the view `ingest_site(umami_website_id uuid, accepts_ingest boolean)` (E2 spec, sections 4 and 6). `accepts_ingest` is true for a non-archived site of an active tenant. The answers, positive and negative, stay in memory for `SITE_CACHE_TTL` (at most 1 minute).

**Stale cache when the database goes down (`SITE_STALE_TTL`, off by default).** With `SITE_STALE_TTL` greater than zero (at most `1h`), if the `ingest_site` query fails, the gateway uses the last **accepted** answer for the same site for up to that long **after** it expires, instead of answering `503`. Rules: a site never seen, unknown or refused gets no stale answer and stays with `503` (never "accept by default"); once `SITE_STALE_TTL` has passed, the `503` returns. Accepted and refused sites are kept in separate maps, each capped at 10,000 entries, so whoever probes made-up IDs only fills the map of refused ones and does not evict an accepted site. After a failure, a simple circuit breaker avoids new queries for 2 s: the stale answer goes out immediately and a single background probe tests the database (without it, with the database hanging, each request would wait for the query's 5 s cap). The counter of stale answers goes to the log as one aggregated warning per minute (`responses`, `total`), with no IP, `User-Agent` or site ID. **Risk window:** a site archived or a tenant removed while the database is down keeps accepting events until `SITE_CACHE_TTL` + `SITE_STALE_TTL` after the last successful query; the refusal only takes effect when the database comes back. Choose `SITE_STALE_TTL` with that window in mind.

**With `SITE_STALE_TTL=0`** nothing stale is served and the database error still becomes `503`. What changed, even when off: the query is now shared per site (only one in flight, with the error shared among those waiting), runs with its own context and a 5 s cap, and cancelling the request returns the context error (also `503`). The circuit breaker only acts with stale on.

- A site that is unknown or does not accept ingestion gets `204`, like an accepted event, and the event is dropped. This way, whoever probes IDs does not find out which ones exist.
- The `stellytics_ingest` user comes from `infra/compose/postgres/init/02-ingest-roles.sh`, and the view and the `GRANT` come from the migration `apps/portal/drizzle/0002_ingest_views.sql`.
- The integration test (`internal/site/pg_test.go`) applies the portal migrations when the view does not exist, and creates tenants and sites in the real tables.

## Client IP

It comes from `RemoteAddr`. `X-Forwarded-For` is only read when the connection arrives from a CIDR in `TRUSTED_PROXIES` (Caddy on the Docker network, in production); in that case the client is the first address, from right to left, that does not belong to a trusted proxy. The full IP only exists in the request's memory: the rate limit and the relay use the truncated IP.

## Privacy (#24)

- **IP:** Umami receives only the truncated IP (last IPv4 octet zeroed, IPv6 cut at /48) and geolocates from it. The full IP does not go to the database, the log or the cache.
- **Logs:** no record carries IP, `X-Forwarded-For` or `User-Agent`. A panic is handled by the gateway itself, because `net/http` would log it with the client's address.
- **Cookies:** no response sets a cookie, and the incoming `Cookie` is not relayed to Umami. The script uses neither cookies nor storage (see `packages/tracker`).
- **Personal data:** Umami stores browser, system, device type, screen, language and the country, region and city of the truncated IP. None of this identifies a person, so there is no data subject to erasure.
- **Tests:** `privacy_test.go` (logs and cookies) and `e2e/privacy_test.go`. The latter sends known IPs through `X-Forwarded-For` and checks two things: that the session's country in Umami came from the truncated IP, and that no text column in the `umami` and `stellytics` databases contains the full IP.

## Configuration

| Variable | Default | Use |
|---|---|---|
| `DATABASE_URL` | required | `stellytics` database with the `stellytics_ingest` user |
| `UMAMI_URL` | required | Umami base URL on the internal network (e.g. `http://umami:3000`) |
| `LISTEN_ADDR` | `:8080` | HTTP address |
| `CLIENT_IP_HEADER` | `x-stellytics-client-ip` | Header with the truncated IP; the `umami` service uses the same variable |
| `SCRIPT_DIR` | empty (`/scripts` in the image) | Directory served at `/s/`; empty turns the route off |
| `TRUSTED_PROXIES` | empty | CIDRs or IPs, comma-separated |
| `RATE_LIMIT` | `20` | Events per second per truncated IP |
| `RATE_BURST` | `40` | Token bucket burst |
| `SITE_CACHE_TTL` | `1m` (`5s` in Compose) | Cache of the `ingest_site` answers |
| `SITE_STALE_TTL` | `0` (off) | How long a stale `ingest_site` answer is still valid when the database fails (0 to 1h) |
| `PROOF_SECRET` | generated at startup | Key for the challenges, with 32+ characters. Set it in production: the generated key is not valid across restarts or across replicas |
| `PROOF_BITS` | `12` | Proof difficulty (0 to 24) |
| `PROOF_TTL` | `10m` | Validity of a challenge (1m to 1h) |
| `FINGERPRINT_LIMIT` | `50` | Distinct fingerprints per truncated IP and site in the window (0 to 1000; 0 turns it off) |
| `FINGERPRINT_WINDOW` | `10m` | Sliding window of the fingerprints (1m to 24h) |
| `RELAY_MAX_INFLIGHT` | `0` (off) | Maximum number of relays to Umami at the same time (0 to 100000); see "Umami saturation" |
| `RELAY_QUEUE_WAIT` | `250ms` | How long an event waits for a relay slot before being dropped with `204` (0 to 10s; `0` refuses immediately) |

## Development

From inside `services/`:

```bash
go test -race ./ingest-web/...
```

The integration test of the `site` package runs when `DATABASE_URL` points to the `stellytics` database. It needs the users from `infra/compose/postgres/init/02-ingest-roles.sh` and never applies migrations to the `DATABASE_URL` database: they belong to the portal, which records them in Drizzle. With a user that can create databases (CI), the test creates a temporary database, applies the migrations there and drops it at the end. With the Compose `stellytics` user, it uses the database already migrated by the portal, or is skipped if the portal has not started yet. Then it connects as `stellytics_ingest`, with the password `stellytics_ingest` or through the URL in `INGEST_DATABASE_URL`.

The end-to-end test needs the Compose environment up, with Umami published by the development override (it uses Umami's admin API):

```bash
docker compose -f compose.yaml -f infra/compose/umami-port.yaml up -d --build --wait
```

```bash
go test -tags e2e -count=1 ./ingest-web/e2e/...
```

It creates a website in Umami through the API (`admin`/`umami`) and an active tenant with that site in the `stellytics` database. Then it sends page views to the gateway (port 3002) and checks what reaches Umami. `TestRecorderRecordsNothing` checks that session recording and heatmaps record nothing ([docs/umami.md](../../docs/umami.md)). The privacy test needs the gateway to trust the test's `X-Forwarded-For`: bring Compose up with `INGEST_TRUSTED_PROXIES=172.16.0.0/12,192.168.0.0/16,10.0.0.0/8`, as in CI. The URLs can be overridden with `GATEWAY_URL`, `UMAMI_URL`, `STELLYTICS_DATABASE_URL` and `UMAMI_DATABASE_URL`.

The image (`Dockerfile`, context at the repository root) is `scratch` with the binary and the published versions of the script, copied from `packages/tracker/published` when the directory exists. The container healthcheck is `ingest-web -healthcheck`.
