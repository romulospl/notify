// Lógica do script de rastreamento, separada da entrada (index.ts) para os testes.
// Não usa cookie, localStorage, sessionStorage nem identificador persistente:
// a sessão é calculada pelo Umami a partir do IP truncado pelo gateway e do User-Agent.

// Caminho do endpoint de eventos no gateway. Neutro de propósito (ver #23).
export const EVENT_PATH = "/e";

// Caminho do desafio da prova de execução de JS (#25).
export const CHALLENGE_PATH = "/c";

// O desafio vale 10 minutos no gateway; o script pede outro antes disso.
export const CHALLENGE_REFRESH_MS = 5 * 60_000;

// Limite de tentativas da prova. Com a dificuldade padrão (12 bits), a média é
// de 4 mil; passar disso indica um gateway mal configurado, e o evento é perdido.
const MAX_ATTEMPTS = 1 << 22;

// Espera antes de enviar o page view de uma navegação de SPA, para o título da
// página nova já estar no document (mesmo atraso do script do Umami).
export const NAVIGATION_DELAY_MS = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Só os parâmetros de campanha saem da query string; o resto pode ter dado pessoal
// (e-mail, token de convite etc.).
const KEPT_PARAMS = /^utm_(source|medium|campaign|term|content)$/;

// Prova de execução de JS: o token do desafio e o nonce que o resolve.
export interface Proof {
  t: string;
  n: string;
}

// Payload no formato do /api/send do Umami, que o gateway valida e repassa.
// O campo p (a prova) fica no gateway.
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
    // Evento customizado (#50); ausentes no page view.
    name?: string;
    data?: Record<string, EventValue>;
  };
}

// Valores aceitos nas propriedades de um evento customizado.
export type EventValue = string | number | boolean;

// Mesmos limites do gateway (services/ingest-web/internal/relay). O gateway é
// quem manda; aqui só se evita enviar o que ele recusaria.
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,49}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const MAX_DATA_KEYS = 10;
const MAX_DATA_STRING = 100;

// Valida nome e propriedades de um evento customizado. Devolve as propriedades
// limpas ou nulo se algo estiver fora do contrato (o evento então não é enviado).
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

// API pública do script, em window.stellytics.
export interface StellyticsApi {
  event(name: string, data?: Record<string, EventValue>): void;
  wallets(kit: unknown, types: unknown): () => void;
}

// ID genérico de módulo de carteira (freighter, albedo...). Mesmo charset das
// chaves de propriedade do gateway e no máximo 32 caracteres: um endereço
// Stellar (56) ou hash (64) nunca passa, nem hex de 40 caracteres (formato EVM).
const WALLET_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

// Lê o id de WALLET_SELECTED. Formato da documentação do kit (consulta de
// 15/11/2026): { eventType, payload: { id } }. Só o id sai; o resto é ignorado.
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
  return location.pathname + (query ? `?${query}` : "");
}

// Referenciador sem query string nem fragmento; vazio quando é a própria página.
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

// Conta os bits zero no começo do hash.
export function leadingZeroBits(hash: Uint8Array): number {
  let n = 0;
  for (const byte of hash) {
    if (byte !== 0) return n + Math.clz32(byte) - 24;
    n += 8;
  }
  return n;
}

// Acha o nonce tal que SHA-256(token + ":" + nonce) comece com `bits` bits zero.
export async function solve(token: string, bits: number): Promise<string | null> {
  const encoder = new TextEncoder();
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const nonce = String(i);
    const hash = await crypto.subtle.digest("SHA-256", encoder.encode(`${token}:${nonce}`));
    if (leadingZeroBits(new Uint8Array(hash)) >= bits) return nonce;
  }
  return null;
}

// Pede o desafio ao gateway e o resolve. Sem crypto.subtle (página fora de
// HTTPS) ou sem resposta do gateway, devolve nulo e os eventos não saem.
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

// Inicia o rastreamento. Devolve uma função que desfaz os ganchos (usada nos testes).
export function start(script: HTMLScriptElement | null): () => void {
  const website = script?.dataset.site ?? "";
  if (!script?.src || !UUID.test(website)) return () => {};
  const endpoint = new URL(EVENT_PATH, script.src).href;
  const challenge = new URL(`${CHALLENGE_PATH}?s=${website}`, script.src).href;

  // Um desafio por carregamento de página, renovado em páginas abertas por muito tempo.
  let proof: Promise<Proof | null> | undefined;
  let proofAt = 0;
  const getProof = () => {
    if (!proof || Date.now() - proofAt > CHALLENGE_REFRESH_MS) {
      proofAt = Date.now();
      // Falhou? Esquece o resultado, e o próximo evento tenta de novo.
      proof = fetchProof(challenge).then((p) => {
        if (!p) proof = undefined;
        return p;
      });
    }
    return proof;
  };

  const send = (url: string, referrer: string, custom?: { name: string; data: Record<string, EventValue> }) => {
    // O payload é lido agora (título, URL), antes de esperar a prova.
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
      // text/plain evita o preflight de CORS; o gateway lê o corpo como JSON.
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

  // window.stellytics.event(nome, propriedades): evento customizado na página atual.
  // Nome ou propriedades fora do contrato são ignorados em silêncio. Nunca passe
  // dado pessoal, endereço de carteira nem hash de transação nas propriedades.
  const api: StellyticsApi = {
    event(name, data) {
      const clean = validateCustomEvent(name, data);
      if (!clean) return;
      send(pageUrl(location), "", { name, data: clean });
    },
    wallets: () => () => {},
  };
  // window.stellytics.wallets(kit, KitEventType) (opt-in, #50): o tenant chama uma vez,
  // passando o kit e o enum. Assina só WALLET_SELECTED e DISCONNECT, nunca
  // STATE_UPDATED (traz o endereço). Manda só o nome do evento e o id do módulo.
  // Idempotente por kit; devolve a função que cancela. Nunca lança.
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
      // Depois de cancelar, handlers antigos ainda vivos (o kit pode não ter
      // desassinado, se `on` não devolveu função) não enviam mais nada.
      let cancelled = false;
      const subscribe = (type: string, handler: (event: unknown) => void): (() => void) => {
        const off: unknown = on.call(kit, type, (event: unknown) => {
          if (cancelled) return;
          try {
            handler(event);
          } catch {
            // Falha do evento não pode afetar a página do tenant.
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
          // Já falhou; só garante que o handler antigo não envia mais.
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
            // Cancelar duas vezes ou com kit quebrado não deve lançar.
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

  // Navegação de SPA: um page view por mudança de rota, com a rota anterior como referenciador.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onNavigate = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const next = pageUrl(location);
      if (next === current) return;
      const previous = current;
      current = next;
      send(next, location.origin + previous.split("?")[0]);
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

  return () => {
    delete (window as unknown as { stellytics?: StellyticsApi }).stellytics;
    clearTimeout(timer);
    history.pushState = pushState;
    history.replaceState = replaceState;
    removeEventListener("popstate", onNavigate);
  };
}
