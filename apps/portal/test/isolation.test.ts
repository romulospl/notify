// Suíte de isolamento entre tenants (#21, spec do E2, seção 8).
//
// Dois tenants (A e B), cada um com site, serviço e chave de ingestão, um
// operador SCF e um usuário sem projeto. Os casos passam pelo que o navegador
// alcança (páginas e server actions, com a sessão simulada) e pelo que a
// ingestão lê (as visões de notify_ingest e notify_collector). Roda contra o
// Postgres de DATABASE_URL e um Umami falso.
//
// Casos que dependem do coletor (#30) estão como `it.todo`: o contrato do
// banco já é testado aqui, e o coletor acrescenta a parte dele. Cada painel
// novo (#28 e #37) também acrescenta os próprios casos a esta suíte.
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, count, eq, inArray, isNull, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTenantContext, type TenantContext } from "@/lib/access";
import { auth } from "@/lib/auth";
import { createApiService, getApiService, listIngestKeys, revokeIngestKey } from "@/lib/data/api-services";
import { getSite, listSites } from "@/lib/data/sites";
import { db, sql } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { account, apiService, auditLog, ingestKey, site, tenant, tenantMember, user } from "@/lib/db/schema";
import { listActiveTenantSites } from "@/lib/data/operator/sites";
import { getSiteStats } from "@/lib/umami/stats";
import DashboardPage from "@/app/(private)/dashboard/page";
import OperatorPage from "@/app/(private)/operator/page";
import {
  reactivateTenantAction,
  removeTenantAction,
  type StatusActionState,
} from "@/app/(private)/operator/tenants/[tenantId]/actions";
import OperatorTenantPage from "@/app/(private)/operator/tenants/[tenantId]/page";
import OperatorWebPage from "@/app/(private)/operator/web/page";
import ServicePage from "@/app/(private)/services/[serviceId]/page";
import SitePage from "@/app/(private)/sites/[siteId]/page";
import { createKeyAction, createServiceAction, revokeKeyAction } from "@/app/(private)/services/actions";
import { createSiteAction } from "@/app/(private)/sites/actions";
import { startFakeUmami, type FakeUmami } from "./fake-umami";
import { asRole } from "./helpers/as-role";

const DOMAIN = "@isolation-test.notify.invalid";
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
    "notify_ingest",
    `select accepts_ingest from ingest_site where umami_website_id = '${umamiWebsiteId}'`,
  );
  return row?.accepts_ingest ?? false;
}

async function collectorKey(prefix: string) {
  const [row] = await asRole<{ tenant_id: string; api_service_id: string }>(
    "notify_collector",
    `select tenant_id, api_service_id from ingest_key_active where prefix = '${prefix}'`,
  );
  return row ?? null;
}

async function cleanup() {
  const ids = (await db.select({ id: tenant.id }).from(tenant).where(like(tenant.slug, `${SLUG}%`))).map(
    (t) => t.id,
  );
  if (ids.length > 0) {
    await db.delete(ingestKey).where(inArray(ingestKey.tenantId, ids));
    await db.delete(apiService).where(inArray(apiService.tenantId, ids));
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

  A = await createFixture("tenant-a");
  B = await createFixture("tenant-b");
  operatorId = (await createUser("operator")).id;
  noProjectId = (await createUser()).id;
});

beforeEach(() => {
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

  it("abre /operator, o painel web global e o detalhe de um tenant: 404", async () => {
    asMember(A);
    await expect(OperatorPage()).rejects.toMatchObject(NOT_FOUND);
    await expect(OperatorWebPage({ searchParams: Promise.resolve({ compare: [A.tenantId, B.tenantId] }) })).rejects.toMatchObject(
      NOT_FOUND,
    );
    expect(umami.requests).toEqual([]);
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
    ).toEqual({ status: "created" });
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
  it.todo("métrica enviada com a chave de A e atributos dizendo ser de B é gravada como A (coletor, #30 e #33)");

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
  it.todo("o coletor recusa a chave revogada em até 60 segundos (cache do coletor, #30)");
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
  it.todo("métrica de API de B removido é recusada pelo coletor com 401 (#30)");
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
