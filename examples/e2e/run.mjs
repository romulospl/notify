// End-to-end test of the examples (#27, #50) against the Docker Compose stack.
//
// Creates a website in Umami for each example and an active tenant with the four
// sites in the stellytics database (which puts them in ingest_site), runs
// Playwright with the IDs in the environment and deletes everything at the end.
// The examples start through the webServer entries in playwright.config.ts.
//
// Variables: UMAMI_URL (http://127.0.0.1:3001), UMAMI_USER/UMAMI_PASSWORD
// (admin/umami), STELLYTICS_DATABASE_URL and UMAMI_DATABASE_URL (Postgres at
// 127.0.0.1:5432) and STELLYTICS_GATEWAY_URL (http://127.0.0.1:3002).
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const umamiURL = process.env.UMAMI_URL ?? "http://127.0.0.1:3001";
const stellytics = postgres(process.env.STELLYTICS_DATABASE_URL ?? "postgresql://stellytics:stellytics@127.0.0.1:5432/stellytics");

async function umami(method, path, token, body) {
  const res = await fetch(umamiURL + path, {
    method,
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Umami ${method} ${path}: ${res.status}`);
  return res.json();
}

const { token } = await umami("POST", "/api/auth/login", null, {
  username: process.env.UMAMI_USER ?? "admin",
  password: process.env.UMAMI_PASSWORD ?? "umami",
});

const examples = ["static", "spa", "next", "wallet"];
const sites = {};
let tenantId;
let status = 1;
try {
  for (const name of examples) {
    const site = await umami("POST", "/api/websites", token, { name: `e2e-${name}`, domain: `${name}.e2e.example` });
    sites[name] = site.id;
  }
  [{ id: tenantId }] = await stellytics`
    INSERT INTO tenant (name, slug) VALUES ('e2e-examples', ${`e2e-examples-${randomUUID()}`}) RETURNING id`;
  for (const name of examples) {
    await stellytics`
      INSERT INTO site (tenant_id, name, domain, umami_website_id)
      VALUES (${tenantId}, ${name}, ${`${name}.e2e.example`}, ${sites[name]})`;
  }

  const result = spawnSync("playwright", ["test", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, SITE_STATIC: sites.static, SITE_SPA: sites.spa, SITE_NEXT: sites.next, SITE_WALLET: sites.wallet },
    shell: process.platform === "win32",
  });
  status = result.status ?? 1;
} finally {
  // Cada passo da limpeza segue mesmo se o anterior falhar.
  const step = (promise) => promise.catch((error) => console.error(`limpeza: ${error.message}`));
  if (tenantId) {
    await step(stellytics`DELETE FROM site WHERE tenant_id = ${tenantId}`);
    await step(stellytics`DELETE FROM tenant WHERE id = ${tenantId}`);
  }
  for (const id of Object.values(sites)) await step(umami("DELETE", `/api/websites/${id}`, token));
  await step(stellytics.end());
}
process.exit(status);
