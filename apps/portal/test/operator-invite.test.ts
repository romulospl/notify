// Operator invites (ADR 0017): the admin script emails a 3-day, single-use
// link; the portal turns it into an operator account. Runs against the
// Postgres of DATABASE_URL, with an in-memory SMTP server.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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

// Decodes the quoted-printable body and takes the token from the link.
function tokenFrom(data: string): string {
  const body = data.replace(/=\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const match = new RegExp(`${PORTAL_URL}/invite/([A-Za-z0-9_-]{43})`).exec(body);
  if (!match) throw new Error("no invite link in the email");
  return match[1]!;
}

async function invited(email: string) {
  expect((await invite(email)).code).toBe(0);
  return tokenFrom(sink.messages.at(-1)!.data);
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
  it("asks the email twice, stores only the hash and emails a 3-day link", async () => {
    const email = newEmail();
    const result = await invite(email.toUpperCase(), email);
    expect(result.code).toBe(0);

    const [row] = await db.select().from(operatorInvite).where(eq(operatorInvite.email, email));
    expect(row).toBeDefined();
    const days = (row!.expiresAt.getTime() - row!.createdAt.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(3, 5);

    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0]!.to).toEqual([email]);
    const token = tokenFrom(sink.messages[0]!.data);
    // The token goes only to the email: never to the terminal or the database.
    expect(result.out).not.toContain(token);
    expect(row!.tokenHash.toString("hex")).not.toContain(Buffer.from(token).toString("hex"));

    const entries = (await db.select().from(auditLog).where(eq(auditLog.action, "operator.invited"))).filter(
      (a) => (a.details as { inviteId?: string }).inviteId === row!.id,
    );
    expect(entries).toMatchObject([{ actorUserId: null }]);
  });

  it("sends nothing when the two emails differ", async () => {
    const email = newEmail();
    const result = await invite(email, newEmail());
    expect(result.code).toBe(1);
    expect(result.out).toContain("don't match");
    expect(sink.messages).toEqual([]);
    expect(await db.select().from(operatorInvite).where(eq(operatorInvite.email, email))).toEqual([]);
  });

  it("refuses an email that already has an account", async () => {
    const existing = newEmail();
    await db.insert(user).values({ id: randomUUID(), name: "T", email: existing, emailVerified: true });
    const result = await invite(existing);
    expect(result.code).toBe(1);
    expect(result.out).toContain("operator:promote");
    expect(sink.messages).toEqual([]);
  });

  it("leaves no invite behind when the email cannot be sent", async () => {
    const email = newEmail();
    const result = await invite(email, email, { SMTP_URL: "smtp://127.0.0.1:1" });
    expect(result.code).toBe(1);
    expect(result.out).toContain("No invite was created");
    expect(await db.select().from(operatorInvite).where(eq(operatorInvite.email, email))).toEqual([]);
  });

  it("refuses to run without PORTAL_URL or BETTER_AUTH_URL", async () => {
    const result = await invite(newEmail(), undefined, { PORTAL_URL: "", BETTER_AUTH_URL: "" });
    expect(result.code).toBe(1);
    expect(result.out).toContain("PORTAL_URL");
  });

  it("falls back to BETTER_AUTH_URL, as inside the portal container", async () => {
    const email = newEmail();
    expect((await invite(email, email, { PORTAL_URL: "", BETTER_AUTH_URL: `${PORTAL_URL}/` })).code).toBe(0);
    expect(tokenFrom(sink.messages.at(-1)!.data)).toHaveLength(43);
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
