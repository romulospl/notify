// Runs a query as another database role (stellytics_ingest or
// stellytics_collector, E2 spec, D4), inside a transaction rolled back at the end.
// Requires the roles from infra/compose/postgres/init/02-ingest-roles.sh.
import { sql } from "@/lib/db";

class Rollback extends Error {}

export async function asRole<T>(role: "stellytics_ingest" | "stellytics_collector", query: string): Promise<T[]> {
  let rows: T[] = [];
  await sql
    .begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      rows = (await tx.unsafe(query)) as unknown as T[];
      throw new Rollback();
    })
    .catch((error) => {
      if (!(error instanceof Rollback)) throw error;
    });
  return rows;
}
