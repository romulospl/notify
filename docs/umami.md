# Umami: access and disabled features

Umami (v3.4.1, [ADR 0001](adr/0001-base-tool.md)) runs **with no patch at all**: the official image, pinned by tag and digest, with the configuration described here. If a patch becomes necessary, it goes on this page, with the reason and how to reapply it on each new version.

## Internal network only (#62)

Umami publishes no port (`infra/compose/dev.yaml`). Only the portal and the `ingest-web` gateway talk to it, through `http://umami:3000` on the Compose network. If Umami's `/api/send` were reachable, anyone could send events directly, without going through the gateway's proof of JS execution, per-IP limit and IP truncation; and the administration interface would be exposed.

- **Compose:** the `umami` service has no `ports`. For development, `infra/compose/umami-port.yaml` publishes the port on `127.0.0.1:3001`; only CI and the developer's machine use that file.
- **Caddy (production, [#14](https://github.com/romulospl/stellytics/issues/14)):** it must not have a route to Umami. Only the gateway (`/e`, `/c` and `/s/`), the portal and the OTLP routes are published (see [`infra/README.md`](../infra/README.md)).
- **Gateway:** it only answers `POST /e`, `GET /c`, `GET /s/` and `GET /healthz`. It relays only `/api/send` to Umami, with the payload rebuilt; `/api/record` and Umami's other routes do not exist on it.

The CI `compose` job checks that the service publishes no port and that no port published by the environment answers `/api/send` or `/api/record` the way Umami would.

## Session recording and heatmaps disabled

In Umami 3.4.1, session recording (replays) and heatmaps are the same feature, the "recorder":

| Piece | Where |
|---|---|
| On/off switch | Per site: columns `website.recorder_enabled` (default `false`) and `website.replay_config` (JSON with `replayEnabled` and `heatmapEnabled`, default null). They change through `POST /api/websites/:id` with `replayConfig`. There is no environment variable. |
| Browser script | `recorder.js`, served by Umami itself |
| Recording route | `POST /api/record`, which requires the session token (`x-umami-cache`) returned by `/api/send` and answers `{"ok":false,"reason":"recorder_disabled"}` when the site does not have `recorder_enabled` |
| Tables | `session_replay`, `session_replay_saved` and `heatmap_event`, in the `umami` database |

They stay off for three independent reasons:

1. The portal creates sites with only `name` and `domain` (`apps/portal/src/lib/umami/provision.ts`) and never sends `replayConfig`, so every site ends up with `recorder_enabled = false`.
2. Neither `recorder.js` nor `/api/record` is reachable from outside: Umami is on the internal network only and the gateway does not relay those routes.
3. The project's own script (`packages/tracker`) records no interaction at all; it sends only page views.

The end-to-end test `TestRecorderRecordsNothing` (`services/ingest-web/e2e/recorder_test.go`, in the `compose` job) creates a site the way the portal does, sends real page views through the gateway, tries to record a replay and a heatmap through the gateway and directly on Umami, and checks that the three tables stay empty and that no site has `recorder_enabled` or `replay_config`.

When upgrading the Umami version, check whether these names (columns, route and tables) changed and adjust the test and this page.

## Event retention (#154)

Umami 3.4.1 **has no** event retention setting of its own (no environment variable erases old data). Retention is applied by the rollup job (`services/rollup`), on every run, with the URL of the `umami` database:

| Variable | Default | What it does |
|---|---|---|
| `UMAMI_DATABASE_URL` | (none) | Turns pruning on; without it, retention stays off and the rest of the job runs as usual |
| `UMAMI_RETENTION_DAYS` | `183` | Maximum age of web events, about six months; `0` turns pruning off |

What the job erases, in this order:

1. **Events** in `website_event` with `created_at` older than the retention.
2. **Sessions** in `session` of the same age that no longer back any event — the session of a visitor who keeps coming back stays, so that its recent events keep their browser, system and location.

The Umami 3.4.1 schema has no foreign keys between these tables, so the order is a choice, not a requirement; the run is idempotent. The test `TestPruneUmami` (`services/rollup/main_test.go`) checks the behavior on a temporary database.

The value of 183 days is the decision recorded in `docs/privacy.md` (section 6), pending validation with legal counsel (checklist in section 9).
