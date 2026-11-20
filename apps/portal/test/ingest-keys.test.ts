// Ingest keys (#59, E2 spec, section 5) against the DATABASE_URL Postgres.
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

const DOMAIN = "@keys-test.stellytics.invalid";
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

// Reads the collector's view as the stellytics_collector user, in a rolled-back transaction.
class Rollback extends Error {}
async function activeForCollector(prefix: string) {
  let rows: { prefix: string; tenant_id: string }[] = [];
  await sql
    .begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE stellytics_collector");
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

describe("key format", () => {
  it("follows ntf_<prefix>_<secret> with 256 bits of secret", () => {
    const { key, prefix, keyHash } = generateIngestKey();
    const match = key.match(KEY_PATTERN);
    expect(match?.[1]).toBe(prefix);
    expect(Buffer.from(match![2]!, "base64url")).toHaveLength(32);
    expect(keyHash.equals(createHash("sha256").update(key).digest())).toBe(true);
    expect(hashIngestKey(key).equals(keyHash)).toBe(true);
  });

  it("does not repeat keys or prefixes", () => {
    const keys = Array.from({ length: 2000 }, () => generateIngestKey());
    expect(new Set(keys.map((k) => k.key)).size).toBe(keys.length);
    expect(new Set(keys.map((k) => k.prefix)).size).toBe(keys.length);
    // All 32 base32 symbols show up: the prefix uses the 40 bits.
    expect(new Set(keys.flatMap((k) => [...k.prefix])).size).toBe(32);
  });
});

describe("services and keys", () => {
  it("creates the service with the first key and stores only prefix and hash", async () => {
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

  it("lists the keys without hash, newest to oldest", async () => {
    const ctx = await createMember();
    const { service, firstKey } = await createApiService(ctx, { name: "api" });
    const second = await createIngestKey(ctx, service.id);

    const keys = await listIngestKeys(ctx, service.id);
    expect(keys!.map((k) => k.id)).toEqual([second!.summary.id, firstKey.summary.id]);
    expect(Object.keys(keys![0]!).sort()).toEqual(["createdAt", "id", "lastUsedOn", "prefix", "revokedAt"]);
    expect(await listApiServices(ctx)).toEqual([service]);
  });

  it("rejects a repeated name in the same tenant, including in simultaneous requests", async () => {
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

  it(`accepts up to ${MAX_ACTIVE_KEYS} active keys per service`, async () => {
    const ctx = await createMember();
    const { service, firstKey } = await createApiService(ctx, { name: "limited" });
    for (let i = 1; i < MAX_ACTIVE_KEYS; i++) await createIngestKey(ctx, service.id);
    await expect(createIngestKey(ctx, service.id)).rejects.toMatchObject({ code: "key_limit" });

    // Revoking frees a slot.
    expect(await revokeIngestKey(ctx, firstKey.summary.id)).toBe(true);
    await expect(createIngestKey(ctx, service.id)).resolves.toBeTruthy();
    await expect(createIngestKey(ctx, service.id)).rejects.toBeInstanceOf(ApiServiceError);
  });

  it("the limit holds with simultaneous requests", async () => {
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

  it("revoking takes the key out of the collector's view and records it in the audit_log", async () => {
    const ctx = await createMember();
    const { service, firstKey } = await createApiService(ctx, { name: "revoke" });
    const { prefix } = firstKey.summary;
    expect(await activeForCollector(prefix)).toEqual([{ prefix, tenant_id: ctx.tenantId }]);

    expect(await revokeIngestKey(ctx, firstKey.summary.id)).toBe(true);
    expect(await activeForCollector(prefix)).toEqual([]);
    // Revoking again does nothing.
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

describe("isolation and tenant status", () => {
  it("does not read, create or revoke another tenant's keys", async () => {
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

  it("a removed tenant creates no service or key, but can revoke", async () => {
    const ctx = await createMember();
    const { service, firstKey } = await createApiService(ctx, { name: "before-removal" });
    await db.update(tenant).set({ status: "removed" }).where(eq(tenant.id, ctx.tenantId));
    const removed = (await loadTenantContext(ctx.userId))!;

    await expect(createApiService(removed, { name: "after" })).rejects.toMatchObject({ code: "tenant_removed" });
    await expect(createIngestKey(removed, service.id)).rejects.toMatchObject({ code: "tenant_removed" });
    expect(await revokeIngestKey(removed, firstKey.summary.id)).toBe(true);
  });

  it("an archived service gets no new key", async () => {
    const ctx = await createMember();
    const { service } = await createApiService(ctx, { name: "archived" });
    await db.update(apiService).set({ archivedAt: new Date() }).where(eq(apiService.id, service.id));
    await expect(createIngestKey(ctx, service.id)).rejects.toMatchObject({ code: "archived" });
  });
});

describe("last use by the collector", () => {
  // Runs as stellytics_collector in a rolled-back transaction; `check` runs again
  // as the owner, still inside the transaction, to read the effect.
  async function asCollector<T>(
    run: (tx: typeof sql) => Promise<unknown>,
    check?: (tx: typeof sql) => Promise<T>,
  ): Promise<{ result?: unknown; error?: Error; checked?: T }> {
    const out: { result?: unknown; error?: Error; checked?: T } = {};
    await sql
      .begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE stellytics_collector");
        try {
          await tx.unsafe("SAVEPOINT s");
          out.result = await run(tx as unknown as typeof sql);
        } catch (error) {
          out.error = error as Error;
          await tx.unsafe("ROLLBACK TO SAVEPOINT s");
        }
        await tx.unsafe("RESET ROLE");
        if (check) out.checked = await check(tx as unknown as typeof sql);
        throw new Rollback();
      })
      .catch((error) => {
        if (!(error instanceof Rollback)) throw error;
      });
    return out;
  }

  const lastUsed = (prefix: string) => (tx: typeof sql) =>
    tx`select last_used_on::text as d from ingest_key where prefix = ${prefix}`.then((r) => r[0]!.d as string | null);

  it("records the day (UTC) of an active key and does not write again on the same day", async () => {
    const ctx = await createMember();
    const { firstKey } = await createApiService(ctx, { name: "touched" });
    const prefix = firstKey.summary.prefix;
    const today = new Date().toISOString().slice(0, 10);

    const first = await asCollector((tx) => tx`select ingest_key_touch(${prefix}) as updated`, lastUsed(prefix));
    expect(first.error).toBeUndefined();
    expect((first.result as { updated: boolean }[])[0]!.updated).toBe(true);
    expect(first.checked).toBe(today);

    // Second call on the same day: nothing to write.
    await sql`update ingest_key set last_used_on = (now() at time zone 'utc')::date where prefix = ${prefix}`;
    const second = await asCollector((tx) => tx`select ingest_key_touch(${prefix}) as updated`);
    expect((second.result as { updated: boolean }[])[0]!.updated).toBe(false);
    await sql`update ingest_key set last_used_on = null where prefix = ${prefix}`;
  });

  it("does not update a revoked key, one of a removed tenant or a nonexistent prefix", async () => {
    const ctx = await createMember();
    const { firstKey } = await createApiService(ctx, { name: "revoked" });
    await revokeIngestKey(ctx, firstKey.summary.id);
    const gone = await createMember();
    const goneKey = (await createApiService(gone, { name: "gone" })).firstKey;
    await sql`update tenant set status = 'removed' where id = ${gone.tenantId}`;
    for (const prefix of [firstKey.summary.prefix, goneKey.summary.prefix]) {
      const r = await asCollector((tx) => tx`select ingest_key_touch(${prefix}) as updated`, lastUsed(prefix));
      expect((r.result as { updated: boolean }[])[0]!.updated).toBe(false);
      expect(r.checked).toBeNull();
    }
    const unknown = await asCollector((tx) => tx`select ingest_key_touch('zzzzzzzz') as updated`);
    expect((unknown.result as { updated: boolean }[])[0]!.updated).toBe(false);
  });

  it("the collector neither reads nor changes the ingest_key table, it only calls the function", async () => {
    const ctx = await createMember();
    const { firstKey } = await createApiService(ctx, { name: "privileges" });
    const prefix = firstKey.summary.prefix;
    for (const statement of [
      `update ingest_key set last_used_on = now()::date where prefix = '${prefix}'`,
      `update ingest_key set revoked_at = null where prefix = '${prefix}'`,
      `update ingest_key set key_hash = key_hash where prefix = '${prefix}'`,
      `select last_used_on from ingest_key`,
      `select key_hash from ingest_key`,
      `delete from ingest_key where prefix = '${prefix}'`,
      `update tenant set status = 'active'`,
    ]) {
      const r = await asCollector((tx) => tx.unsafe(statement));
      expect(r.error?.message, statement).toMatch(/permission denied/);
    }
    // The web gateway has no access to the function.
    let denied: Error | undefined;
    await sql
      .begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE stellytics_ingest");
        try {
          await tx.unsafe(`select ingest_key_touch('${prefix}')`);
        } catch (error) {
          denied = error as Error;
        }
        throw new Rollback();
      })
      .catch((error) => {
        if (!(error instanceof Rollback)) throw error;
      });
    expect(denied?.message).toMatch(/permission denied/);
  });
});

describe("logs", () => {
  it("no flow writes the key to the console", async () => {
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
