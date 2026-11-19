// Suíte de isolamento entre tenants (#21, spec do E2, seção 8).
//
// Dois tenants (A e B), cada um com site, serviço e chave de ingestão, um
// operador SCF e um usuário sem projeto. Os casos passam pelo que o navegador
// alcança (páginas e server actions, com a sessão simulada) e pelo que a
// ingestão lê (as visões de stellytics_ingest e stellytics_collector). Roda contra o
// Postgres de DATABASE_URL e um Umami falso.
//
// A parte do coletor fica no e2e dele (services/collector/e2e/): chave de
// tenant removido recusada (e2e_test.go) e chave revogada ou tenant removido
// DEPOIS de aceitos recusados em até o cache, com reativação, e chave de A
// mandando dados que dizem ser de B, gravados como A (isolation_test.go). Cada painel novo
// (#28, #29, #37 e #38) acrescenta os próprios casos a esta suíte.
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, count, eq, inArray, isNull, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTenantContext, type TenantContext } from "@/lib/access";
import { auth } from "@/lib/auth";
import { createApiService, createIngestKey, getApiService, listIngestKeys, revokeIngestKey } from "@/lib/data/api-services";
import { createReadKey, listReadKeys } from "@/lib/data/operator/api-keys";
import { ANONYMIZED_ACTOR } from "@/lib/data/erasure";
import { resetRateLimits } from "@/lib/rate-limit";
import OperatorKeysPage from "@/app/(private)/operator/keys/page";
import { createReadKeyAction, revokeReadKeyAction } from "@/app/(private)/operator/keys/actions";
import { GET as readApiProjects } from "@/app/api/v1/projects/route";
import { GET as readApiWeb } from "@/app/api/v1/web/route";
import { GET as readApiApi } from "@/app/api/v1/api/route";
import { getSite, listSites } from "@/lib/data/sites";
import { db, sql } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { account, apiService, auditLog, ingestKey, operatorApiKey, site, tenant, tenantMember, user } from "@/lib/db/schema";
import { listActiveTenantSites } from "@/lib/data/operator/sites";
import { getSiteStats } from "@/lib/umami/stats";
import DashboardPage from "@/app/(private)/dashboard/page";
import OperatorPage from "@/app/(private)/operator/page";
import ApprovalsPage from "@/app/(private)/operator/approvals/page";
import SitesPage from "@/app/(private)/sites/page";
import ServicesPage from "@/app/(private)/services/page";
import {
  approveTenantAction,
  purgeTenantAction,
  rejectTenantAction,
  reactivateTenantAction,
  removeTenantAction,
  type StatusActionState,
} from "@/app/(private)/operator/tenants/[tenantId]/actions";
import OperatorTenantPage from "@/app/(private)/operator/tenants/[tenantId]/page";
import OperatorWebPage from "@/app/(private)/operator/web/page";
import ServicePage from "@/app/(private)/services/[serviceId]/page";
import KeysPage from "@/app/(private)/services/[serviceId]/keys/page";
import OperatorApiPage from "@/app/(private)/operator/api/page";
import { getServiceDashboard } from "@/lib/data/api-metrics";
import { resolvePeriod } from "@/lib/period";
import SitePage from "@/app/(private)/sites/[siteId]/page";
import { createKeyAction, createServiceAction, revokeKeyAction } from "@/app/(private)/services/actions";
import { createSiteAction } from "@/app/(private)/sites/actions";
import { deleteAccountAction } from "@/app/(private)/settings/actions";
import { startFakeUmami, type FakeUmami } from "./fake-umami";
import { asRole } from "./helpers/as-role";

const DOMAIN = "@isolation-test.stellytics.invalid";
const SLUG = "isolation-test-";
const PASSWORD = "isolation-password-123";
const RANGE = { startAt: new Date(0), endAt: new Date() };
const NOT_FOUND = { digest: expect.stringContaining("404") };

// Usuário da sessão simulada; null simula quem não entrou.
let sessionUser: { id: string; role: "tenant" | "operator" } | null = null;

vi.mock("@/lib/session", () => ({
  requireSession: async () => {
    if (!sessionUser) throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;/sign-in" });
    return { user: { ...sessionUser, name: "Test", email: "test@example.invalid", emailVerified: true } };
  },
}));
// Fora de uma requisição do Next, refresh() falha; aqui ele não tem efeito.
vi.mock("next/cache", () => ({ refresh: vi.fn() }));

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
let noProjectId: string;

const idle: StatusActionState = { status: "idle" };

function signIn(as: { id: string; role: "tenant" | "operator" } | null) {
  sessionUser = as;
}
const asMember = (f: Fixture) => signIn({ id: f.userId, role: "tenant" });
const asOperator = () => signIn({ id: operatorId, role: "operator" });

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

