// Sign-up with e-mail confirmation, password reset and attempt limit (#60),
// through the Better Auth handler against the DATABASE_URL Postgres.
// E-mail sending is mocked: the messages are kept in `sent`.
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { session, user, verification } from "@/lib/db/schema";

const sent: { to: string; subject: string; text: string }[] = [];

vi.mock("@/lib/mail", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/mail")>();
  return {
    ...original,
    sendMail: async (message: { to: string; subject: string; text: string }) => {
      sent.push(message);
    },
  };
});

const DOMAIN = "@email-test.stellytics.invalid";
const PASSWORD = "first-password-123";
const NEW_PASSWORD = "second-password-456";
const BASE = "http://localhost:3000/api/auth";

// Each test uses its own IPs, so the attempt limits do not mix.
let ipCounter = 0;
function nextIp() {
  ipCounter++;
  return `203.0.113.${ipCounter}`;
}

function call(path: string, { body, cookie, ip = nextIp(), method = "POST" }: {
  body?: unknown;
  cookie?: string;
  ip?: string;
  method?: string;
} = {}) {
  return auth.handler(
    new Request(path.startsWith("http") ? path : `${BASE}${path}`, {
      method,
      headers: {
        origin: "http://localhost:3000",
        "x-forwarded-for": ip,
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    }),
  );
}

function cookieOf(response: Response) {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

function linkIn(message: { text: string }) {
  const url = message.text.split("\n").find((line) => line.startsWith("http"));
  if (!url) throw new Error("e-mail without a link");
  return url;
}

function lastMailTo(email: string) {
  const found = sent.filter((m) => m.to === email).at(-1);
  if (!found) throw new Error(`no e-mail to ${email}`);
  return found;
}

async function signUp(email: string, password = PASSWORD, ip?: string) {
  return call("/sign-up/email", { body: { email, password, name: "Test", callbackURL: "/email-verified" }, ip });
}

async function signIn(email: string, password: string, ip?: string) {
  return call("/sign-in/email", { body: { email, password }, ip });
}

async function getSession(cookie: string) {
  return auth.api.getSession({ headers: new Headers({ cookie }) });
}

// Creates the account and confirms the e-mail through the link.
async function verifiedUser(email: string) {
  await signUp(email);
  const response = await call(linkIn(lastMailTo(email)), { method: "GET" });
  expect(response.status).toBe(302);
}

async function cleanup() {
  await db.delete(user).where(like(user.email, `%${DOMAIN}`));
  await db.delete(verification).where(like(verification.value, `%${DOMAIN}%`));
}

beforeAll(async () => {
  await runMigrations();
  await cleanup();
});

beforeEach(() => {
  sent.length = 0;
});

afterAll(async () => {
  await cleanup();
  await sql.end();
});

describe("sign-up with e-mail confirmation", () => {
  it("creates the account unconfirmed, without a session, and sends the link", async () => {
    const email = `new${DOMAIN}`;
    const response = await signUp(email);
    expect(response.status).toBe(200);
    expect((await response.json()).token).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);

    const [created] = await db.select().from(user).where(eq(user.email, email));
    expect(created).toMatchObject({ emailVerified: false, role: "tenant" });
    expect(await db.select().from(session).where(eq(session.userId, created!.id))).toEqual([]);

    const mail = lastMailTo(email);
    expect(mail.subject).toMatch(/confirm/i);
    expect(linkIn(mail)).toMatch(/\/api\/auth\/verify-email\?token=.+&callbackURL=%2Femail-verified$/);
  });

  it("does not sign in before confirming and resends the link", async () => {
    const email = `unverified${DOMAIN}`;
    await signUp(email);
    sent.length = 0;

    const response = await signIn(email, PASSWORD);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("EMAIL_NOT_VERIFIED");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(lastMailTo(email).subject).toMatch(/confirm/i);
  });

  it("the link confirms the e-mail, opens the session and leads to /email-verified", async () => {
    const email = `confirm${DOMAIN}`;
    await signUp(email);

    const response = await call(linkIn(lastMailTo(email)), { method: "GET" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/email-verified");

    const current = await getSession(cookieOf(response));
    expect(current?.user).toMatchObject({ email, emailVerified: true });
    expect((await signIn(email, PASSWORD)).status).toBe(200);
  });

  it("a tampered link comes back with an error", async () => {
    const email = `tampered${DOMAIN}`;
    await signUp(email);
    const link = linkIn(lastMailTo(email)).replace(/token=([^&]+)/, (_, t: string) => `token=${t.slice(0, -4)}AAAA`);

    const response = await call(link, { method: "GET" });
    expect(response.headers.get("location")).toBe("/email-verified?error=INVALID_TOKEN");
    const [row] = await db.select().from(user).where(eq(user.email, email));
    expect(row!.emailVerified).toBe(false);
  });

  it("an already registered e-mail gets the same response and does not change the account", async () => {
    const email = `existing${DOMAIN}`;
    await verifiedUser(email);

    const again = await signUp(email, "attacker-password-999");
    expect(again.status).toBe(200);
    const body = await again.json();
    expect(body.token).toBeNull();
    expect(body.user.email).toBe(email);

    expect(await db.select().from(user).where(eq(user.email, email))).toHaveLength(1);
    expect((await signIn(email, PASSWORD)).status).toBe(200);
    expect((await signIn(email, "attacker-password-999")).status).toBe(401);
  });

  it("rejects a short password", async () => {
    const response = await signUp(`short${DOMAIN}`, "short");
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("PASSWORD_TOO_SHORT");
  });
});

describe("password reset", () => {
  it("changes the password through the link, ends the sessions and does not let the link be used again", async () => {
    const email = `reset${DOMAIN}`;
    await verifiedUser(email);
    const oldCookie = cookieOf(await signIn(email, PASSWORD));
    expect(await getSession(oldCookie)).not.toBeNull();

    const request = await call("/request-password-reset", { body: { email, redirectTo: "/reset-password" } });
    expect(request.status).toBe(200);
    const mail = lastMailTo(email);
    expect(mail.subject).toMatch(/reset/i);

    // The e-mail link checks the token and leads to the portal screen.
    const landing = await call(linkIn(mail), { method: "GET" });
    expect(landing.status).toBe(302);
    const token = new URL(landing.headers.get("location")!, "http://x").searchParams.get("token");
    expect(landing.headers.get("location")).toBe(`http://localhost:3000/reset-password?token=${token}`);

    const reset = await call("/reset-password", { body: { newPassword: NEW_PASSWORD, token } });
    expect(reset.status).toBe(200);

    expect(await getSession(oldCookie)).toBeNull();
    expect((await signIn(email, PASSWORD)).status).toBe(401);
    expect((await signIn(email, NEW_PASSWORD)).status).toBe(200);

    const reuse = await call("/reset-password", { body: { newPassword: "third-password-789", token } });
    expect(reuse.status).toBe(400);
  });

  it("the link is valid for 30 minutes", async () => {
    const email = `expiry${DOMAIN}`;
    await verifiedUser(email);
    const before = Date.now();
    await call("/request-password-reset", { body: { email, redirectTo: "/reset-password" } });

    // The link is /api/auth/reset-password/<token>?callbackURL=...
    const token = new URL(linkIn(lastMailTo(email))).pathname.split("/").at(-1);
    const [row] = await db
      .select({ id: verification.id, expiresAt: verification.expiresAt })
      .from(verification)
      .where(eq(verification.identifier, `reset-password:${token}`));
    const minutes = (row!.expiresAt.getTime() - before) / 60_000;
    expect(minutes).toBeGreaterThan(29);
    expect(minutes).toBeLessThanOrEqual(30.1);

    // Once expired, the link no longer leads to the new password screen.
    await db.update(verification).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(verification.id, row!.id));
    const landing = await call(linkIn(lastMailTo(email)), { method: "GET" });
    expect(landing.headers.get("location")).toBe("http://localhost:3000/reset-password?error=INVALID_TOKEN");
  });

  it("an e-mail without an account gets the same response and no e-mail is sent", async () => {
    const response = await call("/request-password-reset", {
      body: { email: `nobody${DOMAIN}`, redirectTo: "/reset-password" },
    });
    expect(response.status).toBe(200);
    expect(sent).toEqual([]);
  });
});

describe("attempt limit per IP", () => {
  it("sign-up: 10 per hour", async () => {
    const ip = nextIp();
    for (let i = 0; i < 10; i++) expect((await signUp(`limit${i}${DOMAIN}`, PASSWORD, ip)).status).toBe(200);
    expect((await signUp(`limit10${DOMAIN}`, PASSWORD, ip)).status).toBe(429);
    // Another IP is still allowed.
    expect((await signUp(`limit11${DOMAIN}`)).status).toBe(200);
  });

  it("sign-in: 3 every 10 seconds", async () => {
    const ip = nextIp();
    for (let i = 0; i < 3; i++) expect((await signIn(`nobody${DOMAIN}`, "wrong-password-0", ip)).status).toBe(401);
    expect((await signIn(`nobody${DOMAIN}`, "wrong-password-0", ip)).status).toBe(429);
  });

  it("reset request: 5 per hour", async () => {
    const ip = nextIp();
    const body = { email: `nobody${DOMAIN}`, redirectTo: "/reset-password" };
    for (let i = 0; i < 5; i++) expect((await call("/request-password-reset", { body, ip })).status).toBe(200);
    expect((await call("/request-password-reset", { body, ip })).status).toBe(429);
  });
});
