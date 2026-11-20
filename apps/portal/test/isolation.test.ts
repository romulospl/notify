// Tenant isolation suite (#21, E2 spec, section 8).
//
// Two tenants (A and B), each with a site, a service and an ingest key, an
// SCF operator and a user without a project. The cases go through what the
// browser reaches (pages and server actions, with the session mocked) and what
// ingestion reads (the views of stellytics_ingest and stellytics_collector). Runs
// against the DATABASE_URL Postgres and a fake Umami.
//
// The collector part lives in its own e2e (services/collector/e2e/): key of a
// removed tenant rejected (e2e_test.go) and key revoked or tenant removed
// AFTER being accepted rejected within the cache time, with reactivation, and A's key
// sending data that claims to be B's, stored as A (isolation_test.go). Each new dashboard
// (#28, #29, #37 and #38) adds its own cases to this suite.
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDemoContext, loadTenantContext, type OperatorContext, type TenantContext } from "@/lib/access";
import { auth } from "@/lib/auth";
import { createApiService, createIngestKey, getApiService, revokeIngestKey } from "@/lib/data/api-services";
import { createReadKey } from "@/lib/data/operator/api-keys";
import { ANONYMIZED_ACTOR, deleteOwnAccount } from "@/lib/data/erasure";
import {
  approveTenant,
  purgeRemovedTenant,
  reactivateTenant,
  rejectTenant,
  removeTenant,
  TenantStatusError,
} from "@/lib/data/operator/tenants";
import { resetRateLimits } from "@/lib/rate-limit";
import { GET as readApiProjects } from "@/app/api/v1/projects/route";
import { GET as readApiWeb } from "@/app/api/v1/web/route";
import { GET as readApiApi } from "@/app/api/v1/api/route";
import { getSite, listSites } from "@/lib/data/sites";
import { db, sql } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { account, apiService, auditLog, ingestKey, operatorApiKey, site, tenant, tenantMember, user } from "@/lib/db/schema";
import { listActiveTenantSites } from "@/lib/data/operator/sites";
import { getSiteStats } from "@/lib/umami/stats";
import { getServiceDashboard } from "@/lib/data/api-metrics";
import { resolvePeriod } from "@/lib/period";
import Home from "@/app/page";
import DemoPage from "@/app/(demo)/demo/page";
import DemoOperatorPage from "@/app/(demo)/operator/page";
import PublicCardPage from "@/app/p/[slug]/page";
import { getDemoApiOverview } from "@/lib/data/operator/api";
import { listApiServices } from "@/lib/data/api-services";
import { resetDemoCache } from "@/lib/demo-cache";
import { getDemoWebOverview } from "@/lib/umami/overview";
import { startFakeUmami, type FakeUmami } from "./fake-umami";
import { asRole } from "./helpers/as-role";

const DOMAIN = "@isolation-test.stellytics.invalid";
const SLUG = "isolation-test-";
const PASSWORD = "isolation-password-123";
const RANGE = { startAt: new Date(0), endAt: new Date() };
const NOT_FOUND = { digest: expect.stringContaining("404") };

// User of the mocked session; null simulates someone not signed in.
let sessionUser: { id: string; role: "tenant" | "operator" } | null = null;

vi.mock("@/lib/session", () => ({
  requireSession: async () => {
    if (!sessionUser) throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;/sign-in" });
    return { user: { ...sessionUser, name: "Test", email: "test@example.invalid", emailVerified: true } };
  },
}));
// Outside a Next request, refresh() fails; here it has no effect.
vi.mock("next/cache", () => ({ refresh: vi.fn() }));
// The public home page reads the request headers to look for a session.
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

type Fixture = {
  userId: string;
  email: string;
  tenantId: string;
  ctx: TenantContext;
  siteId: string;
  umamiWebsiteId: string;
  serviceId: string;
  keyId: string;
  keyPrefix: string;
};

let umami: FakeUmami;
let A: Fixture;
let B: Fixture;
let operatorId: string;

const op = () => ({ userId: operatorId }) as OperatorContext;

function signIn(as: { id: string; role: "tenant" | "operator" } | null) {
  sessionUser = as;
}


async function createUser(role: "tenant" | "operator" = "tenant") {
  const id = randomUUID();
  const email = `${id}${DOMAIN}`;
  await db.insert(user).values({ id, name: "Test", email, emailVerified: true, role });
  return { id, email };
}

