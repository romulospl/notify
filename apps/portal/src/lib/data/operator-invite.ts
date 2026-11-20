import "server-only";
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import type { OperatorInviteContext } from "../access";
import { db } from "../db";
import { account, auditLog, operatorInvite, user } from "../db/schema";

// Accepting an operator invite (ADR 0017). The invite comes from
// scripts/operator.mjs; here the invited person only picks a name and a
// password. The account is created already verified, as an operator, the same
// way `operator:create` does.

export const NAME_MAX = 100;
export const PASSWORD_MIN = 12;
// Better Auth's default maximum; the sign-in rejects anything longer.
export const PASSWORD_MAX = 128;

export class OperatorInviteError extends Error {
  constructor(
    readonly code: "invalid_name" | "invalid_password" | "invite_gone" | "account_exists",
    message: string,
  ) {
    super(message);
  }
}

export async function acceptOperatorInvite(
  ctx: OperatorInviteContext,
  input: { name: string; password: string },
): Promise<{ userId: string }> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > NAME_MAX) {
    throw new OperatorInviteError("invalid_name", `Use a name with 1 to ${NAME_MAX} characters.`);
  }
  if (input.password.length < PASSWORD_MIN || input.password.length > PASSWORD_MAX) {
    throw new OperatorInviteError("invalid_password", `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`);
  }
  const hash = await hashPassword(input.password);
  const userId = randomUUID();

  await db.transaction(async (tx) => {
    // Locks the invite so two submissions of the same link create one account.
    const [invite] = await tx
      .select({ id: operatorInvite.id })
      .from(operatorInvite)
      .where(
        and(
          eq(operatorInvite.id, ctx.inviteId),
          gt(operatorInvite.expiresAt, sql`now()`),
        ),
      )
      .for("update");
    if (!invite) throw new OperatorInviteError("invite_gone", "This invite expired or was already used.");

    const [existing] = await tx.select({ id: user.id }).from(user).where(eq(user.email, ctx.email)).limit(1);
    if (existing) {
      throw new OperatorInviteError(
        "account_exists",
        "An account with this email already exists. Ask the person who invited you to promote it instead.",
      );
    }

    await tx.insert(user).values({ id: userId, name, email: ctx.email, emailVerified: true, role: "operator" });
    await tx
      .insert(account)
      .values({ id: randomUUID(), accountId: userId, providerId: "credential", userId, password: hash });
    // Used once: the row goes away, and with it the stored email.
    await tx.delete(operatorInvite).where(eq(operatorInvite.id, invite.id));
    await tx
      .insert(auditLog)
      .values({ actorUserId: userId, action: "operator.invite_accepted", details: { userId, inviteId: invite.id } });
  });

  return { userId };
}
