// Development seed (#19): 2 test projects and 1 SCF operator.
// It can run more than once: what already exists stays as it is.
//
// Usage:
//   read -rs SEED_PASSWORD && export SEED_PASSWORD
//   pnpm db:seed
//
// Accounts created (all with the SEED_PASSWORD password and a confirmed e-mail):
//   owner-a@seed.stellytics.localhost  owner of "Seed Project A"
//   owner-b@seed.stellytics.localhost  owner of "Seed Project B"
//   operator@seed.stellytics.localhost SCF operator (not a tenant member, D2)
// Each project gets an API service with an ingest key (the key is not
// shown; create another one in the UI if you need it) and, if UMAMI_API_KEY
// is set, a site in Umami.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";

if (process.env.NODE_ENV === "production") {
  console.error("The seed is for development only.");
  process.exit(1);
}
const password = process.env.SEED_PASSWORD;
if (!password || password.length < 12) {
  console.error("Provide a password of at least 12 characters in SEED_PASSWORD.");
  process.exit(1);
}

const DOMAIN = "seed.stellytics.localhost";
const PROJECTS = [
  { name: "Seed Project A", slug: "seed-project-a", owner: `owner-a@${DOMAIN}`, site: "a.seed.example.org" },
  { name: "Seed Project B", slug: "seed-project-b", owner: `owner-b@${DOMAIN}`, site: "b.seed.example.org" },
];
const OPERATOR = `operator@${DOMAIN}`;

// 127.0.0.1:3001 only answers with the Umami development override (#62):
// docker compose -f compose.yaml -f infra/compose/umami-port.yaml up -d
const umamiUrl = (process.env.UMAMI_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const umamiKey = process.env.UMAMI_API_KEY;

const sql = postgres(process.env.DATABASE_URL ?? "postgresql://stellytics:stellytics@localhost:5432/stellytics", {
  max: 1,
  onnotice: () => {},
});
const hash = await hashPassword(password);

// Same format as src/lib/ingest-key.ts: ntf_<base32 prefix>_<secret>.
function ingestKey() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0n;
  for (const byte of randomBytes(5)) bits = (bits << 8n) | BigInt(byte);
  let prefix = "";
  for (let i = 7; i >= 0; i--) prefix += alphabet[Number((bits >> BigInt(i * 5)) & 31n)];
  const key = `ntf_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { prefix, keyHash: createHash("sha256").update(key).digest() };
}

async function ensureUser(tx, email, name, role) {
  const [existing] = await tx`select id from "user" where email = ${email}`;
  if (existing) return { id: existing.id, created: false };
  const id = randomUUID();
  await tx`insert into "user" (id, name, email, email_verified, role) values (${id}, ${name}, ${email}, true, ${role})`;
  await tx`insert into account (id, account_id, provider_id, user_id, password)
           values (${randomUUID()}, ${id}, 'credential', ${id}, ${hash})`;
  return { id, created: true };
}

async function createUmamiSite(name, domain) {
  const response = await fetch(`${umamiUrl}/api/websites`, {
    method: "POST",
    headers: { authorization: `Bearer ${umamiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ name, domain }),
  });
  if (!response.ok) throw new Error(`Umami answered ${response.status} when creating the site ${domain}`);
  return (await response.json()).id;
}

try {
  const operator = await sql.begin((tx) => ensureUser(tx, OPERATOR, "Seed Operator", "operator"));
  if (operator.created) {
    await sql`insert into audit_log (actor_user_id, action, details)
              values (null, 'operator.created', ${sql.json({ userId: operator.id })})`;
  }
  console.log(`${OPERATOR}: ${operator.created ? "created" : "already existed"}`);

  for (const project of PROJECTS) {
    const [existing] = await sql`select id from tenant where slug = ${project.slug}`;
    let tenantId = existing?.id;
    if (!tenantId) {
      tenantId = await sql.begin(async (tx) => {
        const owner = await ensureUser(tx, project.owner, `${project.name} owner`, "tenant");
        const [created] = await tx`insert into tenant (name, slug) values (${project.name}, ${project.slug}) returning id`;
        await tx`insert into tenant_member (tenant_id, user_id, role) values (${created.id}, ${owner.id}, 'owner')`;
        await tx`insert into audit_log (actor_user_id, action, tenant_id, details)
                 values (${owner.id}, 'tenant.created', ${created.id}, ${sql.json({ slug: project.slug })})`;
        const [service] = await tx`insert into api_service (tenant_id, name) values (${created.id}, 'seed-api') returning id`;
        const { prefix, keyHash } = ingestKey();
        await tx`insert into ingest_key (api_service_id, tenant_id, prefix, key_hash, created_by)
                 values (${service.id}, ${created.id}, ${prefix}, ${keyHash}, ${owner.id})`;
        return created.id;
      });
      console.log(`${project.name}: created, owner ${project.owner}`);
    } else {
      console.log(`${project.name}: already existed`);
    }

    const [site] = await sql`select id from site where tenant_id = ${tenantId}`;
    if (site) continue;
    if (!umamiKey) {
      console.log(`${project.name}: no site (set UMAMI_API_KEY to create one in Umami)`);
      continue;
    }
    const umamiWebsiteId = await createUmamiSite(`${project.name} site`, project.site);
    await sql`insert into site (tenant_id, name, domain, umami_website_id)
              values (${tenantId}, ${`${project.name} site`}, ${project.site}, ${umamiWebsiteId})`;
    console.log(`${project.name}: site ${project.site} created in Umami`);
  }
} catch (error) {
  process.exitCode = 1;
  console.error(`Seed failed: ${error.message}`);
} finally {
  await sql.end();
}
