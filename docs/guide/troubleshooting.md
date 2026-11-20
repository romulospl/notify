# Troubleshooting

The usual reasons when numbers do not show up.

## Website

| Symptom | Check |
|---|---|
| No page views | The `data-site` ID; the page is on HTTPS; the version is not v1.0.0; an ad blocker |
| The browser rejects the script | `integrity` belongs to another version, or `crossorigin="anonymous"` is missing |
| First Next.js page view missing | Do not use `next/script` with `lazyOnload`; put the tag in the layout's `<head>` |

## API

| Symptom | Check |
|---|---|
| `401` when exporting | The key is wrong or revoked; the header is `Authorization: Bearer ntf_...` |
| Dashboard empty with a valid key | The instrumentation loads after your app (use `node --import ./instrumentation.mjs`), or the metric is not `http.server.request.duration` |
| npm warns about `engines`, or the app fails to start | Node.js older than 22.15 |
| Key shows **Last used**, dashboard still empty | The path is doubled (`/v1/metrics/v1/metrics`); use the base URL where the client adds the path |
| Many `{other}` routes | `http.route` is missing; see [Route normalization](route-normalization.md) |
| Lost the key | It cannot be recovered: get a new one and have the old one revoked |

## Still stuck

See [Support](../support.md).
