import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { DemoContext, OperatorContext } from "../../access";
import { db } from "../../db";
import { site, tenant } from "../../db/schema";

// SCF operator functions (E2 spec, section 4): they take OperatorContext and
// are read-only, except for removing and reactivating a tenant (#20).

// Portal → Umami links of all tenants, including archived sites.
// Used by the consistency check against Umami.
export async function listUmamiLinks(
  ctx: OperatorContext,
): Promise<{ siteId: string; umamiWebsiteId: string }[]> {
  // The context filters nothing here: requiring it proves that the caller is an operator.
  void ctx;
  return db.select({ siteId: site.id, umamiWebsiteId: site.umamiWebsiteId }).from(site);
}

export type ActiveTenantSites = {
  tenantId: string;
  name: string;
  slug: string;
  sites: { siteId: string; umamiWebsiteId: string }[];
};

// Active projects with their non-archived sites, for the global dashboards (#29).
// A removed or pending project is left out of the comparisons (E2 spec, section 6);
// an active project with no site is included with an empty list.
export async function listActiveTenantSites(ctx: OperatorContext): Promise<ActiveTenantSites[]> {
  void ctx;
  return activeTenantSites();
}

// Same shape for the public demo's operator view, restricted to the demo
// tenant: no other project is read.
export async function listDemoTenantSites(ctx: DemoContext): Promise<ActiveTenantSites[]> {
  return activeTenantSites(ctx.tenantId);
}

async function activeTenantSites(onlyTenantId?: string): Promise<ActiveTenantSites[]> {
  const rows = await db
    .select({
      tenantId: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      siteId: site.id,
      umamiWebsiteId: site.umamiWebsiteId,
    })
    .from(tenant)
    .leftJoin(site, and(eq(site.tenantId, tenant.id), isNull(site.archivedAt)))
    .where(and(eq(tenant.status, "active"), onlyTenantId ? eq(tenant.id, onlyTenantId) : undefined))
    .orderBy(asc(tenant.name), asc(site.createdAt));

  const byTenant = new Map<string, ActiveTenantSites>();
  for (const r of rows) {
    const entry = byTenant.get(r.tenantId) ?? { tenantId: r.tenantId, name: r.name, slug: r.slug, sites: [] };
    if (r.siteId && r.umamiWebsiteId) entry.sites.push({ siteId: r.siteId, umamiWebsiteId: r.umamiWebsiteId });
    byTenant.set(r.tenantId, entry);
  }
  return [...byTenant.values()];
}
