import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  cleanReferrer,
  leadingZeroBits,
  NAVIGATION_DELAY_MS,
  pageUrl,
  solve,
  start,
  validateCustomEvent,
  type EventPayload,
} from "../src/tracker.ts";

const SITE = "6f1c2b9e-4a3d-4c1e-9b7a-2d5e8f0a1b3c";

function script(attrs: Record<string, string>): HTMLScriptElement {
  const el = document.createElement("script");
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

const TOKEN = "dGVzdGUtZGUtdG9rZW4tY29tLTMyLWJ5dGVzLWV4YXRvcw";
const BITS = 6;

// Gateway falso: GET /c devolve o desafio; POST /e aceita o evento.
function gateway(challenge: Response | (() => Response) = () => Response.json({ t: TOKEN, d: BITS })) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return new Response(null, { status: 204 });
    return typeof challenge === "function" ? challenge() : challenge;
  });
}

function posts(fetchMock: ReturnType<typeof gateway>): [string, RequestInit][] {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === "POST") as [string, RequestInit][];
}

function sent(fetchMock: ReturnType<typeof gateway>): EventPayload[] {
  return posts(fetchMock).map(([, init]) => JSON.parse(init.body as string));
}

function sha256(text: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(text).digest());
}

describe("pageUrl", () => {
  it("mantém só os parâmetros utm_*", () => {
    expect(pageUrl(new URL("https://a.example/docs?email=x@y.z&utm_source=news&token=1"))).toBe(
      "/docs?utm_source=news",
    );
    expect(pageUrl(new URL("https://a.example/docs?q=1#sec"))).toBe("/docs");
  });
});

describe("cleanReferrer", () => {
  it("remove query string e fragmento", () => {
    expect(cleanReferrer("https://ref.example/p?q=1#x", "a.example")).toBe("https://ref.example/p");
  });

  it("ignora o próprio site e valores inválidos", () => {
    expect(cleanReferrer("https://a.example/outra", "a.example")).toBe("");
    expect(cleanReferrer("não é url", "a.example")).toBe("");
    expect(cleanReferrer("", "a.example")).toBe("");
  });
});

describe("prova de execução de JS", () => {
  it("conta os bits zero do começo", () => {
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0x01]))).toBe(7);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x10]))).toBe(11);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x00]))).toBe(16);
  });

  it("acha um nonce com a dificuldade pedida", async () => {
    const nonce = await solve(TOKEN, 10);
    expect(nonce).toMatch(/^\d+$/);
    expect(leadingZeroBits(sha256(`${TOKEN}:${nonce}`))).toBeGreaterThanOrEqual(10);
  });
});

