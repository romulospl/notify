// Tracking script logic, kept apart from the entry point (index.ts) for the tests.
// It uses no cookie, localStorage, sessionStorage or persistent identifier:
// Umami computes the session from the IP truncated by the gateway and the User-Agent.

// Path of the events endpoint on the gateway. Neutral on purpose (see #23).
export const EVENT_PATH = "/e";

// Path of the JS execution proof challenge (#25).
export const CHALLENGE_PATH = "/c";

// The challenge is valid for 10 minutes on the gateway; the script requests another before that.
export const CHALLENGE_REFRESH_MS = 5 * 60_000;

// Attempt limit for the proof. With the default difficulty (12 bits), the average
// is 4 thousand; going past the limit points to a misconfigured gateway, and the
// event is lost.
const MAX_ATTEMPTS = 1 << 22;

// Wait before sending the page view of an SPA navigation, so the new page's
// title is already in the document (same delay as the Umami script).
export const NAVIGATION_DELAY_MS = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only the campaign parameters leave the query string; the rest may hold personal
// data (e-mail, invite token etc.).
const KEPT_PARAMS = /^utm_(source|medium|campaign|term|content)$/;

// JS execution proof: the challenge token and the nonce that solves it.
export interface Proof {
  t: string;
  n: string;
}

// Payload in the format of Umami's /api/send, which the gateway validates and relays.
// The p field (the proof) stays at the gateway.
export interface EventPayload {
  type: "event";
  p: Proof;
  payload: {
    website: string;
    hostname: string;
    url: string;
    referrer: string;
    title: string;
    language: string;
    screen: string;
    // Custom event (#50); absent in the page view.
    name?: string;
    data?: Record<string, EventValue>;
  };
}

// Values accepted in the properties of a custom event.
export type EventValue = string | number | boolean;

// Same limits as the gateway (services/ingest-web/internal/relay). The gateway
// is the authority; this only avoids sending what it would reject.
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,49}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const MAX_DATA_KEYS = 10;
const MAX_DATA_STRING = 100;

// Validates the name and properties of a custom event. Returns the clean
// properties, or null if anything is outside the contract (the event is then not sent).
export function validateCustomEvent(name: unknown, data?: unknown): Record<string, EventValue> | null {
  if (typeof name !== "string" || !NAME.test(name)) return null;
  const out: Record<string, EventValue> = {};
  if (data === undefined || data === null) return out;
  if (typeof data !== "object" || Array.isArray(data)) return null;
  const entries = Object.entries(data);
  if (entries.length > MAX_DATA_KEYS) return null;
  for (const [key, value] of entries) {
    if (!KEY.test(key)) return null;
    const okString = typeof value === "string" && new TextEncoder().encode(value).length <= MAX_DATA_STRING;
    const okNumber = typeof value === "number" && Number.isFinite(value);
    if (!okString && !okNumber && typeof value !== "boolean") return null;
    out[key] = value as EventValue;
  }
  return out;
}

// Public API of the script, at window.stellytics.
export interface StellyticsApi {
  event(name: string, data?: Record<string, EventValue>): void;
  wallets(kit: unknown, types: unknown): () => void;
}

// Generic wallet module ID (freighter, albedo...). Same charset as the gateway's
// property keys and at most 32 characters: a Stellar address (56) or hash (64)
// never passes, nor does 40-character hex (EVM format).
const WALLET_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

// Reads the id from WALLET_SELECTED. Format from the kit's documentation (checked
// on 15 November 2026): { eventType, payload: { id } }. Only the id leaves; the rest is ignored.
export function walletId(event: unknown): string | null {
  const payload = (event as { payload?: { id?: unknown } } | null | undefined)?.payload;
  const id = payload?.id;
  return typeof id === "string" && WALLET_ID.test(id) ? id : null;
}