// Tenant with an owner, a site (already existing in the fake Umami), a service
// and the first key, created by the same functions the portal uses.
async function createFixture(name: string): Promise<Fixture> {
  const owner = await createUser();
  await db.insert(account).values({
    id: randomUUID(),
    accountId: owner.id,
    providerId: "credential",
    userId: owner.id,
    password: await hashPassword(PASSWORD),
  });
  const [t] = await db
    .insert(tenant)
    .values({ name, slug: `${SLUG}${randomUUID()}` })
    .returning();
  await db.insert(tenantMember).values({ tenantId: t!.id, userId: owner.id, role: "owner" });
  const ctx = (await loadTenantContext(owner.id))!;

  const umamiWebsiteId = randomUUID();
  umami.websites.set(umamiWebsiteId, { id: umamiWebsiteId, name, domain: `${name}.example` });
  const [s] = await db
    .insert(site)
    .values({ tenantId: t!.id, name, domain: `${name}.example`, umamiWebsiteId })
    .returning();

  const { service, firstKey } = await createApiService(ctx, { name: `${name}-api` });
  return {
    userId: owner.id,
    email: owner.email,
    tenantId: t!.id,
    ctx,
    siteId: s!.id,
    umamiWebsiteId,
    serviceId: service.id,
    keyId: firstKey.summary.id,
    keyPrefix: firstKey.summary.prefix,
  };
}


async function tenantStatus(tenantId: string) {
  const [row] = await db.select({ status: tenant.status }).from(tenant).where(eq(tenant.id, tenantId));
  return row!.status;
}

// What the web gateway (#61) and the collector (#30) see, with their roles.
async function acceptsWeb(umamiWebsiteId: string) {
  const [row] = await asRole<{ accepts_ingest: boolean }>(
    "stellytics_ingest",
    `select accepts_ingest from ingest_site where umami_website_id = '${umamiWebsiteId}'`,
  );
  return row?.accepts_ingest ?? false;
}

async function collectorKey(prefix: string) {
  const [row] = await asRole<{ tenant_id: string; api_service_id: string }>(
    "stellytics_collector",
    `select tenant_id, api_service_id from ingest_key_active where prefix = '${prefix}'`,
  );
  return row ?? null;
}

async function cleanup() {
  const ids = (await db.select({ id: tenant.id }).from(tenant).where(like(tenant.slug, `${SLUG}%`))).map(
    (t) => t.id,
  );
  if (ids.length > 0) {
    for (const t of ["api_metric_1m", "api_metric_1h", "api_metric_1d"]) {
      await sql`DELETE FROM ${sql(t)} WHERE tenant_id IN ${sql(ids)}`;
    }
    await db.delete(ingestKey).where(inArray(ingestKey.tenantId, ids));
    await db.delete(apiService).where(inArray(apiService.tenantId, ids));
    await db.delete(site).where(inArray(site.tenantId, ids));
    await db.delete(tenantMember).where(inArray(tenantMember.tenantId, ids));
    await db.delete(tenant).where(inArray(tenant.id, ids));
  }
  const users = (await db.select({ id: user.id }).from(user).where(like(user.email, `%${DOMAIN}`))).map((u) => u.id);
  if (users.length > 0) await db.delete(operatorApiKey).where(inArray(operatorApiKey.createdBy, users));
  await db.delete(user).where(like(user.email, `%${DOMAIN}`));
}

beforeAll(async () => {
  await runMigrations();
  await cleanup();
  umami = await startFakeUmami(process.env.UMAMI_API_KEY!);
  process.env.UMAMI_URL = umami.url;

  A = await createFixture("tenant-a");
  B = await createFixture("tenant-b");
  operatorId = (await createUser("operator")).id;
});

beforeEach(() => {
  resetRateLimits();
  resetDemoCache();
  delete process.env.DEMO_TENANT_SLUG;
  signIn(null);
  umami.requests.length = 0;
});

afterAll(async () => {
  await cleanup();
  await umami.close();
  await sql.end();
});

describe("member of A facing B's resources", () => {

  it("tries to change their own role from the client: ignored", async () => {
    const headers = (cookie?: string) => ({
      "content-type": "application/json",
      origin: "http://localhost:3000",
      "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 250) + 1}`,
      ...(cookie ? { cookie } : {}),
    });
    const signedIn = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ email: A.email, password: PASSWORD }),
      }),
    );
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    const updateUser = (body: unknown) =>
      auth.handler(
        new Request("http://localhost:3000/api/auth/update-user", {
          method: "POST",
          headers: headers(cookie),
          body: JSON.stringify(body),
        }),
      );
    // Control: the session is valid and their own name can change.
    expect((await updateUser({ name: "Member A" })).status).toBe(200);
    // The role cannot: Better Auth rejects the field (input: false in src/lib/auth.ts).
    const forged = await updateUser({ name: "Operator A", role: "operator" });
    expect(forged.ok).toBe(false);

    const [row] = await db.select({ role: user.role, name: user.name }).from(user).where(eq(user.id, A.userId));
    expect(row!.name).toBe("Member A");
    expect(row!.role).toBe("tenant");
  });

});

