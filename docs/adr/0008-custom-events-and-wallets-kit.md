# 0008. Custom events in the script and Stellar Wallets Kit capture

- **Status:** Accepted
- **Date:** 15/11/2026
- **Issue:** [#50](https://github.com/romulospl/stellytics/issues/50)

## Context

#50 asks for two things: a custom event API in the script and automatic capture of Stellar Wallets Kit events, with no tenant configuration. Umami already accepts a custom event at `/api/send` (fields `name` and `data`), but the gateway rebuilds the payload with only `website`, `hostname`, `url`, `referrer`, `title`, `language` and `screen`, and discards the rest on purpose.

Facts gathered about the Wallets Kit (checked on 15 November 2026):

- The official wallet tools page lists the kit and points to the documentation at stellarwalletskit.dev (stellarDocs, `/docs/tools/developer-tools/wallets`, read through the stellar-raven MCP on 15 November 2026). It does not describe events.
- The "Kit events" page of the kit documentation (stellarwalletskit.dev/how-to/kit-events.html, read on 15 November 2026) says that you subscribe with `StellarWalletsKit.on(KitEventType.STATE_UPDATED, handler)`, that the call returns an unsubscribe function and that there are three types: `STATE_UPDATED` (`address`, `networkPassphrase`), `WALLET_SELECTED` (`id`) and `DISCONNECT` (empty).
- The `dapp` skill (used through Raven, note from July 2026) describes v2 as a static singleton started by the app (`StellarWalletsKit.init(...)`, `authModal()`, `signTransaction(...)`), distributed on JSR.
- **Not verified:** whether the events are in-process callbacks or a `CustomEvent` in the DOM (the page does not say); whether the kit exposes any global reference on `window`; whether a signing event exists (the page lists only the three above). Reading the source code on GitHub was not possible (the URL tried returned 404).

## Decision

1. **Custom event: delivered.** The script exposes `window.stellytics.event(name, properties?)`. The name contains no terms blocked by ad blockers. The script validates in the browser and the gateway validates again (the rule that counts is the gateway's): key starting with a letter or digit (rejects `__proto__`); finite number with a literal of up to 32 characters; name with 1 to 50 characters `[A-Za-z0-9_.:-]` starting with a letter or digit; up to 10 properties; key of up to 40 characters `[A-Za-z0-9_.-]`; value a string (up to 100 bytes), number or boolean (nested, null and list are rejected with `400`, `data` without `name` too; this last rule exists only in the gateway, the script does not check it because `event()` itself always sends `name`). Only the validated `name` and `data` are relayed to Umami; `id`, `ip`, `userAgent` and `timestamp` are still discarded, and the order in the gateway does not change (JS proof, `ingest_site`, fingerprints, relay). The API is version 1.2.0 of the script; the old versions remain untouched.
2. **Wallets Kit: not delivered.** The kit only notifies through callbacks registered on the (static) instance of the tenant's own module. The tracking script is a separate bundle, loaded by `<script>`, and it cannot reach that module without (a) the tenant calling something, which is tenant configuration and goes against the criterion, or (b) intercepting the kit by monkey patching (`StellarWalletsKit.on`/`authModal`/`signTransaction`), which depends on the kit being on `window` (not verified), breaks with minification and with load order, and changes the behaviour of third-party code inside the tenant's page. That is too fragile for a script that is immutable per version and has SRI.
3. **Privacy is a hard constraint.** Even with an optional adapter, `STATE_UPDATED` carries `address` and `DISCONNECT`/`WALLET_SELECTED` carry the module ID. Wallet address, public key, transaction hash and amounts are **never** captured or accepted as a convention. If an adapter is proposed again, it sends only the event name (`wallet_selected`, `wallet_disconnected`) and the generic wallet ID (for example `freighter`), never the address.

## Alternatives considered

| Alternative | Pros | Cons |
|---|---|---|
| Intercept the kit by monkey patching in the script | Zero tenant configuration | Depends on an unverified global, breaks with bundlers and load order, alters third-party code, hard to test |
| Optional adapter: the tenant passes the kit to the script (`stellytics.walletKit(StellarWalletsKit, KitEventType)`) | Robust, uses the public `on` API | It is tenant configuration (does not meet "no configuration"); needs the script or an npm package; left as an open item |
| Observe the DOM of the kit's modal | No coupling to the module | Depends on internal selectors, fragile, and does not see signing |
| Accept free-form `data` without limits | Simple | Makes room for personal data and for storage overflow in Umami |
| Only numbers and booleans in `data` | Less risk of personal data | Prevents the common label case (`plan: "pro"`) |

## Consequences

- Tenants can already record their own events, for example `stellytics.event("wallet_connected", { wallet: "freighter" })`, by calling the API at the point in the code where they connect the wallet. The onboarding guide warns not to put an address, hash or amount in it.
- The criterion "Wallets Kit events captured automatically" remains **open**. Before resuming: confirm in the kit's code the event mechanism and whether there is a global reference; decide between the optional adapter and no capture.
- String values in `data` are still free text from the tenant: the responsibility for not sending personal data is theirs (the gateway only limits size and type).
- Listing the events in the tenant's web dashboard remains an open item: the dashboard does not currently read Umami's `/metrics` with `type=event`, and this was not verified in this issue.
