import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { OperatorContext } from "../../access";
import { db } from "../../db";
import { site, tenant } from "../../db/schema";

// Funções do operador SCF (spec do E2, seção 4): recebem OperatorContext e são
// somente leitura, com exceção de remover e reativar tenant (#20).

// Vínculos portal → Umami de todos os tenants, inclusive sites arquivados.
// Usado pela checagem de consistência com o Umami.
export async function listUmamiLinks(
  ctx: OperatorContext,
): Promise<{ siteId: string; umamiWebsiteId: string }[]> {
  // O contexto não filtra nada aqui: exigi-lo prova que quem chama é operador.
  void ctx;
  return db.select({ siteId: site.id, umamiWebsiteId: site.umamiWebsiteId }).from(site);
}

export type ActiveTenantSites = {
  tenantId: string;
  name: string;
  slug: string;
  sites: { siteId: string; umamiWebsiteId: string }[];
};

// Projetos ativos com os sites não arquivados, para os painéis globais (#29).
// Projeto removido ou pendente não entra nas comparações (spec do E2, seção 6);
// projeto ativo sem site entra com a lista vazia.
export async function listActiveTenantSites(ctx: OperatorContext): Promise<ActiveTenantSites[]> {
  void ctx;
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
    .where(eq(tenant.status, "active"))
    .orderBy(asc(tenant.name), asc(site.createdAt));

  const byTenant = new Map<string, ActiveTenantSites>();
  for (const r of rows) {
    const entry = byTenant.get(r.tenantId) ?? { tenantId: r.tenantId, name: r.name, slug: r.slug, sites: [] };
    if (r.siteId && r.umamiWebsiteId) entry.sites.push({ siteId: r.siteId, umamiWebsiteId: r.umamiWebsiteId });
    byTenant.set(r.tenantId, entry);
  }
  return [...byTenant.values()];
}
