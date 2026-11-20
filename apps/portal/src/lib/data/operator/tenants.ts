import "server-only";
import { and, asc, count, desc, eq, isNull, like, sql } from "drizzle-orm";
import type { OperatorContext } from "../../access";
import { db } from "../../db";
import { apiService, auditLog, ingestKey, site, tenant, tenantMember, user } from "../../db/schema";
import { purgeTenantData } from "../erasure";

// Global view of the SCF operator (#19, E2 spec, section 2): read of all
// tenants. Of the ingest keys, only prefix and dates; never the hash.
//
// The only write is changing the tenant's status (#20, #49): remove,
// reactivate, approve and reject.

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TenantOverview = {
  id: string;
  name: string;
  slug: string;
  status: "active" | "removed" | "pending";
  createdAt: Date;
  members: number;
  sites: number;
  services: number;
  activeKeys: number;
};

export async function listTenants(ctx: OperatorContext): Promise<TenantOverview[]> {
  void ctx; // Requiring the context proves that the caller is an operator.
  const members = db
    .select({ tenantId: tenantMember.tenantId, n: count().as("members") })
    .from(tenantMember)
    .groupBy(tenantMember.tenantId)
    .as("members");
  const sites = db
    .select({ tenantId: site.tenantId, n: count().as("sites") })
    .from(site)
    .where(isNull(site.archivedAt))
    .groupBy(site.tenantId)
    .as("sites");
  const services = db
    .select({ tenantId: apiService.tenantId, n: count().as("services") })
    .from(apiService)
    .where(isNull(apiService.archivedAt))
    .groupBy(apiService.tenantId)
    .as("services");
  const keys = db
    .select({ tenantId: ingestKey.tenantId, n: count().as("keys") })
    .from(ingestKey)
    .where(isNull(ingestKey.revokedAt))
    .groupBy(ingestKey.tenantId)
    .as("keys");

  return db
    .select({
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      createdAt: tenant.createdAt,
      members: sql<number>`coalesce(${members.n}, 0)::int`,
      sites: sql<number>`coalesce(${sites.n}, 0)::int`,
      services: sql<number>`coalesce(${services.n}, 0)::int`,
      activeKeys: sql<number>`coalesce(${keys.n}, 0)::int`,
    })
    .from(tenant)
    .leftJoin(members, eq(members.tenantId, tenant.id))
    .leftJoin(sites, eq(sites.tenantId, tenant.id))
    .leftJoin(services, eq(services.tenantId, tenant.id))
    .leftJoin(keys, eq(keys.tenantId, tenant.id))
    .orderBy(asc(tenant.name));
}

