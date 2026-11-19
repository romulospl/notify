# examples

Reference integrations, also used in the end-to-end tests. Each example is its own workspace package (`examples/<name>`).

| Folder | What it shows |
|---|---|
| [`static-html/`](static-html/) | Static site: each loaded page is a page view |
| [`spa/`](spa/) | Framework-less SPA with `history.pushState`: each route change is a page view, without reloading |
| [`nextjs-ssr/`](nextjs-ssr/) | Next.js 16 (App Router) with SSR: the tag ships in the server HTML, and navigation through `<Link>` counts as a page view |
| [`wallet-dapp/`](wallet-dapp/) | Testnet dApp with the real Stellar Wallets Kit: custom events (`stellytics.event`) and the wallet adapter line (`stellytics.wallets`), without sending an address (#50, ADR 0015) |
| [`api-backend/`](api-backend/) | HTTP backend with OpenTelemetry and a dual-export guide (SDK and OTel Collector) for the stellytics collector (#35) |
| [`e2e/`](e2e/) | Playwright: opens the web examples in Chromium and checks page views, custom events and wallets in the Umami database (#27, #50) |

## Installing the script (snippets for the onboarding guide)

The script is served by the gateway, with a fixed version in the path and an SRI hash. Replace `<gateway>` with the gateway address and `<website-id>` with the site ID shown in the portal. The hashes of each version are in [`packages/tracker/published/sri.json`](../packages/tracker/published/sri.json).

### Static HTML and SPA

In the `<head>` of every page (in an SPA, only in `index.html`):

```html
<script
  defer
  src="https://<gateway>/s/v1.1.0/n.js"
  integrity="sha384-oJV5jTaVFhvi5Y8R/QGZrzfVps1szxTK74tBPsk7LIsuUoUzzFetJ//8xd0NUqs0"
  crossorigin="anonymous"
  data-site="<website-id>"
></script>
```

An SPA needs nothing else: the script counts route changes made by `history.pushState`, `history.replaceState` and the browser's back button. Routers such as React Router, Vue Router and SvelteKit's use these APIs.

### Next.js (App Router)

In `app/layout.tsx`, inside `<head>`:

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

The tag goes into the HTML the server generates, and navigation through `<Link>` counts as a page view. Do not use `next/script` with `strategy="lazyOnload"`: it loads the script late, and the first page view may be lost.

### Requirements

- **HTTPS:** the JS execution proof uses `crypto.subtle`, which the browser only provides on HTTPS or `localhost`. On a plain HTTP page, the script does not send events.
- **No cookie or consent:** the script stores no cookie or storage, and the IP is truncated at the gateway.
- **To change versions,** change the path and the `integrity` in your own HTML. The script never updates itself.

## Running locally

With Compose running (gateway on port 3002) and a site registered in the portal (or created by hand in Umami and in `ingest_site`):

```bash
cd examples/static-html && STELLYTICS_WEBSITE_ID=<id> PORT=4001 node ../serve.mjs .
cd examples/spa && STELLYTICS_WEBSITE_ID=<id> PORT=4002 node ../serve.mjs . spa
cd examples/nextjs-ssr && pnpm build && STELLYTICS_WEBSITE_ID=<id> pnpm start
cd examples/wallet-dapp && pnpm build && STELLYTICS_WEBSITE_ID=<id> PORT=4004 pnpm start
```

`serve.mjs` replaces the `<!-- stellytics:script -->` comment in the pages with the script tag. The site comes from `STELLYTICS_WEBSITE_ID`, the gateway from `STELLYTICS_GATEWAY_URL` (default `http://127.0.0.1:3002`) and the version from `STELLYTICS_SCRIPT_VERSION` (default: the newest published one). `HOST` changes the listen address (default `127.0.0.1`; use `0.0.0.0` in a container). The Next.js example reads the same variables.

## End to end

```bash
pnpm --filter @stellytics/examples-e2e exec playwright install chromium
pnpm --filter @stellytics/examples-e2e e2e
```

`run.mjs` creates a website in Umami for each example and a tenant with the four sites in the `stellytics` database. Then it runs Playwright, which starts the examples on ports 4001 to 4004, and at the end deletes everything.

The tests check:
- **Static HTML:** one page view per page;
- **SPA:** four page views, including the browser's back button, without reloading the page;
- **Next.js:** the tag with `integrity` in the server HTML and navigation through `<Link>`;
- **Wallet dApp:** a custom event with a property and, with a fake kit that behaves like Wallets Kit 2.8.0 (no wallet extension in CI), `wallet_selected` only for the user's choice (not for the remembered wallet), `wallet_disconnected` and no address stored.

The URLs can be overridden with `UMAMI_URL`, `STELLYTICS_DATABASE_URL`, `UMAMI_DATABASE_URL` and `STELLYTICS_GATEWAY_URL`. In CI, the test runs in the `compose` job.