describe("API ingestion (contract with the collector)", () => {
  it("A's key always resolves to A's tenant and service", async () => {
    // The collector only reads tenant and service from this view (E2 spec, section 5, D5).
    expect(await collectorKey(A.keyPrefix)).toEqual({ tenant_id: A.tenantId, api_service_id: A.serviceId });
  });

  it("A's revoked key leaves the collector's view right away", async () => {
    const created = await createIngestKey(A.ctx, A.serviceId);
    expect(await collectorKey(created!.summary.prefix)).not.toBeNull();
    expect(await revokeIngestKey(A.ctx, created!.summary.id)).toBe(true);
    expect(await collectorKey(created!.summary.prefix)).toBeNull();
    // B does not revoke A's key.
    expect(await revokeIngestKey(B.ctx, A.keyId)).toBeNull();
    expect(await collectorKey(A.keyPrefix)).not.toBeNull();
  });
  // "A's key sends metrics claiming to be tenant B's: stored as A" lives in the
  // collector's e2e (TestKeyOfAClaimingBIsStoredAsA), which goes through the exporter.

  // The collector rejects the revoked key within the cache time (at most 60 s):
  // services/collector/e2e/isolation_test.go.
});

describe("tenant B removed", () => {
  it("B's web event and key stop being valid; A carries on; reactivating restores them", async () => {
    expect(await acceptsWeb(B.umamiWebsiteId)).toBe(true);
    expect(await collectorKey(B.keyPrefix)).not.toBeNull();

    expect(await removeTenant(op(), B.tenantId, { reason: "Not a Stellar project" })).toBe("changed");
    // The gateway answers 204 and drops it (end-to-end test in
    // services/ingest-web/e2e); the collector answers 401.
    expect(await acceptsWeb(B.umamiWebsiteId)).toBe(false);
    expect(await collectorKey(B.keyPrefix)).toBeNull();
    expect(await acceptsWeb(A.umamiWebsiteId)).toBe(true);
    expect(await collectorKey(A.keyPrefix)).not.toBeNull();
    const active = (await listActiveTenantSites(op())).map((p) => p.tenantId);
    expect(active).toContain(A.tenantId);
    expect(active).not.toContain(B.tenantId);

    expect(await reactivateTenant(op(), B.tenantId, { reason: "Appeal accepted" })).toBe("changed");
    expect(await acceptsWeb(B.umamiWebsiteId)).toBe(true);
    expect(await collectorKey(B.keyPrefix)).not.toBeNull();

    const actions = await db
      .select({ action: auditLog.action, actor: auditLog.actorUserId })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, B.tenantId), like(auditLog.action, "tenant.%")))
      .orderBy(auditLog.at);
    expect(actions).toEqual([
      { action: "tenant.removed", actor: operatorId },
      { action: "tenant.reactivated", actor: operatorId },
    ]);
  });

  it("removing without a reason is rejected and does not change the status", async () => {
    await expect(removeTenant(op(), B.tenantId, { reason: " " })).rejects.toBeInstanceOf(TenantStatusError);
    expect(await tenantStatus(B.tenantId)).toBe("active");
    expect(await removeTenant(op(), randomUUID(), { reason: "Spam" })).toBeNull();
  });

  // The API metric of removed B is rejected by the collector (401 and
  // Unauthenticated), and is accepted again after reactivation:
  // services/collector/e2e/isolation_test.go.
});

describe("service API dashboard (#37)", () => {
  // One row per recent minute, written directly as the collector would.
  async function metric(tenantId: string, serviceId: string, count: number) {
    const at = new Date(Date.now() - 60_000);
    at.setUTCSeconds(0, 0);
    await sql`
      INSERT INTO api_metric_1m (bucket_start, tenant_id, api_service_id, route, method, status_code,
                                 request_count, duration_sum, duration_buckets)
      VALUES (${at.toISOString()}::timestamptz, ${tenantId}, ${serviceId}, '/isolation', 'GET', 200, ${count}, 0,
              ${Array.from({ length: 15 }, (_, i) => (i === 2 ? count : 0))}::bigint[])`;
  }

  it("A sees only the metrics of its own service; B's is null in the data layer", async () => {
    await metric(A.tenantId, A.serviceId, 3);
    await metric(B.tenantId, B.serviceId, 1000);
    // Row impossible through the collector (A's service with B's tenant): the
    // dashboard filters by both, so it does not show up for A either.
    await metric(B.tenantId, A.serviceId, 500);

    const period = resolvePeriod("24h");
    const own = await getServiceDashboard(A.ctx, A.serviceId, period);
    expect(own!.totals.requests).toBe(3);
    expect(await getServiceDashboard(A.ctx, B.serviceId, period)).toBeNull();
  });
});

