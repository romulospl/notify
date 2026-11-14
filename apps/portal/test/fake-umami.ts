// Umami falso para os testes: implementa só as rotas que o portal usa, com
// as mesmas respostas do Umami 3.4.1, e registra cada pedido recebido.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeUmami = {
  url: string;
  apiKey: string;
  websites: Map<string, { id: string; name: string; domain: string }>;
  requests: { method: string; path: string }[];
  // Corpos recebidos em POST /api/websites, para conferir o que o portal envia.
  createBodies: unknown[];
  // Caminho com a query string de cada pedido, na ordem.
  queries: string[];
  // Respostas de /metrics por tipo e da série de /pageviews (#28). Sem valor,
  // a série tem um ponto só, no primeiro balde do período.
  metrics: Record<string, { x: string | null; y: number }[]>;
  series: { pageviews: { x: string; y: number }[]; sessions: { x: string; y: number }[] } | null;
  // Simula o Umami fora do ar nas leituras de estatísticas.
  down: boolean;
  close: () => Promise<void>;
};

export const DEFAULT_METRICS: FakeUmami["metrics"] = {
  referrer: [
    { x: "github.com", y: 2 },
    { x: "google.com", y: 1 },
  ],
  country: [
    { x: "DE", y: 2 },
    { x: "US", y: 1 },
  ],
  device: [{ x: "laptop", y: 3 }],
  browser: [
    { x: "chrome", y: 2 },
    { x: "ios", y: 1 },
  ],
};

export async function startFakeUmami(apiKey: string): Promise<FakeUmami> {
  const websites: FakeUmami["websites"] = new Map();
  const requests: FakeUmami["requests"] = [];
  const createBodies: unknown[] = [];
  const queries: string[] = [];
  const state = { metrics: { ...DEFAULT_METRICS }, series: null as FakeUmami["series"], down: false };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const method = req.method ?? "GET";
    requests.push({ method, path: url.pathname });
    queries.push(url.pathname + url.search);

    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.headers.authorization !== `Bearer ${apiKey}`) return send(401, { error: "Unauthorized" });

    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};

    if (method === "POST" && url.pathname === "/api/websites") {
      createBodies.push(body);
      const website = { id: randomUUID(), name: body.name, domain: body.domain };
      websites.set(website.id, website);
      return send(200, website);
    }
    if (method === "GET" && url.pathname === "/api/websites") {
      const page = Number(url.searchParams.get("page") ?? 1);
      const pageSize = Number(url.searchParams.get("pageSize") ?? 10);
      const all = [...websites.values()];
      const data = all.slice((page - 1) * pageSize, page * pageSize);
      return send(200, { data, count: all.length, page, pageSize });
    }
    const match = url.pathname.match(/^\/api\/websites\/([^/]+)(\/stats|\/pageviews|\/metrics)?$/);
    if (match && websites.has(match[1]!)) {
      if (method === "DELETE" && !match[2]) {
        websites.delete(match[1]!);
        return send(200, { ok: true });
      }
      if (method === "GET" && match[2] && state.down) return send(500, { error: "Internal error" });
      if (method === "GET" && match[2] === "/stats") {
        const totals = { pageviews: 7, visitors: 3, visits: 4, bounces: 1, totaltime: 60 };
        return send(200, { ...totals, comparison: { ...totals, pageviews: 5 } });
      }
      if (method === "GET" && match[2] === "/pageviews") {
        // Como o Umami 3.4.1: só os baldes com dados, com x em ISO sem milissegundos.
        const first = new Date(Number(url.searchParams.get("startAt"))).toISOString().replace(".000Z", "Z");
        return send(
          200,
          state.series ?? { pageviews: [{ x: first, y: 7 }], sessions: [{ x: first, y: 3 }] },
        );
      }
      if (method === "GET" && match[2] === "/metrics") {
        const type = url.searchParams.get("type") ?? "";
        if (!(type in state.metrics)) return send(400, { error: { message: "Bad request" } });
        const limit = Number(url.searchParams.get("limit") ?? 500);
        return send(200, state.metrics[type]!.slice(0, limit));
      }
    }
    return send(404, { error: "Not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    apiKey,
    websites,
    requests,
    createBodies,
    queries,
    get metrics() {
      return state.metrics;
    },
    set metrics(value) {
      state.metrics = value;
    },
    get series() {
      return state.series;
    },
    set series(value) {
      state.series = value;
    },
    get down() {
      return state.down;
    },
    set down(value) {
      state.down = value;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
