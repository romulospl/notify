# 0011. Limit on simultaneous relays to Umami and behaviour under saturation

- **Status:** Accepted
- **Date:** 15/11/2026
- **Issue:** [#133](https://github.com/romulospl/stellytics/issues/133) (decision about the 503) and [#134](https://github.com/romulospl/stellytics/issues/134) (per-site limit); the original text of the pending item is in [`docs/reports/load-1m-per-day.md`](../reports/load-1m-per-day.md), section "Pending item ready to become an issue"
- **Depends on:** [ADR 0002](0002-architecture-and-stack.md), [ADR 0009](0009-high-availability.md)

## Context

The load test ([`docs/reports/load-1m-per-day.md`](../reports/load-1m-per-day.md)) found that Umami saturates near 200 page views per second per instance (one Node core) and that the gateway's relay (`services/ingest-web/internal/relay`) was synchronous and had **no limit on in-flight requests**: each `POST /e` hung until Umami wrote it. Above capacity, the queue grew inside the gateway and Umami, the latency of `POST /e` went past 5 s and the gateway's memory rose, with nothing being refused. None of this shows up at the RFP target (average of 11.6/s and peak of 116/s), but a larger peak, or a bot that gets through the anti-bot layers, would do the same in production.

Repeat of the measurement with the same tool and the same machine, at 400 page views/s for 60 s, **without a limit**: `POST /e` with a p50 of 10.0 s (the ceiling of the relay's `http.Client`), 16,192 of 23,907 responses `502` by timeout, gateway memory of 355 MB. The full numbers, side by side with those of each limit, are in "Measurement" below.

Two facts of the design matter:

- The browser script sends with `keepalive` and **does not retry**. An event that the gateway cannot relay **is lost**; there is no durable queue in between.
- The relay is the only layer of the gateway that depends on a slow external service. The JS proof, the per-IP limit, the `ingest_site` lookup (cache) and the fingerprint limit are local and cheap.

## Decision

A semaphore in the relay (`relay.Limited`), controlled by two variables:

- `RELAY_MAX_INFLIGHT` (0 to 100000, default `0`): maximum number of relays to Umami at the same time. **`0` turns the limit off and preserves the previous behaviour exactly** (the gateway does not even build the semaphore; there is a regression test).
- `RELAY_QUEUE_WAIT` (0 to 10 s, default `250ms`): how long a request waits for a slot. Once the deadline passes, it is refused. `0` refuses immediately if there is no slot.

When there is no slot within the deadline, the gateway answers **`204`** and the event is dropped. The loss is recorded in the aggregate counter and in the log, not in the HTTP status. Answering the same way as the drops by site or fingerprint avoids the status and quota hints; latency can still vary between paths.

Rules:

- **Only the relay is limited.** `GET /c`, `GET /s/`, `GET /healthz`, the JS proof, the per-IP limit and the drop for a refused site or for fingerprint do not go through the semaphore and answer as always, even with the relay saturated. The **order** of the layers does not change (JS proof, `ingest_site`, fingerprints, relay); the wait for a slot happens inside the relay.
- **The slot is returned on any exit**: success, Umami error, timeout, client cancellation and panic (release by `defer`). Whoever cancels while waiting for the slot does not count as a drop by saturation.
- **A drop by saturation does not spend the IP's fingerprint quota.** The handler records the fingerprint before the relay (order unchanged); if the relay is refused by saturation and the fingerprint had just entered the count, it is removed (`Counter.Forget`). Without this, in a peak, legitimate visitors would have the /24's quota of 50 fingerprints consumed by events that were never written, and would start being dropped silently when Umami came back. The same holds for client cancellation, Umami failure and panic (the event was not written). There are tests that fail if the removal is taken out. **Known limit:** if another event from the same IP and the same fingerprint passes between the admission and the removal (it sees the fingerprint as "not new" and is written), the removal also takes its fingerprint out of the count; the quota is undercounted by one fingerprint, only under concurrency. A fingerprint that was already in the count before the event is not removed.
- **Aggregate counter**: `Limited.Dropped()` counts the drops. The gateway logs one warning per minute, only when the total changed (`dropped`, `total`, `in_flight`), as it does with the stale responses of the site cache. **No IP, `User-Agent` or site ID.** The operator sees the drop rate in that log . The last partial minute before a shutdown is not logged.

## Alternatives considered

| Alternative | Pros | Cons |
|---|---|---|
| Semaphore with a short wait and `503` | Bounded memory and latency; the drop is counted and visible in the HTTP status; the short wait absorbs bursts of milliseconds without losing an event; simple, in memory, no state to replicate | The event is lost (the script does not retry); during saturation the `503` gives two hints to whoever probes (see "Decision about the saturation hints") |
| **Answer `204` and drop silently (chosen)** | Does not reveal the two conditions through the HTTP status; the script sees no error | Hides the loss from whoever monitors the HTTP status: the drop rate would exist only in the gateway's log. The visitor does not see the response anyway, so the advantage is only against probing |
| Larger bounded queue (wait seconds for a slot) | Loses fewer events in short bursts | Reintroduces the problem on a smaller scale: connections and memory held for seconds, and the latency of those accepted rises (measured: with 256 slots and a wait of 250 ms the p50 of the accepted was 1.6 s). Only worth it if the burst is shorter than the deadline |
| Durable queue (disk, Redis, NATS) between the gateway and Umami | Does not lose an event in a peak | A new component to operate, backup and consistency; contradicts the stateless gateway of ADR 0002; a peak above the average capacity only postpones the problem, the queue grows without end if the input rate stays higher than the output rate |
| Scale Umami horizontally (several instances behind the gateway) | It is the only option that increases capacity instead of choosing what to lose | Umami is one Node process per instance; needs load balancing in the gateway or in Caddy and tuning of the Postgres pool; more VMs and cost; still needs a limit (any finite capacity saturates). **Complementary, not a substitute**: the limit must exist either way. Left for ADR 0009 (high availability) |
| Per-site limit (one tenant does not exhaust the others' slots) | Prevents a site under attack or in a peak from using all the slots | See "Per-site limit" below |
| Only lower the `http.Client` timeout (10 s today) | One line | Does not bound memory: with 400/s and a timeout of 2 s there are still 800 requests in flight; it drops after spending the slot in Umami, and Umami keeps processing what the gateway has already abandoned (measured: 19,881 events written against 7,715 `204` in the run without a limit) |

### Per-site limit (the multi-tenant point)

The global limit remains per process. With `RELAY_MAX_INFLIGHT=N` and `N >= 2`, each site can occupy up to `N-1` simultaneous slots. This way, a single site in a peak does not occupy the last slot, which stays available for another site. The reservation is fixed: a slot can sit idle when there is only one site. With `N=1` it is not possible to reserve a simultaneous slot for another site; use at least 2 for this protection.

The per-site count includes only active relays, after the site's validation. The entry is removed when the last relay ends, including on error, cancellation or panic. There are at most N entries; waiting requests and unknown IDs do not create entries. The wait remains bounded by `RELAY_QUEUE_WAIT`. There is no fair queue: several sites can compete for the last slot, and multiple sites together can exhaust the limit. The limit does not protect against multiple valid IDs controlled by the same attacker either.

### Measurement with two sites

On 17/11/2026, two simultaneous instances of `services/loadtest web`, with profiles `300x30s` and `10x30s`, against a local gateway, Umami 3.4.1 and Postgres 17.11, `RELAY_MAX_INFLIGHT=2`, `RELAY_QUEUE_WAIT=0` and a 12-bit proof. The site in a peak started 9,075 events and wrote 2,915; the other started 294 and wrote 276. All answered `204`, including drops. The aggregate counter recorded 6,178 drops, equal to the difference of the two sites. No generator saturated. The two tests started about two seconds apart; this is a local run without repetition, not a guarantee of rate or of isolation between more than two sites. The count uses `website_event` before and after, not the HTTP status.

## Measurement

Historical measurement with the previous implementation, which answered `503` under saturation; the `204` below do not include the drops that now also receive `204`.

Local machine, Postgres 17.11 and Umami 3.4.1 in containers, gateway as a Go binary on the host, generator `services/loadtest`, 400 page views/s for 60 s (Poisson), Umami database empty at the start and growing between runs, same configuration as the load report (`PROOF_BITS=12`, `FINGERPRINT_LIMIT=50`, `RATE_LIMIT=20`). **One run per row; no repetition, so the variation between runs is not measured.** Other programs were running on the machine. `Accepted` are the `204`; latencies in milliseconds as seen by the generator.

| Configuration | `204` | `503` / `502` | p50 / p95 / p99 of the accepted | p50 of the refusals | Gateway memory (peak) | Written to Umami |
|---|---|---|---|---|---|---|
| No limit | 7,715 | 502: 16,192 | 5,558 / 9,333 / 9,858 ms | 502 in 10,001 ms | 355 MB | 19,881 (includes the 502s that Umami wrote later) |
| `RELAY_MAX_INFLIGHT=256`, wait 250 ms | 11,324 | 503: 12,838 | 1,570 / 1,810 / 3,784 ms | 251 ms | 58 MB | 11,324 of 11,324 |
| `RELAY_MAX_INFLIGHT=64`, wait 250 ms | 12,048 | 503: 12,166 | 558 / 636 / 673 ms | 251 ms | 46 MB | 12,083 of 12,048 |
| `RELAY_MAX_INFLIGHT=16`, wait 250 ms | 9,774 | 503: 14,254 | 332 / 433 / 511 ms | 251 ms | 40 MB | 9,774 of 9,774 |
| `RELAY_MAX_INFLIGHT=16`, wait 50 ms | 11,127 | 503: 12,688 | 128 / 166 / 202 ms | 51 ms | 31 MB | 11,127 of 11,127 |
| `RELAY_MAX_INFLIGHT=16`, wait 250 ms, **116/s** (RFP peak) | 6,977 | 0 | 28 / 88 / 166 ms | n/a | 25 MB | 6,977 of 6,977 |

Reading:

- Without a limit the bottleneck reproduces: 5 to 10 s of latency, more than two thirds of the responses in `502` by timeout and memory of 355 MB. With a limit, the gateway's memory stayed between 31 and 58 MB, and **every event that received `204` was written** (the limited runs wrote exactly the `204`, except the one with 64 slots, with 35 extra events: 12,083 against 12,048. **Not explained**; the previous run wrote 11,324 of 11,324, so leftover queue is a weak explanation. Unverified hypotheses: events whose `204` the generator did not record because of a timeout in the load client itself, or probe events from the `setup`).
- With a limit, the accepted in 60 s stayed between 9,774 and 12,048 (163 to 201/s), against 7,715 `204` without a limit (the others were `502` for the browser, and Umami wrote 19,881 in total). This 23% variation between rows, without repetition, makes it impossible to state that Umami writes at the same rate with and without a limit; the measurement only shows that it did not stop writing.
- **The latency of the accepted is the wait for a slot plus the time in Umami**; it drops with the shorter wait (`RELAY_QUEUE_WAIT=50ms`: p99 of 202 ms) and with fewer slots. Among the values tested (16, 64 and 256; one run per row, no repetition), 256 left the p50 of the accepted at 1.6 s and 16 at 332 ms. We did not measure Umami's useful parallelism nor derive a rule for choosing `RELAY_MAX_INFLIGHT`: **not measured**.
- **At the RFP peak (116/s) with 16 slots and the default wait there was no `503` at all.** The limit only acts above capacity.
- Since the limit does not raise capacity, at 400/s from 50% to 59% of the events are lost in any configuration. The limit trades "everything slow and uncertain" for "part refused in a clear way"; only more capacity (more Umami instances) reduces the loss.

**Not tested:** several gateway instances (the semaphore is per process; N gateways allow N times `RELAY_MAX_INFLIGHT` to the same Umami), production (Caddy, TLS, real network, Hetzner), Umami with a lot of data (the database started empty), long runs, and contention between tenants in the historical measurement (only one site in that test). The values `16`, `64` and `256` were chosen for the measurement, not calculated for production.

## Decision about the saturation hints

Saturation answers `204`, like the drops for an unknown or refused site and for the fingerprint quota. This avoids revealing those conditions through the HTTP status. The wait for a slot can still produce timing differences; this decision does not guarantee responses of uniform duration. The aggregate counter and the per-minute log are the loss signals. The limit stays off by default.

## Consequences

- **Default `0` (off)**: nothing changes for whoever does not turn the variable on. The variables are passed through by Compose and by Ansible.
- An event refused by saturation is lost forever. The dashboard's pageviews metric is undercounted during saturation and **the dashboard does not warn**; the per-minute warning in the log is the available signal. Whoever turns the limit on must monitor that log.
- Timing differences between the paths can still provide hints.
- The semaphore is per process. With more than one gateway instance, the limit to Umami is the sum.
- The real capacity remains Umami's (about 200 page views/s per instance on this machine). Scaling Umami is left as an evolution (ADR 0009).
- Failures in the `ingest_site` lookup keep answering `503`.
