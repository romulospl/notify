// Painel web global do SCF (#29): projetos ativos, soma dos sites, falha
// parcial, limite de chamadas, comparação e a página, contra o Postgres de
// DATABASE_URL e um Umami falso. O banco pode ter projetos de outros testes,
// então as verificações olham só os projetos criados aqui.
import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatorContext } from "@/lib/access";
import { listActiveTenantSites } from "@/lib/data/operator/sites";
import { db, sql } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { site, tenant, tenantMember, user } from "@/lib/db/schema";
import { resolvePeriod } from "@/lib/period";
import { COMPARE_MAX, compareProjects, getWebOverview, MAX_PARALLEL } from "@/lib/umami/overview";
import OperatorWebPage from "@/app/(private)/operator/web/page";
import { DEFAULT_METRICS, startFakeUmami, type FakeUmami } from "./fake-umami";

const DOMAIN = "@operator-web-test.notify.invalid";
const SLUG = "operator-web-test-";
const NOT_FOUND = { digest: expect.stringContaining("404") };
const PERIOD = resolvePeriod("7d", new Date("2026-11-14T10:00:00Z"));

let sessionUser: { id: string; role: "tenant" | "operator" } | null = null;
vi.mock("@/lib/session", () => ({
  requireSession: async () => {
    if (!sessionUser) throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;/sign-in" });
    return { user: { ...sessionUser, name: "Test", email: "test@example.invalid", emailVerified: true } };
  },
}));

let umami: FakeUmami;
let operator: OperatorContext;
let operatorId: string;
// Prefixo único desta execução, para filtrar a página só pelos projetos daqui.
const RUN = randomUUID().slice(0, 8);

type Project = { tenantId: string; name: string; umamiIds: string[] };

async function createProject(
  label: string,
  { sites = 1, status = "active", archived = 0 }: { sites?: number; status?: "active" | "removed" | "pending"; archived?: number } = {},
): Promise<Project> {
  const name = `${RUN} ${label}`;
  const [t] = await db
    .insert(tenant)
    .values({ name, slug: `${SLUG}${randomUUID()}`, status })
    .returning();
  const umamiIds: string[] = [];
  for (let i = 0; i < sites + archived; i++) {
    const umamiWebsiteId = randomUUID();
    umami.websites.set(umamiWebsiteId, { id: umamiWebsiteId, name, domain: `s${i}.example` });
    await db.insert(site).values({
      tenantId: t!.id,
      name: `Site ${i}`,
      domain: `s${i}.example`,
      umamiWebsiteId,
      archivedAt: i >= sites ? new Date() : null,
    });
    if (i < sites) umamiIds.push(umamiWebsiteId);
  }
  return { tenantId: t!.id, name, umamiIds };
}

function render(element: Promise<ReactElement>) {
  return element.then((e) => renderToStaticMarkup(e));
}

function page(query: Record<string, string | string[]> = {}) {
  return OperatorWebPage({ searchParams: Promise.resolve(query) });
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
  operatorId = randomUUID();
  await db.insert(user).values({ id: operatorId, name: "Op", email: `${operatorId}${DOMAIN}`, role: "operator" });
  operator = { userId: operatorId } as OperatorContext;
});

beforeEach(() => {
  sessionUser = null;
  umami.requests.length = 0;
  umami.queries.length = 0;
  umami.metrics = { ...DEFAULT_METRICS };
  umami.failWebsites.clear();
  umami.statsBy.clear();
  umami.delayMs = 0;
  umami.maxInFlight = 0;
});

afterAll(async () => {
  await cleanup();
  await umami.close();
  await sql.end();
});

describe("projetos que entram", () => {
  it("só ativos, com os sites não arquivados; ativo sem site entra vazio", async () => {
    const active = await createProject("Active", { sites: 2, archived: 1 });
    const empty = await createProject("Empty", { sites: 0 });
    const removed = await createProject("Removed", { status: "removed" });
    const pending = await createProject("Pending", { status: "pending" });

    const all = await listActiveTenantSites(operator);
    const byId = new Map(all.map((p) => [p.tenantId, p]));
    expect(byId.get(active.tenantId)!.sites.map((s) => s.umamiWebsiteId).sort()).toEqual([...active.umamiIds].sort());
    expect(byId.get(empty.tenantId)!.sites).toEqual([]);
    expect(byId.has(removed.tenantId)).toBe(false);
    expect(byId.has(pending.tenantId)).toBe(false);
  });
});

