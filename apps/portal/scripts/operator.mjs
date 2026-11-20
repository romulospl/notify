// SCF operator admin command (#19, E2 spec, D2 and D3; invites in ADR 0017).
// Only people with access to the server (and the database) create, invite,
// promote or demote operators; the portal has no screen for it, so an operator
// cannot make other operators.
//
// Usage:
//   pnpm operator:invite                         # asks the email twice, emails a 3-day link
//   pnpm operator:uninvite --email person@example.org
//   pnpm operator:list
//   read -rs OPERATOR_PASSWORD && export OPERATOR_PASSWORD
//   pnpm operator:create  --email scf@example.org --name "Name"
//   pnpm operator:promote --email person@example.org
//   pnpm operator:demote  --email person@example.org
//
// - invite: emails a link valid for 3 days and usable once; the invited person
//   picks a name and password at /invite/<token> and gets an operator account.
//   Needs SMTP_URL, PORTAL_URL (or BETTER_AUTH_URL; e.g. https://stellytics.xyz)
//   and optionally MAIL_FROM. In production, run it inside the portal container
//   with operator.sh at the repository root, which already has all of them. A new invite
//   to the same email replaces the previous one.
// - uninvite: deletes the pending invite of an email.
// - list: operators and pending invites.
// - create: new account, email already verified. Password in OPERATOR_PASSWORD.
// - promote: existing account that is not a tenant member (D2: an operator has
//   no project; someone from the SCF with a project uses two accounts).
// - demote: turns the operator back into a regular user.
// Every change goes to audit_log (null actor = script). Promote and demote end
// the account's sessions, so the new role applies on the next request.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { hashPassword } from "better-auth/crypto";
import { createTransport } from "nodemailer";
import postgres from "postgres";

const INVITE_DAYS = 3;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COMMANDS = ["invite", "uninvite", "list", "create", "promote", "demote"];

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: { email: { type: "string" }, name: { type: "string" } } });

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Usage error inside the transaction: rolls everything back and shows only the message.
class Refused extends Error {}

if (!COMMANDS.includes(command)) fail(`Use: operator.mjs ${COMMANDS.join("|")} [--email ...]`);

// Asks the email twice. Lines come from the terminal or, without one, from stdin.
async function askEmail() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question) => {
    process.stdout.write(question);
    const { value, done } = await lines.next();
    return done ? "" : value;
  };
  try {
    const first = (await ask("Email of the new operator: ")).trim().toLowerCase();
    const second = (await ask("Type the email again: ")).trim().toLowerCase();
    if (first !== second) fail("The emails don't match. Nothing was sent.");
    return first;
  } finally {
    rl.close();
  }
}

let email = values.email?.trim().toLowerCase();
if (command === "invite" && !email) email = await askEmail();
if (command !== "list") {
  if (!email) fail("Give --email.");
  if (!EMAIL_PATTERN.test(email)) fail(`Invalid email: ${email}`);
}

// Checked before connecting, so a missing setting changes nothing.
let portalUrl;
if (command === "invite") {
  if (!process.env.SMTP_URL) fail("Set SMTP_URL (the portal's SMTP, e.g. smtps://user:password@host:465).");
  // Inside the portal container BETTER_AUTH_URL already holds the public address.
  const base = process.env.PORTAL_URL || process.env.BETTER_AUTH_URL;
  if (!base) fail("Set PORTAL_URL (the portal's public address, e.g. https://stellytics.xyz).");
  portalUrl = base.replace(/\/+$/, "");
}

const sql = postgres(process.env.DATABASE_URL ?? "postgresql://stellytics:stellytics@localhost:5432/stellytics", {
  max: 1,
  onnotice: () => {},
});

async function audit(tx, action, details) {
  await tx`insert into audit_log (actor_user_id, action, details)
           values (null, ${action}, ${sql.json(details)})`;
}

// Expired invites only matter until someone looks: they hold an email and no longer work.
async function purgeExpired(tx) {
  await tx`delete from operator_invite where expires_at <= now()`;
}

