// Example dApp (#50): the real Stellar Wallets Kit, on testnet, plus custom
// events. It shows the integration a project does:
//   1. the tracking script tag in <head> (serve.mjs adds it);
//   2. ONE line for wallets: window.stellytics?.wallets(StellarWalletsKit, KitEventType);
//   3. window.stellytics?.event(name, properties) where it makes sense.
// No address, public key, hash or amount goes to stellytics: the adapter sends
// only the wallet id (e.g. "xbull"), and the event properties below are
// generic labels.
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import { KitEventType, Networks } from "@creit.tech/stellar-wallets-kit/types";

StellarWalletsKit.init({ modules: defaultModules(), network: Networks.TESTNET });

// The project's one line. `?.` keeps the page working if the tracking script
// is blocked or down.
window.stellytics?.wallets(StellarWalletsKit, KitEventType);

const $ = (selector) => document.querySelector(selector);
const log = $("#log");
const status = $("#status");

function note(text) {
  const item = document.createElement("li");
  item.textContent = `${new Date().toLocaleTimeString()} — ${text}`;
  log.prepend(item);
}

// Demo only: the address is shown on the page and never sent.
async function refresh() {
  try {
    const { address } = await StellarWalletsKit.getAddress();
    status.textContent = `Connected: ${address.slice(0, 4)}…${address.slice(-4)} (testnet)`;
    $("#disconnect").disabled = false;
  } catch {
    status.textContent = "No wallet connected";
    $("#disconnect").disabled = true;
  }
}

$("#connect").addEventListener("click", async () => {
  try {
    await StellarWalletsKit.authModal();
    note("wallet connected: the adapter sends wallet_selected with only the wallet id");
  } catch (error) {
    note(`connection cancelled (${error?.message ?? "closed"})`);
  }
  await refresh();
});

$("#disconnect").addEventListener("click", async () => {
  await StellarWalletsKit.disconnect();
  note("wallet_disconnected sent");
  await refresh();
});

for (const button of document.querySelectorAll("[data-event]")) {
  button.addEventListener("click", () => {
    const data = JSON.parse(button.dataset.props ?? "{}");
    window.stellytics?.event(button.dataset.event, data);
    note(`${button.dataset.event} sent ${JSON.stringify(data)}`);
  });
}

if (!window.stellytics) note("tracking script not loaded: events are not sent");
refresh();
