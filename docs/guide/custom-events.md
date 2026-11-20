# Custom events

Record actions beyond page views, such as a sign-up click or a swap started.

## Send an event

```js
window.stellytics?.event("signup_clicked", { plan: "pro", seats: 3 });
```

Needs script v1.4.0 or newer.

## Rules

- **Name:** 1 to 50 characters: letters, digits and `_ . : -`, starting with a letter or digit.
- **Properties:** up to 10. Keys up to 40 characters; values are text (up to 100 bytes), numbers or true/false.
- Anything outside these rules is ignored.

## Call it safely

- `window.stellytics` exists only after the script loads, and there is no queue: an earlier call is lost.
- Always write `window.stellytics?.event(...)`, so the page never breaks.

## Never send personal or wallet data

No addresses, public keys, transaction hashes, amounts or e-mails. The platform limits only the type and size of each value; the content is your project's responsibility.

## Where to see them

The **Custom events** card on the [site dashboard](dashboards.md) lists the 10 most frequent events in the period.
