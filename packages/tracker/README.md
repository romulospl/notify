# packages/tracker

Tracking script in TypeScript, bundled with esbuild. Created in [#22](https://github.com/romulospl/stellytics/issues/22).

- Published at a versioned path (`/s/vX.Y.Z/n.js`), immutable once published and with an SRI hash.
- Sends a payload compatible with Umami's `/api/send`, always through the gateway (`services/ingest-web`), at `POST /e` on the same origin as the script.
- No cookies, `localStorage`, `sessionStorage` or persistent identifier.
- From the query string only the `utm_*` parameters are sent; the referrer goes without query string or fragment.
- In an SPA, it counts every route change (`pushState`, `replaceState` and `popstate`).
- Before sending, it requests a challenge at `GET /c` and solves the JS execution proof with `crypto.subtle` (#25). That is why it only works on HTTPS pages (or `localhost`).
- File and endpoint names must not contain terms blocked by ad blockers (`umami`, `analytics`, `track`, `collect`). The `check:adblock` check verifies this against EasyList, EasyPrivacy and the default uBlock Origin lists; results, host recommendation and manual checklist in [`docs/ad-blockers.md`](docs/ad-blockers.md).
- Custom event (v1.2.0, #50): `window.stellytics.event(name, properties?)`. Name of 1 to 50 characters `[A-Za-z0-9_.:-]`; up to 10 properties with a string value (up to 100 bytes), number or boolean. Anything outside that is silently ignored. **Never** send a wallet address, transaction hash, amount or personal data.

```js
window.stellytics?.event("wallet_connected", { wallet: "freighter" });
```

- Stellar Wallets Kit (v1.5.0, **opt-in**, #50): `window.stellytics.wallets(kit, KitEventType)`. **It is not automatic**: the tenant must call it once, passing the kit and the enum, because the script cannot reach the kit's module on its own ([ADR 0010](../../docs/adr/0010-adaptador-opt-in-do-wallets-kit.md)). It subscribes only to `WALLET_SELECTED` (`wallet_selected` with `{ wallet: id }`) and `DISCONNECT` (`wallet_disconnected`); never `STATE_UPDATED`, address, public key, `networkPassphrase`, hash or amount. Idempotent per kit, returns the unsubscribe function and never throws. Since v1.5.0 it ignores the notification the kit fires inside its own `on` with the wallet remembered in the browser: only user choices become `wallet_selected` ([ADR 0015](../../docs/adr/0015-optional-rfp-features.md)).

```js
window.stellytics?.wallets(StellarWalletsKit, KitEventType);
```

## Installing on the tenant's site

```html
<script
  defer
  src="https://<gateway>/s/v1.1.0/n.js"
  integrity="sha384-oJV5jTaVFhvi5Y8R/QGZrzfVps1szxTK74tBPsk7LIsuUoUzzFetJ//8xd0NUqs0"
  crossorigin="anonymous"
  data-site="<website-id>"
></script>
```

The hash of each version is in [`published/sri.json`](published/sri.json). The script never updates itself: to change versions, the tenant changes the path and the `integrity` in their own HTML.

## Development

```bash
pnpm --filter @stellytics/tracker test       # vitest (happy-dom)
pnpm --filter @stellytics/tracker build      # builds dist/n.js
pnpm --filter @stellytics/tracker release    # publishes the package.json version to published/
pnpm --filter @stellytics/tracker check:adblock  # tests script and endpoints against the ad blocker lists
```

To publish a new version:

1. Change the code.
2. Bump the `version` in `package.json` (semver).
3. Run `release` and commit `published/vX.Y.Z/n.js` and `published/sri.json`.

Old versions are never deleted or changed. v1.0.0 does not send the JS execution proof, so the gateway has dropped its events since #25: use v1.1.0 or newer. The `test/published.test.ts` test checks the hashes and fails if the current code is not that of the `package.json` version.
