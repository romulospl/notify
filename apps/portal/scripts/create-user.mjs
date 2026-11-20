// Creates a regular user (tenant role) in the `stellytics` database, with the e-mail already confirmed.
// Usage: pnpm --filter @stellytics/portal user:create -- --email a@b.c --name "Name"
// The password is read from the PORTAL_USER_PASSWORD variable (so it does not stay in the shell history).
// SCF operator only through the administration command: scripts/operator.mjs (#19).
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
  },
});

const password = process.env.PORTAL_USER_PASSWORD;
if (!values.email || !values.name || !password) {
  console.error("Provide --email and --name, and the password in PORTAL_USER_PASSWORD.");
  process.exit(1);
}
if (password.length < 12) {
  console.error("The password needs at least 12 characters.");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL ?? "postgresql://stellytics:stellytics@localhost:5432/stellytics", { max: 1 });
try {
  const userId = randomUUID();
  const hash = await hashPassword(password);
  await sql.begin(async (tx) => {
    await tx`insert into "user" (id, name, email, email_verified, role)
             values (${userId}, ${values.name}, ${values.email.toLowerCase()}, true, 'tenant')`;
    await tx`insert into account (id, account_id, provider_id, user_id, password)
             values (${randomUUID()}, ${userId}, 'credential', ${userId}, ${hash})`;
  });
  console.log(`User ${values.email} created.`);
} finally {
  await sql.end();
}
