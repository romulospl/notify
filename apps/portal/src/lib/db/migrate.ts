import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./index";

// Aplica as migrações versionadas em ./drizzle. Usado na subida do servidor
// (instrumentation.ts) e nos testes de integração.
export async function runMigrations(migrationsFolder = path.join(process.cwd(), "drizzle")) {
  await migrate(db, { migrationsFolder });
}
