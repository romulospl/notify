import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { stellyticsSql?: ReturnType<typeof postgres> };

// Reuses the connection across `next dev` reloads.
const sql = globalForDb.stellyticsSql ?? postgres(env.databaseUrl, { max: 10, onnotice: () => {} });
if (process.env.NODE_ENV !== "production") globalForDb.stellyticsSql = sql;

export const db = drizzle(sql, { schema, casing: "snake_case" });
export { sql };
