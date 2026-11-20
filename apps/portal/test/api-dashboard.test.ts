// Tenant API dashboard (#37): which table each part of the period comes from, the
// metrics read and the page, against the DATABASE_URL Postgres.
import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTenantContext, type TenantContext } from "@/lib/access";
import { getServiceDashboard, metricSources } from "@/lib/data/api-metrics";
import { db, sql } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { apiService, tenant, tenantMember, user } from "@/lib/db/schema";
import { formatLatency, formatShare, statusLabel } from "@/lib/format";
import { resolvePeriod } from "@/lib/period";

const DOMAIN = "@api-dashboard-test.stellytics.invalid";
const SLUG = "api-dashboard-test-";
// hourCut = 09:00 and dayCut = 14 November 00:00 (UTC).
const NOW = new Date("2026-11-14T10:37:12.345Z");

let sessionUser: { id: string; role: "tenant" | "operator" } | null = null;
vi.mock("@/lib/session", () => ({
  requireSession: async () => {
    if (!sessionUser) throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;/sign-in" });
    return { user: { ...sessionUser, name: "Test", email: "test@example.invalid", emailVerified: true } };
  },
}));

type Member = { userId: string; tenantId: string; ctx: TenantContext; serviceId: string };

async function createMember(status: "active" | "removed" = "active"): Promise<Member> {
  const userId = randomUUID();
  await db.insert(user).values({ id: userId, name: "Test", email: `${userId}${DOMAIN}`, emailVerified: true });
  const [t] = await db
    .insert(tenant)
    .values({ name: "Project", slug: `${SLUG}${randomUUID()}`, status, statusReason: status === "removed" ? "Spam" : null })
    .returning();
  await db.insert(tenantMember).values({ tenantId: t!.id, userId, role: "owner" });
  const [s] = await db.insert(apiService).values({ tenantId: t!.id, name: "horizon-proxy" }).returning();
  return { userId, tenantId: t!.id, ctx: (await loadTenantContext(userId))!, serviceId: s!.id };
}

// 15 positions, like api_metric_bounds() plus the bucket above 10 s.
function buckets(counts: Record<number, number>): number[] {
  return Array.from({ length: 15 }, (_, i) => counts[i] ?? 0);
}

type Point = { at: string; route?: string; method?: string; status?: number; count: number; b?: Record<number, number> };

async function insert(table: "api_metric_1m" | "api_metric_1h" | "api_metric_1d", m: Member, p: Point, serviceId = m.serviceId) {
  const b = buckets(p.b ?? { 2: p.count });
  await sql`
    INSERT INTO ${sql(table)} (bucket_start, tenant_id, api_service_id, route, method, status_code,
                               request_count, duration_sum, duration_buckets)
    VALUES (${p.at}, ${m.tenantId}, ${serviceId}, ${p.route ?? "/ledgers/{id}"}, ${p.method ?? "GET"},
            ${p.status ?? 200}, ${p.count}, ${p.count * 0.02}, ${b}::bigint[])`;
}




