import "server-only";
import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import type { TenantContext, TenantReadContext } from "../access";
import { db } from "../db";
import { apiService, auditLog, ingestKey } from "../db/schema";
import { generateIngestKey } from "../ingest-key";

// The tenant's API services and ingest keys (#59, E2 spec, section 5).
// Every function takes the context and filters by ctx.tenantId.

export const MAX_ACTIVE_KEYS = 5;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ApiService = typeof apiService.$inferSelect;

// What the screens show of a key: never the hash or the key.
export type IngestKeySummary = {
  id: string;
  prefix: string;
  createdAt: Date;
  revokedAt: Date | null;
  lastUsedOn: string | null;
};

// The full key exists only in this value, returned once on creation.
export type CreatedIngestKey = { key: string; summary: IngestKeySummary };

export class ApiServiceError extends Error {
  constructor(
    readonly code: "tenant_removed" | "tenant_pending" | "invalid_name" | "duplicate_name" | "archived" | "key_limit",
    message: string,
  ) {
    super(message);
    this.name = "ApiServiceError";
  }
}

const keySummary = {
  id: ingestKey.id,
  prefix: ingestKey.prefix,
  createdAt: ingestKey.createdAt,
  revokedAt: ingestKey.revokedAt,
  lastUsedOn: ingestKey.lastUsedOn,
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function assertCanWrite(ctx: TenantContext) {
  // E2 spec, section 6: a removed tenant registers no service or key.
  if (ctx.tenantStatus === "removed") {
    throw new ApiServiceError("tenant_removed", "This project was removed.");
  }
  // Sign-up with approval (#49): a pending project registers no service or key.
  if (ctx.tenantStatus === "pending") {
    throw new ApiServiceError("tenant_pending", "This project is awaiting approval.");
  }
}

// Creates the key inside a transaction that already locked the service row, so
// the active key limit holds even with simultaneous requests.
async function insertKey(tx: Tx, ctx: TenantContext, serviceId: string): Promise<CreatedIngestKey> {
  const [{ active }] = (await tx
    .select({ active: count() })
    .from(ingestKey)
    .where(and(eq(ingestKey.apiServiceId, serviceId), isNull(ingestKey.revokedAt)))) as [{ active: number }];
  if (active >= MAX_ACTIVE_KEYS) {
    throw new ApiServiceError(
      "key_limit",
      `A service can have at most ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`,
    );
  }
  const { key, prefix, keyHash } = generateIngestKey();
  const [summary] = await tx
    .insert(ingestKey)
    .values({ apiServiceId: serviceId, tenantId: ctx.tenantId, prefix, keyHash, createdBy: ctx.userId })
    .returning(keySummary);
  await tx.insert(auditLog).values({
    actorUserId: ctx.userId,
    action: "ingest_key.created",
    tenantId: ctx.tenantId,
    details: { apiServiceId: serviceId, prefix },
  });
  return { key, summary: summary! };
}

// Creates the service already with the first key (E2 spec, section 7).
export async function createApiService(
  ctx: TenantContext,
  input: { name: string },
): Promise<{ service: ApiService; firstKey: CreatedIngestKey }> {
  assertCanWrite(ctx);
  const name = input.name.trim();
  if (name.length < 1 || name.length > 100) {
    throw new ApiServiceError("invalid_name", "Name must have between 1 and 100 characters.");
  }
  return db.transaction(async (tx) => {
    const [duplicate] = await tx
      .select({ id: apiService.id })
      .from(apiService)
      .where(and(eq(apiService.tenantId, ctx.tenantId), eq(apiService.name, name)))
      .limit(1);
    if (duplicate) {
      throw new ApiServiceError("duplicate_name", "There is already a service with this name.");
    }
    const [service] = await tx.insert(apiService).values({ tenantId: ctx.tenantId, name }).returning();
    const firstKey = await insertKey(tx, ctx, service!.id);
    return { service: service!, firstKey };
  }).catch((error: unknown) => {
    // Race between two registrations with the same name: the unique index
    // decides. Drizzle wraps the Postgres error, which ends up in `cause`.
    const pg = (error as { cause?: { constraint_name?: string } }).cause;
    if (pg?.constraint_name === "api_service_tenant_id_name_key") {
      throw new ApiServiceError("duplicate_name", "There is already a service with this name.");
    }
    throw error;
  });
}

export async function listApiServices(ctx: TenantReadContext): Promise<ApiService[]> {
  return db
    .select()
    .from(apiService)
    .where(and(eq(apiService.tenantId, ctx.tenantId), isNull(apiService.archivedAt)))
    .orderBy(asc(apiService.name));
}

// Null when the service does not exist, is archived or belongs to another
// tenant: the page answers 404 in all three cases.
export async function getApiService(ctx: TenantReadContext, serviceId: string): Promise<ApiService | null> {
  if (!UUID_REGEX.test(serviceId)) return null;
  const [found] = await db
    .select()
    .from(apiService)
    .where(
      and(eq(apiService.id, serviceId), eq(apiService.tenantId, ctx.tenantId), isNull(apiService.archivedAt)),
    )
    .limit(1);
  return found ?? null;
}

// The service's keys, active and revoked, from newest to oldest.
// Null for another tenant's service.
export async function listIngestKeys(
  ctx: TenantContext,
  serviceId: string,
): Promise<IngestKeySummary[] | null> {
  if (!(await getApiService(ctx, serviceId))) return null;
  return db
    .select(keySummary)
    .from(ingestKey)
    .where(and(eq(ingestKey.apiServiceId, serviceId), eq(ingestKey.tenantId, ctx.tenantId)))
    .orderBy(desc(ingestKey.createdAt));
}

// Null for another tenant's service.
export async function createIngestKey(
  ctx: TenantContext,
  serviceId: string,
): Promise<CreatedIngestKey | null> {
  assertCanWrite(ctx);
  if (!UUID_REGEX.test(serviceId)) return null;
  return db.transaction(async (tx) => {
    // Locks the service: two requests at the same time do not go over the limit.
    const [service] = await tx
      .select({ id: apiService.id, archivedAt: apiService.archivedAt })
      .from(apiService)
      .where(and(eq(apiService.id, serviceId), eq(apiService.tenantId, ctx.tenantId)))
      .for("update");
    if (!service) return null;
    if (service.archivedAt) {
      throw new ApiServiceError("archived", "This service is archived.");
    }
    return insertKey(tx, ctx, service.id);
  });
}

// Revokes the key. The collector stops accepting it within 60 seconds (its cache).
// True: revoked now. False: the key belongs to the tenant, but was already
// revoked (a double click, for example). Null: the key does not exist or
// belongs to another tenant, and the caller answers 404. A removed tenant can
// still revoke: it only reduces access.
export async function revokeIngestKey(ctx: TenantContext, keyId: string): Promise<boolean | null> {
  if (!UUID_REGEX.test(keyId)) return null;
  return db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(ingestKey)
      .set({ revokedAt: new Date() })
      .where(and(eq(ingestKey.id, keyId), eq(ingestKey.tenantId, ctx.tenantId), isNull(ingestKey.revokedAt)))
      .returning({ prefix: ingestKey.prefix, apiServiceId: ingestKey.apiServiceId });
    if (!revoked) {
      const [own] = await tx
        .select({ id: ingestKey.id })
        .from(ingestKey)
        .where(and(eq(ingestKey.id, keyId), eq(ingestKey.tenantId, ctx.tenantId)));
      return own ? false : null;
    }
    await tx.insert(auditLog).values({
      actorUserId: ctx.userId,
      action: "ingest_key.revoked",
      tenantId: ctx.tenantId,
      details: { apiServiceId: revoked.apiServiceId, prefix: revoked.prefix },
    });
    return true;
  });
}