// Detail of a tenant, including a removed one. Null when it does not exist.
export async function getTenantDetail(ctx: OperatorContext, tenantId: string) {
  void ctx;
  if (!UUID_REGEX.test(tenantId)) return null;
  const [found] = await db
    .select({
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      statusChangedAt: tenant.statusChangedAt,
      statusChangedBy: user.email,
      statusReason: tenant.statusReason,
      createdAt: tenant.createdAt,
    })
    .from(tenant)
    .leftJoin(user, eq(user.id, tenant.statusChangedBy))
    .where(eq(tenant.id, tenantId));
  if (!found) return null;

  const [memberRows, siteRows, serviceRows, keyRows, historyRows] = await Promise.all([
    db
      .select({ name: user.name, email: user.email, role: tenantMember.role, since: tenantMember.createdAt })
      .from(tenantMember)
      .innerJoin(user, eq(user.id, tenantMember.userId))
      .where(eq(tenantMember.tenantId, tenantId))
      .orderBy(asc(tenantMember.createdAt)),
    db
      .select({
        id: site.id,
        name: site.name,
        domain: site.domain,
        umamiWebsiteId: site.umamiWebsiteId,
        createdAt: site.createdAt,
        archivedAt: site.archivedAt,
      })
      .from(site)
      .where(eq(site.tenantId, tenantId))
      .orderBy(asc(site.createdAt)),
    db
      .select({ id: apiService.id, name: apiService.name, archivedAt: apiService.archivedAt })
      .from(apiService)
      .where(eq(apiService.tenantId, tenantId))
      .orderBy(asc(apiService.name)),
    db
      .select({
        apiServiceId: ingestKey.apiServiceId,
        prefix: ingestKey.prefix,
        createdAt: ingestKey.createdAt,
        revokedAt: ingestKey.revokedAt,
        lastUsedOn: ingestKey.lastUsedOn,
      })
      .from(ingestKey)
      .where(eq(ingestKey.tenantId, tenantId))
      .orderBy(desc(ingestKey.createdAt)),
    // Status history (creation, removals and reactivations), from the audit_log.
    db
      .select({ at: auditLog.at, action: auditLog.action, actor: user.email, details: auditLog.details })
      .from(auditLog)
      .leftJoin(user, eq(user.id, auditLog.actorUserId))
      .where(and(eq(auditLog.tenantId, tenantId), like(auditLog.action, "tenant.%")))
      .orderBy(desc(auditLog.at)),
  ]);

  return {
    tenant: found,
    statusHistory: historyRows.map((h) => ({
      at: h.at,
      action: h.action,
      actor: h.actor,
      reason: (h.details as { reason?: string }).reason ?? null,
    })),
    members: memberRows,
    sites: siteRows,
    services: serviceRows.map((service) => ({
      ...service,
      keys: keyRows
        .filter((k) => k.apiServiceId === service.id)
        .map((k) => ({ prefix: k.prefix, createdAt: k.createdAt, revokedAt: k.revokedAt, lastUsedOn: k.lastUsedOn })),
    })),
  };
}

// Tenant removal and reactivation (#20, E2 spec, section 6, D6).
//
// Removing is deactivating: the data stays in the database. The ingest views
// (migration 0002) only accept an `active` tenant, so the web gateway and the
// collector start rejecting ingestion within 1 minute (their cache). Each
// change goes to the audit_log with who did it and the reason.

export const REASON_MAX = 500;

export class TenantStatusError extends Error {
  constructor(
    readonly code: "invalid_reason" | "invalid_confirm",
    message: string,
  ) {
    super(message);
    this.name = "TenantStatusError";
  }
}

// Null: the tenant does not exist. "unchanged": it was already in the
// requested status (for example, two operators at the same time); nothing is written.
export type StatusChangeResult = "changed" | "unchanged" | null;

function cleanReason(raw: string | undefined, required: boolean): string | null {
  const reason = (raw ?? "").trim();
  if (reason.length > REASON_MAX) {
    throw new TenantStatusError("invalid_reason", `The reason must have at most ${REASON_MAX} characters.`);
  }
  if (required && reason.length < 3) {
    throw new TenantStatusError("invalid_reason", "Tell the project why.");
  }
  return reason || null;
}

type Transition = {
  to: "active" | "removed";
  // Statuses the change is valid from; from any other, nothing is written ("unchanged").
  from: ReadonlyArray<"active" | "removed" | "pending">;
  action: "tenant.removed" | "tenant.reactivated" | "tenant.approved" | "tenant.rejected";
};

async function changeStatus(
  ctx: OperatorContext,
  tenantId: string,
  transition: Transition,
  reason: string | null,
): Promise<StatusChangeResult> {
  if (!UUID_REGEX.test(tenantId)) return null;
  const { to, from, action } = transition;
  return db.transaction(async (tx) => {
    // Locks the row: two changes at the same time write a single record.
    const [current] = await tx
      .select({ status: tenant.status })
      .from(tenant)
      .where(eq(tenant.id, tenantId))
      .for("update");
    if (!current) return null;
    if (!from.includes(current.status)) return "unchanged";

    await tx
      .update(tenant)
      .set({
        status: to,
        statusChangedAt: sql`clock_timestamp()`,
        statusChangedBy: ctx.userId,
        // The reason in the column is the current status's; the reactivation
        // and approval ones stay only in the audit_log.
        statusReason: to === "removed" ? reason : null,
      })
      .where(eq(tenant.id, tenantId));
    await tx.insert(auditLog).values({
      // The time right now, already holding the lock: the default now() is the
      // transaction's start, and concurrent changes would come out of order in
      // the history.
      at: sql`clock_timestamp()`,
      actorUserId: ctx.userId,
      action,
      tenantId,
      details: { from: current.status, ...(reason ? { reason } : {}) },
    });
    return "changed";
  });
}

