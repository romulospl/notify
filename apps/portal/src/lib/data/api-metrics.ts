import "server-only";
import type { TenantReadContext } from "../access";
import { sql } from "../db";
import type { Period } from "../period";
import { getApiService } from "./api-services";

// Tenant API dashboard (#37): volume, status and p50/p95 latency per endpoint
// of a service in a period. Reads the tables of the E5 spec (section 4)
// directly from the stellytics database, always filtering by the context's
// tenant and by the already checked service (ADR 0003): another tenant's
// service returns null with no metrics read.

// Endpoints in the table, those with the most requests first. The collector
// limits to 500 routes per service and day (D4 of the E5 spec), so the rest is tail.
export const ENDPOINT_LIMIT = 100;

export type ApiCounts = {
  requests: number;
  clientErrors: number; // 4xx
  serverErrors: number; // 5xx
  // Percentiles in seconds, null with no requests. 10 means "10 s or more"
  // (the last histogram bucket has no upper bound).
  p50: number | null;
  p95: number | null;
};

export type ApiEndpoint = ApiCounts & { method: string; route: string };

export type ApiServiceDashboard = {
  totals: ApiCounts;
  // One point per bucket of the period, including the empty ones.
  series: (ApiCounts & { at: Date })[];
  endpoints: ApiEndpoint[];
  endpointCount: number;
  statuses: { statusCode: number; requests: number }[];
};

const HOUR = 3_600_000;

function floorHour(d: Date): Date {
  return new Date(Math.floor(d.getTime() / HOUR) * HOUR);
}

function floorDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Which table each stretch of the period comes from. The #34 job rolls up,
// every 15 minutes, the hours that ended at least 5 minutes ago, and the day
// from the hours, in the same run. What started before `hourCut` comes from
// api_metric_1h, the days before `dayCut`, from api_metric_1d, and the rest,
// from api_metric_1m. The stretches do not overlap, so nothing counts twice.
//
// `hourCut` is the smaller of:
// - the current hour minus one (slack over the job, so late batches from the
//   collector get in before the dashboard switches tables);
// - the end of the tenant's last rolled-up hour (`consolidatedUntil`): if the
//   job stops or runs late, the hours not yet rolled up keep coming from 1m,
//   instead of disappearing. Null (nothing rolled up yet) puts everything in 1m.
export function metricSources(
  period: Pick<Period, "unit" | "startAt" | "endAt">,
  consolidatedUntil: Date | null,
) {
  const slack = new Date(floorHour(period.endAt).getTime() - HOUR);
  const hourCut = consolidatedUntil === null ? period.startAt : consolidatedUntil < slack ? consolidatedUntil : slack;
  const dayCut = floorDay(hourCut);
  const { startAt: start, endAt: end } = period;
  const max = (a: Date, b: Date) => (a > b ? a : b);
  const min = (a: Date, b: Date) => (a < b ? a : b);
  // An hourly period cannot use the one-day bucket.
  const daily = period.unit !== "hour";
  return {
    day: daily ? { from: start, to: min(dayCut, end) } : null,
    hour: { from: daily ? max(start, dayCut) : start, to: min(hourCut, end) },
    minute: { from: max(start, hourCut), to: end },
  };
}

type Row = {
  g_bucket: number;
  g_route: number;
  g_status: number;
  bucket: Date | string | null; // the driver may return text for the expression
  route: string | null;
  method: string | null;
  status_code: number | null;
  requests: string;
  client_errors: string;
  server_errors: string;
  p50: number | null;
  p95: number | null;
};

function counts(r: Row): ApiCounts {
  return {
    requests: Number(r.requests),
    clientErrors: Number(r.client_errors),
    serverErrors: Number(r.server_errors),
    p50: r.p50,
    p95: r.p95,
  };
}

const EMPTY: ApiCounts = { requests: 0, clientErrors: 0, serverErrors: 0, p50: null, p95: null };