describe("tabela de todos os projetos", () => {
  it("soma os sites de cada projeto e só lê /stats de projetos ativos", async () => {
    const two = await createProject("Two sites", { sites: 2 });
    const removed = await createProject("Removed again", { status: "removed" });

    const { projects } = await getWebOverview(operator, PERIOD);
    // Umami falso: 7 visualizações, 3 visitantes, 4 visitas, 1 rejeição e 60 s por site.
    expect(projects.find((p) => p.tenantId === two.tenantId)).toMatchObject({
      sites: 2,
      totals: { pageviews: 14, visitors: 6, visits: 8, bounces: 2, totaltime: 120 },
      previous: { pageviews: 10 },
    });
    expect(projects.some((p) => p.tenantId === removed.tenantId)).toBe(false);
    expect(umami.requests.every((r) => r.path.endsWith("/stats"))).toBe(true);
    expect(umami.requests.some((r) => r.path.includes(removed.umamiIds[0]!))).toBe(false);
  });

  it("site sem resposta deixa só o próprio projeto indisponível", async () => {
    const broken = await createProject("Broken", { sites: 2 });
    const fine = await createProject("Fine");
    umami.failWebsites.add(broken.umamiIds[1]!);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const { projects, unavailable } = await getWebOverview(operator, PERIOD);
    errors.mockRestore();
    expect(projects.find((p) => p.tenantId === broken.tenantId)).toMatchObject({ totals: null, previous: null });
    expect(projects.find((p) => p.tenantId === fine.tenantId)!.totals!.pageviews).toBe(7);
    expect(unavailable).toBeGreaterThanOrEqual(1);
  });

  it("cada projeto recebe os números dos próprios sites", async () => {
    const one = await createProject("Own one", { sites: 2 });
    const two = await createProject("Own two");
    const stats = (pageviews: number) => ({ pageviews, visitors: pageviews, visits: pageviews, bounces: 0, totaltime: 0 });
    umami.statsBy.set(one.umamiIds[0]!, stats(100));
    umami.statsBy.set(one.umamiIds[1]!, stats(20));
    umami.statsBy.set(two.umamiIds[0]!, stats(3));

    const { projects } = await getWebOverview(operator, PERIOD);
    expect(projects.find((p) => p.tenantId === one.tenantId)!.totals!.pageviews).toBe(120);
    expect(projects.find((p) => p.tenantId === two.tenantId)!.totals!.pageviews).toBe(3);

    const compared = await compareProjects(operator, [two.tenantId, one.tenantId], PERIOD);
    expect(compared!.map((p) => p.totals!.pageviews)).toEqual([3, 120]);
  });

  it(`não passa de ${MAX_PARALLEL} chamadas ao Umami ao mesmo tempo`, async () => {
    for (let i = 0; i < 4; i++) await createProject(`Many ${i}`, { sites: 4 });
    umami.delayMs = 20;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await getWebOverview(operator, PERIOD);
    errors.mockRestore();
    expect(umami.maxInFlight).toBeGreaterThan(1);
    expect(umami.maxInFlight).toBeLessThanOrEqual(MAX_PARALLEL);
  });
});

describe("comparação lado a lado", () => {
  it(`a comparação e a página inteira também não passam de ${MAX_PARALLEL} chamadas ao mesmo tempo`, async () => {
    // 2 projetos com 4 sites: 40 chamadas na comparação, mais a tabela.
    const a = await createProject("Busy A", { sites: 4 });
    const b = await createProject("Busy B", { sites: 4 });
    umami.delayMs = 15;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await compareProjects(operator, [a.tenantId, b.tenantId], PERIOD);
    expect(umami.maxInFlight).toBeGreaterThan(1);
    expect(umami.maxInFlight).toBeLessThanOrEqual(MAX_PARALLEL);

    umami.maxInFlight = 0;
    sessionUser = { id: operatorId, role: "operator" };
    await render(page({ compare: [a.tenantId, b.tenantId] }));
    errors.mockRestore();
    expect(umami.maxInFlight).toBeLessThanOrEqual(MAX_PARALLEL);
  });

  it("compara as 7 métricas e soma as listas dos sites", async () => {
    const a = await createProject("Compare A", { sites: 2 });
    const b = await createProject("Compare B");

    const result = await compareProjects(operator, [b.tenantId, a.tenantId], PERIOD);
    expect(result!.map((p) => p.tenantId)).toEqual([b.tenantId, a.tenantId]);
    const [, ofA] = result!;
    expect(ofA!.totals!.pageviews).toBe(14);
    expect(ofA!.breakdowns!.referrer).toEqual([
      { name: "github.com", visitors: 4 },
      { name: "google.com", visitors: 2 },
    ]);
    expect(ofA!.breakdowns!.country[0]).toEqual({ name: "DE", visitors: 4 });
  });

  it("descarta IDs desconhecidos, repetidos ou de projeto removido, e limita a 4", async () => {
    const removed = await createProject("Removed compare", { status: "removed" });
    const actives = await Promise.all([1, 2, 3, 4, 5].map((i) => createProject(`Cap ${i}`)));

    // Menos de 2 válidos: nada chega ao Umami.
    expect(await compareProjects(operator, [actives[0]!.tenantId, removed.tenantId, randomUUID(), "x"], PERIOD)).toBeNull();
    expect(await compareProjects(operator, [actives[0]!.tenantId, actives[0]!.tenantId], PERIOD)).toBeNull();
    expect(umami.requests).toEqual([]);

    const capped = await compareProjects(operator, [...actives.map((p) => p.tenantId), removed.tenantId], PERIOD);
    expect(capped!.map((p) => p.tenantId)).toEqual(actives.slice(0, COMPARE_MAX).map((p) => p.tenantId));
    expect(umami.requests.some((r) => r.path.includes(removed.umamiIds[0]!))).toBe(false);
  });
});

