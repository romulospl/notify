import "server-only";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { OnboardingContext, TenantContext } from "../access";
import { db } from "../db";
import { env } from "../env";
import { auditLog, tenant, tenantMember } from "../db/schema";

// Project creation in the self-service sign-up (#17, E2 spec, section 7):
// the tenant starts as `active` and whoever created it becomes `owner`, in the
// same transaction. With SIGNUP_APPROVAL on (#49, ADR 0007) it starts as
// `pending` until an operator approves it.

export class ProjectError extends Error {
  constructor(
    readonly code: "invalid_name" | "already_member",
    message: string,
  ) {
    super(message);
    this.name = "ProjectError";
  }
}

// "Soroban Explorer!" -> "soroban-explorer". ASCII only, up to 40 characters.
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "project";
}

function constraintOf(error: unknown): string | undefined {
  // Drizzle wraps the Postgres error in `cause`.
  return (error as { cause?: { constraint_name?: string } }).cause?.constraint_name;
}

export async function createProject(
  ctx: OnboardingContext,
  input: { name: string },
): Promise<{ id: string; name: string; slug: string }> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 100) {
    throw new ProjectError("invalid_name", "Project name must have between 2 and 100 characters.");
  }
  const base = slugify(name);
  const status = env.signupApproval ? "pending" : "active";

  // Repeated slug: tries again with a random suffix.
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base.slice(0, 33)}-${randomBytes(3).toString("hex")}`;
    try {
      return await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(tenant)
          .values({ name, slug, status })
          .returning({ id: tenant.id, name: tenant.name, slug: tenant.slug });
        await tx.insert(tenantMember).values({ tenantId: created!.id, userId: ctx.userId, role: "owner" });
        await tx.insert(auditLog).values({
          actorUserId: ctx.userId,
          action: "tenant.created",
          tenantId: created!.id,
          details: { slug, status },
        });
        return created!;
      });
    } catch (error) {
      const constraint = constraintOf(error);
      if (constraint === "tenant_slug_unique") continue;
      // D1: two requests at the same time from the same user; the unique index decides.
      if (constraint === "tenant_member_user_id_key") {
        throw new ProjectError("already_member", "You already have a project.");
      }
      throw error;
    }
  }
  throw new Error("Could not find a free project slug");
}

// Project of the context's tenant, for the dashboard.
export async function getProject(ctx: TenantContext) {
  const [found] = await db
    .select({ name: tenant.name, slug: tenant.slug, status: tenant.status, statusReason: tenant.statusReason })
    .from(tenant)
    .where(eq(tenant.id, ctx.tenantId));
  return found!;
}
