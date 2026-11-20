// Tenant web dashboard (#28): periods, formatting, Umami read and page,
// against the DATABASE_URL Postgres and a fake Umami with the 3.4.1 responses.
import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
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
import { DEFAULT_EVENT_VALUES, DEFAULT_METRICS, startFakeUmami, type FakeUmami } from "./fake-umami";

const DOMAIN = "@web-dashboard-test.stellytics.invalid";
const SLUG = "web-dashboard-test-";
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

describe("periods", () => {
  it("an unknown value in the URL becomes 7 days", () => {
    expect(parsePeriodKey("30d")).toBe("30d");
    for (const raw of [undefined, "", "1y", ["30d"], "__proto__", "toString"]) {
      expect(parsePeriodKey(raw)).toBe("7d");
    }
  });

  it("each period ends now and starts at the beginning of a bucket, in UTC", () => {
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

describe("formatting", () => {
  it("numbers, duration and Umami's ratios", () => {
    expect([formatCount(1284), formatCount(12_900), formatCount(4_200_000)]).toEqual(["1,284", "12.9K", "4.2M"]);
    expect([formatDuration(45), formatDuration(65), formatDuration(7380)]).toEqual(["45s", "1m 05s", "2h 03m"]);
    expect(averageVisitSeconds({ totaltime: 90, visits: 2 })).toBe(45);
    expect(averageVisitSeconds({ totaltime: 0, visits: 0 })).toBe(0);
    expect(bounceRate({ bounces: 1, visits: 4 })).toBe(0.25);
    expect(bounceRate({ bounces: 0, visits: 0 })).toBe(0);
  });

  it("country and browser names", () => {
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

describe("dashboard read", () => {
  it("asks Umami for the period, the bucket in UTC and at most 10 items per list", async () => {
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

  it("returns the 7 metrics and fills the empty buckets of the series", async () => {
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

  it("an unknown country (null in Umami) becomes an empty name", async () => {
    const m = await createMember();
    umami.metrics = { ...DEFAULT_METRICS, country: [{ x: null, y: 1 }] };
    const data = await getSiteDashboard(m.ctx, m.siteId, resolvePeriod("7d", NOW));
    expect(data!.breakdowns.country).toEqual([{ name: "", visitors: 1 }]);
  });

  it("another tenant's site returns null without calling Umami", async () => {
    const a = await createMember();
    const b = await createMember();
    expect(await getSiteDashboard(a.ctx, b.siteId, resolvePeriod("7d", NOW))).toBeNull();
    expect(await getSiteDashboard(a.ctx, b.umamiWebsiteId, resolvePeriod("7d", NOW))).toBeNull();
    expect(umami.requests).toEqual([]);
  });
});