async function cleanup() {
  const ids = (await db.select({ id: tenant.id }).from(tenant).where(like(tenant.slug, `${SLUG}%`))).map(
    (t) => t.id,
  );
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

beforeAll(async () => {
  await runMigrations();
  await cleanup();
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

describe("which table each part comes from", () => {
  const iso = (r: { from: Date; to: Date } | null) => r && { from: r.from.toISOString(), to: r.to.toISOString() };
  // Job up to date: the last rolled-up hour ended 5 minutes ago or more.
  const CAUGHT_UP = new Date("2026-11-14T10:00:00Z");

  it("closed days from 1d, closed hours from 1h and the last two hours from 1m", () => {
    const s = metricSources(resolvePeriod("7d", NOW), CAUGHT_UP);
    expect(iso(s.day)).toEqual({ from: "2026-11-08T00:00:00.000Z", to: "2026-11-14T00:00:00.000Z" });
    expect(iso(s.hour)).toEqual({ from: "2026-11-14T00:00:00.000Z", to: "2026-11-14T09:00:00.000Z" });
    expect(iso(s.minute)).toEqual({ from: "2026-11-14T09:00:00.000Z", to: NOW.toISOString() });
  });

  it("an hourly period does not use 1d", () => {
    const s = metricSources(resolvePeriod("24h", NOW), CAUGHT_UP);
    expect(s.day).toBeNull();
    expect(iso(s.hour)).toEqual({ from: "2026-11-13T11:00:00.000Z", to: "2026-11-14T09:00:00.000Z" });
    expect(iso(s.minute)).toEqual({ from: "2026-11-14T09:00:00.000Z", to: NOW.toISOString() });
  });

  it("late job: what was not rolled up still comes from 1m", () => {
    const s = metricSources(resolvePeriod("7d", NOW), new Date("2026-11-13T21:00:00Z"));
    expect(iso(s.day)).toEqual({ from: "2026-11-08T00:00:00.000Z", to: "2026-11-13T00:00:00.000Z" });
    expect(iso(s.hour)).toEqual({ from: "2026-11-13T00:00:00.000Z", to: "2026-11-13T21:00:00.000Z" });
    expect(iso(s.minute)).toEqual({ from: "2026-11-13T21:00:00.000Z", to: NOW.toISOString() });
  });

  it("nothing rolled up yet: everything from 1m", () => {
    const period = resolvePeriod("30d", NOW);
    const s = metricSources(period, null);
    expect(s.day!.from >= s.day!.to).toBe(true);
    expect(s.hour.from >= s.hour.to).toBe(true);
    expect(iso(s.minute)).toEqual({ from: period.startAt.toISOString(), to: NOW.toISOString() });
  });

  it("right after midnight, the previous day still comes from 1h", () => {
    const at = new Date("2026-11-14T00:30:00Z");
    const s = metricSources(resolvePeriod("12m", at), at);
    expect(iso(s.day)).toEqual({ from: "2025-12-01T00:00:00.000Z", to: "2026-11-13T00:00:00.000Z" });
    expect(iso(s.hour)).toEqual({ from: "2026-11-13T00:00:00.000Z", to: "2026-11-13T23:00:00.000Z" });
    expect(iso(s.minute)).toEqual({ from: "2026-11-13T23:00:00.000Z", to: at.toISOString() });
  });
});

describe("formatting", () => {
  it("latency in ms or s, capped at 10 s", () => {
    expect(formatLatency(null)).toBe("—");
    expect(formatLatency(0.0082)).toBe("8.2 ms");
    expect(formatLatency(0.375)).toBe("375 ms");
    expect(formatLatency(1.25)).toBe("1.25 s");
    expect(formatLatency(10)).toBe("≥ 10 s");
  });

  it("fraction with one decimal place below 10% and never zero when there was an error", () => {
    expect(formatShare(5, 122)).toBe("4.1%");
    expect(formatShare(1, 5000)).toBe("< 0.1%");
    expect(formatShare(0, 10)).toBe("0.0%");
    expect(formatShare(50, 100)).toBe("50%");
    expect(formatShare(9.97, 100)).toBe("10%");
    expect(formatShare(995, 1000)).toBe("> 99%");
    expect(formatShare(10, 10)).toBe("100%");
    expect(formatShare(0, 0)).toBe("—");
  });

  it("status with its name, 0 as unknown", () => {
    expect(statusLabel(404)).toBe("404 Not Found");
    expect(statusLabel(299)).toBe("299");
    expect(statusLabel(0)).toBe("Unknown");
  });
});

describe("metrics read", () => {
  it("joins 1d, 1h and 1m without counting anything twice, only for the tenant's service", async () => {
    const a = await createMember();
    const b = await createMember();
    const [otherService] = await db.insert(apiService).values({ tenantId: a.tenantId, name: "other" }).returning();

    // What counts (7-day period up to NOW).
    await insert("api_metric_1d", a, { at: "2026-11-10T00:00:00Z", count: 100 });
    await insert("api_metric_1d", a, { at: "2026-11-10T00:00:00Z", status: 500, count: 5 });
    await insert("api_metric_1h", a, {
      at: "2026-11-14T05:00:00Z",
      route: "/accounts/{address}",
      method: "POST",
      status: 404,
      count: 10,
      b: { 7: 10 }, // (0.25, 0.5]
    });
    await insert("api_metric_1m", a, { at: "2026-11-14T09:30:00Z", count: 7 });

    // What must not count: rows the rollup already covers, the partial current
    // day in 1d, the current hour in 1h, outside the period, another service and
    // another tenant.
    await insert("api_metric_1m", a, { at: "2026-11-10T12:00:00Z", count: 1000 });
    await insert("api_metric_1h", a, { at: "2026-11-10T12:00:00Z", count: 1000 });
    await insert("api_metric_1m", a, { at: "2026-11-14T05:10:00Z", count: 1000 });
    await insert("api_metric_1d", a, { at: "2026-11-14T00:00:00Z", count: 1000 });
    await insert("api_metric_1h", a, { at: "2026-11-14T09:00:00Z", count: 1000 });
    await insert("api_metric_1d", a, { at: "2026-11-07T00:00:00Z", count: 1000 });
    await insert("api_metric_1d", a, { at: "2026-11-10T00:00:00Z", count: 1000 }, otherService!.id);
    await insert("api_metric_1d", b, { at: "2026-11-10T00:00:00Z", count: 1000 });

    const data = (await getServiceDashboard(a.ctx, a.serviceId, resolvePeriod("7d", NOW)))!;
    expect(data.totals).toMatchObject({ requests: 122, clientErrors: 10, serverErrors: 5 });
    expect(data.series.map((p) => p.requests)).toEqual([0, 0, 105, 0, 0, 0, 17]);
    expect(data.series[0]).toMatchObject({ requests: 0, p50: null, p95: null });

    expect(data.endpointCount).toBe(2);
    expect(data.endpoints.map((e) => [e.method, e.route, e.requests, e.clientErrors, e.serverErrors])).toEqual([
      ["GET", "/ledgers/{id}", 112, 0, 5],
      ["POST", "/accounts/{address}", 10, 10, 0],
    ]);
    // A single bucket: linear interpolation inside (0.25, 0.5].
    expect(data.endpoints[1]!.p50).toBeCloseTo(0.375, 6);
    expect(data.endpoints[1]!.p95).toBeCloseTo(0.4875, 6);
    expect(data.statuses).toEqual([
      { statusCode: 200, requests: 107 },
      { statusCode: 404, requests: 10 },
      { statusCode: 500, requests: 5 },
    ]);

    // Another tenant's service: null, without reading metrics.
    expect(await getServiceDashboard(a.ctx, b.serviceId, resolvePeriod("7d", NOW))).toBeNull();
  });

  it("an hourly period reads 1h even where the rolled-up day already exists", async () => {
    const a = await createMember();
    await insert("api_metric_1h", a, { at: "2026-11-13T20:00:00Z", count: 3 });
    await insert("api_metric_1d", a, { at: "2026-11-13T00:00:00Z", count: 1000 });
    const data = (await getServiceDashboard(a.ctx, a.serviceId, resolvePeriod("24h", NOW)))!;
    expect(data.series).toHaveLength(24);
    expect(data.totals.requests).toBe(3);
    expect(data.series.find((p) => p.requests > 0)!.at.toISOString()).toBe("2026-11-13T20:00:00.000Z");
  });

  it("with the job stopped, the hours only in 1m show up and nothing counts twice", async () => {
    const a = await createMember();
    // Last rolled-up hour: 13 November 20:00. After that, only minutes.
    await insert("api_metric_1h", a, { at: "2026-11-13T20:00:00Z", count: 3 });
    await insert("api_metric_1d", a, { at: "2026-11-13T00:00:00Z", count: 3 });
    await insert("api_metric_1m", a, { at: "2026-11-13T20:10:00Z", count: 1000 }); // already in 1h
    await insert("api_metric_1m", a, { at: "2026-11-13T23:30:00Z", count: 4 });
    await insert("api_metric_1m", a, { at: "2026-11-14T03:15:00Z", count: 5 });
    const day = (await getServiceDashboard(a.ctx, a.serviceId, resolvePeriod("7d", NOW)))!;
    expect(day.totals.requests).toBe(12);
    expect(day.series.slice(-2).map((p) => p.requests)).toEqual([7, 5]);
    const hour = (await getServiceDashboard(a.ctx, a.serviceId, resolvePeriod("24h", NOW)))!;
    expect(hour.totals.requests).toBe(12);
  });

  it("no data: zeros, null percentiles and empty lists", async () => {
    const a = await createMember();
    const data = (await getServiceDashboard(a.ctx, a.serviceId, resolvePeriod("30d", NOW)))!;
    expect(data.totals).toEqual({ requests: 0, clientErrors: 0, serverErrors: 0, p50: null, p95: null });
    expect(data.series).toHaveLength(30);
    expect(data.endpoints).toEqual([]);
    expect(data.statuses).toEqual([]);
  });
});
