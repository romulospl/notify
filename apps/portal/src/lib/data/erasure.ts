import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { apiService, auditLog, ingestKey, operatorApiKey, site, tenant, tenantMember, user } from "../db/schema";
import { deleteUmamiWebsite } from "../umami/purge";

// Right to erasure (#154): erase a tenant's data and delete one's own
// account. Decisions recorded in docs/privacy.md (sections 6 and 7):
//
// - The tenant row stays: its audit_log history remains readable and the
//   slug is not reused. What goes away is the collected data.
// - The user's actions in the audit_log are anonymized, not erased: the
//   triggers (0002 and 0009) accept replacing `actor_user_id` with the marker
//   and nothing else.
// - The sites leave Umami BEFORE the database: if the erasure in the database
//   fails, repeating it completes; the other way round, a site erased here but
//   alive in Umami would keep collecting events with no owner. The DELETE in
//   Umami treats 404 as success, so repeating never gets stuck halfway.

// Same value as the trigger in 0009_erasure.sql; the isolation test checks
// both sides.
export const ANONYMIZED_ACTOR = "[erased]";

export class ErasureError extends Error {
  constructor(
    readonly code: "tenant_active",
    message: string,
  ) {
    super(message);
    this.name = "ErasureError";
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PurgeResult = { sites: number };

// Erases a tenant's collected data: sites in Umami (archived ones included),
// site, service and key rows and the API metrics in the three tables
// (api_metric_purge_tenant, migration 0009). When the tenant is not yet
// `removed`, marks it as removed with the given reason. Called by the
// operator (purgeRemovedTenant) and by the erasure of one's own account.
export async function purgeTenantData(input: {
  tenantId: string;
  actorUserId: string | null;
  statusReason: string;
}): Promise<PurgeResult> {
  if (!UUID_REGEX.test(input.tenantId)) throw new ErasureError("tenant_active", "This project was not found.");
  const [current] = await db
    .select({ status: tenant.status })
    .from(tenant)
    .where(eq(tenant.id, input.tenantId))
    .limit(1);
  if (!current) throw new ErasureError("tenant_active", "This project was not found.");

  const siteRows = await db
    .select({ umamiWebsiteId: site.umamiWebsiteId })
    .from(site)
    .where(eq(site.tenantId, input.tenantId));
  for (const row of siteRows) await deleteUmamiWebsite(row.umamiWebsiteId);

  await db.transaction(async (tx) => {
    // The key references the service (ingest_key_api_service_fk): it goes first.
    await tx.delete(ingestKey).where(eq(ingestKey.tenantId, input.tenantId));
    await tx.delete(apiService).where(eq(apiService.tenantId, input.tenantId));
    await tx.delete(site).where(eq(site.tenantId, input.tenantId));
    await tx.execute(sql`select api_metric_purge_tenant(${input.tenantId}::uuid)`);
    if (current.status !== "removed") {
      await tx
        .update(tenant)
        .set({
          status: "removed",
          // The time right now, as in changeStatus (data/operator/tenants.ts):
          // concurrent changes stay in order in the history.
          statusChangedAt: sql`clock_timestamp()`,
          statusChangedBy: input.actorUserId,
          statusReason: input.statusReason,
        })
        .where(eq(tenant.id, input.tenantId));
    }
    await tx.insert(auditLog).values({
      at: sql`clock_timestamp()`,
      actorUserId: input.actorUserId,
      action: "tenant.purged",
      tenantId: input.tenantId,
      details: { sites: siteRows.length },
    });
  });
  return { sites: siteRows.length };
}

// Deletes one's own account. Null when the user does not exist (already
// deleted, for example on a double click). Flow:
//
// 1. Member and owner of the project (D1: every user belongs to one tenant):
//    erases the tenant's data before the account. Only the owner gets here
//    with a project to erase; if there are ever invites (#D1 dropping the
//    unique index), this rule needs a review.
// 2. In one database, in order: SCF read keys created by the user (restrict
//    foreign key), the final `account.deleted` record, the anonymization of
//    all of their actions in the audit_log (the erasure itself keeps the
//    marker) and the user row: session, account and tenant_member go by
//    cascade, and tenant.status_changed_by becomes null.
export async function deleteOwnAccount(userId: string): Promise<PurgeResult | null> {
  const [account] = await db.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1);
  if (!account) return null;
  const [membership] = await db
    .select({ tenantId: tenantMember.tenantId, role: tenantMember.role })
    .from(tenantMember)
    .where(eq(tenantMember.userId, userId))
    .limit(1);

  let purged: PurgeResult = { sites: 0 };
  if (membership && membership.role === "owner") {
    purged = await purgeTenantData({
      tenantId: membership.tenantId,
      actorUserId: userId,
      statusReason: "Account deleted.",
    });
  }

  await db.transaction(async (tx) => {
    await tx.delete(operatorApiKey).where(eq(operatorApiKey.createdBy, userId));
    await tx.insert(auditLog).values({
      at: sql`clock_timestamp()`,
      actorUserId: userId,
      action: "account.deleted",
      tenantId: membership?.tenantId ?? null,
      details: purged,
    });
    await tx
      .update(auditLog)
      .set({ actorUserId: ANONYMIZED_ACTOR })
      .where(eq(auditLog.actorUserId, userId));
    await tx.delete(user).where(eq(user.id, userId));
  });
  return purged;
}
