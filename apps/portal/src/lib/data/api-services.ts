import "server-only";
import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import type { TenantContext } from "../access";
import { db } from "../db";
import { apiService, auditLog, ingestKey } from "../db/schema";
import { generateIngestKey } from "../ingest-key";

// Serviços de API e chaves de ingestão do tenant (#59, spec do E2, seção 5).
// Toda função recebe o contexto e filtra por ctx.tenantId.

export const MAX_ACTIVE_KEYS = 5;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ApiService = typeof apiService.$inferSelect;

// O que as telas mostram de uma chave: nunca o hash nem a chave.
export type IngestKeySummary = {
  id: string;
  prefix: string;
  createdAt: Date;
  revokedAt: Date | null;
  lastUsedOn: string | null;
};

// A chave completa só existe neste valor, devolvido uma vez na criação.
export type CreatedIngestKey = { key: string; summary: IngestKeySummary };

export class ApiServiceError extends Error {
  constructor(
    readonly code: "tenant_removed" | "invalid_name" | "duplicate_name" | "archived" | "key_limit",
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
  // Spec do E2, seção 6: tenant removido não cadastra serviço nem chave.
  if (ctx.tenantStatus === "removed") {
    throw new ApiServiceError("tenant_removed", "This project was removed.");
  }
}

// Cria a chave dentro de uma transação que já travou a linha do serviço, para
// o limite de chaves ativas valer mesmo com pedidos simultâneos.
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

// Cria o serviço já com a primeira chave (spec do E2, seção 7).
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
    // Corrida entre dois cadastros com o mesmo nome: vale o índice único. O
    // Drizzle embrulha o erro do Postgres, que fica em `cause`.
    const pg = (error as { cause?: { constraint_name?: string } }).cause;
    if (pg?.constraint_name === "api_service_tenant_id_name_key") {
      throw new ApiServiceError("duplicate_name", "There is already a service with this name.");
    }
    throw error;
  });
}

export async function listApiServices(ctx: TenantContext): Promise<ApiService[]> {
  return db
    .select()
    .from(apiService)
    .where(and(eq(apiService.tenantId, ctx.tenantId), isNull(apiService.archivedAt)))
    .orderBy(asc(apiService.name));
}

// Nulo quando o serviço não existe, está arquivado ou é de outro tenant: a
// página responde 404 nos três casos.
export async function getApiService(ctx: TenantContext, serviceId: string): Promise<ApiService | null> {
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

// Chaves do serviço, ativas e revogadas, da mais nova para a mais antiga.
// Nulo para serviço de outro tenant.
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

// Nulo para serviço de outro tenant.
export async function createIngestKey(
  ctx: TenantContext,
  serviceId: string,
): Promise<CreatedIngestKey | null> {
  assertCanWrite(ctx);
  if (!UUID_REGEX.test(serviceId)) return null;
  return db.transaction(async (tx) => {
    // Trava o serviço: dois pedidos ao mesmo tempo não passam do limite.
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

// Revoga a chave. O coletor deixa de aceitá-la em até 60 segundos (cache dele).
// Verdadeiro: revogou agora. Falso: a chave é do tenant, mas já estava
// revogada (um clique duplo, por exemplo). Nulo: a chave não existe ou é de
// outro tenant, e quem chama responde 404. Tenant removido ainda pode
// revogar: só reduz o acesso.
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