describe("SCF read keys (#48)", () => {
  const READ_ROUTES = [
    ["/api/v1/projects", readApiProjects],
    ["/api/v1/web", readApiWeb],
    ["/api/v1/api", readApiApi],
  ] as const;
  const get = (route: (r: Request) => Promise<Response>, path: string, key: string) =>
    route(new Request(`http://portal.test${path}`, { headers: { authorization: `Bearer ${key}` } }));

  it("A's ingest key (ntf_) does not read the read API", async () => {
    const ingest = await createIngestKey(A.ctx, A.serviceId);
    expect(ingest!.key).toMatch(/^ntf_/);
    for (const [path, route] of READ_ROUTES) {
      expect((await get(route, path, ingest!.key)).status).toBe(401);
    }
    expect(umami.requests).toEqual([]);
  });

  it("a read key is neither accepted by the collector nor seen by the gateway", async () => {
    const op = { userId: operatorId } as import("@/lib/access").OperatorContext;
    const { key, summary } = await createReadKey(op, { name: "not-for-collector" });
    // The collector looks up the view by prefix: the read key's prefix is not there.
    expect(await collectorKey(summary.prefix)).toBeNull();
    // And neither the collector nor the gateway has permission on the read keys table.
    await expect(asRole("stellytics_collector", "select prefix from operator_api_key")).rejects.toThrow(/permission denied/);
    await expect(asRole("stellytics_ingest", "select prefix from operator_api_key")).rejects.toThrow(/permission denied/);
    await expect(asRole("stellytics_collector", "select key_hash from operator_api_key")).rejects.toThrow(/permission denied/);
    expect(key).not.toMatch(/^ntf_/);
  });

  it("the API only shows active projects: removed B disappears, A comes back on reactivation, without touching B's Umami", async () => {
    const op = { userId: operatorId } as import("@/lib/access").OperatorContext;
    const { key } = await createReadKey(op, { name: "tenants" });
    const ids = async (path: string, route: (r: Request) => Promise<Response>) =>
      ((await (await get(route, path, key)).json()) as { projects: { id: string }[] }).projects.map((p) => p.id);

    for (const [path, route] of READ_ROUTES) {
      const seen = await ids(path, route);
      expect(seen).toContain(A.tenantId);
      expect(seen).toContain(B.tenantId);
    }
    await db.update(tenant).set({ status: "removed" }).where(eq(tenant.id, B.tenantId));
    try {
      umami.requests.length = 0;
      for (const [path, route] of READ_ROUTES) {
        const seen = await ids(path, route);
        expect(seen).toContain(A.tenantId);
        expect(seen).not.toContain(B.tenantId);
      }
      expect(umami.requests.some((r) => r.path.includes(B.umamiWebsiteId))).toBe(false);
    } finally {
      await db.update(tenant).set({ status: "active" }).where(eq(tenant.id, B.tenantId));
    }
  });
});