// Null when the service does not belong to the context's tenant (or is archived).
export async function getServiceDashboard(
  ctx: TenantReadContext,
  serviceId: string,
  period: Period,
): Promise<ApiServiceDashboard | null> {
  const service = await getApiService(ctx, serviceId);
  if (!service) return null;
  // End of the tenant's last rolled-up hour; the (tenant_id, bucket_start) index serves it.
  const [last] = await sql<{ until: Date | string | null }[]>`
    SELECT max(bucket_start) + interval '1 hour' AS until FROM api_metric_1h WHERE tenant_id = ${ctx.tenantId}`;
  const src = metricSources(period, last?.until ? new Date(last.until) : null);
  // An empty stretch (from >= to) returns no row; the days one disappears in an hourly period.
  const day = src.day ?? { from: period.startAt, to: period.startAt };

  // A single read: GROUPING SETS gives the series, the endpoints, the statuses and the total.
  // The dates go as ISO text with a cast: the driver does not serialize Date here.
  const rows = await sql<Row[]>`
    WITH r AS (
      SELECT bucket_start, route, method, status_code, request_count, duration_buckets FROM api_metric_1d
      WHERE tenant_id = ${ctx.tenantId} AND api_service_id = ${service.id}
        AND bucket_start >= ${day.from.toISOString()}::timestamptz AND bucket_start < ${day.to.toISOString()}::timestamptz
      UNION ALL
      SELECT bucket_start, route, method, status_code, request_count, duration_buckets FROM api_metric_1h
      WHERE tenant_id = ${ctx.tenantId} AND api_service_id = ${service.id}
        AND bucket_start >= ${src.hour.from.toISOString()}::timestamptz AND bucket_start < ${src.hour.to.toISOString()}::timestamptz
      UNION ALL
      SELECT bucket_start, route, method, status_code, request_count, duration_buckets FROM api_metric_1m
      WHERE tenant_id = ${ctx.tenantId} AND api_service_id = ${service.id}
        AND bucket_start >= ${src.minute.from.toISOString()}::timestamptz AND bucket_start < ${src.minute.to.toISOString()}::timestamptz
    )
    SELECT
      GROUPING(bucket)::int AS g_bucket, GROUPING(route, method)::int AS g_route, GROUPING(status_code)::int AS g_status,
      bucket, route, method, status_code,
      sum(request_count) AS requests,
      coalesce(sum(request_count) FILTER (WHERE status_code BETWEEN 400 AND 499), 0) AS client_errors,
      coalesce(sum(request_count) FILTER (WHERE status_code >= 500), 0) AS server_errors,
      api_metric_quantile(api_metric_sum_buckets(duration_buckets), 0.5) AS p50,
      api_metric_quantile(api_metric_sum_buckets(duration_buckets), 0.95) AS p95
    FROM (SELECT date_trunc(${period.unit}::text, bucket_start, 'UTC') AS bucket, * FROM r) b
    GROUP BY GROUPING SETS ((bucket), (route, method), (status_code), ())
  `;

  let totals = EMPTY;
  const byBucket = new Map<number, ApiCounts>();
  const endpoints: ApiEndpoint[] = [];
  const statuses: ApiServiceDashboard["statuses"] = [];
  for (const r of rows) {
    if (r.g_bucket === 0) byBucket.set(new Date(r.bucket!).getTime(), counts(r));
    else if (r.g_route === 0) endpoints.push({ method: r.method!, route: r.route!, ...counts(r) });
    else if (r.g_status === 0) statuses.push({ statusCode: r.status_code!, requests: Number(r.requests) });
    else totals = counts(r);
  }
  const byRequests = (a: { requests: number }, b: { requests: number }) => b.requests - a.requests;
  endpoints.sort((a, b) => byRequests(a, b) || a.route.localeCompare(b.route) || a.method.localeCompare(b.method));
  statuses.sort((a, b) => byRequests(a, b) || a.statusCode - b.statusCode);

  return {
    totals,
    series: period.buckets.map((at) => ({ at, ...(byBucket.get(at.getTime()) ?? EMPTY) })),
    endpoints: endpoints.slice(0, ENDPOINT_LIMIT),
    endpointCount: endpoints.length,
    statuses,
  };
}