export function pageUrl(location: Location | URL): string {
  const kept = new URLSearchParams();
  new URLSearchParams(location.search).forEach((value, key) => {
    if (KEPT_PARAMS.test(key)) kept.append(key, value);
  });
  const query = kept.toString();
  return location.pathname + (query ? `?${query}` : "") + hashRoute(location.hash);
}

// SPA route in the fragment (#/route or #!/route), without query; anchors (#section)
// and fragments that are not a route (e.g. #access_token=...) are not sent.
function hashRoute(hash: string): string {
  const match = /^#!?(\/[^?#]*)/.exec(hash);
  return match ? `#${match[1]}` : "";
}

// Referrer without query string or fragment; empty when it is the page itself.
export function cleanReferrer(referrer: string, hostname: string): string {
  if (!referrer) return "";
  try {
    const url = new URL(referrer);
    if (url.hostname === hostname) return "";
    return url.origin + url.pathname;
  } catch {
    return "";
  }
}

// Counts the leading zero bits of the hash.
export function leadingZeroBits(hash: Uint8Array): number {
  let n = 0;
  for (const byte of hash) {
    if (byte !== 0) return n + Math.clz32(byte) - 24;
    n += 8;
  }
  return n;
}

// Finds the nonce such that SHA-256(token + ":" + nonce) starts with `bits` zero bits.
export async function solve(token: string, bits: number): Promise<string | null> {
  const encoder = new TextEncoder();
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const nonce = String(i);
    const hash = await crypto.subtle.digest("SHA-256", encoder.encode(`${token}:${nonce}`));
    if (leadingZeroBits(new Uint8Array(hash)) >= bits) return nonce;
  }
  return null;
}

// Requests the challenge from the gateway and solves it. Without crypto.subtle (page
// not on HTTPS) or without a gateway response, returns null and no events are sent.
async function fetchProof(url: string): Promise<Proof | null> {
  try {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) return null;
    const { t, d } = (await response.json()) as { t: string; d: number };
    const n = await solve(t, d);
    return n === null ? null : { t, n };
  } catch {
    return null;
  }
}

