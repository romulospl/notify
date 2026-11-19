# 0015. Adopting the optional RFP features: custom events and wallets

- **Status:** Accepted
- **Date:** 19/11/2026
- **Issue:** [#50](https://github.com/romulospl/stellytics/issues/50)

## Context

The RFP lists two nice-to-haves (section 3.2): custom events and capture of Stellar Wallets Kit events. Issue #50 asks to record a decision for each one and, for whatever is adopted, to demonstrate the integration; for the Wallets Kit, "capture without additional tenant configuration".

[ADR 0008](0008-eventos-customizados-e-wallets-kit.md) delivered `window.stellytics.event` in the script (v1.2.0) and concluded that capture without configuration is not feasible without monkey patching the kit. [ADR 0010](0010-adaptador-opt-in-do-wallets-kit.md) delivered the opt-in adapter `window.stellytics.wallets(kit, KitEventType)` (v1.3.0). Still missing were the maintainer's decision, reading the events in the dashboard, and the demonstration.

New facts, checked on 19/11/2026 in the `@creit.tech/stellar-wallets-kit@2.8.0` package (npm, MIT; code in `esm/sdk/kit.js` and `esm/state/values.js`):

- `on(KitEventType.WALLET_SELECTED, ...)` is a Preact Signals `effect`: it calls the handler **at subscription time**, with the current value of `selectedModuleId`.
- `selectedModuleId` is initialized from `localStorage` (`@StellarWalletsKit/selectedModuleId`): the kit remembers the last wallet chosen.
- So, with the v1.3.0/v1.4.0 adapter, **every visit** from someone who had already connected a wallet produced a `wallet_selected`, without the user choosing anything. The selection count in the dashboard would be inflated by returning visits.
- `DISCONNECT` is a plain event (`disconnectEvent.subscribe`): it does not fire on subscription.
- In kit 2.x Freighter shows up as `varial`; module IDs are short and generic (`xbull`, `albedo`, `lobstr`, `hot-wallet`, `LEDGER`...).
- In Umami 3.4.1, `/api/websites/:id/metrics?type=event` lists custom events with `y` = number of events (`count(*)`), and `/event-data/values?eventName=&propertyName=` counts the values of a property (up to 100, descending).

## Decision

1. **Custom events: adopted.** They stay as in ADR 0008 (contract in the script, validated again in the gateway). The site dashboard (`/sites/[siteId]`) gets a **Custom events** card: the 10 events with the most occurrences in the period, counted in events.
2. **Wallets: adopted through the one-line opt-in adapter** (`window.stellytics?.wallets(StellarWalletsKit, KitEventType)`). The criterion "without additional tenant configuration" is **not met** and is recorded as a technical limit of the kit (ADR 0008): the SCF proposal must say so in these terms and not present the capture as automatic.
3. **Script v1.5.0:** the adapter ignores the `WALLET_SELECTED` the kit fires inside its own `on` (the remembered wallet). Only choices made after subscribing become `wallet_selected`. v1.3.0 and v1.4.0 stay published and immutable, with the old behavior; the guide now points to v1.5.0.
4. The site dashboard gets a **Wallet connections** card: selections per wallet (the `wallet` property of `wallet_selected`, with a display name) and the total of `wallet_disconnected`. The event list is read with up to 100 names, so disconnections are found even outside the top 10.
5. Privacy unchanged: no address, public key, network, hash or amount; `STATE_UPDATED` stays forbidden.
6. Demonstration: `examples/wallet-dapp`, a testnet dApp with the real kit (bundled with esbuild; the kit is a dev dependency of the example, outside the production images), and an `examples/e2e` case that uses a fake kit with the 2.8.0 behavior, because CI has no wallet extension.

## Alternatives considered

| Alternative | Pros | Cons |
|---|---|---|
| Do not adopt wallets | No "half" configuration to explain | Loses a Stellar-specific signal the RFP lists as a nice-to-have; the adapter already exists and is tested |
| Count the remembered wallet as a selection | No new script version | Meaningless product number: it measures visits from people who already connected, not choices |
| Send a separate event for the remembered wallet (`wallet_restored`) | More information | One more call per returning visit, and the data approaches "visitor with a wallet", which was not asked for |
| Show events only in Umami | Nothing new in the portal | Tenants cannot reach Umami (closed, #62); without the dashboard the feature does not exist for them |

## Consequences

- Tenants on v1.3.0 or v1.4.0 keep counting the remembered wallet; the fix requires switching to v1.5.0 (path and `integrity`). The onboarding guide says so.
- The dashboard makes two more Umami calls per load (`/metrics?type=event` and `/event-data/values`), both for the tenant's already-checked site (ADR 0003); the isolation suite still covers them, because it checks that every call goes to the tenant's own site.
- The SCF view (`/operator/web`) and the read API (`/api/v1/web`) do **not** show events or wallets yet; left as pending.
- A demonstration with a real wallet (a Freighter/Varial or xBull extension on testnet) needs a person to approve the connection in the extension; on 19/11/2026 it was done with Freighter in Brave on the HP test environment (remembered wallet not counted, no address stored). The e2e covers the path with a fake kit.
- The example brings the kit's dependency tree (about 370 packages) into `pnpm-lock.yaml`, only as a dev dependency of the example.
