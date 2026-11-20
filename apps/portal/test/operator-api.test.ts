// SCF global API dashboard (#38): active projects, sum of the services, the
// same table rule as the tenant dashboard and the page, against the
// DATABASE_URL Postgres. The database may hold projects from other tests, so
// the checks look only at the projects created here.
import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTenantContext, type OperatorContext } from "@/lib/access";
import { getServiceDashboard } from "@/lib/data/api-metrics";
import { getApiOverview, type ProjectApiStats } from "@/lib/data/operator/api";
import { db, sql } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { apiService, tenant, tenantMember, user } from "@/lib/db/schema";
import { resolvePeriod } from "@/lib/period";

const DOMAIN = "@operator-api-test.stellytics.invalid";
const SLUG = "operator-api-test-";
const NOW = new Date("2026-11-14T10:37:12.345Z");
const RUN = randomUUID().slice(0, 8);

let sessionUser: { id: string; role: "tenant" | "operator" } | null = null;
vi.mock("@/lib/session", () => ({
  requireSession: async () => {
    if (!sessionUser) throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;/sign-in" });
    return { user: { ...sessionUser, name: "Test", email: "test@example.invalid", emailVerified: true } };
  },
}));

const operator = { userId: "operator" } as OperatorContext;
let operatorId: string;

type Project = { tenantId: string; userId: string; name: string; services: string[] };

async function createProject(
  label: string,
  { services = 1, archived = 0, status = "active" }: { services?: number; archived?: number; status?: "active" | "removed" | "pending" } = {},
): Promise<Project> {
  const userId = randomUUID();
  await db.insert(user).values({ id: userId, name: "Test", email: `${userId}${DOMAIN}`, emailVerified: true });
  const name = `${RUN} ${label}`;
  const [t] = await db.insert(tenant).values({ name, slug: `${SLUG}${randomUUID()}`, status }).returning();
  await db.insert(tenantMember).values({ tenantId: t!.id, userId, role: "owner" });
  const ids: string[] = [];
  for (let i = 0; i < services + archived; i++) {
    const [s] = await db
      .insert(apiService)
      .values({ tenantId: t!.id, name: `svc-${i}`, archivedAt: i >= services ? new Date() : null })
      .returning();
    ids.push(s!.id);
  }
  return { tenantId: t!.id, userId, name, services: ids };
}

type Point = { at: string; status?: number; count: number; b?: Record<number, number> };

async function insert(table: "api_metric_1m" | "api_metric_1h" | "api_metric_1d", tenantId: string, serviceId: string, p: Point) {
  const b = Array.from({ length: 15 }, (_, i) => (p.b ?? { 2: p.count })[i] ?? 0);
  await sql`
    INSERT INTO ${sql(table)} (bucket_start, tenant_id, api_service_id, route, method, status_code,
                               request_count, duration_sum, duration_buckets)
    VALUES (${p.at}, ${tenantId}, ${serviceId}, '/ledgers/{id}', 'GET', ${p.status ?? 200}, ${p.count}, 0, ${b}::bigint[])`;
}

function mine(projects: ProjectApiStats[]) {
  return projects.filter((p) => p.name.startsWith(RUN));
}



async function cleanup() {
  const ids = (await db.select({ id: tenant.id }).from(tenant).where(like(tenant.slug, `${SLUG}%`))).map((t) => t.id);
  if (ids.length > 0) {
    for (const t of ["api_metric_1m", "api_metric_1h", "api_metric_1d"]) {
      await sql`DELETE FROM ${sql(t)} WHERE tenant_id IN ${sql(ids)}`;
    }
    await db.delete(apiService).where(inArray(apiService.tenantId, ids));
    await db.delete(tenantMember).where(inArray(tenantMember.tenantId, ids));
    await db.delete(tenant).where(inArray(tenant.id, ids));
  }
  await db.delete(user).where(like(user.email, `%${DOMAIN}`));
}

let busy: Project;
let lagging: Project;
let idle: Project;
let empty: Project;
let removed: Project;

