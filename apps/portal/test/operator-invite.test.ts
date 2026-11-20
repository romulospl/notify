// Operator invites (ADR 0017). The invite command is disabled while the portal
// has no /invite/<token> page: the script must refuse and send nothing. The
// library that accepts an invite, uninvite and list still work, so the tests
// write the invite row directly. Runs against the Postgres of DATABASE_URL,
// with an in-memory SMTP server.
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { verifyPassword } from "better-auth/crypto";
import { eq, inArray, like, sql as dsql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadOperatorInvite } from "@/lib/access";
import { acceptOperatorInvite, OperatorInviteError } from "@/lib/data/operator-invite";
import { db, sql } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { account, auditLog, operatorInvite, user } from "@/lib/db/schema";
import { asRole } from "./helpers/as-role";
import { startSmtpSink } from "./helpers/smtp-sink";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "operator.mjs");
const DOMAIN = "@invite-test.stellytics.invalid";
const PORTAL_URL = "https://portal.invite-test.invalid";
const PASSWORD = "invited-password-123";

let sink: Awaited<ReturnType<typeof startSmtpSink>>;

// Runs the admin script, writing `input` to its stdin (the interactive prompts).
function script(args: string[], { input = "", env = {} }: { input?: string; env?: Record<string, string> } = {}) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn("node", [SCRIPT, ...args], {
      env: { ...process.env, SMTP_URL: sink.url, PORTAL_URL, MAIL_FROM: "test <test@invalid>", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
    child.stdin.end(input);
  });
}

function invite(email: string, confirm = email, env?: Record<string, string>) {
  return script(["invite"], { input: `${email}\n${confirm}\n`, env });
}

// Writes a pending invite the way the command did: a random token of which
// only the SHA-256 is stored. A new invite to the same email replaces the old one.
async function invited(email: string) {
  const token = randomBytes(32).toString("base64url");
  await db.delete(operatorInvite).where(eq(operatorInvite.email, email));
  await db.insert(operatorInvite).values({
    email,
    tokenHash: createHash("sha256").update(token, "utf8").digest(),
    expiresAt: dsql`now() + interval '3 days'`,
  });
  return token;
}

function newEmail() {
  return `${randomUUID()}${DOMAIN}`;
}

async function cleanup() {
  await db.delete(operatorInvite).where(like(operatorInvite.email, `%${DOMAIN}`));
  await db.delete(user).where(like(user.email, `%${DOMAIN}`));
}

beforeAll(async () => {
  await runMigrations();
  sink = await startSmtpSink();
  await cleanup();
});

beforeEach(() => {
  sink.messages.length = 0;
});

afterEach(cleanup);

afterAll(async () => {
  await sink.close();
  await sql.end();
});

describe("operator:invite", () => {
  it("is disabled: refuses, sends no email and writes no invite", async () => {
    const email = newEmail();
    const result = await invite(email);
    expect(result.code).toBe(1);
    expect(result.out).toContain("Invites are disabled");
    expect(result.out).toContain("create");
    expect(sink.messages).toEqual([]);
    expect(await db.select().from(operatorInvite).where(eq(operatorInvite.email, email))).toEqual([]);
  });

  it("a new invite to the same email replaces the previous link", async () => {
    const email = newEmail();
    const first = await invited(email);
    const second = await invited(email);
    expect(await loadOperatorInvite(first)).toBeNull();
    expect(await loadOperatorInvite(second)).toMatchObject({ email });
  });

  it("uninvite deletes the pending invite and list shows operators and invites", async () => {
    const email = newEmail();
    const token = await invited(email);
    const listed = await script(["list"]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(email);

    expect((await script(["uninvite", "--email", email])).code).toBe(0);
    expect(await loadOperatorInvite(token)).toBeNull();
    expect((await script(["uninvite", "--email", email])).code).toBe(1);
  });
});

describe("loadOperatorInvite", () => {
  it("rejects malformed, unknown and expired tokens", async () => {
    expect(await loadOperatorInvite("short")).toBeNull();
    expect(await loadOperatorInvite("a".repeat(43))).toBeNull();

    const email = newEmail();
    const token = await invited(email);
    expect(await loadOperatorInvite(token)).toMatchObject({ email });
    await db
      .update(operatorInvite)
      .set({ expiresAt: dsql`now() - interval '1 second'` })
      .where(eq(operatorInvite.email, email));
    expect(await loadOperatorInvite(token)).toBeNull();
  });
});

describe("acceptOperatorInvite", () => {
  it("creates a verified operator with the chosen password and uses the invite once", async () => {
    const email = newEmail();
    const token = await invited(email);
    const ctx = (await loadOperatorInvite(token))!;

    const { userId } = await acceptOperatorInvite(ctx, { name: "  New Operator ", password: PASSWORD });
    const [created] = await db.select().from(user).where(eq(user.id, userId));
    expect(created).toMatchObject({ email, name: "New Operator", role: "operator", emailVerified: true });
    const [credential] = await db.select().from(account).where(eq(account.userId, userId));
    expect(credential!.providerId).toBe("credential");
    expect(await verifyPassword({ hash: credential!.password!, password: PASSWORD })).toBe(true);

    // The row is gone, so the link and the stored email are gone too.
    expect(await db.select().from(operatorInvite).where(eq(operatorInvite.email, email))).toEqual([]);
    expect(await loadOperatorInvite(token)).toBeNull();
    await expect(acceptOperatorInvite(ctx, { name: "Again", password: PASSWORD })).rejects.toMatchObject({
      code: "invite_gone",
    });

    const entries = (await db.select().from(auditLog).where(eq(auditLog.action, "operator.invite_accepted"))).filter(
      (a) => (a.details as { userId?: string }).userId === userId,
    );
    expect(entries).toMatchObject([{ actorUserId: userId }]);
  });

  it("refuses a short password and keeps the invite", async () => {
    const email = newEmail();
    const token = await invited(email);
    const ctx = (await loadOperatorInvite(token))!;
    await expect(acceptOperatorInvite(ctx, { name: "X", password: "short" })).rejects.toBeInstanceOf(
      OperatorInviteError,
    );
    expect(await loadOperatorInvite(token)).not.toBeNull();
  });

  it("refuses when an account with the email appeared after the invite", async () => {
    const email = newEmail();
    const token = await invited(email);
    const ctx = (await loadOperatorInvite(token))!;
    await db.insert(user).values({ id: randomUUID(), name: "T", email, emailVerified: false });
    await expect(acceptOperatorInvite(ctx, { name: "X", password: PASSWORD })).rejects.toMatchObject({
      code: "account_exists",
    });
    const operators = await db.select().from(user).where(inArray(user.email, [email]));
    expect(operators).toMatchObject([{ role: "tenant" }]);
  });

  it("two submissions of the same link create a single account", async () => {
    const email = newEmail();
    const ctx = (await loadOperatorInvite(await invited(email)))!;
    const results = await Promise.allSettled([
      acceptOperatorInvite(ctx, { name: "A", password: PASSWORD }),
      acceptOperatorInvite(ctx, { name: "B", password: PASSWORD }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(user).where(eq(user.email, email))).toHaveLength(1);
  });
});

describe("ingestion roles", () => {
  it.each(["stellytics_ingest", "stellytics_collector"] as const)("%s cannot read invites", async (role) => {
    await expect(asRole(role, "SELECT * FROM operator_invite")).rejects.toMatchObject({ code: "42501" });
  });
});
