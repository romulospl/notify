import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { notifySql?: ReturnType<typeof postgres> };

// Reaproveita a conexão entre recargas do `next dev`.
const sql = globalForDb.notifySql ?? postgres(env.databaseUrl, { max: 10, onnotice: () => {} });
if (process.env.NODE_ENV !== "production") globalForDb.notifySql = sql;

export const db = drizzle(sql, { schema, casing: "snake_case" });
export { sql };
