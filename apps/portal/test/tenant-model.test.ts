// Teste de integração do modelo de tenants (#16) contra um Postgres real
// (DATABASE_URL). Exige os papéis notify_ingest e notify_collector
// (infra/compose/postgres/init/02-ingest-roles.sh).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { apiService, ingestKey, site, tenant, tenantMember, user } from "@/lib/db/schema";
import { asRole } from "./helpers/as-role";

const DOMAIN = "@tenant-test.notify.invalid";
const SLUG = "tenant-test-";

// Prefixo de 8 caracteres em base32 minúsculo, como o da #59.
function randomPrefix() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return Array.from(randomBytes(8), (b) => alphabet[b % 32]).join("");
}

async function createUser() {
  const id = randomUUID();
  await db.insert(user).values({ id, name: "Test", email: `${id}${DOMAIN}`, emailVerified: true });
  return id;
}

async function createTenant(status: "active" | "removed" = "active") {
  const [row] = await db
    .insert(tenant)
    .values({ name: "Test project", slug: `${SLUG}${randomUUID()}`, status })
    .returning();
  return row!;
}

async function createService(tenantId: string) {
  const [row] = await db.insert(apiService).values({ tenantId, name: "api" }).returning();
  return row!;
}

async function createKey(serviceId: string, tenantId: string, createdBy: string) {
  const prefix = randomPrefix();
  const keyHash = createHash("sha256").update(`ntf_${prefix}_secret`).digest();
  await db.insert(ingestKey).values({ apiServiceId: serviceId, tenantId, prefix, keyHash, createdBy });
  return prefix;
}

async function cleanup() {
  const tenants = await db.select({ id: tenant.id }).from(tenant).where(like(tenant.slug, `${SLUG}%`));
  const ids = tenants.map((t) => t.id);
  if (ids.length > 0) {
    await db.delete(ingestKey).where(inArray(ingestKey.tenantId, ids));
    await db.delete(apiService).where(inArray(apiService.tenantId, ids));
    await db.delete(site).where(inArray(site.tenantId, ids));
    await db.delete(tenantMember).where(inArray(tenantMember.tenantId, ids));
    await db.delete(tenant).where(inArray(tenant.id, ids));
  }
  await db.delete(user).where(like(user.email, `%${DOMAIN}`));
}

let userId: string;

beforeAll(async () => {
  await runMigrations();
  await cleanup();
  userId = await createUser();
});

afterAll(async () => {
  await cleanup();
  await sql.end();
});

describe("modelo de tenants", () => {
  it("cria o tenant ativo por padrão e aceita os três status", async () => {
    const created = await createTenant();
    expect(created.status).toBe("active");
    expect(created.statusChangedBy).toBeNull();

    for (const status of ["removed", "pending", "active"] as const) {
      await db.update(tenant).set({ status }).where(eq(tenant.id, created.id));
    }
    await expect(
      sql`update tenant set status = 'deleted' where id = ${created.id}`,
    ).rejects.toThrow();
  });

  it("um usuário pertence a um único tenant (D1)", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const member = await createUser();
    await db.insert(tenantMember).values({ tenantId: a.id, userId: member, role: "owner" });
    await expect(
      db.insert(tenantMember).values({ tenantId: b.id, userId: member }),
    ).rejects.toThrow();
  });

  it("o domínio do site é único por tenant", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const values = { name: "Site", domain: "example.org" };
    await db.insert(site).values({ ...values, tenantId: a.id, umamiWebsiteId: randomUUID() });
    await db.insert(site).values({ ...values, tenantId: b.id, umamiWebsiteId: randomUUID() });
    await expect(
      db.insert(site).values({ ...values, tenantId: a.id, umamiWebsiteId: randomUUID() }),
    ).rejects.toThrow();
  });

  it("a chave de ingestão precisa ser do mesmo tenant do serviço", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const serviceOfA = await createService(a.id);
    await createKey(serviceOfA.id, a.id, userId);
    await expect(createKey(serviceOfA.id, b.id, userId)).rejects.toThrow();
  });

  it("recusa prefixo fora do formato e hash que não é SHA-256", async () => {
    const a = await createTenant();
    const service = await createService(a.id);
    const base = { apiServiceId: service.id, tenantId: a.id, createdBy: userId };
    await expect(
      db.insert(ingestKey).values({ ...base, prefix: "NOT-B32!", keyHash: randomBytes(32) }),
    ).rejects.toThrow();
    await expect(
      db.insert(ingestKey).values({ ...base, prefix: randomPrefix(), keyHash: randomBytes(16) }),
    ).rejects.toThrow();
  });

  it("audit_log só recebe inserções", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`insert into audit_log (action) values ('test.append_only')`;
        await tx`update audit_log set action = 'changed' where action = 'test.append_only'`;
      }),
    ).rejects.toThrow(/só recebe inserções/);
    await expect(
      sql.begin(async (tx) => {
        await tx`insert into audit_log (action) values ('test.append_only')`;
        await tx`delete from audit_log where action = 'test.append_only'`;
      }),
    ).rejects.toThrow(/só recebe inserções/);
  });
});

