import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Single data access layer (#18, E2 spec, section 4, ADR 0003):
// - only src/lib/data/ uses the database client to read and write tenant data;
// - only src/lib/umami/ calls Umami;
// - the rest of the code uses the functions of these two folders, which take a
//   context created by src/lib/access.ts.
// Exceptions: src/lib/db/ (the client itself and the migrations), access.ts
// (creates the context from the session) and auth.ts (Better Auth adapter).
// Forgetting the tenant filter outside the layer becomes a lint error.

const dbClient = {
  // Matches `@/lib/db`, `../db`, `./db/index` and `db/migrate`. The schema
  // (db/schema) is allowed: it only defines tables and types, with no connection.
  regex: "(^|/)db(/(index|migrate))?$",
  message: "Only src/lib/data/ accesses the database. Use a function from there, passing the context from lib/access.ts.",
};
const dbDrivers = {
  group: ["postgres", "drizzle-orm/postgres-js", "drizzle-orm/postgres-js/*"],
  message: "The database client lives in src/lib/db/. Use the functions in src/lib/data/.",
};
const umamiHttp = {
  // read.ts reads by the Umami ID, without checking the tenant: it is internal too.
  group: ["@/lib/umami/http", "**/umami/http", "@/lib/umami/read", "**/umami/read"],
  message: "Only src/lib/umami/ calls Umami. Use the public functions from there.",
};

const restrict = (...patterns) => ({
  rules: { "no-restricted-imports": ["error", { patterns }] },
});

const dataLayer = ["src/lib/data/**", "src/lib/access.ts", "src/lib/auth.ts"];

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: [".next/**", "dist/**", "next-env.d.ts", "drizzle/**"] },
  // Pages, routes, components and the rest of src/: neither database nor Umami.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [...dataLayer, "src/lib/umami/**", "src/lib/db/**"],
    ...restrict(dbClient, dbDrivers, umamiHttp),
  },
  // Data layer: database yes, Umami only through the functions in src/lib/umami/.
  { files: dataLayer, ...restrict(dbDrivers, umamiHttp) },
  // Umami client: reads the database only through the functions in src/lib/data/.
  { files: ["src/lib/umami/**"], ...restrict(dbClient, dbDrivers) },
];

export default config;
