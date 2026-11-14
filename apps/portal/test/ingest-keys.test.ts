// Chaves de ingestão (#59, spec do E2, seção 5) contra o Postgres de DATABASE_URL.
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadTenantContext, type TenantContext } from "@/lib/access";
import {
  ApiServiceError,
  createApiService,
  createIngestKey,
  getApiService,
  listApiServices,
  listIngestKeys,
  MAX_ACTIVE_KEYS,
  revokeIngestKey,
} from "@/lib/data/api-services";
import { db, sql } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { apiService, auditLog, ingestKey, tenant, tenantMember, user } from "@/lib/db/schema";
import { generateIngestKey, hashIngestKey, KEY_PATTERN } from "@/lib/ingest-key";

const DOMAIN = "@keys-test.notify.invalid";
const SLUG = "keys-test-";

async function createMember(status: "active" | "removed" = "active"): Promise<TenantContext> {
  const userId = randomUUID();
  await db.insert(user).values({ id: userId, name: "Test", email: `${userId}${DOMAIN}` });
  const [created] = await db
    .insert(tenant)
    .values({ name: "Project", slug: `${SLUG}${randomUUID()}`, status })
    .returning();
  await db.insert(tenantMember).values({ tenantId: created!.id, userId, role: "owner" });
  return (await loadTenantContext(userId))!;
}

// Lê a visão do coletor como o usuário notify_collector, numa transação desfeita.
class Rollback extends Error {}
async function activeForCollector(prefix: string) {
  let rows: { prefix: string; tenant_id: string }[] = [];
  await sql
    .begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE notify_collector");
      rows = await tx`select prefix, tenant_id from ingest_key_active where prefix = ${prefix}`;
      throw new Rollback();
    })
    .catch((error) => {
      if (!(error instanceof Rollback)) throw error;
    });
  return rows;
}