describe("visões de ingestão (D4)", () => {
  it("ingest_site aceita só site não arquivado de tenant ativo", async () => {
    const active = await createTenant();
    const removed = await createTenant("removed");
    const live = randomUUID();
    const archived = randomUUID();
    const ofRemoved = randomUUID();
    await db.insert(site).values([
      { tenantId: active.id, name: "Live", domain: "live.example", umamiWebsiteId: live },
      {
        tenantId: active.id,
        name: "Old",
        domain: "old.example",
        umamiWebsiteId: archived,
        archivedAt: new Date(),
      },
      { tenantId: removed.id, name: "Gone", domain: "gone.example", umamiWebsiteId: ofRemoved },
    ]);

    const rows = await asRole<{ umami_website_id: string; accepts_ingest: boolean }>(
      "notify_ingest",
      `select umami_website_id, accepts_ingest from ingest_site
       where umami_website_id in ('${live}', '${archived}', '${ofRemoved}')`,
    );
    const accepts = Object.fromEntries(rows.map((r) => [r.umami_website_id, r.accepts_ingest]));
    expect(accepts).toEqual({ [live]: true, [archived]: false, [ofRemoved]: false });
  });

  it("ingest_key_active mostra só chaves válidas, com tenant e serviço", async () => {
    const active = await createTenant();
    const removed = await createTenant("removed");
    const service = await createService(active.id);
    const valid = await createKey(service.id, active.id, userId);
    const revoked = await createKey(service.id, active.id, userId);
    await db.update(ingestKey).set({ revokedAt: new Date() }).where(eq(ingestKey.prefix, revoked));
    const serviceOfRemoved = await createService(removed.id);
    const ofRemoved = await createKey(serviceOfRemoved.id, removed.id, userId);

    const rows = await asRole<{ prefix: string; tenant_id: string; service_name: string }>(
      "notify_collector",
      `select prefix, tenant_id, service_name from ingest_key_active
       where prefix in ('${valid}', '${revoked}', '${ofRemoved}')`,
    );
    expect(rows).toEqual([{ prefix: valid, tenant_id: active.id, service_name: "api" }]);
  });

  it("os usuários de ingestão não leem as tabelas nem a visão do outro", async () => {
    const denied = [
      ["notify_ingest", 'select 1 from "user"'],
      ["notify_ingest", "select 1 from site"],
      ["notify_ingest", "select 1 from ingest_key_active"],
      ["notify_collector", "select 1 from ingest_key"],
      ["notify_collector", "select 1 from session"],
      ["notify_collector", "select 1 from ingest_site"],
    ] as const;
    for (const [role, query] of denied) {
      await expect(asRole(role, query), `${role}: ${query}`).rejects.toThrow(/permission denied/);
    }
  });
});
