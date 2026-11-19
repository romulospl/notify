// Painel web do tenant (#28): períodos, formatação, leitura do Umami e página,
// contra o Postgres de DATABASE_URL e um Umami falso com as respostas do 3.4.1.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inArray, like } from "drizzle-orm";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTenantContext, type TenantContext } from "@/lib/access";
import { db, sql } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { site, tenant, tenantMember, user } from "@/lib/db/schema";
import {
  averageVisitSeconds,
  bounceRate,
  browserName,
  countryName,
  formatCount,
  formatDuration,
  walletName,
} from "@/lib/format";
import { parsePeriodKey, resolvePeriod } from "@/lib/period";
import { EVENT_FETCH_LIMIT, getSiteDashboard, TOP_LIMIT } from "@/lib/umami/stats";
import { TRACKER_VERSION, trackerSnippets } from "@/lib/tracker-snippet";
import SitePage from "@/app/(private)/sites/[siteId]/page";
import { DEFAULT_EVENT_VALUES, DEFAULT_METRICS, startFakeUmami, type FakeUmami } from "./fake-umami";

const DOMAIN = "@web-dashboard-test.stellytics.invalid";
const SLUG = "web-dashboard-test-";
const NOT_FOUND = { digest: expect.stringContaining("404") };
const NOW = new Date("2026-11-14T10:37:12.345Z");

let sessionUser: { id: string; role: "tenant" | "operator" } | null = null;
vi.mock("@/lib/session", () => ({
  requireSession: async () => {
    if (!sessionUser) throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;/sign-in" });
    return { user: { ...sessionUser, name: "Test", email: "test@example.invalid", emailVerified: true } };
  },
}));

let umami: FakeUmami;

type Member = { userId: string; ctx: TenantContext; siteId: string; umamiWebsiteId: string };

async function createMember(status: "active" | "removed" = "active"): Promise<Member> {
  const userId = randomUUID();
  await db.insert(user).values({ id: userId, name: "Test", email: `${userId}${DOMAIN}`, emailVerified: true });
  const [t] = await db
    .insert(tenant)
    .values({ name: "Project", slug: `${SLUG}${randomUUID()}`, status, statusReason: status === "removed" ? "Spam" : null })
    .returning();
  await db.insert(tenantMember).values({ tenantId: t!.id, userId, role: "owner" });
  const umamiWebsiteId = randomUUID();
  umami.websites.set(umamiWebsiteId, { id: umamiWebsiteId, name: "Docs", domain: "docs.example" });
  const [s] = await db
    .insert(site)
    .values({ tenantId: t!.id, name: "Docs", domain: "docs.example", umamiWebsiteId })
    .returning();
  return { userId, ctx: (await loadTenantContext(userId))!, siteId: s!.id, umamiWebsiteId };
}

// HTML da página, com todos os componentes renderizados (inclusive o gráfico).
async function render(element: Promise<ReactElement>): Promise<string> {
  return renderToStaticMarkup(await element);
}

// Texto visível, sem tags e com os espaços normalizados.
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
}

function page(siteId: string, period?: string) {
  return SitePage({ params: Promise.resolve({ siteId }), searchParams: Promise.resolve({ period }) });
}

async function cleanup() {
  const ids = (await db.select({ id: tenant.id }).from(tenant).where(like(tenant.slug, `${SLUG}%`))).map(
    (t) => t.id,
  );
  if (ids.length > 0) {
    await db.delete(site).where(inArray(site.tenantId, ids));
    await db.delete(tenantMember).where(inArray(tenantMember.tenantId, ids));
    await db.delete(tenant).where(inArray(tenant.id, ids));
  }
  await db.delete(user).where(like(user.email, `%${DOMAIN}`));
}

beforeAll(async () => {
  await runMigrations();
  await cleanup();
  umami = await startFakeUmami(process.env.UMAMI_API_KEY!);
  process.env.UMAMI_URL = umami.url;
});

beforeEach(() => {
  sessionUser = null;
  umami.requests.length = 0;
  umami.queries.length = 0;
  umami.metrics = { ...DEFAULT_METRICS };
  umami.eventValues = { ...DEFAULT_EVENT_VALUES };
  umami.series = null;
  umami.down = false;
});

afterAll(async () => {
  await cleanup();
  await umami.close();
  await sql.end();
});