// The reason is required: the project sees it on the dashboard.
export async function removeTenant(
  ctx: OperatorContext,
  tenantId: string,
  input: { reason: string },
): Promise<StatusChangeResult> {
  return changeStatus(
    ctx,
    tenantId,
    { to: "removed", from: ["active", "pending"], action: "tenant.removed" },
    cleanReason(input.reason, true),
  );
}

// The reason is optional and stays only in the audit_log; the project's dashboard goes back to normal.
export async function reactivateTenant(
  ctx: OperatorContext,
  tenantId: string,
  input: { reason?: string } = {},
): Promise<StatusChangeResult> {
  // Reactivating applies only to a removed tenant; `pending` is approved in approveTenant (#49).
  return changeStatus(
    ctx,
    tenantId,
    { to: "active", from: ["removed"], action: "tenant.reactivated" },
    cleanReason(input.reason, false),
  );
}

// Sign-up approval (#49, ADR 0007). Only applies to a `pending` tenant; from
// another status it returns "unchanged". Approving makes it `active` (ingestion
// starts accepting within 1 minute, through the views). Rejecting makes it
// `removed`, with the reason the project sees on the dashboard; the operator
// can still reactivate it later (D6). The approval reason is optional and
// stays only in the audit_log.
export async function approveTenant(
  ctx: OperatorContext,
  tenantId: string,
  input: { reason?: string } = {},
): Promise<StatusChangeResult> {
  return changeStatus(
    ctx,
    tenantId,
    { to: "active", from: ["pending"], action: "tenant.approved" },
    cleanReason(input.reason, false),
  );
}

export async function rejectTenant(
  ctx: OperatorContext,
  tenantId: string,
  input: { reason: string },
): Promise<StatusChangeResult> {
  return changeStatus(
    ctx,
    tenantId,
    { to: "removed", from: ["pending"], action: "tenant.rejected" },
    cleanReason(input.reason, true),
  );
}

// Erases the data of an already removed tenant (#154, an action separate from
// removal, as the E2 spec asks). Null when the tenant does not exist;
// "unchanged" when it is not yet `removed`: the dashboard only shows the form
// for a removed one.
export async function purgeRemovedTenant(
  ctx: OperatorContext,
  tenantId: string,
  input: { confirmSlug: string },
): Promise<StatusChangeResult> {
  if (!UUID_REGEX.test(tenantId)) return null;
  const [current] = await db
    .select({ status: tenant.status, slug: tenant.slug })
    .from(tenant)
    .where(eq(tenant.id, tenantId))
    .limit(1);
  if (!current) return null;
  if (current.status !== "removed") return "unchanged";
  // Confirmation typed in the form: the project slug, so as not to erase by
  // mistake (a mouse click is not enough).
  if (input.confirmSlug.trim() !== current.slug) {
    throw new TenantStatusError("invalid_confirm", "Type the project slug to confirm erasure.");
  }
  await purgeTenantData({
    tenantId,
    actorUserId: ctx.userId,
    statusReason: "Project data erased by operator.",
  });
  return "changed";
}

// Projects waiting for approval, from oldest to newest, with who created
// them. Only name, e-mail and date: nothing beyond what the detail already shows.
export async function listPendingTenants(ctx: OperatorContext) {
  void ctx;
  return db
    .select({
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      createdAt: tenant.createdAt,
      ownerEmail: user.email,
    })
    .from(tenant)
    .leftJoin(tenantMember, eq(tenantMember.tenantId, tenant.id))
    .leftJoin(user, eq(user.id, tenantMember.userId))
    .where(eq(tenant.status, "pending"))
    .orderBy(asc(tenant.createdAt));
}
