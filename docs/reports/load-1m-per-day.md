# Load test: 1 million requests per day (#51)

Date: 2026-11-15. Tool: `services/loadtest` (see the folder's `README.md`).
All the numbers below came from the runs described here; nothing was
extrapolated without being marked as an estimate.

## Summary

- **Target load met on this local machine, without Caddy, TLS, containers or Hetzner hardware; this is not proof of production.** The average of 1M/day is 11.6/s; we ran 10 min at that rate, 5 min at 10x (116/s) and 5 min back at the average, with web and API at the same time.
- **Web:** 45,029 page views, 100% stored in Umami, zero errors, zero 429. Latency of `POST /e` at the 10x peak: p50 8.1 ms, p95 63 ms, p99 244 ms.
- **API:** 1,051,022 simulated requests in 4 minutes (average of 4,379/s, peak of 10,000/s, that is, a whole 1M/day in 4 min), through spans. Everything stored in `api_metric_1m`, exact count, collector at 0.08 core.
- **Bottleneck found: Umami**, not the gateway or the collector. It saturates near 200 page views/s (one Node core). Above that the latency of `POST /e` goes over 5 s and the gateway accumulates requests in memory, without refusing (pending item 1).
- **Disk:** Umami grew about 0.9 KB per page view (estimate of 0.9 GB/day at 1M page views/day; see "Disk"). The API metrics are cheap (181 bytes per 1-minute row).
- Nothing was changed in the pipeline. The "Bottlenecks and pending items" section lists 3 items: a product pending item (Umami and gateway under saturation, with issue text ready), an expected behaviour (duplicated route names in spans) and an error fixed in the load tool itself.

## What "1 million requests per day" means

1M/day = 11.57/s on average. Real traffic is not uniform, so besides the average
we used **10x the average** (116/s) for 5 minutes as the peak. The rationale: sites of
Stellar ecosystem projects have launch, airdrop and news peaks that
usually concentrate several times the average in a few minutes; 10x covers that and is
an easy number to check. After the peak, a return to the average shows whether the
system recovers. Then, increasing steps show where each pipeline
saturates.

The unit changes per pipeline:

- **Web:** 1 request = 1 page view. Each one costs 2 calls to the gateway (`GET /c` for the challenge and `POST /e`), that is, 1M page views/day = 2M HTTP calls/day to the gateway.
- **API:** 1 request = 1 HTTP request that the tenant's backend served. What is sent to the collector is not each request: the OTel SDK aggregates into histograms and exports every N seconds (`metrics` mode, the normal and lightest path) or sends one span per request (`spans` mode, the worst case for the collector). We tested both.

## Environment

- Local development machine, **does not represent the production Hetzner**: Intel Core i5-12450H (12 threads), 15 GiB of RAM, Linux, network over loopback. Other programs and agents were running on the same machine (load of 0.92 in the minute before the main run), which makes the measurements a little noisy.
- PostgreSQL 17.11 and Umami 3.4.1 (the images from `dev.yaml`) in Compose containers, project `stellytics51`, without CPU or memory limits, default `shared_buffers` of 128 MB.
- **Gateway (`ingest-web`), collector and `rollup` ran as Go binaries on the host**, not in containers: the machine's Docker has no BuildKit and the Dockerfiles use `--mount=type=cache`. The binaries are the repository's (`go build -trimpath`), with the same variables as `dev.yaml`: `PROOF_BITS=12`, `RATE_LIMIT=20`, `RATE_BURST=40`, `FINGERPRINT_LIMIT=50`, `SITE_CACHE_TTL=5s`, `INGEST_KEY_CACHE_TTL=5s`, `TRUSTED_PROXIES=127.0.0.0/8` (so the generator can send distinct IPs in `X-Forwarded-For`). The collector used a copy of `config.yaml` with only the ports changed (14317/14318).
- CPU and memory: for the binaries, from `/proc` (CPU in cores, 1.0 = one whole core; memory is the RSS); for the containers, from `docker stats`. Samples every 2 s.
- The portal migrations were applied directly with `psql` (the portal was not started), the same ones from the `apps/portal/drizzle` folder.

## Method

`loadtest setup` creates a site in Umami and, in the `stellytics` database, a tenant with that site and another tenant with 4 API services that send metrics and 2 that send only spans (each with its own `ntf_...` key, created the way `compose-check.sh` does). Then:

- **web:** Poisson arrivals (the pace does not wait for the responses). Each page view does `GET /c`, solves the JS proof (SHA-256 with 12 bits, the same algorithm as `internal/proof`, repeated in the generator because Go does not allow importing an `internal` package from another directory) and sends `POST /e` with `Content-Type: text/plain`. 20,000 simulated visitors, each with an IP in its own /24 (via `X-Forwarded-For`), fixed UA, language and screen, so that the per-IP limit and the fingerprint limit behave as with different visitors. At the end, it counts the `website_event` rows of the site in the Umami database and compares them with the `204` responses received. Since the gateway also responds 204 when dropping, **only that count tells whether the event arrived**.
- **api:** simulates the services, which export OTLP/HTTP in protobuf with `Authorization: Bearer`. Routes with and without `http.route` (the ones without go through the collector's normalization), status 95% 200 / 3% 404 / 1.5% 400 / 0.5% 500, lognormal latency with a median of 40 ms. Metrics: delta histograms every 10 s (the SDK uses 60 s by default; 10 s is more demanding). Spans: batches of up to 512 or every 1 s. At the end, it compares `sum(request_count)` of `api_metric_1m` per service with what was in exports that received 2xx.

Runs: (1) main, web and API at the same time, profile `11.6x10m,116x5m,11.6x5m`; (2) steps of web alone, `50,100,200,400,800` page views/s for 1 min each; (3) steps of the API with spans only, `500,2000,5000,10000`/s for 1 min each; (4) `api_metric_maintain` (rollup) measured with real data and with a seeded 35-day volume; (5) sizes on disk.

## Results

### 1. Main run (web and API together, 20 min)

Web, page views started: 6,943 (average 11.57/s) + 34,671 (115.6/s) + 3,415 (11.4/s) = 45,029. Latency in ms or µs seen by the generator, on loopback.

| step | operation | n | p50 | p95 | p99 | max | codes |
|---|---|---|---|---|---|---|---|
| 11.6/s, 10 min | `GET /c` | 6,943 | 0.42 ms | 1.27 ms | 1.53 ms | 4.63 ms | 200=6,943 |
| | `POST /e` | 6,943 | 11.71 ms | 25.75 ms | 52.7 ms | 163 ms | 204=6,943 |
| 116/s, 5 min | `GET /c` | 34,671 | 0.23 ms | 0.62 ms | 0.99 ms | 21.5 ms | 200=34,671 |
| | `POST /e` | 34,671 | 8.14 ms | 63.17 ms | 244.07 ms | 660 ms | 204=34,671 |
| 11.6/s, 5 min | `GET /c` | 3,415 | 0.84 ms | 1.35 ms | 1.54 ms | 2.54 ms | 200=3,415 |
| | `POST /e` | 3,415 | 12.59 ms | 24.41 ms | 27.9 ms | 69.9 ms | 204=3,415 |

- Network or challenge errors: 0. 429 responses: 0. Generator saturation: 0.
- **Stored in Umami: 45,029 of 45,029 (100%); dropped or lost: 0.**
- `POST /e` waits for Umami to write (synchronous relay), so its latency is Umami's; `GET /c` only signs a token.
- The JS proof on the client cost p50 0.3 to 1 ms and p99 up to 6.9 ms (generator CPU, desktop; does not measure a phone).

API: 45,454 simulated requests (4 services in metrics, 2 in spans), 1,028 + 600 + 526 span exports and 236 + 120 + 124 metric exports, **all 200**; collector latency per export p99 from 2.4 to 4.2 ms (metrics) and from 1.9 to 3.7 ms (spans). Failed exports: 0.

| service | mode | sent with 2xx | stored in `api_metric_1m` |
|---|---|---|---|
| 4 services | metrics | 7,607 / 7,683 / 7,550 / 7,534 | 7,607 / 7,683 / 7,550 / 7,534 |
| 2 services | spans | 7,514 / 7,566 | 7,514 / 7,566 |
| total | | 45,454 | 45,454 |

**Honesty note:** the raw output of this run showed 45,634 stored (+180). It was the sum of a 10 s smoke test I ran before, with the same services (34+28+42+22+28+26 = 180, per service exactly the difference). The tool counted the service's total in the database, without subtracting what was already there; I fixed it to measure the baseline before the test and checked with a clean run afterwards (`11.6x2m`: 1,312 simulated, 1,312 sent, 1,312 stored). No duplicated or lost row.

In all the `api_metric_1m` rows of the tenant at the end (3,984,673; the 3,983,970 in other passages of the report were counted at another moment, before the clean 2-min run and the steps run; this includes the seeded volume, see below), the buckets add up to the count and the duration sum is positive. Route `{other}` (cap of 500 routes): 0.

Resources in the main run (average / peak in cores; peak memory):

| process | 11.6/s | 116/s | 11.6/s |
|---|---|---|---|
| gateway | 0.01 / 0.03 (23 MB) | 0.07 / 0.09 (40 MB) | 0.02 / 0.07 (40 MB) |
| collector | 0.01 / 0.02 (43 MB) | 0.00 / 0.01 (21 MB) | 0.01 / 0.02 (20 MB) |
| Umami (container) | 0.10 / 0.30 (262 MB) | 0.46 / 0.64 (304 MB) | 0.12 / 0.31 (298 MB) |
| Postgres (container) | 0.04 / 0.10 (60 MB) | 0.17 / 0.28 (104 MB) | 0.04 / 0.16 (99 MB) |

### 2. Web steps (where it saturates)

Profile `50,100,200,400,800` page views/s, 1 min each, `-max-inflight 2000`.

| rate | `POST /e` p50 | p95 | p99 | max | page views done | Umami (cores, average) |
|---|---|---|---|---|---|---|
| 50/s | 10.2 ms | 29.8 ms | 56.9 ms | 123 ms | 2,930 | 0.27 |
| 100/s | 8.0 ms | 33.1 ms | 50.2 ms | 94.8 ms | 5,940 | 0.45 |
| 200/s | 8.9 ms | 428 ms | 716 ms | 894 ms | 11,929 | 0.69 |
| 400/s | 5.48 s | 7.05 s | 7.20 s | 7.26 s | 21,646 | 1.08 |
| 800/s | 5.65 s | 7.78 s | 7.94 s | 8.05 s | 19,528 | 1.06 |

- Still 100% stored in Umami (61,973 of 61,973), without 429 or errors. But from 200/s the p95 already goes over 400 ms, and from 400/s the gateway spends 5 to 8 s waiting for Umami.
- The generator hit the cap of 2,000 in flight and did not start 30,707 arrivals (those at 400/s and 800/s). What went beyond the sustained 200/s was the queue of the previous step being drained, not sustained capacity: in total, 61,973 page views in 302 s ≈ 205/s. **Measured sustained capacity of the web pipeline on this machine: about 200 page views/s**, ~17x the target average and ~1.7x the 10x peak. Umami reached 1.0 to 1.4 core (Node is single-threaded) and 1.37 GB; the gateway 0.14 core and 220 MB (because of the waiting requests); Postgres 0.36 core.

### 3. API steps (spans only, the worst case)

Profile `500,2000,5000,10000` requests/s, 1 min each, 2 services.

| rate | exports | p50 | p95 | p99 | collector (cores average / peak) | collector memory |
|---|---|---|---|---|---|---|
| 500/s | 118 | 1.56 ms | 4.0 ms | 4.8 ms | 0.01 / 0.02 | 21 MB |
| 2,000/s | 276 | 1.56 ms | 3.1 ms | 3.8 ms | 0.02 / 0.03 | 22 MB |
| 5,000/s | 612 | 1.36 ms | 2.6 ms | 3.7 ms | 0.04 / 0.05 | 24 MB |
| 10,000/s | 1,212 | 1.21 ms | 2.5 ms | 3.6 ms | 0.07 / 0.08 | 25 MB |

- Total: **1,051,022 simulated requests in 4 min; sent 1,051,022; stored 1,051,022** (525,190 and 525,832 per service). Failed exports: 0.
- The collector did not saturate up to 10,000/s (860x the target average); the limit here was what the generator can emit, not the collector. We did not find the collector's ceiling.

### 4. Rollup and retention (`api_metric_maintain`)

- Real data (2,370 1-min rows, hour still open): 13 ms; the `rollup` service ran twice by itself (24 ms and 7.4 ms). Since only hours closed 5 min ago are included, nothing was rolled up in that hour.
- To measure a real load, **I seeded through SQL** 3,981,600 rows: the 2,370 real rows repeated 1,680 times with `bucket_start` shifted by 30 min each, covering 35 days (the 1m retention). **It is synthetic volume with the shape of the real data**, equivalent to about 2.2M requests/day and 114 thousand rows/day (double the target load; the real profile had 6 services and 12 routes). With 3,983,970 rows in `api_metric_1m`: `api_metric_maintain(48h)` took **2.55 s** the first time and **2.58 s** the next, with nothing more to move from the default partition; both times are, therefore, the cost of rolling up the 48 h. Result: 11,376 rows in `api_metric_1h` and 711 in `api_metric_1d`, both adding up to 4,380,864 requests.
- That is much less than the job's 15 min interval.

### 5. Disk

- `api_metric_1m`: 689 MiB (`pg_size_pretty`) for 3,983,970 rows (3,981,600 seeded + 2,370 real) with indexes, ≈ 181 bytes per row. The 2,370 real rows alone took 1,496 KiB, ≈ 646 bytes per row: in a small table the page and index overhead weighs in, so the figure of 181 B/row holds for large volume, not for the start of the day. `api_metric_1h`: 7.8 MB for 11,376 rows. In the real profile, 2,370 rows (1,496 kB) for 45,634 requests, that is ≈ 5% of rows per request (it depends on the route/status/service cardinality, not on the volume).
- Umami: 107,197 events stored in the runs (195 from the smoke test + 45,029 + 61,973). The `umami` database went from 10.1 MB to 108 MB; `website_event` with indexes takes 86 MB (≈ 800 bytes per page view) and `session` 12 MB. **Estimate** (not measured): ~0.9 KB per page view in the whole database, that is ~0.9 GB per day at 1M page views/day, ~330 GB per year. The data is synthetic (10 paths, short titles), so the real figure varies.

## Bottlenecks and pending items

1. **Umami is the web ceiling (~200 page views/s per instance) and the gateway refuses nothing when Umami gets slow.** The relay is synchronous and has no limit on requests in flight; at 400/s the latency of `POST /e` was 5 to 8 s and the gateway went from 40 MB to 220 MB. In production this would mean browsers holding connections and, with a larger peak, a memory risk. **Nothing was changed**; the decision (limit simultaneous relays and respond 503 or 204 with a drop, a bounded queue, or more Umami instances) deserves its own issue. For the RFP target (average 11.6/s, peak 116/s) nothing needs to change.
   **Update:** the gateway gained `RELAY_MAX_INFLIGHT` and `RELAY_QUEUE_WAIT` (off by default; `503` with `Retry-After` when there is no slot). Repeated measurement and decision in [ADR 0011](../adr/0011-umami-relay-limit.md). The "Nothing was changed" above describes the state in which this report was measured.
2. **Two names for the same route in spans:** spans with the client's `http.route` store `/accounts/{account_id}`; without it the normalization stores `/accounts/{address}`. It is the specified behaviour (the client's `http.route` is used as received), but it shows up as 12 distinct routes where there were 9 endpoints. Worth mentioning in the onboarding documentation; it is not a defect.
3. Tool: the `api` verification did not subtract rows that already existed (fixed, see above).

What was adjusted: nothing in the pipeline. The `dev.yaml` parameters (`RATE_LIMIT`, `FINGERPRINT_LIMIT`, `PROOF_BITS`) were kept and did not get in the way of the test because each simulated visitor has its own /24 and fingerprint.

## Limits: what this test does not prove

- **Production.** Local machine with 12 threads, without Hetzner's CPU, disk and Postgres; without Caddy, TLS, or `prod.yaml`; gateway, collector and `rollup` outside a container (without resource limits). The measured cores serve to compare stages, not to size the VM.
- **Real network.** Client, gateway and collector talked over loopback: latencies of 1 to 10 ms do not include internet RTT, TLS handshake or slow connections. We did not test gRPC, only OTLP/HTTP.
- **Umami with 24 months of data.** The Umami database had ~100 MB. Dashboard queries (`/stats`, `/metrics`) with hundreds of GB were not tested, nor the effect of size on writes. The 35-day volume of `api_metric_1m` was seeded (repetition of real data), and 1h and 1d only have 48 h of rollup.
- **Time.** No run lasted a day. The longest was 20 min; there is no soak of hours (slow leaks, vacuum, partition growth, key rotation, collector restart).
- **Traffic.** Synthetic visitors: 20,000 IPs/fingerprints, 10 pages, no bot, no IPv6, no real browser (Playwright already covers that in the e2e). We did not exercise the per-IP limits (429) or the fingerprint limit. The rate of events dropped by JS proof or fingerprint was 0 because the generator always does everything right.
- **API.** Metrics and spans from 6 services of 1 tenant; we did not test many tenants, cumulative (only delta), D9 (services that send metric and span at the same time) or the cap of 500 routes. The spans were emitted in batches of 512, or 1 s; the real OTel varies.
- **Reading.** The portal dashboards (queries on `api_metric_*` and on Umami) were not measured under write load.
- The `internal/proof` package could not be imported; the generator's algorithm was copied. If the gateway changes the algorithm, the test would show zero events stored, not a false positive.

## Pending item ready to become an issue

**Title:** `[ingest-web] limit simultaneous relays to Umami and define the behaviour under saturation`

**Text:**

> In the load test of #51 (docs/reports/load-1m-per-day.md) Umami saturates near 200 page views/s per instance (one Node core). The gateway relays `POST /e` synchronously and with no limit on requests in flight: at 400/s the latency of `POST /e` was 5 to 8 s and the gateway went from 40 MB to 220 MB of memory, without refusing anything. For the RFP target (average of 11.6/s, peak of 116/s) there is no problem, but a larger peak would hold browser connections and the gateway's memory.
>
> What to do: limit the simultaneous relays to Umami (semaphore) and define the behaviour when the limit is exceeded: respond 503 (the script does not retry), respond 204 dropping the event (as we already do with an unregistered site), use a bounded queue, or put more Umami instances behind the gateway. Include a timeout on the relay and a metric of events dropped by saturation.
>
> Acceptance criteria: with the `services/loadtest` generator at 400 page views/s, the latency of `POST /e` does not go over X s, the gateway's memory stays below Y MB and the drop shows up in a log or metric; the report's test is repeated and attached.

## How to reproduce

```sh
# Postgres + Umami (ports in .env: POSTGRES_PORT, UMAMI_PORT)
docker compose -p stellytics51 -f compose.yaml -f infra/compose/umami-port.yaml up -d --wait --no-deps postgres umami
# portal migrations: apply apps/portal/drizzle/*.sql as the stellytics user (or start the portal)
cd services
go build -o /tmp/ingest-web ./ingest-web && go build -o /tmp/collector ./collector/cmd/stellytics-collector && go build -o /tmp/loadtest ./loadtest
# start both with the dev.yaml variables (TRUSTED_PROXIES=127.0.0.0/8 on the gateway), then:
/tmp/loadtest setup -out state.json
/tmp/loadtest web -state state.json -profile "11.6x10m,116x5m,11.6x5m" -watch gateway=<pid>,collector=<pid> -docker <containers>
/tmp/loadtest api -state state.json -profile "11.6x10m,116x5m,11.6x5m"
/tmp/loadtest teardown -state state.json
```

### Steps, seeding, rollup and sizes

```sh
# steps of web (ceiling) and of the API (spans)
/tmp/loadtest web -state state.json -profile "50x1m,100x1m,200x1m,400x1m,800x1m" -max-inflight 2000 \
  -watch gateway=<pid>,collector=<pid> -docker stellytics51-postgres-1,stellytics51-umami-1 -settle 30s
/tmp/loadtest api -state state.json -modes spans -profile "500x1m,2000x1m,5000x1m,10000x1m" \
  -watch gateway=<pid>,collector=<pid> -docker stellytics51-postgres-1 -settle 30s
```

Synthetic 35-day seeding (repeats the real rows, one copy every 30 min backwards; run as the `stellytics` user, after the main step; it gave 3,981,600 rows in 22.4 s):

```sql
INSERT INTO api_metric_1m (bucket_start, tenant_id, api_service_id, route, method, status_code,
                           request_count, duration_sum, duration_buckets)
SELECT m.bucket_start - make_interval(mins => 30 * g), m.tenant_id, m.api_service_id, m.route,
       m.method, m.status_code, m.request_count, m.duration_sum, m.duration_buckets
FROM api_metric_1m m, generate_series(1, 1680) g;
```

Rollup and sizes:

```sql
\timing on
SELECT api_metric_maintain(interval '48 hours');   -- 2.55 s and 2.58 s
SELECT count(*), sum(request_count) FROM api_metric_1h;
SELECT count(*), sum(request_count) FROM api_metric_1d;
SELECT pg_size_pretty(sum(pg_total_relation_size(c.oid))) FROM pg_class c
 WHERE relname ~ '^api_metric_1m_p' AND relkind = 'r';          -- 689 MiB
SELECT pg_size_pretty(pg_database_size('umami'));                -- 108 MiB (Umami database)
-- in the umami database: SELECT pg_size_pretty(pg_total_relation_size('website_event'));  -- 86 MiB
```

The Postgres sizes use `pg_size_pretty` (KiB, MiB). The IPs of the simulated visitors are in 10.0.0.0/8 (the report's first run used 11.x.x.x, public addresses, only as header values; no packet left the machine).
