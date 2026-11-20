// Self-service project sign-up (#17) against the DATABASE_URL Postgres.
// The session is mocked.
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requireOnboardingContext, requireTenantContext } from "@/lib/access";
import { createProject, getProject, ProjectError, slugify } from "@/lib/data/tenants";
import { db, sql } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { auditLog, tenant, tenantMember, user } from "@/lib/db/schema";

const DOMAIN = "@onboarding-test.stellytics.invalid";
// Every project in these tests has a name with this prefix, for the cleanup.
const NAME = "Onboarding Test";

let sessionUser: { id: string; role: "tenant" | "operator"; emailVerified: boolean } | null = null;

vi.mock("@/lib/session", () => ({
  requireSession: async () => {
    if (!sessionUser) throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;/sign-in" });
    return { user: { ...sessionUser, name: "Test", email: "test@example.invalid" } };
  },
}));

const NOT_FOUND = { digest: expect.stringContaining("404") };

async function createUser(role: "tenant" | "operator" = "tenant", emailVerified = true) {
  const id = randomUUID();
  await db.insert(user).values({ id, name: "Test", email: `${id}${DOMAIN}`, role, emailVerified });
  return id;
}

async function login(role: "tenant" | "operator" = "tenant", emailVerified = true) {
  const id = await createUser(role, emailVerified);
  sessionUser = { id, role, emailVerified };
  return id;
}

async function cleanup() {
  const ids = (await db.select({ id: tenant.id }).from(tenant).where(like(tenant.name, `${NAME}%`))).map(
    (t) => t.id,
  );
  if (ids.length > 0) {
    await db.delete(tenantMember).where(inArray(tenantMember.tenantId, ids));
    await db.delete(tenant).where(inArray(tenant.id, ids));
  }
  await db.delete(user).where(like(user.email, `%${DOMAIN}`));
}

beforeAll(async () => {
  await runMigrations();
  await cleanup();
});

beforeEach(() => {
  sessionUser = null;
});

afterAll(async () => {
  await cleanup();
  await sql.end();
});

describe("project slug", () => {
  it("becomes lowercase ASCII with hyphens", () => {
    expect(slugify("Soroban Explorer!")).toBe("soroban-explorer");
    expect(slugify("  Élan Zürich  ")).toBe("elan-zurich");
    expect(slugify("🚀🚀")).toBe("project");
    expect(slugify("a".repeat(60))).toHaveLength(40);
  });
});

describe("who can create a project", () => {
  it("member with a confirmed e-mail and without a project", async () => {
    const id = await login();
    expect(await requireOnboardingContext()).toEqual({ userId: id });
  });

  it("unconfirmed e-mail gets 404", async () => {
    await login("tenant", false);
    await expect(requireOnboardingContext()).rejects.toMatchObject(NOT_FOUND);
  });

  it("operator gets 404", async () => {
    await login("operator");
    await expect(requireOnboardingContext()).rejects.toMatchObject(NOT_FOUND);
  });

  it("whoever already has a project goes to the dashboard", async () => {
    await login();
    await createProject(await requireOnboardingContext(), { name: `${NAME} existing` });
    await expect(requireOnboardingContext()).rejects.toMatchObject({
      digest: expect.stringContaining("/dashboard"),
    });
  });
});

describe("project creation", () => {
  it("creates the active tenant with its creator as owner and records it in the audit_log", async () => {
    const userId = await login();
    const created = await createProject(await requireOnboardingContext(), { name: `  ${NAME} Alpha  ` });
    expect(created).toMatchObject({ name: `${NAME} Alpha`, slug: "onboarding-test-alpha" });

    const ctx = await requireTenantContext();
    expect(ctx).toMatchObject({ userId, tenantId: created.id, memberRole: "owner", tenantStatus: "active" });
    expect(await getProject(ctx)).toMatchObject({ name: `${NAME} Alpha`, status: "active" });

    const audit = await db.select().from(auditLog).where(eq(auditLog.tenantId, created.id));
    expect(audit).toMatchObject([{ action: "tenant.created", actorUserId: userId }]);
  });

  it("with SIGNUP_APPROVAL off (default or `false`) the tenant starts active, as always", async () => {
    for (const value of [undefined, "", "false", "0", "no"]) {
      if (value === undefined) delete process.env.SIGNUP_APPROVAL;
      else process.env.SIGNUP_APPROVAL = value;
      await login();
      const created = await createProject(await requireOnboardingContext(), { name: `${NAME} Off ${value ?? "unset"}` });
      expect(await requireTenantContext()).toMatchObject({ tenantId: created.id, tenantStatus: "active" });
      const [audit] = await db.select().from(auditLog).where(eq(auditLog.tenantId, created.id));
      expect(audit).toMatchObject({ action: "tenant.created", details: { status: "active" } });
    }
  });

  it("a name repeated by another user gets a slug with a suffix", async () => {
    await login();
    const first = await createProject(await requireOnboardingContext(), { name: `${NAME} Same` });
    await login();
    const second = await createProject(await requireOnboardingContext(), { name: `${NAME} Same` });
    expect(second.slug).not.toBe(first.slug);
    expect(second.slug).toMatch(/^onboarding-test-same-[0-9a-f]{6}$/);
  });

  it("rejects a name that is too short", async () => {
    await login();
    await expect(createProject(await requireOnboardingContext(), { name: " x " })).rejects.toBeInstanceOf(
      ProjectError,
    );
  });

  it("two requests at the same time create a single project (D1)", async () => {
    const userId = await login();
    const ctx = await requireOnboardingContext();
    const results = await Promise.allSettled([
      createProject(ctx, { name: `${NAME} Race A` }),
      createProject(ctx, { name: `${NAME} Race B` }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "already_member" });
    expect(await db.select().from(tenantMember).where(eq(tenantMember.userId, userId))).toHaveLength(1);
  });
});

describe("sign-up with approval (#49)", () => {
  afterEach(() => {
    delete process.env.SIGNUP_APPROVAL;
  });

  it("with SIGNUP_APPROVAL on the tenant starts pending, with owner and audit_log", async () => {
    for (const value of ["true", "1", " TRUE "]) {
      process.env.SIGNUP_APPROVAL = value;
      const userId = await login();
      const created = await createProject(await requireOnboardingContext(), { name: `${NAME} On ${value.trim()}` });
      expect(await getProject((await requireTenantContext({ allowPending: true })))).toMatchObject({
        name: `${NAME} On ${value.trim()}`,
        status: "pending",
      });
      expect(await db.select().from(tenantMember).where(eq(tenantMember.tenantId, created.id))).toMatchObject([
        { userId, role: "owner" },
      ]);
      const [audit] = await db.select().from(auditLog).where(eq(auditLog.tenantId, created.id));
      expect(audit).toMatchObject({ action: "tenant.created", actorUserId: userId, details: { status: "pending" } });
    }
  });

  it("a pending project only passes requireTenantContext with allowPending; the rest goes to /dashboard", async () => {
    process.env.SIGNUP_APPROVAL = "true";
    await login();
    await createProject(await requireOnboardingContext(), { name: `${NAME} Waiting` });
    await expect(requireTenantContext()).rejects.toMatchObject({ digest: expect.stringContaining("/dashboard") });
    expect(await requireTenantContext({ allowPending: true })).toMatchObject({ tenantStatus: "pending" });
  });
});