// Starts tracking. Returns a function that undoes the hooks (used in the tests).
export function start(script: HTMLScriptElement | null): () => void {
  const website = script?.dataset.site ?? "";
  if (!script?.src || !UUID.test(website)) return () => {};
  const endpoint = new URL(EVENT_PATH, script.src).href;
  const challenge = new URL(`${CHALLENGE_PATH}?s=${website}`, script.src).href;

  // One challenge per page load, renewed on pages left open for a long time.
  let proof: Promise<Proof | null> | undefined;
  let proofAt = 0;
  const getProof = () => {
    if (!proof || Date.now() - proofAt > CHALLENGE_REFRESH_MS) {
      proofAt = Date.now();
      // Failed? Forget the result, and the next event tries again.
      proof = fetchProof(challenge).then((p) => {
        if (!p) proof = undefined;
        return p;
      });
    }
    return proof;
  };

  const send = (url: string, referrer: string, custom?: { name: string; data: Record<string, EventValue> }) => {
    // The payload is read now (title, URL), before waiting for the proof.
    const payload: EventPayload["payload"] = {
      website,
      hostname: location.hostname,
      url,
      referrer,
      title: document.title,
      language: navigator.language,
      screen: `${screen.width}x${screen.height}`,
    };
    if (custom) {
      payload.name = custom.name;
      if (Object.keys(custom.data).length > 0) payload.data = custom.data;
    }
    getProof().then((p) => {
      if (!p) return;
      const body: EventPayload = { type: "event", p, payload };
      // text/plain avoids the CORS preflight; the gateway reads the body as JSON.
      return fetch(endpoint, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "text/plain" },
        credentials: "omit",
        keepalive: true,
      });
    }).catch(() => {});
  };

  let current = pageUrl(location);

  // window.stellytics.event(name, properties): custom event on the current page.
  // A name or properties outside the contract are silently ignored. Never pass
  // personal data, a wallet address or a transaction hash in the properties.
  const api: StellyticsApi = {
    event(name, data) {
      const clean = validateCustomEvent(name, data);
      if (!clean) return;
      send(pageUrl(location), "", { name, data: clean });
    },
    wallets: () => () => {},
  };
  // window.stellytics.wallets(kit, KitEventType) (opt-in, #50): the tenant calls it once,
  // passing the kit and the enum. Subscribes only to WALLET_SELECTED and DISCONNECT,
  // never STATE_UPDATED (it carries the address). Sends only the event name and the
  // module id. Idempotent per kit; returns the function that cancels. Never throws.
  const subscriptions = new WeakMap<object, () => void>();
  const noop = () => {};
  api.wallets = (kit, types) => {
    try {
      if ((typeof kit !== "object" && typeof kit !== "function") || kit === null) return noop;
      const existing = subscriptions.get(kit);
      if (existing) return existing;
      const on = (kit as { on?: unknown }).on;
      const t = types as { WALLET_SELECTED?: unknown; DISCONNECT?: unknown } | null | undefined;
      const selected = t?.WALLET_SELECTED;
      const disconnect = t?.DISCONNECT;
      if (typeof on !== "function" || typeof selected !== "string" || typeof disconnect !== "string") return noop;
      if (selected === disconnect) return noop;
      // After cancelling, old handlers still alive (the kit may not have
      // unsubscribed, if `on` returned no function) send nothing more.
      let cancelled = false;
      const subscribe = (type: string, handler: (event: unknown) => void): (() => void) => {
        const off: unknown = on.call(kit, type, (event: unknown) => {
          if (cancelled) return;
          try {
            handler(event);
          } catch {
            // An event failure must not affect the tenant's page.
          }
        });
        return typeof off === "function" ? (off as () => void) : noop;
      };
      // The kit (checked in 2.8.0) fires WALLET_SELECTED inside `on` itself,
      // with the wallet it remembers in the browser. That is not a user choice:
      // without this filter, every visit from someone who already connected
      // would count as a selection (#50, v1.5.0). Only notices after
      // subscribing are sent.
      let subscribing = true;
      const offSelected = subscribe(selected, (event) => {
        if (subscribing) return;
        const id = walletId(event);
        if (id) api.event("wallet_selected", { wallet: id });
      });
      subscribing = false;
      let offDisconnect = noop;
      try {
        offDisconnect = subscribe(disconnect, () => api.event("wallet_disconnected"));
      } catch {
        cancelled = true;
        try {
          offSelected();
        } catch {
          // Already failed; just make sure the old handler sends nothing more.
        }
        return noop;
      }
      const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        subscriptions.delete(kit);
        for (const off of [offSelected, offDisconnect]) {
          try {
            off();
          } catch {
            // Cancelling twice or with a broken kit must not throw.
          }
        }
      };
      subscriptions.set(kit, cancel);
      return cancel;
    } catch {
      return noop;
    }
  };
  (window as unknown as { stellytics?: StellyticsApi }).stellytics = api;

  send(current, cleanReferrer(document.referrer, location.hostname));

  // SPA navigation: one page view per route change, with the previous route as the referrer.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onNavigate = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const next = pageUrl(location);
      if (next === current) return;
      const previous = current;
      current = next;
      send(next, location.origin + previous.replace(/\?[^#]*/, ""));
    }, NAVIGATION_DELAY_MS);
  };

  const { pushState, replaceState } = history;
  for (const [method, original] of [["pushState", pushState], ["replaceState", replaceState]] as const) {
    history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
      onNavigate();
      return result;
    };
  }
  addEventListener("popstate", onNavigate);
  addEventListener("hashchange", onNavigate);

  return () => {
    delete (window as unknown as { stellytics?: StellyticsApi }).stellytics;
    clearTimeout(timer);
    history.pushState = pushState;
    history.replaceState = replaceState;
    removeEventListener("popstate", onNavigate);
    removeEventListener("hashchange", onNavigate);
  };
}
