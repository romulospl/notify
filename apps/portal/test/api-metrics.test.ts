// Integration test of the API metric tables (#33, E5 spec, section 4)
// against a real Postgres (DATABASE_URL). Requires the roles from
// infra/compose/postgres/init/02-ingest-roles.sh.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { asRole } from "./helpers/as-role";

// Metrics have no foreign key (spec, section 4): loose IDs are enough.
const tenantId = randomUUID();
const serviceId = randomUUID();

function buckets(counts: Record<number, number>): number[] {
  return Array.from({ length: 15 }, (_, i) => counts[i] ?? 0);
}

function arrayLiteral(values: number[]) {
  return `'{${values.join(",")}}'::bigint[]`;
}

// The upsert the collector does (#31): adds up count, sum and buckets.
function upsert(table: string, at: string, route: string, status: number, count: number, sum: number, b: number[]) {
  return `
    INSERT INTO ${table} AS m (bucket_start, tenant_id, api_service_id, route, method, status_code,
                               request_count, duration_sum, duration_buckets)
    VALUES ('${at}', '${tenantId}', '${serviceId}', '${route}', 'GET', ${status}, ${count}, ${sum}, ${arrayLiteral(b)})
    ON CONFLICT (tenant_id, api_service_id, route, method, status_code, bucket_start) DO UPDATE SET
      request_count = m.request_count + EXCLUDED.request_count,
      duration_sum = m.duration_sum + EXCLUDED.duration_sum,
      duration_buckets = api_metric_add_buckets(m.duration_buckets, EXCLUDED.duration_buckets)`;
}

const tables = ["api_metric_1m", "api_metric_1h", "api_metric_1d"];

async function partitionNames(): Promise<string[]> {
  const rows = await sql<{ child: string }[]>`
    SELECT c.relname AS child
    FROM pg_inherits i
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE p.relname IN ('api_metric_1m', 'api_metric_1h', 'api_metric_1d')`;
  return rows.map((r) => r.child);
}

// Partitions that existed before the test. The default test creates future
// partitions; without removing them, the second run on the same database would
// find the distant month already covered and the point would never go through
// the default.
let baseline: string[] = [];

beforeAll(async () => {
  await runMigrations();
  baseline = await partitionNames();
});

afterAll(async () => {
  for (const t of tables) {
    await sql.unsafe(`DELETE FROM ${t} WHERE tenant_id = $1`, [tenantId]);
  }
  for (const name of await partitionNames()) {
    if (baseline.includes(name)) continue;
    // Only the ones created by this test, and only if they are already empty.
    const rows = await sql.unsafe(`SELECT count(*)::int AS n FROM ${name}`);
    if (rows[0]!.n === 0) await sql.unsafe(`DROP TABLE ${name}`);
  }
  await sql.end();
});

describe("tables and partitions", () => {
  it("creates the three partitioned tables, with the default and the next months", async () => {
    const rows = await sql<{ parent: string; child: string }[]>`
      SELECT p.relname AS parent, c.relname AS child
      FROM pg_inherits i
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_class c ON c.oid = i.inhrelid
      WHERE p.relname IN ('api_metric_1m', 'api_metric_1h', 'api_metric_1d')`;
    const now = new Date();
    const month = (offset: number) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
      return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    };
    for (const t of ["api_metric_1m", "api_metric_1h", "api_metric_1d"]) {
      const children = rows.filter((r) => r.parent === t).map((r) => r.child);
      expect(children).toContain(`${t}_default`);
      for (const offset of [0, 1, 2]) expect(children).toContain(`${t}_p${month(offset)}`);
    }
  });

  it("keeps a point without a partition in the default and moves it when the partition is created", async () => {
    // One month after the last partition that already exists, so the point falls
    // into the default even if another run has created partitions ahead.
    const now = new Date();
    const lastPartition = baseline
      .filter((n) => /^api_metric_1m_p\d{6}$/.test(n))
      .map((n) => n.slice(-6))
      .sort()
      .at(-1)!;
    const lastMonths = Number(lastPartition.slice(0, 4)) * 12 + Number(lastPartition.slice(4)) - 1;
    const nowMonths = now.getUTCFullYear() * 12 + now.getUTCMonth();
    const ahead = lastMonths - nowMonths + 1;
    const far = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + ahead, 1));
    const at = far.toISOString();
    await sql.unsafe(upsert("api_metric_1m", at, "/late", 200, 1, 0.01, buckets({ 1: 1 })));

    const where = `tenant_id = '${tenantId}' AND route = '/late'`;
    expect(await sql.unsafe(`SELECT 1 FROM api_metric_1m_default WHERE ${where}`)).toHaveLength(1);

    await sql`SELECT api_metric_ensure_partitions(${ahead})`;
    await sql`SELECT api_metric_ensure_partitions(${ahead})`; // idempotent

    expect(await sql.unsafe(`SELECT 1 FROM api_metric_1m_default WHERE ${where}`)).toHaveLength(0);
    const [moved] = await sql.unsafe(`SELECT tableoid::regclass::text AS part FROM api_metric_1m WHERE ${where}`);
    expect(moved!.part).toMatch(/^api_metric_1m_p\d{6}$/);
  });

  it("rejects malformed buckets and an empty route", async () => {
    const at = new Date().toISOString();
    await expect(sql.unsafe(upsert("api_metric_1m", at, "/x", 200, 1, 0.01, [1, 2, 3]))).rejects.toThrow();
    await expect(sql.unsafe(upsert("api_metric_1m", at, "", 200, 1, 0.01, buckets({})))).rejects.toThrow();
  });
});

