# 0010. Opt-in Stellar Wallets Kit adapter in the script

- **Status:** Accepted
- **Date:** 15/11/2026
- **Issue:** [#50](https://github.com/romulospl/stellytics/issues/50) (stays open: refs, does not close)

## Context

[ADR 0008](0008-custom-events-and-wallets-kit.md) delivered `window.stellytics.event` and left the capture of Stellar Wallets Kit events pending, listing as an alternative an adapter in which the tenant passes the kit to the script. This ADR records that alternative as implemented and corrects an error in 0008.

Facts reconfirmed on 15/11/2026, on the official page https://stellarwalletskit.dev/how-to/kit-events.html (read by fetch on that date) The Stellar pages (`/docs/tools/developer-tools/wallets`, via the stellar-raven MCP) are only a pointer to the kit and **do not corroborate** the shape of the event: all the facts below come from stellarwalletskit.dev, a single source.

Facts:

- `StellarWalletsKit.on(KitEventType.X, handler)` returns the unsubscribe function (`const sub = ...on(...)`; "To unsubscribe from the updates, do this: `sub()`").
- `KitEventType` has `STATE_UPDATED = "STATE_UPDATE"` (the text value is not the member name), `WALLET_SELECTED = "WALLET_SELECTED"` and `DISCONNECT = "DISCONNECT"`.
- **The handler receives `{ eventType, payload }`**: `WALLET_SELECTED` has `payload: { id: string | undefined }`, `DISCONNECT` has an empty `payload` and `STATE_UPDATED` has `payload: { address, networkPassphrase }`. The example on the page reads `event.payload.address`.
- **Correction to ADR 0008:** the manual snippet in the onboarding guide (`e.id`) was wrong; the right one is `e.payload.id`. ADR 0008 only described the fields without the `payload` envelope, and the guide copied it the wrong way. The guide was corrected together with this ADR (the manual snippet was replaced by `stellytics.wallets`). 0008 is not rewritten.
- **Not verified:** whether `on` is synchronous (the page does not say; the adapter only uses the return value if it is a function); whether the `id` can have other shapes besides a module string (the page only says `string | undefined`); whether the kit exposes a reference on `window`; the behaviour of the kit's source code (not read). That is why the adapter reads `event.payload.id` and validates the format, and ignores whatever does not fit.

## Decision

1. **The script gains `window.stellytics.wallets(kit, KitEventType)` (v1.3.0).** The tenant calls it **once**, after starting the kit, passing the kit object and the enum.
2. **This is NOT automatic capture nor "without configuration".** The original criterion of #50 ("captured automatically, without tenant configuration") is still **not met**: without the tenant's call, nothing is captured, for the reasons in ADR 0008 (the script is a separate bundle and cannot reach the kit's module). #50 is not closed by this ADR.
3. **Only two events are subscribed to:** `WALLET_SELECTED` sends `wallet_selected` with `{ wallet: id }`, where `id` is the module ID (for example `freighter`) and goes through the same charset as the gateway's keys (`[A-Za-z0-9][A-Za-z0-9_.-]{0,31}`, at most 32 characters: it rejects a 56-character Stellar address, a 64-character hash, 40-character hex in the EVM format and text with a space); `DISCONNECT` sends `wallet_disconnected` with no data. `STATE_UPDATED` is **never** subscribed to, and no address, public key, `networkPassphrase`, hash or amount leaves the browser. Missing or invalid id: the event is not sent.
4. **Defensive behaviour:** idempotent per kit (kept in a `WeakMap`; a second call returns the same unsubscribe function); an invalid kit or enum, an `on` that throws or a handler that throws never propagate (silent try/catch); if the second subscription fails, the first one is undone; no cookie or storage; it returns the function that cancels both subscriptions (and is idempotent). The gateway did not change: the events go through the same `name`/`data` rules of ADR 0008.
5. The names (`wallets`, `wallet_selected`, `wallet_disconnected`) contain no terms blocked by ad blockers.

**Limitation:** the 32-character limit is a heuristic, not a proof. Any short value that the kit returns as `id` would be accepted; the real IDs of the kit's modules are short and generic (for example `freighter`), but the full list was not verified.

## Alternatives considered

| Alternative | Pros | Cons |
|---|---|---|
| Opt-in adapter `stellytics.wallets` (chosen) | Uses the public `on` API, simple, no monkey patching | Requires one line from the tenant; does not meet "without configuration" |
| Monkey patching the kit | No configuration | See ADR 0008 |
| Subscribe to `STATE_UPDATED` as well | More signal (network) | Brings the address; rejected as a hard privacy rule |
| Keep only the manual 3-line snippet | Nothing new in the script | Each tenant rewrites the logic (and the guide had the `e.id` error) |

## Consequences

- New immutable version `v1.3.0` (v1.0.0 to v1.2.0 remain intact).
- The onboarding guide documents the call and the warning never to send an address.
- Still pending: confirm in the kit's code whether `on` is synchronous and other formats of `id`; capture without tenant configuration still has no acceptable solution.
