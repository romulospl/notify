# loadtest

Load generator for the web pipeline and the API pipeline (issue #51). Result and
method in `docs/reports/load-1m-per-day.md`.

```sh
cd services
go build -o /tmp/loadtest ./loadtest
/tmp/loadtest setup    -stellytics-db ... -umami-url ... -out state.json   # site in Umami, tenant, services and keys
/tmp/loadtest web      -state state.json -profile "11.6x10m,116x5m"    # GET /c, JS proof, POST /e
/tmp/loadtest api      -state state.json -profile "11.6x10m,116x5m"    # OTLP/HTTP (metrics and spans)
/tmp/loadtest teardown -state state.json
```

- **Profile:** list of `ratexduration` steps (page views or requests per
  second). Poisson arrivals, without waiting for the responses (a slow server
  shows up as latency and errors). Arrivals beyond `-max-inflight` count as
  generator saturation.
- **web:** each visitor has a fixed IP, UA, language and screen, in its own
  /24; the IP goes in `X-Forwarded-For`, so the gateway needs
  `TRUSTED_PROXIES` with the generator's address. The JS proof is solved the
  way the script does it (the `internal/proof` package cannot be imported from
  outside `services/ingest-web`, so the algorithm is repeated in `web.go`). At
  the end, it counts `website_event` in the Umami database (`-umami-db`)
  against the 204s received. The report has an extra `event <status>` line per
  code (204, 503, 502...), to separate the latency of each status. Since #133, 204 includes drops; use the Umami count to know how many were written.
- **api:** simulates API services that export delta histograms
  (`-modes metrics`) or one server span per request (`-modes spans`), with
  `Authorization: Bearer` from keys created in `setup`. At the end it compares
  `request_count` in `api_metric_1m` with what was sent successfully.
- `-watch name=pid,...` and `-docker container,...` sample CPU and memory every
  2 s and summarize per step (Linux; docker uses `docker stats`).

## Security

- `setup`, `teardown`, `web` and `api` refuse any target that is not loopback
  (`-stellytics-db`, `-umami-url`, `-gateway`, `-umami-db`, `-collector`)
  without `-allow-remote`, and print host and database before acting. Do not
  point it at production.
- The state file (`state.json`, in `.gitignore`) holds the full `ntf_...`
  ingest keys, in mode 0600. Delete it after `teardown`.
- `setup` writes the state at each step; if it fails halfway, `teardown`
  deletes what was created. `teardown` only deletes the `loadtest-*` user and
  the `<user>-web` and `<user>-api` tenants, and aborts if the state does not
  match the database.
- The IPs of the simulated visitors are in 10.0.0.0/8.