async function createUser(role: "tenant" | "operator" = "tenant") {
  const id = randomUUID();
  const email = `${id}${DOMAIN}`;
  await db.insert(user).values({ id, name: "Test", email, emailVerified: true, role });
  return { id, email };
}

// Tenant com dono, um site (já existente no Umami falso), um serviço e a
// primeira chave, criados pelas mesmas funções que o portal usa.
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

async function activeKeys(tenantId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(ingestKey)
    .where(and(eq(ingestKey.tenantId, tenantId), isNull(ingestKey.revokedAt)));
  return row!.n;
}

async function tenantStatus(tenantId: string) {
  const [row] = await db.select({ status: tenant.status }).from(tenant).where(eq(tenant.id, tenantId));
  return row!.status;
}

// O que o gateway web (#61) e o coletor (#30) enxergam, com os papéis deles.
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
  noProjectId = (await createUser()).id;
});

beforeEach(() => {
  resetRateLimits();
  signIn(null);
  umami.requests.length = 0;
});

afterAll(async () => {
  await cleanup();
  await umami.close();
  await sql.end();
});

describe("membro de A diante dos recursos de B", () => {
  it("abre site, serviço ou chave de B pela URL: 404", async () => {
    asMember(A);
    // Controle: o próprio serviço abre.
    await expect(ServicePage({ params: Promise.resolve({ serviceId: A.serviceId }) })).resolves.toBeTruthy();
    await expect(ServicePage({ params: Promise.resolve({ serviceId: B.serviceId }) })).rejects.toMatchObject(
      NOT_FOUND,
    );
    await expect(KeysPage({ params: Promise.resolve({ serviceId: A.serviceId }) })).resolves.toBeTruthy();
    await expect(KeysPage({ params: Promise.resolve({ serviceId: B.serviceId }) })).rejects.toMatchObject(NOT_FOUND);

    // Site e chave ainda não têm página própria; a camada que as páginas vão
    // usar já devolve nulo (a página chama notFound()).
    expect(await getSite(A.ctx, A.siteId)).not.toBeNull();
    expect(await getSite(A.ctx, B.siteId)).toBeNull();
    expect(await getApiService(A.ctx, B.serviceId)).toBeNull();
    expect(await listIngestKeys(A.ctx, B.serviceId)).toBeNull();
    // As listagens só trazem o que é de A.
    expect((await listSites(A.ctx)).map((s) => s.id)).toEqual([A.siteId]);
  });

  it("chama as ações do portal com IDs de B: 404, e nada muda em B", async () => {
    asMember(A);
    const keysOfB = await activeKeys(B.tenantId);

    await expect(createKeyAction(B.serviceId)).rejects.toMatchObject(NOT_FOUND);
    await expect(revokeKeyAction(B.keyId)).rejects.toMatchObject(NOT_FOUND);
    expect(await activeKeys(B.tenantId)).toBe(keysOfB);
    expect(await revokeIngestKey(A.ctx, B.keyId)).toBeNull();
    expect(await collectorKey(B.keyPrefix)).toMatchObject({ tenant_id: B.tenantId });

    // As ações do operador respondem 404 antes de olhar o ID.
    await expect(removeTenantAction(B.tenantId, idle, form({ reason: "Spam" }))).rejects.toMatchObject(NOT_FOUND);
    await expect(reactivateTenantAction(B.tenantId, idle, form({}))).rejects.toMatchObject(NOT_FOUND);
    expect(await tenantStatus(B.tenantId)).toBe("active");
  });

  it("abre /operator, os painéis globais (web e API) e o detalhe de um tenant: 404", async () => {
    asMember(A);
    await expect(OperatorPage()).rejects.toMatchObject(NOT_FOUND);
    await expect(OperatorWebPage({ searchParams: Promise.resolve({ compare: [A.tenantId, B.tenantId] }) })).rejects.toMatchObject(
      NOT_FOUND,
    );
    expect(umami.requests).toEqual([]);
    await expect(OperatorApiPage({ searchParams: Promise.resolve({ q: "tenant-b" }) })).rejects.toMatchObject(NOT_FOUND);
    await expect(
      OperatorTenantPage({ params: Promise.resolve({ tenantId: B.tenantId }) }),
    ).rejects.toMatchObject(NOT_FOUND);
    // Nem o do próprio tenant.
    await expect(
      OperatorTenantPage({ params: Promise.resolve({ tenantId: A.tenantId }) }),
    ).rejects.toMatchObject(NOT_FOUND);
  });

  it("tenta mudar o próprio papel pelo cliente: ignorado", async () => {
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
    // Controle: a sessão vale e o próprio nome pode mudar.
    expect((await updateUser({ name: "Member A" })).status).toBe(200);
    // O papel não: o Better Auth recusa o campo (input: false em src/lib/auth.ts).
    const forged = await updateUser({ name: "Operator A", role: "operator" });
    expect(forged.ok).toBe(false);

    const [row] = await db.select({ role: user.role, name: user.name }).from(user).where(eq(user.id, A.userId));
    expect(row!.name).toBe("Member A");
    expect(row!.role).toBe("tenant");
  });

  it("manda o ID do tenant B num formulário: o tenant vem da sessão", async () => {
    asMember(A);
    const created = await createServiceAction({ status: "idle" }, form({ name: "forged", tenantId: B.tenantId }));
    expect(created).toMatchObject({ status: "created" });
    const [service] = await db.select().from(apiService).where(eq(apiService.name, "forged"));
    expect(service!.tenantId).toBe(A.tenantId);

    expect(
      await createSiteAction({ status: "idle" }, form({ name: "Forged", domain: "forged.example", tenantId: B.tenantId })),
    ).toMatchObject({ status: "created" });
    const [forgedSite] = await db.select().from(site).where(eq(site.domain, "forged.example"));
    expect(forgedSite!.tenantId).toBe(A.tenantId);
  });
});

