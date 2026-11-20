import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./index";

// Applies the versioned migrations in ./drizzle. Used at server startup
// (instrumentation.ts) and in the integration tests.
export async function runMigrations(migrationsFolder = path.join(process.cwd(), "drizzle")) {
  await migrate(db, { migrationsFolder });
}

// Development accounts (known passwords) in ./drizzle-dev, in a tracking table of
// their own so they do not mix with the order of the real migrations. Only runs
// with SEED_DEV_DATA=true (dev Compose); production never sets this variable.
export async function runDevSeed(migrationsFolder = path.join(process.cwd(), "drizzle-dev")) {
  await migrate(db, { migrationsFolder, migrationsTable: "__dev_seed_migrations" });
}