function inviteEmail(url, expiresAt) {
  return {
    subject: "You're invited to be an SCF operator on stellytics",
    text: [
      "You were invited to be an SCF operator on stellytics. Operators see every project on the platform.",
      "",
      "To accept, open the link below and choose your name and password:",
      "",
      url,
      "",
      `The link works once and expires on ${expiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
      "If you weren't expecting this, ignore this email.",
    ].join("\n"),
  };
}

try {
  if (command === "invite") {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token, "utf8").digest();
    let expiresAt;
    await sql.begin(async (tx) => {
      await purgeExpired(tx);
      const [found] = await tx`select role from "user" where email = ${email}`;
      if (found?.role === "operator") throw new Refused(`${email} is already an operator.`);
      if (found) throw new Refused(`${email} already has an account. Use operator:promote instead.`);
      // A new invite replaces the previous one; its link stops working.
      const [previous] = await tx`delete from operator_invite where email = ${email} returning id`;
      if (previous) await audit(tx, "operator.invite_revoked", { inviteId: previous.id });
      const [invite] = await tx`
        insert into operator_invite (email, token_hash, expires_at)
        values (${email}, ${tokenHash}, now() + make_interval(days => ${INVITE_DAYS}))
        returning id, expires_at`;
      expiresAt = invite.expires_at;
      await audit(tx, "operator.invited", { inviteId: invite.id });
      // Sent inside the transaction: if the email fails, no invite is left behind.
      const transport = createTransport(process.env.SMTP_URL);
      await transport.sendMail({
        from: process.env.MAIL_FROM ?? "stellytics <no-reply@stellytics.localhost>",
        to: email,
        ...inviteEmail(`${portalUrl}/invite/${token}`, expiresAt),
      });
    });
    console.log(`Invite sent to ${email}. It expires on ${expiresAt.toISOString()}.`);
  } else if (command === "uninvite") {
    await sql.begin(async (tx) => {
      await purgeExpired(tx);
      const [deleted] = await tx`delete from operator_invite where email = ${email} returning id`;
      if (!deleted) throw new Refused(`No pending invite for ${email}.`);
      await audit(tx, "operator.invite_revoked", { inviteId: deleted.id });
    });
    console.log(`Invite for ${email} revoked.`);
  } else if (command === "list") {
    await sql`delete from operator_invite where expires_at <= now()`;
    const operators = await sql`select email, name, created_at from "user" where role = 'operator' order by created_at`;
    const invites = await sql`select email, expires_at from operator_invite order by created_at`;
    console.log(`Operators (${operators.length}):`);
    for (const o of operators) console.log(`  ${o.email}  ${o.name}  since ${o.created_at.toISOString().slice(0, 10)}`);
    console.log(`Pending invites (${invites.length}):`);
    for (const i of invites) console.log(`  ${i.email}  expires ${i.expires_at.toISOString()}`);
  } else if (command === "create") {
    const password = process.env.OPERATOR_PASSWORD;
    if (!values.name || !password) throw new Refused("Give --name, and the password in OPERATOR_PASSWORD.");
    if (password.length < 12) throw new Refused("The password needs at least 12 characters.");
    const userId = randomUUID();
    const hash = await hashPassword(password);
    await sql.begin(async (tx) => {
      await tx`insert into "user" (id, name, email, email_verified, role)
               values (${userId}, ${values.name}, ${email}, true, 'operator')`;
      await tx`insert into account (id, account_id, provider_id, user_id, password)
               values (${randomUUID()}, ${userId}, 'credential', ${userId}, ${hash})`;
      // A pending invite for this email no longer makes sense.
      await tx`delete from operator_invite where email = ${email}`;
      await audit(tx, "operator.created", { userId });
    });
    console.log(`Operator ${email} created.`);
  } else {
    await sql.begin(async (tx) => {
      const [found] = await tx`select id, role from "user" where email = ${email} for update`;
      if (!found) throw new Refused(`No account with the email ${email}.`);
      if (command === "promote") {
        if (found.role === "operator") throw new Refused(`${email} is already an operator.`);
        const [member] = await tx`select 1 from tenant_member where user_id = ${found.id}`;
        if (member) throw new Refused(`${email} is a project member and cannot be an operator (D2). Use another account.`);
        await tx`update "user" set role = 'operator', updated_at = now() where id = ${found.id}`;
        await audit(tx, "operator.promoted", { userId: found.id });
      } else {
        if (found.role !== "operator") throw new Refused(`${email} is not an operator.`);
        await tx`update "user" set role = 'tenant', updated_at = now() where id = ${found.id}`;
        await audit(tx, "operator.demoted", { userId: found.id });
      }
      await tx`delete from session where user_id = ${found.id}`;
    });
    console.log(command === "promote" ? `${email} is now an operator.` : `${email} is no longer an operator.`);
  }
} catch (error) {
  process.exitCode = 1;
  // Never the password, the hash or the invite token in the message.
  if (error instanceof Refused) console.error(error.message);
  else if (error.code === "23505") console.error("Failed: an account with this email already exists.");
  else if (command === "invite" && error.code && /^E[A-Z]+$/.test(error.code)) {
    console.error(`Failed to send the email (${error.code}). No invite was created.`);
  } else console.error(`Failed: ${error.message}`);
} finally {
  await sql.end();
}