describe("página /operator/web", () => {
  it("lista os projetos filtrados, ordenados e com o período ativo", async () => {
    const big = await createProject("Page big", { sites: 3 });
    await createProject("Page small");
    await createProject("Page removed", { status: "removed" });
    sessionUser = { id: operatorId, role: "operator" };

    const html = await render(page({ q: `${RUN} page`, sort: "pageviews", dir: "desc", period: "30d" }));
    const names = [...html.matchAll(/href="\/operator\/tenants\/[^"]+"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(names).toEqual([`${RUN} Page big`, `${RUN} Page small`]);
    expect(html).toContain('aria-sort="descending"');
    expect(html).toMatch(/aria-current="page"[^>]*>Last 30 days</);
    expect(html).toContain(`value="${big.tenantId}"`);
    // Ordem invertida pelo cabeçalho.
    const asc = await render(page({ q: `${RUN} page`, sort: "pageviews", dir: "asc" }));
    expect([...asc.matchAll(/href="\/operator\/tenants\/[^"]+"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual([
      `${RUN} Page small`,
      `${RUN} Page big`,
    ]);
  });

  it("mostra a comparação dos projetos escolhidos", async () => {
    const a = await createProject("Side A");
    const b = await createProject("Side B");
    sessionUser = { id: operatorId, role: "operator" };

    const html = await render(page({ q: `${RUN} side`, compare: [a.tenantId, b.tenantId] }));
    expect(html).toContain("Side-by-side comparison");
    expect(html).toMatch(new RegExp(`scope="col"[^>]*>${RUN} Side A`));
    expect(html).toMatch(new RegExp(`scope="col"[^>]*>${RUN} Side B`));
    expect(html).toContain("Top referrers");
    expect(html).toContain("Germany");
    // As caixas dos dois ficam marcadas.
    expect(html).toMatch(new RegExp(`value="${a.tenantId}" checked=""|checked="" value="${a.tenantId}"`));
  });

  it("o filtro não tira da comparação os projetos que ele esconde", async () => {
    const a = await createProject("Keep A");
    const b = await createProject("Keep B");
    sessionUser = { id: operatorId, role: "operator" };

    const html = await render(page({ q: `${RUN} keep a`, compare: [a.tenantId, b.tenantId] }));
    // O formulário de "Compare selected" é o último da página.
    const compareForm = html.slice(html.lastIndexOf("<form"));
    expect(compareForm).toContain("Compare selected");
    expect(compareForm).toMatch(new RegExp(`type="hidden" name="compare" value="${b.tenantId}"`));
    // A, visível, vai pela caixa marcada, não por campo oculto.
    expect(compareForm).not.toMatch(new RegExp(`type="hidden" name="compare" value="${a.tenantId}"`));
    expect(compareForm).toContain(`value="${a.tenantId}"`);
  });

  it("um projeto só na comparação: aviso, sem comparação", async () => {
    const a = await createProject("Alone");
    sessionUser = { id: operatorId, role: "operator" };
    const html = await render(page({ q: `${RUN} alone`, compare: a.tenantId }));
    expect(html).toContain("Select between 2 and 4 active projects");
    expect(html).not.toContain("Side-by-side comparison");
  });

  it("membro de tenant recebe 404, sem chamar o Umami", async () => {
    sessionUser = { id: randomUUID(), role: "tenant" };
    await expect(page()).rejects.toMatchObject(NOT_FOUND);
    expect(umami.requests).toEqual([]);
  });
});
