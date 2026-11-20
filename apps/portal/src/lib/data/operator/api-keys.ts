import "server-only";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import type { OperatorContext } from "../../access";
import { db } from "../../db";
import { auditLog, operatorApiKey } from "../../db/schema";
import { generateReadKey } from "../../read-key";

// SCF API keys to read the metrics (#48, ADR 0006). Only the operator calls
// this (OperatorContext). The authentication of the key itself, which creates
// the context, lives in src/lib/access.ts, like the login one.
//
// Any operator sees and revokes everyone's keys: it is a single team, and
// each action goes to the audit_log with who did it.

export const MAX_ACTIVE_READ_KEYS = 20;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What the screen shows of a key: never the hash or the key.
export type ReadKeySummary = {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  revokedAt: Date | null;
  lastUsedOn: string | null;
  createdByMe: boolean;
};

// The full key exists only in this value, returned once on creation.
export type CreatedReadKey = { key: string; summary: ReadKeySummary };

export class ReadKeyError extends Error {
  constructor(
    readonly code: "invalid_name" | "key_limit",
    message: string,
  ) {
    super(message);
    this.name = "ReadKeyError";
  }
}

const summaryColumns = {
  id: operatorApiKey.id,
  name: operatorApiKey.name,
  prefix: operatorApiKey.prefix,
  createdAt: operatorApiKey.createdAt,
  revokedAt: operatorApiKey.revokedAt,
  lastUsedOn: operatorApiKey.lastUsedOn,
  createdBy: operatorApiKey.createdBy,
};

type Row = { createdBy: string } & Omit<ReadKeySummary, "createdByMe">;

function toSummary(ctx: OperatorContext, { createdBy, ...rest }: Row): ReadKeySummary {
  return { ...rest, createdByMe: createdBy === ctx.userId };
}

export async function listReadKeys(ctx: OperatorContext): Promise<ReadKeySummary[]> {
  const rows = await db.select(summaryColumns).from(operatorApiKey).orderBy(desc(operatorApiKey.createdAt));
  return rows.map((r) => toSummary(ctx, r));
}

export async function createReadKey(ctx: OperatorContext, input: { name: string }): Promise<CreatedReadKey> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 100) {
    throw new ReadKeyError("invalid_name", "Name must have between 1 and 100 characters.");
  }
  return db.transaction(async (tx) => {
    // Locks creation (held until the end of the transaction): two requests at the same time do not go over the limit.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('operator_api_key'))`);
    const [{ active }] = (await tx
      .select({ active: count() })
      .from(operatorApiKey)
      .where(isNull(operatorApiKey.revokedAt))) as [{ active: number }];
    if (active >= MAX_ACTIVE_READ_KEYS) {
      throw new ReadKeyError(
        "key_limit",
        `At most ${MAX_ACTIVE_READ_KEYS} read keys can be active. Revoke one first.`,
      );
    }
    const { key, prefix, keyHash } = generateReadKey();
    const [created] = await tx
      .insert(operatorApiKey)
      .values({ name, prefix, keyHash, createdBy: ctx.userId })
      .returning(summaryColumns);
    await tx.insert(auditLog).values({
      actorUserId: ctx.userId,
      action: "operator_api_key.created",
      details: { keyId: created!.id, prefix, name },
    });
    return { key, summary: toSummary(ctx, created!) };
  });
}

// True: revoked now. False: it was already revoked. Null: it does not exist.
export async function revokeReadKey(ctx: OperatorContext, keyId: string): Promise<boolean | null> {
  if (!UUID_REGEX.test(keyId)) return null;
  return db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(operatorApiKey)
      .set({ revokedAt: new Date() })
      .where(and(eq(operatorApiKey.id, keyId), isNull(operatorApiKey.revokedAt)))
      .returning({ prefix: operatorApiKey.prefix, name: operatorApiKey.name });
    if (!revoked) {
      const [exists] = await tx.select({ id: operatorApiKey.id }).from(operatorApiKey).where(eq(operatorApiKey.id, keyId));
      return exists ? false : null;
    }
    await tx.insert(auditLog).values({
      actorUserId: ctx.userId,
      action: "operator_api_key.revoked",
      details: { keyId, prefix: revoked.prefix, name: revoked.name },
    });
    return true;
  });
}
