import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { db } from "./db";
import { operatorApiKey, operatorInvite, tenant, tenantMember, user } from "./db/schema";
import { env } from "./env";
import { READ_KEY_PATTERN, readKeyFromHeader } from "./read-key";
import { requireSession } from "./session";

// Access contexts from the E2 spec, section 4 (ADR 0003). The tenant always
// comes from the session, never from a value sent by the client.
//
// The types are branded: outside this file nobody can build a context by
// hand, so the functions in src/lib/data/ and src/lib/umami/ only take
// contexts created here, from the session. Together with the lint rule
// (eslint.config.mjs), this makes data/ and umami/ the single layer.
//
// Whoever has no access gets 404, never 403, so as not to reveal that the
// resource or the area exists.

declare const tenantContextBrand: unique symbol;
declare const operatorContextBrand: unique symbol;

export type TenantContext = {
  readonly userId: string;
  readonly tenantId: string;
  readonly memberRole: "owner" | "member";
  readonly tenantStatus: "active" | "removed" | "pending";
  readonly [tenantContextBrand]: true;
};

export type OperatorContext = {
  readonly userId: string;
  readonly [operatorContextBrand]: true;
};

// Context of the public demo (/demo and /demo/operator): no session, fixed on
// the one tenant named by DEMO_TENANT_SLUG. It carries no user and is not a
// TenantContext or an OperatorContext, so only the read functions that accept
// TenantReadContext or DemoContext take it: nothing that writes, and nothing
// that reads across tenants, type-checks with it.
declare const demoContextBrand: unique symbol;

export type DemoContext = {
  readonly tenantId: string;
  readonly name: string;
  readonly slug: string;
  readonly [demoContextBrand]: true;
};

// What the tenant read functions need: a tenant that did not come from the client.
export type TenantReadContext = TenantContext | DemoContext;

// Null when the demo is off (no DEMO_TENANT_SLUG) or the tenant does not exist
// or is not active. The slug comes from the server environment, never from
// the request.
export async function loadDemoContext(): Promise<DemoContext | null> {
  const slug = env.demoTenantSlug;
  if (!slug) return null;
  const [row] = await db
    .select({ tenantId: tenant.id, name: tenant.name, slug: tenant.slug })
    .from(tenant)
    .where(and(eq(tenant.slug, slug), eq(tenant.status, "active")))
    .limit(1);
  return row ? (row as DemoContext) : null;
}

export async function requireDemoContext(): Promise<DemoContext> {
  const ctx = await loadDemoContext();
  if (!ctx) notFound();
  return ctx;
}

// Loads the user's tenant (D1: at most one). Null for someone who is not a
// member. Does not check the role: use getTenantContext() or requireTenantContext().
export async function loadTenantContext(userId: string): Promise<TenantContext | null> {
  const [row] = await db
    .select({ tenantId: tenantMember.tenantId, memberRole: tenantMember.role, tenantStatus: tenant.status })
    .from(tenantMember)
    .innerJoin(tenant, eq(tenant.id, tenantMember.tenantId))
    .where(eq(tenantMember.userId, userId))
    .limit(1);
  if (!row) return null;
  return { userId, ...row } as TenantContext;
}

// Tenant context of whoever is in the session, or null for someone who has no
// project yet. With no session it goes to the login; an operator gets 404 (D2:
// an operator is not a tenant member).
export async function getTenantContext(): Promise<TenantContext | null> {
  const session = await requireSession();
  if (session.user.role === "operator") notFound();
  return loadTenantContext(session.user.id);
}

// Whoever has no project yet goes to project creation (#17). A `pending`
// project (sign-up with approval, #49) only sees the waiting screen at
// /dashboard, which asks for `allowPending`; any other tenant page or action
// redirects there, so none of them reaches the data layer.
export async function requireTenantContext(options: { allowPending?: boolean } = {}): Promise<TenantContext> {
  const ctx = await getTenantContext();
  if (!ctx) redirect("/onboarding");
  if (ctx.tenantStatus === "pending" && !options.allowPending) redirect("/dashboard");
  return ctx;
}

// Who can create a project (#17): a member with a confirmed e-mail and no
// tenant yet (D1: one tenant per user). Whoever already has a project goes to
// the dashboard.
declare const onboardingContextBrand: unique symbol;