describe("operador SCF", () => {
  it("lê os dados de A e de B", async () => {
    asOperator();
    await expect(OperatorPage()).resolves.toBeTruthy();
    for (const f of [A, B]) {
      await expect(OperatorTenantPage({ params: Promise.resolve({ tenantId: f.tenantId }) })).resolves.toBeTruthy();
    }
  });

  it("tenta criar site, serviço ou chave, ou revogar chave, em A: recusado", async () => {
    asOperator();
    const keysOfA = await activeKeys(A.tenantId);
    const sitesOfA = (await listSites(A.ctx)).length;

    await expect(createSiteAction({ status: "idle" }, form({ name: "Op", domain: "op.example" }))).rejects.toMatchObject(
      NOT_FOUND,
    );
    await expect(createServiceAction({ status: "idle" }, form({ name: "op-api" }))).rejects.toMatchObject(NOT_FOUND);
    await expect(createKeyAction(A.serviceId)).rejects.toMatchObject(NOT_FOUND);
    await expect(revokeKeyAction(A.keyId)).rejects.toMatchObject(NOT_FOUND);
    // O operador também não abre as páginas do tenant (D2).
    await expect(ServicePage({ params: Promise.resolve({ serviceId: A.serviceId }) })).rejects.toMatchObject(
      NOT_FOUND,
    );

    expect(await activeKeys(A.tenantId)).toBe(keysOfA);
    expect((await listSites(A.ctx)).length).toBe(sitesOfA);
    expect(umami.requests).toEqual([]);
  });
});

describe("ingestão de API (contrato com o coletor)", () => {
  it("a chave de A resolve sempre para o tenant e o serviço de A", async () => {
    // O coletor só lê tenant e serviço desta visão (spec do E2, seção 5, D5).
    expect(await collectorKey(A.keyPrefix)).toEqual({ tenant_id: A.tenantId, api_service_id: A.serviceId });
  });
  // "Chave de A envia métricas dizendo ser do tenant B: gravadas como A" fica
  // no e2e do coletor (TestKeyOfAClaimingBIsStoredAsA), que passa pelo exporter.

  it("chave revogada de A sai da visão do coletor na hora", async () => {
    asMember(A);
    const created = await createKeyAction(A.serviceId);
    if (created.status !== "created") throw new Error("a chave não foi criada");
    expect(await collectorKey(created.prefix)).not.toBeNull();

    const [row] = await db.select({ id: ingestKey.id }).from(ingestKey).where(eq(ingestKey.prefix, created.prefix));
    await revokeKeyAction(row!.id);
    expect(await collectorKey(created.prefix)).toBeNull();
    // Revogar de novo (um clique duplo) não é 404: a chave é de A.
    await expect(revokeKeyAction(row!.id)).resolves.toBeUndefined();
  });
  // O coletor recusa a chave revogada em até o cache (no máximo 60 s):
  // services/collector/e2e/isolation_test.go.
});

