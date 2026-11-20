// Access contexts (#18): the tenant comes from the session and whoever has no access
// gets 404. The session is mocked; the rest runs against the DATABASE_URL Postgres.
import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTenantContext,
  requireOperatorContext,
  requireTenantContext,
} from "@/lib/access";
import { db, sql } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { tenant, tenantMember, user } from "@/lib/db/schema";

const DOMAIN = "@access-test.stellytics.invalid";
const SLUG = "access-test-";

// User of the mocked session; null simulates someone not signed in.
let sessionUser: { id: string; role: "tenant" | "operator" } | null = null;

vi.mock("@/lib/session", () => ({
  requireSession: async () => {
    if (!sessionUser) throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;/sign-in" });
    return { user: { ...sessionUser, name: "Test", email: "test@example.invalid" } };
  },
}));

const NOT_FOUND = { digest: expect.stringContaining("404") };

async function createUser(role: "tenant" | "operator" = "tenant") {
  const id = randomUUID();
  await db.insert(user).values({ id, name: "Test", email: `${id}${DOMAIN}`, role });
  return id;
}

async function createMember() {
  const userId = await createUser();
  const [created] = await db
    .insert(tenant)
    .values({ name: "Project", slug: `${SLUG}${randomUUID()}` })
    .returning();
  await db.insert(tenantMember).values({ tenantId: created!.id, userId, role: "owner" });
  return { userId, tenantId: created!.id };
}

async function cleanup() {
  const ids = (await db.select({ id: tenant.id }).from(tenant).where(like(tenant.slug, `${SLUG}%`))).map(
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

describe("tenant context", () => {
  it("comes from the session: the tenant of the signed-in member", async () => {
    const { userId, tenantId } = await createMember();
    sessionUser = { id: userId, role: "tenant" };

    const ctx = await requireTenantContext();
    expect(ctx).toMatchObject({ userId, tenantId, memberRole: "owner", tenantStatus: "active" });
  });

  it("without a session goes to sign-in", async () => {
    await expect(requireTenantContext()).rejects.toMatchObject({ digest: "NEXT_REDIRECT;/sign-in" });
  });

  it("operator gets 404 (D2)", async () => {
    sessionUser = { id: await createUser("operator"), role: "operator" };
    await expect(getTenantContext()).rejects.toMatchObject(NOT_FOUND);
    await expect(requireTenantContext()).rejects.toMatchObject(NOT_FOUND);
  });

  it("user without a project: null in getTenantContext and goes to create the project in requireTenantContext", async () => {
    sessionUser = { id: await createUser(), role: "tenant" };
    expect(await getTenantContext()).toBeNull();
    await expect(requireTenantContext()).rejects.toMatchObject({
      digest: expect.stringContaining("/onboarding"),
    });
  });
});

describe("operator context", () => {
  it("only for the operator role", async () => {
    const operatorId = await createUser("operator");
    sessionUser = { id: operatorId, role: "operator" };
    expect(await requireOperatorContext()).toEqual({ userId: operatorId });
  });

  it("tenant member gets 404", async () => {
    const { userId } = await createMember();
    sessionUser = { id: userId, role: "tenant" };
    await expect(requireOperatorContext()).rejects.toMatchObject(NOT_FOUND);
  });
});
