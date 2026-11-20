# Read API

SCF operators can read the global metrics of every active project from other systems, such as spreadsheets, Grafana or reports.

## Authentication

Read keys are issued to SCF operators by whoever operates the instance. A key starts with `nrk_` and cannot be shown again.

```bash
curl -H "Authorization: Bearer nrk_<your-read-key>" "https://<portal>/api/v1/web?period=30d"
```

- The key only reads. It is valid while its creator is an operator.
- It is for servers only: there is no CORS, so never put it in browser code.

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/v1/projects` | Active projects, with their counts of sites and services |
| `GET /api/v1/web?period=` | Page views, visitors, visits, bounces and time per project, with the previous period |
| `GET /api/v1/api?period=` | Requests, 4xx, 5xx, p50 and p95 (in seconds) per project |

`period` is `24h`, `7d` (default), `30d`, `90d` or `12m`, in UTC. An unknown value returns `400`.

The numbers are the same as the operator dashboards. Removed and pending projects are not listed.

## Limits and errors

- 60 requests per minute per key; above that, `429` with `Retry-After`.
- Any invalid, revoked or unknown key gets the same `401`, without saying why.
- If the web analytics engine does not answer, a project comes back with `null` totals and `unavailable` above zero.
