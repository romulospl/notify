// Site provisioning in Umami and statistics reads (#58), against
// the DATABASE_URL Postgres and a fake Umami (test/fake-umami.ts).
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadTenantContext, type OperatorContext, type TenantContext } from "@/lib/access";
import { createSite, getSite, listSites, normalizeDomain, SiteInputError } from "@/lib/data/sites";
import { db, sql } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { site, tenant, tenantMember, user } from "@/lib/db/schema";
import { findUmamiInconsistencies } from "@/lib/umami/consistency";
import { UmamiError } from "@/lib/umami/http";
import { provisionUmamiWebsite } from "@/lib/umami/provision";
import { getSiteStats } from "@/lib/umami/stats";
import { startFakeUmami, type FakeUmami } from "./fake-umami";

const DOMAIN = "@umami-test.stellytics.invalid";
const SLUG = "umami-test-";
const RANGE = { startAt: new Date(0), endAt: new Date() };

let umami: FakeUmami;

async function createMember(status: "active" | "removed" = "active"): Promise<TenantContext> {
  const userId = randomUUID();
  await db.insert(user).values({ id: userId, name: "Test", email: `${userId}${DOMAIN}`, emailVerified: true });
  const [created] = await db
    .insert(tenant)
    .values({ name: "Project", slug: `${SLUG}${randomUUID()}`, status })
    .returning();
  await db.insert(tenantMember).values({ tenantId: created!.id, userId, role: "owner" });
  return (await loadTenantContext(userId))!;
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
  umami.requests.length = 0;
  umami.createBodies.length = 0;
});

afterAll(async () => {
  await cleanup();
  await umami.close();
  await sql.end();
});

describe("tenant context", () => {
  it("comes from the user's membership, with the tenant status", async () => {
    const ctx = await createMember("removed");
    expect(ctx.memberRole).toBe("owner");
    expect(ctx.tenantStatus).toBe("removed");
  });

  it("is null for someone who is not a member", async () => {
    const userId = randomUUID();
    await db.insert(user).values({ id: userId, name: "T", email: `${userId}${DOMAIN}` });
    expect(await loadTenantContext(userId)).toBeNull();
  });
});

describe("site creation", () => {
  it("normalizes the domain", () => {
    expect(normalizeDomain(" HTTPS://App.Example.org/a?b#c ")).toBe("app.example.org");
    expect(normalizeDomain("example.org.")).toBe("example.org");
    expect(normalizeDomain("localhost:3000")).toBe("localhost:3000");
  });

  it("creates the site in Umami and stores the link in stellytics", async () => {
    const ctx = await createMember();
    const created = await createSite(ctx, { name: " Docs ", domain: "https://Docs.Example.org/start" });

    expect(created).toMatchObject({ tenantId: ctx.tenantId, name: "Docs", domain: "docs.example.org" });
    expect(umami.websites.get(created.umamiWebsiteId)).toMatchObject({
      name: "Docs",
      domain: "docs.example.org",
    });
    expect(await listSites(ctx)).toEqual([created]);
  });

  it("uses the API key from the environment variable and only creates sites", async () => {
    const ctx = await createMember();
    await createSite(ctx, { name: "Only sites", domain: "only.example.org" });
    expect(umami.requests).toEqual([{ method: "POST", path: "/api/websites" }]);
  });

  it("creates the site with name and domain only, without enabling session recording or heatmaps (#62)", async () => {
    const ctx = await createMember();
    await createSite(ctx, { name: "No recorder", domain: "norec.example.org" });
    expect(umami.createBodies).toEqual([{ name: "No recorder", domain: "norec.example.org" }]);
  });

  it("rejects an invalid or repeated domain without calling Umami", async () => {
    const ctx = await createMember();
    await createSite(ctx, { name: "First", domain: "repeat.example.org" });
    umami.requests.length = 0;

    await expect(createSite(ctx, { name: "Again", domain: "REPEAT.example.org" })).rejects.toThrow(
      SiteInputError,
    );
    await expect(createSite(ctx, { name: "Bad", domain: "not a domain" })).rejects.toThrow(SiteInputError);
    await expect(createSite(ctx, { name: "", domain: "empty.example.org" })).rejects.toThrow(SiteInputError);
    expect(umami.requests).toEqual([]);
  });

  it("the same domain may exist in different tenants", async () => {
    const a = await createMember();
    const b = await createMember();
    await createSite(a, { name: "A", domain: "shared.example.org" });
    await expect(createSite(b, { name: "B", domain: "shared.example.org" })).resolves.toBeTruthy();
  });

  it("a removed tenant creates no site", async () => {
    const ctx = await createMember("removed");
    await expect(createSite(ctx, { name: "Nope", domain: "nope.example.org" })).rejects.toThrow(
      SiteInputError,
    );
    expect(umami.requests).toEqual([]);
  });

  it("deletes the site from Umami when the write fails", async () => {
    const before = umami.websites.size;
    await expect(
      provisionUmamiWebsite({ name: "Rollback", domain: "rollback.example.org" }, async () => {
        throw new Error("simulated write failure");
      }),
    ).rejects.toThrow("simulated write");
    expect(umami.websites.size).toBe(before);
    expect(umami.requests.map((r) => r.method)).toEqual(["POST", "DELETE"]);
  });

  it("fails with a clear error when the key is rejected", async () => {
    const ctx = await createMember();
    const original = process.env.UMAMI_API_KEY;
    process.env.UMAMI_API_KEY = "umami_wrong-key";
    try {
      await expect(createSite(ctx, { name: "X", domain: "wrong-key.example.org" })).rejects.toThrow(
        UmamiError,
      );
    } finally {
      process.env.UMAMI_API_KEY = original;
    }
    expect(await listSites(ctx)).toEqual([]);
  });
});

