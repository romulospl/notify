# Quickstart

From nothing to your first measured page view and API request.

## 1. Get your IDs

This version of the portal has no sign-up. Ask whoever operates the instance for:

- a **website ID** for each site, and the gateway address (`<gateway>`);
- an **ingest key** (`ntf_...`) for each API service, and the collector address (`<collector>`).

## 2. Measure your website

1. Paste this tag in the `<head>` of every page, with your gateway and website ID:

```html
<script
  defer
  src="https://<gateway>/s/v1.6.0/n.js"
  integrity="sha384-cAxHFzNxpJfof+rLRpDVRPPpZZk3btq/2AV2cCsbaDEZGntOrfxIIZX4L9+LW8qp"
  crossorigin="anonymous"
  data-site="<website-id>"
></script>
```

2. Open your site over HTTPS. Each page view is sent to the gateway.

More in [Script tag](script-tag.md).

## 3. Measure your API

1. Keep the ingest key in a secrets manager: it cannot be shown again.
2. Add a second OTLP exporter to your API, in any language, next to the one you already use:

```text
POST https://<collector>/v1/metrics
Authorization: Bearer ntf_<your-ingest-key>
```

3. Send some traffic. Requests are counted within 1 to 2 minutes.

More in [OpenTelemetry](opentelemetry.md).