beforeAll(async () => {
  await runMigrations();
  await cleanup();
  operatorId = randomUUID();
  await db.insert(user).values({ id: operatorId, name: "Op", email: `${operatorId}${DOMAIN}`, emailVerified: true, role: "operator" });

  // Two services and an archived one; data in 1d, 1h and 1m, plus traps that
  // would count twice or come from outside the period.
  busy = await createProject("busy", { services: 2, archived: 1 });
  const [s1, s2, gone] = busy.services as [string, string, string];
  await insert("api_metric_1d", busy.tenantId, s1, { at: "2026-11-10T00:00:00Z", count: 100 });
  await insert("api_metric_1d", busy.tenantId, s2, { at: "2026-11-11T00:00:00Z", status: 500, count: 10, b: { 9: 10 } });
  await insert("api_metric_1h", busy.tenantId, s1, { at: "2026-11-14T05:00:00Z", status: 404, count: 20 });
  await insert("api_metric_1m", busy.tenantId, s2, { at: "2026-11-14T09:30:00Z", count: 7 });
  await insert("api_metric_1h", busy.tenantId, s1, { at: "2026-11-10T12:00:00Z", count: 1000 }); // already in 1d
  await insert("api_metric_1m", busy.tenantId, s1, { at: "2026-11-14T05:10:00Z", count: 1000 }); // already in 1h
  await insert("api_metric_1d", busy.tenantId, s1, { at: "2026-11-14T00:00:00Z", count: 1000 }); // partial day
  // Hour already rolled up, but inside the one-hour margin: it comes from 1m (09:30).
  await insert("api_metric_1h", busy.tenantId, s1, { at: "2026-11-14T09:00:00Z", count: 1000 });
  await insert("api_metric_1d", busy.tenantId, s1, { at: "2026-11-07T00:00:00Z", count: 1000 }); // outside
  await insert("api_metric_1d", busy.tenantId, gone, { at: "2026-11-10T00:00:00Z", count: 1000 }); // archived

  // Late job: the last rolled-up hour is 13 November 20:00; after that, only minutes.
  lagging = await createProject("lagging");
  const [l] = lagging.services as [string];
  await insert("api_metric_1h", lagging.tenantId, l, { at: "2026-11-13T20:00:00Z", count: 3 });
  await insert("api_metric_1m", lagging.tenantId, l, { at: "2026-11-13T20:10:00Z", count: 1000 }); // already in 1h
  await insert("api_metric_1m", lagging.tenantId, l, { at: "2026-11-14T03:15:00Z", count: 5 });

  idle = await createProject("idle");
  empty = await createProject("empty", { services: 0 });
  removed = await createProject("removed", { status: "removed" });
  await insert("api_metric_1m", removed.tenantId, removed.services[0]!, { at: "2026-11-14T09:30:00Z", count: 50 });
});

beforeEach(() => {
  sessionUser = null;
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await cleanup();
  await sql.end();
});

describe("read", () => {
  it("sums the non-archived services of each active project, without counting anything twice", async () => {
    const projects = mine(await getApiOverview(operator, resolvePeriod("7d", NOW)));
    const by = new Map(projects.map((p) => [p.tenantId, p]));
    expect(projects.map((p) => p.tenantId).sort()).toEqual(
      [busy, lagging, idle, empty].map((p) => p.tenantId).sort(),
    );
    expect(by.get(busy.tenantId)).toMatchObject({
      services: 2,
      totals: { requests: 137, clientErrors: 20, serverErrors: 10 },
    });
    expect(by.get(lagging.tenantId)!.totals.requests).toBe(8);
    expect(by.get(idle.tenantId)).toMatchObject({ services: 1, totals: { requests: 0, p50: null, p95: null } });
    expect(by.get(empty.tenantId)).toMatchObject({ services: 0, totals: { requests: 0 } });
  });

  it("shows the same numbers as each service's dashboard", async () => {
    for (const key of ["24h", "7d", "30d", "12m"] as const) {
      const period = resolvePeriod(key, NOW);
      const overview = new Map(mine(await getApiOverview(operator, period)).map((p) => [p.tenantId, p]));
      for (const project of [busy, lagging, idle]) {
        const ctx = (await loadTenantContext(project.userId))!;
        let requests = 0;
        let serverErrors = 0;
        let clientErrors = 0;
        for (const serviceId of project.services) {
          const d = await getServiceDashboard(ctx, serviceId, period);
          if (!d) continue; // archived
          requests += d.totals.requests;
          serverErrors += d.totals.serverErrors;
          clientErrors += d.totals.clientErrors;
        }
        expect(overview.get(project.tenantId)!.totals, `${key} ${project.name}`).toMatchObject({
          requests,
          serverErrors,
          clientErrors,
        });
      }
    }
    // With a single service, the percentiles match too.
    const ctx = (await loadTenantContext(lagging.userId))!;
    const service = await getServiceDashboard(ctx, lagging.services[0]!, resolvePeriod("7d", NOW));
    const project = mine(await getApiOverview(operator, resolvePeriod("7d", NOW))).find((p) => p.tenantId === lagging.tenantId)!;
    expect(project.totals.p50).toBeCloseTo(service!.totals.p50!, 9);
    expect(project.totals.p95).toBeCloseTo(service!.totals.p95!, 9);
  });

  it("an hourly period does not read 1d", async () => {
    const project = mine(await getApiOverview(operator, resolvePeriod("24h", NOW))).find((p) => p.tenantId === busy.tenantId)!;
    // 24 hours up to NOW: the 05:00 hour (1h) and the 09:30 minute (1m).
    expect(project.totals.requests).toBe(27);
  });
});
