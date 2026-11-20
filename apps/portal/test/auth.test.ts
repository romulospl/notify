// Integration test of sign-in against a real Postgres (DATABASE_URL).
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { account, session, user } from "@/lib/db/schema";

const DOMAIN = "@auth-test.stellytics.invalid";
const PASSWORD = "correct-horse-battery-staple";
const BASE = "http://localhost:3000/api/auth";

async function createUser(email: string, role: "tenant" | "operator" = "tenant") {
  const id = randomUUID();
  await db.insert(user).values({ id, name: "Test", email, emailVerified: true, role });
  await db.insert(account).values({
    id: randomUUID(),
    accountId: id,
    providerId: "credential",
    userId: id,
    password: await hashPassword(PASSWORD),
  });
  return id;
}

// Each call uses a different IP so it does not hit the attempt limit.
function post(path: string, body: unknown, cookie?: string) {
  return auth.handler(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

function sessionCookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function getSession(cookie: string) {
  return auth.api.getSession({ headers: new Headers({ cookie }) });
}

beforeAll(async () => {
  await runMigrations();
  await db.delete(user).where(like(user.email, `%${DOMAIN}`));
});

afterAll(async () => {
  await db.delete(user).where(like(user.email, `%${DOMAIN}`));
  await sql.end();
});

describe("sign-in by e-mail and password", () => {
  it("signs in with the right password and creates the session without storing the IP", async () => {
    const email = `tenant${DOMAIN}`;
    const userId = await createUser(email);

    const response = await post("/sign-in/email", { email, password: PASSWORD });
    expect(response.status).toBe(200);

    const current = await getSession(sessionCookie(response));
    expect(current?.user.email).toBe(email);
    expect(current?.user.role).toBe("tenant");

    const rows = await db.select().from(session).where(eq(session.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ipAddress).toBeNull();
  });

  it("rejects a wrong password", async () => {
    const email = `wrong${DOMAIN}`;
    await createUser(email);

    const response = await post("/sign-in/email", { email, password: "not-the-password" });
    expect(response.status).toBe(401);
  });

  it("returns the operator role", async () => {
    const email = `operator${DOMAIN}`;
    await createUser(email, "operator");

    const response = await post("/sign-in/email", { email, password: PASSWORD });
    const current = await getSession(sessionCookie(response));
    expect(current?.user.role).toBe("operator");
  });

  it("signing out invalidates the session", async () => {
    const email = `signout${DOMAIN}`;
    await createUser(email);

    const cookie = sessionCookie(await post("/sign-in/email", { email, password: PASSWORD }));
    expect(await getSession(cookie)).not.toBeNull();

    const response = await post("/sign-out", {}, cookie);
    expect(response.status).toBe(200);
    expect(await getSession(cookie)).toBeNull();
  });

  // Sign-up has been open since #60 (full flow in email-flows.test.ts),
  // but the role never comes from the client.
  it("sign-up does not let you pick the operator role", async () => {
    const response = await post("/sign-up/email", {
      email: `signup${DOMAIN}`,
      password: PASSWORD,
      name: "Intruder",
      role: "operator",
    });
    const [created] = await db.select().from(user).where(eq(user.email, `signup${DOMAIN}`));
    // Better Auth rejects the field or creates the account as tenant; never as operator.
    if (created) expect(created.role).toBe("tenant");
    else expect(response.ok).toBe(false);
  });
});