async function cleanup() {
  const ids = (await db.select({ id: tenant.id }).from(tenant).where(like(tenant.slug, `${SLUG}%`))).map(
    (t) => t.id,
  );
  if (ids.length > 0) {
    await db.delete(ingestKey).where(inArray(ingestKey.tenantId, ids));
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

afterAll(async () => {
  await cleanup();
  await sql.end();
});

describe("formato da chave", () => {
  it("segue ntf_<prefixo>_<segredo> com 256 bits de segredo", () => {
    const { key, prefix, keyHash } = generateIngestKey();
    const match = key.match(KEY_PATTERN);
    expect(match?.[1]).toBe(prefix);
    expect(Buffer.from(match![2]!, "base64url")).toHaveLength(32);
    expect(keyHash.equals(createHash("sha256").update(key).digest())).toBe(true);
    expect(hashIngestKey(key).equals(keyHash)).toBe(true);
  });

  it("não repete chaves nem prefixos", () => {
    const keys = Array.from({ length: 2000 }, () => generateIngestKey());
    expect(new Set(keys.map((k) => k.key)).size).toBe(keys.length);
    expect(new Set(keys.map((k) => k.prefix)).size).toBe(keys.length);
    // Os 32 símbolos do base32 aparecem: o prefixo usa os 40 bits.
    expect(new Set(keys.flatMap((k) => [...k.prefix])).size).toBe(32);
  });
});

describe("serviços e chaves", () => {
  it("cria o serviço com a primeira chave e guarda só prefixo e hash", async () => {
    const ctx = await createMember();
    const { service, firstKey } = await createApiService(ctx, { name: " horizon-proxy " });

    expect(service).toMatchObject({ tenantId: ctx.tenantId, name: "horizon-proxy" });
    expect(firstKey.key).toMatch(KEY_PATTERN);
    expect(firstKey.key.startsWith(`ntf_${firstKey.summary.prefix}_`)).toBe(true);

    const [row] = await db.select().from(ingestKey).where(eq(ingestKey.id, firstKey.summary.id));
    expect(row!.keyHash.equals(hashIngestKey(firstKey.key))).toBe(true);
    expect(row!.createdBy).toBe(ctx.userId);
    const secret = firstKey.key.split("_").slice(2).join("_");
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it("lista as chaves sem hash, da mais nova para a mais antiga", async () => {
    const ctx = await createMember();
    const { service, firstKey } = await createApiService(ctx, { name: "api" });
    const second = await createIngestKey(ctx, service.id);

    const keys = await listIngestKeys(ctx, service.id);
    expect(keys!.map((k) => k.id)).toEqual([second!.summary.id, firstKey.summary.id]);
    expect(Object.keys(keys![0]!).sort()).toEqual(["createdAt", "id", "lastUsedOn", "prefix", "revokedAt"]);
    expect(await listApiServices(ctx)).toEqual([service]);
  });

  it("recusa nome repetido no mesmo tenant, inclusive em pedidos simultâneos", async () => {
    const ctx = await createMember();
    await createApiService(ctx, { name: "dup" });
    await expect(createApiService(ctx, { name: "dup" })).rejects.toMatchObject({ code: "duplicate_name" });

    const results = await Promise.allSettled([
      createApiService(ctx, { name: "race" }),
      createApiService(ctx, { name: "race" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "duplicate_name" });
  });

  it(`aceita até ${MAX_ACTIVE_KEYS} chaves ativas por serviço`, async () => {
    const ctx = await createMember();
    const { service, firstKey } = await createApiService(ctx, { name: "limited" });
    for (let i = 1; i < MAX_ACTIVE_KEYS; i++) await createIngestKey(ctx, service.id);
    await expect(createIngestKey(ctx, service.id)).rejects.toMatchObject({ code: "key_limit" });

    // Revogar libera uma vaga.
    expect(await revokeIngestKey(ctx, firstKey.summary.id)).toBe(true);
    await expect(createIngestKey(ctx, service.id)).resolves.toBeTruthy();
    await expect(createIngestKey(ctx, service.id)).rejects.toBeInstanceOf(ApiServiceError);
  });

  it("o limite vale com pedidos simultâneos", async () => {
    const ctx = await createMember();
    const { service } = await createApiService(ctx, { name: "concurrent" });
    for (let i = 2; i < MAX_ACTIVE_KEYS; i++) await createIngestKey(ctx, service.id);

    const results = await Promise.allSettled(Array.from({ length: 4 }, () => createIngestKey(ctx, service.id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const active = await db
      .select()
      .from(ingestKey)
      .where(eq(ingestKey.apiServiceId, service.id));
    expect(active.filter((k) => !k.revokedAt)).toHaveLength(MAX_ACTIVE_KEYS);
  });

  it("revogar tira a chave da visão do coletor e registra no audit_log", async () => {
    const ctx = await createMember();
    const { service, firstKey } = await createApiService(ctx, { name: "revoke" });
    const { prefix } = firstKey.summary;
    expect(await activeForCollector(prefix)).toEqual([{ prefix, tenant_id: ctx.tenantId }]);

    expect(await revokeIngestKey(ctx, firstKey.summary.id)).toBe(true);
    expect(await activeForCollector(prefix)).toEqual([]);
    // Revogar de novo não faz nada.
    expect(await revokeIngestKey(ctx, firstKey.summary.id)).toBe(false);

    const audit = await db
      .select({ action: auditLog.action, actor: auditLog.actorUserId, details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, ctx.tenantId)))
      .orderBy(auditLog.at);
    expect(audit).toEqual([
      { action: "ingest_key.created", actor: ctx.userId, details: { apiServiceId: service.id, prefix } },
      { action: "ingest_key.revoked", actor: ctx.userId, details: { apiServiceId: service.id, prefix } },
    ]);
  });
});

describe("isolamento e status do tenant", () => {
  it("não lê, cria nem revoga chaves de outro tenant", async () => {
    const a = await createMember();
    const b = await createMember();
    const ofB = await createApiService(b, { name: "b-service" });

    expect(await getApiService(a, ofB.service.id)).toBeNull();
    expect(await listIngestKeys(a, ofB.service.id)).toBeNull();
    expect(await createIngestKey(a, ofB.service.id)).toBeNull();
    expect(await revokeIngestKey(a, ofB.firstKey.summary.id)).toBeNull();
    expect(await revokeIngestKey(a, randomUUID())).toBeNull();
    expect(await revokeIngestKey(a, "not-a-uuid")).toBeNull();
    expect(await getApiService(a, "not-a-uuid")).toBeNull();

    const keysOfB = await listIngestKeys(b, ofB.service.id);
    expect(keysOfB).toHaveLength(1);
    expect(keysOfB![0]!.revokedAt).toBeNull();
  });

  it("tenant removido não cria serviço nem chave, mas pode revogar", async () => {
    const ctx = await createMember();
    const { service, firstKey } = await createApiService(ctx, { name: "before-removal" });
    await db.update(tenant).set({ status: "removed" }).where(eq(tenant.id, ctx.tenantId));
    const removed = (await loadTenantContext(ctx.userId))!;

    await expect(createApiService(removed, { name: "after" })).rejects.toMatchObject({ code: "tenant_removed" });
    await expect(createIngestKey(removed, service.id)).rejects.toMatchObject({ code: "tenant_removed" });
    expect(await revokeIngestKey(removed, firstKey.summary.id)).toBe(true);
  });

  it("serviço arquivado não recebe chave nova", async () => {
    const ctx = await createMember();
    const { service } = await createApiService(ctx, { name: "archived" });
    await db.update(apiService).set({ archivedAt: new Date() }).where(eq(apiService.id, service.id));
    await expect(createIngestKey(ctx, service.id)).rejects.toMatchObject({ code: "archived" });
  });
});

describe("logs", () => {
  it("nenhum fluxo escreve a chave no console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const ctx = await createMember();
      const { service, firstKey } = await createApiService(ctx, { name: "quiet" });
      const second = await createIngestKey(ctx, service.id);
      await revokeIngestKey(ctx, firstKey.summary.id);
      await createApiService(ctx, { name: "quiet" }).catch(() => {});

      const printed = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
      expect(printed).not.toContain(firstKey.key);
      expect(printed).not.toContain(second!.key);
      expect(printed).not.toMatch(/ntf_[a-z2-7]{8}_/);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