describe("start", () => {
  const SRC = "https://in.example/s/v1.1.0/n.js";
  let fetchMock: ReturnType<typeof gateway>;
  let stop = () => {};

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    fetchMock = gateway();
    vi.stubGlobal("fetch", fetchMock);
    history.replaceState(null, "", "/inicio?utm_campaign=lancamento&email=x@y.z");
    document.title = "Início";
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resolve o desafio e envia o page view ao gateway de onde o script veio", async () => {
    stop = start(script({ src: SRC, "data-site": SITE }));
    await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(1));

    const [challengeUrl, challengeInit] = fetchMock.mock.calls[0]!;
    expect(challengeUrl).toBe(`https://in.example/c?s=${SITE}`);
    expect(challengeInit).toMatchObject({ credentials: "omit" });

    const [url, init] = posts(fetchMock)[0]!;
    expect(url).toBe("https://in.example/e");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", keepalive: true });
    const event = sent(fetchMock)[0]!;
    expect(event.payload).toEqual({
      website: SITE,
      hostname: location.hostname,
      url: "/inicio?utm_campaign=lancamento",
      referrer: "",
      title: "Início",
      language: navigator.language,
      screen: `${screen.width}x${screen.height}`,
    });
    expect(event.p.t).toBe(TOKEN);
    expect(leadingZeroBits(sha256(`${TOKEN}:${event.p.n}`))).toBeGreaterThanOrEqual(BITS);
  });

  it("window.stellytics.event envia um evento customizado com nome e propriedades", async () => {
    stop = start(script({ src: SRC, "data-site": SITE }));
    await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
    const api = (window as unknown as { stellytics: { event: (n: string, d?: object) => void } }).stellytics;
    api.event("signup_clicked", { plan: "pro", seats: 3, trial: true });
    await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(2));
    const event = sent(fetchMock)[1]!;
    expect(event.payload).toMatchObject({
      website: SITE,
      url: "/inicio?utm_campaign=lancamento",
      name: "signup_clicked",
      data: { plan: "pro", seats: 3, trial: true },
    });
    // O page view não leva nome nem dados.
    expect(sent(fetchMock)[0]!.payload).not.toHaveProperty("name");
  });

  it("window.stellytics.event ignora evento fora do contrato e some ao parar", async () => {
    stop = start(script({ src: SRC, "data-site": SITE }));
    await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
    const w = window as unknown as { stellytics?: { event: (n: string, d?: object) => void } };
    w.stellytics!.event("nome inválido");
    w.stellytics!.event("ok", { nested: { a: 1 } });
    await vi.advanceTimersByTimeAsync(50);
    expect(posts(fetchMock)).toHaveLength(1);
    stop();
    expect(w.stellytics).toBeUndefined();
  });

  describe("window.stellytics.wallets (kit falso)", () => {
    const Types = { STATE_UPDATED: "STATE_UPDATE", WALLET_SELECTED: "WALLET_SELECTED", DISCONNECT: "DISCONNECT" };
    const ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

    // Kit falso com a forma da documentação: on(tipo, handler) devolve a função de cancelar.
    function fakeKit() {
      const handlers = new Map<string, Set<(e: unknown) => void>>();
      const unsub = vi.fn();
      const on = vi.fn((type: string, handler: (e: unknown) => void) => {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type)!.add(handler);
        return () => {
          unsub();
          handlers.get(type)!.delete(handler);
        };
      });
      const emit = (type: string, payload: unknown) =>
        handlers.get(type)?.forEach((h) => h({ eventType: type, payload }));
      return { kit: { on }, on, emit, handlers, unsub };
    }

    const wallets = () =>
      (window as unknown as { stellytics: { wallets: (k: unknown, t: unknown) => () => void } }).stellytics.wallets;

    it("assina só WALLET_SELECTED e DISCONNECT e manda só o id do módulo", async () => {
      stop = start(script({ src: SRC, "data-site": SITE }));
      await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
      const f = fakeKit();
      wallets()(f.kit, Types);
      expect(f.on.mock.calls.map((c) => c[0]).sort()).toEqual(["DISCONNECT", "WALLET_SELECTED"]);

      f.emit(Types.STATE_UPDATED, { address: ADDRESS, networkPassphrase: "Public Global Stellar Network ; September 2015" });
      f.emit(Types.WALLET_SELECTED, { id: "freighter", address: ADDRESS });
      f.emit(Types.DISCONNECT, {});
      await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(3));

      const [, selected, disconnected] = sent(fetchMock);
      expect(selected!.payload).toMatchObject({ name: "wallet_selected", data: { wallet: "freighter" } });
      expect(disconnected!.payload.name).toBe("wallet_disconnected");
      expect(disconnected!.payload).not.toHaveProperty("data");
      const all = JSON.stringify(sent(fetchMock));
      expect(all).not.toContain(ADDRESS);
      expect(all).not.toContain("Public Global");
    });

    it("does not count the remembered wallet the kit reports on subscribe (v1.5.0)", async () => {
      stop = start(script({ src: SRC, "data-site": SITE }));
      await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
      // Like kit 2.8.0: `on` calls the handler right away, with the current value.
      const f = fakeKit();
      const on = f.kit.on;
      const kit = {
        on: (type: string, handler: (e: unknown) => void) => {
          const off = on(type, handler);
          if (type === Types.WALLET_SELECTED) handler({ eventType: type, payload: { id: "freighter" } });
          return off;
        },
      };
      wallets()(kit, Types);
      await vi.advanceTimersByTimeAsync(50);
      expect(posts(fetchMock)).toHaveLength(1);

      // A choice after subscribing counts as usual.
      f.emit(Types.WALLET_SELECTED, { id: "albedo" });
      await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(2));
      expect(sent(fetchMock)[1]!.payload).toMatchObject({ name: "wallet_selected", data: { wallet: "albedo" } });
    });

    it("ignora id ausente, inválido ou parecido com endereço", async () => {
      stop = start(script({ src: SRC, "data-site": SITE }));
      await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
      const f = fakeKit();
      wallets()(f.kit, Types);
      f.emit(Types.WALLET_SELECTED, { id: undefined });
      f.emit(Types.WALLET_SELECTED, { id: ADDRESS });
      f.emit(Types.WALLET_SELECTED, { id: "a b" });
      f.emit(Types.WALLET_SELECTED, { id: 42 });
      await vi.advanceTimersByTimeAsync(50);
      expect(posts(fetchMock)).toHaveLength(1);
    });

    it("é idempotente por kit e o cancelamento remove as assinaturas", async () => {
      stop = start(script({ src: SRC, "data-site": SITE }));
      await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
      const f = fakeKit();
      const cancel = wallets()(f.kit, Types);
      expect(wallets()(f.kit, Types)).toBe(cancel);
      expect(f.on).toHaveBeenCalledTimes(2);
      f.emit(Types.WALLET_SELECTED, { id: "albedo" });
      await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(2));

      cancel();
      cancel();
      expect(f.unsub).toHaveBeenCalledTimes(2);
      f.emit(Types.WALLET_SELECTED, { id: "albedo" });
      await vi.advanceTimersByTimeAsync(50);
      expect(posts(fetchMock)).toHaveLength(2);
      // Depois de cancelar, pode assinar de novo.
      wallets()(f.kit, Types);
      expect(f.on).toHaveBeenCalledTimes(4);
    });

    it("kit ou enum inválidos não lançam nem assinam", async () => {
      stop = start(script({ src: SRC, "data-site": SITE }));
      await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
      const w = wallets();
      const boom = { on: () => { throw new Error("quebrado"); } };
      const f = fakeKit();
      for (const [kit, types] of [
        [undefined, Types], [null, Types], ["x", Types], [{}, Types], [boom, Types],
        [f.kit, undefined], [f.kit, {}], [f.kit, { WALLET_SELECTED: 1, DISCONNECT: 2 }],
        [f.kit, { WALLET_SELECTED: "A", DISCONNECT: "A" }],
      ] as const) {
        expect(() => w(kit, types)()).not.toThrow();
      }
      expect(f.on).not.toHaveBeenCalled();
    });

    it("falha da segunda assinatura desfaz a primeira; handler que lança não propaga", async () => {
      stop = start(script({ src: SRC, "data-site": SITE }));
      await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
      const off = vi.fn();
      let n = 0;
      const kit = { on: () => { if (++n === 2) throw new Error("x"); return off; } };
      expect(() => wallets()(kit, Types)()).not.toThrow();
      expect(off).toHaveBeenCalledTimes(1);

      const f = fakeKit();
      wallets()(f.kit, Types);
      expect(() => f.emit(Types.WALLET_SELECTED, null)).not.toThrow();
    });

    it("on que não devolve função: cancelar silencia o handler antigo e reassinar não duplica", async () => {
      stop = start(script({ src: SRC, "data-site": SITE }));
      await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
      for (const ret of [undefined, Promise.resolve(() => {})]) {
        const handlers: ((e: unknown) => void)[] = [];
        const kit = { on: (_t: string, h: (e: unknown) => void) => { handlers.push(h); return ret; } };
        const before = posts(fetchMock).length;
        const cancel = wallets()(kit, Types);
        const old = handlers.slice();
        cancel();
        wallets()(kit, Types);
        // Os handlers do primeiro ciclo continuam vivos no kit, mas não enviam.
        for (const h of old) h({ eventType: Types.WALLET_SELECTED, payload: { id: "freighter" } });
        await vi.advanceTimersByTimeAsync(50);
        expect(posts(fetchMock)).toHaveLength(before);
        // Só o handler novo envia, uma vez.
        handlers.slice(old.length)[0]!({ eventType: Types.WALLET_SELECTED, payload: { id: "freighter" } });
        await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(before + 1));
      }
    });

    it("payload com getter que lança, id objeto e off que lança não propagam", async () => {
      stop = start(script({ src: SRC, "data-site": SITE }));
      await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
      const handlers: ((e: unknown) => void)[] = [];
      const kit = {
        on: (_t: string, h: (e: unknown) => void) => {
          handlers.push(h);
          return () => { throw new Error("off quebrado"); };
        },
      };
      const cancel = wallets()(kit, Types);
      const boom = { get payload(): never { throw new Error("getter"); } };
      expect(() => handlers[0]!(boom)).not.toThrow();
      handlers[0]!({ payload: { id: { toString: () => "freighter" } } });
      handlers[0]!({ payload: { id: "a".repeat(40) } });
      await vi.advanceTimersByTimeAsync(50);
      expect(posts(fetchMock)).toHaveLength(1);
      expect(() => cancel()).not.toThrow();
    });

    it("não usa cookie nem storage", async () => {
      stop = start(script({ src: SRC, "data-site": SITE }));
      await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
      const f = fakeKit();
      wallets()(f.kit, Types);
      f.emit(Types.WALLET_SELECTED, { id: "freighter" });
      await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(2));
      expect(document.cookie).toBe("");
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    });
  });

  it("não faz nada sem data-site válido", async () => {
    start(script({ src: SRC }));
    start(script({ src: SRC, "data-site": "abc" }));
    start(null);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sem desafio, não envia evento e tenta de novo no próximo", async () => {
    let fail = true;
    fetchMock = gateway(() => (fail ? new Response(null, { status: 503 }) : Response.json({ t: TOKEN, d: BITS })));
    vi.stubGlobal("fetch", fetchMock);

    stop = start(script({ src: SRC, "data-site": SITE }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(posts(fetchMock)).toHaveLength(0);

    fail = false;
    history.pushState(null, "", "/docs");
    vi.advanceTimersByTime(NAVIGATION_DELAY_MS);
    await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
    expect(sent(fetchMock)[0]!.payload.url).toBe("/docs");
  });

  it("usa um desafio por página e renova depois de 5 minutos", async () => {
    stop = start(script({ src: SRC, "data-site": SITE }));
    await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(1));

    history.pushState(null, "", "/a");
    vi.advanceTimersByTime(NAVIGATION_DELAY_MS);
    await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(2));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST")).toHaveLength(1);

    vi.advanceTimersByTime(5 * 60_000 + 1);
    history.pushState(null, "", "/b");
    vi.advanceTimersByTime(NAVIGATION_DELAY_MS);
    await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(3));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST")).toHaveLength(2);
  });

  it("conta mudanças de rota em SPA, uma vez por rota", async () => {
    stop = start(script({ src: SRC, "data-site": SITE }));
    await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(1));

    history.pushState(null, "", "/docs");
    document.title = "Docs";
    vi.advanceTimersByTime(NAVIGATION_DELAY_MS);
    // replaceState na mesma rota (ex.: só o estado mudou) não conta.
    history.replaceState({ aba: 2 }, "", "/docs");
    vi.advanceTimersByTime(NAVIGATION_DELAY_MS);
    // Voltar no navegador muda a URL sem passar por pushState e dispara popstate.
    History.prototype.replaceState.call(history, null, "", "/inicio");
    dispatchEvent(new PopStateEvent("popstate"));
    vi.advanceTimersByTime(NAVIGATION_DELAY_MS);

    await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(3));
    const events = sent(fetchMock).map((e) => e.payload);
    expect(events.map((e) => e.url)).toEqual(["/inicio?utm_campaign=lancamento", "/docs", "/inicio"]);
    expect(events[1]).toMatchObject({ title: "Docs", referrer: `${location.origin}/inicio` });
    expect(events[2]).toMatchObject({ referrer: `${location.origin}/docs` });
  });

  it("não grava cookie nem storage", async () => {
    const cookie = vi.spyOn(document, "cookie", "set");
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    stop = start(script({ src: SRC, "data-site": SITE }));
    history.pushState(null, "", "/outra");
    vi.advanceTimersByTime(NAVIGATION_DELAY_MS);
    await vi.waitFor(() => expect(posts(fetchMock)).toHaveLength(2));

    expect(cookie).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
  });
});