describe("statistics read", () => {
  it("reads the statistics of its own site", async () => {
    const ctx = await createMember();
    const own = await createSite(ctx, { name: "Own", domain: "own.example.org" });
    umami.requests.length = 0;

    const stats = await getSiteStats(ctx, own.id, RANGE);
    expect(stats?.pageviews).toBe(7);
    expect(umami.requests).toEqual([
      { method: "GET", path: `/api/websites/${own.umamiWebsiteId}/stats` },
    ]);
  });

  it("rejects another tenant's site before reaching Umami", async () => {
    const a = await createMember();
    const b = await createMember();
    const ofB = await createSite(b, { name: "B", domain: "b-only.example.org" });
    umami.requests.length = 0;

    expect(await getSite(a, ofB.id)).toBeNull();
    expect(await getSiteStats(a, ofB.id, RANGE)).toBeNull();
    // Not even B's Umami ID works as a portal site ID.
    expect(await getSiteStats(a, ofB.umamiWebsiteId, RANGE)).toBeNull();
    expect(await getSiteStats(a, "not-a-uuid", RANGE)).toBeNull();
    expect(umami.requests).toEqual([]);
  });

  it("an archived site is not read", async () => {
    const ctx = await createMember();
    const archived = await createSite(ctx, { name: "Old", domain: "old.example.org" });
    await db.update(site).set({ archivedAt: new Date() }).where(eq(site.id, archived.id));
    umami.requests.length = 0;

    expect(await getSiteStats(ctx, archived.id, RANGE)).toBeNull();
    expect(umami.requests).toEqual([]);
  });
});

describe("consistency between portal and Umami", () => {
  it("flags a site missing from Umami and an Umami site without a link", async () => {
    const ctx = await createMember();
    const kept = await createSite(ctx, { name: "Kept", domain: "kept.example.org" });
    const lost = await createSite(ctx, { name: "Lost", domain: "lost.example.org" });
    umami.websites.delete(lost.umamiWebsiteId);
    const orphanId = randomUUID();
    umami.websites.set(orphanId, { id: orphanId, name: "Orphan", domain: "orphan.example.org" });

    // Only the test builds the context by hand; in the portal it comes from requireOperatorContext().
    const operator = { userId: "test-operator" } as OperatorContext;
    const result = await findUmamiInconsistencies(operator);
    expect(result.missingInUmami).toContain(lost.id);
    expect(result.missingInUmami).not.toContain(kept.id);
    expect(result.orphanedInUmami).toEqual([orphanId]);
    umami.websites.delete(orphanId);
  });
});