// Public demo (/, /demo, /operator): no session, fixed on the tenant of
// DEMO_TENANT_SLUG. Here A is the demo tenant and B is a regular one.
describe("public demo", () => {
  // The home page asks Better Auth for the session; anonymous here.
  const anonymous = () => vi.spyOn(auth.api, "getSession").mockResolvedValue(null);
  const demoPage = (query: Record<string, string | string[]> = {}) => DemoPage({ searchParams: Promise.resolve(query) });
  const operatorPage = (query: Record<string, string | string[]> = {}) =>
    DemoOperatorPage({ searchParams: Promise.resolve(query) });
  const slugOf = async (tenantId: string) =>
    (await db.select({ slug: tenant.slug }).from(tenant).where(eq(tenant.id, tenantId)))[0]!.slug;
  // Earlier cases may have added websites to A: every Umami read must be for
  // one of A's own, and none for B's.
  const onlyA = async () => {
    const own = (await db.select({ id: site.umamiWebsiteId }).from(site).where(eq(site.tenantId, A.tenantId))).map((r) => r.id);
    expect(umami.requests.length).toBeGreaterThan(0);
    expect(umami.requests.every((r) => own.some((id) => r.path.startsWith(`/api/websites/${id}/`)))).toBe(true);
    expect(umami.requests.some((r) => r.path.includes(B.umamiWebsiteId))).toBe(false);
  };

  it("no demo tenant configured: sample data only, nothing read from any tenant", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { DemoNotice } = await import("@/components/demo/demo-notice");
    await expect(demoPage({ tenantId: B.tenantId, siteId: B.siteId })).resolves.toBeTruthy();
    await expect(operatorPage({ compare: [A.tenantId, B.tenantId] })).resolves.toBeTruthy();
    expect(await loadDemoContext()).toBeNull();
    expect(umami.requests).toEqual([]);
    // The "measuring its own site" label is only for real data.
    expect(DemoNotice({ sample: true })).toBeNull();
    expect(renderToStaticMarkup(DemoNotice({ sample: false }))).toContain("measuring its own site");

    // The sample is self-consistent and names no real tenant.
    const { sampleApiOverview, sampleServiceDashboard, sampleSiteDashboard, sampleWebOverview } = await import("@/lib/demo-sample");
    for (const key of ["24h", "7d", "30d", "90d", "12m"] as const) {
      const period = resolvePeriod(key);
      const web = sampleSiteDashboard(period);
      expect(web.series).toHaveLength(period.buckets.length);
      expect(web.totals.pageviews).toBe(web.series.reduce((n, p) => n + p.pageviews, 0));
      expect(web.totals.pageviews).toBeGreaterThan(0);
      const api = sampleServiceDashboard(period);
      expect(api.totals.requests).toBe(api.series.reduce((n, p) => n + p.requests, 0));
      expect(api.statuses.reduce((n, s) => n + s.requests, 0)).toBe(api.totals.requests);
      const ids = [...sampleWebOverview(period).projects, ...sampleApiOverview(period)].map((p) => p.tenantId);
      expect(ids).toEqual(["sample", "sample"]);
    }
  });

  it("anonymous request reads only the demo tenant, whatever the URL says", async () => {
    process.env.DEMO_TENANT_SLUG = await slugOf(A.tenantId);
    const ctx = (await loadDemoContext())!;
    expect(ctx.tenantId).toBe(A.tenantId);

    // Client values naming B are ignored: only `period` is read.
    const forged = { tenant: B.tenantId, tenantId: B.tenantId, siteId: B.siteId, serviceId: B.serviceId, compare: [A.tenantId, B.tenantId], q: "tenant-b" };
    await expect(demoPage(forged)).resolves.toBeTruthy();
    await onlyA();
    umami.requests.length = 0;
    resetDemoCache();
    await expect(operatorPage(forged)).resolves.toBeTruthy();
    await onlyA();

    // The data layer under the pages: B is out of reach with the demo context.
    expect(await getSite(ctx, B.siteId)).toBeNull();
    expect(await getApiService(ctx, B.serviceId)).toBeNull();
    expect(await getServiceDashboard(ctx, B.serviceId, resolvePeriod("24h"))).toBeNull();
    expect((await listSites(ctx)).every((s) => s.tenantId === A.tenantId)).toBe(true);
    expect((await listApiServices(ctx)).every((s) => s.tenantId === A.tenantId)).toBe(true);
    // The demo operator view lists the demo tenant alone, never every project.
    const period = resolvePeriod("7d");
    expect((await getDemoWebOverview(ctx, period)).projects.map((p) => p.tenantId)).toEqual([A.tenantId]);
    expect((await getDemoApiOverview(ctx, period)).map((p) => p.tenantId)).toEqual([A.tenantId]);
  });

  it("public card: only the demo project has one; any other slug is 404 and reads nothing", async () => {
    const card = (slug: string) => PublicCardPage({ params: Promise.resolve({ slug }) });
    const slugA = await slugOf(A.tenantId);
    const slugB = await slugOf(B.tenantId);

    // Sample mode: only the sample project's slug, and nothing is read. A real
    // project's slug does not open a card.
    await expect(card("stellytics")).resolves.toBeTruthy();
    await expect(card(slugA)).rejects.toMatchObject(NOT_FOUND);
    await expect(card(slugB)).rejects.toMatchObject(NOT_FOUND);
    expect(umami.requests).toEqual([]);

    // Tenant mode: A's card reads only A; B's slug and the sample slug are 404.
    process.env.DEMO_TENANT_SLUG = slugA;
    await expect(card(slugB)).rejects.toMatchObject(NOT_FOUND);
    await expect(card("stellytics")).rejects.toMatchObject(NOT_FOUND);
    expect(umami.requests).toEqual([]);
    await expect(card(slugA)).resolves.toBeTruthy();
    await onlyA();
  });

  it("documentation pages are public and read no tenant data", async () => {
    const { createElement, Fragment } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: DocPage } = await import("@/app/docs/[slug]/page");
    const { DOCS } = await import("@/lib/docs");
    const { TRACKER_VERSION } = await import("@/lib/tracker-snippet");
    process.env.DEMO_TENANT_SLUG = await slugOf(A.tenantId);
    for (const doc of DOCS) {
      const page = await DocPage({ params: Promise.resolve({ slug: doc.slug }) });
      // Render the body only: the docs layout holds client components.
      const body = renderToStaticMarkup(createElement(Fragment, null, ...page.props.children));
      // The guides show the newest script version, with placeholders only.
      if (doc.slug === "script-tag" || doc.slug === "quickstart") {
        expect(body, doc.slug).toContain(`/s/v${TRACKER_VERSION}/n.js`);
        expect(body, doc.slug).toContain("&lt;website-id&gt;");
      }
      for (const secret of [A.umamiWebsiteId, B.umamiWebsiteId, A.tenantId, B.tenantId, A.keyPrefix, B.keyPrefix]) {
        expect(body, doc.slug).not.toContain(secret);
      }
    }
    expect(umami.requests).toEqual([]);
  });

  it("removed or unknown demo tenant: 404, nothing read", async () => {
    process.env.DEMO_TENANT_SLUG = await slugOf(A.tenantId);
    await db.update(tenant).set({ status: "removed" }).where(eq(tenant.id, A.tenantId));
    try {
      await expect(demoPage()).rejects.toMatchObject(NOT_FOUND);
      await expect(operatorPage()).rejects.toMatchObject(NOT_FOUND);
      await expect(PublicCardPage({ params: Promise.resolve({ slug: process.env.DEMO_TENANT_SLUG }) })).rejects.toMatchObject(NOT_FOUND);
    } finally {
      await db.update(tenant).set({ status: "active" }).where(eq(tenant.id, A.tenantId));
    }
    process.env.DEMO_TENANT_SLUG = `${SLUG}does-not-exist`;
    await expect(demoPage()).rejects.toMatchObject(NOT_FOUND);
    expect(umami.requests).toEqual([]);
  });

  it("the home page is public and installs the pinned tracker only for the demo tenant's own site", async () => {
    const session = anonymous();
    try {
      const html = async () => {
        const { renderToStaticMarkup } = await import("react-dom/server");
        return renderToStaticMarkup(await Home());
      };
      // No demo tenant: public page, demo with sample data, no tracker.
      let page = await html();
      // The public pages carry no sign-in or sign-up link; /sign-in still exists.
      expect(page).not.toContain('href="/sign-in"');
      expect(page).not.toContain('href="/sign-up"');
      expect(page).toContain("https://github.com/romulospl/stellytics");
      expect(page).toContain('href="/docs"');
      expect(page).toContain('href="/demo"');
      expect(page).toContain("sample data");
      expect(page).not.toContain("<script");

      // Demo tenant set, but no site registered for the portal's own host: no tracker.
      process.env.DEMO_TENANT_SLUG = await slugOf(A.tenantId);
      resetDemoCache();
      page = await html();
      expect(page).toContain('href="/demo"');
      expect(page).not.toContain("sample data");
      expect(page).not.toContain("<script");

      // A's site is the portal's host: the tag carries A's site and the SRI
      // hash of the newest published version.
      const host = new URL(process.env.BETTER_AUTH_URL!).host;
      await db.update(site).set({ domain: host }).where(eq(site.id, A.siteId));
      try {
        resetDemoCache();
        page = await html();
        const sri = (await import("../../../packages/tracker/published/sri.json")).default as Record<string, string>;
        const { TRACKER_VERSION } = await import("@/lib/tracker-snippet");
        expect(page).toContain(`data-site="${A.umamiWebsiteId}"`);
        expect(page).toContain(`integrity="${sri[TRACKER_VERSION]}"`);
        expect(page).toContain(`/s/v${TRACKER_VERSION}/n.js`);
        expect(page).not.toContain(B.umamiWebsiteId);
      } finally {
        await db.update(site).set({ domain: "tenant-a.example" }).where(eq(site.id, A.siteId));
      }
    } finally {
      session.mockRestore();
    }
  });
});