describe("validateCustomEvent", () => {
  it("aceita string, número e booleano", () => {
    expect(validateCustomEvent("a.b-c_d:e", { x: "y", n: 1.5, b: false })).toEqual({ x: "y", n: 1.5, b: false });
    expect(validateCustomEvent("a")).toEqual({});
  });

  it("recusa nome, chaves e valores fora do contrato", () => {
    expect(validateCustomEvent("", {})).toBeNull();
    expect(validateCustomEvent("a b")).toBeNull();
    expect(validateCustomEvent("a".repeat(51))).toBeNull();
    expect(validateCustomEvent(1 as unknown as string)).toBeNull();
    expect(validateCustomEvent("a", { "a b": 1 })).toBeNull();
    expect(validateCustomEvent("a", { a: null })).toBeNull();
    expect(validateCustomEvent("a", { a: [1] })).toBeNull();
    expect(validateCustomEvent("a", { a: NaN })).toBeNull();
    expect(validateCustomEvent("a", { a: "x".repeat(101) })).toBeNull();
    expect(validateCustomEvent("a", Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 1])))).toBeNull();
    expect(validateCustomEvent("a", [1])).toBeNull();
    expect(validateCustomEvent("a", JSON.parse('{"__proto__":1}'))).toBeNull();
    expect(validateCustomEvent("a", { ["k".repeat(41)]: 1 })).toBeNull();
    expect(validateCustomEvent("a", { ["k".repeat(40)]: "x".repeat(100) })).not.toBeNull();
  });
});