describe("upsert and percentiles", () => {
  const minute = "2026-11-14T10:00:00Z";

  it("adds up count, duration and histogram buckets of the same time bucket", async () => {
    await sql.unsafe(upsert("api_metric_1m", minute, "/ledgers/{id}", 200, 50, 1, buckets({ 2: 50 })));
    await sql.unsafe(upsert("api_metric_1m", minute, "/ledgers/{id}", 200, 50, 300, buckets({ 11: 50 })));
    const [row] = await sql<{ request_count: string; duration_sum: number; duration_buckets: string[] }[]>`
      SELECT request_count, duration_sum, duration_buckets FROM api_metric_1m
      WHERE tenant_id = ${tenantId} AND route = '/ledgers/{id}' AND bucket_start = ${minute}`;
    expect(Number(row!.request_count)).toBe(100);
    expect(row!.duration_sum).toBe(301);
    expect(row!.duration_buckets.map(Number)).toEqual(buckets({ 2: 50, 11: 50 }));
  });

  it("computes p50 and p95 per route and period", async () => {
    // One more row of the same route in another minute and another, fast route.
    await sql.unsafe(upsert("api_metric_1m", "2026-11-14T10:01:00Z", "/ledgers/{id}", 500, 0, 0, buckets({})));
    await sql.unsafe(upsert("api_metric_1m", "2026-11-14T10:01:00Z", "/health", 200, 10, 0.02, buckets({ 0: 10 })));

    const rows = await sql<{ route: string; requests: string; p50: number; p95: number }[]>`
      SELECT route, sum(request_count) AS requests,
             api_metric_quantile(api_metric_sum_buckets(duration_buckets), 0.5) AS p50,
             api_metric_quantile(api_metric_sum_buckets(duration_buckets), 0.95) AS p95
      FROM api_metric_1m
      WHERE tenant_id = ${tenantId} AND bucket_start >= '2026-11-14T10:00:00Z' AND bucket_start < '2026-11-14T11:00:00Z'
      GROUP BY route ORDER BY route`;

    expect(rows.map((r) => r.route)).toEqual(["/health", "/ledgers/{id}"]);
    // /ledgers: 50 in the third bucket, (0.01, 0.025], and 50 in the twelfth,
    // (2.5, 5]. p50 closes the third (0.025); p95 falls at 45/50 of the
    // twelfth: 2.5 + 2.5 * 0.9 = 4.75.
    const ledgers = rows[1]!;
    expect(Number(ledgers.requests)).toBe(100);
    expect(ledgers.p50).toBeCloseTo(0.025, 9);
    expect(ledgers.p95).toBeCloseTo(4.75, 9);
    // /health: everything in the first bucket [0, 0.005].
    expect(rows[0]!.p50).toBeCloseTo(0.0025, 9);
  });

  it("handles the percentile extremes", async () => {
    const q = async (b: number[], p: number) =>
      (await sql.unsafe(`SELECT api_metric_quantile(${arrayLiteral(b)}, ${p}) AS v`))[0]!.v as number | null;
    expect(await q(buckets({}), 0.5)).toBeNull();
    expect(await q(buckets({ 14: 3 }), 0.5)).toBe(10); // above 10 s
    expect(await q(buckets({ 4: 1 }), 0)).toBeCloseTo(0.05, 9);
    expect(await q(buckets({ 4: 1 }), 1)).toBeCloseTo(0.075, 9);
    expect(await q(buckets({ 4: 1 }), 1.5)).toBeNull();
  });
});

describe("permissions", () => {
  const at = "2026-11-14T10:00:00Z";

  it("the collector writes and accumulates in the 1-minute bucket", async () => {
    await asRole("stellytics_collector", upsert("api_metric_1m", at, "/collector", 201, 1, 0.1, buckets({ 5: 1 })));
    await asRole("stellytics_collector", upsert("api_metric_1m", at, "/ledgers/{id}", 200, 1, 0.1, buckets({ 5: 1 })));
  });

  it("the collector does not delete, does not write to the rollups and does not touch partitions", async () => {
    await expect(asRole("stellytics_collector", `DELETE FROM api_metric_1m WHERE tenant_id = '${tenantId}'`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asRole("stellytics_collector", upsert("api_metric_1h", at, "/x", 200, 1, 0.1, buckets({ 5: 1 }))),
    ).rejects.toThrow(/permission denied/);
    await expect(asRole("stellytics_collector", "SELECT api_metric_ensure_partitions(1)")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("the web gateway cannot see the metrics", async () => {
    await expect(asRole("stellytics_ingest", "SELECT 1 FROM api_metric_1m LIMIT 1")).rejects.toThrow(/permission denied/);
  });
});