describe("tenant B removido", () => {
  it("evento web e chave de B deixam de valer; A continua; reativar devolve", async () => {
    expect(await acceptsWeb(B.umamiWebsiteId)).toBe(true);
    expect(await collectorKey(B.keyPrefix)).not.toBeNull();

    asOperator();
    expect(await removeTenantAction(B.tenantId, idle, form({ reason: "Not a Stellar project" }))).toEqual({
      status: "done",
    });

    // O gateway responde 204 e descarta (teste ponta a ponta em
    // services/ingest-web/e2e); o coletor responde 401.
    expect(await acceptsWeb(B.umamiWebsiteId)).toBe(false);
    expect(await collectorKey(B.keyPrefix)).toBeNull();
    expect(await acceptsWeb(A.umamiWebsiteId)).toBe(true);
    expect(await collectorKey(A.keyPrefix)).not.toBeNull();
    // Fora das comparações do painel global (#29), mas A continua.
    const active = (await listActiveTenantSites({ userId: operatorId } as never)).map((p) => p.tenantId);
    expect(active).toContain(A.tenantId);
    expect(active).not.toContain(B.tenantId);

    // Quem é de B ainda entra, mas não cadastra nada.
    asMember(B);
    expect(await createServiceAction({ status: "idle" }, form({ name: "after-removal" }))).toEqual({
      status: "error",
      message: "This project was removed.",
    });
    expect(
      await createSiteAction({ status: "idle" }, form({ name: "After", domain: "after-removal.example" })),
    ).toEqual({ status: "error", message: "This project was removed." });
    expect(await createKeyAction(B.serviceId)).toEqual({ status: "error", message: "This project was removed." });
    expect(umami.requests).toEqual([]);

    asOperator();
    expect(await reactivateTenantAction(B.tenantId, idle, form({ reason: "Appeal accepted" }))).toEqual({
      status: "done",
    });
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

  it("remover sem motivo volta com erro e não muda o status", async () => {
    asOperator();
    expect(await removeTenantAction(B.tenantId, idle, form({ reason: " " }))).toMatchObject({ status: "error" });
    expect(await tenantStatus(B.tenantId)).toBe("active");
  });

  it("tenant inexistente: 404", async () => {
    asOperator();
    await expect(removeTenantAction(randomUUID(), idle, form({ reason: "Spam" }))).rejects.toMatchObject(NOT_FOUND);
  });
  // A métrica de API de B removido é recusada pelo coletor (401 e
  // Unauthenticated), e volta a valer depois da reativação:
  // services/collector/e2e/isolation_test.go.
});

describe("painel web do site (#28)", () => {
  const sitePage = (siteId: string) =>
    SitePage({ params: Promise.resolve({ siteId }), searchParams: Promise.resolve({}) });

  it("membro de A abre o próprio painel; o de B responde 404 sem chamar o Umami", async () => {
    asMember(A);
    await expect(sitePage(A.siteId)).resolves.toBeTruthy();
    expect(umami.requests.length).toBeGreaterThan(0);
    expect(umami.requests.every((r) => r.path.startsWith(`/api/websites/${A.umamiWebsiteId}/`))).toBe(true);
    umami.requests.length = 0;

    await expect(sitePage(B.siteId)).rejects.toMatchObject(NOT_FOUND);
    // Nem com o ID do site de B no Umami no lugar do ID do portal.
    await expect(sitePage(B.umamiWebsiteId)).rejects.toMatchObject(NOT_FOUND);
    expect(umami.requests).toEqual([]);
  });

  it("operador abre o painel de um site: 404 (D2)", async () => {
    asOperator();
    await expect(sitePage(A.siteId)).rejects.toMatchObject(NOT_FOUND);
    expect(umami.requests).toEqual([]);
  });
});

describe("painel de API do serviço (#37)", () => {
  const servicePage = (serviceId: string) =>
    ServicePage({ params: Promise.resolve({ serviceId }), searchParams: Promise.resolve({}) });

  // Uma linha por minuto recente, gravada direto como faria o coletor.
  async function metric(tenantId: string, serviceId: string, count: number) {
    const at = new Date(Date.now() - 60_000);
    at.setUTCSeconds(0, 0);
    await sql`
      INSERT INTO api_metric_1m (bucket_start, tenant_id, api_service_id, route, method, status_code,
                                 request_count, duration_sum, duration_buckets)
      VALUES (${at.toISOString()}::timestamptz, ${tenantId}, ${serviceId}, '/isolation', 'GET', 200, ${count}, 0,
              ${Array.from({ length: 15 }, (_, i) => (i === 2 ? count : 0))}::bigint[])`;
  }

  it("A vê só as métricas do próprio serviço; o de B é 404 e nulo na camada de dados", async () => {
    await metric(A.tenantId, A.serviceId, 3);
    await metric(B.tenantId, B.serviceId, 1000);
    // Linha impossível pelo coletor (serviço de A com o tenant de B): o painel
    // filtra pelos dois, então ela também não aparece para A.
    await metric(B.tenantId, A.serviceId, 500);

    const period = resolvePeriod("24h");
    const own = await getServiceDashboard(A.ctx, A.serviceId, period);
    expect(own!.totals.requests).toBe(3);
    expect(await getServiceDashboard(A.ctx, B.serviceId, period)).toBeNull();

    asMember(A);
    await expect(servicePage(A.serviceId)).resolves.toBeTruthy();
    await expect(servicePage(B.serviceId)).rejects.toMatchObject(NOT_FOUND);
  });

  it("operador abre o painel de um serviço: 404 (D2)", async () => {
    asOperator();
    await expect(servicePage(A.serviceId)).rejects.toMatchObject(NOT_FOUND);
  });
});

describe("chaves de leitura do SCF (#48)", () => {
  const READ_ROUTES = [
    ["/api/v1/projects", readApiProjects],
    ["/api/v1/web", readApiWeb],
    ["/api/v1/api", readApiApi],
  ] as const;
  const get = (route: (r: Request) => Promise<Response>, path: string, key: string) =>
    route(new Request(`http://portal.test${path}`, { headers: { authorization: `Bearer ${key}` } }));
  const keyRows = async () => (await db.select({ id: operatorApiKey.id }).from(operatorApiKey)).length;

  it("membro de tenant não gera nem revoga chave de leitura: 404, e nada é gravado", async () => {
    const op = { userId: operatorId } as import("@/lib/access").OperatorContext;
    const { summary } = await createReadKey(op, { name: "isolation" });
    const before = await keyRows();

    asMember(A);
    await expect(OperatorKeysPage()).rejects.toMatchObject(NOT_FOUND);
    await expect(createReadKeyAction({ status: "idle" }, form({ name: "mine" }))).rejects.toMatchObject(NOT_FOUND);
    await expect(revokeReadKeyAction(summary.id)).rejects.toMatchObject(NOT_FOUND);
    signIn({ id: noProjectId, role: "tenant" });
    await expect(createReadKeyAction({ status: "idle" }, form({ name: "mine" }))).rejects.toMatchObject(NOT_FOUND);
    signIn(null);
    await expect(createReadKeyAction({ status: "idle" }, form({ name: "mine" }))).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;/sign-in",
    });

    expect(await keyRows()).toBe(before);
    expect((await listReadKeys(op)).find((k) => k.id === summary.id)?.revokedAt).toBeNull();
  });

  it("operador cria e revoga pela interface; a chave só aparece no retorno da criação", async () => {
    asOperator();
    await expect(OperatorKeysPage()).resolves.toBeTruthy();
    const created = await createReadKeyAction({ status: "idle" }, form({ name: "from-ui" }));
    expect(created).toMatchObject({ status: "created", key: expect.stringMatching(/^nrk_/) });
    const key = (created as { key: string }).key;
    expect((await get(readApiProjects, "/api/v1/projects", key)).status).toBe(200);
    const [row] = await db.select().from(operatorApiKey).where(eq(operatorApiKey.prefix, key.split("_")[1]!));
    await revokeReadKeyAction(row!.id);
    expect((await get(readApiProjects, "/api/v1/projects", key)).status).toBe(401);
  });

  it("chave de ingestão (ntf_) de A não lê a API de leitura", async () => {
    const ingest = await createIngestKey(A.ctx, A.serviceId);
    expect(ingest!.key).toMatch(/^ntf_/);
    for (const [path, route] of READ_ROUTES) {
      expect((await get(route, path, ingest!.key)).status).toBe(401);
    }
    expect(umami.requests).toEqual([]);
  });

  it("chave de leitura não é aceita pelo coletor nem enxergada pelo gateway", async () => {
    const op = { userId: operatorId } as import("@/lib/access").OperatorContext;
    const { key, summary } = await createReadKey(op, { name: "not-for-collector" });
    // O coletor busca na visão pelo prefixo: o prefixo da chave de leitura não está lá.
    expect(await collectorKey(summary.prefix)).toBeNull();
    // E nem o coletor nem o gateway têm permissão na tabela das chaves de leitura.
    await expect(asRole("stellytics_collector", "select prefix from operator_api_key")).rejects.toThrow(/permission denied/);
    await expect(asRole("stellytics_ingest", "select prefix from operator_api_key")).rejects.toThrow(/permission denied/);
    await expect(asRole("stellytics_collector", "select key_hash from operator_api_key")).rejects.toThrow(/permission denied/);
    expect(key).not.toMatch(/^ntf_/);
  });

  it("a API só mostra projetos ativos: B removido some, A volta ao reativar, sem tocar no Umami de B", async () => {
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

describe("usuário sem projeto", () => {
  it("abre /dashboard e vai para a criação de projeto", async () => {
    signIn({ id: noProjectId, role: "tenant" });
    await expect(DashboardPage()).rejects.toMatchObject({ digest: expect.stringContaining("/onboarding") });
  });

  it("sem sessão vai para o login", async () => {
    await expect(DashboardPage()).rejects.toMatchObject({ digest: "NEXT_REDIRECT;/sign-in" });
  });
});

describe("leitura do Umami", () => {
  it("o contexto de A não lê o site de B, nem pelo ID do portal nem pelo do Umami", async () => {
    expect(await getSiteStats(A.ctx, A.siteId, RANGE)).toMatchObject({ pageviews: 7 });
    expect(umami.requests).toHaveLength(1);
    umami.requests.length = 0;

    expect(await getSiteStats(A.ctx, B.siteId, RANGE)).toBeNull();
    expect(await getSiteStats(A.ctx, B.umamiWebsiteId, RANGE)).toBeNull();
    expect(await getSiteStats(A.ctx, A.umamiWebsiteId, RANGE)).toBeNull();
    // Recusado antes de chegar ao Umami.
    expect(umami.requests).toEqual([]);
  });
});

// Textos de uma árvore de elementos React (sem renderizar): só strings e filhos.
function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  const props = (node as { props?: { children?: unknown } } | null)?.props;
  return props ? textOf(props.children) : "";
}

describe("cadastro com aprovação (#49)", () => {
  // Projeto pendente com site, serviço e chave. As linhas são criadas com o
  // projeto ativo (as funções de data/ recusam pendente) e o status muda depois,
  // como se fossem de um cadastro antigo: a ingestão e as páginas é que são
  // testadas aqui.
  async function pendingFixture(name: string): Promise<Fixture> {
    const f = await createFixture(name);
    await db.update(tenant).set({ status: "pending" }).where(eq(tenant.id, f.tenantId));
    return { ...f, ctx: (await loadTenantContext(f.userId))! };
  }

  let P: Fixture;
  beforeAll(async () => {
    P = await pendingFixture("tenant-pending");
  });

  it("ingestão web e de API recusam o pendente; A continua", async () => {
    expect(await acceptsWeb(P.umamiWebsiteId)).toBe(false);
    expect(await collectorKey(P.keyPrefix)).toBeNull();
    expect(await acceptsWeb(A.umamiWebsiteId)).toBe(true);
    expect(await collectorKey(A.keyPrefix)).not.toBeNull();
  });

  it("o pendente vê só a tela de espera; o resto do portal manda para /dashboard", async () => {
    asMember(P);
    expect(P.ctx.tenantStatus).toBe("pending");
    await expect(DashboardPage()).resolves.toBeTruthy();
    const toDashboard = { digest: expect.stringContaining("/dashboard") };
    await expect(SitesPage()).rejects.toMatchObject(toDashboard);
    await expect(ServicesPage()).rejects.toMatchObject(toDashboard);
    await expect(SitePage({ params: Promise.resolve({ siteId: P.siteId }), searchParams: Promise.resolve({}) })).rejects.toMatchObject(toDashboard);
    await expect(ServicePage({ params: Promise.resolve({ serviceId: P.serviceId }) })).rejects.toMatchObject(toDashboard);
    await expect(KeysPage({ params: Promise.resolve({ serviceId: P.serviceId }) })).rejects.toMatchObject(toDashboard);

    const keys = await activeKeys(P.tenantId);
    await expect(createSiteAction({ status: "idle" }, form({ name: "P", domain: "p.example" }))).rejects.toMatchObject(toDashboard);
    await expect(createServiceAction({ status: "idle" }, form({ name: "p-api" }))).rejects.toMatchObject(toDashboard);
    await expect(createKeyAction(P.serviceId)).rejects.toMatchObject(toDashboard);
    await expect(revokeKeyAction(P.keyId)).rejects.toMatchObject(toDashboard);
    expect(await activeKeys(P.tenantId)).toBe(keys);
    expect(umami.requests).toEqual([]);

    // Mesmo que alguém chame a camada de dados direto, ela recusa.
    await expect(createApiService(P.ctx, { name: "direct" })).rejects.toMatchObject({ code: "tenant_pending" });
    expect(await getSite(A.ctx, P.siteId)).toBeNull();
  });

  it("membro de A não alcança o pendente: 404 em tudo", async () => {
    asMember(A);
    await expect(ServicePage({ params: Promise.resolve({ serviceId: P.serviceId }) })).rejects.toMatchObject(NOT_FOUND);
    expect(await getApiService(A.ctx, P.serviceId)).toBeNull();
    await expect(approveTenantAction(P.tenantId, idle, form({}))).rejects.toMatchObject(NOT_FOUND);
    await expect(rejectTenantAction(P.tenantId, idle, form({ reason: "No" }))).rejects.toMatchObject(NOT_FOUND);
    await expect(ApprovalsPage()).rejects.toMatchObject(NOT_FOUND);
    // O próprio pendente também não aprova.
    asMember(P);
    await expect(approveTenantAction(P.tenantId, idle, form({}))).rejects.toMatchObject(NOT_FOUND);
    await expect(ApprovalsPage()).rejects.toMatchObject(NOT_FOUND);
    expect(await tenantStatus(P.tenantId)).toBe("pending");
  });

  it("o operador vê a fila, aprova, e a ingestão passa a aceitar; tudo no audit_log", async () => {
    asOperator();
    await expect(ApprovalsPage()).resolves.toBeTruthy();
    // Modo desligado com pendentes na fila: a tela explica; ligado, não.
    delete process.env.SIGNUP_APPROVAL;
    expect(textOf(await ApprovalsPage())).toContain("currently turned off");
    process.env.SIGNUP_APPROVAL = "true";
    expect(textOf(await ApprovalsPage())).not.toContain("currently turned off");
    delete process.env.SIGNUP_APPROVAL;
    expect(await approveTenantAction(P.tenantId, idle, form({ reason: "Looks good" }))).toEqual({ status: "done" });
    expect(await tenantStatus(P.tenantId)).toBe("active");
    expect(await acceptsWeb(P.umamiWebsiteId)).toBe(true);
    expect(await collectorKey(P.keyPrefix)).toMatchObject({ tenant_id: P.tenantId });
    // Segunda aprovação (dois operadores ao mesmo tempo): nada novo.
    expect(await approveTenantAction(P.tenantId, idle, form({}))).toEqual({ status: "done" });

    const audit = await db
      .select({ action: auditLog.action, actor: auditLog.actorUserId })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, P.tenantId), like(auditLog.action, "tenant.%")));
    expect(audit).toEqual([{ action: "tenant.approved", actor: operatorId }]);

    asMember(P);
    await expect(SitesPage()).resolves.toBeTruthy();
  });

  it("rejeitar exige motivo; o rejeitado vê o aviso e a ingestão segue recusada", async () => {
    const R = await pendingFixture("tenant-rejected");
    asOperator();
    expect(await rejectTenantAction(R.tenantId, idle, form({ reason: " " }))).toMatchObject({ status: "error" });
    expect(await tenantStatus(R.tenantId)).toBe("pending");
    expect(await rejectTenantAction(R.tenantId, idle, form({ reason: "Not a Stellar project" }))).toEqual({
      status: "done",
    });
    expect(await tenantStatus(R.tenantId)).toBe("removed");
    expect(await acceptsWeb(R.umamiWebsiteId)).toBe(false);
    expect(await collectorKey(R.keyPrefix)).toBeNull();
    const [entry] = await db
      .select({ action: auditLog.action, actor: auditLog.actorUserId, details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, R.tenantId), eq(auditLog.action, "tenant.rejected")));
    expect(entry).toEqual({
      action: "tenant.rejected",
      actor: operatorId,
      details: { from: "pending", reason: "Not a Stellar project" },
    });
    asMember(R);
    await expect(DashboardPage()).resolves.toBeTruthy();
    // Aprovar um rejeitado não vale: só reativar.
    asOperator();
    expect(await approveTenantAction(R.tenantId, idle, form({}))).toEqual({ status: "done" });
    expect(await tenantStatus(R.tenantId)).toBe("removed");
  });

  it("aprovar ou rejeitar projeto inexistente: 404", async () => {
    asOperator();
    await expect(approveTenantAction(randomUUID(), idle, form({}))).rejects.toMatchObject(NOT_FOUND);
    await expect(rejectTenantAction(randomUUID(), idle, form({ reason: "Spam" }))).rejects.toMatchObject(NOT_FOUND);
  });
});

