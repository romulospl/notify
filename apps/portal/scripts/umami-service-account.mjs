// Prepares the portal's service account in Umami and prints a new API key.
// Run once per environment (and again to rotate the key), by whoever administers
// the server. The portal keeps only the key, in UMAMI_API_KEY; never the
// administrator password (ADR 0001, verified in #58).
//
// Usage:
//   read -rs UMAMI_ADMIN_PASSWORD && export UMAMI_ADMIN_PASSWORD
//   UMAMI_URL=http://127.0.0.1:3001 pnpm umami:service-account [--revoke-old]
//
// What it does:
//   1. Logs in to Umami as administrator (UMAMI_ADMIN_USER, default "admin").
//   2. Creates the service user (UMAMI_SERVICE_USER, default "stellytics-portal")
//      with the regular "user" role, not administrator. If it already exists,
//      replaces the password with a new random one.
//   3. Logs in as the service user and creates an API key.
//   4. With --revoke-old, deletes the service user's other keys. Use it to
//      rotate the key: run without the option, put the new key in the portal and
//      run again with it (which creates one more key and leaves only that last one).
// The service user's password is random and discarded: nobody logs in with it.
// Only the key goes to standard output; the messages go to standard error.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

const { values: options } = parseArgs({ options: { "revoke-old": { type: "boolean", default: false } } });

const baseUrl = (process.env.UMAMI_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const adminUser = process.env.UMAMI_ADMIN_USER ?? "admin";
const adminPassword = process.env.UMAMI_ADMIN_PASSWORD;
const serviceUser = process.env.UMAMI_SERVICE_USER ?? "stellytics-portal";

if (!adminPassword) {
  console.error("Provide the Umami administrator password in UMAMI_ADMIN_PASSWORD.");
  process.exit(1);
}

async function call(path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function login(username, password) {
  const { token } = await call("/api/auth/login", { method: "POST", body: { username, password } });
  return token;
}

const adminToken = await login(adminUser, adminPassword);
const servicePassword = randomBytes(32).toString("base64url");

const { data: found } = await call(
  `/api/admin/users?search=${encodeURIComponent(serviceUser)}&pageSize=100`,
  { token: adminToken },
);
const existing = found.find((u) => u.username === serviceUser);

if (existing) {
  if (existing.role !== "user") {
    throw new Error(`The user ${serviceUser} exists with the role ${existing.role}; expected "user".`);
  }
  await call(`/api/users/${existing.id}`, {
    token: adminToken,
    method: "POST",
    body: { password: servicePassword },
  });
  console.error(`Service user ${serviceUser} already existed; password replaced.`);
} else {
  await call("/api/users", {
    token: adminToken,
    method: "POST",
    body: { username: serviceUser, password: servicePassword, role: "user" },
  });
  console.error(`Service user ${serviceUser} created with the "user" role.`);
}

const serviceToken = await login(serviceUser, servicePassword);
const name = `stellytics-portal ${new Date().toISOString()}`;
const { id: newKeyId, key, keyPrefix } = await call("/api/me/api-keys", {
  token: serviceToken,
  method: "POST",
  body: { name },
});
if (options["revoke-old"]) {
  const keys = await call("/api/me/api-keys", { token: serviceToken });
  for (const old of keys.filter((k) => k.id !== newKeyId)) {
    await call(`/api/me/api-keys/${old.id}`, { token: serviceToken, method: "DELETE" });
    console.error(`Key ${old.keyPrefix}… revoked.`);
  }
}
console.error(`Key ${keyPrefix}… created. Store it in UMAMI_API_KEY; it is not shown again.`);
console.log(key);
