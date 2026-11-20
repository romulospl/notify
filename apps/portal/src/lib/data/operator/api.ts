import "server-only";
import type { DemoContext, OperatorContext } from "../../access";
import { sql } from "../../db";
import type { Period } from "../../period";
import { type ApiCounts, metricSources } from "../api-metrics";

// Global SCF API dashboard (#38): volume, errors and latency of each active
// project in the period, summing its non-archived services. A removed or
// pending project is left out (E2 spec, section 6); an active project with no
// service or no requests is included with zeros, so the SCF finds who is not
// using it.
//
// Each project reads the tables by the same rule as the tenant dashboard
// (metricSources, #37), with its own last rolled-up hour: both dashboards
// show the same numbers for the same period.

export type ProjectApiStats = {
  tenantId: string;
  name: string;
  slug: string;
  services: number;
  totals: ApiCounts;
};

type Row = {
  tenant_id: string;
  requests: string | null;
  client_errors: string | null;
  server_errors: string | null;
  p50: number | null;
  p95: number | null;
};

export async function getApiOverview(ctx: OperatorContext, period: Period): Promise<ProjectApiStats[]> {
  // The context filters nothing here: requiring it proves that the caller is an operator.
  void ctx;
  return apiOverview(period);
}

// Same numbers for the public demo's operator view, restricted to the demo
// tenant: no other project is read.
export async function getDemoApiOverview(ctx: DemoContext, period: Period): Promise<ProjectApiStats[]> {
  return apiOverview(period, ctx.tenantId);
}

async function apiOverview(period: Period, onlyTenantId?: string): Promise<ProjectApiStats[]> {
  // Active projects, non-archived services and the end of each one's last
  // rolled-up hour (the (tenant_id, bucket_start) index serves it).
  const projects = await sql<
    { tenant_id: string; name: string; slug: string; services: string; until: Date | string | null }[]
  >`
    SELECT t.id AS tenant_id, t.name, t.slug,
      (SELECT count(*) FROM api_service s WHERE s.tenant_id = t.id AND s.archived_at IS NULL) AS services,
      (SELECT max(bucket_start) + interval '1 hour' FROM api_metric_1h m WHERE m.tenant_id = t.id) AS until
    FROM tenant t
    WHERE t.status = 'active' ${onlyTenantId ? sql`AND t.id = ${onlyTenantId}` : sql``}
    ORDER BY t.name`;
  if (projects.length === 0) return [];

  // Each project's stretches go in a single JSON, which becomes a table with
  // json_to_recordset (the driver does not serialize text arrays here). An
  // empty stretch (from >= to) returns no row; the days one disappears in an
  // hourly period.
  const ranges = projects.map((p) => {
    const src = metricSources(period, p.until ? new Date(p.until) : null);
    const day = src.day ?? { from: period.startAt, to: period.startAt };
    return {
      tenant_id: p.tenant_id,
      d_from: day.from,
      d_to: day.to,
      h_from: src.hour.from,
      h_to: src.hour.to,
      m_from: src.minute.from,
      m_to: src.minute.to,
    };
  });

  const rows = await sql<Row[]>`
    WITH c AS (
      SELECT * FROM json_to_recordset(${JSON.stringify(ranges)}::json)
        AS c(tenant_id uuid, d_from timestamptz, d_to timestamptz, h_from timestamptz, h_to timestamptz,
             m_from timestamptz, m_to timestamptz)
    ), s AS (
      SELECT s.id, s.tenant_id FROM api_service s JOIN c ON c.tenant_id = s.tenant_id WHERE s.archived_at IS NULL
    ), r AS (
      SELECT m.tenant_id, m.status_code, m.request_count, m.duration_buckets
      FROM api_metric_1d m JOIN c ON c.tenant_id = m.tenant_id JOIN s ON s.id = m.api_service_id AND s.tenant_id = m.tenant_id
      WHERE m.bucket_start >= c.d_from AND m.bucket_start < c.d_to
      UNION ALL
      SELECT m.tenant_id, m.status_code, m.request_count, m.duration_buckets
      FROM api_metric_1h m JOIN c ON c.tenant_id = m.tenant_id JOIN s ON s.id = m.api_service_id AND s.tenant_id = m.tenant_id
      WHERE m.bucket_start >= c.h_from AND m.bucket_start < c.h_to
      UNION ALL
      SELECT m.tenant_id, m.status_code, m.request_count, m.duration_buckets
      FROM api_metric_1m m JOIN c ON c.tenant_id = m.tenant_id JOIN s ON s.id = m.api_service_id AND s.tenant_id = m.tenant_id
      WHERE m.bucket_start >= c.m_from AND m.bucket_start < c.m_to
    )
    SELECT tenant_id,
      sum(request_count) AS requests,
      coalesce(sum(request_count) FILTER (WHERE status_code BETWEEN 400 AND 499), 0) AS client_errors,
      coalesce(sum(request_count) FILTER (WHERE status_code >= 500), 0) AS server_errors,
      api_metric_quantile(api_metric_sum_buckets(duration_buckets), 0.5) AS p50,
      api_metric_quantile(api_metric_sum_buckets(duration_buckets), 0.95) AS p95
    FROM r
    GROUP BY tenant_id`;

  const byTenant = new Map(rows.map((r) => [r.tenant_id, r]));
  return projects.map((p) => {
    const r = byTenant.get(p.tenant_id);
    return {
      tenantId: p.tenant_id,
      name: p.name,
      slug: p.slug,
      services: Number(p.services),
      totals: {
        requests: Number(r?.requests ?? 0),
        clientErrors: Number(r?.client_errors ?? 0),
        serverErrors: Number(r?.server_errors ?? 0),
        p50: r?.p50 ?? null,
        p95: r?.p95 ?? null,
      },
    };
  });
}