describe("períodos", () => {
  it("valor desconhecido na URL vira 7 dias", () => {
    expect(parsePeriodKey("30d")).toBe("30d");
    for (const raw of [undefined, "", "1y", ["30d"], "__proto__", "toString"]) {
      expect(parsePeriodKey(raw)).toBe("7d");
    }
  });

  it("cada período termina agora e começa no início de um balde, em UTC", () => {
    const day = resolvePeriod("7d", NOW);
    expect(day.startAt.toISOString()).toBe("2026-11-08T00:00:00.000Z");
    expect(day.endAt).toBe(NOW);
    expect(day.buckets).toHaveLength(7);
    expect(day.buckets.at(-1)!.toISOString()).toBe("2026-11-14T00:00:00.000Z");

    const hour = resolvePeriod("24h", NOW);
    expect(hour.startAt.toISOString()).toBe("2026-11-13T11:00:00.000Z");
    expect(hour.buckets.at(-1)!.toISOString()).toBe("2026-11-14T10:00:00.000Z");

    const month = resolvePeriod("12m", NOW);
    expect(month.unit).toBe("month");
    expect(month.startAt.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(month.buckets.map((b) => b.getUTCMonth())).toEqual([11, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    expect(resolvePeriod("90d", NOW).buckets).toHaveLength(90);
  });
});

describe("formatação", () => {
  it("números, duração e as razões do Umami", () => {
    expect([formatCount(1284), formatCount(12_900), formatCount(4_200_000)]).toEqual(["1,284", "12.9K", "4.2M"]);
    expect([formatDuration(45), formatDuration(65), formatDuration(7380)]).toEqual(["45s", "1m 05s", "2h 03m"]);
    expect(averageVisitSeconds({ totaltime: 90, visits: 2 })).toBe(45);
    expect(averageVisitSeconds({ totaltime: 0, visits: 0 })).toBe(0);
    expect(bounceRate({ bounces: 1, visits: 4 })).toBe(0.25);
    expect(bounceRate({ bounces: 0, visits: 0 })).toBe(0);
  });

  it("nomes de país e navegador", () => {
    expect(countryName("DE")).toBe("Germany");
    expect(countryName("")).toBe("Unknown");
    expect(browserName("ios")).toBe("Safari (iOS)");
    expect(browserName("edge-chromium")).toBe("Edge");
    expect(browserName("some-new-browser")).toBe("Some new browser");
    expect(walletName("xbull")).toBe("xBull");
    expect(walletName("freighter")).toBe("Freighter");
    expect(walletName("new-wallet")).toBe("new-wallet");
    expect(walletName("")).toBe("Unknown");
  });
});

describe("leitura do painel", () => {
  it("pede ao Umami o período, o balde em UTC e no máximo 10 itens por lista", async () => {
    const m = await createMember();
    const period = resolvePeriod("30d", NOW);
    await getSiteDashboard(m.ctx, m.siteId, period);

    const range = `startAt=${period.startAt.getTime()}&endAt=${NOW.getTime()}`;
    const base = `/api/websites/${m.umamiWebsiteId}`;
    expect(umami.queries.sort()).toEqual(
      [
        `${base}/stats?${range}`,
        `${base}/pageviews?${range}&unit=day&timezone=UTC`,
        ...["referrer", "country", "device", "browser"].map((t) => `${base}/metrics?${range}&type=${t}&limit=${TOP_LIMIT}`),
        `${base}/metrics?${range}&type=event&limit=${EVENT_FETCH_LIMIT}`,
        `${base}/event-data/values?${range}&eventName=wallet_selected&propertyName=wallet`,
      ].sort(),
    );
  });

  it("devolve as 7 métricas e preenche os baldes vazios da série", async () => {
    const m = await createMember();
    umami.series = {
      pageviews: [
        { x: "2026-11-09T00:00:00Z", y: 4 },
        { x: "2026-11-14T00:00:00Z", y: 9 },
      ],
      sessions: [
        { x: "2026-11-09T00:00:00Z", y: 2 },
        { x: "2026-11-14T00:00:00Z", y: 5 },
      ],
    };
    const data = await getSiteDashboard(m.ctx, m.siteId, resolvePeriod("7d", NOW));

    expect(data!.totals).toEqual({ pageviews: 7, visitors: 3, visits: 4, bounces: 1, totaltime: 60 });
    expect(data!.previous.pageviews).toBe(5);
    expect(data!.series.map((p) => p.pageviews)).toEqual([0, 4, 0, 0, 0, 0, 9]);
    expect(data!.series.map((p) => p.visitors)).toEqual([0, 2, 0, 0, 0, 0, 5]);
    expect(data!.breakdowns).toEqual({
      referrer: [
        { name: "github.com", visitors: 2 },
        { name: "google.com", visitors: 1 },
      ],
      country: [
        { name: "DE", visitors: 2 },
        { name: "US", visitors: 1 },
      ],
      device: [{ name: "laptop", visitors: 3 }],
      browser: [
        { name: "chrome", visitors: 2 },
        { name: "ios", visitors: 1 },
      ],
    });
    expect(data!.events).toEqual([
      { name: "swap_submitted", count: 5 },
      { name: "wallet_selected", count: 3 },
      { name: "wallet_disconnected", count: 1 },
    ]);
    expect(data!.wallets).toEqual({
      selections: [
        { name: "varial", count: 2 },
        { name: "xbull", count: 1 },
      ],
      disconnects: 1,
    });
  });

  it("events: shows only the top 10 but finds disconnections outside them (#50)", async () => {
    const m = await createMember();
    umami.metrics = {
      ...DEFAULT_METRICS,
      event: [
        ...Array.from({ length: 12 }, (_, i) => ({ x: `event_${i}`, y: 100 - i })),
        { x: "wallet_disconnected", y: 2 },
      ],
    };
    const data = await getSiteDashboard(m.ctx, m.siteId, resolvePeriod("7d", NOW));
    expect(data!.events).toHaveLength(TOP_LIMIT);
    expect(data!.events[0]).toEqual({ name: "event_0", count: 100 });
    expect(data!.wallets.disconnects).toBe(2);
  });

  it("país desconhecido (nulo no Umami) vira nome vazio", async () => {
    const m = await createMember();
    umami.metrics = { ...DEFAULT_METRICS, country: [{ x: null, y: 1 }] };
    const data = await getSiteDashboard(m.ctx, m.siteId, resolvePeriod("7d", NOW));
    expect(data!.breakdowns.country).toEqual([{ name: "", visitors: 1 }]);
  });

  it("site de outro tenant devolve nulo sem chamar o Umami", async () => {
    const a = await createMember();
    const b = await createMember();
    expect(await getSiteDashboard(a.ctx, b.siteId, resolvePeriod("7d", NOW))).toBeNull();
    expect(await getSiteDashboard(a.ctx, b.umamiWebsiteId, resolvePeriod("7d", NOW))).toBeNull();
    expect(umami.requests).toEqual([]);
  });
});

describe("página do site", () => {
  it("mostra as 7 métricas, a variação, o período ativo, o gráfico e a tabela", async () => {
    const m = await createMember();
    sessionUser = { id: m.userId, role: "tenant" };
    const html = await render(page(m.siteId, "30d"));
    const t = text(html);

    // Indicadores do Umami falso: 7 visualizações (5 antes), 3 visitantes,
    // 4 visitas, 1 rejeição e 60 s de tempo total.
    expect(t).toContain("Page views 7 ▲ Up 40% vs previous 30 days");
    expect(t).toContain("Unique visitors 3 No change vs previous 30 days");
    expect(t).toContain("Average visit duration 15s No change");
    expect(t).toContain("Bounce rate 25% No change");
    // Listas, com os nomes de exibição.
    expect(t).toMatch(/Referrers Visitors github\.com 2 google\.com 1/);
    expect(t).toMatch(/Countries Visitors Germany 2 United States 1/);
    expect(t).toMatch(/Devices Visitors Laptop 3/);
    expect(t).toMatch(/Browsers Visitors Chrome 2 Safari \(iOS\) 1/);
    // Custom events and wallets (#50).
    expect(t).toContain("Custom events Events swap_submitted 5 wallet_selected 3 wallet_disconnected 1");
    expect(t).toContain("Wallet connections Selections Varial (Freighter) 2 xBull 1 Disconnections: 1");
    // Período ativo marcado, e os outros como links.
    const active = html.match(/<a [^>]*aria-current="page"[^>]*>([^<]+)<\/a>/g) ?? [];
    expect(active).toHaveLength(1);
    expect(active[0]).toContain(`href="/sites/${m.siteId}?period=30d"`);
    expect(active[0]).toContain(">Last 30 days<");
    expect(html).toContain(`href="/sites/${m.siteId}?period=7d"`);
    // Gráfico: uma coluna por dia, com o valor no rótulo. Uma parada de Tab só
    // (a coluna mais recente); as setas andam entre as outras.
    const columns = html.match(/role="listitem" tabindex="(0|-1)"/g) ?? [];
    expect(columns).toHaveLength(30);
    expect(columns.filter((c) => c.endsWith('"0"'))).toHaveLength(1);
    expect(html).toMatch(/aria-label="[^"]+: 7 page views, 3 visitors"/);
    expect(html).toMatch(/aria-label="[^"]+: 0 page views, 0 visitors"/);
    // Tabela equivalente ao gráfico, com uma linha por dia.
    expect(t).toContain("Show as table");
    expect((html.match(/<tr>/g) ?? []).length).toBe(31);
  });

  it("período desconhecido na URL mostra 7 dias", async () => {
    const m = await createMember();
    sessionUser = { id: m.userId, role: "tenant" };
    const html = await render(page(m.siteId, "1y"));
    expect(html).toMatch(/aria-current="page"[^>]*>Last 7 days</);
    expect(html.match(/role="listitem" tabindex="(0|-1)"/g)).toHaveLength(7);
  });

  it("sem dados: indicadores sem variação e listas vazias", async () => {
    const m = await createMember();
    sessionUser = { id: m.userId, role: "tenant" };
    umami.series = { pageviews: [], sessions: [] };
    umami.metrics = { referrer: [], country: [], device: [], browser: [], event: [] };
    umami.eventValues = {};
    const t = text(await render(page(m.siteId)));
    expect(t).toContain("No data in this period.");
    expect(t).toContain("No custom events in this period. Send them with stellytics.event().");
    expect(t).toContain("No wallet selections in this period. Track them with stellytics.wallets().");
    expect(t).toContain("Disconnections: 0");
    expect(t).not.toContain("NaN");
  });

  it("tag de instalação pronta para copiar, com o ID do site e o SRI da versão mais nova", async () => {
    const m = await createMember();
    sessionUser = { id: m.userId, role: "tenant" };
    const html = await render(page(m.siteId));
    const t = text(html);
    expect(t).toContain("Install the tracking script");
    expect(html).toContain(`data-site=&quot;${m.umamiWebsiteId}&quot;`);
    expect(html).toContain(`/s/v${TRACKER_VERSION}/n.js`);
    // With page views the section starts collapsed.
    expect(html).toMatch(/<details id="install" class="[^"]*">/);

    // The hash in the tag is the hash of the published file.
    const published = path.join(import.meta.dirname, "../../../packages/tracker/published");
    const versions = Object.keys(JSON.parse(readFileSync(path.join(published, "sri.json"), "utf8")) as object);
    const newest = versions.sort((a, b) => a.localeCompare(b, "en", { numeric: true })).at(-1);
    expect(TRACKER_VERSION).toBe(newest);
    const file = readFileSync(path.join(published, `v${TRACKER_VERSION}`, "n.js"));
    const sri = `sha384-${createHash("sha384").update(file).digest("base64")}`;
    const { html: htmlTag, nextjs } = trackerSnippets(m.umamiWebsiteId);
    expect(htmlTag).toContain(`integrity="${sri}"`);
    expect(htmlTag).toContain('crossorigin="anonymous"');
    expect(htmlTag).toMatch(/^<script\n[\s\S]*\n><\/script>$/);
    expect(nextjs).toContain('crossOrigin="anonymous"');
    expect(nextjs).toMatch(/\n\/>$/);
  });

  it("sem visualizações ou com o Umami fora do ar: a tag de instalação vem aberta", async () => {
    const m = await createMember();
    sessionUser = { id: m.userId, role: "tenant" };
    umami.series = { pageviews: [], sessions: [] };
    umami.metrics = { referrer: [], country: [], device: [], browser: [], event: [] };
    umami.eventValues = {};
    umami.statsBy.set(m.umamiWebsiteId, { pageviews: 0, visitors: 0, visits: 0, bounces: 0, totaltime: 0 });
    expect(await render(page(m.siteId))).toMatch(/<details id="install" open="" /);

    umami.down = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await render(page(m.siteId));
    errors.mockRestore();
    expect(html).toMatch(/<details id="install" open="" /);
    expect(html).toContain(`data-site=&quot;${m.umamiWebsiteId}&quot;`);
  });

  it("site de outro tenant: 404, sem chamar o Umami", async () => {
    const a = await createMember();
    const b = await createMember();
    sessionUser = { id: a.userId, role: "tenant" };
    await expect(page(b.siteId)).rejects.toMatchObject(NOT_FOUND);
    await expect(page("not-a-uuid")).rejects.toMatchObject(NOT_FOUND);
    expect(umami.requests).toEqual([]);
  });

  it("projeto removido vê só o aviso, sem chamar o Umami", async () => {
    const m = await createMember("removed");
    sessionUser = { id: m.userId, role: "tenant" };
    const t = text(await render(page(m.siteId)));
    expect(t).toContain("This project was removed by the SCF operators.");
    expect(t).toContain("Reason: Spam");
    expect(t).not.toContain("Page views");
    expect(umami.requests).toEqual([]);
  });

  it("Umami fora do ar: aviso na página, sem detalhe do erro", async () => {
    const m = await createMember();
    sessionUser = { id: m.userId, role: "tenant" };
    umami.down = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await render(page(m.siteId));
    errors.mockRestore();
    expect(text(html)).toContain("Web analytics is unavailable right now");
    expect(text(html)).not.toMatch(/500|Umami/);
    // O seletor continua lá, para tentar outro período.
    expect(html).toContain("Last 30 days");
  });
});