export type OnboardingContext = {
  readonly userId: string;
  readonly [onboardingContextBrand]: true;
};

export async function requireOnboardingContext(): Promise<OnboardingContext> {
  const session = await requireSession();
  if (session.user.role === "operator") notFound();
  // The login already requires a confirmed e-mail (#60); checking again here
  // guarantees that an unconfirmed account never creates a project.
  if (!session.user.emailVerified) notFound();
  if (await loadTenantContext(session.user.id)) redirect("/dashboard");
  return { userId: session.user.id } as OnboardingContext;
}

export async function requireOperatorContext(): Promise<OperatorContext> {
  const session = await requireSession();
  if (session.user.role !== "operator") notFound();
  return { userId: session.user.id } as OperatorContext;
}

// Context of whoever calls the read API with an SCF key (#48, ADR 0006).
// It is an OperatorContext (the same data/operator/ functions apply), plus the
// key ID, used in the request limit. `userId` is who created the key.
export type OperatorKeyContext = OperatorContext & { readonly keyId: string };

// Authenticates `Authorization: Bearer nrk_...`. Null for any failure (no
// header, wrong format, unknown prefix, wrong secret, key revoked or created
// by someone who is no longer an operator); the caller answers the same 401
// in every case. Only the read key is valid: the ingest key (`ntf_`) does not
// get past the format. The full key never goes to a log or an error.
export async function authenticateReadKey(authorization: string | null): Promise<OperatorKeyContext | null> {
  const key = readKeyFromHeader(authorization);
  const parsed = key ? READ_KEY_PATTERN.exec(key) : null;
  if (!key || !parsed) return null;
  const [row] = await db
    .select({
      id: operatorApiKey.id,
      keyHash: operatorApiKey.keyHash,
      createdBy: operatorApiKey.createdBy,
      lastUsedOn: operatorApiKey.lastUsedOn,
    })
    .from(operatorApiKey)
    .innerJoin(user, eq(user.id, operatorApiKey.createdBy))
    .where(and(eq(operatorApiKey.prefix, parsed[1]!), isNull(operatorApiKey.revokedAt), eq(user.role, "operator")))
    .limit(1);
  if (!row) return null;
  const given = createHash("sha256").update(key, "utf8").digest();
  if (!timingSafeEqual(given, row.keyHash)) return null;
  // At most one write per day and key.
  const today = new Date().toISOString().slice(0, 10);
  if (row.lastUsedOn !== today) {
    // Best effort: failing to record the last use must not take down a valid
    // key. The log carries only the error name.
    try {
      await db
        .update(operatorApiKey)
        .set({ lastUsedOn: sql`${today}::date` })
        .where(eq(operatorApiKey.id, row.id));
    } catch (error) {
      console.error("Failed to record the last use of the read key", (error as Error).name);
    }
  }
  return { userId: row.createdBy, keyId: row.id } as OperatorKeyContext;
}

// Context of someone holding an operator invite link (ADR 0017). The token in
// the link is the credential: there is no session yet. Only acceptOperatorInvite
// (src/lib/data/operator-invite.ts) takes it.
declare const operatorInviteContextBrand: unique symbol;

export type OperatorInviteContext = {
  readonly inviteId: string;
  readonly email: string;
  readonly expiresAt: Date;
  readonly [operatorInviteContextBrand]: true;
};

// 32 random bytes in base64url, as created by scripts/operator.mjs.
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Null for any failure (bad format, unknown token, already used, revoked or
// expired: a used or revoked invite no longer has a row); the page shows the same message in every case.
export async function loadOperatorInvite(token: string): Promise<OperatorInviteContext | null> {
  if (!INVITE_TOKEN_PATTERN.test(token)) return null;
  const tokenHash = createHash("sha256").update(token, "utf8").digest();
  const [row] = await db
    .select({ inviteId: operatorInvite.id, email: operatorInvite.email, expiresAt: operatorInvite.expiresAt })
    .from(operatorInvite)
    .where(
      and(
        eq(operatorInvite.tokenHash, tokenHash),
        gt(operatorInvite.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  return row ? (row as OperatorInviteContext) : null;
}
