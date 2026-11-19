# Tenant onboarding guide

For anyone who will measure a Stellar ecosystem project on the platform: from sign-up to reading the dashboards, covering **web** analytics (tracking script) and **API** analytics (OpenTelemetry). Written for issue [#43](https://github.com/romulospl/stellytics/issues/43) (pilot criterion pending).

> **Validation status.** The snippets in this guide were checked against the repository examples and against the code of the screens (see PR #108). Validation with a **real pilot** (acceptance criterion 2 of #43) **has not happened yet**: it depends on the pilots of issues #45 and #46. Until then, treat the guide as not validated by an external project.

Conventions: `<gateway>` is the web ingestion host and `<coletor>` the API collector address given by the instance operator. In local Compose it is at `127.0.0.1:4318` (HTTP) and `4317` (gRPC); in production it is `https://<api_host>`, on port 443, for OTLP/HTTP and gRPC (ADR 0012). No real production has been deployed yet (`docs/andamento.md`); confirm the address with whoever operates the instance before configuring.

## 1. Overview

A **project** (tenant) groups **sites** (web analytics) and **API services** (API analytics). You only see your project's data; SCF operators see all projects.

| Step | Where | What it produces |
|---|---|---|
| 1. Sign-up and e-mail confirmation | `/sign-up` | confirmed account |
| 2. Create the project | `/onboarding` | project, with you as `owner` |
| 3a. Register a site | `/sites` | site ID for the script |
| 3b. Register an API service | `/services` | ingest key `ntf_...` |
| 4a. Install the script | on your site | page views on the dashboard |
| 4b. Configure OTel dual-export | on your API | metrics on the dashboard |
| 5. Read the dashboards | `/sites/[siteId]`, `/services/[serviceId]` | |

You can use only the web part, only the API part, or both.

## 2. Sign-up

1. Open `/sign-up` and enter name, e-mail and password (at least 12 characters, with confirmation).
2. The portal sends an e-mail with the confirmation link, valid for 24 hours. **Without confirming, you cannot sign in or create a project.** With a valid link, you are signed in right away and move on to the project. If the link expires or is invalid, go to `/sign-in` with e-mail and password: the portal sends a new one (there is a per-IP limit).
3. On `/onboarding`, give the project a name (for example, your product's name). This creates the project and your `owner` role.
4. `/dashboard` shows the count of sites and services, with links to `/sites` and `/services`.

Forgot your password? `/forgot-password` sends a single-use link, valid for 30 minutes, that ends your other sessions. A portal session lasts 7 days of inactivity (renewed on each day of use).

What **does not exist**: inviting other members to the project and deleting your own account. A project has the account that created it. Anyone who needs to remove a project contacts the SCF operators (they perform the removal, with a recorded reason, and it can be reverted).

## 3. Web analytics

### 3.1 Register the site

On `/sites`, enter **Name** and **Domain** (for example `docs.example.org`) and add it. The table then shows the **Website ID**, a UUID. This is the value that goes in the script's `data-site` attribute. The site name links to its dashboard.

The portal **does not generate the installation snippet**: build the tag as below, replacing `<gateway>` and `<website-id>`.

### 3.2 Install the script

The script is served by the gateway, with the version in the path and an SRI hash. The hashes of all versions are in [`packages/tracker/published/sri.json`](../packages/tracker/published/sri.json). The newest version is **v1.1.0**.

**Static HTML and SPA.** In the `<head>` of every page (in an SPA, only in `index.html`):

```html
<script
  defer
  src="https://<gateway>/s/v1.1.0/n.js"
  integrity="sha384-oJV5jTaVFhvi5Y8R/QGZrzfVps1szxTK74tBPsk7LIsuUoUzzFetJ//8xd0NUqs0"
  crossorigin="anonymous"
  data-site="<website-id>"
></script>
```

An SPA needs nothing else: the script counts route changes made by `history.pushState`, `history.replaceState` and the browser's back button. Routers such as React Router, Vue Router and SvelteKit's use these APIs. Examples: [`examples/static-html`](../examples/static-html), [`examples/spa`](../examples/spa).

**Next.js (App Router, with SSR).** In `app/layout.tsx`, inside `<head>`:

```tsx
<head>
  <script
    defer
    src="https://<gateway>/s/v1.1.0/n.js"
    integrity="sha384-oJV5jTaVFhvi5Y8R/QGZrzfVps1szxTK74tBPsk7LIsuUoUzzFetJ//8xd0NUqs0"
    crossOrigin="anonymous"
    data-site="<website-id>"
  />
</head>
```

The tag goes into the HTML the server generates, and navigation through `<Link>` counts as a page view. **Do not use `next/script` with `strategy="lazyOnload"`:** it loads the script late, and the first page view may be lost. Example: [`examples/nextjs-ssr`](../examples/nextjs-ssr).

The snippets above are the same as in [`examples/README.md`](../examples/README.md), which the real examples and the end-to-end test (`examples/e2e`) exercise.

### 3.3 Immutable version and SRI

- Each published version (`/s/vX.Y.Z/n.js`) **never changes**: the file is served with a one-year immutable cache and the hash comes from `sri.json`. If the content changed, the browser would reject the script because of `integrity`.
- The script **never updates itself**. To change versions, change the path and the `integrity` in your HTML.
- Always use **v1.1.0 or newer** (**v1.2.0** adds custom events and **v1.3.0**, `window.notify.wallets`; **v1.4.0 renames the global object to `window.stellytics`**; **v1.5.0 fixes the wallet count**, see 3.4.1). v1.0.0 does not perform the JS execution proof, and the gateway **drops its events**.
- `crossorigin="anonymous"` is required together with `integrity`; the gateway responds with `Access-Control-Allow-Origin: *` for this.

### 3.4 Requirements and what the script does

- **HTTPS:** the JS execution proof uses `crypto.subtle`, which the browser only provides on HTTPS or `localhost`. On a plain HTTP page the script does not send events.
- The script requests a challenge at `GET /c`, solves the proof and sends a page view at `POST /e` to the origin it was loaded from. Events from clients that fail the proof are silently dropped (`204`).
- A page view carries: site ID, hostname, path (plus only the `utm_*` parameters), referrer without query or fragment, title, language and screen size.
- **Do not put personal data in paths or titles** (for example `/perfil/maria@exemplo.com`): they would be stored.
- Archived site or removed project: the gateway responds as if it had accepted and drops the event. If the numbers do not show up, check the site ID before anything else.

### 3.4.1 Custom events (v1.2.0)

With v1.2.0, `window.stellytics.event(name, properties)` records an action (click, wallet connection etc.) on the current page:

```js
window.stellytics?.event("signup_clicked", { plan: "pro", seats: 3 });
```

- Name: 1 to 50 characters among letters, digits and `_ . : -`, starting with a letter or digit. Properties: up to 10, with a key of up to 40 characters and a text value (up to 100 bytes), number or true/false. Anything outside that is ignored.
- **Do not send personal or wallet data:** address, public key, transaction hash, transferred amount, e-mail. The gateway only limits type and size; the content is the project's responsibility.
- `window.stellytics` only exists after the script loads, and **there is no queue**: a call before that is lost. Always use `window.stellytics?.event(...)`.
- **Stellar Wallets Kit events (v1.5.0, opt-in, not automatic):** the script does **not** capture anything from the kit on its own. It only reaches the kit if **you** hand it over, with one call, after initializing the kit (see [ADR 0010](adr/0010-adaptador-opt-in-do-wallets-kit.md)):

```js
window.stellytics?.wallets(StellarWalletsKit, KitEventType);
```

  - Call it **once** (calling it again with the same kit does not duplicate the subscription). It returns a function that cancels the subscription. If the kit or the enum are invalid, nothing happens and the page does not break.
  - It only subscribes to `WALLET_SELECTED` (sends `wallet_selected` with `{ wallet: "freighter" }`, the module ID) and `DISCONNECT` (sends `wallet_disconnected`, with no data). It **never** subscribes to `STATE_UPDATED` and never sends address, public key, `networkPassphrase`, hash or amount. An ID that is not a plain module name (up to 32 characters) is ignored.
  - **Use v1.5.0.** The kit remembers the last wallet in the browser and announces it at subscription time; v1.3.0 and v1.4.0 counted that as `wallet_selected` on every visit by someone who had already connected. v1.5.0 only counts choices made by the user ([ADR 0015](adr/0015-optional-rfp-features.md)).
  - Since `window.stellytics` has no queue, call it after the script loads (`window.stellytics?.wallets(...)`; if the script may take a while, repeat the call on the window's `load`, it is idempotent).
  - If you prefer to subscribe by hand and use `stellytics.event`, the handler receives `{ eventType, payload }`: the id is in `e.payload.id`, **never** in `e.id`, and `STATE_UPDATED` is still forbidden (it carries the address):

```js
StellarWalletsKit.on(KitEventType.WALLET_SELECTED, (e) => {
  const id = e?.payload?.id;
  if (id) window.stellytics?.event("wallet_selected", { wallet: id });
});
```

  - The kit (2.x) calls this handler once **during** `on`, with the remembered wallet. If you subscribe by hand, skip that first call (set a flag after `on` returns), or every returning visit counts as a selection. `stellytics.wallets` already does this.
- The site dashboard shows the events in the **Custom events** card and the wallets in the **Wallet connections** card (section 5.1).
- Complete example, with the real kit on testnet: [`examples/wallet-dapp`](../examples/wallet-dapp/).

### 3.5 Ad blockers

The script and the endpoints use `/s/`, `/e` and `/c`, without the terms the default lists block, and a daily check verifies the uBlock Origin lists. Even so, **use a neutral host** for the gateway (for example `e.<your-domain>` or `gw.<your-domain>`), without `analytics`, `track`, `collect`, `umami`, `stats`, `metrics` or `telemetry` in the name. Results, tested lists, limits (AdGuard and DNS filters were not tested) and manual checklist in [`packages/tracker/docs/ad-blockers.md`](../packages/tracker/docs/ad-blockers.md). Some share of visitors will still be blocked; the numbers are a measurement, not a census.

## 4. API analytics

### 4.1 Register the service and get the key

1. On `/services`, enter **Service name** (for example `horizon-proxy`) and create it. The portal creates the service **and the first ingest key**.
2. The key is shown **only once**, in a "Copy your ingest key now. It won't be shown again" notice. Copy it and store it in a secrets manager. It has the format `ntf_<8 characters>_<secret>`. The portal stores only the hash; if you lose the key, create another.
3. On `/services/[serviceId]/keys` (the **Ingest keys** tab) you see the prefix, the creation date and the status of each key (the **Last used** column shows the day, in UTC, of the key's last authentication at the collector; "Never" means it has not been used yet), create new ones and revoke old ones. Each service can have up to **5 active keys**. To rotate the key without losing data: create the new one, update your API and only then revoke the old one.

**One key per service.** The key defines the project and the service of each metric. The `service.name` and any tenant attribute your API sends are **ignored**: the collector deletes the `stellytics.*` attributes that come from the client.

### 4.2 What the collector needs to receive

- **Endpoint:** OTLP/HTTP (`/v1/metrics`, `/v1/traces`) or OTLP/gRPC, at `<coletor>`.
- **Header:** `Authorization: Bearer ntf_...`. Without a valid key (or with a revoked key, or one from a removed project), the response is `401` (HTTP) or `Unauthenticated` (gRPC).
- **Signal:** the `http.server.request.duration` histogram (in seconds, the current name in the OpenTelemetry semantic conventions; the old `http.server.duration`, in `ms`, also works). Alternative: HTTP server spans. If the service sends both, stellytics uses the metric and ignores the spans, to avoid double counting. Prefer the metric: traces with sampling count fewer requests than the real ones.
- **Attributes read:** `http.request.method`, `http.response.status_code` and `http.route`. Without `http.route`, the collector uses the path (`url.path`) and normalizes it.
- **Temporality:** prefer **delta**. Cumulative also works (the collector converts it), but a collector restart may lose an interval.

**Normalized routes.** An `http.route` you send is kept as is (e.g. `/accounts/{id}`). Without it, the path segments become `{uuid}`, `{address}` (Stellar G, C or M addresses), `{hash}` (hex of 16 characters or more) or `{id}` (digits only), and query, fragment and trailing slash are removed. There is a cap of 500 routes per service per day; anything beyond that goes in as `{other}`. Send `http.route` whenever your framework knows it.

**What the collector drops.** Traces, spans and logs are **never stored**: from each request only route, method, status, count and the duration distribution go in, aggregated per minute. Even so, do not put personal data in attributes; the safest filter is on your side (a `filter` processor in your Collector).

### 4.3 Dual-export through the SDK

Your API keeps sending telemetry to your current APM and sends the same metric to stellytics. Each destination is a `PeriodicExportingMetricReader` on the same `MeterProvider` (full code in [`examples/api-backend/server.mjs`](../examples/api-backend/server.mjs)):

```js
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { AggregationTemporality, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

const reader = (url, headers = {}) =>
  new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url, headers, temporalityPreference: AggregationTemporality.DELTA }),
  });

const provider = new MeterProvider({
  readers: [
    reader("https://apm.example.com/v1/metrics"), // your own backend
    reader("https://<coletor>/v1/metrics", { Authorization: `Bearer ${process.env.STELLYTICS_INGEST_KEY}` }),
  ],
});
```

The standard `OTEL_EXPORTER_OTLP_*` variables configure a single destination; the second one has to be built in code (or use the Collector). In other languages the idea is the same: two OTLP exporters, one with the `Authorization` header.

### 4.4 Dual-export through the OTel Collector

If your API already sends to an OTel Collector, just add an exporter (full file in [`examples/api-backend/otelcol.yaml`](../examples/api-backend/otelcol.yaml)):

```yaml
exporters:
  otlp_http/stellytics:
    endpoint: ${env:STELLYTICS_OTLP_ENDPOINT}
    headers:
      Authorization: Bearer ${env:STELLYTICS_INGEST_KEY}

service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug, otlp_http/stellytics] # replace debug with your APM's exporter
```

It works with the core Collector (`otel/opentelemetry-collector`) from v0.164.0; in older versions, the exporter name is `otlphttp`. With contrib, you can use a separate pipeline with a `filter` processor before `otlp_http/stellytics`, sending only what is needed. More details, including running locally with Compose, in [`examples/api-backend/README.md`](../examples/api-backend/README.md); the full contract is in [`docs/specs/e5-pipeline-de-api.md`](specs/e5-pipeline-de-api.md).

### 4.5 Check that it arrived

The keys' **Last used** column has a one-day granularity and is written in the background on the first authentication of the day, so it may take a few moments. The most direct sign that the data arrived is the service dashboard (section 5.2), which starts showing requests within 1 to 2 minutes, depending on the SDK's export interval. If it shows "No requests in this period yet", check: endpoint, `Authorization` header, the metric name and whether your API actually received traffic after you configured the exporter.

## 5. Reading the dashboards

Both dashboards have the period selector **Last 24 hours, 7 days, 30 days, 90 days and 12 months**, default 7 days. All times are **UTC**. The period ends now and starts at the beginning of an hour, day or month, so "Last 7 days" is the 6 previous full days plus today up to now. The period is in the URL (`?period=30d`), so you can share the link with others on the project.

### 5.1 Site dashboard (`/sites/[siteId]`)

- **Page views, Unique visitors, Average visit duration and Bounce rate**, each with the change against the previous period of the same length.
- Chart of page views per hour, day or month (depending on the period), with an alternative table.
- Lists of **Referrers, Countries, Devices and Browsers**.
- **Custom events:** the 10 custom events with the most occurrences in the period, as a number of events (not visitors).
- **Wallet connections:** how many times each wallet was chosen (`wallet_selected`, by wallet name) and the total disconnections (`wallet_disconnected`). Only shown with the Wallets Kit adapter (section 3.4.1).
- A unique visitor is an estimate made without a cookie or persistent identifier in the browser (see section 7); the exact criterion is Umami's and was not verified here, so do not treat the number as a count of people.
- If Umami is down, the dashboard shows "Web analytics is unavailable right now"; try again in a few minutes.

### 5.2 API service dashboard (`/services/[serviceId]`)

- **Requests**, **Server errors (5xx)** (percentage and count), **Median latency (p50)** and **p95 latency**.
- Charts of requests (with 4xx and 5xx broken out) and latency over the period, with an alternative table.
- **Endpoints**: method and normalized route, with requests, % of 4xx and 5xx, p50 and p95; shows the **100 routes** with the most requests (the header says "Top 100 of N").
- **Status codes**: distribution by code.
- The **Ingest keys** tab leads to key management (section 4.1).

How to read the numbers and the limits:

- **p50 and p95 are approximations.** Latency is stored in 15 buckets (14 bounds, from 5 ms to 10 s, plus one bucket above 10 s) and the percentile is interpolated within the range; the maximum error is the width of the range. It is good for trends and comparison, not for measuring milliseconds. Latency above 10 s shows up as 10 s.
- **Delay:** new data shows up within 1 to 2 minutes, depending on the SDK's export interval. A job rolls the minutes up into hours and days every 15 minutes, only for hours closed at least 5 minutes ago; meanwhile the dashboard reads the recent part directly from the minutes, so the difference should not show up in the numbers.
- **Retention:** minutes for 35 days, hours and days for 25 months. The dashboard reads each stretch from the table that covers it: rolled-up hours come from 1h, days from 1d and the recent, not yet rolled-up part from 1m.
- **Gaps** in the latency charts are periods without requests.
- **Server HTTP only:** the dashboard does not show clients, IPs, bodies or traces; these never reach stellytics.
- **Removed project:** a project removed by the SCF sees only the notice, and ingestion (web and API) is refused.

## 6. Common problems

| Symptom | Likely cause |
|---|---|
| No page views | wrong `data-site`; page on HTTP (no `crypto.subtle`); script v1.0.0; blocked by an ad blocker; `integrity` does not match the version in the path |
| Browser console rejects the script | `integrity` from another version, or missing `crossorigin="anonymous"` |
| First Next.js page view is missing | `next/script` with `lazyOnload`; put the tag in the layout's `<head>` |
| `401` when exporting metrics | wrong key, revoked, or from a removed project; the header must be `Authorization: Bearer ntf_...` |
| API dashboard empty with a valid key | metric or spans that are not HTTP server ones; check `http.request.method` and `http.response.status_code` |
| Many `{other}` routes | missing `http.route` with high-cardinality paths; send `http.route` |
| I lost the key | it cannot be recovered; create another and revoke the old one |

## 7. Privacy summary

- **Web:** no cookie, no `localStorage` or `sessionStorage`. The gateway **truncates the IP** (last octet on IPv4, /48 on IPv6) before geolocation, and the full IP is not stored. Session recording and heatmaps are turned off.
- **API:** only counters and histograms per route, method and status; traces, spans and logs are dropped.
- Since it uses no cookie, the script does not require a consent banner **by itself**; the legal decision is your project's. The roles, what is stored and the points of attention are in [`docs/privacidade.md`](privacidade.md), which is not legal advice.
