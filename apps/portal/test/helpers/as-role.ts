// Roda uma consulta como outro papel do banco (notify_ingest ou
// notify_collector, spec do E2, D4), dentro de uma transação desfeita no fim.
// Exige os papéis de infra/compose/postgres/init/02-ingest-roles.sh.
import { sql } from "@/lib/db";

class Rollback extends Error {}

export async function asRole<T>(role: "notify_ingest" | "notify_collector", query: string): Promise<T[]> {
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