describe("Umami read", () => {
  it("A's context does not read B's site, neither by the portal ID nor by the Umami one", async () => {
    expect(await getSiteStats(A.ctx, A.siteId, RANGE)).toMatchObject({ pageviews: 7 });
    expect(umami.requests).toHaveLength(1);
    umami.requests.length = 0;

    expect(await getSiteStats(A.ctx, B.siteId, RANGE)).toBeNull();
    expect(await getSiteStats(A.ctx, B.umamiWebsiteId, RANGE)).toBeNull();
    expect(await getSiteStats(A.ctx, A.umamiWebsiteId, RANGE)).toBeNull();
    // Rejected before reaching Umami.
    expect(umami.requests).toEqual([]);
  });
});


describe("sign-up with approval (#49)", () => {
  // Pending project with site, service and key. The rows are created with the
  // project active (the data/ functions reject pending) and the status changes
  // afterwards, as if they came from an old sign-up: ingestion and the pages are
  // what is tested here.
  async function pendingFixture(name: string): Promise<Fixture> {
    const f = await createFixture(name);
    await db.update(tenant).set({ status: "pending" }).where(eq(tenant.id, f.tenantId));
    return { ...f, ctx: (await loadTenantContext(f.userId))! };
  }

  let P: Fixture;
  beforeAll(async () => {
    P = await pendingFixture("tenant-pending");
  });

  it("web and API ingestion reject the pending one; A carries on", async () => {
    expect(await acceptsWeb(P.umamiWebsiteId)).toBe(false);
    expect(await collectorKey(P.keyPrefix)).toBeNull();
    expect(await acceptsWeb(A.umamiWebsiteId)).toBe(true);
    expect(await collectorKey(A.keyPrefix)).not.toBeNull();
  });

  it("the operator approves and ingestion starts accepting; everything in the audit_log", async () => {
    expect(await approveTenant(op(), P.tenantId, { reason: "Looks good" })).toBe("changed");
    expect(await tenantStatus(P.tenantId)).toBe("active");
    expect(await acceptsWeb(P.umamiWebsiteId)).toBe(true);
    expect(await collectorKey(P.keyPrefix)).toMatchObject({ tenant_id: P.tenantId });
    // Second approval (two operators at the same time): nothing new.
    expect(await approveTenant(op(), P.tenantId)).toBe("unchanged");
    const audit = await db
      .select({ action: auditLog.action, actor: auditLog.actorUserId })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, P.tenantId), like(auditLog.action, "tenant.%")));
    expect(audit).toEqual([{ action: "tenant.approved", actor: operatorId }]);
  });

  it("rejecting requires a reason; ingestion of the rejected one stays refused", async () => {
    const R = await pendingFixture("tenant-rejected");
    await expect(rejectTenant(op(), R.tenantId, { reason: " " })).rejects.toBeInstanceOf(TenantStatusError);
    expect(await tenantStatus(R.tenantId)).toBe("pending");
    expect(await rejectTenant(op(), R.tenantId, { reason: "Not a Stellar project" })).toBe("changed");
    expect(await tenantStatus(R.tenantId)).toBe("removed");
    expect(await acceptsWeb(R.umamiWebsiteId)).toBe(false);
    expect(await collectorKey(R.keyPrefix)).toBeNull();
    // Approving a rejected one does not work: only reactivating.
    expect(await approveTenant(op(), R.tenantId)).toBe("unchanged");
    expect(await tenantStatus(R.tenantId)).toBe("removed");
  });

  it("approving or rejecting a nonexistent project: null", async () => {
    expect(await approveTenant(op(), randomUUID())).toBeNull();
    expect(await rejectTenant(op(), randomUUID(), { reason: "Spam" })).toBeNull();
  });
});

