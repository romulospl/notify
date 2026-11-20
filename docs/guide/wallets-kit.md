# Stellar Wallets Kit

Count which wallets your users connect with, without ever seeing an address.

## Turn it on

Nothing is captured automatically. After you initialize the kit, hand it to the script once:

```js
window.stellytics?.wallets(StellarWalletsKit, KitEventType);
```

Needs script **v1.5.0** or newer.

## What is sent

- `wallet_selected`, with the wallet's module ID, such as `{ wallet: "freighter" }`, when the user picks a wallet.
- `wallet_disconnected`, with no data.

Never sent: address, public key, network passphrase, transaction hash or amount. The adapter never listens to `STATE_UPDATED`, which carries the address.

## Good to know

- Calling it again with the same kit does not count twice. It returns a function that stops the subscription.
- If the kit or the enum is invalid, nothing happens and the page keeps working.
- If the script may load after your code, repeat the call on the window's `load` event; it is safe to call more than once.
- v1.5.0 counts only wallets the user chooses. Older versions also counted the wallet the kit remembers, on every return visit.

## Where to see them

The **Wallet connections** card on the [site dashboard](dashboards.md). A full example with the real kit on testnet is in [`examples/wallet-dapp`](../../examples/wallet-dapp/).