describe("apagamento (#154)", () => {
  // Ponto de métrica de API, para conferir que o apagamento o remove.
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

  it("o marcador do código é o mesmo que o do gatilho", async () => {
    // O gatilho aponta para a função; o corpo dela é que tem o marcador.
    const [fn] = await sql<{ prosrc: string }[]>`
      SELECT prosrc FROM pg_proc WHERE proname = 'audit_log_erasure_guard'`;
    expect(fn!.prosrc).toContain(`'[apagado]'`);
    expect(fn!.prosrc).toContain(ANONYMIZED_ACTOR);
  });

  it("o operador apaga os dados de um projeto removido; a linha dele fica", async () => {
    const C = await createFixture("tenant-erasure");
    await insertMetric(C);
    asOperator();
    expect(await removeTenantAction(C.tenantId, idle, form({ reason: "Erasure request" }))).toEqual({ status: "done" });

    // Confirmação errada: erro e nada apagado.
    expect(await purgeTenantAction(C.tenantId, idle, form({ confirm: "wrong-slug" }))).toMatchObject({ status: "error" });
    expect(umami.requests).toEqual([]);

    const { slug } = await tenantRow(C.tenantId);
    expect(await purgeTenantAction(C.tenantId, idle, form({ confirm: slug }))).toEqual({ status: "done" });

    // O site saiu do Umami e as linhas saíram do banco.
    expect(umami.websites.has(C.umamiWebsiteId)).toBe(false);
    expect(umami.requests.some((r) => r.method === "DELETE" && r.path === `/api/websites/${C.umamiWebsiteId}`)).toBe(
      true,
    );
    expect((await metricRows(C.tenantId, "api_metric_1m"))[0]!.n).toBe(0);
    expect((await metricRows(C.tenantId, "api_metric_1h"))[0]!.n).toBe(0);
    expect((await metricRows(C.tenantId, "api_metric_1d"))[0]!.n).toBe(0);
    expect(await db.select().from(site).where(eq(site.tenantId, C.tenantId))).toEqual([]);
    expect(await db.select().from(apiService).where(eq(apiService.tenantId, C.tenantId))).toEqual([]);
    expect(await db.select().from(ingestKey).where(eq(ingestKey.tenantId, C.tenantId))).toEqual([]);

    // A linha do tenant fica, com o histórico legível no audit_log.
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

    // Ingestão continua recusada depois do apagamento (site apagado).
    expect(await acceptsWeb(C.umamiWebsiteId)).toBe(false);
  });

  it("apagar projeto que não está removido: unchanged e nada sai", async () => {
    asOperator();
    expect(await purgeTenantAction(A.tenantId, idle, form({ confirm: "anything" }))).toEqual({ status: "done" });
    expect(umami.requests).toEqual([]);
    expect(await tenantStatus(A.tenantId)).toBe("active");
  });

  it("a exclusão da própria conta apaga o projeto do dono e anonimiza o audit_log", async () => {
    const D = await createFixture("tenant-account-erasure");
    await insertMetric(D);

    asMember(D);
    expect(await deleteAccountAction({ status: "idle" }, form({ confirm: "wrong@example.invalid" }))).toMatchObject({
      status: "error",
    });
    // Confirmação errada não mexeu em nada.
    expect(umami.requests).toEqual([]);
    expect(await db.select({ id: user.id }).from(user).where(eq(user.id, D.userId))).toHaveLength(1);

    // A ação responde com redirecionamento para /sign-in (o e-mail da sessão
    // simulada é o fixo do mock).
    await expect(deleteAccountAction({ status: "idle" }, form({ confirm: "test@example.invalid" }))).rejects.toMatchObject({
      digest: expect.stringContaining("sign-in"),
    });

    // A conta saiu com as dependentes em cascata: sessão e senha.
    expect(await db.select().from(user).where(eq(user.id, D.userId))).toEqual([]);
    expect(await db.select().from(account).where(eq(account.userId, D.userId))).toEqual([]);
    expect((await sql`SELECT count(*)::int AS n FROM session WHERE user_id = ${D.userId}`)[0]!.n).toBe(0);

    // O projeto saiu: status removido, dados apagados, site fora do Umami.
    expect(umami.websites.has(D.umamiWebsiteId)).toBe(false);
    expect(umami.requests.some((r) => r.method === "DELETE" && r.path === `/api/websites/${D.umamiWebsiteId}`)).toBe(
      true,
    );
    expect((await metricRows(D.tenantId, "api_metric_1m"))[0]!.n).toBe(0);
    expect(await db.select().from(site).where(eq(site.tenantId, D.tenantId))).toEqual([]);
    expect(await db.select().from(ingestKey).where(eq(ingestKey.tenantId, D.tenantId))).toEqual([]);
    const row = await tenantRow(D.tenantId);
    expect(row.status).toBe("removed");
    // A referência ao usuário vira nula em cascata (set null).
    expect(row.statusChangedBy).toBeNull();

    // Todas as ações do usuário ficam no audit_log, anonimizadas — inclusive a
    // própria exclusão. Nenhuma linha guarda mais o ID dele.
    const audit = await db
      .select({ action: auditLog.action, actor: auditLog.actorUserId })
      .from(auditLog)
      .where(eq(auditLog.tenantId, D.tenantId))
      .orderBy(auditLog.at);
    expect(audit.map((a) => a.action)).toContain("account.deleted");
    for (const a of audit) expect(a.actor).toBe(ANONYMIZED_ACTOR);
  });

  it("exclusão de conta sem projeto: só o usuário sai", async () => {
    const alone = (await createUser()).id;
    signIn({ id: alone, role: "tenant" });
    await expect(deleteAccountAction({ status: "idle" }, form({ confirm: "test@example.invalid" }))).rejects.toMatchObject({
      digest: expect.stringContaining("sign-in"),
    });
    expect(await db.select().from(user).where(eq(user.id, alone))).toEqual([]);
  });

  it("o gatilho recusa qualquer mudança fora do marcador", async () => {
    const [entry] = await db
      .insert(auditLog)
      .values({ actorUserId: "trigger-test", action: "trigger.test", details: {} })
      .returning();
    const id = entry!.id;

    // UPDATE de outra coluna: recusado.
    await expect(sql`UPDATE audit_log SET action = 'trigger.other' WHERE id = ${id}`).rejects.toThrow(
      /audit_log só recebe inserções/,
    );
    // DELETE: recusado.
    await expect(sql`DELETE FROM audit_log WHERE id = ${id}`).rejects.toThrow(/audit_log só recebe inserções/);
    // Trocar o ator por outro valor que não o marcador: recusado.
    await expect(sql`UPDATE audit_log SET actor_user_id = 'anon' WHERE id = ${id}`).rejects.toThrow(
      /audit_log só recebe inserções/,
    );
    // Só o marcador passa.
    await expect(sql`UPDATE audit_log SET actor_user_id = ${ANONYMIZED_ACTOR} WHERE id = ${id}`).resolves.toBeTruthy();
    const [after] = await db.select({ actor: auditLog.actorUserId }).from(auditLog).where(eq(auditLog.id, id));
    expect(after!.actor).toBe(ANONYMIZED_ACTOR);
  });
});