describe("erasure (#154)", () => {
  // API metric point, to check that erasure removes it.
  async function insertMetric(f: Fixture, at = new Date().toISOString()) {
    await sql`
      INSERT INTO api_metric_1m (bucket_start, tenant_id, api_service_id, route, method, status_code,
                                 request_count, duration_sum, duration_buckets)
      VALUES (${at}, ${f.tenantId}, ${f.serviceId}, '/r', 'GET', 200, 3, 0.3,
              '{0,0,0,3,0,0,0,0,0,0,0,0,0,0,0}'::bigint[])`;
  }

  async function metricRows(tenantId: string, table: "api_metric_1m" | "api_metric_1h" | "api_metric_1d") {
    return sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(table)} WHERE tenant_id = ${tenantId}`;
  }

  async function tenantRow(tenantId: string) {
    const [row] = await db
      .select({ status: tenant.status, slug: tenant.slug, statusChangedBy: tenant.statusChangedBy })
      .from(tenant)
      .where(eq(tenant.id, tenantId));
    return row!;
  }

  it("the operator erases the data of a removed project; its row stays", async () => {
    const C = await createFixture("tenant-erasure");
    await insertMetric(C);
    expect(await removeTenant(op(), C.tenantId, { reason: "Erasure request" })).toBe("changed");

    // Wrong confirmation: error and nothing erased.
    await expect(purgeRemovedTenant(op(), C.tenantId, { confirmSlug: "wrong-slug" })).rejects.toBeInstanceOf(
      TenantStatusError,
    );
    expect(umami.requests).toEqual([]);

    const { slug } = await tenantRow(C.tenantId);
    expect(await purgeRemovedTenant(op(), C.tenantId, { confirmSlug: slug })).toBe("changed");

    // The site is gone from Umami and the rows are gone from the database.
    expect(umami.websites.has(C.umamiWebsiteId)).toBe(false);
    expect((await metricRows(C.tenantId, "api_metric_1m"))[0]!.n).toBe(0);
    expect(await db.select().from(site).where(eq(site.tenantId, C.tenantId))).toEqual([]);
    expect(await db.select().from(apiService).where(eq(apiService.tenantId, C.tenantId))).toEqual([]);
    expect(await db.select().from(ingestKey).where(eq(ingestKey.tenantId, C.tenantId))).toEqual([]);

    // The tenant row stays, with the history readable in the audit_log.
    expect(await tenantStatus(C.tenantId)).toBe("removed");
    const actions = await db
      .select({ action: auditLog.action, actor: auditLog.actorUserId })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, C.tenantId), like(auditLog.action, "tenant.%")))
      .orderBy(auditLog.at);
    expect(actions).toEqual([
      { action: "tenant.removed", actor: operatorId },
      { action: "tenant.purged", actor: operatorId },
    ]);
    expect(await acceptsWeb(C.umamiWebsiteId)).toBe(false);
  });

  it("erasing a project that is not removed: unchanged and nothing goes", async () => {
    expect(await purgeRemovedTenant(op(), A.tenantId, { confirmSlug: "anything" })).toBe("unchanged");
    expect(umami.requests).toEqual([]);
    expect(await tenantStatus(A.tenantId)).toBe("active");
  });

  it("account erasure erases the owner's project and anonymizes the audit_log", async () => {
    const D = await createFixture("tenant-account-erasure");
    await insertMetric(D);
    await deleteOwnAccount(D.userId);

    expect(await db.select().from(user).where(eq(user.id, D.userId))).toEqual([]);
    expect(await db.select().from(account).where(eq(account.userId, D.userId))).toEqual([]);
    expect(umami.websites.has(D.umamiWebsiteId)).toBe(false);
    expect((await metricRows(D.tenantId, "api_metric_1m"))[0]!.n).toBe(0);
    expect(await db.select().from(site).where(eq(site.tenantId, D.tenantId))).toEqual([]);
    expect(await db.select().from(ingestKey).where(eq(ingestKey.tenantId, D.tenantId))).toEqual([]);
    const row = await tenantRow(D.tenantId);
    expect(row.status).toBe("removed");
    expect(row.statusChangedBy).toBeNull();
    const audit = await db
      .select({ action: auditLog.action, actor: auditLog.actorUserId })
      .from(auditLog)
      .where(eq(auditLog.tenantId, D.tenantId));
    expect(audit.map((a) => a.action)).toContain("account.deleted");
    for (const a of audit) expect(a.actor).toBe(ANONYMIZED_ACTOR);
  });

  it("erasure of an account without a project: only the user goes", async () => {
    const alone = (await createUser()).id;
    await deleteOwnAccount(alone);
    expect(await db.select().from(user).where(eq(user.id, alone))).toEqual([]);
  });

  it("the marker in the code is the same as the trigger's", async () => {
    // The trigger points to the function; its body is what holds the marker.
    const [fn] = await sql<{ prosrc: string }[]>`
      SELECT prosrc FROM pg_proc WHERE proname = 'audit_log_erasure_guard'`;
    expect(fn!.prosrc).toContain(ANONYMIZED_ACTOR);
  });

  it("the trigger rejects any change other than the marker", async () => {
    const [entry] = await db
      .insert(auditLog)
      .values({ actorUserId: "trigger-test", action: "trigger.test", details: {} })
      .returning();
    const id = entry!.id;

    // UPDATE of another column: rejected.
    await expect(sql`UPDATE audit_log SET action = 'trigger.other' WHERE id = ${id}`).rejects.toThrow(
      /audit_log is insert-only/,
    );
    // DELETE: rejected.
    await expect(sql`DELETE FROM audit_log WHERE id = ${id}`).rejects.toThrow(/audit_log is insert-only/);
    // Replacing the actor with a value other than the marker: rejected.
    await expect(sql`UPDATE audit_log SET actor_user_id = 'anon' WHERE id = ${id}`).rejects.toThrow(
      /audit_log is insert-only/,
    );
    // Only the marker passes.
    await expect(sql`UPDATE audit_log SET actor_user_id = ${ANONYMIZED_ACTOR} WHERE id = ${id}`).resolves.toBeTruthy();
    const [after] = await db.select({ actor: auditLog.actorUserId }).from(auditLog).where(eq(auditLog.id, id));
    expect(after!.actor).toBe(ANONYMIZED_ACTOR);
  });
});
