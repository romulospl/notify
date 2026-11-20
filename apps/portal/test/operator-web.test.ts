// SCF global web dashboard (#29): active projects, sum of the sites, partial
// failure, call limit, comparison and the page, against the DATABASE_URL
// Postgres and a fake Umami. The database may hold projects from other tests,
// so the checks look only at the projects created here.
import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatorContext } from "@/lib/access";
import { listActiveTenantSites } from "@/lib/data/operator/sites";
import { db, sql } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { site, tenant, tenantMember, user } from "@/lib/db/schema";
import { resolvePeriod } from "@/lib/period";
import { COMPARE_MAX, compareProjects, getWebOverview, MAX_PARALLEL } from "@/lib/umami/overview";
import { DEFAULT_METRICS, startFakeUmami, type FakeUmami } from "./fake-umami";

const DOMAIN = "@operator-web-test.stellytics.invalid";
const SLUG = "operator-web-test-";
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
// Prefix unique to this run, to filter the page down to the projects from here.
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

describe("projects that are included", () => {
  it("only active ones, with the non-archived sites; an active one without a site comes in empty", async () => {
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

describe("table of all projects", () => {
  it("sums the sites of each project and only reads /stats of active projects", async () => {
    const two = await createProject("Two sites", { sites: 2 });
    const removed = await createProject("Removed again", { status: "removed" });

    const { projects } = await getWebOverview(operator, PERIOD);
    // Fake Umami: 7 page views, 3 visitors, 4 visits, 1 bounce and 60 s per site.
    expect(projects.find((p) => p.tenantId === two.tenantId)).toMatchObject({
      sites: 2,
      totals: { pageviews: 14, visitors: 6, visits: 8, bounces: 2, totaltime: 120 },
      previous: { pageviews: 10 },
    });
    expect(projects.some((p) => p.tenantId === removed.tenantId)).toBe(false);
    expect(umami.requests.every((r) => r.path.endsWith("/stats"))).toBe(true);
    expect(umami.requests.some((r) => r.path.includes(removed.umamiIds[0]!))).toBe(false);
  });

  it("a site with no response leaves only its own project unavailable", async () => {
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

  it("each project gets the numbers of its own sites", async () => {
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

  it(`does not exceed ${MAX_PARALLEL} calls to Umami at the same time`, async () => {
    for (let i = 0; i < 4; i++) await createProject(`Many ${i}`, { sites: 4 });
    umami.delayMs = 20;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await getWebOverview(operator, PERIOD);
    errors.mockRestore();
    expect(umami.maxInFlight).toBeGreaterThan(1);
    expect(umami.maxInFlight).toBeLessThanOrEqual(MAX_PARALLEL);
  });
});

describe("side-by-side comparison", () => {
  it("compares the 7 metrics and sums the sites' lists", async () => {
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

  it("drops unknown, repeated or removed-project IDs, and limits to 4", async () => {
    const removed = await createProject("Removed compare", { status: "removed" });
    const actives = await Promise.all([1, 2, 3, 4, 5].map((i) => createProject(`Cap ${i}`)));

    // Fewer than 2 valid ones: nothing reaches Umami.
    expect(await compareProjects(operator, [actives[0]!.tenantId, removed.tenantId, randomUUID(), "x"], PERIOD)).toBeNull();
    expect(await compareProjects(operator, [actives[0]!.tenantId, actives[0]!.tenantId], PERIOD)).toBeNull();
    expect(umami.requests).toEqual([]);

    const capped = await compareProjects(operator, [...actives.map((p) => p.tenantId), removed.tenantId], PERIOD);
    expect(capped!.map((p) => p.tenantId)).toEqual(actives.slice(0, COMPARE_MAX).map((p) => p.tenantId));
    expect(umami.requests.some((r) => r.path.includes(removed.umamiIds[0]!))).toBe(false);
  });
});
