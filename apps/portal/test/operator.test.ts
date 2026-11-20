// SCF operator (#19): rule D2 in the database, admin command, development
// seed and global view, against the DATABASE_URL Postgres.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OperatorContext } from "@/lib/access";
import {
  approveTenant,
  getTenantDetail,
  listPendingTenants,
  listTenants,
  rejectTenant,
  REASON_MAX,
  reactivateTenant,
  removeTenant,
  TenantStatusError,
} from "@/lib/data/operator/tenants";
import { db, sql } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { apiService, auditLog, ingestKey, session, tenant, tenantMember, user } from "@/lib/db/schema";

const run = promisify(execFile);
const SCRIPTS = path.join(import.meta.dirname, "..", "scripts");
const DOMAIN = "@operator-test.stellytics.invalid";
const SLUG = "operator-test-";
const PASSWORD = "operator-password-123";
// Only the test builds the context by hand; in the portal it comes from requireOperatorContext().
// The userId is filled in beforeAll with a real operator, because
// tenant.status_changed_by points to user.id.
let operator = { userId: "test-operator" } as OperatorContext;

// Runs a portal script with the test database and without Umami.
async function script(name: string, args: string[], env: Record<string, string> = {}) {
  const base = { ...process.env };
  delete base.UMAMI_API_KEY;
  try {
    const { stdout, stderr } = await run("node", [path.join(SCRIPTS, name), ...args], {
      env: { ...base, ...env },
    });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, out: e.stdout + e.stderr };
  }
}

async function createUser(role: "tenant" | "operator" = "tenant") {
  const id = randomUUID();
  const email = `${id}${DOMAIN}`;
  await db.insert(user).values({ id, name: "Test", email, emailVerified: true, role });
  return { id, email };
}

async function createTenant(status: "active" | "removed" | "pending" = "active") {
  const [created] = await db
    .insert(tenant)
    .values({ name: "Operator test", slug: `${SLUG}${randomUUID()}`, status })
    .returning();
  return created!;
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
  operator = { userId: (await createUser("operator")).id } as OperatorContext;
});

afterAll(async () => {
  await cleanup();
  await sql.end();
});

describe("an operator is not a tenant member (D2) in the database", () => {
  it("refuses to put an operator in a tenant", async () => {
    const op = await createUser("operator");
    const t = await createTenant();
    await expect(db.insert(tenantMember).values({ tenantId: t.id, userId: op.id })).rejects.toMatchObject({
      cause: { message: expect.stringContaining("D2") },
    });
  });

  it("refuses to promote a tenant member to operator", async () => {
    const member = await createUser();
    const t = await createTenant();
    await db.insert(tenantMember).values({ tenantId: t.id, userId: member.id, role: "owner" });
    await expect(db.update(user).set({ role: "operator" }).where(eq(user.id, member.id))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("D2") },
    });
  });
});

describe("admin command", () => {
  it("create creates an operator with a confirmed e-mail, without a tenant, and records it in the audit_log", async () => {
    const email = `new-op${DOMAIN}`;
    const result = await script("operator.mjs", ["create", "--email", email, "--name", "SCF"], {
      OPERATOR_PASSWORD: PASSWORD,
    });
    expect(result).toMatchObject({ code: 0 });
    expect(result.out).not.toContain(PASSWORD);

    const [created] = await db.select().from(user).where(eq(user.email, email));
    expect(created).toMatchObject({ role: "operator", emailVerified: true });
    expect(await db.select().from(tenantMember).where(eq(tenantMember.userId, created!.id))).toEqual([]);
    const entries = (await db.select().from(auditLog).where(eq(auditLog.action, "operator.created"))).filter(
      (a) => (a.details as { userId?: string }).userId === created!.id,
    );
    // Null actor: the action came from the admin command.
    expect(entries).toMatchObject([{ actorUserId: null }]);
  });

  it("create rejects a short password", async () => {
    const result = await script("operator.mjs", ["create", "--email", `short${DOMAIN}`, "--name", "X"], {
      OPERATOR_PASSWORD: "short",
    });
    expect(result.code).toBe(1);
    expect(await db.select().from(user).where(eq(user.email, `short${DOMAIN}`))).toEqual([]);
  });

  it("promote and demote change the role, record it and end the sessions", async () => {
    const target = await createUser();
    await db.insert(session).values({
      id: randomUUID(),
      token: randomUUID(),
      userId: target.id,
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect((await script("operator.mjs", ["promote", "--email", target.email])).code).toBe(0);
    let [row] = await db.select().from(user).where(eq(user.id, target.id));
    expect(row!.role).toBe("operator");
    expect(await db.select().from(session).where(eq(session.userId, target.id))).toEqual([]);

    expect((await script("operator.mjs", ["demote", "--email", target.email])).code).toBe(0);
    [row] = await db.select().from(user).where(eq(user.id, target.id));
    expect(row!.role).toBe("tenant");

    const actions = (await db.select().from(auditLog))
      .filter((a) => (a.details as { userId?: string }).userId === target.id)
      .map((a) => a.action);
    expect(actions).toEqual(["operator.promoted", "operator.demoted"]);
  });

  it("promote refuses a tenant member and changes nothing", async () => {
    const member = await createUser();
    const t = await createTenant();
    await db.insert(tenantMember).values({ tenantId: t.id, userId: member.id, role: "owner" });

    const result = await script("operator.mjs", ["promote", "--email", member.email]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("D2");
    const [row] = await db.select().from(user).where(eq(user.id, member.id));
    expect(row!.role).toBe("tenant");
  });

  it("regular user sign-up does not create an operator", async () => {
    const email = `plain${DOMAIN}`;
    const result = await script("create-user.mjs", ["--email", email, "--name", "X", "--role", "operator"], {
      PORTAL_USER_PASSWORD: PASSWORD,
    });
    // The --role option no longer exists: the script rejects the argument.
    expect(result.code).not.toBe(0);
    expect(await db.select().from(user).where(eq(user.email, email))).toEqual([]);
  });
});

describe("development seed", () => {
  it("creates 2 projects and 1 operator, and can run again", async () => {
    const env = { SEED_PASSWORD: PASSWORD };
    expect((await script("seed.mjs", [], env)).code).toBe(0);
    const again = await script("seed.mjs", [], env);
    expect(again.code).toBe(0);
    expect(again.out).toContain("already existed");

    const seeded = await db.select().from(tenant).where(inArray(tenant.slug, ["seed-project-a", "seed-project-b"]));
    expect(seeded).toHaveLength(2);
    for (const t of seeded) {
      const members = await db.select().from(tenantMember).where(eq(tenantMember.tenantId, t.id));
      expect(members).toMatchObject([{ role: "owner" }]);
      expect(await db.select().from(ingestKey).where(eq(ingestKey.tenantId, t.id))).toHaveLength(1);
    }
    const [op] = await db.select().from(user).where(eq(user.email, "operator@seed.stellytics.localhost"));
    expect(op).toMatchObject({ role: "operator", emailVerified: true });
    expect(await db.select().from(tenantMember).where(eq(tenantMember.userId, op!.id))).toEqual([]);
  });
});

describe("operator's global view", () => {
  it("lists all tenants, including removed ones, with the counts", async () => {
    const active = await createTenant();
    const removed = await createTenant("removed");
    const owner = await createUser();
    await db.insert(tenantMember).values({ tenantId: active.id, userId: owner.id, role: "owner" });
    const [service] = await db.insert(apiService).values({ tenantId: active.id, name: "api" }).returning();
    await db.insert(ingestKey).values({
      apiServiceId: service!.id,
      tenantId: active.id,
      prefix: "opertest",
      keyHash: Buffer.alloc(32, 1),
      createdBy: owner.id,
    });

    const all = await listTenants(operator);
    expect(all.find((t) => t.id === active.id)).toMatchObject({
      status: "active",
      members: 1,
      sites: 0,
      services: 1,
      activeKeys: 1,
    });
    expect(all.find((t) => t.id === removed.id)).toMatchObject({ status: "removed", members: 0 });
  });

  it("details the tenant without exposing the hash of the keys", async () => {
    const t = await createTenant();
    const owner = await createUser();
    await db.insert(tenantMember).values({ tenantId: t.id, userId: owner.id, role: "owner" });
    const [service] = await db.insert(apiService).values({ tenantId: t.id, name: "detail-api" }).returning();
    await db.insert(ingestKey).values({
      apiServiceId: service!.id,
      tenantId: t.id,
      prefix: "detailkk",
      keyHash: Buffer.alloc(32, 2),
      createdBy: owner.id,
    });

    const detail = await getTenantDetail(operator, t.id);
    expect(detail!.members).toMatchObject([{ email: owner.email, role: "owner" }]);
    expect(detail!.services).toMatchObject([{ name: "detail-api", keys: [{ prefix: "detailkk" }] }]);
    expect(Object.keys(detail!.services[0]!.keys[0]!).sort()).toEqual([
      "createdAt",
      "lastUsedOn",
      "prefix",
      "revokedAt",
    ]);
    expect(await getTenantDetail(operator, randomUUID())).toBeNull();
    expect(await getTenantDetail(operator, "not-a-uuid")).toBeNull();
  });
});

describe("project removal and reactivation (#20)", () => {
  async function auditOf(tenantId: string) {
    return db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId)).orderBy(auditLog.at);
  }

  it("removing stores status, who, when and reason, and records it in the audit_log", async () => {
    const t = await createTenant();
    const before = Date.now();

    expect(await removeTenant(operator, t.id, { reason: "  Not a Stellar project  " })).toBe("changed");

    const [row] = await db.select().from(tenant).where(eq(tenant.id, t.id));
    expect(row).toMatchObject({
      status: "removed",
      statusChangedBy: operator.userId,
      statusReason: "Not a Stellar project",
    });
    expect(row!.statusChangedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await auditOf(t.id)).toMatchObject([
      {
        action: "tenant.removed",
        actorUserId: operator.userId,
        details: { from: "active", reason: "Not a Stellar project" },
      },
    ]);
  });

  it("removing requires a reason and limits its length, without storing anything", async () => {
    const t = await createTenant();
    for (const reason of ["", "  ", "no", "x".repeat(REASON_MAX + 1)]) {
      await expect(removeTenant(operator, t.id, { reason })).rejects.toBeInstanceOf(TenantStatusError);
    }
    const [row] = await db.select().from(tenant).where(eq(tenant.id, t.id));
    expect(row!.status).toBe("active");
    expect(await auditOf(t.id)).toEqual([]);
  });

  it("removing again changes nothing and does not duplicate the record, even with simultaneous requests", async () => {
    const t = await createTenant();
    const results = await Promise.all([
      removeTenant(operator, t.id, { reason: "first" }),
      removeTenant(operator, t.id, { reason: "second" }),
    ]);
    expect(results.sort()).toEqual(["changed", "unchanged"]);
    expect(await removeTenant(operator, t.id, { reason: "third" })).toBe("unchanged");
    expect(await auditOf(t.id)).toHaveLength(1);
  });

  it("reactivating goes back to active, clears the reason and records the note (D6)", async () => {
    const t = await createTenant();
    await removeTenant(operator, t.id, { reason: "Spam" });

    expect(await reactivateTenant(operator, t.id, { reason: "Removed by mistake" })).toBe("changed");

    const [row] = await db.select().from(tenant).where(eq(tenant.id, t.id));
    expect(row).toMatchObject({ status: "active", statusReason: null, statusChangedBy: operator.userId });
    expect((await auditOf(t.id)).map((a) => [a.action, a.details])).toEqual([
      ["tenant.removed", { from: "active", reason: "Spam" }],
      ["tenant.reactivated", { from: "removed", reason: "Removed by mistake" }],
    ]);
    // Without a note works too.
    await removeTenant(operator, t.id, { reason: "Spam again" });
    expect(await reactivateTenant(operator, t.id)).toBe("changed");
  });

  it("reactivating only works for a removed project", async () => {
    const active = await createTenant();
    expect(await reactivateTenant(operator, active.id)).toBe("unchanged");
    const [pending] = await db
      .insert(tenant)
      .values({ name: "Pending", slug: `${SLUG}${randomUUID()}`, status: "pending" })
      .returning();
    expect(await reactivateTenant(operator, pending!.id)).toBe("unchanged");
    expect(await auditOf(active.id)).toEqual([]);
    expect(await auditOf(pending!.id)).toEqual([]);
  });

  it("approving only works for a pending project: it becomes active and records who, when and the note (#49)", async () => {
    const t = await createTenant("pending");
    expect(await listPendingTenants(operator)).toEqual(expect.arrayContaining([expect.objectContaining({ id: t.id })]));

    expect(await approveTenant(operator, t.id, { reason: "Known Stellar team" })).toBe("changed");

    const [row] = await db.select().from(tenant).where(eq(tenant.id, t.id));
    expect(row).toMatchObject({ status: "active", statusReason: null, statusChangedBy: operator.userId });
    expect((await auditOf(t.id)).map((a) => [a.action, a.actorUserId, a.details])).toEqual([
      ["tenant.approved", operator.userId, { from: "pending", reason: "Known Stellar team" }],
    ]);
    expect((await listPendingTenants(operator)).map((p) => p.id)).not.toContain(t.id);
    // Approving again, or a project that is not pending, stores nothing.
    expect(await approveTenant(operator, t.id)).toBe("unchanged");
    const removed = await createTenant("removed");
    expect(await approveTenant(operator, removed.id)).toBe("unchanged");
    expect(await auditOf(removed.id)).toEqual([]);
  });

  it("rejecting requires a reason, becomes removed with the reason and can be reactivated (#49)", async () => {
    const t = await createTenant("pending");
    await expect(rejectTenant(operator, t.id, { reason: " " })).rejects.toBeInstanceOf(TenantStatusError);
    await expect(rejectTenant(operator, t.id, { reason: "x".repeat(REASON_MAX + 1) })).rejects.toBeInstanceOf(
      TenantStatusError,
    );
    expect((await db.select().from(tenant).where(eq(tenant.id, t.id)))[0]!.status).toBe("pending");

    expect(await rejectTenant(operator, t.id, { reason: "Not a Stellar project" })).toBe("changed");
    const [row] = await db.select().from(tenant).where(eq(tenant.id, t.id));
    expect(row).toMatchObject({
      status: "removed",
      statusReason: "Not a Stellar project",
      statusChangedBy: operator.userId,
    });
    expect((await auditOf(t.id)).map((a) => [a.action, a.actorUserId, a.details])).toEqual([
      ["tenant.rejected", operator.userId, { from: "pending", reason: "Not a Stellar project" }],
    ]);
    // Rejecting an active project does not work; reactivating the rejected one does (D6).
    const active = await createTenant();
    expect(await rejectTenant(operator, active.id, { reason: "Spam" })).toBe("unchanged");
    expect(await reactivateTenant(operator, t.id)).toBe("changed");
  });

  it("approve and reject: a nonexistent or invalid ID returns null", async () => {
    expect(await approveTenant(operator, randomUUID())).toBeNull();
    expect(await approveTenant(operator, "not-a-uuid")).toBeNull();
    expect(await rejectTenant(operator, randomUUID(), { reason: "Spam" })).toBeNull();
  });

  it("a nonexistent project or invalid ID returns null", async () => {
    expect(await removeTenant(operator, randomUUID(), { reason: "Spam" })).toBeNull();
    expect(await removeTenant(operator, "not-a-uuid", { reason: "Spam" })).toBeNull();
    expect(await reactivateTenant(operator, randomUUID())).toBeNull();
  });

  it("the detail shows who changed the status and the history, newest to oldest", async () => {
    const t = await createTenant();
    await removeTenant(operator, t.id, { reason: "Spam" });
    await reactivateTenant(operator, t.id, { reason: "Appeal accepted" });
    await removeTenant(operator, t.id, { reason: "Spam again" });

    const [op] = await db.select().from(user).where(eq(user.id, operator.userId));
    const detail = await getTenantDetail(operator, t.id);
    expect(detail!.tenant).toMatchObject({ status: "removed", statusChangedBy: op!.email, statusReason: "Spam again" });
    expect(detail!.statusHistory).toMatchObject([
      { action: "tenant.removed", actor: op!.email, reason: "Spam again" },
      { action: "tenant.reactivated", actor: op!.email, reason: "Appeal accepted" },
      { action: "tenant.removed", actor: op!.email, reason: "Spam" },
    ]);
  });
});
